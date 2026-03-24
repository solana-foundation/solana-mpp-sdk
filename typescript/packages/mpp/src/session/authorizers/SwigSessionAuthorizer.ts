import { createSolanaRpc, type KeyPairSigner } from '@solana/kit';

import { DEFAULT_RPC_URLS } from '../../constants.js';
import {
    type AuthorizeCloseInput,
    type AuthorizedClose,
    type AuthorizedOpen,
    type AuthorizedTopUp,
    type AuthorizedVoucher,
    type AuthorizeOpenInput,
    type AuthorizerCapabilities,
    type AuthorizeTopUpInput,
    type AuthorizeVoucherInput,
    type SessionAuthorizer,
    type SessionPolicyProfile,
    type SessionVoucher,
    type SignedSessionVoucher,
} from '../Types.js';
import { signVoucher } from '../Voucher.js';

type SwigPolicy = Extract<SessionPolicyProfile, { profile: 'swig-time-bound' }>;

type SwigRoleActions = {
    canUseProgram?: (programId: string) => boolean;
    solSpendLimit?: () => bigint | null;
    tokenSpendLimit?: (mint: string) => bigint | null;
};

type SwigRole = {
    actions?: SwigRoleActions;
    id: number;
};

type SwigAccount = {
    findRoleById?: (id: number) => SwigRole | null;
    findRoleBySessionKey?: (sessionKey: string) => SwigRole | null;
};

export type SwigSessionModule = {
    fetchSwig: (rpc: unknown, swigAddress: string) => Promise<SwigAccount>;
};

type SessionSignerState = {
    createdAtMs?: number;
    openTx?: string;
    signer: KeyPairSigner;
    swigRoleId?: number;
};

type ChannelProgress = {
    deposited: bigint;
    lastCumulative: bigint;
    signerAddress: string;
    swigRoleId?: number;
};

export type SwigSessionKeyResult =
    | KeyPairSigner
    | {
          createdAt?: Date | number | string;
          openTx?: string;
          signer: KeyPairSigner;
          swigRoleId?: number;
      };

export interface SwigWalletAdapter {
    address: string;
    createSessionKey?: (config: {
        channelId: string;
        channelProgram: string;
        depositLimit?: string;
        network: string;
        recipient: string;
        spendLimit?: string;
        ttlSeconds: number;
    }) => Promise<SwigSessionKeyResult>;
    getSessionKey?: () => Promise<SwigSessionKeyResult | null | undefined>;
    swigAddress?: string;
    swigRoleId?: number;
}

export interface SwigSessionAuthorizerParameters {
    allowedPrograms?: string[];
    buildOpenTx?: (input: AuthorizeOpenInput) => Promise<string> | string;
    buildTopUpTx?: (input: AuthorizeTopUpInput) => Promise<string> | string;
    policy: SwigPolicy;
    rpcUrl?: string;
    swigModule?: SwigSessionModule;
    wallet: SwigWalletAdapter;
}

export class SwigSessionAuthorizer implements SessionAuthorizer {
    private readonly wallet: SwigWalletAdapter;
    private readonly policy: SwigPolicy;
    private readonly rpcUrl?: string;
    private readonly allowedPrograms?: Set<string>;
    private readonly spendLimit?: bigint;
    private readonly depositLimit?: bigint;
    private readonly buildOpenTx?: (input: AuthorizeOpenInput) => Promise<string> | string;
    private readonly buildTopUpTx?: (input: AuthorizeTopUpInput) => Promise<string> | string;
    private readonly channels = new Map<string, ChannelProgress>();

    private swigLoaded = false;
    private swigModule: SwigSessionModule | null = null;
    private sessionSigner: KeyPairSigner | null = null;
    private sessionStartedAtMs: number | null = null;
    private sessionOpenTransaction: string | null = null;
    private sessionRoleId: number | null = null;
    private validatedPolicyForSessionSigner: string | null = null;

