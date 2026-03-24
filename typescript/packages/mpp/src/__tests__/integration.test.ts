/**
 * Integration tests against a local Surfpool simnet.
 *
 * Runs a real HTTP server (mppx server) and a real HTTP client (mppx client)
 * with actual Solana transactions against surfpool on localhost:8899.
 *
 * Requires: `surfpool start --no-tui --offline` running on localhost:8899
 *
 * Run: npm run test:integration
 */
import { test, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { generateKeyPairSigner, address, lamports } from '@solana/kit';
import { createLocalClient } from '@solana/kit-client-rpc';
import { getTransferSolInstruction, systemProgram } from '@solana-program/system';
import {
    fetchSwig,
    findSwigPda,
    getCreateSessionInstructions,
    getCreateSwigInstruction,
    getSignInstructions,
    getSwigWalletAddress,
} from '@swig-wallet/kit';
import { Actions, createEd25519SessionAuthorityInfo } from '@swig-wallet/lib';
import { Receipt } from 'mppx';
import { Mppx as ServerMppx, solana as serverSolana, Store } from '../../src/server/index.js';
import { Mppx as ClientMppx, solana as clientSolana } from '../../src/client/index.js';
import { SwigBudgetAuthorizer, SwigSessionAuthorizer, UnboundedAuthorizer } from '../../src/index.js';
import * as SessionChannelStore from '../../src/session/ChannelStore.js';

const RPC_URL = 'http://localhost:8899';
const SESSION_CHANNEL_PROGRAM = 'swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB';

type GeneratedSigner = Awaited<ReturnType<typeof generateKeyPairSigner>>;
type TestClient = Awaited<ReturnType<typeof createTestClient>>;
type SwigHarness = {
    swigAddress: string;
    swigWalletAddress: string;
    createSessionKey: (ttlSeconds: number) => Promise<{
        signer: GeneratedSigner;
        openTx: string;
        swigRoleId: number;
    }>;
    getCurrentSessionSigner: () => GeneratedSigner | null;
    spendFromSwig: (amountLamports: bigint, destination: string) => Promise<string>;
};
type SessionServerParameters = Parameters<typeof serverSolana.session>[0];
type SessionHarness = {
    port: number;
    store: Store.Store;
    close: () => Promise<void>;
};

// ── Helpers ──

async function createTestClient(payer?: GeneratedSigner) {
    return await createLocalClient({ payer, url: RPC_URL }).use(systemProgram());
}

async function getBalance(client: TestClient, pubkey: string): Promise<bigint> {
    const { value } = await client.rpc.getBalance(address(pubkey)).send();
    return value;
}

async function getConfirmedTransaction(client: TestClient, signature: string) {
    return await client.rpc
        .getTransaction(signature as Parameters<typeof client.rpc.getTransaction>[0], {
            encoding: 'jsonParsed',
            maxSupportedTransactionVersion: 0,
        })
        .send();
}

async function isSurfpoolRunning(): Promise<boolean> {
    try {
        const res = await fetch(RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth', params: [] }),
        });
        return res.ok;
    } catch {
        return false;
    }
}

/** Convert an incoming Node request to a Web API Request. */
function toWebRequest(req: http.IncomingMessage, body: string): Request {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value) headers.set(key, Array.isArray(value) ? value[0] : value);
    }
    const url = `http://localhost${req.url}`;
    return new Request(url, { method: req.method, headers, body: body || undefined });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString();
}

