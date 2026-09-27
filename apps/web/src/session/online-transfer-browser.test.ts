import { toBase64Url } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import { MemoryEscrowLifecycleStore, VirtualClock } from '@cp2p/protocol/testing';
import { afterEach, expect, test, vi } from 'vitest';
import type { OnlineWorkerClient } from './online-worker-client.js';
import type { OnlineTransferChannel } from './online-transfer-channel.js';
import { OnlineTransferBrowser } from './online-transfer-browser.js';
import { createTransferInvite, OnlineTransferLink } from './online-transfer-link.js';
import type { OnlineTransferLinkOptions } from './online-transfer-link.js';
import { OnlineTransferRecordStore, saveCurrentTransferInvite } from './online-transfer-records.js';
import type { OnlineTransferExchangeRecord } from './online-transfer-records.js';
import type { OnlineWorkerRequestBody, OnlineWorkerReplyByKind } from './online-worker-messages.js';

test('a finished destination restores only a worker-verified cancellation and retries its receipt', async () => {
  const source = identityFromSecret(new Uint8Array(32).fill(111));
  const destination = identityFromSecret(new Uint8Array(32).fill(112));
  const invite = createTransferInvite({
    attemptId: 'C'.repeat(43),
    gameId: 'c'.repeat(22),
    seat: 0,
    genesisDigest: testKey(8),
    roomId: 'transferae',
    serverUrl: 'wss://signal.example/',
    identity: { ...source, dispose: () => source.secretKey.fill(0) },
  });
  const store = new MemoryEscrowLifecycleStore();
  const records = new OnlineTransferRecordStore(store, destination.peerId, invite, 'destination');
  await records.save({
    ...sourceRecord(invite, destination.peerId),
    role: 'destination',
    approved: null,
  });
  await records.finish();
  const callbacks: OnlineTransferLinkOptions[] = [];
  vi.spyOn(OnlineTransferLink, 'openDestination').mockImplementation((options) => {
    callbacks.push(options);
    return asTestLink({ close() {} });
  });
  const workerCalls: string[] = [];
  const worker = asTestWorker({
    async request(body: OnlineWorkerRequestBody) {
      workerCalls.push(body.kind);
      if (body.kind !== 'initializeTransfer')
        throw new Error('Terminal restore needs no other worker request');
      return {
        ok: true,
        value: {
          phase: 'cancelled',
          gameId: invite.body.gameId,
          head: ref(12),
          authorization: ref(11),
          outcome: { authorization: ref(11), entry: ref(12), outcome: 'cancelled' },
        },
      };
    },
    async shutdown() {
      workerCalls.push('shutdown');
    },
  });
  let browser: OnlineTransferBrowser | undefined;
  try {
    browser = await OnlineTransferBrowser.openDestination({
      invite,
      identity: { ...destination, dispose: () => destination.secretKey.fill(0) },
      store,
      worker,
      clock: new VirtualClock(),
      network: {},
    });
    expect(workerCalls).toEqual(['initializeTransfer', 'shutdown']);
    expect(browser.getSnapshot()).toMatchObject({
      phase: 'cancelled',
      promotedGameId: null,
      error: null,
    });
    callbacks[0]?.onError(new Error('Retired source is unavailable'));
    expect(browser.getSnapshot()).toMatchObject({ phase: 'cancelled', error: null });
    const sent: string[] = [];
    callbacks[0]?.onChannel(
      asTestChannel({
        async send(artifact: { kind: string }) {
          sent.push(artifact.kind);
        },
      }),
    );
    await vi.waitFor(() => expect(sent).toEqual(['received']));
    expect(browser.getSnapshot()).toMatchObject({ phase: 'cancelled', promotedGameId: null });
  } finally {
    await browser?.close();
    source.secretKey.fill(0);
    destination.secretKey.fill(0);
  }
});