    constructor(parameters: SwigSessionAuthorizerParameters) {
        if (!Number.isInteger(parameters.policy.ttlSeconds) || parameters.policy.ttlSeconds <= 0) {
            throw new Error('Swig policy `ttlSeconds` must be a positive integer');
        }

        this.wallet = parameters.wallet;
        this.policy = parameters.policy;
        this.rpcUrl = parameters.rpcUrl;
        if (parameters.swigModule) {
            this.swigModule = parameters.swigModule;
            this.swigLoaded = true;
        }
        this.allowedPrograms = parameters.allowedPrograms ? new Set(parameters.allowedPrograms) : undefined;
        this.spendLimit =
            this.policy.spendLimit !== undefined
                ? parseNonNegativeAmount(this.policy.spendLimit, 'spendLimit')
                : undefined;
        this.depositLimit =
            this.policy.depositLimit !== undefined
                ? parseNonNegativeAmount(this.policy.depositLimit, 'depositLimit')
                : undefined;
        this.buildOpenTx = parameters.buildOpenTx;
        this.buildTopUpTx = parameters.buildTopUpTx;
    }

    getMode() {
        return 'swig_session' as const;
    }

    getCapabilities(): AuthorizerCapabilities {
        return {
            expiresAt: this.getSessionExpiresAt(),
            mode: 'swig_session',
            ...(this.policy.spendLimit ? { maxCumulativeAmount: this.policy.spendLimit } : {}),
            ...(this.policy.depositLimit ? { maxDepositAmount: this.policy.depositLimit } : {}),
            ...(this.allowedPrograms ? { allowedPrograms: [...this.allowedPrograms] } : {}),
            allowedActions: ['open', 'voucher', 'topUp', 'close'],
            requiresInteractiveApproval: {
                close: false,
                open: true,
                topUp: !this.policy.autoTopup?.enabled,
                voucher: false,
            },
        };
    }

    async authorizeOpen(input: AuthorizeOpenInput): Promise<AuthorizedOpen> {
        await this.ensureSwigInstalled();
        this.assertProgramAllowed(input.channelProgram);

        const deposit = parseNonNegativeAmount(input.depositAmount, 'depositAmount');
        if (this.depositLimit !== undefined && deposit > this.depositLimit) {
            throw new Error(`Open deposit exceeds depositLimit (${this.depositLimit.toString()})`);
        }

        const session = await this.ensureSessionSignerForOpen(input);
        await this.assertPolicyAppliedOnChain(input, session);

        const sessionSigner = session.signer;
        const transaction = await this.resolveOpenTx(input, session);
        const expiresAt = this.getSessionExpiresAt();

        const voucher = await this.signSwigVoucher(sessionSigner, {
            channelId: input.channelId,
            cumulativeAmount: '0',
            expiresAt,
        });

        this.channels.set(input.channelId, {
            deposited: deposit,
            lastCumulative: 0n,
            signerAddress: sessionSigner.address,
            ...(session.swigRoleId !== undefined ? { swigRoleId: session.swigRoleId } : {}),
        });

        return { transaction, voucher };
    }

    async authorizeVoucher(input: AuthorizeVoucherInput): Promise<AuthorizedVoucher> {
        await this.ensureSwigInstalled();

        const cumulativeAmount = parseNonNegativeAmount(input.cumulativeAmount, 'cumulativeAmount');
        if (this.spendLimit !== undefined && cumulativeAmount > this.spendLimit) {
            throw new Error(`Cumulative amount exceeds spendLimit (${this.spendLimit.toString()})`);
        }

        const progress = this.channels.get(input.channelId);
        const sessionSigner = this.requireActiveSessionSigner(input.channelId, progress);

        if (progress && cumulativeAmount < progress.lastCumulative) {
            throw new Error(
                `Cumulative amount must not decrease for channel ${input.channelId}. Last=${progress.lastCumulative.toString()}, received=${cumulativeAmount.toString()}`,
            );
        }

        const voucher = await this.signSwigVoucher(sessionSigner, {
            channelId: input.channelId,
            cumulativeAmount: cumulativeAmount.toString(),
            expiresAt: this.getSessionExpiresAt(),
        });

        this.channels.set(input.channelId, {
            deposited: progress?.deposited ?? 0n,
            lastCumulative: cumulativeAmount,
            signerAddress: sessionSigner.address,
            ...(progress?.swigRoleId !== undefined
                ? { swigRoleId: progress.swigRoleId }
                : this.sessionRoleId !== null
                  ? { swigRoleId: this.sessionRoleId }
                  : {}),
        });

        return { voucher };
    }

