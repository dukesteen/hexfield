import { canonicalEncode, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import {
  DERIVATION_LABELS,
  G,
  deriveScalar,
  encodePoint,
  encodeScalar,
  identityFromSecret,
  pedersenCommit,
  proveHiddenTransfer,
  scalePoint,
  sealWithEphemeralProof,
  signObject,
} from '@cp2p/crypto';
import { RESOURCES, createResourceBounds, knightsConfig, knightsEngine } from '@cp2p/engine';
import type { EngineEffect, GameState, Input, Result } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { toKindMap } from './card-kinds.js';
import type { KindMap } from './card-kinds.js';
import {
  applyPublicResourceEffect,
  emptyHandCommitments,
  validateHandCommitments,
  verifyHandOpening,
} from './hand-commitments.js';
import {
  planHandTransition,
  proveHandObligation,
  verifyHandProof,
  verifyHandProofs,
} from './hand-transition.js';
import type { HandProofBinding } from './hand-transition.js';
import { verifyResourceAccounting } from './resource-accounting.js';
import {
  STEAL_EVIDENCE_PROTOCOL,
  STEAL_OPENING_BYTES,
  createStealContribution,
  createStealDispute,
  createStealReceipt,
  openStealContribution,
  stealOpeningBytes,
  stealOperationId,
  validateStealOperation,
  verifyStealContribution,
  verifyStealDispute,
} from './steal-delivery.js';
import type { FixedSteal, StealOperation } from './steal-delivery.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

const COMMODITIES = ['cloth', 'coin', 'paper'];
const KINDS = [...RESOURCES, ...COMMODITIES];

function kindMap<T>(record: Record<string, T>): KindMap<T> {
  const map = toKindMap(record);
  if (!map) throw new Error('Test map misses a base resource');
  return map;
}

function counts(patch: Record<string, number> = {}): Record<string, number> {
  return { ...Object.fromEntries(KINDS.map((kind) => [kind, 0])), ...patch };
}

function scalars(seed: bigint): Record<string, bigint> {
  return Object.fromEntries(KINDS.map((kind, index) => [kind, seed + BigInt(index)]));
}

function encoded(map: Record<string, bigint>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(map).map(([kind, scalar]) => [kind, encodeScalar(scalar)]),
  );
}

describe('hand commitments over the game card kinds', () => {
  test('base games keep exactly five kinds in today order and refuse a commodity key', () => {
    const base = value(emptyHandCommitments([0, 1]));
    expect(Object.keys(base[0]?.commitments ?? {})).toEqual([
      'brick',
      'lumber',
      'wool',
      'grain',
      'ore',
    ]);
    const wide = value(emptyHandCommitments([0, 1], KINDS));
    expect(Object.keys(wide[0]?.commitments ?? {})).toEqual(KINDS);
    expect(validateHandCommitments(wide, [0, 1]).ok).toBe(false);
    expect(validateHandCommitments(base, [0, 1], KINDS).ok).toBe(false);
    expect(validateHandCommitments(wide, [0, 1], KINDS).ok).toBe(true);
    const extra = wide.map((row) => ({ ...row, commitments: { ...row.commitments, gold: '' } }));
    expect(validateHandCommitments(extra, [0, 1], KINDS).ok).toBe(false);
  });

  test('a public commodity movement moves only that commodity commitment', () => {
    const wide = value(emptyHandCommitments([0, 1], KINDS));
    const moved = value(
      applyPublicResourceEffect(
        wide,
        [0, 1],
        { seat: 1, resource: 'coin', direction: 'credit', count: 3 },
        KINDS,
      ),
    );
    expect(moved[1]?.commitments.coin).toBe(pedersenCommit(3n, 0n));
    expect(moved[1]?.commitments.cloth).toBe(pedersenCommit(0n, 0n));
    expect(moved[0]).toEqual(wide[0]);
    expect(
      applyPublicResourceEffect(
        wide,
        [0, 1],
        { seat: 1, resource: 'gold', direction: 'credit', count: 1 },
        KINDS,
      ).ok,
    ).toBe(false);
    // The base default has no coin.
    expect(
      applyPublicResourceEffect(value(emptyHandCommitments([0, 1])), [0, 1], {
        seat: 1,
        resource: 'coin',
        direction: 'credit',
        count: 1,
      }).ok,
    ).toBe(false);
  });

  test('an opening covers every kind and binds each commodity blinding', () => {
    const hand = counts({ brick: 1, cloth: 2, paper: 1 });
    const blind = scalars(5n);
    const commitments = Object.fromEntries(
      KINDS.map((kind) => [kind, pedersenCommit(BigInt(hand[kind] ?? 0), blind[kind] ?? 0n)]),
    );
    const ledger = [{ seat: 0 as const, commitments }];
    expect(verifyHandOpening(ledger, [0], 0, hand, encoded(blind), KINDS).ok).toBe(true);
    expect(verifyHandOpening(ledger, [0], 0, { ...hand, cloth: 1 }, encoded(blind), KINDS).ok).toBe(
      false,
    );
    expect(
      verifyHandOpening(ledger, [0], 0, hand, { ...encoded(blind), paper: encodeScalar(1n) }, KINDS)
        .ok,
    ).toBe(false);
    const short = Object.fromEntries(RESOURCES.map((kind) => [kind, hand[kind] ?? 0]));
    expect(verifyHandOpening(ledger, [0], 0, short, encoded(blind), KINDS).ok).toBe(false);
  });
});

