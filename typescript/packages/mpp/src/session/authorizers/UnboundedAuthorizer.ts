import type { MessagePartialSigner } from '@solana/kit';

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

type ChannelProgress = {
    lastCumulative: bigint;
};

export interface UnboundedAuthorizerParameters {
    allowedPrograms?: string[];
    buildOpenTx?: (input: AuthorizeOpenInput) => Promise<string> | string;
    buildTopUpTx?: (input: AuthorizeTopUpInput) => Promise<string> | string;
    expiresAt?: string;
    requiresInteractiveApproval?: Partial<AuthorizerCapabilities['requiresInteractiveApproval']>;
    signer: MessagePartialSigner;
}

export class UnboundedAuthorizer implements SessionAuthorizer {
    private readonly signer: MessagePartialSigner;
    private readonly allowedPrograms?: Set<string>;
    private readonly expiresAt?: string;
    private readonly expiresAtUnixMs?: number;
    private readonly buildOpenTx?: (input: AuthorizeOpenInput) => Promise<string> | string;
    private readonly buildTopUpTx?: (input: AuthorizeTopUpInput) => Promise<string> | string;
    private readonly channels = new Map<string, ChannelProgress>();
    private readonly capabilities: AuthorizerCapabilities;

    constructor(parameters: UnboundedAuthorizerParameters) {
        this.signer = parameters.signer;
        this.allowedPrograms = parameters.allowedPrograms ? new Set(parameters.allowedPrograms) : undefined;
        this.expiresAt = parameters.expiresAt;
        this.expiresAtUnixMs =
            parameters.expiresAt !== undefined ? parseIsoTimestamp(parameters.expiresAt, 'expiresAt') : undefined;
        this.buildOpenTx = parameters.buildOpenTx;
        this.buildTopUpTx = parameters.buildTopUpTx;

        const requiresInteractiveApproval = {
            close: parameters.requiresInteractiveApproval?.close ?? false,
            open: parameters.requiresInteractiveApproval?.open ?? false,
            topUp: parameters.requiresInteractiveApproval?.topUp ?? false,
            voucher: parameters.requiresInteractiveApproval?.voucher ?? false,
        };

        this.capabilities = {
            mode: 'regular_unbounded',
            ...(this.expiresAt ? { expiresAt: this.expiresAt } : {}),
            ...(parameters.allowedPrograms ? { allowedPrograms: [...parameters.allowedPrograms] } : {}),
            allowedActions: ['open', 'voucher', 'topUp', 'close'],
            requiresInteractiveApproval,
        };
    }

    getMode() {
        return 'regular_unbounded' as const;
    }

    getCapabilities(): AuthorizerCapabilities {
        return this.capabilities;
    }

    async authorizeOpen(input: AuthorizeOpenInput): Promise<AuthorizedOpen> {
        this.assertNotExpired();
        this.assertProgramAllowed(input.channelProgram);

        const transaction = await this.resolveOpenTx(input);

        const voucher = await signVoucher(this.signer, {
            channelId: input.channelId,
            cumulativeAmount: '0',
            ...(this.expiresAt ? { expiresAt: this.expiresAt } : {}),
        });

        this.channels.set(input.channelId, { lastCumulative: 0n });

        return { transaction, voucher };
    }

    async authorizeVoucher(input: AuthorizeVoucherInput): Promise<AuthorizedVoucher> {
        this.assertNotExpired();

        const cumulativeAmount = parseNonNegativeAmount(input.cumulativeAmount, 'cumulativeAmount');

        const progress = this.channels.get(input.channelId);
        if (progress !== undefined && cumulativeAmount < progress.lastCumulative) {
            throw new Error(
                `Cumulative amount must not decrease for channel ${input.channelId}. Last=${progress.lastCumulative.toString()}, received=${cumulativeAmount.toString()}`,
            );
        }

        const voucher = await signVoucher(this.signer, {
            channelId: input.channelId,
            cumulativeAmount: cumulativeAmount.toString(),
            ...(this.expiresAt ? { expiresAt: this.expiresAt } : {}),
        });

        this.channels.set(input.channelId, { lastCumulative: cumulativeAmount });

        return { voucher };
    }

    async authorizeTopUp(input: AuthorizeTopUpInput): Promise<AuthorizedTopUp> {
        this.assertNotExpired();
        this.assertProgramAllowed(input.channelProgram);
        parseNonNegativeAmount(input.additionalAmount, 'additionalAmount');

        return {
            transaction: await this.resolveTopUpTx(input),
        };
    }

    async authorizeClose(input: AuthorizeCloseInput): Promise<AuthorizedClose> {
        this.assertNotExpired();

        if (!input.finalCumulativeAmount) {
            return {};
        }

        const finalCumulativeAmount = parseNonNegativeAmount(input.finalCumulativeAmount, 'finalCumulativeAmount');

        const progress = this.channels.get(input.channelId);
        if (progress !== undefined && finalCumulativeAmount < progress.lastCumulative) {
            throw new Error(
                `Cumulative amount must not decrease for channel ${input.channelId}. Last=${progress.lastCumulative.toString()}, received=${finalCumulativeAmount.toString()}`,
            );
        }

        const voucher = await signVoucher(this.signer, {
            channelId: input.channelId,
            cumulativeAmount: finalCumulativeAmount.toString(),
            ...(this.expiresAt ? { expiresAt: this.expiresAt } : {}),
        });

        this.channels.set(input.channelId, { lastCumulative: finalCumulativeAmount });

        return { voucher };
    }

    private assertNotExpired() {
        if (this.expiresAtUnixMs !== undefined && Date.now() > this.expiresAtUnixMs) {
            throw new Error('Unbounded authorizer policy has expired');
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

    private async resolveOpenTx(input: AuthorizeOpenInput): Promise<string> {
        if (!this.buildOpenTx) {
            throw new Error('UnboundedAuthorizer requires `buildOpenTx` to authorize open requests');
        }

        return await this.buildOpenTx(input);
    }

    private async resolveTopUpTx(input: AuthorizeTopUpInput): Promise<string> {
        if (!this.buildTopUpTx) {
            throw new Error('UnboundedAuthorizer requires `buildTopUpTx` to authorize topUp requests');
        }

        return await this.buildTopUpTx(input);
    }
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
