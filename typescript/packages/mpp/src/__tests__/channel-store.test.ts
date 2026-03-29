/**
 * Tests for session/ChannelStore.ts — get, update, deduct, and locking behavior.
 */
import { Store } from 'mppx/server';

import * as ChannelStore from '../session/ChannelStore.js';
import type { ChannelState } from '../session/Types.js';

function makeChannelState(overrides: Partial<ChannelState> = {}): ChannelState {
    return {
        asset: { decimals: 9, kind: 'sol' },
        authority: { wallet: 'wallet-abc' },
        authorizationMode: 'regular_unbounded',
        channelId: 'channel-1',
        createdAt: new Date().toISOString(),
        escrowedAmount: '1000',
        expiresAtUnix: null,
        lastAuthorizedAmount: '200',
        lastSequence: 1,
        openSlot: 100,
        payer: 'payer-abc',
        recipient: 'recipient-abc',
        serverNonce: 'nonce-1',
        settledAmount: '0',
        status: 'open',
        ...overrides,
    };
}

let store: Store.Store;

beforeEach(() => {
    store = Store.memory();
});

describe('fromStore', () => {
    test('returns a ChannelStore with getChannel and updateChannel methods', () => {
        const cs = ChannelStore.fromStore(store);
        expect(typeof cs.getChannel).toBe('function');
        expect(typeof cs.updateChannel).toBe('function');
    });

    test('caches store instances (same store returns same ChannelStore)', () => {
        const cs1 = ChannelStore.fromStore(store);
        const cs2 = ChannelStore.fromStore(store);
        expect(cs1).toBe(cs2);
    });

    test('different stores return different ChannelStore instances', () => {
        const store2 = Store.memory();
        const cs1 = ChannelStore.fromStore(store);
        const cs2 = ChannelStore.fromStore(store2);
        expect(cs1).not.toBe(cs2);
    });
});

describe('getChannel', () => {
    test('returns null for a non-existent channel', async () => {
        const cs = ChannelStore.fromStore(store);
        const result = await cs.getChannel('nonexistent');
        expect(result).toBeNull();
    });

    test('returns the stored channel after it is created', async () => {
        const cs = ChannelStore.fromStore(store);
        const channel = makeChannelState({ channelId: 'ch-get' });

        await cs.updateChannel('ch-get', () => channel);
        const retrieved = await cs.getChannel('ch-get');

        expect(retrieved).toEqual(channel);
    });
});

describe('updateChannel', () => {
    test('creates a new channel when updater returns a value', async () => {
        const cs = ChannelStore.fromStore(store);
        const channel = makeChannelState({ channelId: 'ch-create' });

        const result = await cs.updateChannel('ch-create', current => {
            expect(current).toBeNull();
            return channel;
        });

        expect(result).toEqual(channel);
    });

    test('updates an existing channel', async () => {
        const cs = ChannelStore.fromStore(store);
        const channel = makeChannelState({ channelId: 'ch-update' });

        await cs.updateChannel('ch-update', () => channel);

        const updated = await cs.updateChannel('ch-update', current => {
            expect(current).toEqual(channel);
            return { ...current!, lastSequence: 5, lastAuthorizedAmount: '500' };
        });

        expect(updated!.lastSequence).toBe(5);
        expect(updated!.lastAuthorizedAmount).toBe('500');
    });

    test('deletes a channel when updater returns null', async () => {
        const cs = ChannelStore.fromStore(store);
        const channel = makeChannelState({ channelId: 'ch-delete' });

        await cs.updateChannel('ch-delete', () => channel);
        const result = await cs.updateChannel('ch-delete', () => null);

        expect(result).toBeNull();

        const retrieved = await cs.getChannel('ch-delete');
        expect(retrieved).toBeNull();
    });

    test('handles concurrent updates with internal locking', async () => {
        const cs = ChannelStore.fromStore(store);
        const channel = makeChannelState({
            channelId: 'ch-concurrent',
            lastSequence: 0,
        });

        await cs.updateChannel('ch-concurrent', () => channel);

        // Fire two concurrent updates
        const [result1, result2] = await Promise.all([
            cs.updateChannel('ch-concurrent', current => ({
                ...current!,
                lastSequence: current!.lastSequence + 1,
            })),
            cs.updateChannel('ch-concurrent', current => ({
                ...current!,
                lastSequence: current!.lastSequence + 1,
            })),
        ]);

        // With locking, the second update should see the first update's result.
        // One should be 1, the other 2.
        const sequences = [result1!.lastSequence, result2!.lastSequence].sort();
        expect(sequences).toEqual([1, 2]);
    });
});