/** A two-seat knights state in the main phase where seat 0's hand is a hidden five cards. */
function knightsMaritime() {
  const engine = knightsEngine();
  const initial = engine.createGame(knightsConfig({ seats: 2 }), new Uint8Array(32).fill(51));
  const uncertain = value(
    createResourceBounds(
      5,
      counts(),
      counts({ cloth: 5, coin: 5, paper: 5, ore: 5, brick: 5 }),
      KINDS,
    ),
  );
  const before: GameState = {
    ...initial,
    turn: {
      ...initial.turn,
      number: 3,
      activeSeat: 0,
      phase: [{ module: 'base', id: 'main', data: null }],
    },
    seats: initial.seats.map((seat) =>
      seat.seat === 0 ? { ...seat, resources: uncertain } : seat,
    ),
  };
  const blind = scalars(9n);
  const hand = counts({ cloth: 4, paper: 1 });
  const hands = value(emptyHandCommitments([0, 1], KINDS)).map((row) => ({
    ...row,
    commitments:
      row.seat === 0
        ? kindMap(
            Object.fromEntries(
              KINDS.map((kind) => [
                kind,
                pedersenCommit(BigInt(hand[kind] ?? 0), blind[kind] ?? 0n),
              ]),
            ),
          )
        : row.commitments,
  }));
  const input: Input = {
    kind: 'command',
    seat: 0,
    command: { type: 'MARITIME_TRADE', give: { cloth: 4 }, get: { ore: 1 } },
  };
  const applied = value(engine.apply(before, input));
  const binding: HandProofBinding = {
    genesisDigest: toBase64Url(new Uint8Array(32).fill(1)),
    epoch: 0,
    anchor: { seq: 9, hash: 'a'.repeat(64) },
    command: {
      gameId: 'a'.repeat(22),
      genesisDigest: toBase64Url(new Uint8Array(32).fill(1)),
      seat: 0,
      nonce: 2,
      headSeq: 9,
      headHash: 'a'.repeat(64),
      command: input.command,
    },
  };
  return { engine, before, hands, input, applied, hand, blind, binding };
}