    async authorizeTopUp(input: AuthorizeTopUpInput): Promise<AuthorizedTopUp> {
        await this.ensureSwigInstalled();
        this.assertProgramAllowed(input.channelProgram);

        const progress = this.channels.get(input.channelId);
        this.requireActiveSessionSigner(input.channelId, progress);
        const additionalAmount = parseNonNegativeAmount(input.additionalAmount, 'additionalAmount');

        const nextDeposited = (progress?.deposited ?? 0n) + additionalAmount;
        if (this.depositLimit !== undefined && nextDeposited > this.depositLimit) {
            throw new Error(`TopUp exceeds depositLimit (${this.depositLimit.toString()})`);
        }

        const transaction = await this.resolveTopUpTx(input);

        this.channels.set(input.channelId, {
            deposited: nextDeposited,
            lastCumulative: progress?.lastCumulative ?? 0n,
            signerAddress: progress?.signerAddress ?? this.sessionSigner!.address,
            ...(progress?.swigRoleId !== undefined
                ? { swigRoleId: progress.swigRoleId }
                : this.sessionRoleId !== null
                  ? { swigRoleId: this.sessionRoleId }
                  : {}),
        });

        return { transaction };
    }

    async authorizeClose(input: AuthorizeCloseInput): Promise<AuthorizedClose> {
        await this.ensureSwigInstalled();

        if (!input.finalCumulativeAmount) {
            return {};
        }

        const finalCumulativeAmount = parseNonNegativeAmount(input.finalCumulativeAmount, 'finalCumulativeAmount');
        if (this.spendLimit !== undefined && finalCumulativeAmount > this.spendLimit) {
            throw new Error(`Final cumulative amount exceeds spendLimit (${this.spendLimit.toString()})`);
        }

        const progress = this.channels.get(input.channelId);
        const sessionSigner = this.requireActiveSessionSigner(input.channelId, progress);

        if (progress && finalCumulativeAmount < progress.lastCumulative) {
            throw new Error(
                `Cumulative amount must not decrease for channel ${input.channelId}. Last=${progress.lastCumulative.toString()}, received=${finalCumulativeAmount.toString()}`,
            );
        }

        const voucher = await this.signSwigVoucher(sessionSigner, {
            channelId: input.channelId,
            cumulativeAmount: finalCumulativeAmount.toString(),
            expiresAt: this.getSessionExpiresAt(),
        });

        this.channels.set(input.channelId, {
            deposited: progress?.deposited ?? 0n,
            lastCumulative: finalCumulativeAmount,
            signerAddress: sessionSigner.address,
            ...(progress?.swigRoleId !== undefined
                ? { swigRoleId: progress.swigRoleId }
                : this.sessionRoleId !== null
                  ? { swigRoleId: this.sessionRoleId }
                  : {}),
        });

        return { voucher };
    }

    private async signSwigVoucher(signer: KeyPairSigner, voucher: SessionVoucher): Promise<SignedSessionVoucher> {
        const signed = await signVoucher(signer, voucher);
        return {
            ...signed,
            signatureType: 'swig-session',
        };
    }

    private assertProgramAllowed(channelProgram: string) {
        if (!this.allowedPrograms) {
            return;
        }

        if (!this.allowedPrograms.has(channelProgram)) {
            throw new Error(`Channel program is not allowed: ${channelProgram}`);
        }
    }

    private requireActiveSessionSigner(channelId: string, progress: ChannelProgress | undefined): KeyPairSigner {
        if (!this.sessionSigner || this.sessionStartedAtMs === null) {
            throw new Error(`No active Swig session key for channel ${channelId}. Call authorizeOpen first.`);
        }

        if (this.isSessionExpired()) {
            throw new Error('Swig session key has expired. Re-open the channel to create a fresh session key.');
        }

        if (progress && progress.signerAddress !== this.sessionSigner.address) {
            throw new Error(
                `Session signer changed for channel ${channelId}; expected ${progress.signerAddress}, active ${this.sessionSigner.address}`,
            );
        }

        if (
            progress?.swigRoleId !== undefined &&
            this.sessionRoleId !== null &&
            progress.swigRoleId !== this.sessionRoleId
        ) {
            throw new Error(
                `Swig role changed for channel ${channelId}; expected ${progress.swigRoleId}, active ${this.sessionRoleId}`,
            );
        }

        return this.sessionSigner;
    }

