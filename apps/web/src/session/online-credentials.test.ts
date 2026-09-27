import { toBase64Url } from '@cp2p/codec';
import { decodeScalar, identityFromSecret } from '@cp2p/crypto';
import { describe, expect, test } from 'vitest';
import {
  loadCeremonyMaterial,
  loadOnlineIdentity,
  loadOrCreateOnlineIdentity,
  prepareCeremonyMaterial,
} from './online-credentials.js';
import type { OnlineCredentialStore, OnlineSeatLayout, RandomBytes } from './online-credentials.js';

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

function deterministicBytes(start: number): RandomBytes {
  let next = start;
  return (length) => {
    const bytes = new Uint8Array(length);
    bytes.fill(next++);
    return bytes;
  };
}

function peer(byte: number): string {
  return identityFromSecret(new Uint8Array(32).fill(byte)).peerId;
}

function layout(devicePeerId: string, otherPeerId: string): OnlineSeatLayout[] {
  return [
    { seat: 0, kind: 'human', devicePeerId },
    { seat: 1, kind: 'human', devicePeerId: otherPeerId },
    { seat: 2, kind: 'bot', botHost: devicePeerId },
  ];
}

describe('persistent online credentials', () => {
  test('resume loads only the original identity and exact game keys', async () => {
    const store = new MemoryCredentialStore();
    await expect(loadOnlineIdentity(store)).rejects.toThrow('missing');
    const identity = await loadOrCreateOnlineIdentity(store, deterministicBytes(15));
    const restoredIdentity = await loadOnlineIdentity(store);
    expect(restoredIdentity.peerId).toBe(identity.peerId);
    const nonce = new Uint8Array(32).fill(16);
    const seats = layout(identity.peerId, peer(17));
    await expect(
      loadCeremonyMaterial({
        store,
        identity: restoredIdentity,
        ceremonyNonce: nonce,
        layout: seats,
      }),
    ).rejects.toThrow('missing');
    const created = await prepareCeremonyMaterial({
      store,
      identity,
      ceremonyNonce: nonce,
      layout: seats,
      randomBytes: deterministicBytes(18),
    });
    const loaded = await loadCeremonyMaterial({
      store,
      identity: restoredIdentity,
      ceremonyNonce: nonce,
      layout: seats,
    });
    expect(loaded.keys).toEqual(created.keys);
    await expect(
      loadCeremonyMaterial({
        store,
        identity: restoredIdentity,
        ceremonyNonce: nonce,
        layout: seats.map((seat) => (seat.kind === 'bot' ? { ...seat, botHost: peer(17) } : seat)),
      }),
    ).rejects.toThrow('another layout');
    loaded.dispose();
    created.dispose();
    restoredIdentity.dispose();
    identity.dispose();
  });

  test('pins one device identity across concurrent store connections and restart', async () => {
    const shared: SharedRecords = { values: new Map(), locks: new Map() };
    const firstStore = new MemoryCredentialStore(shared);
    const secondStore = new MemoryCredentialStore(shared);
    let generated = 0;
    const firstEntropy: RandomBytes = (length) => {
      generated += 1;
      return new Uint8Array(length).fill(21);
    };
    const secondEntropy: RandomBytes = (length) => {
      generated += 1;
      return new Uint8Array(length).fill(22);
    };

    const [first, second] = await Promise.all([
      loadOrCreateOnlineIdentity(firstStore, firstEntropy),
      loadOrCreateOnlineIdentity(secondStore, secondEntropy),
    ]);
    expect(first.peerId).toBe(second.peerId);
    expect(first.secretKey).toEqual(second.secretKey);
    expect(generated).toBe(1);

    const restored = await loadOrCreateOnlineIdentity(new MemoryCredentialStore(shared), () => {
      throw new Error('A persisted identity must not be regenerated');
    });
    expect(restored.peerId).toBe(first.peerId);
    first.dispose();
    second.dispose();
    restored.dispose();
    expect(first.secretKey).toEqual(new Uint8Array(32));
  });

  test('persists independent seat signing keys and master scalars before returning them', async () => {
    const shared: SharedRecords = { values: new Map(), locks: new Map() };
    const store = new MemoryCredentialStore(shared);
    const identity = await loadOrCreateOnlineIdentity(store, deterministicBytes(31));
    const nonce = new Uint8Array(32).fill(7);
    let randomCalls = 0;
    const random: RandomBytes = (length) => {
      randomCalls += 1;
      return new Uint8Array(length).fill(40 + randomCalls);
    };
    const materials = await prepareCeremonyMaterial({
      store,
      identity,
      ceremonyNonce: nonce,
      layout: layout(identity.peerId, peer(51)),
      randomBytes: random,
    });

    expect(randomCalls).toBe(4);
    expect(materials.keys.map(({ seat, kind }) => [seat, kind])).toEqual([
      [0, 'human'],
      [2, 'bot'],
    ]);
    for (const item of materials.keys) {
      expect(item.signingKey).not.toEqual(item.master);
      const derived = identityFromSecret(item.signingKey);
      expect(derived.peerId).toBe(item.peerId);
      derived.secretKey.fill(0);
      derived.publicKey.fill(0);
      expect(decodeScalar(toBase64Url(item.master), { nonzero: true })).toBeGreaterThan(0n);
    }
    const storeKey = `online-credentials/ceremony/${toBase64Url(nonce)}/${identity.peerId}`;
    expect(await store.load(storeKey)).not.toBeNull();

    const retry = await prepareCeremonyMaterial({
      store: new MemoryCredentialStore(shared),
      identity,
      ceremonyNonce: nonce,
      layout: layout(identity.peerId, peer(51)),
      randomBytes: () => {
        throw new Error('A retry must restore the reserved material');
      },
    });
    expect(retry.keys.map(({ signingKey, master }) => [signingKey, master])).toEqual(
      materials.keys.map(({ signingKey, master }) => [signingKey, master]),
    );

    materials.dispose();
    retry.dispose();
    identity.dispose();
    expect(
      materials.keys.every(({ signingKey, master }) =>
        [...signingKey, ...master].every((byte) => byte === 0),
      ),
    ).toBe(true);
  });

  test('snapshot inputs before waiting and refuse a nonce reused for another layout', async () => {
    const store = new MemoryCredentialStore();
    const identity = await loadOrCreateOnlineIdentity(store, deterministicBytes(61));
    const nonce = new Uint8Array(32).fill(9);
    const seats = layout(identity.peerId, peer(62));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let announce!: () => void;
    const entered = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const held = store.withCeremonyLock(
      `online-credentials/ceremony/${toBase64Url(nonce)}/${identity.peerId}`,
      async () => {
        announce();
        await gate;
      },
    );
    await entered;

    const pending = prepareCeremonyMaterial({
      store,
      identity,
      ceremonyNonce: nonce,
      layout: seats,
      randomBytes: deterministicBytes(70),
    });
    nonce.fill(0);
    seats[2] = { seat: 2, kind: 'bot', botHost: peer(62) };
    release();
    await held;
    const materials = await pending;
    expect(materials.ceremonyNonce).toBe(toBase64Url(new Uint8Array(32).fill(9)));

    await expect(
      prepareCeremonyMaterial({
        store,
        identity,
        ceremonyNonce: new Uint8Array(32).fill(9),
        layout: layout(identity.peerId, peer(62)).map((seat) =>
          seat.seat === 2 ? { seat: 2, kind: 'human', devicePeerId: peer(62) } : seat,
        ),
        randomBytes: () => {
          throw new Error('Conflicting scope must fail before generating secrets');
        },
      }),
    ).rejects.toThrow('another layout');
    materials.dispose();
    identity.dispose();
  });

  test('rejects corrupt stored identity and ceremony material without regeneration', async () => {
    const shared: SharedRecords = { values: new Map(), locks: new Map() };
    const store = new MemoryCredentialStore(shared);
    const identity = await loadOrCreateOnlineIdentity(store, deterministicBytes(81));
    const nonce = new Uint8Array(32).fill(10);
    const seats = layout(identity.peerId, peer(82));
    const material = await prepareCeremonyMaterial({
      store,
      identity,
      ceremonyNonce: nonce,
      layout: seats,
      randomBytes: deterministicBytes(83),
    });
    material.dispose();

    shared.values.set(
      `online-credentials/ceremony/${toBase64Url(nonce)}/${identity.peerId}`,
      new Uint8Array([0, 1, 2]),
    );
    await expect(
      prepareCeremonyMaterial({
        store,
        identity,
        ceremonyNonce: nonce,
        layout: seats,
        randomBytes: () => {
          throw new Error('Corruption must not fall back to new keys');
        },
      }),
    ).rejects.toThrow('Stored online credentials are malformed');

    shared.values.set('online-credentials/device-identity/v1', new Uint8Array([0, 1, 2]));
    await expect(
      loadOrCreateOnlineIdentity(store, () => {
        throw new Error('Corruption must not replace the pinned identity');
      }),
    ).rejects.toThrow('Stored online credentials are malformed');
    identity.dispose();
  });
});