describe('commodity debits over committed hands', () => {
  const seed = new Uint8Array(32).fill(8);

  test('a 4:1 commodity trade needs a range proof over the cloth commitment only', () => {
    const { before, hands, input, applied, hand, blind, binding } = knightsMaritime();
    expect(verifyResourceAccounting(before, applied.state, applied.effects).ok).toBe(true);
    const plan = value(planHandTransition(hands, before, input, applied));
    expect(plan.kinds).toEqual(KINDS);
    expect(plan.obligations).toMatchObject([
      { kind: 'range', seat: 0, resource: 'cloth', count: 4 },
    ]);
    const proof = value(proveHandObligation(plan, 0, hand, encoded(blind), seed, binding));
    expect(proof).toMatchObject({ kind: 'range', resource: 'cloth', count: 4 });
    expect(verifyHandProof(plan, 0, proof, binding).ok).toBe(true);
    expect(verifyHandProofs(plan, [proof], binding).ok).toBe(true);
    // The ledger moves exactly the traded kinds: cloth is debited, ore credited, blindings kept.
    expect(plan.hands[0]?.commitments.cloth).toBe(pedersenCommit(0n, blind.cloth ?? 0n));
    expect(plan.hands[0]?.commitments.ore).toBe(pedersenCommit(1n, blind.ore ?? 0n));
    expect(plan.hands[0]?.commitments.paper).toBe(hands[0]?.commitments.paper);
  });

  test('a forged commodity debit is rejected at proving and at verification', () => {
    const { before, hands, input, applied, hand, blind, binding } = knightsMaritime();
    const plan = value(planHandTransition(hands, before, input, applied));
    const proof = value(proveHandObligation(plan, 0, hand, encoded(blind), seed, binding));
    // A seat that holds only three cloth cannot prove a four-cloth debit.
    const poor = counts({ cloth: 3, paper: 1 });
    expect(proveHandObligation(plan, 0, poor, encoded(blind), seed, binding)).toMatchObject({
      ok: false,
    });
    // Lying about the opening of a commodity fails against the public commitment.
    const lie = proveHandObligation(
      plan,
      0,
      counts({ cloth: 9, paper: 1 }),
      encoded(blind),
      seed,
      binding,
    );
    expect(lie).toMatchObject({ ok: false, error: { code: 'hand-opening-mismatch' } });
    expect(
      proveHandObligation(
        plan,
        0,
        hand,
        { ...encoded(blind), cloth: encodeScalar(1n) },
        seed,
        binding,
      ).ok,
    ).toBe(false);
    // A proof cannot be re-labelled as another kind, a smaller debit or another seat.
    expect(verifyHandProofs(plan, [{ ...proof, resource: 'coin' }], binding).ok).toBe(false);
    expect(verifyHandProofs(plan, [{ ...proof, count: 2 }], binding).ok).toBe(false);
    expect(verifyHandProofs(plan, [{ ...proof, seat: 1 }], binding).ok).toBe(false);
    // An unknown kind never reaches a proof.
    expect(verifyHandProofs(plan, [{ ...proof, resource: 'gold' }], binding).ok).toBe(false);
  });

  test('accounting rejects forged commodity effects and unknown kinds', () => {
    const { before, applied } = knightsMaritime();
    const swapped: EngineEffect[] = applied.effects.map((effect) =>
      effect.type === 'resource-transfer' && effect.resource === 'cloth'
        ? { ...effect, resource: 'coin' }
        : effect,
    );
    expect(verifyResourceAccounting(before, applied.state, swapped).ok).toBe(false);
    const unknown: EngineEffect[] = applied.effects.map((effect) =>
      effect.type === 'resource-transfer' ? { ...effect, resource: 'gold' } : effect,
    );
    expect(verifyResourceAccounting(before, applied.state, unknown).ok).toBe(false);
    const inflated: EngineEffect[] = applied.effects.map((effect) =>
      effect.type === 'resource-transfer' && effect.resource === 'cloth'
        ? { ...effect, count: effect.count + 1 }
        : effect,
    );
    expect(verifyResourceAccounting(before, applied.state, inflated).ok).toBe(false);
  });
});