async function startSessionHarness(overrides: Partial<SessionServerParameters> = {}): Promise<SessionHarness> {
    const store = overrides.store ?? Store.memory();

    const mppx = ServerMppx.create({
        secretKey: `test-secret-key-session-${crypto.randomUUID()}`,
        methods: [
            serverSolana.session({
                recipient: recipientSigner.address,
                network: 'localnet',
                currency: 'sol',
                amount: '10',
                channelProgram: SESSION_CHANNEL_PROGRAM,
                store,
                ...overrides,
            }),
        ],
    });

    const server = http.createServer(async (req, res) => {
        const body = await readBody(req);
        const webReq = toWebRequest(req, body);

        const result = await mppx.session({})(webReq);

        if (result.status === 402) {
            const challenge = result.challenge as Response;
            res.writeHead(challenge.status, Object.fromEntries(challenge.headers));
            res.end(await challenge.text());
            return;
        }

        const response = result.withReceipt(Response.json({ paid: true })) as Response;
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
    });

    const port = await new Promise<number>(resolve => {
        server.listen(0, () => resolve((server.address() as { port: number }).port));
    });

    return {
        port,
        store,
        close: async () => {
            await new Promise<void>((resolve, reject) => {
                server.close(error => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        },
    };
}

function createUnboundedSessionAuthorizer() {
    return new UnboundedAuthorizer({
        signer: clientSigner,
        buildOpenTx: input => `open:${input.channelId}`,
        buildTopUpTx: input => `topup:${input.channelId}:${input.additionalAmount}`,
    });
}

function receiptFromResponse(response: Response) {
    return Receipt.fromResponse(response);
}

async function getSessionChannel(store: Store.Store, channelId: string) {
    return await SessionChannelStore.fromStore(store).getChannel(channelId);
}

async function sendMarkerTransfer(parameters: {
    client: TestClient;
    destination: string;
    amount?: bigint;
}): Promise<string> {
    const { client, destination, amount = 1n } = parameters;
    const result = await client.system.instructions
        .transferSol({
            source: client.payer,
            destination: address(destination),
            amount,
        })
        .sendTransaction();
    return result.context.signature;
}

async function createSwigHarness(parameters: {
    client: TestClient;
    spendLimitLamports: bigint;
    sessionTtlSeconds: number;
}): Promise<SwigHarness> {
    const { client, spendLimitLamports, sessionTtlSeconds } = parameters;
    const walletSigner = client.payer as GeneratedSigner;
    const swigRoleId = 0;

    const swigId = crypto.getRandomValues(new Uint8Array(32));
    const createSwigInstruction = await getCreateSwigInstruction({
        payer: walletSigner.address,
        id: swigId,
        actions: Actions.set().manageAuthority().programAll().solLimit({ amount: spendLimitLamports }).get(),
        authorityInfo: createEd25519SessionAuthorityInfo(walletSigner.address, BigInt(sessionTtlSeconds)),
    });

    await client.sendTransaction([createSwigInstruction]);

    const swigAddress = await findSwigPda(swigId);
    let swig = await (fetchSwig as any)(client.rpc, swigAddress);
    const swigWalletAddress = await getSwigWalletAddress(swig);

    await client.system.instructions
        .transferSol({
            source: walletSigner,
            destination: address(swigWalletAddress),
            amount: spendLimitLamports * 4n,
        })
        .sendTransaction();

    let currentSessionSigner: GeneratedSigner | null = null;

    return {
        swigAddress,
        swigWalletAddress,
        async createSessionKey(ttlSeconds: number) {
            swig = await (fetchSwig as any)(client.rpc, swigAddress);

            const sessionSigner = await generateKeyPairSigner();
            const createSessionInstructions = await getCreateSessionInstructions(
                swig,
                swigRoleId,
                sessionSigner.address,
                BigInt(ttlSeconds),
            );

            const openResult = await client.sendTransaction(createSessionInstructions);

            await client.system.instructions
                .transferSol({
                    source: walletSigner,
                    destination: sessionSigner.address,
                    amount: 5_000_000n,
                })
                .sendTransaction();

            currentSessionSigner = sessionSigner;

            return {
                signer: sessionSigner,
                openTx: openResult.context.signature,
                swigRoleId,
            };
        },
        getCurrentSessionSigner() {
            return currentSessionSigner;
        },
        async spendFromSwig(amountLamports: bigint, destination: string) {
            if (!currentSessionSigner) {
                throw new Error('No active Swig session signer');
            }

            swig = await (fetchSwig as any)(client.rpc, swigAddress);

            const innerInstructions = [
                getTransferSolInstruction({
                    source: address(swigWalletAddress) as any,
                    destination: address(destination),
                    amount: amountLamports,
                }),
            ];

            const signInstructions = await getSignInstructions(swig, swigRoleId, innerInstructions, false, {
                payer: currentSessionSigner.address,
            });

            const sessionClient = await createTestClient(currentSessionSigner);
            const result = await sessionClient.sendTransaction(signInstructions);
            return result.context.signature;
        },
    };
}

// ── Test state ──

let client: TestClient;
let clientSigner: GeneratedSigner;
let recipientSigner: GeneratedSigner;
let server: http.Server;
let serverPort: number;

beforeAll(async () => {
    const running = await isSurfpoolRunning();
    if (!running) {
        console.log('Surfpool not running on localhost:8899 — skipping integration tests.');
        console.log('Start it with: surfpool start --no-tui --offline');
        process.exit(0);
    }

    // Generate fresh keypairs
    clientSigner = await generateKeyPairSigner();
    recipientSigner = await generateKeyPairSigner();

    // Create kit client with systemProgram plugin
    client = await createTestClient(clientSigner);

    // Fund the client with 10 SOL
    await client.airdrop(clientSigner.address, lamports(10_000_000_000n));

    // Start a test HTTP server with the mppx charge handler
    // secretKey is required by mppx for signing challenge tokens
    const secretKey = 'test-secret-key-for-integration-tests';

    const mppx = ServerMppx.create({
        secretKey,
        methods: [
            serverSolana.charge({
                recipient: recipientSigner.address,
                network: 'localnet',
                rpcUrl: RPC_URL,
            }),
        ],
    });

    server = http.createServer(async (req, res) => {
        // Read body
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks).toString();

        const webReq = toWebRequest(req, body);

        const result = await mppx.charge({
            amount: '1000000', // 0.001 SOL
            currency: 'sol',
            description: 'test charge',
        })(webReq);

        if (result.status === 402) {
            const challenge = result.challenge as Response;
            const headers = Object.fromEntries(challenge.headers);
            res.writeHead(challenge.status, headers);
            res.end(await challenge.text());
            return;
        }

        const response = result.withReceipt(Response.json({ paid: true })) as Response;
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
    });

    await new Promise<void>(resolve => {
        server.listen(0, () => {
            serverPort = (server.address() as any).port;
            resolve();
        });
    });
});

afterAll(() => {
    server?.close();
});

// ── Tests ──

test('e2e: native SOL charge via pull mode (default)', async () => {
    const events: string[] = [];

    const clientMethod = clientSolana.charge({
        signer: clientSigner,
        rpcUrl: RPC_URL,
        // broadcast defaults to false (pull mode)
        onProgress(event) {
            events.push(event.type);
        },
    });

    const mppx = ClientMppx.create({ methods: [clientMethod] });

    const balanceBefore = await getBalance(client, recipientSigner.address);

    const response = await mppx.fetch(`http://localhost:${serverPort}/test`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ paid: true });

    // Verify progress events
    expect(events).toContain('challenge');
    expect(events).toContain('signing');
    expect(events).toContain('signed');

    // Verify recipient received payment
    const balanceAfter = await getBalance(client, recipientSigner.address);
    expect(balanceAfter).toBeGreaterThan(balanceBefore);
    expect(balanceAfter - balanceBefore).toBeGreaterThanOrEqual(1_000_000n);
});

test('e2e: native SOL charge via push mode', async () => {
    const events: string[] = [];

    const clientMethod = clientSolana.charge({
        signer: clientSigner,
        rpcUrl: RPC_URL,
        broadcast: true,
        onProgress(event) {
            events.push(event.type);
        },
    });

    const mppx = ClientMppx.create({ methods: [clientMethod] });

    const response = await mppx.fetch(`http://localhost:${serverPort}/test`);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ paid: true });

    // Push mode should fire: challenge → signing → paying → confirming → paid
    expect(events).toContain('challenge');
    expect(events).toContain('signing');
    expect(events).toContain('paying');
    expect(events).toContain('paid');
});

