import { describe, expect, test } from 'vitest';
import type { GameState } from '../../../core/state/index.js';
import type { Seat } from '../../../core/types/index.js';
import {
  handOf,
  hexOf,
  inDice,
  newGame,
  rejection,
  ringLayout,
  submit,
  top,
  verticesOfHex,
  withBuildings,
  withHand,
  withKnights,
  withLevels,
  withStep,
  withTokens,
} from '../support.js';
import { knightsExt, updateKnights } from '../types.js';
import {
  at,
  engine,
  frameSlot,
  held,
  privateOf,
  scene,
  system,
  systemRefusal,
  withCards,
} from './testing.js';

/** Seat 0 rolls; seats 0 and 1 have science level 1 and 2, seat 2 none. */
function start(active: Seat = 0): GameState {
  const base = newGame(engine, { seats: 3 });
  const levels = withLevels(withLevels(base, 0, { science: 1 }), 1, { science: 2 });
  return inDice(withTokens(levels, {}), active);
}

const roll = (state: GameState, dice: [number, number], event: string) =>
  system(state, { kind: 'system', type: 'DICE_RESULT', dice, extra: { event } });

/** Answer every victory check with "none", as a drawer without a victory card does. */
function checked(state: GameState): GameState {
  let next = state;
  for (;;) {
    const ask = engine
      .getPending(next)
      .find((item) => item.kind === 'reveal' && item.systemType === 'REVEAL_PROGRESS');
    if (ask?.kind !== 'reveal') return next;
    next = system(next, {
      kind: 'system',
      type: 'REVEAL_PROGRESS',
      seat: ask.seat,
      slotId: String(ask.request.slotId),
      card: 'none',
    });
  }
}

const deal = (state: GameState, seat: Seat, card: string) => {
  const pending = engine.getPending(state).find((item) => item.kind === 'random');
  if (pending?.kind !== 'random') throw new Error('No draw pending');
  return system(state, {
    kind: 'system',
    type: 'CARD_DEALT',
    deck: String(pending.request.deck),
    seat,
    slotId: String(pending.request.slotId),
    card,
  });
};

const drawer = (state: GameState): unknown => {
  const pending = engine.getPending(state).find((item) => item.kind === 'random');
  return pending?.kind === 'random' ? pending.request.seat : undefined;
};

