import { canonicalDecode, canonicalEncode, toBase64Url } from '@cp2p/codec';
import { encodePoint, G, identityFromSecret, signObject } from '@cp2p/crypto';
import type { Result } from '@cp2p/engine';
import { TRANSFER_DEVICE_DOMAIN, TRANSFER_GAME_KEY_DOMAIN } from '@cp2p/protocol';
import type { SeatTransferAuthorization, TransferPrivateEnvelope } from '@cp2p/protocol';
import { expect, test } from 'vitest';
import type { OnlineTransferArtifact } from './online-transfer-channel.js';
import { DestinationTransferExchange, SourceTransferExchange } from './online-transfer-exchange.js';
import type {
  OnlineTransferExchangeRecord,
  TransferExchangeWorker,
} from './online-transfer-exchange.js';
import type { OnlineWorkerReplyByKind, OnlineWorkerRequestBody } from './online-worker-messages.js';

const key = (byte: number) => toBase64Url(new Uint8Array(32).fill(byte));
const sig = toBase64Url(new Uint8Array(64).fill(9));
const head = (seq: number) => ({ seq, hash: seq.toString(16).padStart(64, '0') });
const sourceDevice = key(1);
const deviceIdentity = identityFromSecret(new Uint8Array(32).fill(2));
const gameIdentity = identityFromSecret(new Uint8Array(32).fill(3));
const destinationDevice = deviceIdentity.peerId;
const destinationGame = gameIdentity.peerId;
const digest = key(4);
const authorization = head(11);
const unsignedOffer: SeatTransferAuthorization = {
  kind: 'transfer-authorize',
  statement: {
    protocol: 'seat-transfer-v1',
    genesisDigest: digest,
    anchor: head(10),
    validUntilSeq: 74,
    mode: 'live',
    seat: 0,
    currentController: {
      publicKey: key(5),
      kind: 'human',
      activatedAt: head(0),
      hostSeat: 0,
    },
    recovery: null,
    nextEpoch: 1,
    destination: {
      devicePeer: destinationDevice,
      gamePeer: destinationGame,
      transferEncryptionKey: encodePoint(G),
    },
    replacements: [
      { seat: 0, oldPublicKey: key(5), newPublicKey: destinationGame, newHostSeat: 0 },
    ],
  },
  destinationDeviceSig: sig,
  destinationGameSig: sig,
  replacementKeySigs: [],
};
const offer: SeatTransferAuthorization = {
  ...unsignedOffer,
  destinationDeviceSig: signObject(
    TRANSFER_DEVICE_DOMAIN,
    unsignedOffer.statement,
    deviceIdentity.secretKey,
  ),
  destinationGameSig: signObject(
    TRANSFER_GAME_KEY_DOMAIN,
    unsignedOffer.statement,
    gameIdentity.secretKey,
  ),
};
const approved: SeatTransferAuthorization = {
  ...offer,
  ownerIntent: { signer: 'current-game', sig },
};
const readiness = {
  kind: 'transfer-activate' as const,
  statement: {
    protocol: 'seat-transfer-activation-v1' as const,
    genesisDigest: digest,
    authorization,
    parent: authorization,
    nextEpoch: 1,
    destinationDevice,
    destinationGame,
    replacements: offer.statement.replacements,
    checkDigest: 'a'.repeat(64),
  },
  destinationCheck: sig,
  replacementChecks: [],
};
const packet: TransferPrivateEnvelope = {
  protocol: 'seat-transfer-private-v1',
  genesisDigest: digest,
  authorization,
  sourceParent: authorization,
  sourceSeat: 0,
  sourceSigner: { kind: 'current-controller', publicKey: key(5) },
  destinationDevice,
  destinationGame,
  affectedSeats: [0],
  nonce: key(7),
  sealed: { ephemeral: key(8), ciphertext: 'a' },
  ciphertextHash: 'b'.repeat(64),
  sourceSig: sig,
};

function record(role: 'source' | 'destination'): OnlineTransferExchangeRecord {
  return {
    protocol: 'online-transfer-exchange-v1',
    role,
    attemptId: key(10),
    gameId: 'a'.repeat(22),
    genesisDigest: digest,
    sourceDevice,
    destinationDevice,
    seat: 0,
    offer: null,
    approved: null,
    authorization: null,
    cancelRequested: false,
  };
}

function sourceRecord(): OnlineTransferExchangeRecord & { role: 'source' } {
  return { ...record('source'), role: 'source' };
}

