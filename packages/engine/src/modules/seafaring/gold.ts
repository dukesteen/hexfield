import type { CommandHandler, HandlerContext, PhaseHandler } from '../../core/modules/index.js';
import type { CommandShape } from '../../core/pipeline/index.js';
import type { GameState, PhaseFrame } from '../../core/state/index.js';
import { RESOURCES, failure, success } from '../../core/types/index.js';
import type { Resource, ResourceCounts, Seat } from '../../core/types/index.js';
import { claimCommands } from '../base/legal.js';
import { emptyResources } from '../base/constants.js';
import { hexesForVertex } from '../base/board/index.js';
import {
  countTotal,
  exchangeBank,
  parseCounts,
  playerPending,
  popPhase,
  privateExchange,
  pushPhase,
  replaceTop,
  withClaim,
} from '../base/shared.js';
import { SEAFARING_ID } from './config.js';
import type { GoldClaim, GoldFrameData } from './types.js';

export const GOLD_FRAME = 'goldChoice';

function bankTotal(state: GameState): number {
  return RESOURCES.reduce((sum, kind) => sum + (state.bank[kind] ?? 0), 0);
}

/** Each seat's total gold entitlement for a roll: 1 per settlement and 2 per city on a gold hex. */
export function goldClaims(state: GameState, roll: number): Map<Seat, number> {
  const claims = new Map<Seat, number>();
  for (const hex of state.board.hexes) {
    if (hex.terrain !== 'gold' || hex.token !== roll || hex.id === state.board.robberHex) continue;
    for (const building of state.board.buildings) {
      if (!hexesForVertex(state, building.vertex).includes(hex.id)) continue;
      claims.set(
        building.seat,
        (claims.get(building.seat) ?? 0) + (building.kind === 'city' ? 2 : 1),
      );
    }
  }
  return claims;
}

/** Seats with a claim, in turn order starting with the active seat. */
function claimQueue(state: GameState, claims: ReadonlyMap<Seat, number>): GoldClaim[] {
  const seats = state.config.seats;
  const start = Math.max(0, seats.indexOf(state.turn.activeSeat));
  return seats
    .map((_, offset) => seats[(start + offset) % seats.length])
    .flatMap((seat) => {
      const claim = seat === undefined ? 0 : (claims.get(seat) ?? 0);
      return seat !== undefined && claim > 0 ? [{ seat, claim }] : [];
    });
}

function goldData(state: GameState): GoldFrameData {
  const frame = state.turn.phase.at(-1);
  const value: unknown = frame?.data;
  if (frame?.module !== SEAFARING_ID || frame.id !== GOLD_FRAME || typeof value !== 'object')
    throw new Error('Expected a gold choice phase');
  // Only afterProduction and CHOOSE_GOLD build this phase data.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as GoldFrameData;
}

function goldFrame(queue: readonly GoldClaim[]): PhaseFrame {
  return { id: GOLD_FRAME, module: SEAFARING_ID, data: { queue: [...queue] } };
}

/** Cards the head seat must take: its claim, capped at what the bank holds. */
export function goldNeed(state: GameState): { seat: Seat; count: number } {
  const head = goldData(state).queue[0];
  if (!head) throw new Error('Empty gold queue');
  return { seat: head.seat, count: Math.min(head.claim, bankTotal(state)) };
}

/** The `afterProduction` hook: open the gold choices, if anyone has a claim and the bank has cards. */
export function openGoldChoices(state: GameState, roll: number): GameState {
  if (roll === 7 || bankTotal(state) === 0) return state;
  const queue = claimQueue(state, goldClaims(state, roll));
  return queue.length ? pushPhase(state, goldFrame(queue)) : state;
}

