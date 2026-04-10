/**
 * Network / blockhash sanity check.
 *
 * The Surfpool localnet implementation embeds a recognizable prefix into
 * every blockhash it returns. We use this to catch the common footgun
 * where a client signs a transaction against a Surfpool RPC and submits
 * it to a server configured for a real cluster (mainnet/devnet).
 *
 * The check is asymmetric:
 *
 *   - If the blockhash starts with the Surfpool prefix, the transaction
 *     was DEFINITELY signed against a Surfpool localnet. The only network
 *     slug for which that's valid is `localnet` — any other slug must
 *     reject the credential up-front.
 *
 *   - If the blockhash does NOT start with the Surfpool prefix, we can't
 *     tell what cluster it came from (real localnet doesn't add a prefix
 *     either), so we accept it.
 */

/**
 * Base58 prefix embedded in every blockhash returned by the Surfpool
 * localnet implementation.
 */
export const SURFPOOL_BLOCKHASH_PREFIX = 'SURFNETxSAFEHASH';

/**
 * Network slug for Solana's local validator. The only network for which
 * a Surfpool-prefixed blockhash is valid.
 */
export const LOCALNET_NETWORK = 'localnet';

/**
 * Error thrown when a Surfpool-signed blockhash is submitted to a server
 * configured for any network other than `localnet`.
 */
export class WrongNetworkError extends Error {
    readonly code = 'wrong-network' as const;
    readonly expected: string;
    readonly received = 'localnet' as const;
    readonly blockhash: string;

    constructor(opts: { expected: string; blockhash: string; message: string }) {
        super(opts.message);
        this.name = 'WrongNetworkError';
        this.expected = opts.expected;
        this.blockhash = opts.blockhash;
    }
}

/**
 * Pure check: throws if a Surfpool-prefixed blockhash is submitted to a
 * server configured for any network other than `localnet`.
 *
 * Returns silently in every other case — a non-prefixed blockhash is
 * undetectable as wrong-cluster from the slug alone, so we let the
 * downstream broadcast handle it.
 */
export function checkNetworkBlockhash(network: string, blockhashB58: string): void {
    if (!blockhashB58.startsWith(SURFPOOL_BLOCKHASH_PREFIX)) return;
    if (network === LOCALNET_NETWORK) return;
    // Blockhash detail is debug-grade and not actionable for end users.
    // The structured `blockhash` field on the error is still set so
    // tooling can read it programmatically.
    throw new WrongNetworkError({
        expected: network,
        blockhash: blockhashB58,
        message:
            `Signed against localnet but the server expects ${network}. ` +
            `Switch your client RPC to ${network} and re-sign.`,
    });
}