function destinationRecord(): OnlineTransferExchangeRecord & { role: 'destination' } {
  return { ...record('destination'), role: 'destination' };
}

function required<T>(item: T | undefined): T {
  if (item === undefined) throw new Error('Expected exchange test value');
  return item;
}

function artifact(kind: OnlineTransferArtifact['kind'], value: unknown): OnlineTransferArtifact {
  return { kind, bytes: canonicalEncode(value) };
}

function worker(respond: (body: OnlineWorkerRequestBody) => unknown): TransferExchangeWorker {
  return {
    async request<K extends OnlineWorkerRequestBody['kind']>(
      body: Extract<OnlineWorkerRequestBody, { kind: K }>,
    ): Promise<Result<OnlineWorkerReplyByKind[K]>> {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Test fake maps each request to its matching reply below.
      return { ok: true, value: respond(body) as OnlineWorkerReplyByKind[K] };
    },
  };
}

test('source waits for explicit consent, durably records approval, and retries exact certified outcome after retirement', async () => {
  const calls: string[] = [];
  const sent: OnlineTransferArtifact[] = [];
  const saved: OnlineTransferExchangeRecord[] = [];
  let pending = false;
  let activated = false;
  const source = new SourceTransferExchange({
    record: sourceRecord(),
    channel: {
      async send(item) {
        sent.push({ kind: item.kind, bytes: new Uint8Array(item.bytes) });
      },
    },
    worker: worker((body) => {
      calls.push(body.kind);
      // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- This fake rejects requests outside the source exchange API.
      switch (body.kind) {
        case 'transferStatus':
          return {
            head: pending ? (activated ? head(12) : authorization) : head(10),
            pending:
              pending && !activated ? { entry: authorization, statement: offer.statement } : null,
            outcome:
              activated && body.authorization
                ? { authorization, outcome: 'activated', entry: head(12) }
                : null,
          };
        case 'authorizeLiveTransfer':
          return approved;
        case 'submitTransfer':
          if (body.change && typeof body.change === 'object' && 'kind' in body.change) {
            if (body.change.kind === 'transfer-authorize') pending = true;
            if (body.change.kind === 'transfer-activate') activated = true;
          }
          return undefined;
        case 'exportTransferBootstrap':
          return Uint8Array.of(body.throughSeq ?? 99);
        case 'prepareTransferPrivate':
          return packet;
        default:
          throw new Error(`Unexpected source request ${body.kind}`);
      }
    }),
    async savePublicRecord(next) {
      saved.push(structuredClone(next));
    },
  });
  await source.start();
  await source.receive(artifact('offer', offer));
  expect(source.snapshot().phase).toBe('awaiting-confirmation');
  expect(calls).toEqual(['exportTransferBootstrap']);
  expect(saved.at(-1)?.offer).toEqual(offer);
  await source.confirm();
  expect(saved.at(-1)?.authorization).toEqual(authorization);
  expect(sent.map((item) => item.kind)).toEqual(['bootstrap', 'authorized', 'private']);
  expect(calls.indexOf('submitTransfer')).toBeGreaterThan(calls.indexOf('authorizeLiveTransfer'));
  await source.receive(artifact('readiness', readiness));
  expect(source.snapshot().phase).toBe('awaiting-receipt');
  expect(sent.slice(-2).map((item) => item.kind)).toEqual(['authorized', 'activated']);
  expect([...required(sent.at(-2)).bytes]).toEqual([11]);
  expect([...required(sent.at(-1)).bytes]).toEqual([12]);
  await expect(
    source.receive(
      artifact('received', {
        protocol: 'online-transfer-received-v1',
        destinationDevice,
        authorization,
        outcome: 'activated',
        entry: head(13),
      }),
    ),
  ).rejects.toThrow(/matching certified outcome/);
  expect(source.snapshot().phase).toBe('awaiting-receipt');
  await source.receive(
    artifact('received', {
      protocol: 'online-transfer-received-v1',
      destinationDevice,
      authorization,
      outcome: 'activated',
      entry: head(12),
    }),
  );
  expect(source.snapshot().phase).toBe('activated');
  const sentAfterReceipt = sent.length;
  await source.receive(artifact('readiness', readiness));
  expect(source.snapshot().phase).toBe('activated');
  expect(sent).toHaveLength(sentAfterReceipt);
  const restarted = new SourceTransferExchange({
    record: { ...required(saved.at(-1)), role: 'source' },
    channel: {
      async send(item) {
        sent.push(item);
      },
    },
    worker: worker((body) => {
      if (body.kind === 'transferStatus')
        return {
          head: head(12),
          pending: null,
          outcome: { authorization, outcome: 'activated', entry: head(12) },
        };
      if (body.kind === 'exportTransferBootstrap') return Uint8Array.of(body.throughSeq ?? 99);
      throw new Error('Retired source must not sign or submit again');
    }),
    async savePublicRecord() {
      throw new Error('No new decision expected');
    },
  });
  await restarted.retry();
  expect(sent.slice(-2).map((item) => item.kind)).toEqual(['authorized', 'activated']);
});