const RECIPIENT_SECRET = 21n;
const STEAL_SEED = new Uint8Array(32).fill(45);
const DISPUTE_SEED = new Uint8Array(32).fill(46);

function stealFixture(handCounts: Record<string, number>, index: number) {
  const thief = identityFromSecret(new Uint8Array(32).fill(1));
  const victim = identityFromSecret(new Uint8Array(32).fill(2));
  const blind = scalars(11n);
  const commitments = Object.fromEntries(
    KINDS.map((kind) => [kind, pedersenCommit(BigInt(handCounts[kind] ?? 0), blind[kind] ?? 0n)]),
  );
  const handSize = KINDS.reduce((sum, kind) => sum + (handCounts[kind] ?? 0), 0);
  const operation: StealOperation = {
    protocol: STEAL_EVIDENCE_PROTOCOL,
    genesisDigest: toBase64Url(new Uint8Array(32).fill(9)),
    epoch: 2,
    anchor: { seq: 12, hash: 'a'.repeat(64) },
    beaconOperationId: 'c'.repeat(64),
    thief: {
      seat: 0,
      publicKey: thief.peerId,
      encryptionKey: encodePoint(scalePoint(G, RECIPIENT_SECRET)),
    },
    victim: { seat: 1, publicKey: victim.peerId },
    handSize,
    index,
    commitments: kindMap(commitments),
  };
  const contribution = value(
    createStealContribution(operation, handCounts, encoded(blind), STEAL_SEED, victim.secretKey),
  );
  const fixed: FixedSteal = {
    operation,
    contribution,
    entry: { seq: 13, hash: 'b'.repeat(64) },
  };
  return { thief, victim, blind, operation, contribution, fixed, handCounts };
}

// brick 1, lumber 2, wool 1, grain 1, ore 1, cloth 2, coin 1, paper 0: cards 0-8 by kind.
const HAND = counts({ brick: 1, lumber: 2, wool: 1, grain: 1, ore: 1, cloth: 2, coin: 1 });
const FIRST_COMMODITY = 6;

