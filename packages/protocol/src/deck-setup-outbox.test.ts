import { canonicalEncode, toBase64Url } from '@cp2p/codec';
import { identityFromSecret, scalarToBytes } from '@cp2p/crypto';
import type { Result } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { completeDeckDraw, decodeDeckCard, freezeDeckDraw } from './deck-draw.js';
import type { DeckDrawRequest } from './deck-draw.js';
import { prepareDeckUnlock } from './deck-outbox.js';
import type { DeckContributionStore } from './deck-outbox.js';
import { createDeckSecretSource } from './deck-source.js';
import { prepareDeckPass } from './deck-setup-outbox.js';
import { applyDeckPass, initDeckSetup, signDeckShuffle } from './deck-setup.js';
import type { DeckDefinition, DeckSetupState, SignedDeckPass } from './deck-setup.js';

const keys = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)] as const;
const masters = [scalarToBytes(17n), scalarToBytes(19n)] as const;
const definition: DeckDefinition = {
  ceremonyId: toBase64Url(new Uint8Array(32).fill(7)),
  deckId: 'development',
  deckEpoch: 0,
  creation: { kind: 'ceremony' },
  cards: [
    { identity: 'knight-1', card: 'knight' },
    { identity: 'knight-2', card: 'knight' },
    { identity: 'road-1', card: 'roadBuilding' },
  ],
  participants: keys.map((key, seat) => ({
    seat: seat === 0 ? 0 : 1,
    publicKey: identityFromSecret(key).peerId,
  })),
};

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

class MemoryStore implements DeckContributionStore {
  readonly records = new Map<string, Uint8Array>();
  failWrite = false;
  async load(id: string): Promise<Uint8Array | null> {
    return this.records.get(id)?.slice() ?? null;
  }
  async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    if (this.failWrite) throw new Error('storage unavailable');
    if (this.records.has(id)) return false;
    this.records.set(id, bytes.slice());
    return true;
  }
}

async function attempt(
  state: DeckSetupState,
  seat: 0 | 1,
  store: DeckContributionStore,
): Promise<Result<SignedDeckPass | null>> {
  const source = createDeckSecretSource(masters[seat], definition, seat);
  try {
    return await prepareDeckPass(state, seat, keys[seat], source, store);
  } finally {
    source.dispose();
  }
}

async function prepared(
  state: DeckSetupState,
  seat: 0 | 1,
  store: DeckContributionStore,
): Promise<SignedDeckPass> {
  const pass = value(await attempt(state, seat, store));
  if (!pass) throw new Error('Expected elected pass');
  return pass;
}