test('source rejects offer replacement and a failed durable approval before any submit or private disclosure', async () => {
  const calls: string[] = [];
  const sent: OnlineTransferArtifact[] = [];
  const source = new SourceTransferExchange({
    record: sourceRecord(),
    channel: {
      async send(item) {
        sent.push(item);
      },
    },
    worker: worker((body) => {
      calls.push(body.kind);
      if (body.kind === 'transferStatus') return { head: head(10), pending: null, outcome: null };
      if (body.kind === 'authorizeLiveTransfer') return approved;
      throw new Error('Approval was not persisted');
    }),
    async savePublicRecord(next) {
      if (next.approved) throw new Error('Storage failed');
    },
  });
  await source.receive(artifact('offer', offer));
  await expect(
    source.receive(
      artifact('offer', {
        ...offer,
        statement: {
          ...offer.statement,
          destination: { ...offer.statement.destination, gamePeer: key(20) },
        },
      }),
    ),
  ).rejects.toThrow(/changed/);
  await expect(source.confirm()).rejects.toThrow(/Storage failed/);
  expect(calls).toEqual(['transferStatus', 'authorizeLiveTransfer']);
  expect(sent).toEqual([]);
});

test('invalid possession cannot pin an offer or prevent a later valid offer', async () => {
  const saved: OnlineTransferExchangeRecord[] = [];
  const source = new SourceTransferExchange({
    record: sourceRecord(),
    worker: worker(() => {
      throw new Error('Offer inspection must not sign or submit');
    }),
    channel: { async send() {} },
    async savePublicRecord(next) {
      saved.push(next);
    },
  });
  for (const field of ['destinationDeviceSig', 'destinationGameSig'] as const) {
    // oxlint-disable-next-line no-await-in-loop -- Each rejection must leave the same attempt unpinned before the next offer arrives.
    await expect(source.receive(artifact('offer', { ...offer, [field]: sig }))).rejects.toThrow(
      /possession signatures/,
    );
    expect(source.snapshot().record.offer).toBeNull();
    expect(saved).toEqual([]);
  }
  await source.receive(artifact('offer', offer));
  expect(source.snapshot().phase).toBe('awaiting-confirmation');
  expect(saved).toHaveLength(1);
  expect(saved[0]?.offer).toEqual(offer);
});

test('source never reports local cancellation after an approved request with an uncertain certificate', async () => {
  let pending = false;
  let cancelled = false;
  const sent: OnlineTransferArtifact[] = [];
  const source = new SourceTransferExchange({
    record: { ...sourceRecord(), offer, approved },
    channel: {
      async send(item) {
        sent.push(item);
      },
    },
    worker: worker((body) => {
      if (body.kind === 'transferStatus')
        return {
          head: cancelled ? head(12) : pending ? authorization : head(10),
          pending:
            pending && !cancelled ? { entry: authorization, statement: offer.statement } : null,
          outcome: cancelled ? { authorization, outcome: 'cancelled', entry: head(12) } : null,
          matchedAuthorization: pending
            ? { entry: authorization, statement: offer.statement }
            : null,
          expiredBeforeCertification: false,
        };
      if (body.kind === 'submitTransfer') {
        if (
          !body.change ||
          typeof body.change !== 'object' ||
          !('kind' in body.change) ||
          body.change.kind !== 'transfer-cancel'
        )
          throw new Error('Expected certified cancel');
        cancelled = true;
        return undefined;
      }
      if (body.kind === 'exportTransferBootstrap') return Uint8Array.of(body.throughSeq ?? 99);
      throw new Error('Cancellation must not sign or disclose private material');
    }),
    async savePublicRecord() {
      return undefined;
    },
  });
  await expect(source.cancel()).rejects.toThrow(/uncertain/);
  expect(source.snapshot().phase).toBe('connecting');
  expect(source.snapshot().record.cancelRequested).toBe(true);
  expect(sent).toEqual([]);
  pending = true;
  await source.cancel();
  expect(source.snapshot().record.authorization).toEqual(authorization);
  expect(source.snapshot().phase).toBe('cancelled-awaiting-receipt');
  expect(sent.map((item) => item.kind)).toEqual(['authorized', 'cancelled']);
});

