import { describe, expect, test } from 'vitest';
import type { GameState } from '../../../core/state/index.js';
import { inDice, newGame, submit, withLevels, withTokens } from '../support.js';
import { knightsExt, updateKnights } from '../types.js';
import { engine, held, privateOf, scene, system, withHidden } from './testing.js';

/** Seat 0 rolls a politics gate and draws. */
function drawConstitution(points = 0): GameState {
  const base = withLevels(newGame(engine, { seats: 3 }), 0, { politics: 2 });
  const start = updateKnights(inDice(withTokens(base, {})), (old) => ({
    ...old,
    defenders: [points, 0, 0],
  }));
  const rolled = system(start, {
    kind: 'system',
    type: 'DICE_RESULT',
    dice: [2, 4],
    extra: { event: 'politics' },
  });
  const pending = engine.getPending(rolled).find((item) => item.kind === 'random');
  if (pending?.kind !== 'random') throw new Error('No draw');
  return system(rolled, {
    kind: 'system',
    type: 'CARD_DEALT',
    deck: 'progress-politics',
    seat: 0,
    slotId: String(pending.request.slotId),
    card: 'constitution',
  });
}

function show(state: GameState, card: string): GameState {
  const ask = engine.getPending(state).find((item) => item.kind === 'reveal');
  if (ask?.kind !== 'reveal') throw new Error('No victory check');
  return system(state, {
    kind: 'system',
    type: 'REVEAL_PROGRESS',
    seat: ask.seat,
    slotId: String(ask.request.slotId),
    card,
  });
}

describe('Constitution', () => {
  test('is shown when drawn from the politics deck and is worth one point', () => {
    const shown = show(drawConstitution(), 'constitution');
    expect(shown.seats[0]?.publicVp).toBe(1);
    expect(held(shown, 0)).toEqual([]);
    expect(knightsExt(shown).bottom.politics).toEqual([]);
    expect(engine.checkInvariants(shown)).toEqual([]);
  });

  test('it belongs to the politics deck: the Printer is not its card', () => {
    const drawn = drawConstitution();
    const ask = engine.getPending(drawn).find((item) => item.kind === 'reveal');
    const slotId = ask?.kind === 'reveal' ? String(ask.request.slotId) : '';
    expect(
      engine.validate(drawn, {
        kind: 'system',
        type: 'REVEAL_PROGRESS',
        seat: 0,
        slotId,
        card: 'printer',
      }).ok,
    ).toBe(false);
    expect(ask).toMatchObject({ request: { deck: 'progress-politics' } });
  });

  test('a drawer who says none while holding it is caught by its own hand', () => {
    const drawn = drawConstitution();
    const ask = engine.getPending(drawn).find((item) => item.kind === 'reveal');
    const slotId = ask?.kind === 'reveal' ? String(ask.request.slotId) : '';
    const owner = privateOf(engine, drawn, 0, {}, { [slotId]: 'constitution' });
    expect(
      engine.applyPrivate(owner, drawn, {
        kind: 'system',
        type: 'REVEAL_PROGRESS',
        seat: 0,
        slotId,
        card: 'none',
      }).ok,
    ).toBe(false);
  });

  test('once shown, later politics draws are not checked, and a late reveal by play counts', () => {
    const shown = show(drawConstitution(), 'constitution');
    expect(shown.seats[0]?.cardSlots.some((slot) => slot.revealed === 'constitution')).toBe(true);
    const hidden = withHidden(scene().state, 0, 'constitution');
    const played = submit(engine, hidden.state, 0, {
      type: 'PLAY_PROGRESS_CARD',
      slotId: hidden.slotId,
      card: 'constitution',
    });
    // The scene's settlement and the Constitution.
    expect(played.seats[0]?.publicVp).toBe(2);
  });

  test('the thirteenth point wins on the drawer’s turn', () => {
    expect(show(drawConstitution(12), 'constitution').result).toMatchObject({ winner: 0 });
    expect(show(drawConstitution(11), 'constitution').result).toBeNull();
  });
});
