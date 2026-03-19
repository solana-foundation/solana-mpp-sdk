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
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
    appendTransactionMessageInstructions,
    createSolanaRpc,
    createTransactionMessage,
    generateKeyPairSigner,
    getBase64EncodedWireTransaction,
    pipe,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
    address,
    type Instruction,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
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
import { BudgetAuthorizer, SwigSessionAuthorizer, UnboundedAuthorizer } from '../../src/index.js';
import * as SessionChannelStore from '../../src/session/ChannelStore.js';

const RPC_URL = 'http://localhost:8899';
const SESSION_CHANNEL_PROGRAM = 'swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB';

type GeneratedSigner = Awaited<ReturnType<typeof generateKeyPairSigner>>;
type SolanaRpcClient = ReturnType<typeof createSolanaRpc>;
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

async function airdrop(pubkey: string, lamports: number) {
    const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'requestAirdrop',
            params: [pubkey, lamports],
        }),
    });
    const data = (await res.json()) as { result?: string; error?: any };
    if (data.error) throw new Error(`Airdrop failed: ${JSON.stringify(data.error)}`);

    // Wait for confirmation
    const sig = data.result!;
    for (let i = 0; i < 30; i++) {
        const statusRes = await fetch(RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getSignatureStatuses',
                params: [[sig]],
            }),
        });
        const statusData = (await statusRes.json()) as { result?: { value: any[] } };
        const status = statusData.result?.value?.[0];
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
            return sig;
        }
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('Airdrop confirmation timeout');
}

async function getBalance(pubkey: string): Promise<number> {
    const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBalance',
            params: [pubkey],
        }),
    });
    const data = (await res.json()) as { result?: { value: number } };
    return data.result?.value ?? 0;
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
                asset: { kind: 'sol', decimals: 9 },
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
        buildTopupTx: input => `topup:${input.channelId}:${input.additionalAmount}`,
    });
}

function receiptFromResponse(response: Response) {
    return Receipt.fromResponse(response);
}

async function getSessionChannel(store: Store.Store, channelId: string) {
    return await SessionChannelStore.fromStore(store).getChannel(channelId);
}

async function waitForSignatureConfirmation(signature: string, timeoutMs = 30_000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        const res = await fetch(RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getSignatureStatuses',
                params: [[signature]],
            }),
        });

        const data = (await res.json()) as {
            result?: {
                value: Array<null | {
                    confirmationStatus?: string;
                    err?: unknown;
                }>;
            };
        };

        const status = data.result?.value?.[0];
        if (status) {
            if (status.err) {
                throw new Error(`Transaction ${signature} failed: ${JSON.stringify(status.err)}`);
            }

            if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
                return;
            }
        }

        await new Promise(resolve => setTimeout(resolve, 250));
    }

    throw new Error(`Timed out waiting for transaction confirmation: ${signature}`);
}

async function sendInstructions(parameters: {
    rpc: SolanaRpcClient;
    feePayer: GeneratedSigner;
    instructions: readonly Instruction[];
}): Promise<string> {
    const { rpc, feePayer, instructions } = parameters;
    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

    const txMessage = pipe(
        createTransactionMessage({ version: 0 }),
        message => setTransactionMessageFeePayerSigner(feePayer, message),
        message => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, message),
        message => appendTransactionMessageInstructions(instructions, message),
    );

    const signed = await signTransactionMessageWithSigners(txMessage);
    const wire = getBase64EncodedWireTransaction(signed);
    const signature = await rpc
        .sendTransaction(wire, {
            encoding: 'base64',
            skipPreflight: false,
        })
        .send();

    await waitForSignatureConfirmation(signature);
    return signature;
}

async function getConfirmedTransaction(signature: string) {
    const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getTransaction',
            params: [
                signature,
                {
                    encoding: 'jsonParsed',
                    maxSupportedTransactionVersion: 0,
                },
            ],
        }),
    });

    const data = (await res.json()) as {
        result?: unknown;
        error?: unknown;
    };

    if (data.error) {
        throw new Error(`getTransaction failed: ${JSON.stringify(data.error)}`);
    }

    return data.result ?? null;
}