test('e2e: multiple sequential charges succeed', async () => {
    const clientMethod = clientSolana.charge({
        signer: clientSigner,
        rpcUrl: RPC_URL,
    });

    const mppx = ClientMppx.create({ methods: [clientMethod] });

    // Three sequential charges should all succeed (no replay issues)
    for (let i = 0; i < 3; i++) {
        const response = await mppx.fetch(`http://localhost:${serverPort}/test`);
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data).toEqual({ paid: true });
    }
});

test('e2e: receipt header is present on success', async () => {
    const clientMethod = clientSolana.charge({
        signer: clientSigner,
        rpcUrl: RPC_URL,
    });

    const mppx = ClientMppx.create({ methods: [clientMethod] });

    const response = await mppx.fetch(`http://localhost:${serverPort}/test`);
    expect(response.status).toBe(200);

    // mppx attaches a receipt header
    const receiptHeader = response.headers.get('Payment-Receipt');
    expect(receiptHeader).toBeTruthy();
});

// ── Fee payer (server pays tx fees) ──

test('e2e: fee payer mode — server co-signs and pays fees', async () => {
    // Generate a dedicated fee payer keypair for the server
    const feePayerSigner = await generateKeyPairSigner();
    await client.airdrop(feePayerSigner.address, lamports(10_000_000_000n));

    const secretKey = 'test-secret-key-feepayer';

    const feePayerMppx = ServerMppx.create({
        secretKey,
        methods: [
            serverSolana.charge({
                recipient: recipientSigner.address,
                network: 'localnet',
                rpcUrl: RPC_URL,
                signer: feePayerSigner, // Server pays fees
            }),
        ],
    });

    // Start a fee-payer server
    const fpServer = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks).toString();
        const webReq = toWebRequest(req, body);

        const result = await feePayerMppx.charge({
            amount: '1000000',
            currency: 'sol',
        })(webReq);

        if (result.status === 402) {
            const challenge = result.challenge as Response;
            res.writeHead(challenge.status, Object.fromEntries(challenge.headers));
            res.end(await challenge.text());
            return;
        }

        const response = result.withReceipt(Response.json({ paid: true })) as Response;
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
    });

    const fpPort = await new Promise<number>(resolve => {
        fpServer.listen(0, () => resolve((fpServer.address() as any).port));
    });

    try {
        const clientBalanceBefore = await getBalance(client, clientSigner.address);

        const clientMethod = clientSolana.charge({
            signer: clientSigner,
            rpcUrl: RPC_URL,
            // broadcast defaults to false — required for fee payer
        });

        const mppx = ClientMppx.create({ methods: [clientMethod] });
        const response = await mppx.fetch(`http://localhost:${fpPort}/test`);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data).toEqual({ paid: true });

        // Client should have paid exactly 1_000_000 lamports for the transfer,
        // but NOT the tx fee (the fee payer covered that).
        const clientBalanceAfter = await getBalance(client, clientSigner.address);
        const clientSpent = clientBalanceBefore - clientBalanceAfter;

        // The client should have spent exactly the transfer amount (1_000_000 lamports).
        // Without fee payer, they'd also spend ~5000 lamports for the tx fee.
        expect(clientSpent).toBe(1_000_000n);
    } finally {
        fpServer.close();
    }
});

