import { describe, expect, test } from 'vitest';
import { RESOURCES, exactResourceBounds } from '@cp2p/engine';
import type { GameState, PrivateState, Resource, Seat } from '@cp2p/engine';
import { standardFixedBoard } from '@cp2p/maps';
import { LocalSession } from './local-session.js';
import type { SessionScheduler } from './types.js';

class Clock implements SessionScheduler {
  time = 1_700_000_000_000;
  private nextId = 0;
  private jobs = new Map<number, { at: number; callback: () => void }>();
  now(): number {
    return this.time;
  }
  setTimeout(callback: () => void, delay: number): unknown {
    const id = ++this.nextId;
    this.jobs.set(id, { at: this.time + delay, callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.jobs.delete(handle);
  }
  /** Runs every job due within `ms`, including ones those jobs schedule. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (let step = 0; step < 1000; step++) {
      const next = [...this.jobs].toSorted((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > end) break;
      this.jobs.delete(next[0]);
      this.time = next[1].at;
      next[1].callback();
    }
    this.time = end;
  }
}

type Hand = Record<Resource, number>;
const hand = (cards: Partial<Hand>): Hand => ({
  brick: 0,
  lumber: 0,
  wool: 0,
  grain: 0,
  ore: 0,
  ...cards,
});

/**
 * Seat 0 is the person; bots hold seats 1 and 2. The game jumps to `active`'s main phase with
 * fixed hands, so every bot saves for a road (one brick and one lumber).
 */
function tradeTable(active: Seat, hands: Partial<Record<Seat, Hand>>) {
  const clock = new Clock();
  const made = LocalSession.create({
    config: {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1, 2],
      options: { base: { mapLayout: 'standard-fixed', vpTarget: 10 } },
      board: standardFixedBoard(),
    },
    humanSeats: [0],
    botSeats: [1, 2],
    genesisSeed: new Uint8Array(32).fill(9),
    botDelayMs: 100,
    scheduler: clock,
  });
  if (!made.ok) throw new Error(made.error.message);
  const session = made.value;
  const before = session.getState();
  const state: GameState = {
    ...before,
    turn: {
      ...before.turn,
      number: 7,
      activeSeat: active,
      phase: [{ module: 'base', id: 'main', data: null }],
    },
    // The cards come out of the bank, so the game's card totals still add up.
    bank: {
      ...before.bank,
      ...Object.fromEntries(
        RESOURCES.map((kind) => [
          kind,
          (before.bank[kind] ?? 0) -
            Object.values(hands).reduce((sum, cards) => sum + (cards?.[kind] ?? 0), 0),
        ]),
      ),
    },
    seats: before.seats.map((holder) => {
      const bounds = exactResourceBounds(hands[holder.seat] ?? hand({}));
      if (!bounds.ok) throw new Error(bounds.error.message);
      return { ...holder, resources: bounds.value };
    }),
  };
  const privates: Record<string, PrivateState> = {};
  for (const seat of state.config.seats) {
    const priv = session.getPrivate(seat);
    if (!priv) throw new Error('Missing private state');
    privates[String(seat)] = { ...priv, hand: hands[seat] ?? hand({}) };
  }
  const replaced = session.devReplace(state, privates);
  if (!replaced.ok) throw new Error(replaced.error.message);
  return { session, clock };
}

const offers = (session: LocalSession): unknown[] => {
  const base = session.getState().ext.base;
  return typeof base === 'object' && base !== null && 'offers' in base && Array.isArray(base.offers)
    ? base.offers
    : [];
};
const types = (session: LocalSession) => session.getEvents().map((event) => event.type);

describe('trading with hosted bots', () => {
  test('a bot’s offer: the other bot answers, the person accepts, the bot trades with them', async () => {
    const hands = { 0: hand({ lumber: 2 }), 1: hand({ brick: 2 }), 2: hand({ lumber: 1 }) };
    const { session, clock } = tradeTable(1, hands);
    expect(
      session.devApply(1, { type: 'OFFER_TRADE', give: { brick: 1 }, want: { lumber: 1 } }).ok,
    ).toBe(true);
    clock.advance(100);
    // Seat 2 declines at once (its only lumber is part of its road); the offer waits for seat 0.
    expect(offers(session)).toMatchObject([{ declinedBy: [2], acceptedBy: [] }]);
    clock.advance(5_000);
    expect(offers(session)).toHaveLength(1);
    const accepted = await session.submit(0, { type: 'RESPOND_TRADE', offerId: 0, accept: true });
    expect(accepted.ok).toBe(true);
    clock.advance(100);
    expect(types(session)).toContain('tradeConfirmed');
    expect(offers(session)).toEqual([]);
    expect(session.getPrivate(0)?.hand).toMatchObject({ brick: 1, lumber: 1 });
    session.dispose();
  });

  test('a bot withdraws its offer when the person does not answer in time', () => {
    const hands = { 0: hand({ lumber: 2 }), 1: hand({ brick: 2 }), 2: hand({ lumber: 1 }) };
    const { session, clock } = tradeTable(1, hands);
    session.devApply(1, { type: 'OFFER_TRADE', give: { brick: 1 }, want: { lumber: 1 } });
    clock.advance(14_000);
    expect(offers(session)).toHaveLength(1);
    clock.advance(1_100);
    expect(types(session)).toContain('tradeCancelled');
    session.dispose();
  });

  test('the person’s offer: a bot accepts and the person confirms the trade', async () => {
    const hands = { 0: hand({ brick: 2 }), 1: hand({ lumber: 2 }), 2: hand({ lumber: 1 }) };
    const { session, clock } = tradeTable(0, hands);
    const offered = await session.submit(0, {
      type: 'OFFER_TRADE',
      give: { brick: 1 },
      want: { lumber: 1 },
    });
    expect(offered).toEqual({ ok: true });
    clock.advance(1_000);
    expect(offers(session)).toMatchObject([{ acceptedBy: [1], declinedBy: [2] }]);
    const confirm = session
      .getLegalCommands(0)
      .commands.find((command) => command.type === 'CONFIRM_TRADE');
    expect(confirm).toEqual({ type: 'CONFIRM_TRADE', offerId: 0, withSeat: 1 });
    if (!confirm) return;
    expect((await session.submit(0, confirm)).ok).toBe(true);
    expect(session.getPrivate(0)?.hand).toMatchObject({ brick: 1, lumber: 1 });
    session.dispose();
  });
});
