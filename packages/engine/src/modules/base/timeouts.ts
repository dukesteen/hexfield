import type { SystemInputHandler } from '../../core/modules/index.js';
import type { GameState } from '../../core/state/index.js';
import { RESOURCES, failure, success } from '../../core/types/index.js';
import type { ResourceCounts, Result, Seat } from '../../core/types/index.js';
import { verticesForHex } from './board/index.js';
import { emptyResources } from './constants.js';
import { legalRobberHexes, moveRobber, steal, stealVictims } from './robber.js';
import { ownSeat, top, updateBase } from './shared.js';
import { discard, endTurn, rollDice } from './phases/turn.js';
import { skipRoadBuilding } from './devcards.js';
import { baseExt } from './types.js';

function timeoutSeat(state: GameState, value: unknown): Seat | undefined {
  return state.config.seats.find((seat) => seat === value);
}

function hasUnansweredOffer(state: GameState, seat: Seat): boolean {
  return baseExt(state.ext.base).offers.some(
    (offer) =>
      offer.proposer === state.turn.activeSeat &&
      offer.to.includes(seat) &&
      !offer.acceptedBy.includes(seat) &&
      !offer.declinedBy.includes(seat),
  );
}

function deterministicDiscard(state: GameState, seat: Seat): Result<ResourceCounts> {
  const bounds = ownSeat(state, seat).resources;
  if (RESOURCES.some((kind) => bounds.min[kind] !== bounds.max[kind]))
    return failure(
      'private-discard-required',
      'Unknown hand requires owner or escrow to choose a timeout discard',
    );
  let remaining = Math.floor(bounds.total / 2);
  const counts = emptyResources();
  const ordered = [...RESOURCES].toSorted(
    (left, right) =>
      bounds.min[right] - bounds.min[left] || RESOURCES.indexOf(left) - RESOURCES.indexOf(right),
  );
  for (const kind of ordered) {
    const amount = Math.min(bounds.min[kind], remaining);
    counts[kind] = amount;
    remaining -= amount;
  }
  return remaining === 0
    ? success(counts)
    : failure('private-discard-required', 'Public hand cannot determine a discard');
}

function automaticRobberHex(state: GameState): string | undefined {
  const candidates = legalRobberHexes(state);
  const ownVertices = new Set(
    state.board.buildings
      .filter((building) => building.seat === state.turn.activeSeat)
      .map((building) => building.vertex),
  );
  return (
    candidates.find(
      (hex) => !verticesForHex(state, hex).some((vertex) => ownVertices.has(vertex)),
    ) ?? candidates[0]
  );
}

export const timeout: SystemInputHandler = {
  validate: (state, input, ctx) => {
    const seat = timeoutSeat(state, input.seat);
    if (seat === undefined)
      return failure('invalid-timeout-seat', 'Timeout seat is not in the game');
    switch (top(state).id) {
      case 'preRoll':
      case 'moveRobber':
      case 'steal':
      case 'roadBuilding':
        return seat === state.turn.activeSeat
          ? success(undefined)
          : failure('wrong-timeout-seat', 'Only active seat can time out here');
      case 'discard': {
        const chosen = deterministicDiscard(state, seat);
        if (!chosen.ok) return chosen;
        return discard.validate(
          state,
          { kind: 'command', seat, command: { type: 'DISCARD', cards: chosen.value } },
          ctx,
        );
      }
      case 'main':
        return seat === state.turn.activeSeat || hasUnansweredOffer(state, seat)
          ? success(undefined)
          : failure('no-trade-response', 'Seat has no unanswered trade offer');
      default:
        return failure('unsupported-timeout', 'No timeout action is defined for this phase');
    }
  },
  apply: (state, input, ctx) => {
    const seat = timeoutSeat(state, input.seat);
    if (seat === undefined) throw new Error('Validated timeout seat missing');
    const phase = top(state).id;
    if (phase === 'preRoll')
      return rollDice.apply(state, { kind: 'command', seat, command: { type: 'ROLL_DICE' } }, ctx);
    if (phase === 'moveRobber') {
      const hex = automaticRobberHex(state);
      if (!hex) throw new Error('No legal robber hex');
      return moveRobber.apply(
        state,
        { kind: 'command', seat, command: { type: 'MOVE_ROBBER', hex } },
        ctx,
      );
    }
    if (phase === 'steal') {
      const victim = stealVictims(state).toSorted((a, b) => a - b)[0];
      if (victim === undefined) throw new Error('No timeout steal victim');
      const command = { kind: 'command' as const, seat, command: { type: 'STEAL', victim } };
      const valid = steal.validate(state, command, ctx);
      if (!valid.ok) throw new Error(`Timeout steal is invalid: ${valid.error.code}`);
      return steal.apply(state, command, ctx);
    }
    if (phase === 'discard') {
      const counts = deterministicDiscard(state, seat);
      if (!counts.ok) throw new Error('Validated timeout discard missing');
      return discard.apply(
        state,
        { kind: 'command', seat, command: { type: 'DISCARD', cards: counts.value } },
        ctx,
      );
    }
    if (phase === 'roadBuilding')
      return skipRoadBuilding.apply(
        state,
        { kind: 'command', seat, command: { type: 'SKIP' } },
        ctx,
      );
    if (phase === 'main' && seat === state.turn.activeSeat)
      return endTurn.apply(state, { kind: 'command', seat, command: { type: 'END_TURN' } }, ctx);
    if (phase === 'main') {
      const next = updateBase(state, (old) => ({
        ...old,
        offers: old.offers.map((offer) =>
          offer.proposer === state.turn.activeSeat &&
          offer.to.includes(seat) &&
          !offer.acceptedBy.includes(seat) &&
          !offer.declinedBy.includes(seat)
            ? { ...offer, declinedBy: [...offer.declinedBy, seat].toSorted((a, b) => a - b) }
            : offer,
        ),
      }));
      return { state: next, events: [{ type: 'tradeResponsesTimedOut', seat }] };
    }
    throw new Error('Unsupported validated timeout');
  },
  applyPrivate: (priv, before, input, _data, ctx) => {
    const seat = timeoutSeat(before, input.seat);
    if (seat === undefined || priv.seat !== seat || top(before).id !== 'discard')
      return success(priv);
    const counts = deterministicDiscard(before, seat);
    return counts.ok
      ? (discard.applyPrivate?.(
          priv,
          before,
          { kind: 'command', seat, command: { type: 'DISCARD', cards: counts.value } },
          undefined,
          ctx,
        ) ?? success(priv))
      : counts;
  },
};
