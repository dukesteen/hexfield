import { canonicalDecode, toBase64Url } from '@cp2p/codec';
import { identityFromSecret, parsePeerId, verifyObject } from '@cp2p/crypto';
import { describe, expect, test } from 'vitest';
import {
  TRANSFER_BOT_KEY_DOMAIN,
  TRANSFER_DEVICE_DOMAIN,
  TRANSFER_GAME_KEY_DOMAIN,
} from '@cp2p/protocol';
import {
  prepareOnlineTransferCredentials,
  type OnlineTransferCredentialScope,
} from './online-transfer-credentials.js';
import type {
  DisposableOnlineIdentity,
  OnlineCredentialStore,
  RandomBytes,
} from './online-credentials.js';

interface SharedRecords {
  values: Map<string, Uint8Array>;
  locks: Map<string, Promise<void>>;
}

class MemoryCredentialStore implements OnlineCredentialStore {
  constructor(private readonly shared: SharedRecords = { values: new Map(), locks: new Map() }) {}

  async load(id: string): Promise<Uint8Array | null> {
    return this.shared.values.get(id)?.slice() ?? null;
  }

  async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    if (this.shared.values.has(id)) return false;
    this.shared.values.set(id, bytes.slice());
    return true;
  }

  async withCeremonyLock<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.shared.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.shared.locks.set(id, current);
    await previous;
    try {
      return await task();
    } finally {
      if (this.shared.locks.get(id) === current) this.shared.locks.delete(id);
      release();
    }
  }
}

function identity(seed: number): DisposableOnlineIdentity {
  const generated = identityFromSecret(new Uint8Array(32).fill(seed));
  return {
    peerId: generated.peerId,
    secretKey: generated.secretKey,
    dispose: () => generated.secretKey.fill(0),
  };
}

function scope(devicePeer: string): OnlineTransferCredentialScope {
  const previous = identity(91);
  const botController = identity(92);
  const result: OnlineTransferCredentialScope = {
    attemptId: toBase64Url(new Uint8Array(32).fill(13)),
    genesisDigest: toBase64Url(new Uint8Array(32).fill(171)),
    anchor: { seq: 4, hash: 'cd'.repeat(32) },
    validUntilSeq: 20,
    mode: 'live',
    seat: 0,
    currentController: {
      publicKey: previous.peerId,
      kind: 'human',
      activatedAt: { seq: 0, hash: 'ef'.repeat(32) },
      hostSeat: 0,
    },
    recovery: null,
    nextEpoch: 2,
    devicePeer,
    replacements: [
      { seat: 0, oldPublicKey: previous.peerId, newHostSeat: 0 },
      { seat: 2, oldPublicKey: botController.peerId, newHostSeat: 0 },
    ],
  };
  previous.dispose();
  botController.dispose();
  return result;
}

function entropy(start: number): RandomBytes {
  let count = 0;
  return (length) => new Uint8Array(length).fill(start + count++);
}