test('a finished destination record cannot assert cancellation without a verified outcome', async () => {
  const source = identityFromSecret(new Uint8Array(32).fill(113));
  const destination = identityFromSecret(new Uint8Array(32).fill(114));
  const invite = createTransferInvite({
    attemptId: 'D'.repeat(43),
    gameId: 'd'.repeat(22),
    seat: 0,
    genesisDigest: testKey(9),
    roomId: 'transferaf',
    serverUrl: 'wss://signal.example/',
    identity: { ...source, dispose: () => source.secretKey.fill(0) },
  });
  const store = new MemoryEscrowLifecycleStore();
  const records = new OnlineTransferRecordStore(store, destination.peerId, invite, 'destination');
  await records.save({
    ...sourceRecord(invite, destination.peerId),
    role: 'destination',
    approved: null,
  });
  await records.finish();
  const link = vi.spyOn(OnlineTransferLink, 'openDestination');
  const worker = asTestWorker({
    async request() {
      return {
        ok: true,
        value: {
          phase: 'cancelled',
          gameId: invite.body.gameId,
          head: ref(12),
          authorization: ref(11),
          outcome: null,
        },
      };
    },
    async shutdown() {},
  });
  try {
    await expect(
      OnlineTransferBrowser.openDestination({
        invite,
        identity: { ...destination, dispose: () => destination.secretKey.fill(0) },
        store,
        worker,
        clock: new VirtualClock(),
        network: {},
      }),
    ).rejects.toThrow('matching certified terminal result');
    expect(link).not.toHaveBeenCalled();
  } finally {
    source.secretKey.fill(0);
    destination.secretKey.fill(0);
  }
});

test('an imported checkpoint is pinned before linking and cannot be omitted on reopen', async () => {
  const source = identityFromSecret(new Uint8Array(32).fill(115));
  const destination = identityFromSecret(new Uint8Array(32).fill(116));
  const invite = createTransferInvite({
    attemptId: 'E'.repeat(43),
    gameId: 'e'.repeat(22),
    seat: 0,
    genesisDigest: testKey(10),
    roomId: 'transferag',
    serverUrl: 'wss://signal.example/',
    identity: { ...source, dispose: () => source.secretKey.fill(0) },
  });
  const archiveId = 'f'.repeat(64);
  const store = new MemoryEscrowLifecycleStore();
  const link = vi
    .spyOn(OnlineTransferLink, 'openDestination')
    .mockImplementation(() => asTestLink({ close() {} }));
  const workerCalls: string[] = [];
  const worker = asTestWorker({
    async request(body: OnlineWorkerRequestBody) {
      workerCalls.push(body.kind);
      throw new Error(`Unexpected initial request ${body.kind}`);
    },
    async shutdown() {},
  });
  let browser: OnlineTransferBrowser | undefined;
  try {
    browser = await OnlineTransferBrowser.openDestination({
      invite,
      importedArchiveId: archiveId,
      identity: { ...destination, dispose: () => destination.secretKey.fill(0) },
      store,
      worker,
      clock: new VirtualClock(),
      network: {},
    });
    const records = new OnlineTransferRecordStore(store, destination.peerId, invite, 'destination');
    expect(await records.load()).toMatchObject({
      finished: false,
      record: { importedArchiveId: archiveId },
    });
    expect(workerCalls).toEqual([]);
    await expect(
      OnlineTransferBrowser.openDestination({
        invite,
        identity: { ...destination, dispose: () => destination.secretKey.fill(0) },
        store,
        worker,
        clock: new VirtualClock(),
        network: {},
      }),
    ).rejects.toThrow('pinned to another imported checkpoint');
    expect(link).toHaveBeenCalledOnce();
  } finally {
    await browser?.close();
    source.secretKey.fill(0);
    destination.secretKey.fill(0);
  }
});

afterEach(() => vi.restoreAllMocks());

function asTestLink(value: object): OnlineTransferLink {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Browser tests use only the mock link methods their scenario invokes.
  return value as unknown as OnlineTransferLink;
}

function asTestWorker(value: object): OnlineWorkerClient {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Browser tests provide only the worker requests needed by their scenario.
  return value as unknown as OnlineWorkerClient;
}

function asTestChannel(value: object): OnlineTransferChannel {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The mock implements only receipt sending used by terminal retry.
  return value as OnlineTransferChannel;
}

