import type { CommandHandler, VpContribution } from '../../core/modules/index.js';
import type { GameState, PrivateState } from '../../core/state/index.js';
import { failure, success } from '../../core/types/index.js';
import type { Seat } from '../../core/types/index.js';
import { baseOptions } from './types.js';
import { ownSeat, updateSeat } from './shared.js';

function claimedIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every((id) => typeof id === 'string'))
    return null;
  return value;
}

export const claimVictory: CommandHandler = {
  validate: (state, input) => {
    const ids = claimedIds(input.command.slotIds);
    if (!ids) return failure('invalid-victory-slots', 'At least one card slot id is required');
    if (new Set(ids).size !== ids.length)
      return failure('duplicate-victory-slot', 'Victory card slots must be distinct');
    const own = ownSeat(state, input.seat);
    for (const id of ids) {
      const slot = own.cardSlots.find((item) => item.slotId === id);
      if (!slot || slot.revealed)
        return failure('invalid-victory-slot', 'Victory card slot is foreign, missing or spent');
    }
    return own.publicVp + ids.length >= baseOptions(state.config.options.base).vpTarget
      ? success(undefined)
      : failure('insufficient-victory-points', 'Claim does not reach the victory target');
  },
  apply: (state, input) => {
    const ids = claimedIds(input.command.slotIds);
    if (!ids) throw new Error('Validated victory slots missing');
    const selected = new Set(ids);
    const next = updateSeat(state, input.seat, (old) => ({
      ...old,
      cardSlots: old.cardSlots.map((slot) =>
        selected.has(slot.slotId) ? { ...slot, revealed: 'victoryPoint' } : slot,
      ),
    }));
    return {
      state: {
        ...next,
        result: { winner: input.seat, reason: 'claimed-vp', atTurn: state.turn.number },
      },
      events: [{ type: 'gameEnded', winner: input.seat, reason: 'claimed-vp' }],
    };
  },
  applyPrivate: (priv, _before, input) => {
    if (priv.seat !== input.seat) return success(priv);
    const ids = claimedIds(input.command.slotIds);
    if (
      !ids ||
      ids.some((id) => !Object.hasOwn(priv.slots, id) || priv.slots[id] !== 'victoryPoint')
    )
      return failure('private-victory-mismatch', 'Claimed card is not an owned victory point');
    return success({
      ...priv,
      slots: Object.fromEntries(Object.entries(priv.slots).filter(([id]) => !ids.includes(id))),
    });
  },
};

/** Only unrevealed owned victory-point cards are added to the public total. */
export function hiddenVictoryPoints(
  state: GameState,
  seat: Seat,
  priv?: PrivateState,
): VpContribution[] {
  if (!priv || priv.seat !== seat) return [];
  const publicSlots = ownSeat(state, seat).cardSlots;
  const hidden = publicSlots.filter(
    (slot) => !slot.revealed && priv.slots[slot.slotId] === 'victoryPoint',
  );
  return hidden.map((slot) => ({ source: slot.slotId, points: 1, public: false }));
}

/** Emit the first sufficient set of actual hidden VP cards before any further input. */
export function automaticVictoryClaim(state: GameState, privates: ReadonlyMap<Seat, PrivateState>) {
  if (state.turn.phase.at(-1)?.id === 'setup') return null;
  const seat = state.turn.activeSeat;
  const priv = privates.get(seat);
  if (!priv) return null;
  const needed = baseOptions(state.config.options.base).vpTarget - ownSeat(state, seat).publicVp;
  if (needed <= 0) return null;
  const ids = ownSeat(state, seat)
    .cardSlots.filter((slot) => !slot.revealed && priv.slots[slot.slotId] === 'victoryPoint')
    .map((slot) => slot.slotId)
    .toSorted();
  return ids.length >= needed
    ? {
        kind: 'command' as const,
        seat,
        command: { type: 'CLAIM_VICTORY', slotIds: ids.slice(0, needed) },
      }
    : null;
}
