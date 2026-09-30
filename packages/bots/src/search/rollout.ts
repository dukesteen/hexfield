import type {
  CommandShape,
  Engine,
  GameState,
  Input,
  Pending,
  PrivateInputData,
  PrivateState,
  Seat,
} from '@cp2p/engine';
import { kindsOfCounts } from '@cp2p/engine';
import type { Bot, BotRng } from '../types.js';
import type { Chance } from './chance.js';
import type { World } from './determinize.js';

type PlayerPending = Extract<Pending, { kind: 'player' }>;

/** A rollout stopped: the game state it reached, and whether the game ended. */
export interface RolloutEnd {
  state: GameState;
  privates: Map<Seat, PrivateState>;
}

/** The chance events of a sampled world: dice, development draws, steals and reveals. */
function resolveSystem(
  pending: Extract<Pending, { kind: 'random' | 'reveal' }>,
  state: GameState,
  privates: ReadonlyMap<Seat, PrivateState>,
  world: World,
  rng: BotRng,
): { input: Input; privateData?: Partial<Record<Seat, PrivateInputData>> } | null {
  switch (pending.systemType) {
    case 'DICE_RESULT': {
      if (pending.request.mode === 'balanced') {
        const base = state.ext.base;
        const deck =
          typeof base === 'object' &&
          base !== null &&
          'diceDeck' in base &&
          Array.isArray(base.diceDeck)
            ? base.diceDeck
            : [];
        const index = rng.int(deck.length);
        const card = Number(deck[index]);
        return {
          input: {
            kind: 'system',
            type: 'DICE_RESULT',
            index,
            dice: [Math.floor(card / 6) + 1, (card % 6) + 1],
          },
        };
      }
      if (pending.request.mode === 'fixed' || pending.request.extra !== undefined) return null;
      return {
        input: { kind: 'system', type: 'DICE_RESULT', dice: [rng.int(6) + 1, rng.int(6) + 1] },
      };
    }
    case 'CARD_DEALT': {
      const deck = pending.request.deck ?? 'dev';
      const card = deck === 'dev' ? world.devDeck.pop() : undefined;
      if (card === undefined || typeof pending.request.slotId !== 'string') return null;
      return {
        input: {
          kind: 'system',
          type: 'CARD_DEALT',
          deck,
          seat: pending.request.seat,
          slotId: pending.request.slotId,
          card,
        },
      };
    }
    case 'STEAL_RESULT': {
      const victim = state.seats.find((holder) => holder.seat === pending.request.victim)?.seat;
      const hand = victim === undefined ? undefined : privates.get(victim)?.hand;
      if (!hand) return null;
      const kinds = kindsOfCounts(hand);
      let index = rng.int(
        Math.max(
          1,
          kinds.reduce((sum, kind) => sum + (hand[kind] ?? 0), 0),
        ),
      );
      for (const resource of kinds) {
        index -= hand[resource] ?? 0;
        if (index < 0)
          return {
            input: {
              kind: 'system',
              type: 'STEAL_RESULT',
              thief: pending.request.thief,
              victim: pending.request.victim,
              resource,
            },
          };
      }
      return null;
    }
    case 'REVEAL_COUNT': {
      if (pending.kind !== 'reveal' || typeof pending.request.resource !== 'string') return null;
      const hand = privates.get(pending.seat)?.hand ?? {};
      return {
        input: {
          kind: 'system',
          type: 'REVEAL_COUNT',
          seat: pending.seat,
          resource: pending.request.resource,
          count: hand[pending.request.resource] ?? 0,
        },
      };
    }
    default:
      return null;
  }
}

function nextPlayer(pending: readonly Pending[], active: Seat): PlayerPending | null {
  const players = pending.filter(
    (item): item is PlayerPending =>
      item.kind === 'player' && item.allowed.some((type) => type !== 'CLAIM_VICTORY'),
  );
  return (
    players.find((item) => item.allowed.includes('DISCARD')) ??
    players.find((item) => item.seat !== active && item.allowed.includes('RESPOND_TRADE')) ??
    players.find((item) => item.seat === active) ??
    players[0] ??
    null
  );
}

/**
 * Play a sampled world forward with a fast policy until `turns` more turns have started, the game
 * ends, a chance event the sampler does not model comes up, or `outOfTime` says to stop. `first`
 * is the searched command, applied for `seat` before the policy takes over. Chance events come
 * from `chance` when given (every module's events), else from the stage 16 base sampler on `rng`.
 */
export function rollout(
  engine: Engine,
  world: World,
  seat: Seat,
  first: CommandShape,
  policy: (seat: Seat) => Bot,
  rng: BotRng,
  turns: number,
  /** Stops the rollout (returning 'timeout') once this reports the time is up. */
  outOfTime: () => boolean = () => false,
  chance?: Chance,
): RolloutEnd | 'timeout' | null {
  let state = world.state;
  let privates = world.privates;
  const apply = (input: Input, privateData?: Partial<Record<Seat, PrivateInputData>>): boolean => {
    const applied = engine.apply(state, input);
    if (!applied.ok) return false;
    const updated = engine.applyAllPrivates(privates, state, input, privateData);
    if (!updated.ok) return false;
    state = applied.value.state;
    privates = updated.value;
    return true;
  };
  if (!apply({ kind: 'command', seat, command: first })) return null;
  const stopAt = state.turn.number + turns;
  for (let step = 0; step < 2_000 && !state.result && state.turn.number < stopAt; step++) {
    if (outOfTime()) return 'timeout';
    const automatic = engine.getAutomaticInput(state, privates);
    if (automatic) {
      if (!apply(automatic)) break;
      continue;
    }
    const pending = engine.getPending(state);
    const system = pending.find(
      (item): item is Extract<Pending, { kind: 'random' | 'reveal' }> =>
        item.kind === 'random' || item.kind === 'reveal',
    );
    if (system) {
      const answer = chance
        ? chance(system, state, privates)
        : resolveSystem(system, state, privates, world, rng);
      if (!answer || !apply(answer.input, answer.privateData)) break;
      continue;
    }
    const player = nextPlayer(pending, state.turn.activeSeat);
    const priv = player ? privates.get(player.seat) : undefined;
    if (!player || !priv) break;
    let command: CommandShape;
    try {
      command = policy(player.seat).decide({ state, priv, seat: player.seat }, player, rng);
    } catch {
      break;
    }
    if (!apply({ kind: 'command', seat: player.seat, command })) break;
  }
  return { state, privates };
}