describe('online transfer credentials', () => {
  test('preserves a caller-owned Buffer device key', async () => {
    const device = identity(29);
    const secretKey = Buffer.from(device.secretKey);
    const credentials = await prepareOnlineTransferCredentials({
      store: new MemoryCredentialStore(),
      identity: { ...device, secretKey },
      scope: scope(device.peerId),
      randomBytes: entropy(50),
    });
    try {
      expect(secretKey).toEqual(Buffer.from(device.secretKey));
      expect(credentials.authorization.statement.destination.devicePeer).toBe(device.peerId);
    } finally {
      credentials.dispose();
      secretKey.fill(0);
      device.dispose();
    }
  });

  test('persists fresh independent keys before returning signed public authorization', async () => {
    const store = new MemoryCredentialStore();
    const device = identity(21);
    const credentials = await prepareOnlineTransferCredentials({
      store,
      identity: device,
      scope: scope(device.peerId),
      randomBytes: entropy(40),
    });
    const statement = credentials.authorization.statement;
    const [primary, replacement] = credentials.keys;
    const botSignature = credentials.authorization.replacementKeySigs[0];
    if (!primary || !replacement || !botSignature)
      throw new Error('Expected transfer keys/signatures');
    expect(statement.destination.devicePeer).toBe(device.peerId);
    expect(credentials.keys.map(({ seat }) => seat)).toEqual([0, 2]);
    expect(credentials.keys.map(({ peerId }) => peerId)).toEqual(
      statement.replacements.map(({ newPublicKey }) => newPublicKey),
    );
    expect(credentials.keys[0]?.signingKey).not.toEqual(credentials.encryptionSecret);
    expect(
      verifyObject(
        TRANSFER_DEVICE_DOMAIN,
        statement,
        credentials.authorization.destinationDeviceSig,
        parsePeerId(device.peerId),
      ),
    ).toBe(true);
    expect(
      verifyObject(
        TRANSFER_GAME_KEY_DOMAIN,
        statement,
        credentials.authorization.destinationGameSig,
        parsePeerId(primary.peerId),
      ),
    ).toBe(true);
    expect(
      verifyObject(
        TRANSFER_BOT_KEY_DOMAIN,
        statement,
        botSignature.sig,
        parsePeerId(replacement.peerId),
      ),
    ).toBe(true);

    const slot = `online-transfer-credentials/v1/${statement.genesisDigest}/${device.peerId}/0/${scope(device.peerId).attemptId}`;
    const stored = await store.load(slot);
    expect(stored).not.toBeNull();
    if (!stored) throw new Error('Expected persisted transfer credentials');
    const decoded = canonicalDecode(stored);
    expect(decoded).toHaveProperty('keys.length', 2);
    stored?.fill(0);
    credentials.dispose();
    device.dispose();
  });

  test('reuses exact reserved keys after restart and rejects a conflicting scope', async () => {
    const shared: SharedRecords = { values: new Map(), locks: new Map() };
    const device = identity(22);
    const firstScope = scope(device.peerId);
    const first = await prepareOnlineTransferCredentials({
      store: new MemoryCredentialStore(shared),
      identity: device,
      scope: firstScope,
      randomBytes: entropy(50),
    });
    const retry = await prepareOnlineTransferCredentials({
      store: new MemoryCredentialStore(shared),
      identity: device,
      scope: scope(device.peerId),
      randomBytes: () => {
        throw new Error('A retry must restore reserved keys');
      },
    });
    expect(retry.authorization).toEqual(first.authorization);
    expect(retry.keys.map(({ signingKey }) => signingKey)).toEqual(
      first.keys.map(({ signingKey }) => signingKey),
    );
    const conflicting = scope(device.peerId);
    const conflictingScope = { ...conflicting, anchor: { seq: 5, hash: '12'.repeat(32) } };
    await expect(
      prepareOnlineTransferCredentials({
        store: new MemoryCredentialStore(shared),
        identity: device,
        scope: conflictingScope,
        randomBytes: entropy(60),
      }),
    ).rejects.toThrow('another authorization scope');
    const laterAttempt = await prepareOnlineTransferCredentials({
      store: new MemoryCredentialStore(shared),
      identity: device,
      scope: { ...scope(device.peerId), attemptId: toBase64Url(new Uint8Array(32).fill(14)) },
      randomBytes: entropy(61),
    });
    expect(laterAttempt.authorization.statement.destination.gamePeer).not.toBe(
      first.authorization.statement.destination.gamePeer,
    );
    first.dispose();
    retry.dispose();
    laterAttempt.dispose();
    device.dispose();
  });

  test('snapshots mutable inputs before waiting for the slot lock', async () => {
    const store = new MemoryCredentialStore();
    const device = identity(23);
    const inputScope = scope(device.peerId);
    const id = `online-transfer-credentials/v1/${inputScope.genesisDigest}/${device.peerId}/0/${inputScope.attemptId}`;
    let release!: () => void;
    let announce!: () => void;
    const entered = new Promise<void>((resolve) => (announce = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const held = store.withCeremonyLock(id, async () => {
      announce();
      await gate;
    });
    await entered;
    const pending = prepareOnlineTransferCredentials({
      store,
      identity: device,
      scope: inputScope,
      randomBytes: entropy(70),
    });
    (inputScope as { anchor: { seq: number; hash: string } }).anchor = {
      seq: 19,
      hash: '34'.repeat(32),
    };
    device.secretKey.fill(99);
    release();
    await held;
    const result = await pending;
    expect(result.authorization.statement.anchor).toEqual({ seq: 4, hash: 'cd'.repeat(32) });
    result.dispose();
    device.dispose();
  });

  test('concurrent retry returns the same reservation and disposed copies are zeroed', async () => {
    const shared: SharedRecords = { values: new Map(), locks: new Map() };
    const device = identity(24);
    const [left, right] = await Promise.all([
      prepareOnlineTransferCredentials({
        store: new MemoryCredentialStore(shared),
        identity: device,
        scope: scope(device.peerId),
        randomBytes: entropy(80),
      }),
      prepareOnlineTransferCredentials({
        store: new MemoryCredentialStore(shared),
        identity: device,
        scope: scope(device.peerId),
        randomBytes: entropy(90),
      }),
    ]);
    expect(left.authorization).toEqual(right.authorization);
    const primary = left.keys[0];
    if (!primary) throw new Error('Expected primary transfer key');
    const retained = primary.signingKey;
    left.dispose();
    expect(retained).toEqual(new Uint8Array(32));
    right.dispose();
    device.dispose();
  });

  test('keeps the primary destination first when its hosted bot has a lower seat number', async () => {
    const device = identity(26);
    const original = scope(device.peerId);
    const [primary, bot] = original.replacements;
    if (!primary || !bot) throw new Error('Expected fixture replacements');
    const transferScope: OnlineTransferCredentialScope = {
      ...original,
      attemptId: toBase64Url(new Uint8Array(32).fill(15)),
      seat: 1,
      replacements: [
        { seat: 1, oldPublicKey: bot.oldPublicKey, newHostSeat: 1 },
        { seat: 0, oldPublicKey: primary.oldPublicKey, newHostSeat: 1 },
      ],
    };
    const result = await prepareOnlineTransferCredentials({
      store: new MemoryCredentialStore(),
      identity: device,
      scope: transferScope,
      randomBytes: entropy(110),
    });
    expect(result.authorization.statement.replacements.map(({ seat }) => seat)).toEqual([1, 0]);
    result.dispose();
    device.dispose();
  });

  test('refuses malformed persisted records without generating replacement keys', async () => {
    const shared: SharedRecords = { values: new Map(), locks: new Map() };
    const device = identity(25);
    const transferScope = scope(device.peerId);
    const first = await prepareOnlineTransferCredentials({
      store: new MemoryCredentialStore(shared),
      identity: device,
      scope: transferScope,
      randomBytes: entropy(100),
    });
    const slot = `online-transfer-credentials/v1/${transferScope.genesisDigest}/${device.peerId}/0/${transferScope.attemptId}`;
    shared.values.set(slot, Uint8Array.of(1, 2, 3));
    await expect(
      prepareOnlineTransferCredentials({
        store: new MemoryCredentialStore(shared),
        identity: device,
        scope: transferScope,
        randomBytes: () => {
          throw new Error('Malformed stored material must fail before generation');
        },
      }),
    ).rejects.toThrow('malformed');
    first.dispose();
    device.dispose();
  });
});