describe('deductFromChannel', () => {
    test('deducts from a channel successfully', async () => {
        const cs = ChannelStore.fromStore(store);
        const channel = makeChannelState({
            channelId: 'ch-deduct',
            escrowedAmount: '1000',
            lastAuthorizedAmount: '500',
            settledAmount: '100',
        });

        await cs.updateChannel('ch-deduct', () => channel);

        const { ok, channel: updated } = await ChannelStore.deductFromChannel(cs, 'ch-deduct', 50n);

        expect(ok).toBe(true);
        expect(updated.settledAmount).toBe('150');
    });

    test('refuses deduction that exceeds authorized amount', async () => {
        const cs = ChannelStore.fromStore(store);
        const channel = makeChannelState({
            channelId: 'ch-deduct-over',
            escrowedAmount: '1000',
            lastAuthorizedAmount: '200',
            settledAmount: '150',
        });

        await cs.updateChannel('ch-deduct-over', () => channel);

        const { ok, channel: updated } = await ChannelStore.deductFromChannel(cs, 'ch-deduct-over', 100n);

        expect(ok).toBe(false);
        expect(updated.settledAmount).toBe('150'); // Unchanged
    });

    test('refuses deduction that exceeds escrowed amount', async () => {
        const cs = ChannelStore.fromStore(store);
        const channel = makeChannelState({
            channelId: 'ch-deduct-escrow',
            escrowedAmount: '100',
            lastAuthorizedAmount: '500',
            settledAmount: '0',
        });

        await cs.updateChannel('ch-deduct-escrow', () => channel);

        // 101 > escrowedAmount (100), even though authorized is 500
        const { ok } = await ChannelStore.deductFromChannel(cs, 'ch-deduct-escrow', 101n);

        expect(ok).toBe(false);
    });

    test('allows deduction up to the exact spend ceiling', async () => {
        const cs = ChannelStore.fromStore(store);
        const channel = makeChannelState({
            channelId: 'ch-deduct-exact',
            escrowedAmount: '500',
            lastAuthorizedAmount: '300',
            settledAmount: '0',
        });

        await cs.updateChannel('ch-deduct-exact', () => channel);

        // Ceiling is min(authorized=300, escrowed=500) = 300
        const { ok, channel: updated } = await ChannelStore.deductFromChannel(cs, 'ch-deduct-exact', 300n);

        expect(ok).toBe(true);
        expect(updated.settledAmount).toBe('300');
    });

    test('deduction of zero succeeds', async () => {
        const cs = ChannelStore.fromStore(store);
        const channel = makeChannelState({
            channelId: 'ch-deduct-zero',
            settledAmount: '50',
        });

        await cs.updateChannel('ch-deduct-zero', () => channel);

        const { ok, channel: updated } = await ChannelStore.deductFromChannel(cs, 'ch-deduct-zero', 0n);

        expect(ok).toBe(true);
        expect(updated.settledAmount).toBe('50');
    });

    test('throws when amount is negative', async () => {
        const cs = ChannelStore.fromStore(store);
        const channel = makeChannelState({ channelId: 'ch-deduct-neg' });
        await cs.updateChannel('ch-deduct-neg', () => channel);

        await expect(ChannelStore.deductFromChannel(cs, 'ch-deduct-neg', -1n)).rejects.toThrow(
            /non-negative/,
        );
    });

    test('throws when channel does not exist', async () => {
        const cs = ChannelStore.fromStore(store);

        await expect(ChannelStore.deductFromChannel(cs, 'nonexistent', 10n)).rejects.toThrow(
            /channel not found/,
        );
    });
});