// ── USDC charge (SPL token) ──

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

async function fundUsdc(ownerAddress: string, amount: number) {
    await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'surfnet_setTokenAccount',
            params: [ownerAddress, USDC_MINT, { amount, state: 'initialized' }, TOKEN_PROGRAM],
        }),
    });
}

test('e2e: USDC charge via pull mode with fee payer', async () => {
    const feePayerSigner = await generateKeyPairSigner();
    await client.airdrop(feePayerSigner.address, lamports(10_000_000_000n));
    await fundUsdc(clientSigner.address, 100_000_000); // 100 USDC

    const secretKey = 'test-secret-key-usdc';

    const usdcMppx = ServerMppx.create({
        secretKey,
        methods: [
            serverSolana.charge({
                recipient: recipientSigner.address,
                network: 'localnet',
                rpcUrl: RPC_URL,
                currency: USDC_MINT,
                decimals: 6,
                signer: feePayerSigner,
            }),
        ],
    });

    const usdcServer = http.createServer(async (req, res) => {
        const body = await readBody(req);
        const webReq = toWebRequest(req, body);

        const result = await usdcMppx.charge({
            amount: '10000', // 0.01 USDC
            currency: USDC_MINT,
        })(webReq);

        if (result.status === 402) {
            const challenge = result.challenge as Response;
            res.writeHead(challenge.status, Object.fromEntries(challenge.headers));
            res.end(await challenge.text());
            return;
        }

        const response = result.withReceipt(Response.json({ paid: true })) as Response;
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
    });

    const usdcPort = await new Promise<number>(resolve => {
        usdcServer.listen(0, () => resolve((usdcServer.address() as { port: number }).port));
    });

    try {
        const clientMethod = clientSolana.charge({
            signer: clientSigner,
            rpcUrl: RPC_URL,
        });

        const mppx = ClientMppx.create({ methods: [clientMethod] });
        const response = await mppx.fetch(`http://localhost:${usdcPort}/test`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ paid: true });

        const receiptHeader = response.headers.get('Payment-Receipt');
        expect(receiptHeader).toBeTruthy();
    } finally {
        usdcServer.close();
    }
});

test('e2e: USDC charge with splits (platform fee)', async () => {
    const feePayerSigner = await generateKeyPairSigner();
    const platformSigner = await generateKeyPairSigner();
    await client.airdrop(feePayerSigner.address, lamports(10_000_000_000n));
    await fundUsdc(clientSigner.address, 100_000_000); // 100 USDC

    const secretKey = 'test-secret-key-splits';
    const splits = [{ recipient: platformSigner.address, amount: '5000', memo: 'platform fee' }];

    const splitsMppx = ServerMppx.create({
        secretKey,
        methods: [
            serverSolana.charge({
                recipient: recipientSigner.address,
                network: 'localnet',
                rpcUrl: RPC_URL,
                currency: USDC_MINT,
                decimals: 6,
                signer: feePayerSigner,
                splits,
            }),
        ],
    });

    const splitsServer = http.createServer(async (req, res) => {
        const body = await readBody(req);
        const webReq = toWebRequest(req, body);

        const result = await splitsMppx.charge({
            amount: '15000', // 0.015 USDC total (0.01 to recipient + 0.005 to platform)
            currency: USDC_MINT,
        })(webReq);

        if (result.status === 402) {
            const challenge = result.challenge as Response;
            res.writeHead(challenge.status, Object.fromEntries(challenge.headers));
            res.end(await challenge.text());
            return;
        }

        const response = result.withReceipt(Response.json({ paid: true })) as Response;
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
    });

    const splitsPort = await new Promise<number>(resolve => {
        splitsServer.listen(0, () => resolve((splitsServer.address() as { port: number }).port));
    });

    try {
        const clientMethod = clientSolana.charge({
            signer: clientSigner,
            rpcUrl: RPC_URL,
        });

        const mppx = ClientMppx.create({ methods: [clientMethod] });
        const response = await mppx.fetch(`http://localhost:${splitsPort}/test`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ paid: true });
    } finally {
        splitsServer.close();
    }
});

