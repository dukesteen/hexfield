import { RandomBot, createBotRng } from '@cp2p/bots';
import { canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { createBaseEngine, LocalGame } from '@cp2p/engine';
import type {
  Engine,
  GameConfig,
  GameState,
  Input,
  Pending,
  PrivateState,
  Seat,
} from '@cp2p/engine';
import { standardFixedBoard } from '@cp2p/maps';
import { createLocalRandomSource, deriveSeed } from './random-source.js';
import type { LocalRandomOptions } from './random-source.js';

export interface RunGameOptions extends LocalRandomOptions {
  seed: number;
  gameIndex: number;
  players?: number;
  baseOptions?: Record<string, unknown>;
  verify?: boolean;
  maxTurns?: number;
  maxInputsWithoutTurn?: number;
  /** Optional test observer, called with only the acting seat's private state. */
  onPlayerStep?: (engine: Engine, state: GameState, seat: Seat, priv: PrivateState) => void;
}

export interface GameStats {
  turns: number;
  inputs: number;
  winner: Seat;
  dice: number[];
  commands: Record<string, number>;
  awardSwing: boolean;
  applyCount: number;
  applyNanoseconds: number;
  applyDurationsNanoseconds: number[];
  elapsedNanoseconds: number;
}

export interface RunGameResult {
  config: GameConfig;
  genesisSeed: Uint8Array;
  inputs: Input[];
  state: GameState;
  stats: GameStats;
}

export type SimulationFailureCategory =
  | 'dead-turn'
  | 'dead-stall'
  | 'public-invariant'
  | 'private-failure'
  | 'input-rejected'
  | 'driver-failure';

/** A reproducible game failure, including the accepted public input prefix. */
export class SimulationFailure extends Error {
  constructor(
    message: string,
    readonly config: GameConfig,
    readonly genesisSeed: Uint8Array,
    readonly inputs: Input[],
    readonly attemptedInput?: Input,
    readonly category: SimulationFailureCategory = 'driver-failure',
  ) {
    super(message);
    this.name = 'SimulationFailure';
  }
}

function checkedState(engine: Engine, state: GameState, inputCount: number): void {
  const problems = engine.checkInvariants(state);
  if (problems.length)
    throw new Error(`Invariant after input ${inputCount}: ${problems.join('; ')}`);
  if (!state.result && engine.getPending(state).length === 0)
    throw new Error(`Live game has no pending input after ${inputCount}`);
  if (inputCount % 100 === 0) canonicalEncode(state);
}

const DEV_CARD_COUNTS: Record<string, number> = {
  knight: 14,
  victoryPoint: 5,
  roadBuilding: 2,
  yearOfPlenty: 2,
  monopoly: 2,
};

/** Check the real local deck against public slots, private identities, and stock. */
export function cardConservation(
  state: GameState,
  privates: ReadonlyMap<Seat, PrivateState>,
  remaining: readonly string[],
): string[] {
  const problems: string[] = [];
  const publicRemaining = state.decks.dev?.remaining;
  if (publicRemaining !== remaining.length)
    problems.push(
      `Source deck has ${remaining.length} cards, public deck has ${String(publicRemaining)}`,
    );
  const counts: Record<string, number> = {};
  const count = (card: string): void => {
    if (!Object.hasOwn(DEV_CARD_COUNTS, card)) problems.push(`Unknown development card ${card}`);
    counts[card] = (counts[card] ?? 0) + 1;
  };
  for (const card of remaining) count(card);
  for (const seat of state.config.seats) {
    const priv = privates.get(seat);
    if (!priv) return [`Missing private cards for seat ${seat}`];
    const publicSeat = state.seats.find((holder) => holder.seat === seat);
    if (!publicSeat) return [`Missing public seat ${seat}`];
    const unrevealed = new Set(
      publicSeat.cardSlots.filter((slot) => !slot.revealed).map((slot) => slot.slotId),
    );
    for (const slotId of unrevealed)
      if (!Object.hasOwn(priv.slots, slotId))
        problems.push(`Seat ${seat} lacks private identity for slot ${slotId}`);
    for (const slotId of Object.keys(priv.slots))
      if (!unrevealed.has(slotId))
        problems.push(`Seat ${seat} has private identity without unrevealed slot ${slotId}`);
    for (const card of Object.values(priv.slots)) count(card);
  }
  for (const seat of state.seats)
    for (const slot of seat.cardSlots) if (slot.revealed) count(slot.revealed);
  for (const [card, expected] of Object.entries(DEV_CARD_COUNTS))
    if (counts[card] !== expected)
      problems.push(`${card} count ${counts[card] ?? 0}, expected ${expected}`);
  return problems;
}

function gameConfig(players: number, baseOptions: Record<string, unknown>): GameConfig {
  if (!Number.isSafeInteger(players) || players < 2 || players > 4)
    throw new RangeError('Base simulation requires 2–4 players');
  const seats: Seat[] = [0, 1, 2, 3];
  return {
    modules: [{ id: 'base', version: '1.0.0' }],
    seats: seats.slice(0, players),
    options: { base: { vpTarget: 10, ...baseOptions } },
    ...(baseOptions.mapLayout === 'standard-fixed' ? { board: standardFixedBoard() } : {}),
  };
}

function choosePending(
  pending: Pending[],
  activeSeat: Seat,
  choice: number,
): Extract<Pending, { kind: 'player' }> {
  const actionable = pending.filter(
    (item): item is Extract<Pending, { kind: 'player' }> =>
      item.kind === 'player' && item.allowed.some((type) => type !== 'CLAIM_VICTORY'),
  );
  if (actionable.length === 0) throw new Error('No actionable player pending');
  const mandatory = actionable.find((item) => item.allowed.includes('DISCARD'));
  if (mandatory) return mandatory;
  const response = actionable.find(
    (item) => item.seat !== activeSeat && item.allowed.includes('RESPOND_TRADE'),
  );
  if (response && choice % 2 === 0) return response;
  const selected = actionable.find((item) => item.seat === activeSeat) ?? actionable[0];
  if (!selected) throw new Error('No actionable player pending');
  return selected;
}

/** Play one deterministic LocalGame, checking every public and private transition. */
export function runGame(options: RunGameOptions): RunGameResult {
  const gameStarted = process.hrtime.bigint();
  const players = options.players ?? 4;
  const config = gameConfig(players, options.baseOptions ?? {});
  const genesisSeed = deriveSeed(options.seed, options.gameIndex, 'genesis');
  const randomSource = createLocalRandomSource(
    deriveSeed(options.seed, options.gameIndex, 'system'),
    options,
  );
  const underlying = createBaseEngine();
  const dice = Array<number>(13).fill(0);
  const commands: Record<string, number> = {};
  const applyDurationsNanoseconds: number[] = [];
  const acceptedInputs: Input[] = [];
  let inputsWithoutTurn = 0;
  let awardGainInBatch: Seat | null = null;
  let awardSwing = false;
  let applyNanoseconds = 0;
  let applyCount = 0;
  const maxTurns = options.maxTurns ?? 500;
  const maxInputsWithoutTurn = options.maxInputsWithoutTurn ?? 2_000;
  const verify = options.verify !== false;
  const checked: Engine = {
    ...underlying,
    checkPrivateInvariants(state, privates) {
      const violations = underlying.checkPrivateInvariants(state, privates);
      if (verify && applyCount % 100 === 0)
        for (const priv of privates.values()) canonicalEncode(priv);
      return verify
        ? [...violations, ...cardConservation(state, privates, randomSource.remainingCards())]
        : violations;
    },
    createGame(gameOptions, seed) {
      const created = underlying.createGame(gameOptions, seed);
      if (verify) checkedState(underlying, created, 0);
      return created;
    },
    apply(before, input) {
      if (input.kind === 'command' && input.command.type !== 'CLAIM_VICTORY')
        awardGainInBatch = null;
      const sample = verify && (applyCount + 1) % 100 === 0 ? toHex(hashValue(before)) : null;
      const started = process.hrtime.bigint();
      const applied = underlying.apply(before, input);
      const elapsed = Number(process.hrtime.bigint() - started);
      applyNanoseconds += elapsed;
      applyDurationsNanoseconds.push(elapsed);
      applyCount++;
      if (!applied.ok) return applied;
      if (sample !== null && toHex(hashValue(before)) !== sample)
        throw new Error(`Engine mutated input at ${applyCount}`);
      const next = applied.value.state;
      acceptedInputs.push(input);
      for (const award of ['longestRoad', 'largestArmy']) {
        const newHolder = next.awards[award];
        if (newHolder !== null && newHolder !== undefined && newHolder !== before.awards[award])
          awardGainInBatch = newHolder;
      }
      if (next.result && awardGainInBatch === next.result.winner) awardSwing = true;
      if (verify) checkedState(underlying, next, applyCount);
      inputsWithoutTurn = next.turn.number === before.turn.number ? inputsWithoutTurn + 1 : 0;
      if (next.turn.number > maxTurns)
        throw new Error(`Dead game: turn ${next.turn.number} exceeds ${maxTurns}`);
      if (inputsWithoutTurn > maxInputsWithoutTurn)
        throw new Error(`Dead game: ${inputsWithoutTurn} inputs without a turn change`);
      if (input.kind === 'command')
        commands[input.command.type] = (commands[input.command.type] ?? 0) + 1;
      if (input.kind === 'system' && input.type === 'DICE_RESULT' && Array.isArray(input.dice)) {
        const roll = Number(input.dice[0]) + Number(input.dice[1]);
        if (Number.isSafeInteger(roll) && roll >= 2 && roll <= 12)
          dice[roll] = (dice[roll] ?? 0) + 1;
      }
      return applied;
    },
  };
  const created = (() => {
    try {
      return LocalGame.create(checked, config, genesisSeed, randomSource, {
        verifyInvariants: verify,
      });
    } catch (error) {
      throw new SimulationFailure(
        `Local game creation failed: ${String(error)}`,
        config,
        genesisSeed,
        acceptedInputs,
      );
    }
  })();
  if (!created.ok)
    throw new SimulationFailure(
      `${created.error.code}: ${created.error.message}`,
      config,
      genesisSeed,
      acceptedInputs,
      undefined,
      'driver-failure',
    );
  const game = created.value;
  const bots = config.seats.map(() => new RandomBot(underlying));
  const botRngs = config.seats.map((seat) =>
    createBotRng(deriveSeed(options.seed, options.gameIndex, 'bot', seat)),
  );
  const scheduler = createBotRng(deriveSeed(options.seed, options.gameIndex, 'scheduler'));

  while (!game.state.result) {
    let input: Input | undefined;
    try {
      const state = game.state as GameState;
      const pending = choosePending(game.getPending(), state.turn.activeSeat, scheduler.int(2));
      const seat = pending.seat;
      // Bots only read this deeply frozen view; LocalGame retains ownership.
      const priv = game.privateView(seat);
      const bot = bots[seat];
      const botRng = botRngs[seat];
      if (!priv || !bot || !botRng)
        throw new Error(`Missing bot or private state for seat ${seat}`);
      options.onPlayerStep?.(underlying, state, seat, priv);
      const command = bot.decide({ state, priv, seat }, pending, botRng);
      input = { kind: 'command', seat, command };
      const next = game.submit(input);
      if (!next.ok)
        throw new SimulationFailure(
          `${next.error.code}: ${next.error.message}`,
          config,
          genesisSeed,
          acceptedInputs,
          acceptedInputs.includes(input) ? undefined : input,
          next.error.message.includes('Dead game: turn')
            ? 'dead-turn'
            : next.error.message.includes('inputs without a turn change')
              ? 'dead-stall'
              : next.error.message.includes('Invariant after input')
                ? 'public-invariant'
                : next.error.code.includes('private')
                  ? 'private-failure'
                  : next.error.code === 'driver-error' || next.error.code === 'driver-terminal'
                    ? 'driver-failure'
                    : acceptedInputs.includes(input)
                      ? 'driver-failure'
                      : 'input-rejected',
        );
    } catch (error) {
      if (error instanceof SimulationFailure) throw error;
      throw new SimulationFailure(
        `Driver failed: ${String(error)}`,
        config,
        genesisSeed,
        acceptedInputs,
        input,
      );
    }
  }
  const state = game.state as GameState;
  const winner = state.result?.winner;
  if (winner === undefined)
    throw new SimulationFailure('Game ended without a winner', config, genesisSeed, acceptedInputs);
  return {
    config,
    genesisSeed,
    inputs: [...game.log],
    state,
    stats: {
      turns: state.turn.number,
      inputs: game.log.length,
      winner,
      dice,
      commands,
      awardSwing,
      applyCount,
      applyNanoseconds,
      applyDurationsNanoseconds,
      elapsedNanoseconds: Number(process.hrtime.bigint() - gameStarted),
    },
  };
}