/** Every multiset of `count` cards the bank can pay, or a fixed sample when there are many. */
export function goldOptions(
  bank: Readonly<Record<string, number>>,
  count: number,
): ResourceCounts[] {
  const stock = RESOURCES.map((kind) => bank[kind] ?? 0);
  const all: ResourceCounts[] = [];
  const pick = (index: number, left: number, chosen: number[]): void => {
    if (all.length > 60) return;
    if (index === RESOURCES.length) {
      if (left === 0) {
        const counts = emptyResources();
        RESOURCES.forEach((kind, i) => {
          counts[kind] = chosen[i] ?? 0;
        });
        all.push(counts);
      }
      return;
    }
    for (let take = Math.min(left, stock[index] ?? 0); take >= 0; take--)
      pick(index + 1, left - take, [...chosen, take]);
  };
  pick(0, count, []);
  if (all.length <= 60) return all;
  // Too many to list: one greedy fill per starting kind.
  const sample = RESOURCES.map((_, first) => {
    const counts = emptyResources();
    let left = count;
    for (let step = 0; step < RESOURCES.length && left > 0; step++) {
      const kind = RESOURCES[(first + step) % RESOURCES.length];
      if (!kind) continue;
      const take = Math.min(left, bank[kind] ?? 0);
      counts[kind] = take;
      left -= take;
    }
    return counts;
  });
  return sample.filter(
    (item, index) => sample.findIndex((other) => sameCounts(other, item)) === index,
  );
}

function sameCounts(a: ResourceCounts, b: ResourceCounts): boolean {
  return RESOURCES.every((kind) => a[kind] === b[kind]);
}

/** The deterministic choice a timeout makes: the bank's kinds in canonical order. */
export function automaticGold(state: GameState): ResourceCounts {
  const counts = emptyResources();
  let left = goldNeed(state).count;
  for (const kind of RESOURCES) {
    const take = Math.min(left, state.bank[kind] ?? 0);
    counts[kind] = take;
    left -= take;
  }
  return counts;
}

export function goldTimeout(state: GameState, seat: Seat): CommandShape | null {
  const frame = state.turn.phase.at(-1);
  if (frame?.module !== SEAFARING_ID || frame.id !== GOLD_FRAME) return null;
  return goldNeed(state).seat === seat
    ? { type: 'CHOOSE_GOLD', resources: automaticGold(state) }
    : null;
}

export const goldChoicePhase: PhaseHandler = {
  pending: (state) => {
    const { seat } = goldNeed(state);
    return withClaim(state, [playerPending(state, seat, ['CHOOSE_GOLD'], GOLD_FRAME)]);
  },
  legalCommands: (state, _frame, seat, priv, ctx: HandlerContext) => {
    const claim = claimCommands(state, seat, priv, ctx);
    const need = goldNeed(state);
    if (need.seat !== seat) return claim;
    return {
      commands: [
        ...goldOptions(state.bank, need.count).map((resources) => ({
          type: 'CHOOSE_GOLD',
          resources,
        })),
        ...claim.commands,
      ],
      templates: claim.templates,
    };
  },
};

function parseChoice(state: GameState, value: unknown): ResourceCounts | null {
  const parsed = parseCounts(value);
  if (!parsed.ok) return null;
  const need = goldNeed(state).count;
  return countTotal(parsed.value) === need &&
    RESOURCES.every((kind: Resource) => parsed.value[kind] <= (state.bank[kind] ?? 0))
    ? parsed.value
    : null;
}

export const chooseGold: CommandHandler = {
  keys: { allowed: ['resources'] },
  validate: (state, input) => {
    if (goldNeed(state).seat !== input.seat)
      return failure('not-choosing-gold', 'It is not this seat’s gold choice');
    return parseChoice(state, input.command.resources)
      ? success(undefined)
      : failure('invalid-gold-choice', 'Choose exactly the cards the bank can pay');
  },
  apply: (state, input) => {
    const counts = parseChoice(state, input.command.resources);
    if (!counts) throw new Error('Validated gold choice missing');
    const paid = exchangeBank(state, input.seat, counts, true);
    const rest = goldData(state).queue.slice(1);
    const next =
      rest.length && bankTotal(paid.state) > 0
        ? replaceTop(paid.state, goldFrame(rest))
        : popPhase(paid.state);
    return {
      state: next,
      events: [{ type: 'goldChosen', seat: input.seat, resources: counts }],
      effects: paid.effects,
    };
  },
  applyPrivate: (priv, before, input) => {
    if (priv.seat !== input.seat) return success(priv);
    const counts = parseChoice(before, input.command.resources);
    return counts
      ? privateExchange(priv, counts, true)
      : failure('invalid-gold-choice', 'Gold choice invalid');
  },
};