test('an error from a replaced transfer link cannot clear the current browser connection', async () => {
  const source = identityFromSecret(new Uint8Array(32).fill(71));
  const destination = identityFromSecret(new Uint8Array(32).fill(72));
  const invite = createTransferInvite({
    attemptId: 'A'.repeat(43),
    gameId: 'b'.repeat(22),
    seat: 0,
    genesisDigest: 'C'.repeat(43),
    roomId: 'transferac',
    serverUrl: 'wss://signal.example/',
    identity: { ...source, dispose: () => source.secretKey.fill(0) },
  });
  const callbacks: OnlineTransferLinkOptions[] = [];
  const closed: boolean[] = [];
  vi.spyOn(OnlineTransferLink, 'openDestination').mockImplementation((options) => {
    const index = callbacks.push(options) - 1;
    closed.push(false);
    const mock = {
      close: () => {
        closed[index] = true;
      },
    };
    return asTestLink(mock);
  });
  let shutdowns = 0;
  const worker = asTestWorker({
    shutdown: async () => {
      shutdowns += 1;
    },
  });
  const browser = await OnlineTransferBrowser.openDestination({
    invite,
    identity: { ...destination, dispose: () => destination.secretKey.fill(0) },
    store: new MemoryEscrowLifecycleStore(),
    worker,
    clock: new VirtualClock(),
    network: {},
  });
  try {
    expect(callbacks).toHaveLength(1);
    await browser.retry();
    expect(callbacks).toHaveLength(2);
    expect(closed[0]).toBe(true);
    callbacks[0]?.onError(new Error('stale link failure'));
    expect(browser.getSnapshot().error).toBeNull();
    callbacks[1]?.onError(new Error('current link failure'));
    expect(browser.getSnapshot().error).toBe('current link failure');
  } finally {
    await browser.close();
    source.secretKey.fill(0);
    destination.secretKey.fill(0);
  }
  expect(shutdowns).toBe(1);
});

const testKey = (byte: number) => toBase64Url(new Uint8Array(32).fill(byte));
const testSignature = toBase64Url(new Uint8Array(64).fill(9));
const ref = (seq: number) => ({ seq, hash: seq.toString(16).padStart(64, '0') });

