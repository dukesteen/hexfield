import { buildBoardGraph } from '@cp2p/engine/geometry';
import type { BoardGraph } from '@cp2p/engine/geometry';
import type { EngineEffect, GameEvent, GameState, Seat, Transition } from '@cp2p/engine';

export type ReplayMarkerKind = 'build' | 'award' | 'robber' | 'swing';

/** A notable moment; `position` is the input count after which it is visible. */
export interface ReplayMarker {
  readonly position: number;
  readonly kind: ReplayMarkerKind;
  readonly seat: Seat | null;
  /** The event type, or the award name for an award. */
  readonly detail: string;
}

export interface ReplayTimeline {
  readonly markers: readonly ReplayMarker[];
  /** Positions right after a 7 was rolled. */
  readonly sevens: readonly number[];
  /** The first position of each turn number, in order. */
  readonly turnStarts: readonly { readonly turn: number; readonly position: number }[];
  /** The turn number shown at each position (0..length). */
  readonly turnAt: readonly number[];
}

export interface SeatTrades {
  /** Player-to-player trades this seat took part in. */
  readonly playerTrades: number;
  readonly maritimeTrades: number;
  /** Cards handed over and received in both kinds of trade. */
  readonly given: number;
  readonly received: number;
  /** Robber steals this seat made, and suffered. */
  readonly steals: number;
  readonly stolenFrom: number;
}

export interface ReplayStats {
  readonly seats: readonly Seat[];
  /**
   * Cumulative cards each seat gained from the bank outside trades (production, gold, and
   * commodities count, as do Year of Plenty and similar), sampled at each turn start and at
   * the end. `totals` is aligned with `seats`.
   */
  readonly gains: readonly {
    readonly turn: number;
    readonly position: number;
    readonly totals: readonly number[];
  }[];
  /** Counts of the dice totals 2..12, index 0 being a 2. */
  readonly dice: readonly number[];
  /** Cards the robber kept from each seat on rolls of its hex's number. */
  readonly robberBlocked: readonly number[];
  readonly trades: readonly SeatTrades[];
}

/** The chance of each 2d6 total, 2..12. */
export const DICE_PROBABILITY: readonly number[] = [1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1].map(
  (ways) => ways / 36,
);

const BUILD_EVENTS = new Set(['settlementBuilt', 'cityBuilt', 'metropolisPlaced']);
const ROBBER_EVENTS = new Set(['robberMoved', 'pirateMoved']);
const SWING_MARKERS = 5;
const MIN_SWING = 2;

