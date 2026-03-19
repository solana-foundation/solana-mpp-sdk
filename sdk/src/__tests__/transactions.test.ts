import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    generateKeyPairSigner,
    pipe,
    createTransactionMessage,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash,
    appendTransactionMessageInstructions,
    partiallySignTransactionMessageWithSigners,
    getBase64EncodedWireTransaction,
    getTransactionDecoder,
    getBase64Codec,
    address,
    type TransactionPartialSigner,
    type Blockhash,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { coSignBase64Transaction } from '../utils/transactions.js';

// ── Helpers ──

/**
 * Build a partially-signed tx that mimics the real fee-payer flow:
 * client sets fee payer as an address (not a signer), signs the transfer,
 * and the server co-signs as fee payer afterward.
 */
async function buildPartiallySignedTx() {
    const sender = await generateKeyPairSigner();
    const feePayer = await generateKeyPairSigner();
    const recipientSigner = await generateKeyPairSigner();
    const recipient = recipientSigner.address;

    const blockhash = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N' as Blockhash;

    // Client sets fee payer as address only (not signer) — server will co-sign
    const txMessage = pipe(
        createTransactionMessage({ version: 0 }),
        msg => setTransactionMessageFeePayer(feePayer.address, msg),
        msg => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: 1000n }, msg),
        msg =>
            appendTransactionMessageInstructions(
                [
                    getTransferSolInstruction({
                        source: sender,
                        destination: recipient,
                        amount: 1_000_000n,
                    }),
                ],
                msg,
            ),
    );

    const partiallySigned = await partiallySignTransactionMessageWithSigners(txMessage);
    const base64Tx = getBase64EncodedWireTransaction(partiallySigned);

    return { base64Tx, feePayer, sender };
}

// ── Tests ──

test('coSignBase64Transaction co-signs with a valid TransactionPartialSigner', async () => {
    const { base64Tx, feePayer } = await buildPartiallySignedTx();

    const result = await coSignBase64Transaction(feePayer, base64Tx);

    assert.ok(typeof result === 'string' && result.length > 0);
    assert.notEqual(result, base64Tx, 'co-signed tx should differ from input');

    // Verify the fee payer signature is present in the decoded transaction
    const txBytes = getBase64Codec().encode(result);
    const decoded = getTransactionDecoder().decode(txBytes);
    const feePayerSig = decoded.signatures[feePayer.address];
    assert.ok(feePayerSig, 'fee payer signature should be present');
    assert.notEqual(feePayerSig, new Uint8Array(64), 'fee payer signature should not be empty bytes');
});

test('coSignBase64Transaction preserves existing signatures', async () => {
    const { base64Tx, feePayer, sender } = await buildPartiallySignedTx();

    const result = await coSignBase64Transaction(feePayer, base64Tx);

    // Decode and verify both sender and fee payer signatures are present
    const decoded = getTransactionDecoder().decode(getBase64Codec().encode(result));
    assert.ok(decoded.signatures[feePayer.address], 'fee payer sig should be present');
    assert.ok(decoded.signatures[sender.address], 'sender sig should be preserved');
});

test('coSignBase64Transaction throws on invalid base64 input', async () => {
    const feePayer = await generateKeyPairSigner();

    await assert.rejects(() => coSignBase64Transaction(feePayer, 'not-valid-base64!!!'));
});