test('e2e: native SOL charge with splits', async () => {
    const platformSigner = await generateKeyPairSigner();
    const referrerSigner = await generateKeyPairSigner();

    const secretKey = 'test-secret-key-sol-splits';
    const splits = [
        { recipient: platformSigner.address, amount: '50000' },
        { recipient: referrerSigner.address, amount: '20000' },
    ];

    const solSplitsMppx = ServerMppx.create({
        secretKey,
        methods: [
            serverSolana.charge({
                recipient: recipientSigner.address,
                network: 'localnet',
                rpcUrl: RPC_URL,
                splits,
            }),
        ],
    });

    const solSplitsServer = http.createServer(async (req, res) => {
        const body = await readBody(req);
        const webReq = toWebRequest(req, body);

        const result = await solSplitsMppx.charge({
            amount: '1070000', // 1M to recipient + 50k platform + 20k referrer
            currency: 'sol',
        })(webReq);

        if (result.status === 402) {
            const challenge = result.challenge as Response;
            res.writeHead(challenge.status, Object.fromEntries(challenge.headers));
            res.end(await challenge.text());
            return;
        }

        const response = result.withReceipt(Response.json({ paid: true })) as Response;
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
    });

    const solSplitsPort = await new Promise<number>(resolve => {
        solSplitsServer.listen(0, () => resolve((solSplitsServer.address() as { port: number }).port));
    });

    try {
        const clientMethod = clientSolana.charge({
            signer: clientSigner,
            rpcUrl: RPC_URL,
        });

        const mppx = ClientMppx.create({ methods: [clientMethod] });

        const platformBefore = await getBalance(client, platformSigner.address);
        const referrerBefore = await getBalance(client, referrerSigner.address);

        const response = await mppx.fetch(`http://localhost:${solSplitsPort}/test`);
        expect(response.status).toBe(200);

        // Verify split recipients received their shares
        const platformAfter = await getBalance(client, platformSigner.address);
        const referrerAfter = await getBalance(client, referrerSigner.address);

        expect(platformAfter - platformBefore).toBe(50_000n);
        expect(referrerAfter - referrerBefore).toBe(20_000n);
    } finally {
        solSplitsServer.close();
    }
});

// ── Session flow ──

test('e2e: session auto-open then update over repeated requests', async () => {
    const harness = await startSessionHarness({
        amount: '10',
        unitType: 'request',
        suggestedDeposit: '1000',
        ttlSeconds: 60,
    });

    try {
        const events: string[] = [];

        const clientMethod = clientSolana.session({
            signer: clientSigner,
            authorizer: createUnboundedSessionAuthorizer(),
            onProgress(event) {
                events.push(event.type);
            },
        });

        const mppx = ClientMppx.create({ methods: [clientMethod], polyfill: false });
        const endpoint = `http://localhost:${harness.port}/session`;

        const firstResponse = await mppx.fetch(endpoint);
        expect(firstResponse.status).toBe(200);
        expect(await firstResponse.json()).toEqual({ paid: true });

        const firstReceipt = receiptFromResponse(firstResponse);
        const channelId = firstReceipt.reference;

        const secondResponse = await mppx.fetch(endpoint);
        expect(secondResponse.status).toBe(200);
        expect(await secondResponse.json()).toEqual({ paid: true });

        const secondReceipt = receiptFromResponse(secondResponse);
        expect(secondReceipt.reference).toBe(channelId);

        const channel = await getSessionChannel(harness.store, channelId);
        expect(channel).toBeTruthy();
        expect(channel!.status).toBe('open');
        expect(channel!.escrowedAmount).toBe('1000');
        expect(channel!.acceptedCumulative).toBe('10');

        expect(events).toContain('challenge');
        expect(events).toContain('opening');
        expect(events).toContain('opened');
        expect(events).toContain('updating');
        expect(events).toContain('updated');
    } finally {
        await harness.close();
    }
});

