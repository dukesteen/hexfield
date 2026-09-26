import { toBase64Url } from '@cp2p/codec';
import { encodeScalar, pedersenCommit } from '@cp2p/crypto';
import * as cryptoProofs from '@cp2p/crypto';
import {
  RESOURCES,
  createBaseEngine,
  createResourceBounds,
  exactResourceBounds,
  gainKnown,
  loseKnown,
  revealExact,
  zeroCounts,
} from '@cp2p/engine';
import type {
  EngineEffect,
  GameState,
  Input,
  Resource,
  ResourceBounds,
  ResourceEndpoint,
  Result,
  Seat,
  Transition,
} from '@cp2p/engine';
import { describe, expect, test, vi } from 'vitest';
import { emptyHandCommitments } from './hand-commitments.js';
import {
  handProofContext,
  planHandTransition,
  proveHandObligation,
  verifyHandProofs,
} from './hand-transition.js';
import type { HandProofBinding, HandTransitionPlan } from './hand-transition.js';
import {
  COMMAND_PROOFS_PROTOCOL,
  composeCommandProofs,
  readCommandProofs,
} from './command-proofs.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
const empty = zeroCounts(RESOURCES);
const blindings = {
  brick: encodeScalar(7n),
  lumber: encodeScalar(0n),
  wool: encodeScalar(11n),
  grain: encodeScalar(0n),
  ore: encodeScalar(0n),
};
const counts = { ...empty, brick: 1, wool: 1 };
const input: Input = {
  kind: 'command',
  seat: 0,
  command: { type: 'DISCARD', cards: { brick: 1 } },
};
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
const seed = new Uint8Array(32).fill(8);

function fixture(exact = false) {
  const engine = createBaseEngine();
  const initial = engine.createGame(
    {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1],
      options: { base: { mapLayout: 'random' } },
    },
    new Uint8Array(32).fill(50),
  );
  const uncertain = value(
    createResourceBounds(2, empty, { brick: 2, lumber: 2, wool: 2, grain: 2, ore: 2 }),
  );
  const before = {
    ...initial,
    seats: initial.seats.map((seat) => ({
      ...seat,
      resources:
        seat.seat === 0
          ? exact
            ? value(exactResourceBounds(counts))
            : uncertain
          : value(exactResourceBounds({ ...empty, brick: 2 })),
    })),
  };
  const hands = value(emptyHandCommitments([0, 1])).map((row) => ({
    ...row,
    commitments: { ...row.commitments },
  }));
  for (const row of hands)
    for (const resource of RESOURCES) {
      const count = row.seat === 0 ? (counts[resource] ?? 0) : resource === 'brick' ? 2 : 0;
      const blind =
        row.seat === 0 ? (resource === 'brick' ? 7n : resource === 'wool' ? 11n : 0n) : 0n;
      row.commitments[resource] = pedersenCommit(BigInt(count), blind);
    }
  return { before, hands };
}

// Synthetic accounting fixtures isolate proof obligations; the caller must separately
// validate a real engine command. Legal peer histories are covered by integration tests.
function transition(before: GameState, effects: EngineEffect[]): Transition {
  const bank = { ...before.bank };
  const hands = new Map<Seat, ResourceBounds>(
    before.seats.map((seat) => [seat.seat, seat.resources]),
  );
  const move = (endpoint: ResourceEndpoint, resource: Resource, count: number, credit: boolean) => {
    if (endpoint.kind === 'bank') {
      bank[resource] = (bank[resource] ?? 0) + (credit ? count : -count);
      return;
    }
    const hand = hands.get(endpoint.seat);
    if (!hand) throw new Error('Missing test hand');
    hands.set(
      endpoint.seat,
      value((credit ? gainKnown : loseKnown)(hand, { ...empty, [resource]: count })),
    );
  };
  for (const effect of effects) {
    if (effect.type === 'resource-transfer') {
      move(effect.from, effect.resource, effect.count, false);
      move(effect.to, effect.resource, effect.count, true);
    } else if (effect.type === 'resource-count-revealed') {
      const hand = hands.get(effect.seat);
      if (!hand) throw new Error('Missing count hand');
      hands.set(effect.seat, value(revealExact(hand, effect.resource, effect.count)));
    }
  }
  return {
    state: {
      ...before,
      bank,
      seats: before.seats.map((seat) => ({
        ...seat,
        resources: hands.get(seat.seat) ?? seat.resources,
      })),
    },
    events: [],
    effects,
  };
}

const debit: EngineEffect = {
  type: 'resource-transfer',
  from: { kind: 'seat', seat: 0 },
  to: { kind: 'bank' },
  resource: 'brick',
  count: 1,
};