async function sendMarkerTransfer(parameters: {
    signer: GeneratedSigner;
    destination: string;
    lamports?: bigint;
}): Promise<string> {
    const rpc = createSolanaRpc(RPC_URL);
    const { signer, destination, lamports = 1n } = parameters;

    return await sendInstructions({
        rpc,
        feePayer: signer,
        instructions: [
            getTransferSolInstruction({
                source: signer,
                destination: address(destination),
                amount: lamports,
            }),
        ],
    });
}

async function createSwigHarness(parameters: {
    walletSigner: GeneratedSigner;
    spendLimitLamports: bigint;
    sessionTtlSeconds: number;
}): Promise<SwigHarness> {
    const { walletSigner, spendLimitLamports, sessionTtlSeconds } = parameters;
    const rpc = createSolanaRpc(RPC_URL);
    const swigRoleId = 0;

    const swigId = crypto.getRandomValues(new Uint8Array(32));
    const createSwigInstruction = await getCreateSwigInstruction({
        payer: walletSigner.address,
        id: swigId,
        actions: Actions.set().manageAuthority().programAll().solLimit({ amount: spendLimitLamports }).get(),
        authorityInfo: createEd25519SessionAuthorityInfo(walletSigner.address, BigInt(sessionTtlSeconds)),
    });

    await sendInstructions({
        rpc,
        feePayer: walletSigner,
        instructions: [createSwigInstruction],
    });

    const swigAddress = await findSwigPda(swigId);
    let swig = await (fetchSwig as any)(rpc, swigAddress);
    const swigWalletAddress = await getSwigWalletAddress(swig);

    await sendInstructions({
        rpc,
        feePayer: walletSigner,
        instructions: [
            getTransferSolInstruction({
                source: walletSigner,
                destination: address(swigWalletAddress),
                amount: spendLimitLamports * 4n,
            }),
        ],
    });

    let currentSessionSigner: GeneratedSigner | null = null;

    return {
        swigAddress,
        swigWalletAddress,
        async createSessionKey(ttlSeconds: number) {
            swig = await (fetchSwig as any)(rpc, swigAddress);

            const sessionSigner = await generateKeyPairSigner();
            const createSessionInstructions = await getCreateSessionInstructions(
                swig,
                swigRoleId,
                sessionSigner.address,
                BigInt(ttlSeconds),
            );

            const openTx = await sendInstructions({
                rpc,
                feePayer: walletSigner,
                instructions: createSessionInstructions,
            });

            await sendInstructions({
                rpc,
                feePayer: walletSigner,
                instructions: [
                    getTransferSolInstruction({
                        source: walletSigner,
                        destination: sessionSigner.address,
                        amount: 5_000_000n,
                    }),
                ],
            });

            currentSessionSigner = sessionSigner;

            return {
                signer: sessionSigner,
                openTx,
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

            swig = await (fetchSwig as any)(rpc, swigAddress);

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

            return await sendInstructions({
                rpc,
                feePayer: currentSessionSigner,
                instructions: signInstructions,
            });
        },
    };
}

// ── Test state ──

let clientSigner: GeneratedSigner;
let recipientSigner: GeneratedSigner;
let server: http.Server;
let serverPort: number;

before(async () => {
    const running = await isSurfpoolRunning();
    if (!running) {
        console.log('Surfpool not running on localhost:8899 — skipping integration tests.');
        console.log('Start it with: surfpool start --no-tui --offline');
        process.exit(0);
    }

    // Generate fresh keypairs
    clientSigner = await generateKeyPairSigner();
    recipientSigner = await generateKeyPairSigner();

    // Fund the client with 10 SOL
    await airdrop(clientSigner.address, 10_000_000_000);

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
            currency: 'SOL',
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

after(() => {
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

    const balanceBefore = await getBalance(recipientSigner.address);

    const response = await mppx.fetch(`http://localhost:${serverPort}/test`);
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(data, { paid: true });

    // Verify progress events
    assert.ok(events.includes('challenge'), 'should emit challenge');
    assert.ok(events.includes('signing'), 'should emit signing');
    assert.ok(events.includes('signed'), 'should emit signed');

    // Verify recipient received payment
    const balanceAfter = await getBalance(recipientSigner.address);
    assert.ok(balanceAfter > balanceBefore, 'recipient balance should increase');
    assert.ok(
        balanceAfter - balanceBefore >= 1_000_000,
        `expected >= 1000000 lamports increase, got ${balanceAfter - balanceBefore}`,
    );
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

    assert.equal(response.status, 200);
    assert.deepEqual(data, { paid: true });

    // Push mode should fire: challenge → signing → paying → confirming → paid
    assert.ok(events.includes('challenge'), 'should emit challenge');
    assert.ok(events.includes('signing'), 'should emit signing');
    assert.ok(events.includes('paying'), 'should emit paying');
    assert.ok(events.includes('paid'), 'should emit paid');
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
        assert.equal(response.status, 200, `request ${i + 1} should succeed`);
        const data = await response.json();
        assert.deepEqual(data, { paid: true });
    }
});

test('e2e: receipt header is present on success', async () => {
    const clientMethod = clientSolana.charge({
        signer: clientSigner,
        rpcUrl: RPC_URL,
    });

    const mppx = ClientMppx.create({ methods: [clientMethod] });

    const response = await mppx.fetch(`http://localhost:${serverPort}/test`);
    assert.equal(response.status, 200);

    // mppx attaches a receipt header
    const receiptHeader = response.headers.get('Payment-Receipt');
    assert.ok(receiptHeader, 'response should have Payment-Receipt header');
});

// ── Fee payer (server pays tx fees) ──

test('e2e: fee payer mode — server co-signs and pays fees', async () => {
    // Generate a dedicated fee payer keypair for the server
    const feePayerSigner = await generateKeyPairSigner();
    await airdrop(feePayerSigner.address, 10_000_000_000); // Fund fee payer

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
            currency: 'SOL',
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
        const clientBalanceBefore = await getBalance(clientSigner.address);

        const clientMethod = clientSolana.charge({
            signer: clientSigner,
            rpcUrl: RPC_URL,
            // broadcast defaults to false — required for fee payer
        });

        const mppx = ClientMppx.create({ methods: [clientMethod] });
        const response = await mppx.fetch(`http://localhost:${fpPort}/test`);
        const data = await response.json();

        assert.equal(response.status, 200);
        assert.deepEqual(data, { paid: true });

        // Client should have paid exactly 1_000_000 lamports for the transfer,
        // but NOT the tx fee (the fee payer covered that).
        const clientBalanceAfter = await getBalance(clientSigner.address);
        const clientSpent = clientBalanceBefore - clientBalanceAfter;

        // The client should have spent exactly the transfer amount (1_000_000 lamports).
        // Without fee payer, they'd also spend ~5000 lamports for the tx fee.
        assert.equal(
            clientSpent,
            1_000_000,
            `client should spend exactly 1000000 lamports (transfer only), got ${clientSpent}`,
        );
    } finally {
        fpServer.close();
    }
});

// ── Session flow ──

test('e2e: session auto-open then update over repeated requests', async () => {
    const harness = await startSessionHarness({
        pricing: {
            unit: 'request',
            amountPerUnit: '10',
            meter: 'api_calls',
        },
        sessionDefaults: {
            suggestedDeposit: '1000',
            ttlSeconds: 60,
        },
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
        assert.equal(firstResponse.status, 200);
        assert.deepEqual(await firstResponse.json(), { paid: true });

        const firstReceipt = receiptFromResponse(firstResponse);
        const channelId = firstReceipt.reference;

        const secondResponse = await mppx.fetch(endpoint);
        assert.equal(secondResponse.status, 200);
        assert.deepEqual(await secondResponse.json(), { paid: true });

        const secondReceipt = receiptFromResponse(secondResponse);
        assert.equal(secondReceipt.reference, channelId);

        const channel = await getSessionChannel(harness.store, channelId);
        assert.ok(channel);
        assert.equal(channel!.status, 'open');
        assert.equal(channel!.escrowedAmount, '1000');
        assert.equal(channel!.lastAuthorizedAmount, '10');
        assert.equal(channel!.lastSequence, 1);

        assert.ok(events.includes('challenge'), 'should emit challenge events');
        assert.ok(events.includes('opening'), 'should emit opening event');
        assert.ok(events.includes('opened'), 'should emit opened event');
        assert.ok(events.includes('updating'), 'should emit updating event');
        assert.ok(events.includes('updated'), 'should emit updated event');
    } finally {
        await harness.close();
    }
});

test('e2e: session autoTopup returns 204 management response, then resumes updates', async () => {
    const harness = await startSessionHarness({
        pricing: {
            unit: 'request',
            amountPerUnit: '70',
            meter: 'api_calls',
        },
        sessionDefaults: {
            suggestedDeposit: '100',
            ttlSeconds: 60,
        },
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
        assert.equal(openResponse.status, 200);
        const channelId = receiptFromResponse(openResponse).reference;

        const updateResponse = await mppx.fetch(endpoint);
        assert.equal(updateResponse.status, 200);
        assert.equal(receiptFromResponse(updateResponse).reference, channelId);

        const topupResponse = await mppx.fetch(endpoint);
        assert.equal(topupResponse.status, 204);
        assert.equal(receiptFromResponse(topupResponse).reference, channelId);

        const channelAfterTopup = await getSessionChannel(harness.store, channelId);
        assert.ok(channelAfterTopup);
        assert.equal(channelAfterTopup!.escrowedAmount, '200');
        assert.equal(channelAfterTopup!.lastAuthorizedAmount, '70');
        assert.equal(channelAfterTopup!.lastSequence, 1);

        const postTopupUpdateResponse = await mppx.fetch(endpoint);
        assert.equal(postTopupUpdateResponse.status, 200);
        assert.equal(receiptFromResponse(postTopupUpdateResponse).reference, channelId);

        const channelAfterUpdate = await getSessionChannel(harness.store, channelId);
        assert.ok(channelAfterUpdate);
        assert.equal(channelAfterUpdate!.lastAuthorizedAmount, '140');
        assert.equal(channelAfterUpdate!.lastSequence, 2);
    } finally {
        await harness.close();
    }
});

test('e2e: session can auto-close when limit is hit and autoTopup is disabled', async () => {
    const harness = await startSessionHarness({
        pricing: {
            unit: 'request',
            amountPerUnit: '10',
            meter: 'api_calls',
        },
        sessionDefaults: {
            suggestedDeposit: '10',
            ttlSeconds: 60,
        },
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
        assert.equal(openResponse.status, 200);
        const channelId = receiptFromResponse(openResponse).reference;

        const updateResponse = await mppx.fetch(endpoint);
        assert.equal(updateResponse.status, 200);
        assert.equal(receiptFromResponse(updateResponse).reference, channelId);

        const autoCloseResponse = await mppx.fetch(endpoint);
        assert.equal(autoCloseResponse.status, 204);
        assert.equal(receiptFromResponse(autoCloseResponse).reference, channelId);

        const closedChannel = await getSessionChannel(harness.store, channelId);
        assert.ok(closedChannel);
        assert.equal(closedChannel!.status, 'closed');

        const reopenedResponse = await mppx.fetch(endpoint);
        assert.equal(reopenedResponse.status, 200);
        assert.notEqual(receiptFromResponse(reopenedResponse).reference, channelId);
    } finally {
        await harness.close();
    }
});

test('e2e: session close action returns 204 and next request opens a new channel', async () => {
    const harness = await startSessionHarness({
        pricing: {
            unit: 'request',
            amountPerUnit: '25',
            meter: 'api_calls',
        },
        sessionDefaults: {
            suggestedDeposit: '500',
            ttlSeconds: 60,
        },
    });

    try {
        const clientMethod = clientSolana.session({
            signer: clientSigner,
            authorizer: createUnboundedSessionAuthorizer(),
        });

        const mppx = ClientMppx.create({ methods: [clientMethod], polyfill: false });
        const endpoint = `http://localhost:${harness.port}/session`;

        const openResponse = await mppx.fetch(endpoint);
        assert.equal(openResponse.status, 200);
        const initialChannelId = receiptFromResponse(openResponse).reference;

        const updateResponse = await mppx.fetch(endpoint);
        assert.equal(updateResponse.status, 200);

        const closeResponse = await mppx.fetch(endpoint, {
            context: { action: 'close' },
        });
        assert.equal(closeResponse.status, 204);
        assert.equal(receiptFromResponse(closeResponse).reference, initialChannelId);

        const closedChannel = await getSessionChannel(harness.store, initialChannelId);
        assert.ok(closedChannel);
        assert.equal(closedChannel!.status, 'closed');

        const reopenedResponse = await mppx.fetch(endpoint);
        assert.equal(reopenedResponse.status, 200);
        const reopenedReceipt = receiptFromResponse(reopenedResponse);

        assert.notEqual(reopenedReceipt.reference, initialChannelId);

        const reopenedChannel = await getSessionChannel(harness.store, reopenedReceipt.reference);
        assert.ok(reopenedChannel);
        assert.equal(reopenedChannel!.status, 'open');
        assert.equal(reopenedChannel!.lastSequence, 0);
    } finally {
        await harness.close();
    }
});

test('e2e: session swig_session mode uses on-chain setup and enforces spend limit', async () => {
    const spendLimitLamports = 800n;
    const swig = await createSwigHarness({
        walletSigner: clientSigner,
        spendLimitLamports,
        sessionTtlSeconds: 120,
    });

    let verifiedOpenTx: string | null = null;
    const harness = await startSessionHarness({
        pricing: {
            unit: 'request',
            amountPerUnit: '10',
            meter: 'api_calls',
        },
        sessionDefaults: {
            suggestedDeposit: '500',
            ttlSeconds: 60,
        },
        verifier: {
            acceptAuthorizationModes: ['swig_session'],
        },
        transactionVerifier: {
            async verifyOpen(_channelId, openTx) {
                verifiedOpenTx = openTx;
                const tx = await getConfirmedTransaction(openTx);
                assert.ok(tx, 'openTx should resolve to a confirmed on-chain transaction');
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
        assert.equal(openResponse.status, 200);
        const channelId = receiptFromResponse(openResponse).reference;

        const updateResponse = await mppx.fetch(endpoint);
        assert.equal(updateResponse.status, 200);
        assert.equal(receiptFromResponse(updateResponse).reference, channelId);

        assert.ok(verifiedOpenTx, 'transaction verifier should receive openTx signature');

        const delegatedSigner = swig.getCurrentSessionSigner();
        assert.ok(delegatedSigner, 'swig session signer should be created on open');

        const channel = await getSessionChannel(harness.store, channelId);
        assert.ok(channel);
        assert.equal(channel!.authorizationMode, 'swig_session');
        assert.equal(channel!.authority.wallet, clientSigner.address);
        assert.equal(channel!.authority.delegatedSessionKey, delegatedSigner!.address);
        assert.equal(channel!.lastAuthorizedAmount, '10');
        assert.equal(channel!.lastSequence, 1);

        const recipientBalanceBefore = await getBalance(recipientSigner.address);

        const withinLimitSignature = await swig.spendFromSwig(500n, recipientSigner.address);
        const withinLimitTx = await getConfirmedTransaction(withinLimitSignature);
        assert.ok(withinLimitTx, 'within-limit Swig spend should settle on-chain');

        const recipientBalanceAfter = await getBalance(recipientSigner.address);
        assert.ok(
            recipientBalanceAfter - recipientBalanceBefore >= 500,
            'recipient should receive Swig spend transfer',
        );

        await assert.rejects(
            async () => {
                await swig.spendFromSwig(900n, recipientSigner.address);
            },
            /Transaction simulation failed/,
            'over-limit Swig spend should fail on-chain',
        );
    } finally {
        await harness.close();
    }
});

test('e2e: session close can include on-chain settlement transaction', async () => {
    const swig = await createSwigHarness({
        walletSigner: clientSigner,
        spendLimitLamports: 2_000n,
        sessionTtlSeconds: 120,
    });

    let verifiedCloseTx: string | null = null;
    const harness = await startSessionHarness({
        pricing: {
            unit: 'request',
            amountPerUnit: '10',
            meter: 'api_calls',
        },
        sessionDefaults: {
            suggestedDeposit: '500',
            ttlSeconds: 60,
        },
        verifier: {
            acceptAuthorizationModes: ['swig_session'],
        },
        transactionVerifier: {
            async verifyClose(_channelId, closeTx) {
                verifiedCloseTx = closeTx;
                const tx = await getConfirmedTransaction(closeTx);
                assert.ok(tx, 'closeTx should resolve to a confirmed on-chain transaction');
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
                spendLimit: '2000',
            },
            rpcUrl: RPC_URL,
            allowedPrograms: [SESSION_CHANNEL_PROGRAM],
            buildCloseTx: async ({ finalCumulativeAmount, recipient }) =>
                await swig.spendFromSwig(BigInt(finalCumulativeAmount), recipient),
        });

        const clientMethod = clientSolana.session({
            signer: clientSigner,
            authorizer,
            autoTopup: false,
        });

        const mppx = ClientMppx.create({ methods: [clientMethod], polyfill: false });
        const endpoint = `http://localhost:${harness.port}/session`;

        const openResponse = await mppx.fetch(endpoint);
        assert.equal(openResponse.status, 200);

        const updateResponse = await mppx.fetch(endpoint);
        assert.equal(updateResponse.status, 200);

        const recipientBalanceBeforeClose = await getBalance(recipientSigner.address);

        const closeResponse = await mppx.fetch(endpoint, {
            context: { action: 'close' },
        });
        assert.equal(closeResponse.status, 204);
        assert.ok(verifiedCloseTx, 'transaction verifier should receive closeTx signature');

        const recipientBalanceAfterClose = await getBalance(recipientSigner.address);
        assert.ok(
            recipientBalanceAfterClose - recipientBalanceBeforeClose >= 10,
            'recipient should receive settlement transfer on close',
        );
    } finally {
        await harness.close();
    }
});

test('e2e: session regular_budget mode enforces on-chain Swig role limits', async () => {
    const swigSpendLimitLamports = 700n;
    const swig = await createSwigHarness({
        walletSigner: clientSigner,
        spendLimitLamports: swigSpendLimitLamports,
        sessionTtlSeconds: 120,
    });

    let verifiedOpenTx: string | null = null;
    const harness = await startSessionHarness({
        pricing: {
            unit: 'request',
            amountPerUnit: '400',
            meter: 'api_calls',
        },
        sessionDefaults: {
            suggestedDeposit: '500',
            ttlSeconds: 60,
        },
        verifier: {
            acceptAuthorizationModes: ['regular_budget'],
        },
        transactionVerifier: {
            async verifyOpen(_channelId, openTx) {
                verifiedOpenTx = openTx;
                const tx = await getConfirmedTransaction(openTx);
                assert.ok(tx, 'budget openTx should resolve to a confirmed on-chain transaction');
            },
        },
    });

    try {
        const authorizer = new BudgetAuthorizer({
            signer: clientSigner,
            maxCumulativeAmount: '1000',
            swig: {
                swigAddress: swig.swigAddress,
                swigRoleId: 0,
                rpcUrl: RPC_URL,
            },
            buildOpenTx: async () =>
                await sendMarkerTransfer({
                    signer: clientSigner,
                    destination: recipientSigner.address,
                }),
            buildTopupTx: async () =>
                await sendMarkerTransfer({
                    signer: clientSigner,
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
        assert.equal(openResponse.status, 200);
        const channelId = receiptFromResponse(openResponse).reference;

        assert.ok(verifiedOpenTx, 'budget flow should verify openTx on-chain');

        const firstUpdateResponse = await mppx.fetch(endpoint);
        assert.equal(firstUpdateResponse.status, 200);
        assert.equal(receiptFromResponse(firstUpdateResponse).reference, channelId);

        await assert.rejects(
            async () => {
                await mppx.fetch(endpoint);
            },
            /maxDepositAmount \(700\)/,
            'budget authorizer should clamp topups to Swig on-chain spend limit',
        );

        const channel = await getSessionChannel(harness.store, channelId);
        assert.ok(channel);
        assert.equal(channel!.authorizationMode, 'regular_budget');
        assert.equal(channel!.lastAuthorizedAmount, '400');
        assert.equal(channel!.lastSequence, 1);
    } finally {
        await harness.close();
    }
});

// ── Negative session + Swig flows ──

test('e2e: session swig_session mode rejects delegated signer not present on-chain', async () => {
    const swig = await createSwigHarness({
        walletSigner: clientSigner,
        spendLimitLamports: 500n,
        sessionTtlSeconds: 120,
    });

    const harness = await startSessionHarness({
        pricing: {
            unit: 'request',
            amountPerUnit: '10',
            meter: 'api_calls',
        },
        sessionDefaults: {
            suggestedDeposit: '100',
            ttlSeconds: 60,
        },
        verifier: {
            acceptAuthorizationModes: ['swig_session'],
        },
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

        await assert.rejects(
            async () => {
                await mppx.fetch(`http://localhost:${harness.port}/session`);
            },
            /delegated session key|Swig role 0 does not match delegated session key role/,
            'swig_session should reject delegated keys that are not created on-chain',
        );
    } finally {
        await harness.close();
    }
});

test('e2e: session regular_budget mode rejects unknown configured Swig role', async () => {
    const swig = await createSwigHarness({
        walletSigner: clientSigner,
        spendLimitLamports: 500n,
        sessionTtlSeconds: 120,
    });

    const harness = await startSessionHarness({
        pricing: {
            unit: 'request',
            amountPerUnit: '10',
            meter: 'api_calls',
        },
        sessionDefaults: {
            suggestedDeposit: '100',
            ttlSeconds: 60,
        },
        verifier: {
            acceptAuthorizationModes: ['regular_budget'],
        },
    });

    try {
        const authorizer = new BudgetAuthorizer({
            signer: clientSigner,
            maxCumulativeAmount: '1000',
            swig: {
                swigAddress: swig.swigAddress,
                swigRoleId: 999,
                rpcUrl: RPC_URL,
            },
            buildOpenTx: async () =>
                await sendMarkerTransfer({
                    signer: clientSigner,
                    destination: recipientSigner.address,
                }),
            buildTopupTx: async () =>
                await sendMarkerTransfer({
                    signer: clientSigner,
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

        await assert.rejects(
            async () => {
                await mppx.fetch(`http://localhost:${harness.port}/session`);
            },
            /Unable to locate Swig role 999/,
            'regular_budget should reject non-existent configured Swig roles',
        );
    } finally {
        await harness.close();
    }
});
