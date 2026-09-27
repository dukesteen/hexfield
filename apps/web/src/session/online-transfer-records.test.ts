import { identityFromSecret } from '@cp2p/crypto';
import { MemoryEscrowLifecycleStore } from '@cp2p/protocol/testing';
import { expect, test } from 'vitest';
import { createTransferInvite } from './online-transfer-link.js';
import {
  loadCurrentTransferInvite,
  OnlineTransferRecordStore,
  saveCurrentTransferInvite,
} from './online-transfer-records.js';
import type { OnlineTransferExchangeRecord } from './online-transfer-records.js';

test('public transfer decisions survive reload and cannot switch destination or signed invitation', async () => {
  const source = identityFromSecret(new Uint8Array(32).fill(81));
  const destination = identityFromSecret(new Uint8Array(32).fill(82));
  const other = identityFromSecret(new Uint8Array(32).fill(83));
  const store = new MemoryEscrowLifecycleStore();
  try {
    const invite = createTransferInvite({
      identity: { ...source, dispose: () => source.secretKey.fill(0) },
      attemptId: 'A'.repeat(43),
      gameId: 'g'.repeat(22),
      genesisDigest: 'B'.repeat(43),
      seat: 0,
      serverUrl: 'wss://example.com',
      roomId: 'transferaa',
    });
    const records = new OnlineTransferRecordStore(store, source.peerId, invite, 'source');
    const record: OnlineTransferExchangeRecord = {
      protocol: 'online-transfer-exchange-v1',
      role: 'source',
      attemptId: invite.body.attemptId,
      gameId: invite.body.gameId,
      genesisDigest: invite.body.genesisDigest,
      sourceDevice: source.peerId,
      destinationDevice: destination.peerId,
      seat: 0,
      offer: null,
      approved: null,
      authorization: null,
      cancelRequested: false,
    };
    await records.save(record);
    const restored = new OnlineTransferRecordStore(store, source.peerId, invite, 'source');
    expect(await restored.load()).toEqual({ record, finished: false });
    await expect(restored.save({ ...record, destinationDevice: other.peerId })).rejects.toThrow(
      'pinned',
    );
    await expect(restored.save({ ...record, seat: 1 })).rejects.toThrow('invitation');
    await expect(
      restored.save({ ...record, authorization: { seq: 3, hash: 'a'.repeat(64) } }),
    ).rejects.toThrow('chosen offer');
    expect(await records.load()).toEqual({ record, finished: false });
    const changedInvite = createTransferInvite({
      ...invite.body,
      identity: { ...source, dispose: () => source.secretKey.fill(0) },
      genesisDigest: 'C'.repeat(43),
    });
    await expect(
      new OnlineTransferRecordStore(store, source.peerId, changedInvite, 'source').load(),
    ).rejects.toThrow('another invitation');
    await records.save({ ...record, cancelRequested: true });
    expect((await restored.load()).record?.cancelRequested).toBe(true);
    await expect(records.save(record)).rejects.toThrow('cannot be cleared');
  } finally {
    source.secretKey.fill(0);
    destination.secretKey.fill(0);
    other.secretKey.fill(0);
  }
});

test('the game locator preserves unfinished attempts and permits replacement only after finish', async () => {
  const source = identityFromSecret(new Uint8Array(32).fill(84));
  const store = new MemoryEscrowLifecycleStore();
  try {
    const identity = { ...source, dispose: () => source.secretKey.fill(0) };
    const input = {
      identity,
      gameId: 'h'.repeat(22),
      genesisDigest: 'D'.repeat(43),
      seat: 0 as const,
      serverUrl: 'wss://example.com',
      roomId: 'transferab',
    };
    const first = createTransferInvite({ ...input, attemptId: 'E'.repeat(43) });
    const second = createTransferInvite({ ...input, attemptId: 'F'.repeat(43) });
    await saveCurrentTransferInvite(store, source.peerId, first);
    await saveCurrentTransferInvite(store, source.peerId, first);
    await expect(saveCurrentTransferInvite(store, source.peerId, second)).rejects.toThrow(
      'progress',
    );
    expect(await loadCurrentTransferInvite(store, source.peerId, input.gameId)).toEqual(first);
    const records = new OnlineTransferRecordStore(store, source.peerId, first, 'source');
    await records.finish();
    await saveCurrentTransferInvite(store, source.peerId, second);
    expect(await loadCurrentTransferInvite(store, source.peerId, input.gameId)).toEqual(second);
    expect((await records.load()).finished).toBe(true);
  } finally {
    source.secretKey.fill(0);
  }
});