test('failed cancellation remains durable and late readiness retries cancellation without disclosing', async () => {
  let cancelAttempts = 0;
  let cancelled = false;
  const calls: string[] = [];
  const saved: OnlineTransferExchangeRecord[] = [];
  const source = new SourceTransferExchange({
    record: { ...sourceRecord(), offer, approved, authorization },
    channel: {
      async send() {
        return undefined;
      },
    },
    worker: worker((body) => {
      calls.push(body.kind);
      if (body.kind === 'transferStatus')
        return {
          head: cancelled ? head(12) : authorization,
          pending: cancelled ? null : { entry: authorization, statement: offer.statement },
          outcome: cancelled ? { authorization, outcome: 'cancelled', entry: head(12) } : null,
          matchedAuthorization: { entry: authorization, statement: offer.statement },
          expiredBeforeCertification: false,
        };
      if (body.kind === 'submitTransfer') {
        if (
          !body.change ||
          typeof body.change !== 'object' ||
          !('kind' in body.change) ||
          body.change.kind !== 'transfer-cancel'
        )
          throw new Error('Readiness activated a cancelled transfer');
        cancelAttempts += 1;
        if (cancelAttempts === 1) throw new Error('temporary certification timeout');
        cancelled = true;
        return undefined;
      }
      if (body.kind === 'exportTransferBootstrap') return Uint8Array.of(1);
      throw new Error('Cancelled transfer cannot prepare private material');
    }),
    async savePublicRecord(next) {
      saved.push(next);
    },
  });
  await expect(source.cancel()).rejects.toThrow(/timeout/);
  expect(saved.at(-1)?.cancelRequested).toBe(true);
  await source.receive(artifact('readiness', readiness));
  expect(cancelAttempts).toBe(2);
  expect(calls).not.toContain('prepareTransferPrivate');
  expect(source.snapshot().phase).toBe('cancelled-awaiting-receipt');
});

test('expired approval with no exact certified authorization can be closed without signing', async () => {
  const calls: string[] = [];
  const source = new SourceTransferExchange({
    record: { ...sourceRecord(), offer, approved },
    channel: {
      async send() {
        throw new Error('No destination is connected');
      },
    },
    worker: worker((body) => {
      calls.push(body.kind);
      if (body.kind === 'transferStatus')
        return {
          head: head(75),
          pending: null,
          outcome: null,
          matchedAuthorization: null,
          expiredBeforeCertification: true,
        };
      throw new Error('Expired unapproved transfer cannot sign or submit');
    }),
    async savePublicRecord() {
      return undefined;
    },
  });
  await source.cancel();
  expect(source.snapshot().record.cancelRequested).toBe(true);
  expect(source.snapshot().phase).toBe('cancelled');
  expect(calls).toEqual(['transferStatus']);
});

test('exact statement history recovers a certified outcome when its ref was not saved locally', async () => {
  const saved: OnlineTransferExchangeRecord[] = [];
  const sent: OnlineTransferArtifact[] = [];
  const source = new SourceTransferExchange({
    record: { ...sourceRecord(), offer, approved },
    channel: {
      async send(item) {
        sent.push(item);
      },
    },
    worker: worker((body) => {
      if (body.kind === 'transferStatus')
        return {
          head: head(12),
          pending: null,
          matchedAuthorization: { entry: authorization, statement: offer.statement },
          expiredBeforeCertification: false,
          outcome: { authorization, outcome: 'cancelled', entry: head(12) },
        };
      if (body.kind === 'exportTransferBootstrap') return Uint8Array.of(1);
      throw new Error('Completed historical outcome cannot sign or disclose');
    }),
    async savePublicRecord(next) {
      saved.push(next);
    },
  });
  await source.retry();
  expect(saved.at(-1)?.authorization).toEqual(authorization);
  expect(source.snapshot().phase).toBe('cancelled-awaiting-receipt');
  expect(sent.map((item) => item.kind)).toEqual(['authorized', 'cancelled']);
});

