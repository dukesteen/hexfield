import { hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { G, encodePoint, scalarToBytes, scalePoint } from '@cp2p/crypto';
import { success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import { beforeAll, describe, expect, test } from 'vitest';
import { createBeaconSecretSource } from './beacon-source.js';
import { deckCeremonyId, validateDeckGenesisCommitments } from './deck-genesis.js';
import type { DeckLedger } from './deck-ledger.js';
import { replayDeckSetup } from './deck-setup.js';
import {
  genesisBody,
  genesisDigest,
  genesisId,
  signGenesis,
  signVerifiedGenesis,
  validateGenesis,
} from './genesis.js';
import { verifyRevealedMaster } from './genesis-secrets.js';
import { validateGenesisMasters } from './genesis-masters.js';
import type { GenesisBody } from './types.js';
import { createGenesisDeckFixture } from './testing/deck-fixture.js';
import { createSimulationGenesis } from './testing/simulation-genesis.js';

function checked<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing master fixture value');
  return value;
}

function master(seat: Seat): Uint8Array {
  return scalarToBytes(BigInt(17 + seat));
}

function fixture() {
  const simulated = createSimulationGenesis({
    seed: 71,
    humanCount: 1,
    config: {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1],
      options: {},
    },
  });
  const deck = createGenesisDeckFixture(
    { ...genesisBody(simulated.genesis), security: 'verified', commitments: {} },
    simulated.identities,
  );
  const body: GenesisBody = {
    ...deck.body,
    commitments: {
      ...deck.body.commitments,
      masters: deck.body.seats.map(({ seat }) => ({
        seat,
        masterPub: encodePoint(scalePoint(G, BigInt(17 + seat))),
      })),
      beaconChains: deck.body.seats
        .filter((seat) => seat.kind === 'human')
        .map(({ seat }) => {
          const source = createBeaconSecretSource(
            master(seat),
            { ceremonyId: deckCeremonyId(deck.body), seat },
            8,
          );
          try {
            return { seat, length: 8, tip: toBase64Url(source.initialCommitment.tip) };
          } finally {
            source.dispose();
          }
        }),
    },
  };
  const commitments = checked(validateDeckGenesisCommitments(body));
  const ledger: DeckLedger = {
    genesisDigest: genesisDigest(body),
    active: null,
    decks: commitments.map((commitment, index) => ({
      commitment,
      setup: checked(
        replayDeckSetup(commitment.definition, required(deck.transcripts[index]).passes),
      ),
      nextPass: commitment.passHashes.length,
      nextPosition: 0,
      slots: [],
    })),
  };
  return { body, ledger, simulated, transcripts: deck.transcripts };
}

