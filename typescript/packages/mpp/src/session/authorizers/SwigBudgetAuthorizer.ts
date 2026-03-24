import { createSolanaRpc, type MessagePartialSigner } from '@solana/kit';

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
} from '../Types.js';
import { signVoucher } from '../Voucher.js';

type SwigRoleActions = {
    canUseProgram?: (programId: string) => boolean;
    solSpendLimit?: () => bigint | null;
    tokenSpendLimit?: (mint: string) => bigint | null;
};

type SwigAddressLike = {
    toBase58?: () => string;
};

type SwigRoleAuthority = {
    ed25519PublicKey?: SwigAddressLike;
    publicKey?: SwigAddressLike;
    sessionKey?: SwigAddressLike;
};

type SwigRole = {
    actions?: SwigRoleActions;
    authority?: SwigRoleAuthority;
    id: number;
};

type SwigAccount = {
    findRoleById?: (id: number) => SwigRole | null;
    findRoleBySessionKey?: (sessionKey: string) => SwigRole | null;
    findRolesByEd25519SignerPk?: (signerPk: string) => SwigRole[];
};

export type BudgetSwigModule = {
    fetchSwig: (rpc: unknown, swigAddress: string) => Promise<SwigAccount>;
};

type SwigOnChainRoleConfig = {
    rpcUrl?: string;
    swigAddress: string;
    swigRoleId: number;
};

type ChannelProgress = {
    deposited: bigint;
    lastCumulative: bigint;
    maxCumulativeAmount: bigint;
    maxDepositAmount?: bigint;
    swigRoleId?: number;
};

export interface SwigBudgetAuthorizerParameters {
    allowedPrograms?: string[];
    buildOpenTx?: (input: AuthorizeOpenInput) => Promise<string> | string;
    buildTopUpTx?: (input: AuthorizeTopUpInput) => Promise<string> | string;
    maxCumulativeAmount: string;
    maxDepositAmount?: string;
    requireApprovalOnTopup?: boolean;
    signer: MessagePartialSigner;
    swig: SwigOnChainRoleConfig;
    swigModule?: BudgetSwigModule;
    validUntil?: string;
}

export class SwigBudgetAuthorizer implements SessionAuthorizer {
    private readonly signer: MessagePartialSigner;
    private readonly maxCumulativeAmount: bigint;
    private readonly maxDepositAmount?: bigint;
    private readonly validUntil?: string;
    private readonly validUntilUnixMs?: number;
    private readonly allowedPrograms?: Set<string>;
    private readonly swig: SwigOnChainRoleConfig;
    private readonly buildOpenTx?: (input: AuthorizeOpenInput) => Promise<string> | string;
    private readonly buildTopUpTx?: (input: AuthorizeTopUpInput) => Promise<string> | string;
    private readonly channels = new Map<string, ChannelProgress>();
    private readonly capabilities: AuthorizerCapabilities;
    private swigLoaded = false;
    private swigModule: BudgetSwigModule | null = null;

