import type { Engine } from './pipeline/engine.js';
import type { CommandShape } from './pipeline/types.js';
import type { GameState, PrivateState } from './state/types.js';
import { RESOURCES } from './types/index.js';
import type { Resource, ResourceCounts, Seat } from './types/index.js';

type MutableCounts = { -readonly [K in keyof ResourceCounts]: ResourceCounts[K] };

export interface EnumerateOptions {
  /** Maximum distinct discards returned for one hand. Defaults to 50. */
  maxDiscardOptions?: number;
  /** Maximum curated offers returned for one seat. Defaults to 40. */
  maxTradeOffers?: number;
  /** Injected uniform integer source, needed when discards exceed the cap. */
  sampleIndex?: (maxExclusive: number) => number;
  /** Optional policy filter applied before the final public validation. */
  candidateFilter?: (command: CommandShape) => boolean;
}

function checkedCap(value: number | undefined, fallback: number, name: string): number {
  const cap = value ?? fallback;
  if (!Number.isSafeInteger(cap) || cap < 1) throw new RangeError(`${name} must be positive`);
  return cap;
}

function counts(): MutableCounts {
  return { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
}

function wholeHand(priv: PrivateState): MutableCounts {
  const hand = counts();
  for (const resource of RESOURCES) {
    const quantity = priv.hand[resource];
    if (quantity === undefined || !Number.isSafeInteger(quantity) || quantity < 0)
      throw new RangeError(`Invalid private hand count for ${resource}`);
    hand[resource] = quantity;
  }
  return hand;
}

function discardOptions(
  hand: ResourceCounts,
  count: number,
  limit: number,
  sampleIndex?: (maxExclusive: number) => number,
): CommandShape[] {
  if (!Number.isSafeInteger(count) || count < 0) return [];
  const memo = new Map<string, number>();
  function ways(index: number, remaining: number): number {
    if (index === RESOURCES.length) return remaining === 0 ? 1 : 0;
    const key = `${index}:${remaining}`;
    const saved = memo.get(key);
    if (saved !== undefined) return saved;
    const resource = RESOURCES[index];
    if (resource === undefined) return 0;
    let total = 0;
    for (let n = 0; n <= Math.min(hand[resource], remaining); n++)
      total += ways(index + 1, remaining - n);
    memo.set(key, total);
    return total;
  }
  const total = ways(0, count);
  if (total === 0) return [];
  const selected: number[] = [];
  if (total <= limit) {
    for (let rank = 0; rank < total; rank++) selected.push(rank);
  } else {
    if (!sampleIndex) throw new RangeError('sampleIndex is required when discards exceed the cap');
    const ranks = new Set<number>();
    for (let value = total - limit; value < total; value++) {
      const sampled = sampleIndex(value + 1);
      if (!Number.isSafeInteger(sampled) || sampled < 0 || sampled > value)
        throw new RangeError('sampleIndex returned an out-of-range value');
      ranks.add(ranks.has(sampled) ? value : sampled);
    }
    selected.push(...[...ranks].toSorted((a, b) => a - b));
  }
  function unrank(rank: number): ResourceCounts {
    const result = counts();
    let remaining = count;
    for (let index = 0; index < RESOURCES.length; index++) {
      const resource = RESOURCES[index];
      if (resource === undefined) break;
      for (let n = 0; n <= Math.min(hand[resource], remaining); n++) {
        const size = ways(index + 1, remaining - n);
        if (rank >= size) rank -= size;
        else {
          result[resource] = n;
          remaining -= n;
          break;
        }
      }
    }
    return result;
  }
  return selected.map((rank) => ({ type: 'DISCARD', cards: unrank(rank) }));
}

function pair(first: Resource, second: Resource): ResourceCounts {
  const selected = counts();
  selected[first]++;
  selected[second]++;
  return selected;
}

/** Expand one seat's legal templates. Random sampling is supplied by the caller. */
export function enumerateCommands(
  engine: Engine,
  state: GameState,
  seat: Seat,
  priv: PrivateState,
  opts: EnumerateOptions = {},
): CommandShape[] {
  if (priv.seat !== seat) throw new Error('Private state belongs to another seat');
  const maxDiscardOptions = checkedCap(opts.maxDiscardOptions, 50, 'maxDiscardOptions');
  const maxTradeOffers = checkedCap(opts.maxTradeOffers, 40, 'maxTradeOffers');
  const hand = wholeHand(priv);
  const legal = engine.getLegalCommands(state, seat, priv, opts.candidateFilter);
  const candidates: CommandShape[] = [];
  for (const template of legal.templates) {
    switch (template.type) {
      case 'DISCARD': {
        if (typeof template.count === 'number')
          candidates.push(
            ...discardOptions(hand, template.count, maxDiscardOptions, opts.sampleIndex),
          );
        break;
      }
      case 'MARITIME_TRADE': {
        for (const give of RESOURCES)
          for (const rate of [2, 3, 4]) {
            if (hand[give] < rate) continue;
            for (const get of RESOURCES) {
              if (get === give || (state.bank[get] ?? 0) < 1) continue;
              candidates.push({
                type: 'MARITIME_TRADE',
                give: { [give]: rate },
                get: { [get]: 1 },
              });
            }
          }
        break;
      }
      case 'OFFER_TRADE':
      case 'PROPOSE_TRADE': {
        let added = 0;
        for (const give of RESOURCES) {
          for (const want of RESOURCES) {
            if (give === want) continue;
            for (const amount of [1, 2]) {
              if (added >= maxTradeOffers) break;
              if (hand[give] < amount) continue;
              candidates.push({
                type: template.type,
                give: { [give]: amount },
                want: { [want]: 1 },
              });
              added++;
            }
          }
        }
        break;
      }
      case 'PLAY_DEV_CARD': {
        if (template.card !== 'yearOfPlenty' || typeof template.slotId !== 'string') break;
        for (let i = 0; i < RESOURCES.length; i++)
          for (let j = i; j < RESOURCES.length; j++) {
            const first = RESOURCES[i];
            const second = RESOURCES[j];
            if (first !== undefined && second !== undefined)
              candidates.push({
                type: 'PLAY_DEV_CARD',
                slotId: template.slotId,
                card: 'yearOfPlenty',
                params: { resources: pair(first, second) },
              });
          }
        break;
      }
    }
  }
  const accepted = legal.commands;
  accepted.push(
    ...candidates.filter(
      (command) =>
        (opts.candidateFilter?.(command) ?? true) &&
        engine.validate(state, { kind: 'command', seat, command }).ok,
    ),
  );
  return accepted;
}