describe('durable deck setup outbox', () => {
  test('persists each real shuffle and lock before return and replays the complete setup', async () => {
    const store = new MemoryStore();
    let state = value(initDeckSetup(definition));
    for (const [seat, expectedPhase] of [
      [0, 'shuffle'],
      [1, 'shuffle'],
      [0, 'lock'],
      [1, 'lock'],
    ] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each signed pass needs the preceding certified setup state.
      const pass = await prepared(state, seat, store);
      expect(pass.body.phase).toBe(expectedPhase);
      expect(store.records.size).toBeGreaterThan(0);
      state = value(applyDeckPass(state, pass));
    }
    expect(state.shuffleKeys).toHaveLength(2);
    expect(state.lockKeys).toHaveLength(2);
    expect(store.records.size).toBe(4);
    expect(value(await attempt(state, 0, store))).toBeNull();
  });

  test('returns the exact stored pass after restart without touching a disposed provider', async () => {
    const store = new MemoryStore();
    const state = value(initDeckSetup(definition));
    const first = await prepared(state, 0, store);
    const disposed = createDeckSecretSource(masters[0], definition, 0);
    disposed.dispose();
    expect(value(await prepareDeckPass(state, 0, keys[0], disposed, store))).toEqual(first);
    expect(await prepared(state, 0, new MemoryStore())).toEqual(first);
    expect(value(applyDeckPass(state, first)).shuffleKeys).toHaveLength(1);
  });

  test('refuses a divergent valid prior history under the same immutable actor-phase key', async () => {
    const store = new MemoryStore();
    const initial = value(initDeckSetup(definition));
    const first = signDeckShuffle(initial, 13n, [0, 1, 2], new Uint8Array(32).fill(3), keys[0]);
    const alternate = signDeckShuffle(initial, 13n, [1, 0, 2], new Uint8Array(32).fill(3), keys[0]);
    const originalHistory = value(applyDeckPass(initial, first));
    const competingHistory = value(applyDeckPass(initial, alternate));
    await prepared(originalHistory, 1, store);
    const blocked = await attempt(competingHistory, 1, store);
    expect(blocked).toMatchObject({ ok: false, error: { code: 'deck-outbox-record' } });
    expect(store.records.size).toBe(1);
  });

  test('does not return a new pass when persistence fails or a conflicting writer wins', async () => {
    const state = value(initDeckSetup(definition));
    const store = new MemoryStore();
    store.failWrite = true;
    const denied = await attempt(state, 0, store);
    expect(denied).toMatchObject({ ok: false, error: { code: 'deck-outbox-write' } });
    expect(store.records.size).toBe(0);

    const conflicting = signDeckShuffle(state, 23n, [1, 0, 2], new Uint8Array(32).fill(9), keys[0]);
    const race: DeckContributionStore = {
      async load() {
        return canonicalEncode(conflicting);
      },
      async putIfAbsent() {
        return false;
      },
    };
    // The existing signed pass is valid for this same state, so a losing writer
    // returns it instead of its newly generated alternate pass.
    expect(value(await attempt(state, 0, race))).toEqual(conflicting);

    const prior = signDeckShuffle(state, 29n, [1, 2, 0], new Uint8Array(32).fill(5), keys[0]);
    const differentParent = value(applyDeckPass(state, prior));
    const competingPrior = signDeckShuffle(
      state,
      29n,
      [2, 0, 1],
      new Uint8Array(32).fill(5),
      keys[0],
    );
    const competingParent = value(applyDeckPass(state, competingPrior));
    const wrongWinner = signDeckShuffle(
      competingParent,
      31n,
      [2, 0, 1],
      new Uint8Array(32).fill(6),
      keys[1],
    );
    let reads = 0;
    const conflictingRace: DeckContributionStore = {
      async load() {
        reads += 1;
        return reads === 1 ? null : canonicalEncode(wrongWinner);
      },
      async putIfAbsent() {
        return false;
      },
    };
    const rejected = await attempt(differentParent, 1, conflictingRace);
    expect(rejected).toMatchObject({ ok: false, error: { code: 'deck-outbox-record' } });
  });

  test('the real factory setup, durable unlock and owner decode preserve the physical card permutation', async () => {
    const setupStore = new MemoryStore();
    let setup = value(initDeckSetup(definition));
    for (const seat of [0, 1, 0, 1] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each pass consumes the previous verified state.
      setup = value(applyDeckPass(setup, await prepared(setup, seat, setupStore)));
    }

    const firstSource = createDeckSecretSource(masters[0], definition, 0);
    const secondSource = createDeckSecretSource(masters[1], definition, 1);
    const firstPermutation = firstSource.permutation();
    const secondPermutation = secondSource.permutation();
    firstSource.dispose();
    secondSource.dispose();
    const originalIndex = definition.cards.findIndex(
      (_, index) => secondPermutation[firstPermutation[index] ?? -1] === 0,
    );
    const expectedCard = definition.cards[originalIndex];
    if (!expectedCard) throw new Error('Expected exactly one physical card at position zero');

    const request: DeckDrawRequest = {
      genesisDigest: toBase64Url(new Uint8Array(32).fill(11)),
      epoch: 0,
      anchor: { seq: 9, hash: 'a'.repeat(64) },
      position: 0,
      seat: 0,
      slotId: 'slot-1',
    };
    const operation = value(freezeDeckDraw(setup, request));
    const drawStore = new MemoryStore();
    const owner = createDeckSecretSource(masters[0], definition, 0);
    const other = createDeckSecretSource(masters[1], definition, 1);
    try {
      expect(
        value(await prepareDeckUnlock(setup, request, [], 0, keys[0], owner, drawStore)),
      ).toBeNull();
      const unlock = value(
        await prepareDeckUnlock(setup, request, [], 1, keys[1], other, drawStore),
      );
      if (!unlock) throw new Error('Expected non-owner unlock');
      const receipt = value(completeDeckDraw(operation, [unlock]));
      const recreated = createDeckSecretSource(masters[0], definition, 0);
      try {
        expect(value(decodeDeckCard(setup, receipt, recreated.lock(0)))).toEqual(expectedCard);
      } finally {
        recreated.dispose();
      }
      expect(drawStore.records.size).toBe(3);
    } finally {
      owner.dispose();
      other.dispose();
    }
  });
});