describe('recovered master consistency', () => {
  let base: ReturnType<typeof fixture>;
  beforeAll(() => {
    base = fixture();
  }, 20_000);

  test('checks a human and hosted bot against their original derived keys', () => {
    for (const seat of [0, 1] as const)
      expect(verifyRevealedMaster(base.body, base.ledger, seat, toBase64Url(master(seat)))).toEqual(
        {
          ok: true,
          value: undefined,
        },
      );
  });

  test('requires one distinct nonidentity commitment per original seat in order', () => {
    const good = checked(validateGenesisMasters(base.body));
    for (const masters of [
      undefined,
      good.slice(0, 1),
      good.toReversed(),
      [good[0], good[0]],
      [good[0], { seat: 1, masterPub: good[0]?.masterPub }],
      [good[0], { seat: 1, masterPub: encodePoint(scalePoint(G, 0n)) }],
      [good[0], { seat: 1, masterPub: toBase64Url(new Uint8Array(32).fill(255)) }],
    ]) {
      const body = { ...base.body, commitments: { ...base.body.commitments, masters } };
      expect(validateGenesisMasters(body).ok).toBe(false);
    }
  });

  test('rejects another master, a zero scalar, an out-of-field scalar and an unknown seat', () => {
    for (const value of [
      toBase64Url(master(1)),
      toBase64Url(new Uint8Array(32)),
      toBase64Url(new Uint8Array(32).fill(255)),
      `${'A'.repeat(42)}B`,
      'bad',
    ])
      expect(verifyRevealedMaster(base.body, base.ledger, 0, value).ok).toBe(false);
    expect(verifyRevealedMaster(base.body, base.ledger, 5, toBase64Url(master(0))).ok).toBe(false);
  });

  test('requires master commitments at both human consent and genesis admission', () => {
    const key = required(base.simulated.identities.get(0)).secretKey;
    const policy = { verifyCommitments: () => success(undefined) };
    const signed = (body: GenesisBody) => ({
      ...body,
      gameId: genesisId(body),
      signatures: [signGenesis(body, 0, key)],
    });
    expect(signVerifiedGenesis(base.body, base.transcripts, 0, key).ok).toBe(true);
    expect(validateGenesis(signed(base.body), base.simulated.engine, policy).ok).toBe(true);
    const body = structuredClone(base.body);
    delete body.commitments.masters;
    expect(signVerifiedGenesis(body, base.transcripts, 0, key)).toMatchObject({
      ok: false,
      error: { code: 'genesis-masters' },
    });
    expect(validateGenesis(signed(body), base.simulated.engine, policy)).toMatchObject({
      ok: false,
      error: { code: 'genesis-masters' },
    });
  });

  test('rejects a mismatched encryption key and initial beacon tip independently', () => {
    const body = structuredClone(base.body);
    required(body.seats[0]).encryptionKey = encodePoint(scalePoint(G, 71n));
    expect(verifyRevealedMaster(body, base.ledger, 0, toBase64Url(master(0)))).toMatchObject({
      ok: false,
      error: { code: 'master-encryption-key' },
    });
    const wrongTip: GenesisBody = {
      ...base.body,
      commitments: {
        ...base.body.commitments,
        beaconChains: [{ seat: 0, length: 8, tip: toBase64Url(new Uint8Array(32).fill(71)) }],
      },
    };
    expect(verifyRevealedMaster(wrongTip, base.ledger, 0, toBase64Url(master(0)))).toMatchObject({
      ok: false,
      error: { code: 'master-beacon-tip' },
    });
  });

  test.each(['shuffle', 'lock'] as const)(
    'detects a %s key unrelated to the committed master even when bound to genesis',
    (kind) => {
      const ledger = structuredClone(base.ledger);
      const deck = required(ledger.decks[0]);
      if (kind === 'shuffle') deck.setup.shuffleKeys[0] = encodePoint(scalePoint(G, 99n));
      else required(deck.setup.lockKeys[0])[0] = encodePoint(scalePoint(G, 99n));
      // This unit fixture binds the changed public key to a new genesis. It tests
      // key consistency, not the separate certificate/ceremony verification path.
      deck.commitment.finalStateHash = toHex(
        hashValue({ domain: 'cp2p/v1/locked-deck', deck: deck.setup }),
      );
      const body = {
        ...base.body,
        commitments: {
          ...base.body.commitments,
          decks: ledger.decks.map((item) => item.commitment),
        },
      };
      ledger.genesisDigest = genesisDigest(body);
      expect(verifyRevealedMaster(body, ledger, 0, toBase64Url(master(0)))).toMatchObject({
        ok: false,
        error: { code: `master-${kind}-key` },
      });
    },
  );

  test('rejects substituted or missing deck context before treating it as complete', () => {
    for (const ledger of [
      { ...base.ledger, genesisDigest: toBase64Url(new Uint8Array(32)) },
      { ...base.ledger, decks: [] },
    ])
      expect(verifyRevealedMaster(base.body, ledger, 0, toBase64Url(master(0)))).toMatchObject({
        ok: false,
        error: { code: 'master-deck-context' },
      });
  });
});