test('stale readiness gets a fresh certified parent instead of being submitted', async () => {
  const sent: OnlineTransferArtifact[] = [];
  const source = new SourceTransferExchange({
    record: { ...sourceRecord(), offer, approved, authorization },
    channel: {
      async send(item) {
        sent.push(item);
      },
    },
    worker: worker((body) => {
      if (body.kind === 'transferStatus')
        return {
          head: head(12),
          pending: { entry: authorization, statement: offer.statement },
          outcome: null,
        };
      if (body.kind === 'exportTransferBootstrap') return Uint8Array.of(12);
      throw new Error('Stale readiness must not be certified');
    }),
    async savePublicRecord() {
      throw new Error('No new decision expected');
    },
  });
  await source.receive(artifact('readiness', readiness));
  expect(sent.map((item) => item.kind)).toEqual(['authorized']);
  expect(source.snapshot().phase).toBe('awaiting-readiness');
});

test('duplicate destination offer resumes an already approved source without another confirmation', async () => {
  const sent: OnlineTransferArtifact[] = [];
  const source = new SourceTransferExchange({
    record: { ...sourceRecord(), offer, approved, authorization },
    channel: {
      async send(item) {
        sent.push(item);
      },
    },
    worker: worker((body) => {
      if (body.kind === 'transferStatus')
        return {
          head: authorization,
          pending: { entry: authorization, statement: offer.statement },
          outcome: null,
          matchedAuthorization: { entry: authorization, statement: offer.statement },
          expiredBeforeCertification: false,
        };
      if (body.kind === 'exportTransferBootstrap') return Uint8Array.of(1);
      if (body.kind === 'prepareTransferPrivate') return packet;
      throw new Error('Reconnected offer must not authorize again');
    }),
    async savePublicRecord() {
      return undefined;
    },
  });
  await source.receive(artifact('offer', offer));
  expect(sent.map((item) => item.kind)).toEqual(['authorized', 'private']);
  expect(source.snapshot().phase).toBe('awaiting-readiness');
});

test('destination delegates import and promotion to worker and shuts it down before opening the game', async () => {
  const steps: string[] = [];
  const sent: OnlineTransferArtifact[] = [];
  let stage: 'offered' | 'imported' = 'offered';
  const destination = new DestinationTransferExchange({
    record: destinationRecord(),
    expected: { gameId: 'a'.repeat(22), genesisDigest: digest },
    channel: {
      async send(item) {
        sent.push({ kind: item.kind, bytes: new Uint8Array(item.bytes) });
      },
    },
    worker: worker((body) => {
      steps.push(body.kind);
      // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- This fake rejects requests outside the destination exchange API.
      switch (body.kind) {
        case 'initializeTransfer':
          return {
            phase: 'prepared',
            gameId: 'a'.repeat(22),
            head: head(10),
            authorization: null,
            outcome: null,
          };
        case 'prepareTransferOffer':
          return offer;
        case 'refreshTransferBootstrap':
          return {
            phase: stage,
            gameId: 'a'.repeat(22),
            head: authorization,
            authorization: stage === 'imported' ? authorization : null,
            outcome: null,
          };
        case 'transferSnapshot':
          return {
            phase: stage,
            gameId: 'a'.repeat(22),
            head: authorization,
            authorization: stage === 'imported' ? authorization : null,
            outcome: null,
          };
        case 'importTransferPacket':
          stage = 'imported';
          return {
            phase: stage,
            gameId: 'a'.repeat(22),
            head: authorization,
            authorization,
            outcome: null,
          };
        case 'prepareTransferReadiness':
          return readiness;
        case 'observeTransferActivation':
          return {
            gameId: 'a'.repeat(22),
            snapshot: {
              phase: 'promoted',
              gameId: 'a'.repeat(22),
              head: head(12),
              authorization,
              outcome: { authorization, outcome: 'activated', entry: head(12) },
            },
          };
        default:
          throw new Error(`Unexpected destination request ${body.kind}`);
      }
    }),
    async savePublicRecord() {
      steps.push('save');
    },
    async shutdownWorker() {
      steps.push('shutdown');
    },
    async onPromoted(gameId) {
      expect(gameId).toBe('a'.repeat(22));
      steps.push('promoted');
    },
  });
  await destination.receive({ kind: 'bootstrap', bytes: Uint8Array.of(1) });
  await destination.receive({ kind: 'authorized', bytes: Uint8Array.of(2) });
  await destination.receive(artifact('private', packet));
  expect(sent.map((item) => item.kind)).toEqual(['offer', 'readiness']);
  expect(canonicalDecode(required(sent.at(-1)).bytes)).toEqual(readiness);
  await destination.receive(artifact('private', packet));
  expect(steps.filter((step) => step === 'importTransferPacket')).toHaveLength(2);
  await destination.receive({ kind: 'authorized', bytes: Uint8Array.of(4) });
  expect(steps.filter((step) => step === 'importTransferPacket')).toHaveLength(2);
  expect(sent.filter((item) => item.kind === 'readiness')).toHaveLength(2);
  expect(sent.at(-1)?.kind).toBe('readiness');
  await destination.receive({ kind: 'activated', bytes: Uint8Array.of(3) });
  expect(steps.slice(-3)).toEqual(['observeTransferActivation', 'shutdown', 'promoted']);
  expect(sent.at(-1)?.kind).toBe('received');
  expect(destination.snapshot().phase).toBe('activated');
  const requestsAfterPromotion = steps.length;
  await destination.receive({ kind: 'authorized', bytes: Uint8Array.of(4) });
  expect(steps).toHaveLength(requestsAfterPromotion);
  expect(sent.at(-1)?.kind).toBe('received');
});