describe('committed hand transition obligations', () => {
  test('requires a real six-bit proof when public minima are insufficient and binds every context field', () => {
    const { before, hands } = fixture();
    const applied = transition(before, [structuredClone(debit)]);
    const plan = value(planHandTransition(hands, before, input, applied));
    expect(plan.obligations).toMatchObject([
      { kind: 'range', seat: 0, resource: 'brick', count: 1, effectIndices: [0] },
    ]);
    expect(plan.hands[0]?.commitments.brick).toBe(pedersenCommit(0n, 7n));
    const proof = value(proveHandObligation(plan, 0, counts, blindings, seed, binding));
    expect(verifyHandProofs(plan, [proof], binding).ok).toBe(true);
    expect(verifyHandProofs(plan, [], binding).ok).toBe(false);
    expect(verifyHandProofs(plan, [proof, proof], binding).ok).toBe(false);
    expect(verifyHandProofs(plan, [{ ...proof, resource: 'wool' }], binding).ok).toBe(false);
    const command = binding.command;
    if (!command) throw new Error('Missing test command');
    for (const changed of [
      { ...binding, epoch: 1 },
      { ...binding, command: { ...command, nonce: 3 } },
      {
        ...binding,
        anchor: { seq: 10, hash: 'b'.repeat(64) },
        command: { ...command, headSeq: 10, headHash: 'b'.repeat(64) },
      },
      {
        ...binding,
        genesisDigest: toBase64Url(new Uint8Array(32).fill(2)),
        command: { ...command, genesisDigest: toBase64Url(new Uint8Array(32).fill(2)) },
      },
    ])
      expect(verifyHandProofs(plan, [proof], changed).ok).toBe(false);
    expect(
      verifyHandProofs(
        { ...plan, effects: plan.effects.toReversed().concat(debit) },
        [proof],
        binding,
      ).ok,
    ).toBe(false);
    expect(
      verifyHandProofs(
        {
          ...plan,
          obligations: plan.obligations.map((obligation) => ({
            ...obligation,
            commitment: pedersenCommit(2n, 7n),
          })),
        },
        [proof],
        binding,
      ).ok,
    ).toBe(false);
    expect(proveHandObligation(plan, 0, { ...counts, brick: 0 }, blindings, seed, binding).ok).toBe(
      false,
    );
    expect(
      proveHandObligation(plan, 0, counts, { ...blindings, brick: encodeScalar(8n) }, seed, binding)
        .ok,
    ).toBe(false);
    expect(handProofContext(plan, 0, binding)).toMatchObject({
      protocol: 'hand-obligation-v1',
      obligation: plan.obligations[0],
    });
    // Plans detach engine effect references before any owner proof production.
    if (applied.effects[0]?.type === 'resource-transfer') applied.effects[0].count = 2;
    expect(plan.effects[0]).toMatchObject({ count: 1 });
    expect(verifyHandProofs(plan, [proof], binding).ok).toBe(true);
  });

  test('sums gross debits and does not fund a promise with incoming cards', () => {
    const { before, hands } = fixture();
    const twice = value(
      planHandTransition(hands, before, input, transition(before, [debit, debit])),
    );
    expect(twice.obligations[0]).toMatchObject({ count: 2, effectIndices: [0, 1] });
    expect(proveHandObligation(twice, 0, counts, blindings, seed, binding)).toMatchObject({
      ok: false,
      error: { code: 'hand-proof-witness' },
    });
    const incoming: EngineEffect = {
      type: 'resource-transfer',
      from: { kind: 'seat', seat: 1 },
      to: { kind: 'seat', seat: 0 },
      resource: 'brick',
      count: 1,
    };
    const outgoing: EngineEffect = { ...debit, count: 2 };
    const plan = value(
      planHandTransition(hands, before, input, transition(before, [incoming, outgoing])),
    );
    expect(plan.obligations).toMatchObject([{ seat: 0, resource: 'brick', count: 2 }]);
    expect(proveHandObligation(plan, 0, counts, blindings, seed, binding).ok).toBe(false);
  });

  test('skips only debits covered by parent minimum and rejects needless proof packets', () => {
    const { before, hands } = fixture(true);
    const plan = value(planHandTransition(hands, before, input, transition(before, [debit])));
    expect(plan.obligations).toEqual([]);
    expect(verifyHandProofs(plan, [], binding).ok).toBe(true);
    expect(readCommandProofs(undefined, plan)).toEqual({
      ok: true,
      value: { deck: [], hands: [] },
    });
    expect(composeCommandProofs([], [])).toBeUndefined();
    expect(
      readCommandProofs({ protocol: COMMAND_PROOFS_PROTOCOL, data: { deck: [], hands: [] } }, plan)
        .ok,
    ).toBe(false);
    expect(readCommandProofs({ protocol: 'anything', data: null }, plan).ok).toBe(false);
  });

  test('requires an opening for zero as well as positive reveals before monopoly movement', () => {
    for (const count of [0, 1]) {
      const { before, hands } = fixture();
      const witness = { ...counts, brick: count, wool: 2 - count };
      const owner = hands[0];
      if (!owner) throw new Error('Missing test owner');
      owner.commitments.brick = pedersenCommit(BigInt(count), 7n);
      owner.commitments.wool = pedersenCommit(BigInt(2 - count), 11n);
      const effects: EngineEffect[] = [
        { type: 'resource-count-revealed', seat: 0, resource: 'brick', count },
      ];
      if (count) effects.push(debit);
      const system: Input = {
        kind: 'system',
        type: 'REVEAL_COUNT',
        seat: 0,
        resource: 'brick',
        count,
      };
      const context = { ...binding, command: null };
      const plan = value(planHandTransition(hands, before, system, transition(before, effects)));
      expect(plan.obligations).toHaveLength(1);
      expect(plan.obligations[0]).toMatchObject({ kind: 'count', count });
      const proof = value(proveHandObligation(plan, 0, witness, blindings, seed, context));
      expect(verifyHandProofs(plan, [proof], context).ok).toBe(true);
      expect(verifyHandProofs(plan, [], context).ok).toBe(false);
      expect(verifyHandProofs(plan, [{ ...proof, count: 1 - count }], context).ok).toBe(false);
    }
  });

  test('blocks hidden and named steals and inconsistent effects before a proof callback could help', () => {
    const { before, hands } = fixture();
    for (const resource of ['hidden', 'brick']) {
      expect(
        planHandTransition(
          hands,
          before,
          { kind: 'system', type: 'STEAL_RESULT', thief: 0, victim: 1, resource },
          { state: before, events: [], effects: [] },
        ),
      ).toMatchObject({ ok: false, error: { code: 'hand-steal-unavailable' } });
    }
    expect(
      planHandTransition(hands, before, input, { state: before, events: [], effects: [debit] }),
    ).toMatchObject({ ok: false, error: { code: 'resource-accounting' } });
  });

  test('requires both exact evidence sections and limits deck-only migration to no hand obligation', () => {
    const { before, hands } = fixture();
    const plan = value(planHandTransition(hands, before, input, transition(before, [debit])));
    const proof = value(proveHandObligation(plan, 0, counts, blindings, seed, binding));
    expect(readCommandProofs(composeCommandProofs([], [proof]), plan)).toMatchObject({ ok: true });
    const reveal = { slotId: 'slot', identity: 'knight', proof: {} };
    const both: HandTransitionPlan = {
      ...plan,
      effects: [
        ...plan.effects,
        { type: 'card-slot-revealed', seat: 0, deck: 'dev', slotId: 'slot', card: 'knight' },
      ],
    };
    expect(readCommandProofs(composeCommandProofs([reveal], [proof]), both).ok).toBe(true);
    expect(readCommandProofs(composeCommandProofs([], [proof]), both).ok).toBe(false);
    expect(readCommandProofs(composeCommandProofs([reveal], []), both).ok).toBe(false);
    const legacy = { protocol: 'deck-reveal-v1', data: [reveal] };
    expect(readCommandProofs(legacy, both).ok).toBe(false);
    expect(readCommandProofs(legacy, { ...both, obligations: [] }).ok).toBe(true);
    expect(
      readCommandProofs(
        { protocol: COMMAND_PROOFS_PROTOCOL, data: { deck: [], hands: [proof], extra: true } },
        plan,
      ).ok,
    ).toBe(false);
    expect(
      readCommandProofs(
        {
          protocol: COMMAND_PROOFS_PROTOCOL,
          data: { deck: [], hands: [{ ...proof, extra: true }] },
        },
        plan,
      ).ok,
    ).toBe(false);
    const curve = vi.spyOn(cryptoProofs, 'verifyRange');
    try {
      expect(
        verifyHandProofs(
          plan,
          Array.from({ length: 31 }, () => proof),
          binding,
        ).ok,
      ).toBe(false);
      expect(
        readCommandProofs(
          composeCommandProofs(
            Array.from({ length: 129 }, () => reveal),
            [proof],
          ),
          both,
        ).ok,
      ).toBe(false);
      expect(curve).not.toHaveBeenCalled();
    } finally {
      curve.mockRestore();
    }
  });

  test('binds the order and role of two independently owned proof obligations', () => {
    const data = fixture();
    const before = {
      ...data.before,
      seats: data.before.seats.map((seat) => ({
        ...seat,
        resources: data.before.seats[0]?.resources ?? seat.resources,
      })),
    };
    const otherDebit: EngineEffect = { ...debit, from: { kind: 'seat', seat: 1 } };
    const plan = value(
      planHandTransition(data.hands, before, input, transition(before, [debit, otherDebit])),
    );
    expect(plan.obligations.map((obligation) => obligation.seat)).toEqual([0, 1]);
    const first = value(proveHandObligation(plan, 0, counts, blindings, seed, binding));
    const otherCounts = { ...empty, brick: 2 };
    const zero = encodeScalar(0n);
    const otherBlindings = { brick: zero, lumber: zero, wool: zero, grain: zero, ore: zero };
    const second = value(proveHandObligation(plan, 1, otherCounts, otherBlindings, seed, binding));
    expect(verifyHandProofs(plan, [first, second], binding).ok).toBe(true);
    expect(verifyHandProofs(plan, [second, first], binding)).toMatchObject({
      ok: false,
      error: { code: 'hand-proof-obligation' },
    });
    const countProof = {
      ...first,
      kind: 'count',
      proof: { commitment: pedersenCommit(0n, 0n), response: zero },
    };
    expect(verifyHandProofs(plan, [countProof, second], binding)).toMatchObject({
      ok: false,
      error: { code: 'hand-proof-obligation' },
    });
  });
});