    private async ensureSessionSignerForOpen(input: AuthorizeOpenInput): Promise<SessionSignerState> {
        if (this.sessionSigner && !this.isSessionExpired()) {
            return {
                signer: this.sessionSigner,
                ...(this.sessionOpenTransaction ? { openTx: this.sessionOpenTransaction } : {}),
                ...(this.sessionRoleId !== null ? { swigRoleId: this.sessionRoleId } : {}),
                ...(this.sessionStartedAtMs !== null ? { createdAtMs: this.sessionStartedAtMs } : {}),
            };
        }

        const existingResult = this.wallet.getSessionKey ? await this.wallet.getSessionKey() : null;
        if (existingResult) {
            const existing = normalizeSessionSignerState(existingResult, 'getSessionKey');

            if (existing.createdAtMs !== undefined) {
                this.setSessionState(existing);
                return existing;
            }

            if (!this.wallet.createSessionKey) {
                throw new Error(
                    'Swig wallet getSessionKey() must include `createdAt` when createSessionKey() is unavailable, so session TTL can be validated safely',
                );
            }
        }

        if (!this.wallet.createSessionKey) {
            throw new Error(
                'Swig wallet must implement createSessionKey() or getSessionKey() to use SwigSessionAuthorizer',
            );
        }

        const createdResult = await this.wallet.createSessionKey({
            ttlSeconds: this.policy.ttlSeconds,
            ...(this.policy.spendLimit ? { spendLimit: this.policy.spendLimit } : {}),
            ...(this.policy.depositLimit ? { depositLimit: this.policy.depositLimit } : {}),
            channelId: input.channelId,
            channelProgram: input.channelProgram,
            network: input.network,
            recipient: input.recipient,
        });

        const created = normalizeSessionSignerState(createdResult, 'createSessionKey');
        const resolvedCreated: SessionSignerState = {
            ...created,
            createdAtMs: created.createdAtMs ?? Date.now(),
        };

        this.setSessionState(resolvedCreated);
        return resolvedCreated;
    }

    private async ensureSwigInstalled() {
        if (this.swigLoaded) {
            return;
        }

        try {
            const swigPackageName = '@swig-wallet/kit';
            const module = (await import(swigPackageName)) as Partial<SwigSessionModule>;
            if (typeof module.fetchSwig !== 'function') {
                throw new Error('Installed `@swig-wallet/kit` does not export fetchSwig() at runtime');
            }
            this.swigModule = {
                fetchSwig: module.fetchSwig,
            };
            this.swigLoaded = true;
        } catch {
            throw new Error(
                'SwigSessionAuthorizer requires the optional dependency `@swig-wallet/kit`. Install it with `npm install @swig-wallet/kit` to use `swig_session` mode.',
            );
        }
    }

    private isSessionExpired(): boolean {
        if (this.sessionStartedAtMs === null) {
            return true;
        }

        return Date.now() > this.sessionStartedAtMs + this.policy.ttlSeconds * 1000;
    }

    private getSessionExpiresAt(): string {
        const start = this.sessionStartedAtMs ?? Date.now();
        return new Date(start + this.policy.ttlSeconds * 1000).toISOString();
    }

    private async resolveOpenTx(input: AuthorizeOpenInput, session: SessionSignerState): Promise<string> {
        if (!this.buildOpenTx) {
            if (!session.openTx) {
                throw new Error(
                    'SwigSessionAuthorizer requires `buildOpenTx` or a session setup result that includes `openTx` from `createSessionKey()`/`getSessionKey()`',
                );
            }

            return session.openTx;
        }

        return await this.buildOpenTx(input);
    }

    private async resolveTopUpTx(input: AuthorizeTopUpInput): Promise<string> {
        if (!this.buildTopUpTx) {
            throw new Error('SwigSessionAuthorizer requires `buildTopUpTx` to authorize topUp requests');
        }

        return await this.buildTopUpTx(input);
    }