function transferDecision(
  sourceDevice: string,
  destinationDevice: string,
  gameId: string,
  genesisDigest: string,
) {
  const statement = {
    protocol: 'seat-transfer-v1' as const,
    genesisDigest,
    anchor: ref(10),
    validUntilSeq: 74,
    mode: 'live' as const,
    seat: 0 as const,
    currentController: {
      publicKey: testKey(3),
      kind: 'human' as const,
      activatedAt: ref(0),
      hostSeat: 0 as const,
    },
    recovery: null,
    nextEpoch: 1,
    destination: {
      devicePeer: destinationDevice,
      gamePeer: testKey(4),
      transferEncryptionKey: testKey(5),
    },
    replacements: [
      {
        seat: 0 as const,
        oldPublicKey: testKey(3),
        newPublicKey: testKey(4),
        newHostSeat: 0 as const,
      },
    ],
  };
  expect(gameId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(sourceDevice).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return {
    kind: 'transfer-authorize' as const,
    statement,
    destinationDeviceSig: testSignature,
    destinationGameSig: testSignature,
    replacementKeySigs: [],
    ownerIntent: { signer: 'current-game' as const, sig: testSignature },
  };
}

function sourceRecord(
  invite: ReturnType<typeof createTransferInvite>,
  destinationDevice: string,
): OnlineTransferExchangeRecord {
  const offer = transferDecision(
    invite.body.sourceDevice,
    destinationDevice,
    invite.body.gameId,
    invite.body.genesisDigest,
  );
  return {
    protocol: 'online-transfer-exchange-v1',
    role: 'source',
    attemptId: invite.body.attemptId,
    gameId: invite.body.gameId,
    genesisDigest: invite.body.genesisDigest,
    sourceDevice: invite.body.sourceDevice,
    destinationDevice,
    seat: invite.body.seat,
    offer,
    approved: offer,
    authorization: ref(11),
    cancelRequested: false,
  };
}

function sourceLink(candidates: readonly string[] = [], failSelect?: Error) {
  let onCandidates: ((peers: readonly string[]) => void) | null = null;
  const link = {
    candidates: () => [...candidates],
    onCandidates(listener: (peers: readonly string[]) => void) {
      onCandidates = listener;
      try {
        listener([...candidates]);
      } catch {
        // OnlineTransferLink isolates candidate observer failures from transport callbacks.
      }
      return () => {
        onCandidates = null;
      };
    },
    selectDestination() {
      if (failSelect) throw failSelect;
    },
    close() {},
    emit(peers: readonly string[]) {
      onCandidates?.([...peers]);
    },
  };
  return link;
}

test('an unapproved saved live invitation cannot strand a later certified return attempt', async () => {
  const source = identityFromSecret(new Uint8Array(32).fill(120));
  const destination = identityFromSecret(new Uint8Array(32).fill(121));
  const store = new MemoryEscrowLifecycleStore();
  const old = createTransferInvite({
    identity: { ...source, dispose: () => source.secretKey.fill(0) },
    attemptId: 'E'.repeat(43),
    gameId: 'e'.repeat(22),
    genesisDigest: testKey(7),
    seat: 0,
    mode: 'live',
    serverUrl: 'wss://signal.example/',
    roomId: 'transferaf',
  });
  await saveCurrentTransferInvite(store, source.peerId, old);
  const prior = new OnlineTransferRecordStore(store, source.peerId, old, 'source');
  await prior.save({
    ...sourceRecord(old, destination.peerId),
    offer: null,
    approved: null,
    authorization: null,
  });
  vi.spyOn(OnlineTransferLink, 'openSource').mockReturnValue(asTestLink(sourceLink()));
  let browser: OnlineTransferBrowser | undefined;
  try {
    browser = await OnlineTransferBrowser.openSource({
      identity: { ...source, dispose: () => source.secretKey.fill(0) },
      store,
      worker: asTestWorker({
        async request() {
          throw new Error('No game work expected');
        },
      }),
      clock: new VirtualClock(),
      network: {},
      gameId: old.body.gameId,
      genesisDigest: old.body.genesisDigest,
      seat: 0,
      mode: 'return',
      serverUrl: old.body.serverUrl,
    });
    expect(browser.getSnapshot().invite.body.mode).toBe('return');
    expect(browser.getSnapshot().invite.body.attemptId).not.toBe(old.body.attemptId);
    expect((await prior.load()).finished).toBe(true);
  } finally {
    await browser?.close();
    source.secretKey.fill(0);
    destination.secretKey.fill(0);
  }
});

test('an approved saved invitation cannot be silently replaced by a return attempt', async () => {
  const source = identityFromSecret(new Uint8Array(32).fill(122));
  const destination = identityFromSecret(new Uint8Array(32).fill(123));
  const store = new MemoryEscrowLifecycleStore();
  const old = createTransferInvite({
    identity: { ...source, dispose: () => source.secretKey.fill(0) },
    attemptId: 'F'.repeat(43),
    gameId: 'f'.repeat(22),
    genesisDigest: testKey(8),
    seat: 0,
    mode: 'live',
    serverUrl: 'wss://signal.example/',
    roomId: 'transferag',
  });
  await saveCurrentTransferInvite(store, source.peerId, old);
  const prior = new OnlineTransferRecordStore(store, source.peerId, old, 'source');
  await prior.save(sourceRecord(old, destination.peerId));
  try {
    await expect(
      OnlineTransferBrowser.openSource({
        identity: { ...source, dispose: () => source.secretKey.fill(0) },
        store,
        worker: asTestWorker({}),
        clock: new VirtualClock(),
        network: {},
        gameId: old.body.gameId,
        genesisDigest: old.body.genesisDigest,
        seat: 0,
        mode: 'return',
        serverUrl: old.body.serverUrl,
      }),
    ).rejects.toThrow('Finish the approved transfer');
    expect((await prior.load()).finished).toBe(false);
  } finally {
    source.secretKey.fill(0);
    destination.secretKey.fill(0);
  }
});

test('reopened certified source cancellation commits locally when outcome delivery is unavailable', async () => {
  const source = identityFromSecret(new Uint8Array(32).fill(91));
  const destination = identityFromSecret(new Uint8Array(32).fill(92));
  const store = new MemoryEscrowLifecycleStore();
  const gameId = 'g'.repeat(22);
  const genesisDigest = testKey(6);
  const invite = createTransferInvite({
    identity: { ...source, dispose: () => source.secretKey.fill(0) },
    attemptId: 'A'.repeat(43),
    gameId,
    genesisDigest,
    seat: 0,
    serverUrl: 'wss://signal.example/',
    roomId: 'transferac',
  });
  await saveCurrentTransferInvite(store, source.peerId, invite);
  const records = new OnlineTransferRecordStore(store, source.peerId, invite, 'source');
  const persisted = sourceRecord(invite, destination.peerId);
  await records.save(persisted);
  const approved = persisted.approved;
  if (!approved) throw new Error('Expected test offer to be approved');

  const finalRef = ref(13);
  const submitted: OnlineWorkerRequestBody[] = [];
  let statusReads = 0;
  const worker = {
    async request<K extends OnlineWorkerRequestBody['kind']>(
      body: Extract<OnlineWorkerRequestBody, { kind: K }>,
    ) {
      if (body.kind === 'submitTransfer') submitted.push(body);
      let value: unknown;
      if (body.kind === 'transferStatus') {
        statusReads += 1;
        value =
          statusReads === 1
            ? {
                head: ref(12),
                pending: { entry: ref(11), statement: approved.statement },
                outcome: null,
                matchedAuthorization: {
                  entry: ref(11),
                  statement: approved.statement,
                },
                expiredBeforeCertification: false,
              }
            : {
                head: finalRef,
                pending: null,
                outcome: { authorization: ref(11), outcome: 'cancelled', entry: finalRef },
                matchedAuthorization: null,
                expiredBeforeCertification: false,
              };
      } else if (body.kind === 'exportTransferBootstrap') value = Uint8Array.of(1);
      else if (body.kind === 'submitTransfer') value = undefined;
      else throw new Error(`Unexpected worker request ${body.kind}`);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fake worker returns only the status/bootstrap/submission replies used by this regression.
      return { ok: true as const, value: value as OnlineWorkerReplyByKind[K] };
    },
    async shutdown() {},
  };
  const workerClient = asTestWorker(worker);

  const link = sourceLink();
  vi.spyOn(OnlineTransferLink, 'openSource').mockReturnValue(asTestLink(link));
  const options = {
    identity: { ...source, dispose: () => source.secretKey.fill(0) },
    store,
    worker: workerClient,
    clock: new VirtualClock(),
    network: {},
    gameId,
    genesisDigest,
    seat: 0 as const,
    serverUrl: 'wss://signal.example/',
  };
  let browser: OnlineTransferBrowser | undefined;
  let reopened: OnlineTransferBrowser | undefined;
  try {
    browser = await OnlineTransferBrowser.openSource(options);
    await expect(browser.cancel()).rejects.toThrow('Transfer connection is unavailable');
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      kind: 'submitTransfer',
      change: { kind: 'transfer-cancel', authorization: ref(11) },
    });
    expect(browser.getSnapshot().phase).toBe('cancelled-awaiting-receipt');
    expect((await records.load()).finished).toBe(true);

    reopened = await OnlineTransferBrowser.openSource(options);
    expect(reopened.getSnapshot().invite.body.attemptId).not.toBe(invite.body.attemptId);
    expect((await records.load()).finished).toBe(true);
  } finally {
    await browser?.close();
    await reopened?.close();
    source.secretKey.fill(0);
    destination.secretKey.fill(0);
  }
});