    constructor(parameters: SwigBudgetAuthorizerParameters) {
        if (!parameters.swig) {
            throw new Error('SwigBudgetAuthorizer requires `swig` configuration with on-chain role details');
        }

        if (!Number.isInteger(parameters.swig.swigRoleId) || parameters.swig.swigRoleId < 0) {
            throw new Error('swig.swigRoleId must be a non-negative integer');
        }

        if (parameters.swig.swigAddress.trim().length === 0) {
            throw new Error('swig.swigAddress must be a non-empty string');
        }

        this.signer = parameters.signer;
        this.maxCumulativeAmount = parseNonNegativeAmount(parameters.maxCumulativeAmount, 'maxCumulativeAmount');
        this.maxDepositAmount =
            parameters.maxDepositAmount !== undefined
                ? parseNonNegativeAmount(parameters.maxDepositAmount, 'maxDepositAmount')
                : undefined;
        this.validUntil = parameters.validUntil;
        this.validUntilUnixMs =
            parameters.validUntil !== undefined ? parseIsoTimestamp(parameters.validUntil, 'validUntil') : undefined;
        this.allowedPrograms = parameters.allowedPrograms ? new Set(parameters.allowedPrograms) : undefined;
        this.swig = {
            swigAddress: parameters.swig.swigAddress,
            swigRoleId: parameters.swig.swigRoleId,
            ...(parameters.swig.rpcUrl ? { rpcUrl: parameters.swig.rpcUrl } : {}),
        };
        if (parameters.swigModule) {
            this.swigModule = parameters.swigModule;
            this.swigLoaded = true;
        }
        this.buildOpenTx = parameters.buildOpenTx;
        this.buildTopUpTx = parameters.buildTopUpTx;

        this.capabilities = {
            mode: 'regular_budget',
            ...(this.validUntil ? { expiresAt: this.validUntil } : {}),
            maxCumulativeAmount: this.maxCumulativeAmount.toString(),
            ...(parameters.maxDepositAmount ? { maxDepositAmount: parameters.maxDepositAmount } : {}),
            ...(parameters.allowedPrograms ? { allowedPrograms: [...parameters.allowedPrograms] } : {}),
            allowedActions: ['open', 'voucher', 'topUp', 'close'],
            requiresInteractiveApproval: {
                close: false,
                open: false,
                topUp: parameters.requireApprovalOnTopup ?? false,
                voucher: false,
            },
        };
    }

    getMode() {
        return 'regular_budget' as const;
    }

    getCapabilities(): AuthorizerCapabilities {
        return this.capabilities;
    }

    async authorizeOpen(input: AuthorizeOpenInput): Promise<AuthorizedOpen> {
        this.assertNotExpired();
        this.assertProgramAllowed(input.channelProgram);

        const onChainConstraints = await this.resolveOnChainConstraints(input);

        const deposit = parseNonNegativeAmount(input.depositAmount, 'depositAmount');
        const maxDepositAmount = onChainConstraints.maxDepositAmount ?? this.maxDepositAmount;
        if (maxDepositAmount !== undefined && deposit > maxDepositAmount) {
            throw new Error(`Open deposit exceeds maxDepositAmount (${maxDepositAmount.toString()})`);
        }

        const transaction = await this.resolveOpenTx(input);

        const voucher = await signVoucher(this.signer, {
            channelId: input.channelId,
            cumulativeAmount: '0',
            ...(this.validUntil ? { expiresAt: this.validUntil } : {}),
        });

        this.channels.set(input.channelId, {
            deposited: deposit,
            lastCumulative: 0n,
            maxCumulativeAmount: onChainConstraints.maxCumulativeAmount ?? this.maxCumulativeAmount,
            ...(maxDepositAmount !== undefined ? { maxDepositAmount } : {}),
            swigRoleId: onChainConstraints.swigRoleId,
        });

        return { transaction, voucher };
    }

    async authorizeVoucher(input: AuthorizeVoucherInput): Promise<AuthorizedVoucher> {
        this.assertNotExpired();

        const cumulativeAmount = parseNonNegativeAmount(input.cumulativeAmount, 'cumulativeAmount');

        const progress = this.channels.get(input.channelId);
        if (!progress) {
            throw new Error(`Unknown channel ${input.channelId}. Call authorizeOpen before authorizeVoucher.`);
        }

        if (cumulativeAmount > progress.maxCumulativeAmount) {
            throw new Error(
                `Cumulative amount exceeds maxCumulativeAmount (${progress.maxCumulativeAmount.toString()})`,
            );
        }

        if (cumulativeAmount < progress.lastCumulative) {
            throw new Error(
                `Cumulative amount must not decrease for channel ${input.channelId}. Last=${progress.lastCumulative.toString()}, received=${cumulativeAmount.toString()}`,
            );
        }

        const voucher = await signVoucher(this.signer, {
            channelId: input.channelId,
            cumulativeAmount: cumulativeAmount.toString(),
            ...(this.validUntil ? { expiresAt: this.validUntil } : {}),
        });

        this.channels.set(input.channelId, {
            ...progress,
            lastCumulative: cumulativeAmount,
        });

        return { voucher };
    }

