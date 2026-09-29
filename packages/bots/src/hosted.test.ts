import { describe, expect, test } from 'vitest';
import { createBaseEngine, exactResourceBounds } from '@cp2p/engine';
import type { CommandShape, GameState, Pending, PrivateState, Seat } from '@cp2p/engine';
import { decideHosted, hostedTradeCommand } from './hosted.js';
import { RandomBot } from './random-bot.js';

const engine = createBaseEngine();
type Hand = Record<'brick' | 'lumber' | 'wool' | 'grain' | 'ore', number>;
const hand = (cards: Partial<Hand>): Hand => ({
  brick: 0,
  lumber: 0,
  wool: 0,
  grain: 0,
  ore: 0,
  ...cards,
});

/** Seat 0's main phase, with every seat's hand public and private alike. */
function mainGame(hands: Partial<Record<Seat, Hand>>): GameState {
  const created = engine.createGame(
    {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1, 2],
      options: { base: { mapLayout: 'random' } },
    },
    new Uint8Array(32),
  );
  return {
    ...created,
    turn: {
      ...created.turn,
      number: 3,
      activeSeat: 0,
      phase: [{ module: 'base', id: 'main', data: null }],
    },
    seats: created.seats.map((holder) => {
      const bounds = exactResourceBounds(hands[holder.seat] ?? hand({}));
      if (!bounds.ok) throw new Error(bounds.error.message);
      return { ...holder, resources: bounds.value };
    }),
  };
}

function view(state: GameState, seat: Seat, cards: Hand) {
  const priv: PrivateState = { ...engine.createPrivateState(seat), hand: cards };
  return { state, seat, priv };
}

function pendingFor(state: GameState, seat: Seat): Pending {
  const found = engine
    .getPending(state)
    .find((item) => item.kind === 'player' && item.seat === seat);
  if (!found) throw new Error(`No pending for seat ${seat}`);
  return found;
}

function play(state: GameState, seat: Seat, command: CommandShape): GameState {
  const applied = engine.apply(state, { kind: 'command', seat, command });
  if (!applied.ok) throw new Error(applied.error.message);
  return applied.value.state;
}

// With no pieces on the board every bot saves for a road: one brick and one lumber.
const hands = {
  0: hand({ brick: 2 }),
  1: hand({ lumber: 2 }),
  2: hand({ lumber: 1 }),
};
const offer = { type: 'OFFER_TRADE', give: { brick: 1 }, want: { lumber: 1 } };

describe('hosted bot trade manners', () => {
  test('answers an offer on its merits: it needs what it gets and keeps what it builds with', () => {
    const offered = play(mainGame(hands), 0, offer);
    expect(hostedTradeCommand(view(offered, 1, hands[1]), pendingFor(offered, 1), engine)).toEqual({
      type: 'RESPOND_TRADE',
      offerId: 0,
      accept: true,
    });
    // Its last lumber is part of its road, so seat 2 turns the same offer down.
    expect(hostedTradeCommand(view(offered, 2, hands[2]), pendingFor(offered, 2), engine)).toEqual({
      type: 'RESPOND_TRADE',
      offerId: 0,
      accept: false,
    });
  });

  test('an offering bot trades with the first seat that accepted', () => {
    let state = play(mainGame(hands), 0, offer);
    state = play(state, 2, { type: 'RESPOND_TRADE', offerId: 0, accept: true });
    state = play(state, 1, { type: 'RESPOND_TRADE', offerId: 0, accept: true });
    const command = hostedTradeCommand(view(state, 0, hands[0]), pendingFor(state, 0), engine);
    expect(command).toEqual({ type: 'CONFIRM_TRADE', offerId: 0, withSeat: 1 });
    if (!command) throw new Error('No settlement');
    const traded = play(state, 0, command);
    expect(traded.ext.base).toMatchObject({ offers: [] });
  });

  test('an offering bot withdraws an offer nobody accepted, even with a reply still owed', () => {
    let state = play(mainGame(hands), 0, offer);
    state = play(state, 2, { type: 'RESPOND_TRADE', offerId: 0, accept: false });
    // Seat 1 has not answered: the scheduler only asks once its patience has run out.
    expect(hostedTradeCommand(view(state, 0, hands[0]), pendingFor(state, 0), engine)).toEqual({
      type: 'CANCEL_TRADE',
      offerId: 0,
    });
  });

  test('the active bot takes a counter-offer it wants and turns down one it does not', () => {
    const good = play(mainGame(hands), 1, {
      type: 'PROPOSE_TRADE',
      give: { lumber: 1 },
      want: { brick: 1 },
    });
    expect(hostedTradeCommand(view(good, 0, hands[0]), pendingFor(good, 0), engine)).toEqual({
      type: 'CONFIRM_TRADE',
      offerId: 0,
      withSeat: 1,
    });
    const greedy = play(mainGame(hands), 1, {
      type: 'PROPOSE_TRADE',
      give: { lumber: 1 },
      want: { brick: 2 },
    });
    expect(hostedTradeCommand(view(greedy, 0, hands[0]), pendingFor(greedy, 0), engine)).toEqual({
      type: 'CANCEL_TRADE',
      offerId: 0,
    });
  });

  test('without a trade to settle the bot plays its own policy', () => {
    const state = mainGame(hands);
    expect(hostedTradeCommand(view(state, 0, hands[0]), pendingFor(state, 0), engine)).toBeNull();
    const command = decideHosted(
      new RandomBot(engine),
      view(state, 0, hands[0]),
      pendingFor(state, 0),
      { int: () => 0 },
      engine,
    );
    expect(engine.validate(state, { kind: 'command', seat: 0, command }).ok).toBe(true);
  });
});