test('destination sends a cancellation receipt only after verified certified evidence', async () => {
  const steps: string[] = [];
  const sent: OnlineTransferArtifact[] = [];
  let exactOutcome = false;
  const destination = new DestinationTransferExchange({
    record: destinationRecord(),
    expected: { gameId: 'a'.repeat(22), genesisDigest: digest },
    channel: {
      async send(item) {
        sent.push(item);
      },
    },
    worker: worker((body) => {
      steps.push(body.kind);
      if (body.kind === 'initializeTransfer')
        return {
          phase: 'prepared',
          gameId: 'a'.repeat(22),
          head: head(10),
          authorization: null,
          outcome: null,
        };
      if (body.kind === 'prepareTransferOffer') return offer;
      if (body.kind === 'observeTransferCancellation')
        return {
          phase: 'cancelled',
          gameId: 'a'.repeat(22),
          head: head(12),
          authorization,
          outcome: exactOutcome
            ? { authorization, entry: head(12), outcome: 'cancelled' }
            : { authorization, entry: head(13), outcome: 'cancelled' },
        };
      throw new Error('Unexpected destination request');
    }),
    async savePublicRecord() {
      steps.push('save');
    },
    async shutdownWorker() {
      steps.push('shutdown');
    },
    onPromoted() {
      throw new Error('A cancelled transfer cannot promote');
    },
  });
  await destination.receive({ kind: 'bootstrap', bytes: Uint8Array.of(1) });
  await expect(destination.receive({ kind: 'cancelled', bytes: Uint8Array.of(2) })).rejects.toThrow(
    /did not verify this exact certified outcome/,
  );
  expect(sent.map((item) => item.kind)).toEqual(['offer']);
  expect(steps).not.toContain('shutdown');
  exactOutcome = true;
  await destination.receive({ kind: 'cancelled', bytes: Uint8Array.of(2) });
  expect(sent.at(-1)?.kind).toBe('received');
  expect(canonicalDecode(required(sent.at(-1)).bytes)).toMatchObject({
    authorization,
    entry: head(12),
    outcome: 'cancelled',
  });
  expect(destination.snapshot().phase).toBe('cancelled');
});