    async authorizeTopUp(input: AuthorizeTopUpInput): Promise<AuthorizedTopUp> {
        this.assertNotExpired();
        this.assertProgramAllowed(input.channelProgram);

        const additionalAmount = parseNonNegativeAmount(input.additionalAmount, 'additionalAmount');
        const progress = this.channels.get(input.channelId);
        if (!progress) {
            throw new Error(`Unknown channel ${input.channelId}. Call authorizeOpen before authorizeTopUp.`);
        }

        const nextDeposited = progress.deposited + additionalAmount;
        const maxDepositAmount = progress.maxDepositAmount ?? this.maxDepositAmount;

        if (maxDepositAmount !== undefined && nextDeposited > maxDepositAmount) {
            throw new Error(`TopUp exceeds maxDepositAmount (${maxDepositAmount.toString()})`);
        }

        const transaction = await this.resolveTopUpTx(input);

        this.channels.set(input.channelId, {
            ...progress,
            deposited: nextDeposited,
        });

        return { transaction };
    }

    async authorizeClose(input: AuthorizeCloseInput): Promise<AuthorizedClose> {
        this.assertNotExpired();

        if (!input.finalCumulativeAmount) {
            return {};
        }

        const finalCumulativeAmount = parseNonNegativeAmount(input.finalCumulativeAmount, 'finalCumulativeAmount');

        const progress = this.channels.get(input.channelId);
        if (!progress) {
            throw new Error(`Unknown channel ${input.channelId}. Call authorizeOpen before authorizeClose.`);
        }

        if (finalCumulativeAmount > progress.maxCumulativeAmount) {
            throw new Error(
                `Final cumulative amount exceeds maxCumulativeAmount (${progress.maxCumulativeAmount.toString()})`,
            );
        }

        if (finalCumulativeAmount < progress.lastCumulative) {
            throw new Error(
                `Cumulative amount must not decrease for channel ${input.channelId}. Last=${progress.lastCumulative.toString()}, received=${finalCumulativeAmount.toString()}`,
            );
        }

        const voucher = await signVoucher(this.signer, {
            channelId: input.channelId,
            cumulativeAmount: finalCumulativeAmount.toString(),
            ...(this.validUntil ? { expiresAt: this.validUntil } : {}),
        });

        this.channels.set(input.channelId, {
            ...progress,
            lastCumulative: finalCumulativeAmount,
        });

        return { voucher };
    }

    private assertNotExpired() {
        if (this.validUntilUnixMs !== undefined && Date.now() > this.validUntilUnixMs) {
            throw new Error('Budget authorizer policy has expired');
        }
    }

    private assertProgramAllowed(channelProgram: string) {
        if (!this.allowedPrograms) {
            return;
        }

        if (!this.allowedPrograms.has(channelProgram)) {
            throw new Error(`Channel program is not allowed: ${channelProgram}`);
        }
    }

    private async resolveOnChainConstraints(input: AuthorizeOpenInput): Promise<{
        maxCumulativeAmount: bigint;
        maxDepositAmount: bigint;
        swigRoleId: number;
    }> {
        await this.ensureSwigInstalled();

        const swigModule = this.swigModule;
        if (!swigModule) {
            throw new Error('Swig SDK was not loaded before budget role validation');
        }

        const rpc = createSolanaRpc(this.resolveRpcUrl(input.network));
        const swig = await swigModule.fetchSwig(rpc, this.swig.swigAddress);
        const role = this.resolveSwigRole(swig);
        const actions = role.actions;

        if (!actions) {
            throw new Error(`Swig role ${role.id} does not expose action metadata for budget validation`);
        }

        if (!actions.canUseProgram) {
            throw new Error(`Swig role ${role.id} does not expose canUseProgram() for program authorization checks`);
        }

        if (!actions.canUseProgram(input.channelProgram)) {
            throw new Error(`Swig role ${role.id} does not allow channel program ${input.channelProgram}`);
        }

        const isSpl = input.currency !== 'sol';
        const onChainLimit = isSpl
            ? this.resolveTokenSpendLimit(actions, input.currency)
            : this.resolveSolSpendLimit(actions);

        if (onChainLimit === null) {
            throw new Error(
                `Swig role ${role.id} has uncapped spending; SwigBudgetAuthorizer requires an on-chain spend cap`,
            );
        }

        return {
            maxCumulativeAmount: minBigInt(this.maxCumulativeAmount, onChainLimit),
            maxDepositAmount:
                this.maxDepositAmount !== undefined ? minBigInt(this.maxDepositAmount, onChainLimit) : onChainLimit,
            swigRoleId: role.id,
        };
    }