function isSeat(value: unknown): value is Seat {
  return value === 0 || value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

function seatOf(event: GameEvent): Seat | null {
  const seat: unknown = Reflect.get(event, 'seat');
  return isSeat(seat) ? seat : null;
}

function isTrade(events: readonly GameEvent[]): 'player' | 'maritime' | null {
  if (events.some((event) => event.type === 'tradeConfirmed')) return 'player';
  if (events.some((event) => event.type === 'maritimeTrade')) return 'maritime';
  return null;
}

/** Folds each transition into timeline markers and statistics, public facts only. */
export class ReplayAnalyser {
  private readonly seats: readonly Seat[];
  private readonly markers: ReplayMarker[] = [];
  private readonly swings: { position: number; size: number }[] = [];
  private readonly sevens: number[] = [];
  private readonly turnStarts: { turn: number; position: number }[] = [];
  private readonly turnAt: number[] = [];
  private readonly gained: number[];
  private readonly gains: { turn: number; position: number; totals: number[] }[] = [];
  private readonly dice = Array<number>(11).fill(0);
  private readonly blocked: number[];
  private readonly trades: {
    playerTrades: number;
    maritimeTrades: number;
    given: number;
    received: number;
    steals: number;
    stolenFrom: number;
  }[];
  private graph: { hexes: GameState['board']['hexes']; graph: BoardGraph } | null = null;

  constructor(initial: GameState) {
    this.seats = initial.config.seats;
    this.gained = this.seats.map(() => 0);
    this.blocked = this.seats.map(() => 0);
    this.trades = this.seats.map(() => ({
      playerTrades: 0,
      maritimeTrades: 0,
      given: 0,
      received: 0,
      steals: 0,
      stolenFrom: 0,
    }));
    this.turnAt.push(initial.turn.number);
    this.turnStarts.push({ turn: initial.turn.number, position: 0 });
    this.gains.push({ turn: initial.turn.number, position: 0, totals: [...this.gained] });
  }

  private index(seat: Seat): number {
    return this.seats.indexOf(seat);
  }

  /** Record the transition from `before` that produced position `position`. */
  step(before: GameState, transition: Transition, position: number): void {
    const after = transition.state;
    const trade = isTrade(transition.events);
    this.countEffects(transition.effects, trade);
    for (const event of transition.events) {
      const seat = seatOf(event);
      if (BUILD_EVENTS.has(event.type))
        this.markers.push({ position, kind: 'build', seat, detail: event.type });
      else if (ROBBER_EVENTS.has(event.type))
        this.markers.push({ position, kind: 'robber', seat, detail: event.type });
      else if (event.type === 'maritimeTrade' && seat !== null) {
        const item = this.trades[this.index(seat)];
        if (item) item.maritimeTrades += 1;
      } else if (event.type === 'resourceStolen') {
        const thiefSeat: unknown = Reflect.get(event, 'thief');
        const victimSeat: unknown = Reflect.get(event, 'victim');
        const thief = isSeat(thiefSeat) ? this.trades[this.index(thiefSeat)] : null;
        const victim = isSeat(victimSeat) ? this.trades[this.index(victimSeat)] : null;
        if (thief) thief.steals += 1;
        if (victim) victim.stolenFrom += 1;
      } else if (event.type === 'diceRolled' && typeof event.roll === 'number') {
        const roll = event.roll;
        if (roll >= 2 && roll <= 12) this.dice[roll - 2] = (this.dice[roll - 2] ?? 0) + 1;
        if (roll === 7) this.sevens.push(position);
        else this.countBlocked(before, roll);
      }
    }
    for (const [award, holder] of Object.entries(after.awards))
      if ((before.awards[award] ?? null) !== holder)
        this.markers.push({ position, kind: 'award', seat: holder, detail: award });
    let swing = 0;
    for (const seat of after.seats) {
      const previous = before.seats.find((item) => item.seat === seat.seat)?.publicVp ?? 0;
      swing += Math.abs(seat.publicVp - previous);
    }
    if (swing >= MIN_SWING) this.swings.push({ position, size: swing });
    if (after.turn.number !== before.turn.number) {
      this.turnStarts.push({ turn: after.turn.number, position });
      this.gains.push({ turn: after.turn.number, position, totals: [...this.gained] });
    }
    this.turnAt.push(after.turn.number);
  }

  private countEffects(
    effects: readonly EngineEffect[],
    trade: 'player' | 'maritime' | null,
  ): void {
    const traders = new Set<number>();
    for (const effect of effects) {
      if (effect.type !== 'resource-transfer') continue;
      const { from, to, count } = effect;
      if (trade) {
        if (from.kind === 'seat') {
          const item = this.trades[this.index(from.seat)];
          if (item) item.given += count;
          traders.add(this.index(from.seat));
        }
        if (to.kind === 'seat') {
          const item = this.trades[this.index(to.seat)];
          if (item) item.received += count;
          traders.add(this.index(to.seat));
        }
        continue;
      }
      if (from.kind === 'bank' && to.kind === 'seat') {
        const at = this.index(to.seat);
        if (at >= 0) this.gained[at] = (this.gained[at] ?? 0) + count;
      }
    }
    if (trade === 'player')
      for (const at of traders) {
        const item = this.trades[at];
        if (item) item.playerTrades += 1;
      }
  }

  /** The cards the robber's hex would have produced on this roll. */
  private countBlocked(state: GameState, roll: number): void {
    const robber = state.board.robberHex;
    if (!robber) return;
    const hex = state.board.hexes.find((item) => item.id === robber);
    if (!hex || hex.token !== roll) return;
    if (this.graph?.hexes !== state.board.hexes)
      this.graph = { hexes: state.board.hexes, graph: buildBoardGraph(state.board.hexes) };
    const { graph } = this.graph;
    const corners = new Set<string>(graph.hexVertices[graph.hexIndex[robber] ?? -1] ?? []);
    for (const building of state.board.buildings) {
      if (!corners.has(building.vertex)) continue;
      const at = this.index(building.seat);
      if (at >= 0)
        this.blocked[at] = (this.blocked[at] ?? 0) + (building.kind === 'settlement' ? 1 : 2);
    }
  }

  finish(final: GameState): { timeline: ReplayTimeline; stats: ReplayStats } {
    const position = this.turnAt.length - 1;
    if (this.gains.at(-1)?.position !== position)
      this.gains.push({ turn: final.turn.number, position, totals: [...this.gained] });
    const swings = this.swings
      .toSorted((a, b) => b.size - a.size || a.position - b.position)
      .slice(0, SWING_MARKERS)
      .map((item): ReplayMarker => ({
        position: item.position,
        kind: 'swing',
        seat: null,
        detail: String(item.size),
      }));
    return {
      timeline: {
        markers: [...this.markers, ...swings].toSorted((a, b) => a.position - b.position),
        sevens: this.sevens,
        turnStarts: this.turnStarts,
        turnAt: this.turnAt,
      },
      stats: {
        seats: this.seats,
        gains: this.gains,
        dice: this.dice,
        robberBlocked: this.blocked,
        trades: this.trades,
      },
    };
  }
}
