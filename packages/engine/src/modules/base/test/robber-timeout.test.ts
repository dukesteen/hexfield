import { describe, expect, test } from 'vitest';
import { exactResourceBounds, gainHidden } from '../../../core/resources/index.js';
import type { GameState, PrivateState } from '../../../core/state/types.js';
import type { ResourceCounts, Seat } from '../../../core/types/index.js';
import { baseModule, createBaseEngine } from '../index.js';
import { verticesForHex } from '../board/index.js';
import { legalRobberHexes } from '../robber.js';
import { frame } from '../shared.js';
import { baseExt } from '../types.js';
import type { TradeOffer } from '../types.js';

const engine = createBaseEngine();
const zero = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
function genesis(options: Record<string, unknown> = {}): GameState {
  return engine.createGame(
    {
      modules: [{ id: 'base', version: baseModule().version }],
      seats: [0, 1, 2],
      options: { base: options },
    },
    new Uint8Array(32),
  );
}
function withPhase(state: GameState, id: string, data: unknown = null): GameState {
  return { ...state, turn: { ...state.turn, activeSeat: 0, phase: [frame(id, data)] } };
}
function withHand(state: GameState, seat: Seat, counts: ResourceCounts): GameState {
  const exact = exactResourceBounds(counts);
  if (!exact.ok) throw new Error(exact.error.message);
  return {
    ...state,
    seats: state.seats.map((item) =>
      item.seat === seat ? { ...item, resources: exact.value } : item,
    ),
  };
}
function answer(state: GameState, type: string, fields: Record<string, unknown> = {}): GameState {
  const result = engine.apply(state, { kind: 'system', type, ...fields });
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value.state;
}
function privateHand(seat: Seat, counts: ResourceCounts): PrivateState {
  return { ...engine.createPrivateState(seat), hand: { ...counts } };
}