    private resolveSwigRole(swig: SwigAccount): SwigRole {
        if (!swig.findRoleById) {
            throw new Error('Swig account object does not expose findRoleById() required for configured swigRoleId');
        }

        const role = swig.findRoleById(this.swig.swigRoleId);
        if (!role) {
            throw new Error(`Unable to locate Swig role ${this.swig.swigRoleId} for signer ${this.signer.address}`);
        }

        if (swig.findRolesByEd25519SignerPk) {
            const signerRoles = swig.findRolesByEd25519SignerPk(this.signer.address);
            const roleMatchesSigner = signerRoles.some(signerRole => signerRole.id === role.id);

            if (roleMatchesSigner) {
                return role;
            }
        }

        if (swig.findRoleBySessionKey) {
            const sessionRole = swig.findRoleBySessionKey(this.signer.address);
            if (sessionRole?.id === role.id) {
                return role;
            }
        }

        const authorityAddresses = collectAuthorityAddresses(role.authority);
        if (authorityAddresses.includes(this.signer.address)) {
            return role;
        }

        throw new Error(`Configured Swig role ${role.id} does not match signer ${this.signer.address}`);
    }

    private resolveTokenSpendLimit(actions: SwigRoleActions, currency: string): bigint | null {
        if (!actions.tokenSpendLimit) {
            throw new Error('Swig role does not expose tokenSpendLimit() for SPL budget validation');
        }
        return actions.tokenSpendLimit(currency);
    }

    private resolveSolSpendLimit(actions: SwigRoleActions): bigint | null {
        if (!actions.solSpendLimit) {
            throw new Error('Swig role does not expose solSpendLimit() for SOL budget validation');
        }
        return actions.solSpendLimit();
    }

    private resolveRpcUrl(network: string): string {
        return this.swig.rpcUrl ?? DEFAULT_RPC_URLS[network] ?? DEFAULT_RPC_URLS['mainnet-beta'];
    }

    private async ensureSwigInstalled() {
        if (this.swigLoaded) {
            return;
        }

        try {
            const swigPackageName = '@swig-wallet/kit';
            const module = (await import(swigPackageName)) as Partial<BudgetSwigModule>;
            if (typeof module.fetchSwig !== 'function') {
                throw new Error('Installed `@swig-wallet/kit` does not export fetchSwig() at runtime');
            }

            this.swigModule = {
                fetchSwig: module.fetchSwig,
            };
            this.swigLoaded = true;
        } catch {
            throw new Error(
                'SwigBudgetAuthorizer with `swig` config requires optional dependency `@swig-wallet/kit`. Install it with `npm install @swig-wallet/kit`.',
            );
        }
    }

    private async resolveOpenTx(input: AuthorizeOpenInput): Promise<string> {
        if (!this.buildOpenTx) {
            throw new Error('SwigBudgetAuthorizer requires `buildOpenTx` to authorize open requests');
        }

        return await this.buildOpenTx(input);
    }

    private async resolveTopUpTx(input: AuthorizeTopUpInput): Promise<string> {
        if (!this.buildTopUpTx) {
            throw new Error('SwigBudgetAuthorizer requires `buildTopUpTx` to authorize topUp requests');
        }

        return await this.buildTopUpTx(input);
    }
}

function collectAuthorityAddresses(authority: SwigRoleAuthority | undefined): string[] {
    if (!authority) {
        return [];
    }

    const candidates = [authority.publicKey, authority.ed25519PublicKey, authority.sessionKey];

    return candidates.map(candidate => candidate?.toBase58?.()).filter((candidate): candidate is string => !!candidate);
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

function parseIsoTimestamp(value: string, field: string): number {
    const unixMs = Date.parse(value);
    if (Number.isNaN(unixMs)) {
        throw new Error(`${field} must be a valid ISO timestamp`);
    }
    return unixMs;
}

function minBigInt(a: bigint, b: bigint): bigint {
    return a <= b ? a : b;
}