test('a persisted destination auto-selection failure remains visible after candidate observers swallow it', async () => {
  const source = identityFromSecret(new Uint8Array(32).fill(101));
  const destination = identityFromSecret(new Uint8Array(32).fill(102));
  const store = new MemoryEscrowLifecycleStore();
  const gameId = 'h'.repeat(22);
  const genesisDigest = testKey(7);
  const invite = createTransferInvite({
    identity: { ...source, dispose: () => source.secretKey.fill(0) },
    attemptId: 'B'.repeat(43),
    gameId,
    genesisDigest,
    seat: 0,
    serverUrl: 'wss://signal.example/',
    roomId: 'transferad',
  });
  await saveCurrentTransferInvite(store, source.peerId, invite);
  await new OnlineTransferRecordStore(store, source.peerId, invite, 'source').save(
    sourceRecord(invite, destination.peerId),
  );
  const link = sourceLink([destination.peerId], new Error('Could not update transfer roster'));
  vi.spyOn(OnlineTransferLink, 'openSource').mockReturnValue(asTestLink(link));
  const worker = asTestWorker({
    async request() {
      throw new Error('No transfer work expected');
    },
    async shutdown() {},
  });
  let browser: OnlineTransferBrowser | undefined;
  try {
    browser = await OnlineTransferBrowser.openSource({
      identity: { ...source, dispose: () => source.secretKey.fill(0) },
      store,
      worker,
      clock: new VirtualClock(),
      network: {},
      gameId,
      genesisDigest,
      seat: 0,
      serverUrl: 'wss://signal.example/',
    });
    expect(browser.getSnapshot()).toMatchObject({
      selectedDevice: destination.peerId,
      error: 'Could not update transfer roster',
    });
  } finally {
    await browser?.close();
    source.secretKey.fill(0);
    destination.secretKey.fill(0);
  }
});