test('e2e: session autoTopup returns 204 management response, then resumes updates', async () => {
    const harness = await startSessionHarness({
        amount: '70',
        unitType: 'request',
        suggestedDeposit: '100',
        ttlSeconds: 60,
    });

    try {
        const clientMethod = clientSolana.session({
            signer: clientSigner,
            authorizer: createUnboundedSessionAuthorizer(),
            autoTopup: true,
        });

        const mppx = ClientMppx.create({ methods: [clientMethod], polyfill: false });
        const endpoint = `http://localhost:${harness.port}/session`;

        const openResponse = await mppx.fetch(endpoint);
        expect(openResponse.status).toBe(200);
        const channelId = receiptFromResponse(openResponse).reference;

        const updateResponse = await mppx.fetch(endpoint);
        expect(updateResponse.status).toBe(200);
        expect(receiptFromResponse(updateResponse).reference).toBe(channelId);

        const topupResponse = await mppx.fetch(endpoint);
        expect(topupResponse.status).toBe(204);
        expect(receiptFromResponse(topupResponse).reference).toBe(channelId);

        const channelAfterTopup = await getSessionChannel(harness.store, channelId);
        expect(channelAfterTopup).toBeTruthy();
        expect(channelAfterTopup!.escrowedAmount).toBe('200');
        expect(channelAfterTopup!.acceptedCumulative).toBe('70');

        const postTopupUpdateResponse = await mppx.fetch(endpoint);
        expect(postTopupUpdateResponse.status).toBe(200);
        expect(receiptFromResponse(postTopupUpdateResponse).reference).toBe(channelId);

        const channelAfterUpdate = await getSessionChannel(harness.store, channelId);
        expect(channelAfterUpdate).toBeTruthy();
        expect(channelAfterUpdate!.acceptedCumulative).toBe('140');
    } finally {
        await harness.close();
    }
});

test('e2e: session can auto-close when limit is hit and autoTopup is disabled', async () => {
    const harness = await startSessionHarness({
        amount: '10',
        unitType: 'request',
        suggestedDeposit: '10',
        ttlSeconds: 60,
    });

    try {
        const clientMethod = clientSolana.session({
            signer: clientSigner,
            authorizer: createUnboundedSessionAuthorizer(),
            autoTopup: false,
            settleOnLimitHit: true,
        });

        const mppx = ClientMppx.create({ methods: [clientMethod], polyfill: false });
        const endpoint = `http://localhost:${harness.port}/session`;

        const openResponse = await mppx.fetch(endpoint);
        expect(openResponse.status).toBe(200);
        const channelId = receiptFromResponse(openResponse).reference;

        const updateResponse = await mppx.fetch(endpoint);
        expect(updateResponse.status).toBe(200);
        expect(receiptFromResponse(updateResponse).reference).toBe(channelId);

        const autoCloseResponse = await mppx.fetch(endpoint);
        expect(autoCloseResponse.status).toBe(204);
        expect(receiptFromResponse(autoCloseResponse).reference).toBe(channelId);

        const closedChannel = await getSessionChannel(harness.store, channelId);
        expect(closedChannel).toBeTruthy();
        expect(closedChannel!.status).toBe('closed');

        const reopenedResponse = await mppx.fetch(endpoint);
        expect(reopenedResponse.status).toBe(200);
        expect(receiptFromResponse(reopenedResponse).reference).not.toBe(channelId);
    } finally {
        await harness.close();
    }
});

test('e2e: session close action returns 204 and next request opens a new channel', async () => {
    const harness = await startSessionHarness({
        amount: '25',
        unitType: 'request',
        suggestedDeposit: '500',
        ttlSeconds: 60,
    });

    try {
        const clientMethod = clientSolana.session({
            signer: clientSigner,
            authorizer: createUnboundedSessionAuthorizer(),
        });

        const mppx = ClientMppx.create({ methods: [clientMethod], polyfill: false });
        const endpoint = `http://localhost:${harness.port}/session`;

        const openResponse = await mppx.fetch(endpoint);
        expect(openResponse.status).toBe(200);
        const initialChannelId = receiptFromResponse(openResponse).reference;

        const updateResponse = await mppx.fetch(endpoint);
        expect(updateResponse.status).toBe(200);

        const closeResponse = await mppx.fetch(endpoint, {
            context: { action: 'close' },
        });
        expect(closeResponse.status).toBe(204);
        expect(receiptFromResponse(closeResponse).reference).toBe(initialChannelId);

        const closedChannel = await getSessionChannel(harness.store, initialChannelId);
        expect(closedChannel).toBeTruthy();
        expect(closedChannel!.status).toBe('closed');

        const reopenedResponse = await mppx.fetch(endpoint);
        expect(reopenedResponse.status).toBe(200);
        const reopenedReceipt = receiptFromResponse(reopenedResponse);

        expect(reopenedReceipt.reference).not.toBe(initialChannelId);

        const reopenedChannel = await getSessionChannel(harness.store, reopenedReceipt.reference);
        expect(reopenedChannel).toBeTruthy();
        expect(reopenedChannel!.status).toBe('open');
        expect(reopenedChannel!.acceptedCumulative).toBe('0');
    } finally {
        await harness.close();
    }
});

