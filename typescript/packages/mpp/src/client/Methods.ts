import { selectSolanaChargeChallenge } from './ChallengeSelection.js';
import { buildChargeTransaction, charge as charge_ } from './Charge.js';

/**
 * Creates a Solana `charge` method for usage on the client.
 *
 * Intercepts 402 responses, sends a Solana transaction to pay the challenge,
 * and retries with the transaction signature as credential automatically.
 *
 * @example
 * ```ts
 * import { Mppx, solana } from 'solana-mpp-sdk/client'
 *
 * const method = solana.charge({ signer })
 * const mppx = Mppx.create({ methods: [method] })
 *
 * const response = await mppx.fetch('https://api.example.com/paid-content')
 * ```
 */
export const solana: {
    (parameters: solana.Parameters): ReturnType<typeof charge_>;
    buildChargeTransaction: typeof buildChargeTransaction;
    charge: typeof charge_;
    selectChargeChallenge: typeof selectSolanaChargeChallenge;
} = Object.assign((parameters: solana.Parameters) => charge_(parameters), {
    buildChargeTransaction,
    charge: charge_,
    selectChargeChallenge: selectSolanaChargeChallenge,
});

export declare namespace solana {
    type Parameters = charge_.Parameters;
}
