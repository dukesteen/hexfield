import type { GameState, Seat } from '@cp2p/engine';
import { kindBounds } from '@cp2p/engine';
import { productionRates } from './board.js';
import type { BotRng } from '../types.js';

/**
 * A distribution over one opponent's hand. The public bounds (exact total, per-kind minimum and
 * maximum, kept by the engine from every build, trade, steal and discard) fix which hands are
 * possible; among those, a hand is weighted like a multinomial draw from the seat's production, so
 * a seat that makes a lot of ore is more likely to hold ore.
 */
export interface HandBelief {
  kinds: readonly string[];
  total: number;
  min: readonly number[];
  max: readonly number[];
  /** Relative chance of drawing each kind (the multinomial prior). */
  prior: readonly number[];
}

function factorial(n: number): number {
  let value = 1;
  for (let k = 2; k <= n; k++) value *= k;
  return value;
}

/** The belief about a seat's hand, from public information only. */
export function handBelief(state: GameState, seat: Seat): HandBelief {
  const holder = state.seats.find((item) => item.seat === seat);
  if (!holder) throw new Error(`Seat ${seat} is not in the game`);
  const bounds = kindBounds(holder.resources);
  const kinds = Object.keys(bounds.min).toSorted();
  const rates = productionRates(state, seat);
  const prior = kinds.map((kind) => 0.15 + ((Reflect.get(rates, kind) ?? 0) * 36) / 10);
  return {
    kinds,
    total: bounds.total,
    min: kinds.map((kind) => bounds.min[kind] ?? 0),
    max: kinds.map((kind) => Math.min(bounds.max[kind] ?? 0, bounds.total)),
    prior,
  };
}

/** Weight of holding exactly n of kind i (the multinomial term p^n / n!). */
function term(belief: HandBelief, i: number, n: number): number {
  return (belief.prior[i] ?? 0) ** n / factorial(n);
}

/** suffix[i][t]: total weight of filling kinds i.. with exactly t cards. */
function suffixWeights(belief: HandBelief): number[][] {
  const k = belief.kinds.length;
  const suffix: number[][] = Array.from({ length: k + 1 }, () =>
    Array<number>(belief.total + 1).fill(0),
  );
  const last = suffix[k];
  if (last) last[0] = 1;
  for (let i = k - 1; i >= 0; i--) {
    const row = suffix[i];
    const next = suffix[i + 1];
    if (!row || !next) continue;
    for (let t = 0; t <= belief.total; t++) {
      let sum = 0;
      for (let n = belief.min[i] ?? 0; n <= Math.min(belief.max[i] ?? 0, t); n++)
        sum += term(belief, i, n) * (next[t - n] ?? 0);
      row[t] = sum;
    }
  }
  return suffix;
}

/** Expected count of each kind under the belief. */
export function expectedHand(belief: HandBelief): Record<string, number> {
  const k = belief.kinds.length;
  const result: Record<string, number> = {};
  if (k === 0) return result;
  // Probability of each count for kind i, from the weight of the other kinds.
  for (let i = 0; i < k; i++) {
    const others: HandBelief = {
      kinds: belief.kinds.filter((_, j) => j !== i),
      total: belief.total,
      min: belief.min.filter((_, j) => j !== i),
      max: belief.max.filter((_, j) => j !== i),
      prior: belief.prior.filter((_, j) => j !== i),
    };
    const rest = suffixWeights(others)[0] ?? [];
    let mass = 0;
    let mean = 0;
    for (let n = belief.min[i] ?? 0; n <= Math.min(belief.max[i] ?? 0, belief.total); n++) {
      const weight = term(belief, i, n) * (rest[belief.total - n] ?? 0);
      mass += weight;
      mean += n * weight;
    }
    result[belief.kinds[i] ?? ''] = mass > 0 ? mean / mass : (belief.min[i] ?? 0);
  }
  return result;
}

/** Draw one hand consistent with the bounds, weighted by the belief. */
export function sampleHand(belief: HandBelief, rng: BotRng): Record<string, number> {
  const suffix = suffixWeights(belief);
  const hand: Record<string, number> = {};
  let remaining = belief.total;
  for (let i = 0; i < belief.kinds.length; i++) {
    const kind = belief.kinds[i] ?? '';
    const next = suffix[i + 1] ?? [];
    const low = belief.min[i] ?? 0;
    const high = Math.min(belief.max[i] ?? 0, remaining);
    const weights: number[] = [];
    let total = 0;
    for (let n = low; n <= high; n++) {
      const weight = term(belief, i, n) * (next[remaining - n] ?? 0);
      weights.push(weight);
      total += weight;
    }
    let chosen = low;
    if (total > 0) {
      let pick = (rng.int(1_000_000) / 1_000_000) * total;
      for (let j = 0; j < weights.length; j++) {
        pick -= weights[j] ?? 0;
        if (pick < 0) {
          chosen = low + j;
          break;
        }
        chosen = low + j;
      }
    }
    hand[kind] = chosen;
    remaining -= chosen;
  }
  return hand;
}