test('e2e: session swig_session mode uses on-chain setup and enforces spend limit', async () => {
    const spendLimitLamports = 800n;
    const swig = await createSwigHarness({
        client,
        spendLimitLamports,
        sessionTtlSeconds: 120,
    });

    let verifiedOpenTx: string | null = null;
    const harness = await startSessionHarness({
        amount: '10',
        unitType: 'request',
        suggestedDeposit: '500',
        ttlSeconds: 60,
        transactionHandler: {
            async handleOpen(_channelId, transaction) {
                verifiedOpenTx = transaction;
                return 'mock-signature';
            },
        },
    });

    try {
        const authorizer = new SwigSessionAuthorizer({
            wallet: {
                address: clientSigner.address,
                swigAddress: swig.swigAddress,
                swigRoleId: 0,
                getSessionKey: async () => {
                    const signer = swig.getCurrentSessionSigner();
                    if (!signer) return null;
                    return {
                        signer,
                        swigRoleId: 0,
                    };
                },
                createSessionKey: async ({ ttlSeconds }) => {
                    return await swig.createSessionKey(ttlSeconds);
                },
            },
            policy: {
                profile: 'swig-time-bound',
                ttlSeconds: 60,
                spendLimit: spendLimitLamports.toString(),
            },
            rpcUrl: RPC_URL,
            allowedPrograms: [SESSION_CHANNEL_PROGRAM],
        });

        const clientMethod = clientSolana.session({
            signer: clientSigner,
            authorizer,
            autoTopup: true,
        });

        const mppx = ClientMppx.create({ methods: [clientMethod], polyfill: false });
        const endpoint = `http://localhost:${harness.port}/session`;

        const openResponse = await mppx.fetch(endpoint);
        expect(openResponse.status).toBe(200);
        const channelId = receiptFromResponse(openResponse).reference;

        const updateResponse = await mppx.fetch(endpoint);
        expect(updateResponse.status).toBe(200);
        expect(receiptFromResponse(updateResponse).reference).toBe(channelId);

        expect(verifiedOpenTx).toBeTruthy();

        const delegatedSigner = swig.getCurrentSessionSigner();
        expect(delegatedSigner).toBeTruthy();

        const channel = await getSessionChannel(harness.store, channelId);
        expect(channel).toBeTruthy();
        expect(channel!.authorizedSigner).toBe(delegatedSigner!.address);
        expect(channel!.acceptedCumulative).toBe('10');

        const recipientBalanceBefore = await getBalance(client, recipientSigner.address);

        const withinLimitSignature = await swig.spendFromSwig(500n, recipientSigner.address);
        const withinLimitTx = await getConfirmedTransaction(client, withinLimitSignature);
        expect(withinLimitTx).toBeTruthy();

        const recipientBalanceAfter = await getBalance(client, recipientSigner.address);
        expect(recipientBalanceAfter - recipientBalanceBefore).toBeGreaterThanOrEqual(500n);

        await expect(async () => {
            await swig.spendFromSwig(900n, recipientSigner.address);
        }).rejects.toThrow(/Failed to send transaction|Transaction simulation failed/);
    } finally {
        await harness.close();
    }
});

test('e2e: session close can include on-chain settlement transaction', async () => {
    const swig = await createSwigHarness({
        client,
        spendLimitLamports: 2_000n,
        sessionTtlSeconds: 120,
    });

    let verifiedCloseTx: string | null = null;
    const harness = await startSessionHarness({
        amount: '10',
        unitType: 'request',
        suggestedDeposit: '500',
        ttlSeconds: 60,
    });

    try {
        const authorizer = new SwigSessionAuthorizer({
            wallet: {
                address: clientSigner.address,
                swigAddress: swig.swigAddress,
                swigRoleId: 0,
                getSessionKey: async () => {
                    const signer = swig.getCurrentSessionSigner();
                    if (!signer) return null;
                    return {
                        signer,
                        swigRoleId: 0,
                    };
                },
                createSessionKey: async ({ ttlSeconds }) => {
                    return await swig.createSessionKey(ttlSeconds);
                },
            },
            policy: {
                profile: 'swig-time-bound',
                ttlSeconds: 60,
                spendLimit: '2000',
            },
            rpcUrl: RPC_URL,
            allowedPrograms: [SESSION_CHANNEL_PROGRAM],
        });

        const clientMethod = clientSolana.session({
            signer: clientSigner,
            authorizer,
            autoTopup: false,
        });

        const mppx = ClientMppx.create({ methods: [clientMethod], polyfill: false });
        const endpoint = `http://localhost:${harness.port}/session`;

        const openResponse = await mppx.fetch(endpoint);
        expect(openResponse.status).toBe(200);

        const updateResponse = await mppx.fetch(endpoint);
        expect(updateResponse.status).toBe(200);

        const recipientBalanceBeforeClose = await getBalance(client, recipientSigner.address);

        const closeResponse = await mppx.fetch(endpoint, {
            context: { action: 'close' },
        });
        expect(closeResponse.status).toBe(204);
        expect(verifiedCloseTx).toBeTruthy();

        const recipientBalanceAfterClose = await getBalance(client, recipientSigner.address);
        expect(recipientBalanceAfterClose - recipientBalanceBeforeClose).toBeGreaterThanOrEqual(10n);
    } finally {
        await harness.close();
    }
});