describe('hidden steals over eight card kinds', () => {
  test('every card, commodity included, is delivered exactly and constant-length', () => {
    const expected = [
      'brick',
      'lumber',
      'lumber',
      'wool',
      'grain',
      'ore',
      'cloth',
      'cloth',
      'coin',
    ];
    const lengths = new Set<number>();
    for (const [index, kind] of expected.entries()) {
      const data = stealFixture(HAND, index);
      const { operation, contribution, fixed, thief } = data;
      expect(verifyStealContribution(contribution, operation)).toMatchObject({ ok: true });
      const opened = value(openStealContribution(operation, contribution, RECIPIENT_SECRET));
      expect(opened.resource).toBe(kind);
      expect(Object.keys(opened.blindings)).toEqual(KINDS);
      lengths.add(contribution.body.sealed.ciphertext.length);
      expect(contribution.body.transfer).toHaveLength(8);
      expect(value(createStealReceipt(fixed, RECIPIENT_SECRET, thief.secretKey)).body.seat).toBe(0);
      // A genuine delivery is never evidence against the victim.
      expect(
        createStealDispute(fixed, RECIPIENT_SECRET, thief.secretKey, DISPUTE_SEED),
      ).toMatchObject({ ok: false, error: { code: 'steal-good-delivery' } });
    }
    expect(lengths.size).toBe(1);
    expect(stealOpeningBytes(8)).toBeGreaterThan(STEAL_OPENING_BYTES);
  }, 60_000);

  test('a false sealed commodity claim is disputable and never opens', () => {
    const data = stealFixture(HAND, FIRST_COMMODITY);
    const { operation, contribution, victim, thief, blind } = data;
    const operationId = stealOperationId(operation);
    const transferBlindings = KINDS.map((resource) =>
      deriveScalar(STEAL_SEED, DERIVATION_LABELS.transferBlind, { operationId, resource }),
    );
    // The public transfer selects cloth (index 6); the sealed claim says coin (index 7).
    const opening = canonicalEncode({ type: 7, blindings: transferBlindings.map(encodeScalar) });
    expect(opening).toHaveLength(stealOpeningBytes(8));
    const transfer = contribution.body.transfer;
    const { sealed, ephemeralProof } = sealWithEphemeralProof(
      opening,
      operation.thief.encryptionKey,
      STEAL_SEED,
      { protocol: 'steal-seal-v1', operationId, transfer },
      { protocol: 'steal-ephemeral-v1', operationId, transfer },
    );
    opening.fill(0);
    const proof = proveHiddenTransfer(
      {
        commitments: KINDS.map((kind) => operation.commitments[kind] ?? ''),
        transfer,
        handSize: operation.handSize,
        index: operation.index,
        payloadHash: toHex(hashValue(sealed)),
      },
      {
        counts: KINDS.map((kind) => HAND[kind] ?? 0),
        blindings: KINDS.map((kind) => blind[kind] ?? 0n),
        transferBlindings,
      },
      STEAL_SEED,
      { protocol: 'steal-transfer-v1', operationId },
    );
    const body = { operationId, seat: 1 as const, transfer, sealed, ephemeralProof, proof };
    const forged = { body, sig: signObject('steal-contribution', body, victim.secretKey) };
    // Publicly it is a valid transfer proof, so only the recipient can tell.
    expect(verifyStealContribution(forged, operation).ok).toBe(true);
    expect(openStealContribution(operation, forged, RECIPIENT_SECRET)).toMatchObject({
      ok: false,
      error: { code: 'steal-opening-mismatch' },
    });
    const fixed: FixedSteal = {
      operation,
      contribution: forged,
      entry: { seq: 13, hash: 'b'.repeat(64) },
    };
    const dispute = value(
      createStealDispute(fixed, RECIPIENT_SECRET, thief.secretKey, DISPUTE_SEED),
    );
    expect(verifyStealDispute(dispute, fixed).ok).toBe(true);
  });

  test('a transfer proven for a different index or a narrower vector is rejected', () => {
    const data = stealFixture(HAND, FIRST_COMMODITY);
    const { operation, contribution } = data;
    // The same contribution presented against an index that selects coin instead of cloth.
    const elsewhere: StealOperation = { ...operation, index: 8 };
    expect(verifyStealContribution(contribution, elsewhere).ok).toBe(false);
    // A five-kind contribution under an eight-kind operation.
    const narrow = stealFixture(counts({ brick: 1, cloth: 0 }), 0);
    const cross = { ...narrow.contribution.body, operationId: stealOperationId(operation) };
    expect(
      verifyStealContribution(
        {
          body: { ...cross, transfer: narrow.contribution.body.transfer.slice(0, 5) },
          sig: narrow.contribution.sig,
        },
        operation,
      ).ok,
    ).toBe(false);
    // The frozen victim commitments must name every base resource and only well-formed kinds.
    const withoutOre = Object.fromEntries(
      Object.entries(operation.commitments).filter(([kind]) => kind !== 'ore'),
    );
    expect(validateStealOperation({ ...operation, commitments: withoutOre }).ok).toBe(false);
    expect(
      validateStealOperation({
        ...operation,
        commitments: { ...operation.commitments, 'Bad Kind': operation.commitments.brick },
      }).ok,
    ).toBe(false);
    expect(
      validateStealOperation({
        ...operation,
        commitments: Object.fromEntries([
          ...Object.entries(operation.commitments),
          ['gold', operation.commitments.brick],
          ['gems', operation.commitments.brick],
        ]),
      }).ok,
    ).toBe(false);
    // A hand that lies about a commodity count cannot produce a contribution.
    expect(
      createStealContribution(
        operation,
        { ...HAND, coin: 2 },
        encoded(data.blind),
        STEAL_SEED,
        data.victim.secretKey,
      ).ok,
    ).toBe(false);
  });
});