    private setSessionState(state: SessionSignerState) {
        this.sessionSigner = state.signer;
        this.sessionStartedAtMs = state.createdAtMs ?? Date.now();
        this.sessionOpenTransaction = state.openTx ?? null;
        this.sessionRoleId = state.swigRoleId ?? this.wallet.swigRoleId ?? null;
        this.validatedPolicyForSessionSigner = null;
    }

    private resolveRpcUrl(network: string): string {
        return this.rpcUrl ?? DEFAULT_RPC_URLS[network] ?? DEFAULT_RPC_URLS['mainnet-beta'];
    }

    private async assertPolicyAppliedOnChain(input: AuthorizeOpenInput, session: SessionSignerState) {
        if (this.validatedPolicyForSessionSigner === session.signer.address) {
            return;
        }

        if (!this.wallet.swigAddress) {
            throw new Error(
                'Swig wallet adapter must provide `swigAddress` to validate on-chain session policy limits',
            );
        }

        const swigModule = this.swigModule;
        if (!swigModule) {
            throw new Error('Swig SDK was not loaded before on-chain validation');
        }

        const rpcUrl = this.resolveRpcUrl(input.network);
        const rpc = createSolanaRpc(rpcUrl);
        const swig = await swigModule.fetchSwig(rpc, this.wallet.swigAddress);

        const role = this.resolveSessionRole(swig, session);
        const actions = role.actions;

        if (!actions) {
            throw new Error(`Swig role ${role.id} does not expose action metadata for policy validation`);
        }

        this.assertRoleAllowsProgram(actions, input.channelProgram, role.id);

        const isSpl = input.currency !== 'sol';
        const onChainSpendLimit = isSpl
            ? this.resolveTokenSpendLimit(actions, input.currency)
            : this.resolveSolSpendLimit(actions);

        this.assertLimitAtMostPolicy(onChainSpendLimit, this.spendLimit, 'spendLimit', role.id, input.currency);
        this.assertLimitAtMostPolicy(onChainSpendLimit, this.depositLimit, 'depositLimit', role.id, input.currency);

        this.sessionRoleId = role.id;
        this.validatedPolicyForSessionSigner = session.signer.address;
    }

    private resolveSessionRole(swig: SwigAccount, session: SessionSignerState): SwigRole {
        const preferredRoleId = session.swigRoleId ?? this.sessionRoleId ?? this.wallet.swigRoleId;

        if (preferredRoleId !== undefined && preferredRoleId !== null && swig.findRoleById) {
            const roleById = swig.findRoleById(preferredRoleId);
            if (roleById) {
                if (swig.findRoleBySessionKey) {
                    const roleBySessionKey = swig.findRoleBySessionKey(session.signer.address);
                    if (!roleBySessionKey) {
                        throw new Error(
                            `Unable to locate a Swig role for delegated session key ${session.signer.address}`,
                        );
                    }

                    if (roleBySessionKey.id !== roleById.id) {
                        throw new Error(
                            `Swig role ${preferredRoleId} does not match delegated session key role ${roleBySessionKey.id}`,
                        );
                    }
                }

                return roleById;
            }

            throw new Error(`Unable to locate Swig role ${preferredRoleId} for session key ${session.signer.address}`);
        }

        if (!swig.findRoleBySessionKey) {
            throw new Error(
                'Swig account object does not expose findRoleBySessionKey() required for policy validation',
            );
        }

        const roleBySessionKey = swig.findRoleBySessionKey(session.signer.address);
        if (!roleBySessionKey) {
            throw new Error(`Unable to locate a Swig role for delegated session key ${session.signer.address}`);
        }

        return roleBySessionKey;
    }

    private assertRoleAllowsProgram(actions: SwigRoleActions, channelProgram: string, roleId: number) {
        if (!actions.canUseProgram) {
            return;
        }

        if (!actions.canUseProgram(channelProgram)) {
            throw new Error(`Swig role ${roleId} does not allow channel program ${channelProgram}`);
        }
    }