describe('progress card draws', () => {
  test('a gate face draws for every seat at level L with a red die of at most L + 1', () => {
    const rolled = roll(start(), [1, 4], 'science');
    // Seats 0 and 1 draw, in turn order from the active seat; seat 2 has no improvement.
    expect(top(rolled)).toMatchObject({
      module: 'base',
      id: 'drawDev',
      data: { seat: 0, deck: 'progress-science' },
    });
    const first = deal(rolled, 0, 'crane');
    expect(drawer(first)).toBe(1);
    const second = deal(first, 1, 'smith');
    // The two drawers now show a victory card or say they drew none.
    expect(top(second)).toMatchObject({ module: 'knights', id: 'progress' });
    expect(top(checked(second))?.id).toBe('main');
    expect(held(second, 0)).toEqual([undefined]);
    expect(second.decks['progress-science']).toMatchObject({ remaining: 16 });
    expect(held(checked(second), 1)).toEqual([undefined]);
  });

  test('turn order starts with the active seat', () => {
    const rolled = roll(start(1), [2, 3], 'science');
    expect(drawer(rolled)).toBe(1);
    expect(drawer(deal(rolled, 1, 'crane'))).toBe(0);
  });

  test('a higher red die draws only for the higher levels', () => {
    // Red 3: level 1 needs 2 or less, level 2 needs 3 or less.
    const three = roll(start(), [3, 4], 'science');
    expect(drawer(three)).toBe(1);
    expect(top(checked(deal(three, 1, 'crane')))?.id).toBe('main');
    const five = roll(start(), [4, 3], 'science');
    expect(top(five)?.id).toBe('main');
    const maxed = roll(withLevels(start(), 2, { science: 5 }), [6, 1], 'science');
    expect(drawer(maxed)).toBe(2);
  });

  test('the colour of the gate names the deck, and a seat draws only from its own track', () => {
    const state = withLevels(start(), 2, { trade: 1, politics: 2 });
    const trade = roll(state, [1, 5], 'trade');
    expect(top(trade)).toMatchObject({ data: { seat: 2, deck: 'progress-trade' } });
    const politics = roll(state, [1, 2], 'politics');
    expect(top(politics)).toMatchObject({ data: { seat: 2, deck: 'progress-politics' } });
    // A ship draws nothing.
    expect(top(roll(state, [1, 2], 'ship'))?.id).toBe('main');
    // Seat 2 is not at level 1 on the science track.
    expect(top(roll(state, [1, 2], 'science'))).toMatchObject({ data: { seat: 0 } });
  });

  test('production waits for the draws and then pays as usual', () => {
    const base = start();
    const forest = hexOf(base, 'forest');
    let state = withTokens(base, { [forest]: 6 });
    state = withBuildings(state, [{ vertex: verticesOfHex(state, forest)[0] ?? '', seat: 2 }]);
    state = withHand(state, 2, {});
    const rolled = roll(state, [1, 5], 'science');
    expect(handOf(rolled, 2).lumber).toBe(0);
    const done = checked(deal(deal(rolled, 0, 'crane'), 1, 'smith'));
    expect(top(done)?.id).toBe('main');
    expect(handOf(done, 2).lumber).toBe(1);
  });

  test('a 7 is resolved after the draws: discards and the robber step follow', () => {
    const rolled = roll(withHand(start(), 2, { wool: 8 }), [1, 6], 'science');
    const done = checked(deal(deal(rolled, 0, 'crane'), 1, 'smith'));
    expect(top(done)?.id).toBe('discard');
  });

  test('an emptied hidden deck deals its returned cards in the order they came back', () => {
    const queued = updateKnights(start(), (old) => ({
      ...old,
      bottom: { ...old.bottom, science: ['crane', 'smith'] },
    }));
    const empty = {
      ...queued,
      decks: { ...queued.decks, 'progress-science': { remaining: 0, drawn: [] } },
    };
    const rolled = roll(empty, [1, 4], 'science');
    expect(top(rolled)).toMatchObject({
      module: 'knights',
      id: 'progressDeal',
      data: { seat: 0, card: 'crane' },
    });
    const pending = engine.getPending(rolled).find((item) => item.kind === 'reveal');
    expect(pending).toMatchObject({ seat: 0, systemType: 'DEAL_KNOWN' });
    const result = engine.apply(rolled, {
      kind: 'system',
      type: 'DEAL_KNOWN',
      seat: 0,
      deck: 'progress-science',
      slotId: frameSlot(rolled),
      card: 'crane',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.effects).toEqual([
      expect.objectContaining({ type: 'card-slot-known', seat: 0, card: 'crane' }),
    ]);
    const next = result.value.state;
    expect(held(next, 0)).toEqual(['crane']);
    expect(knightsExt(next).bottom.science).toEqual(['smith']);
    expect(top(next)).toMatchObject({ id: 'progressDeal', data: { seat: 1, card: 'smith' } });
  });

  test('a deal that differs from the returned card is refused', () => {
    const queued = updateKnights(start(), (old) => ({
      ...old,
      bottom: { ...old.bottom, science: ['crane'] },
    }));
    const empty = {
      ...queued,
      decks: { ...queued.decks, 'progress-science': { remaining: 0, drawn: [] } },
    };
    const rolled = roll(empty, [1, 4], 'science');
    const slotId = frameSlot(rolled);
    const base = {
      kind: 'system' as const,
      type: 'DEAL_KNOWN',
      seat: 0,
      deck: 'progress-science',
      slotId,
    };
    expect(systemRefusal(rolled, { ...base, card: 'smith' })).toBe('deal-mismatch');
    expect(systemRefusal(rolled, { ...base, seat: 1, card: 'crane' })).toBe('not-pending');
    expect(systemRefusal(rolled, { ...base, card: 'crane' })).toBeNull();
  });

  test('with nothing left in a deck nobody draws and the roll goes on', () => {
    const empty = {
      ...start(),
      decks: { ...start().decks, 'progress-science': { remaining: 0, drawn: [] } },
    };
    expect(top(roll(empty, [1, 4], 'science'))?.id).toBe('main');
  });

  test('a short deck serves the seats in order until it is empty', () => {
    const short = {
      ...start(),
      decks: { ...start().decks, 'progress-science': { remaining: 1, drawn: [] } },
    };
    const rolled = roll(short, [1, 4], 'science');
    expect(drawer(rolled)).toBe(0);
    expect(top(checked(deal(rolled, 0, 'crane')))?.id).toBe('main');
  });
});

describe('victory cards', () => {
  test('a drawn victory card is shown at once and counts as a point', () => {
    const rolled = roll(start(), [1, 5], 'science');
    const dealt = deal(deal(rolled, 0, 'printer'), 1, 'crane');
    // Both drawers are asked, in parallel, once the draws are over.
    const asked = engine
      .getPending(dealt)
      .flatMap((item) => (item.kind === 'reveal' ? [item.seat] : []));
    expect(asked).toEqual([0, 1]);
    const slotId = (item: number) =>
      engine
        .getPending(dealt)
        .flatMap((p) =>
          p.kind === 'reveal' && p.seat === item ? [String(p.request.slotId)] : [],
        )[0] ?? '';
    const one = system(dealt, {
      kind: 'system',
      type: 'REVEAL_PROGRESS',
      seat: 0,
      slotId: slotId(0),
      card: 'printer',
    });
    expect(one.seats[0]?.publicVp).toBe(1);
    expect(held(one, 0)).toEqual([]);
    expect(knightsExt(one).bottom.science).toEqual([]);
    const two = system(one, {
      kind: 'system',
      type: 'REVEAL_PROGRESS',
      seat: 1,
      slotId: slotId(1),
      card: 'none',
    });
    expect(top(two)?.id).toBe('main');
    expect(held(two, 1)).toEqual([undefined]);
  });

  test('a drawer can only show its deck’s victory card, and only for a slot it drew', () => {
    const dealt = deal(deal(roll(start(), [1, 5], 'science'), 0, 'printer'), 1, 'crane');
    const slotId = String(
      engine
        .getPending(dealt)
        .flatMap((p) => (p.kind === 'reveal' && p.seat === 0 ? [p.request.slotId] : []))[0],
    );
    const input = { kind: 'system' as const, type: 'REVEAL_PROGRESS', seat: 0, slotId };
    expect(systemRefusal(dealt, { ...input, card: 'constitution' })).toBe('invalid-victory-card');
    expect(systemRefusal(dealt, { ...input, card: 'crane' })).toBe('invalid-victory-card');
    expect(systemRefusal(dealt, { ...input, slotId: 'progress:99', card: 'none' })).toBe(
      'no-victory-check',
    );
    expect(systemRefusal(dealt, { ...input, seat: 2, card: 'none' })).toBe('not-pending');
  });

  test('a drawer who hides its victory card is caught by its own hand', () => {
    const dealt = deal(
      roll(withLevels(start(), 1, { science: 0 }), [1, 5], 'science'),
      0,
      'printer',
    );
    expect(top(dealt)).toMatchObject({ module: 'knights', id: 'progress' });
    const slotId = String(
      engine.getPending(dealt).flatMap((p) => (p.kind === 'reveal' ? [p.request.slotId] : []))[0],
    );
    const owner = privateOf(engine, dealt, 0, {}, { [slotId]: 'printer' });
    const hide = {
      kind: 'system' as const,
      type: 'REVEAL_PROGRESS',
      seat: 0,
      slotId,
      card: 'none',
    };
    expect(engine.applyPrivate(owner, dealt, hide).ok).toBe(false);
    const show = engine.applyPrivate(owner, dealt, { ...hide, card: 'printer' });
    expect(show.ok && show.value.slots).toEqual({});
    const honest = privateOf(engine, dealt, 0, {}, { [slotId]: 'crane' });
    expect(engine.applyPrivate(honest, dealt, hide).ok).toBe(true);
    expect(engine.applyPrivate(honest, dealt, { ...hide, card: 'printer' }).ok).toBe(false);
  });

  test('a deck asks only while its victory card is unseen; the trade deck never asks', () => {
    const dealt = deal(deal(roll(start(), [1, 5], 'science'), 0, 'crane'), 1, 'smith');
    const asked = engine
      .getPending(dealt)
      .flatMap((p) => (p.kind === 'reveal' ? [String(p.request.slotId)] : []));
    expect(asked).toEqual(['progress:0', 'progress:1']);
    // Once the Printer is on the table, later science draws are not checked.
    const shown: GameState = {
      ...start(),
      seats: start().seats.map((seat) =>
        seat.seat === 2
          ? {
              ...seat,
              cardSlots: [
                { slotId: 'x', deck: 'progress-science', acquiredTurn: 1, revealed: 'printer' },
              ],
            }
          : seat,
      ),
      decks: {
        ...start().decks,
        'progress-science': { remaining: 17, drawn: [{ slotId: 'x', seat: 2 }] },
      },
    };
    const after = deal(deal(roll(shown, [1, 5], 'science'), 0, 'crane'), 1, 'smith');
    expect(top(after)?.id).toBe('main');
    expect(engine.getPending(after).some((p) => p.kind === 'reveal')).toBe(false);
    const trade = deal(roll(withLevels(start(), 0, { trade: 1 }), [1, 5], 'trade'), 0, 'merchant');
    expect(top(trade)?.id).toBe('main');
  });

  test('a shown victory card is worth a point and never counts toward the limit', () => {
    const { state } = scene();
    const holder = withCards(state, 0, 'crane', 'crane', 'smith', 'medicine');
    const shownState = {
      ...holder,
      seats: holder.seats.map((seat) =>
        seat.seat === 0
          ? {
              ...seat,
              cardSlots: [
                ...seat.cardSlots,
                { slotId: 'v', deck: 'progress-science', acquiredTurn: 1, revealed: 'printer' },
              ],
            }
          : seat,
      ),
    };
    expect(
      engine.hooks
        .victoryPoints(shownState, 0, undefined, [])
        .map((item) => [item.source, item.points]),
    ).toEqual([['progress', 1]]);
    expect(held(shownState, 0)).toHaveLength(4);
  });
});

/** Seat 1 holds four cards and draws a fifth; seat 0 rolls. */
function crowded(): GameState {
  return withCards(start(), 1, 'crane', 'engineer', 'smith', 'medicine');
}

describe('the progress card limit', () => {
  test('an off-turn seat over the limit discards at once, before production', () => {
    const base = crowded();
    const forest = hexOf(base, 'forest');
    let state = withTokens(base, { [forest]: 6 });
    state = withBuildings(state, [{ vertex: verticesOfHex(state, forest)[0] ?? '', seat: 2 }]);
    state = withHand(state, 2, {});
    const drawn = checked(deal(deal(roll(state, [1, 5], 'science'), 0, 'crane'), 1, 'mining'));
    expect(top(drawn)).toMatchObject({ module: 'knights', id: 'progress' });
    // The discard is the only thing pending, and production has not happened.
    expect(handOf(drawn, 2).lumber).toBe(0);
    const pending = engine
      .getPending(drawn)
      .filter((item) => item.kind === 'player' && item.allowed.includes('DISCARD_PROGRESS'));
    expect(pending.map((item) => (item.kind === 'player' ? item.seat : -1))).toEqual([1]);
    const slots = drawn.seats[1]?.cardSlots.map((slot) => slot.slotId) ?? [];
    expect(slots).toHaveLength(5);
    // A discard of the wrong size, or of a card the seat does not hold, is refused.
    expect(rejection(engine, drawn, 1, { type: 'DISCARD_PROGRESS', cards: [] })).not.toBeNull();
    expect(
      rejection(engine, drawn, 1, {
        type: 'DISCARD_PROGRESS',
        cards: [
          { slotId: slots[0], card: 'crane' },
          { slotId: slots[1], card: 'engineer' },
        ],
      }),
    ).toBe('wrong-discard-count');
    expect(
      rejection(engine, drawn, 1, {
        type: 'DISCARD_PROGRESS',
        cards: [{ slotId: 'progress:404', card: 'crane' }],
      }),
    ).toBe('invalid-slot');
    expect(
      rejection(engine, drawn, 1, {
        type: 'DISCARD_PROGRESS',
        cards: [{ slotId: slots[0], card: 'smith' }],
      }),
    ).toBe('card-mismatch');
    const done = submit(engine, drawn, 1, {
      type: 'DISCARD_PROGRESS',
      cards: [{ slotId: slots[0], card: 'crane' }],
    });
    expect(top(done)?.id).toBe('main');
    expect(handOf(done, 2).lumber).toBe(1);
    // The card is shown and goes under its deck.
    expect(knightsExt(done).bottom.science).toEqual(['crane']);
    expect(held(done, 1)).toHaveLength(4);
    expect(engine.checkInvariants(done)).toEqual([]);
  });

  test('the newly drawn card may be the one discarded, and a hidden hand lists its own discards', () => {
    const drawn = checked(deal(deal(roll(crowded(), [1, 5], 'science'), 0, 'crane'), 1, 'mining'));
    const newest = drawn.seats[1]?.cardSlots.at(-1)?.slotId ?? '';
    const done = submit(engine, drawn, 1, {
      type: 'DISCARD_PROGRESS',
      cards: [{ slotId: newest, card: 'mining' }],
    });
    expect(knightsExt(done).bottom.science).toEqual(['mining']);
    expect(held(done, 1)).toEqual(['crane', 'engineer', 'smith', 'medicine']);
    // Without the private identity of the new card a seat is offered a template, with it commands.
    expect(engine.getLegalCommands(drawn, 1).templates.map((item) => item.type)).toEqual([
      'DISCARD_PROGRESS',
    ]);
    const owner = privateOf(engine, drawn, 1, {}, { [newest]: 'mining' });
    const own = engine.getLegalCommands(drawn, 1, owner).commands;
    expect(own).toHaveLength(5);
    expect(own.every((item) => item.type === 'DISCARD_PROGRESS')).toBe(true);
  });

  test('the active seat may go over the limit and must discard before ending its turn', () => {
    const { state } = scene();
    const five = withCards(state, 0, 'crane', 'engineer', 'smith', 'medicine', 'mining');
    const pending = engine
      .getPending(five)
      .find((item) => item.kind === 'player' && item.seat === 0);
    expect(pending?.kind === 'player' && pending.allowed).not.toContain('END_TURN');
    expect(pending?.kind === 'player' && pending.allowed).toContain('DISCARD_PROGRESS');
    expect(rejection(engine, five, 0, { type: 'END_TURN' })).toBe('not-pending');
    // The timeout of the main phase cannot end the turn either.
    expect(systemRefusal(five, { kind: 'system', type: 'TIMEOUT', seat: 0, phase: 'main' })).toBe(
      'turn-end-blocked',
    );
    const slot = five.seats[0]?.cardSlots[0]?.slotId ?? '';
    const done = submit(engine, five, 0, {
      type: 'DISCARD_PROGRESS',
      cards: [{ slotId: slot, card: 'crane' }],
    });
    expect(rejection(engine, done, 0, { type: 'END_TURN' })).toBeNull();
    // At the limit nothing more may be discarded.
    const again = held(done, 0);
    expect(again).toHaveLength(4);
    expect(
      rejection(engine, done, 0, {
        type: 'DISCARD_PROGRESS',
        cards: [{ slotId: done.seats[0]?.cardSlots[1]?.slotId, card: 'engineer' }],
      }),
    ).toBe('not-pending');
  });

  test('the discards are listed for a seat over the limit', () => {
    const { state } = scene();
    const five = withCards(state, 0, 'crane', 'engineer', 'smith', 'medicine', 'mining');
    const legal = engine.getLegalCommands(five, 0).commands;
    expect(legal.filter((item) => item.type === 'DISCARD_PROGRESS')).toHaveLength(5);
    expect(legal.some((item) => item.type === 'END_TURN')).toBe(false);
  });
});

/** Two seats tie for the top contribution with the barbarians one step from landing. */
function tie(): GameState {
  const base = newGame(engine, { seats: 3 });
  const { ring, out } = ringLayout(base);
  let state = withBuildings(base, [
    { vertex: at(out, 0), seat: 0, kind: 'city' },
    { vertex: at(out, 2), seat: 1, kind: 'city' },
  ]);
  state = withKnights(state, [
    { seat: 0, vertex: at(ring, 0), level: 2 },
    { seat: 1, vertex: at(ring, 3), level: 2 },
  ]);
  return withStep(inDice(withTokens(state, {})), 6);
}

describe('defender ties', () => {
  test('each tied seat picks a deck in turn order and draws from it', () => {
    const attacked = roll(tie(), [1, 2], 'ship');
    expect(knightsExt(attacked).lastAttack?.tied).toEqual([0, 1]);
    expect(top(attacked)).toMatchObject({ module: 'knights', id: 'progress' });
    const pending = engine
      .getPending(attacked)
      .filter((item) => item.kind === 'player' && item.allowed.includes('CHOOSE_PROGRESS_DECK'));
    expect(pending.map((item) => (item.kind === 'player' ? item.seat : -1))).toEqual([0]);
    expect(engine.getLegalCommands(attacked, 0).commands.map((item) => item.deck)).toEqual([
      'trade',
      'politics',
      'science',
    ]);
    expect(rejection(engine, attacked, 1, { type: 'CHOOSE_PROGRESS_DECK', deck: 'trade' })).toBe(
      'not-pending',
    );
    expect(rejection(engine, attacked, 0, { type: 'CHOOSE_PROGRESS_DECK', deck: 'moon' })).toBe(
      'invalid-deck',
    );
    const one = submit(engine, attacked, 0, { type: 'CHOOSE_PROGRESS_DECK', deck: 'politics' });
    expect(top(one)).toMatchObject({ id: 'drawDev', data: { seat: 0, deck: 'progress-politics' } });
    const dealt = deal(one, 0, 'spy');
    // The second seat chooses only after the first has drawn, and may take another deck.
    const asked = engine
      .getPending(dealt)
      .flatMap((item) =>
        item.kind === 'player' && item.allowed.includes('CHOOSE_PROGRESS_DECK') ? [item.seat] : [],
      );
    expect(asked).toEqual([1]);
    const two = submit(engine, dealt, 1, { type: 'CHOOSE_PROGRESS_DECK', deck: 'science' });
    const done = checked(deal(two, 1, 'crane'));
    expect(top(done)?.id).toBe('main');
    expect(held(done, 0)).toHaveLength(1);
    expect(held(done, 1)).toHaveLength(1);
  });

  test('a deck with no card cannot be picked, and an only choice is taken for the seat', () => {
    const state = tie();
    const drained = {
      ...state,
      decks: {
        ...state.decks,
        'progress-trade': { remaining: 0, drawn: [] },
        'progress-politics': { remaining: 0, drawn: [] },
      },
    };
    const attacked = roll(drained, [1, 2], 'ship');
    // Only science is left, so the first seat draws from it without being asked.
    expect(top(attacked)).toMatchObject({
      id: 'drawDev',
      data: { deck: 'progress-science', seat: 0 },
    });
    const empty = {
      ...drained,
      decks: { ...drained.decks, 'progress-science': { remaining: 0, drawn: [] } },
    };
    expect(top(roll(empty, [1, 2], 'ship'))?.id).toBe('main');
  });

  test('a timeout picks the first deck, in the order science, trade, politics, that has cards', () => {
    const attacked = roll(tie(), [1, 2], 'ship');
    const timed = system(attacked, { kind: 'system', type: 'TIMEOUT', seat: 0, phase: 'progress' });
    expect(top(timed)).toMatchObject({ id: 'drawDev', data: { deck: 'progress-science' } });
  });
});
