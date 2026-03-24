export type AuthorizationMode = 'regular_budget' | 'regular_unbounded' | 'swig_session';

export interface SessionVoucher {
    channelId: string;
    cumulativeAmount: string;
    expiresAt?: string;
}

export interface SignedSessionVoucher {
    signature: string;
    signatureType: 'ed25519' | 'swig-session';
    signer: string;
    voucher: SessionVoucher;
}

export interface ChannelState {
    /** Highest voucher cumulativeAmount the server has accepted. */
    acceptedCumulative: string;
    /** Voucher signer policy from the open credential. */
    authorizationPolicy?: Record<string, unknown>;
    /** Authorized signer for vouchers (payer or delegated key). */
    authorizedSigner: string;
    channelId: string;
    /** Unix timestamp when forced close was requested, or 0 if none. */
    closeRequestedAt: number;
    createdAt: string;
    /** Currency identifier: "sol" or SPL mint address. */
    currency: string;
    /** Token decimals for amount normalization. */
    decimals: number;
    /** Total amount deposited into the channel. */
    escrowedAmount: string;
    /** Whether the channel has been finalized (closed). */
    finalized: boolean;
    /** Payee (recipient) wallet. */
    payee: string;
    payer: string;
    /** Highest cumulativeAmount already claimed via on-chain settle. */
    settledOnChain: string;
    /** Cumulative amount charged for delivered service. */
    spentAmount: string;
    status: 'closed' | 'open';
}

export type SessionCredentialPayload =
    | {
          action: 'close';
          channelId: string;
          voucher?: SignedSessionVoucher;
      }
    | {
          action: 'open';
          authorizationPolicy?: Record<string, unknown>;
          capabilities?: Record<string, unknown>;
          channelId: string;
          depositAmount: string;
          expiresAt?: string;
          payer: string;
          transaction: string;
          voucher: SignedSessionVoucher;
      }
    | {
          action: 'topUp';
          additionalAmount: string;
          channelId: string;
          transaction: string;
      }
    | {
          action: 'voucher';
          channelId: string;
          voucher: SignedSessionVoucher;
      };

export interface VoucherVerifier {
    verify(voucher: SignedSessionVoucher, channel: ChannelState): Promise<boolean>;
}

export interface SessionAuthorizer {
    authorizeClose(input: AuthorizeCloseInput): Promise<AuthorizedClose>;
    authorizeOpen(input: AuthorizeOpenInput): Promise<AuthorizedOpen>;
    authorizeTopUp(input: AuthorizeTopUpInput): Promise<AuthorizedTopUp>;
    authorizeVoucher(input: AuthorizeVoucherInput): Promise<AuthorizedVoucher>;
    getCapabilities(): AuthorizerCapabilities;
    getMode(): AuthorizationMode;
}

export interface AuthorizeOpenInput {
    channelId: string;
    channelProgram: string;
    currency: string;
    decimals: number;
    depositAmount: string;
    feePayerKey?: string;
    network: string;
    recipient: string;
}

export interface AuthorizedOpen {
    transaction: string;
    voucher: SignedSessionVoucher;
}

export interface AuthorizeVoucherInput {
    channelId: string;
    cumulativeAmount: string;
}

export interface AuthorizedVoucher {
    voucher: SignedSessionVoucher;
}

export interface AuthorizeTopUpInput {
    additionalAmount: string;
    channelId: string;
    channelProgram: string;
    feePayerKey?: string;
    network: string;
}

export interface AuthorizedTopUp {
    transaction: string;
}

export interface AuthorizeCloseInput {
    channelId: string;
    finalCumulativeAmount?: string;
}

export interface AuthorizedClose {
    voucher?: SignedSessionVoucher;
}

export interface AuthorizerCapabilities {
    allowedActions?: Array<'close' | 'open' | 'topUp' | 'voucher'>;
    allowedPrograms?: string[];
    expiresAt?: string;
    maxCumulativeAmount?: string;
    maxDepositAmount?: string;
    mode: AuthorizationMode;
    requiresInteractiveApproval: {
        close: boolean;
        open: boolean;
        topUp: boolean;
        voucher: boolean;
    };
}

export type SessionPolicyProfile =
    | {
          autoTopup?: {
              amount: string;
              enabled: boolean;
              triggerBelow: string;
          };
          depositLimit?: string;
          profile: 'swig-time-bound';
          spendLimit?: string;
          ttlSeconds: number;
      }
    | {
          maxCumulativeAmount: string;
          maxDepositAmount?: string;
          profile: 'wallet-budget';
          requireApprovalOnTopup?: boolean;
          validUntil?: string;
      }
    | {
          profile: 'wallet-manual';
          requireApprovalOnEveryVoucher: boolean;
      };