describe('robber and timeout rules', () => {
  test('friendly robber avoids low-VP neighbors and falls back when every hex is restricted', () => {
    const initial = genesis({ friendlyRobber: true });
    const candidate = initial.board.hexes.find((hex) => hex.id !== initial.board.robberHex)?.id;
    if (!candidate) throw new Error('No candidate hex');
    const vertex = verticesForHex(initial, candidate)[0];
    if (!vertex) throw new Error('No candidate vertex');
    const restricted = {
      ...initial,
      board: { ...initial.board, buildings: [{ vertex, seat: 1 as const, kind: 'settlement' }] },
    };
    expect(legalRobberHexes(restricted)).not.toContain(candidate);
    const allCovered = {
      ...initial,
      board: {
        ...initial.board,
        buildings: initial.board.hexes.flatMap((hex) => {
          const at = verticesForHex(initial, hex.id)[0];
          return at ? [{ vertex: at, seat: 1 as const, kind: 'settlement' }] : [];
        }),
      },
    };
    expect(legalRobberHexes(allCovered)).toEqual(
      initial.board.hexes
        .map((hex) => hex.id)
        .filter((hex) => hex !== initial.board.robberHex)
        .toSorted(),
    );
  });

  test('seven discards are simultaneous and timeout picks most plentiful, canonical tie first', () => {
    let current = withPhase(genesis(), 'discard', { remaining: [0, 1] });
    current = withHand(current, 0, { ...zero, brick: 4, lumber: 4 });
    current = withHand(current, 1, { ...zero, grain: 5, ore: 4 });
    expect(
      engine
        .getPending(current)
        .filter((item) => item.kind === 'player')
        .map((item) => item.seat),
    ).toEqual([0, 1]);
    const first = answer(current, 'TIMEOUT', { seat: 0, phase: 'discard' });
    expect(first.seats[0]?.resources.total).toBe(4);
    expect(first.seats[0]?.resources.min.brick).toBe(0);
    expect(first.seats[0]?.resources.min.lumber).toBe(4);
    expect(
      engine
        .getPending(first)
        .flatMap((item) =>
          item.kind === 'player' && item.allowed.includes('DISCARD') ? [item.seat] : [],
        ),
    ).toEqual([1]);
    const second = answer(first, 'TIMEOUT', { seat: 1, phase: 'discard' });
    expect(second.turn.phase.at(-1)?.id).toBe('moveRobber');
    expect(second.seats[1]?.resources.total).toBe(5);
    expect(second.seats[1]?.resources.min.grain).toBe(1);
  });

  test('exact-hand timeout discards the same cards publicly and privately', () => {
    const hand = { ...zero, brick: 4, lumber: 4 };
    const initial = withHand(withPhase(genesis(), 'discard', { remaining: [1] }), 1, hand);
    const waiting = { ...initial, bank: { ...initial.bank, brick: 15, lumber: 15 } };
    const input = { kind: 'system' as const, type: 'TIMEOUT', seat: 1, phase: 'discard' };
    const publicResult = engine.apply(waiting, input);
    const actorResult = engine.applyPrivate(privateHand(1, hand), waiting, input);
    const otherResult = engine.applyPrivate(privateHand(2, zero), waiting, input);

    expect(publicResult.ok).toBe(true);
    expect(actorResult.ok).toBe(true);
    expect(otherResult.ok).toBe(true);
    if (!publicResult.ok || !actorResult.ok || !otherResult.ok) return;
    expect(publicResult.value.state.seats[1]?.resources.min).toEqual({ ...zero, lumber: 4 });
    expect(publicResult.value.state.bank).toEqual({ ...waiting.bank, brick: 19 });
    expect(actorResult.value.hand).toEqual({ ...zero, lumber: 4 });
    expect(otherResult.value.hand).toEqual(zero);
  });

  test('timeout cannot guess a private discard from ambiguous public bounds', () => {
    const exact = exactResourceBounds({ ...zero, brick: 8 });
    if (!exact.ok) throw new Error(exact.error.message);
    const ambiguous = gainHidden(exact.value, 1);
    if (!ambiguous.ok) throw new Error(ambiguous.error.message);
    const initial = withPhase(genesis(), 'discard', { remaining: [1] });
    const waiting = {
      ...initial,
      seats: initial.seats.map((seat) =>
        seat.seat === 1 ? { ...seat, resources: ambiguous.value } : seat,
      ),
    };
    expect(
      engine.validate(waiting, { kind: 'system', type: 'TIMEOUT', seat: 1, phase: 'discard' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'private-discard-required' },
    });
  });

  test('discardLimit zero skips a one-card zero-discard and keeps a two-card discard', () => {
    let waiting = withPhase(genesis({ discardLimit: 0 }), 'dice');
    waiting = withHand(waiting, 0, { ...zero, brick: 1 });
    waiting = withHand(waiting, 1, { ...zero, ore: 2 });
    const rolled = answer(waiting, 'DICE_RESULT', { dice: [3, 4] });
    expect(rolled.turn.phase.at(-1)?.id).toBe('discard');
    expect(
      engine
        .getPending(rolled)
        .flatMap((item) =>
          item.kind === 'player' && item.allowed.includes('DISCARD') ? [item.seat] : [],
        ),
    ).toEqual([1]);
    const after = answer(rolled, 'TIMEOUT', { seat: 1, phase: 'discard' });
    expect(after.seats[1]?.resources.total).toBe(1);
    expect(after.turn.phase.at(-1)?.id).toBe('moveRobber');
  });

  test('timeout discard drains initially largest pile before smaller piles', () => {
    const waiting = withHand(withPhase(genesis(), 'discard', { remaining: [0] }), 0, {
      ...zero,
      wool: 1,
      grain: 4,
      ore: 5,
    });
    const after = answer(waiting, 'TIMEOUT', { seat: 0, phase: 'discard' });
    expect(after.seats[0]?.resources.min).toEqual({ ...zero, wool: 1, grain: 4 });
  });

  test('claim-only active seat cannot time out another seat’s discard', () => {
    const waiting = withHand(withPhase(genesis(), 'discard', { remaining: [1] }), 1, {
      ...zero,
      ore: 8,
    });
    expect(
      engine
        .getPending(waiting)
        .some(
          (item) =>
            item.kind === 'player' && item.seat === 0 && item.allowed.includes('CLAIM_VICTORY'),
        ),
    ).toBe(true);
    const input = { kind: 'system' as const, type: 'TIMEOUT', seat: 0, phase: 'discard' };
    expect(engine.validate(waiting, input)).toMatchObject({
      ok: false,
      error: { code: 'not-discarding' },
    });
    expect(engine.apply(waiting, input)).toMatchObject({
      ok: false,
      error: { code: 'not-discarding' },
    });
    expect(waiting.turn.phase.at(-1)?.data).toEqual({ remaining: [1] });
  });

  test('a seat already discarded cannot time out a second time while another remains', () => {
    let waiting = withPhase(genesis(), 'discard', { remaining: [0, 1] });
    waiting = withHand(waiting, 0, { ...zero, brick: 8 });
    waiting = withHand(waiting, 1, { ...zero, ore: 8 });
    const afterFirst = answer(waiting, 'TIMEOUT', { seat: 0, phase: 'discard' });
    const repeated = { kind: 'system' as const, type: 'TIMEOUT', seat: 0, phase: 'discard' };
    expect(afterFirst.turn.phase.at(-1)?.data).toEqual({ remaining: [1] });
    expect(engine.validate(afterFirst, repeated)).toMatchObject({
      ok: false,
      error: { code: 'not-discarding' },
    });
    expect(engine.apply(afterFirst, repeated)).toMatchObject({
      ok: false,
      error: { code: 'not-discarding' },
    });
    expect(afterFirst.seats[0]?.resources.total).toBe(4);
  });

  test('known and hidden steals update public bounds and private hands', () => {
    const start = withHand(
      withPhase(genesis(), 'stealResult', { thief: 0, victim: 2, returnTo: 'main' }),
      2,
      { ...zero, brick: 1 },
    );
    const known = {
      kind: 'system' as const,
      type: 'STEAL_RESULT',
      thief: 0,
      victim: 2,
      resource: 'brick',
    };
    const knownPublic = engine.apply(start, known);
    expect(knownPublic.ok).toBe(true);
    if (!knownPublic.ok) return;
    expect(knownPublic.value.state.seats[0]?.resources.min.brick).toBe(1);
    expect(knownPublic.value.state.seats[2]?.resources.total).toBe(0);
    const knownPrivate = engine.applyPrivate(privateHand(0, zero), start, known);
    expect(knownPrivate.ok && knownPrivate.value.hand.brick).toBe(1);

    const hidden = { ...known, resource: 'hidden' };
    const hiddenPublic = engine.apply(start, hidden);
    expect(hiddenPublic.ok).toBe(true);
    if (!hiddenPublic.ok) return;
    expect(hiddenPublic.value.state.seats[0]?.resources.total).toBe(1);
    expect(hiddenPublic.value.state.seats[0]?.resources.min.brick).toBe(0);
    const privateThief = engine.applyPrivate(privateHand(0, zero), start, hidden, {
      resource: 'brick',
    });
    const privateVictim = engine.applyPrivate(
      privateHand(2, { ...zero, brick: 1 }),
      start,
      hidden,
      { resource: 'brick' },
    );
    expect(privateThief.ok && privateThief.value.hand.brick).toBe(1);
    expect(privateVictim.ok && privateVictim.value.hand.brick).toBe(0);
    expect(engine.applyPrivate(privateHand(0, zero), start, hidden)).toMatchObject({
      ok: false,
      error: { code: 'missing-private-steal-card' },
    });
  });

  test('robber rejects its current or unknown hex and resumes main without a victim', () => {
    const waiting = withPhase(genesis(), 'moveRobber', { returnTo: 'main' });
    const current = waiting.board.robberHex;
    const target = legalRobberHexes(waiting)[0];
    if (!current || !target) throw new Error('Missing robber hex');
    expect(
      engine.validate(waiting, {
        kind: 'command',
        seat: 0,
        command: { type: 'MOVE_ROBBER', hex: current },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'illegal-robber-hex' },
    });
    expect(
      engine.validate(waiting, {
        kind: 'command',
        seat: 0,
        command: { type: 'MOVE_ROBBER', hex: 'toString' },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'illegal-robber-hex' },
    });
    const moved = engine.apply(waiting, {
      kind: 'command',
      seat: 0,
      command: { type: 'MOVE_ROBBER', hex: target },
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.value.state.board.robberHex).toBe(target);
    expect(moved.value.state.turn.phase.at(-1)?.id).toBe('main');
  });

  test('occupied robber hex leads only to eligible victims and validates the steal result', () => {
    const initial = genesis();
    const target = legalRobberHexes(initial)[0];
    if (!target) throw new Error('No target hex');
    const vertex = verticesForHex(initial, target)[0];
    if (!vertex) throw new Error('No target vertex');
    const occupied = withHand(
      {
        ...initial,
        board: { ...initial.board, buildings: [{ vertex, seat: 2, kind: 'settlement' }] },
      },
      2,
      { ...zero, brick: 1 },
    );
    const waiting = withPhase(occupied, 'moveRobber', { returnTo: 'main' });
    const chosen = engine.apply(waiting, {
      kind: 'command',
      seat: 0,
      command: { type: 'MOVE_ROBBER', hex: target },
    });
    expect(chosen.ok).toBe(true);
    if (!chosen.ok) return;
    const stealPhase = chosen.value.state;
    expect(stealPhase.turn.phase.at(-1)?.id).toBe('steal');
    expect(
      engine.validate(stealPhase, {
        kind: 'command',
        seat: 0,
        command: { type: 'STEAL', victim: 1 },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid-steal-victim' },
    });
    const selected = engine.apply(stealPhase, {
      kind: 'command',
      seat: 0,
      command: { type: 'STEAL', victim: 2 },
    });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    const stealing = selected.value.state;
    expect(
      engine.validate(stealing, {
        kind: 'system',
        type: 'STEAL_RESULT',
        thief: 1,
        victim: 2,
        resource: 'brick',
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'steal-result-mismatch' },
    });
    expect(
      engine.validate(stealing, {
        kind: 'system',
        type: 'STEAL_RESULT',
        thief: 0,
        victim: 1,
        resource: 'brick',
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'steal-result-mismatch' },
    });
    expect(
      engine.validate(stealing, {
        kind: 'system',
        type: 'STEAL_RESULT',
        thief: 0,
        victim: 2,
        resource: 'unknown',
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid-steal-resource' },
    });
    expect(
      engine.validate(stealing, {
        kind: 'system',
        type: 'STEAL_RESULT',
        thief: 0,
        victim: 2,
        resource: 'ore',
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'insufficient-resources' },
    });
    expect(
      engine.applyPrivate(
        privateHand(0, zero),
        stealing,
        { kind: 'system', type: 'STEAL_RESULT', thief: 0, victim: 2, resource: 'brick' },
        { resource: 'ore' },
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'steal-card-mismatch' },
    });
  });

  test('timeout steal chooses first eligible victim, not first other seat', () => {
    const waiting = withPhase(genesis(), 'steal', { targets: [2], thief: 0, returnTo: 'main' });
    const next = answer(waiting, 'TIMEOUT', { seat: 0, phase: 'steal' });
    expect(next.turn.phase.at(-1)).toEqual(
      frame('stealResult', { thief: 0, victim: 2, returnTo: 'main' }),
    );
  });

  test('moveRobber timeout avoids own building when possible', () => {
    const initial = genesis();
    const candidates = legalRobberHexes(initial);
    const first = candidates[0];
    if (!first) throw new Error('No robber target');
    const vertex = verticesForHex(initial, first)[0];
    if (!vertex) throw new Error('No robber vertex');
    const waiting = withPhase(
      {
        ...initial,
        board: { ...initial.board, buildings: [{ vertex, seat: 0, kind: 'settlement' }] },
      },
      'moveRobber',
      { returnTo: 'main' },
    );
    const expected = candidates.find((hex) => !verticesForHex(waiting, hex).includes(vertex));
    const next = answer(waiting, 'TIMEOUT', { seat: 0, phase: 'moveRobber' });
    expect(next.board.robberHex).toBe(expected);
    expect(next.turn.phase.at(-1)?.id).toBe('main');
  });

  test('preRoll, roadBuilding, main, and pending trade response timeouts advance deterministically', () => {
    const initial = genesis();
    expect(
      answer(withPhase(initial, 'preRoll'), 'TIMEOUT', { seat: 0, phase: 'preRoll' }).turn.phase.at(
        -1,
      )?.id,
    ).toBe('dice');
    const road = {
      ...initial,
      turn: {
        ...initial.turn,
        activeSeat: 0 as const,
        phase: [frame('main'), frame('roadBuilding', { remaining: 2 })],
      },
    };
    expect(answer(road, 'TIMEOUT', { seat: 0, phase: 'roadBuilding' }).turn.phase.at(-1)?.id).toBe(
      'main',
    );
    expect(
      answer(withPhase(initial, 'main'), 'TIMEOUT', { seat: 0, phase: 'main' }).turn.activeSeat,
    ).toBe(1);
    const offer: TradeOffer = {
      id: 0,
      proposer: 0,
      give: { ...zero, brick: 1 },
      want: { ...zero, ore: 1 },
      to: [1],
      acceptedBy: [],
      declinedBy: [],
      valid: true,
    };
    const ext = baseExt(initial.ext.base);
    const withOffer = withPhase(
      { ...initial, ext: { ...initial.ext, base: { ...ext, offers: [offer] } } },
      'main',
    );
    const declined = answer(withOffer, 'TIMEOUT', { seat: 1, phase: 'main' });
    const declinedExt = baseExt(declined.ext.base);
    expect(declinedExt.offers[0]?.declinedBy).toEqual([1]);
  });

  test('road-building interrupt uses the main-turn timer', () => {
    const initial = genesis({
      turnTimer: {
        preRollSec: 5,
        mainSec: 11,
        discardSec: 17,
        robberSec: 23,
      },
    });
    const waiting = {
      ...initial,
      turn: {
        ...initial.turn,
        activeSeat: 0 as const,
        phase: [frame('main'), frame('roadBuilding', { remaining: 2 })],
      },
    };
    expect(engine.getPending(waiting)).toContainEqual(
      expect.objectContaining({
        kind: 'player',
        seat: 0,
        deadline: { phase: 'roadBuilding', seconds: 11 },
      }),
    );
  });

  test('offered trade response uses mainSec while proposal-only pending has no deadline', () => {
    const initial = genesis({
      turnTimer: {
        preRollSec: 5,
        mainSec: 11,
        discardSec: 17,
        robberSec: 23,
      },
    });
    const offer: TradeOffer = {
      id: 0,
      proposer: 0,
      give: { ...zero, brick: 1 },
      want: { ...zero, ore: 1 },
      to: [1],
      acceptedBy: [],
      declinedBy: [],
      valid: true,
    };
    const waiting = withPhase(
      {
        ...initial,
        ext: { ...initial.ext, base: { ...baseExt(initial.ext.base), offers: [offer] } },
      },
      'main',
    );
    expect(engine.getPending(waiting)).toContainEqual(
      expect.objectContaining({
        kind: 'player',
        seat: 1,
        allowed: ['PROPOSE_TRADE', 'RESPOND_TRADE'],
        deadline: { phase: 'main', seconds: 11 },
      }),
    );
    expect(engine.getPending(waiting)).toContainEqual({
      kind: 'player',
      seat: 2,
      allowed: ['PROPOSE_TRADE'],
    });
  });

  test('proposal-only non-active seat has no main-turn timeout to resolve', () => {
    const waiting = withPhase(genesis(), 'main');
    expect(engine.getPending(waiting)).toContainEqual({
      kind: 'player',
      seat: 1,
      allowed: ['PROPOSE_TRADE'],
    });
    const input = { kind: 'system' as const, type: 'TIMEOUT', seat: 1, phase: 'main' };
    expect(engine.validate(waiting, input)).toMatchObject({
      ok: false,
      error: { code: 'no-trade-response' },
    });
    expect(engine.apply(waiting, input)).toMatchObject({
      ok: false,
      error: { code: 'no-trade-response' },
    });
  });
});