test('e2e: session regular_budget mode enforces on-chain Swig role limits', async () => {
    const swigSpendLimitLamports = 700n;
    const swig = await createSwigHarness({
        client,
        spendLimitLamports: swigSpendLimitLamports,
        sessionTtlSeconds: 120,
    });

    let verifiedOpenTx: string | null = null;
    const harness = await startSessionHarness({
        amount: '400',
        unitType: 'request',
        suggestedDeposit: '500',
        ttlSeconds: 60,
    });

    try {
        const authorizer = new SwigBudgetAuthorizer({
            signer: clientSigner,
            maxCumulativeAmount: '1000',
            swig: {
                swigAddress: swig.swigAddress,
                swigRoleId: 0,
                rpcUrl: RPC_URL,
            },
            buildOpenTx: async () =>
                await sendMarkerTransfer({
                    client,
                    destination: recipientSigner.address,
                }),
            buildTopUpTx: async () =>
                await sendMarkerTransfer({
                    client,
                    destination: recipientSigner.address,
                }),
        });

        const clientMethod = clientSolana.session({
            signer: clientSigner,
            authorizer,
            autoTopup: true,
        });

        const mppx = ClientMppx.create({ methods: [clientMethod], polyfill: false });
        const endpoint = `http://localhost:${harness.port}/session`;

        const openResponse = await mppx.fetch(endpoint);
        expect(openResponse.status).toBe(200);
        const channelId = receiptFromResponse(openResponse).reference;

        expect(verifiedOpenTx).toBeTruthy();

        const firstUpdateResponse = await mppx.fetch(endpoint);
        expect(firstUpdateResponse.status).toBe(200);
        expect(receiptFromResponse(firstUpdateResponse).reference).toBe(channelId);

        await expect(async () => {
            await mppx.fetch(endpoint);
        }).rejects.toThrow(/maxDepositAmount \(700\)/);

        const channel = await getSessionChannel(harness.store, channelId);
        expect(channel).toBeTruthy();
        expect(channel!.acceptedCumulative).toBe('400');
    } finally {
        await harness.close();
    }
});

// ── Negative session + Swig flows ──

test('e2e: session swig_session mode rejects delegated signer not present on-chain', async () => {
    const swig = await createSwigHarness({
        client,
        spendLimitLamports: 500n,
        sessionTtlSeconds: 120,
    });

    const harness = await startSessionHarness({
        amount: '10',
        unitType: 'request',
        suggestedDeposit: '100',
        ttlSeconds: 60,
    });

    try {
        const authorizer = new SwigSessionAuthorizer({
            wallet: {
                address: clientSigner.address,
                swigAddress: swig.swigAddress,
                swigRoleId: 0,
                createSessionKey: async () => ({
                    signer: await generateKeyPairSigner(),
                    swigRoleId: 0,
                    openTx: `invalid-open-${crypto.randomUUID()}`,
                }),
            },
            policy: {
                profile: 'swig-time-bound',
                ttlSeconds: 60,
                spendLimit: '100',
            },
            rpcUrl: RPC_URL,
            allowedPrograms: [SESSION_CHANNEL_PROGRAM],
        });

        const mppx = ClientMppx.create({
            methods: [
                clientSolana.session({
                    signer: clientSigner,
                    authorizer,
                }),
            ],
            polyfill: false,
        });

        await expect(async () => {
            await mppx.fetch(`http://localhost:${harness.port}/session`);
        }).rejects.toThrow(/delegated session key|Swig role 0 does not match delegated session key role/);
    } finally {
        await harness.close();
    }
});

test('e2e: session regular_budget mode rejects unknown configured Swig role', async () => {
    const swig = await createSwigHarness({
        client,
        spendLimitLamports: 500n,
        sessionTtlSeconds: 120,
    });

    const harness = await startSessionHarness({
        amount: '10',
        unitType: 'request',
        suggestedDeposit: '100',
        ttlSeconds: 60,
    });

    try {
        const authorizer = new SwigBudgetAuthorizer({
            signer: clientSigner,
            maxCumulativeAmount: '1000',
            swig: {
                swigAddress: swig.swigAddress,
                swigRoleId: 999,
                rpcUrl: RPC_URL,
            },
            buildOpenTx: async () =>
                await sendMarkerTransfer({
                    client,
                    destination: recipientSigner.address,
                }),
            buildTopUpTx: async () =>
                await sendMarkerTransfer({
                    client,
                    destination: recipientSigner.address,
                }),
        });

        const mppx = ClientMppx.create({
            methods: [
                clientSolana.session({
                    signer: clientSigner,
                    authorizer,
                }),
            ],
            polyfill: false,
        });

        await expect(async () => {
            await mppx.fetch(`http://localhost:${harness.port}/session`);
        }).rejects.toThrow(/Unable to locate Swig role 999/);
    } finally {
        await harness.close();
    }
});
