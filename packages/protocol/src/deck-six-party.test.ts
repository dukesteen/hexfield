import { toBase64Url } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import { FIVE_SIX_DEV_CARDS, devCardCatalogue } from '@cp2p/engine';
import { expect, test } from 'vitest';
import {
  completeDeckDraw,
  freezeDeckDraw,
  signDeckUnlock,
  verifyDeckUnlockPrefix,
} from './deck-draw.js';
import type { SignedDeckUnlock } from './deck-draw.js';
import { applyDeckPass, initDeckSetup, signDeckLock, signDeckShuffle } from './deck-setup.js';

const SEATS = 6;
const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);

function timed<T>(timings: number[], work: () => T): T {
  const started = performance.now();
  const result = work();
  timings.push(performance.now() - started);
  return result;
}

function summary(values: readonly number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    totalMs: Math.round(total),
    meanMs: Math.round(total / values.length),
    maxMs: Math.round(sorted.at(-1) ?? 0),
  };
}

/**
 * Stage 11 P2P measurement: six participants run the real verified ceremony on the 34-card
 * five-six deck, then one card's unlock chain passes through the five other seats. Every
 * receiving peer verifies the growing prefix, as the replica does before storing a hop.
 */
test('six-party deck ceremony and five-hop unlock chain', () => {
  const keys = Array.from({ length: SEATS }, (_, seat) => bytes(90 + seat));
  const identities = keys.map(identityFromSecret);
  const cards = devCardCatalogue(FIVE_SIX_DEV_CARDS);
  expect(cards).toHaveLength(34);
  const initial = initDeckSetup({
    ceremonyId: toBase64Url(bytes(12)),
    deckId: 'dev',
    deckEpoch: 0,
    creation: { kind: 'ceremony' },
    cards: cards.map(({ identity, card }) => ({ identity, card })),
    participants: identities.map((identity, seat) => ({ seat, publicKey: identity.peerId })),
  });
  if (!initial.ok) throw new Error(initial.error.message);
  let setup = initial.value;
  const shuffleSecrets = Array.from({ length: SEATS }, (_, seat) => BigInt(1_009 + seat * 7));
  const lockRows = Array.from({ length: SEATS }, (_, seat) =>
    Array.from({ length: cards.length }, (_, position) =>
      BigInt(2_003 + seat * 97 + position * 13),
    ),
  );
  const shuffleMs: number[] = [];
  const lockMs: number[] = [];
  for (let seat = 0; seat < SEATS; seat++) {
    const key = keys[seat];
    const secret = shuffleSecrets[seat];
    if (!key || secret === undefined) throw new Error('missing signer');
    const permutation = Array.from(
      { length: cards.length },
      (_, index) => (index * (2 * seat + 3) + seat) % cards.length,
    );
    expect(new Set(permutation).size).toBe(cards.length);
    setup = timed(shuffleMs, () => {
      const next = applyDeckPass(
        setup,
        signDeckShuffle(setup, secret, permutation, bytes(31 + seat), key),
      );
      if (!next.ok) throw new Error(next.error.message);
      return next.value;
    });
  }
  for (let seat = 0; seat < SEATS; seat++) {
    const key = keys[seat];
    const secret = shuffleSecrets[seat];
    const locks = lockRows[seat];
    if (!key || secret === undefined || !locks) throw new Error('missing lock signer');
    setup = timed(lockMs, () => {
      const next = applyDeckPass(setup, signDeckLock(setup, secret, locks, bytes(41 + seat), key));
      if (!next.ok) throw new Error(next.error.message);
      return next.value;
    });
  }

  const drawer = 3;
  const frozen = freezeDeckDraw(setup, {
    genesisDigest: toBase64Url(bytes(12)),
    epoch: 1,
    anchor: { seq: 40, hash: 'a'.repeat(64) },
    position: 5,
    seat: drawer,
    slotId: 'dev:0',
  });
  if (!frozen.ok) throw new Error(frozen.error.message);
  const unlocks: SignedDeckUnlock[] = [];
  const signMs: number[] = [];
  const verifyMs: number[] = [];
  const chainStarted = performance.now();
  for (const { seat } of frozen.value.participants.filter((item) => item.seat !== drawer)) {
    const lock = lockRows[seat]?.[5];
    const key = keys[seat];
    if (lock === undefined || !key) throw new Error('missing unlock signer');
    unlocks.push(
      timed(signMs, () => signDeckUnlock(frozen.value, unlocks, lock, bytes(70 + seat), key)),
    );
    // Every other peer verifies the extended prefix before it is stored or forwarded.
    for (let peer = 0; peer < SEATS - 1; peer++)
      timed(verifyMs, () => expect(verifyDeckUnlockPrefix(frozen.value, unlocks).ok).toBe(true));
  }
  const completed = completeDeckDraw(frozen.value, unlocks);
  const chainMs = performance.now() - chainStarted;
  expect(completed.ok).toBe(true);
  expect(unlocks).toHaveLength(SEATS - 1);
  const report = {
    participants: SEATS,
    deckCards: cards.length,
    ceremony: { shuffle: summary(shuffleMs), lock: summary(lockMs) },
    unlockChain: {
      hops: unlocks.length,
      sign: summary(signMs),
      verifyPerPeer: summary(verifyMs),
      computeMsExcludingNetwork: Math.round(chainMs),
    },
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
}, 600_000);
