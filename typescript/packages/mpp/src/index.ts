// Shared types and method definition
export { charge } from './Methods.js';
export { session } from './Methods.js';

// Session types and authorizer utilities
export type {
    AuthorizationMode,
    SessionVoucher,
    SignedSessionVoucher,
    ChannelState,
    SessionCredentialPayload,
    VoucherVerifier,
    SessionAuthorizer,
    AuthorizeOpenInput,
    AuthorizedOpen,
    AuthorizeVoucherInput,
    AuthorizedVoucher,
    AuthorizeTopUpInput,
    AuthorizedTopUp,
    AuthorizeCloseInput,
    AuthorizedClose,
    AuthorizerCapabilities,
    SessionPolicyProfile,
} from './session/Types.js';

export {
    SwigBudgetAuthorizer,
    SwigSessionAuthorizer,
    UnboundedAuthorizer,
    makeSessionAuthorizer,
} from './session/authorizers/index.js';

// Convenience re-exports — for full usage, import from solana-mpp-sdk/server or solana-mpp-sdk/client
export * as server from './server/index.js';
export * as client from './client/index.js';