test('destination completes promotion after a lost final receipt and reconnect without using its stopped worker', async () => {
  const calls: string[] = [];
  const sent: OnlineTransferArtifact[] = [];
  let failReceipt = true;
  const destination = new DestinationTransferExchange({
    record: destinationRecord(),
    expected: { gameId: 'a'.repeat(22), genesisDigest: digest },
    channel: {
      async send(item) {
        sent.push(item);
        if (item.kind === 'received' && failReceipt) {
          failReceipt = false;
          throw new Error('connection replaced before receipt ack');
        }
      },
    },
    worker: worker((body) => {
      calls.push(body.kind);
      if (body.kind === 'initializeTransfer')
        return {
          phase: 'prepared',
          gameId: 'a'.repeat(22),
          head: head(10),
          authorization: null,
          outcome: null,
        };
      if (body.kind === 'prepareTransferOffer') return offer;
      if (body.kind === 'observeTransferActivation')
        return {
          gameId: 'a'.repeat(22),
          snapshot: {
            phase: 'promoted',
            gameId: 'a'.repeat(22),
            head: head(12),
            authorization,
            outcome: { authorization, entry: head(12), outcome: 'activated' },
          },
        };
      throw new Error('Stopped destination worker was called after finalization');
    }),
    async savePublicRecord() {
      calls.push('save');
    },
    async shutdownWorker() {
      calls.push('shutdown');
    },
    async onPromoted() {
      calls.push('promoted');
    },
  });
  await destination.receive({ kind: 'bootstrap', bytes: Uint8Array.of(1) });
  await expect(destination.receive({ kind: 'activated', bytes: Uint8Array.of(2) })).rejects.toThrow(
    /connection replaced/,
  );
  expect(calls).toContain('shutdown');
  expect(calls).toContain('promoted');
  expect(destination.snapshot().phase).toBe('activated');
  await destination.receive({ kind: 'bootstrap', bytes: Uint8Array.of(1) });
  expect(destination.snapshot().phase).toBe('activated');
  expect(calls.filter((call) => call === 'promoted')).toHaveLength(1);
  expect(sent.filter((item) => item.kind === 'received')).toHaveLength(2);
  await destination.retry();
  expect(calls.filter((call) => call === 'promoted')).toHaveLength(1);
  expect(calls.filter((call) => call === 'transferSnapshot')).toHaveLength(0);
});

test('destination retries a signed offer after its first public save fails', async () => {
  let saves = 0;
  const sent: OnlineTransferArtifact[] = [];
  const destination = new DestinationTransferExchange({
    record: destinationRecord(),
    expected: { gameId: 'a'.repeat(22), genesisDigest: digest },
    channel: {
      async send(item) {
        sent.push(item);
      },
    },
    worker: worker((body) => {
      if (body.kind === 'initializeTransfer')
        return {
          phase: 'offered',
          gameId: 'a'.repeat(22),
          head: head(10),
          authorization: null,
          outcome: null,
        };
      if (body.kind === 'transferSnapshot' || body.kind === 'refreshTransferBootstrap')
        return {
          phase: 'offered',
          gameId: 'a'.repeat(22),
          head: head(10),
          authorization: null,
          outcome: null,
        };
      if (body.kind === 'prepareTransferOffer') return offer;
      throw new Error('Offer recovery must not import or promote');
    }),
    async savePublicRecord() {
      saves += 1;
      if (saves === 1) throw new Error('temporary public store failure');
    },
    async shutdownWorker() {
      return undefined;
    },
    onPromoted() {
      throw new Error('No promotion occurred');
    },
  });
  await expect(destination.receive({ kind: 'bootstrap', bytes: Uint8Array.of(1) })).rejects.toThrow(
    /store failure/,
  );
  expect(sent).toEqual([]);
  await destination.retry();
  expect(saves).toBe(2);
  expect(sent.map((item) => item.kind)).toEqual(['offer']);
  await destination.receive({ kind: 'bootstrap', bytes: Uint8Array.of(1) });
  expect(sent.map((item) => item.kind)).toEqual(['offer', 'offer']);
});

test('queue admits two large certified prefixes and one small packet, then rejects more', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const destination = new DestinationTransferExchange({
    record: destinationRecord(),
    expected: { gameId: 'a'.repeat(22), genesisDigest: digest },
    channel: {
      async send() {
        return undefined;
      },
    },
    worker: {
      async request() {
        await blocked;
        throw new Error('Stopped after queue admission check');
      },
    },
    async savePublicRecord() {
      return undefined;
    },
    async shutdownWorker() {
      return undefined;
    },
    onPromoted() {
      return undefined;
    },
  });
  const large = new Uint8Array(9 * 1024 * 1024);
  const first = destination.receive({ kind: 'bootstrap', bytes: large });
  const second = destination.receive({ kind: 'activated', bytes: large });
  const third = destination.receive({ kind: 'private', bytes: Uint8Array.of(1) });
  await expect(destination.receive({ kind: 'offer', bytes: Uint8Array.of(1) })).rejects.toThrow(
    /queue is full/,
  );
  destination.close();
  release();
  const settled = await Promise.allSettled([first, second, third]);
  expect(settled.map((item) => item.status)).toEqual(['rejected', 'rejected', 'rejected']);
});