    private resolveTokenSpendLimit(actions: SwigRoleActions, currency: string): bigint | null {
        if (!actions.tokenSpendLimit) {
            throw new Error('Swig role does not expose tokenSpendLimit() for SPL policy validation');
        }
        return actions.tokenSpendLimit(currency);
    }

    private resolveSolSpendLimit(actions: SwigRoleActions): bigint | null {
        if (!actions.solSpendLimit) {
            throw new Error('Swig role does not expose solSpendLimit() for SOL policy validation');
        }
        return actions.solSpendLimit();
    }

    private assertLimitAtMostPolicy(
        onChainLimit: bigint | null,
        policyLimit: bigint | undefined,
        field: 'depositLimit' | 'spendLimit',
        roleId: number,
        currency: string,
    ) {
        if (policyLimit === undefined) {
            return;
        }

        if (onChainLimit === null) {
            throw new Error(
                `Swig role ${roleId} has uncapped ${currency.toUpperCase()} spending, but policy ${field}=${policyLimit.toString()} requires an on-chain cap`,
            );
        }

        if (onChainLimit > policyLimit) {
            throw new Error(
                `Swig role ${roleId} on-chain limit ${onChainLimit.toString()} exceeds policy ${field}=${policyLimit.toString()}`,
            );
        }
    }
}

function normalizeSessionSignerState(
    value: SwigSessionKeyResult,
    source: 'createSessionKey' | 'getSessionKey',
): SessionSignerState {
    if (isSignerLike(value)) {
        return { signer: value };
    }

    if (!value || typeof value !== 'object') {
        throw new Error(`Swig wallet ${source}() must return a signer or an object containing { signer }`);
    }

    const signer = (value as { signer?: unknown }).signer;
    if (!isSignerLike(signer)) {
        throw new Error(`Swig wallet ${source}() returned an invalid signer`);
    }

    const openTx = (value as { openTx?: unknown }).openTx;
    if (openTx !== undefined && typeof openTx !== 'string') {
        throw new Error(`Swig wallet ${source}() returned invalid openTx; expected string`);
    }

    const swigRoleIdRaw = (value as { swigRoleId?: unknown }).swigRoleId;
    let swigRoleId: number | undefined;
    if (swigRoleIdRaw !== undefined) {
        if (typeof swigRoleIdRaw !== 'number') {
            throw new Error(`Swig wallet ${source}() returned invalid swigRoleId; expected a non-negative integer`);
        }

        if (!Number.isInteger(swigRoleIdRaw) || swigRoleIdRaw < 0) {
            throw new Error(`Swig wallet ${source}() returned invalid swigRoleId; expected a non-negative integer`);
        }

        swigRoleId = swigRoleIdRaw;
    }

    const createdAtRaw = (value as { createdAt?: unknown }).createdAt;
    let createdAtMs: number | undefined;
    if (createdAtRaw !== undefined) {
        createdAtMs = parseCreatedAt(createdAtRaw, source);
    }

    return {
        signer,
        ...(openTx !== undefined && openTx.trim().length > 0 ? { openTx } : {}),
        ...(swigRoleId !== undefined ? { swigRoleId } : {}),
        ...(createdAtMs !== undefined ? { createdAtMs } : {}),
    };
}

function isSignerLike(value: unknown): value is KeyPairSigner {
    return !!value && typeof value === 'object' && typeof (value as { address?: unknown }).address === 'string';
}

function parseCreatedAt(value: unknown, source: 'createSessionKey' | 'getSessionKey'): number {
    const unixMs =
        value instanceof Date
            ? value.getTime()
            : typeof value === 'number'
              ? value
              : typeof value === 'string'
                ? Date.parse(value)
                : Number.NaN;

    if (!Number.isFinite(unixMs) || unixMs <= 0) {
        throw new Error(
            `Swig wallet ${source}() returned invalid createdAt; expected Date, unix milliseconds, or ISO timestamp string`,
        );
    }

    return unixMs;
}

function parseNonNegativeAmount(value: string, field: string): bigint {
    let amount: bigint;
    try {
        amount = BigInt(value);
    } catch {
        throw new Error(`${field} must be a valid integer string`);
    }

    if (amount < 0n) {
        throw new Error(`${field} must be non-negative`);
    }

    return amount;
}
