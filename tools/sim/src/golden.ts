import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RandomBot, createBotRng } from '@cp2p/bots';
import { fromBase64Url } from '@cp2p/codec';
import { createBaseEngine, LocalGame } from '@cp2p/engine';
import type {
  Engine,
  GameState,
  Input,
  LocalRandomSource,
  Pending,
  Resource,
  Seat,
} from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import { createLocalRandomSource, deriveSeed } from './random-source.js';
import { makeReplay, readReplay, verifyReplay, writeReplay } from './replay.js';
import type { ReplayFile } from './replay.js';
import { runGame, SimulationFailure } from './run-game.js';

export type GoldenFeature =
  | 'normal-completion'
  | 'longest-road-win'
  | 'largest-army-win'
  | 'hidden-vp-win'
  | 'bank-shortage'
  | 'friendly-robber-restriction'
  | 'balanced-dice'
  | 'all-development-card-types'
  | 'road-building-no-legal-spots';

export interface GoldenCase {
  name: string;
  seed: number;
  gameIndex: number;
  players?: number;
  baseOptions?: Record<string, unknown>;
  features?: readonly GoldenFeature[];
  devCardOrder?: readonly string[];
  fixedDiceTotal?: number;
}

export interface UpdateGoldensOptions {
  /** Must be explicit so ordinary verification can never replace baselines. */
  update?: boolean;
  outputDirectory?: string;
  cases?: readonly GoldenCase[];
}

export interface GoldenManifestEntry {
  name: string;
  file: string;
  seed: number;
  gameIndex: number;
  players: number;
  baseOptions: Record<string, unknown>;
  fixedDiceTotal?: number;
  features: GoldenFeature[];
  inputs: number;
  winner: Seat | null;
  engineVersion: string;
}

const defaultOutputDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/engine/test/golden',
);

const extraGames: GoldenCase[] = [
  ...Array.from({ length: 5 }, (_, index) => ({
    name: `normal-game-${String(index + 1).padStart(2, '0')}`,
    seed: 4100,
    gameIndex: index,
  })),
  ...[2, 3, 4, 5, 7, 8].map((gameIndex) => ({
    name: `normal-game-${String(gameIndex + 6).padStart(2, '0')}`,
    seed: 8301,
    gameIndex,
  })),
];

/** Twenty deterministic games and focused cases that cover the rare rule paths. */
export const DEFAULT_GOLDEN_CASES: readonly GoldenCase[] = [
  {
    name: 'normal-completion',
    seed: 4100,
    gameIndex: 2,
    features: ['normal-completion'],
  },
  {
    name: 'longest-road-win',
    seed: 8301,
    gameIndex: 7,
    features: ['longest-road-win'],
  },
  {
    name: 'largest-army-win',
    seed: 8301,
    gameIndex: 4,
    features: ['largest-army-win'],
  },
  {
    name: 'hidden-vp-win',
    seed: 8301,
    gameIndex: 0,
    features: ['hidden-vp-win'],
  },
  {
    name: 'bank-shortage',
    seed: 8301,
    gameIndex: 0,
    fixedDiceTotal: 6,
    features: ['bank-shortage'],
  },
  {
    name: 'friendly-robber',
    seed: 9200,
    gameIndex: 0,
    baseOptions: { friendlyRobber: true },
    features: ['friendly-robber-restriction'],
  },
  {
    name: 'balanced-dice',
    seed: 9200,
    gameIndex: 0,
    baseOptions: { diceMode: 'balanced' },
    features: ['balanced-dice'],
  },
  {
    name: 'all-development-card-types',
    seed: 8301,
    gameIndex: 3,
    features: ['all-development-card-types'],
  },
  {
    name: 'road-building-no-legal-spots',
    seed: 1392,
    gameIndex: 0,
    features: ['road-building-no-legal-spots'],
  },
  ...extraGames,
];

const terrainResource: Readonly<Record<string, Resource | undefined>> = {
  hills: 'brick',
  forest: 'lumber',
  pasture: 'wool',
  fields: 'grain',
  mountains: 'ore',
};

function hasProductionShortage(state: GameState, roll: number): boolean {
  const coords = state.board.hexes.flatMap((hex) => {
    const match = /^h:(-?\d+),(-?\d+)$/.exec(hex.id);
    return match ? [{ q: Number(match[1]), r: Number(match[2]) }] : [];
  });
  const graph = buildBoardGraph(coords);
  const demand = new Map<string, Map<Seat, number>>();
  for (const hex of state.board.hexes) {
    const resource = terrainResource[hex.terrain];
    if (!resource || hex.token !== roll || hex.id === state.board.robberHex) continue;
    const index = graph.hexIndex[hex.id];
    const vertices = new Set<string>(index === undefined ? [] : (graph.hexVertices[index] ?? []));
    for (const building of state.board.buildings) {
      if (!vertices.has(building.vertex)) continue;
      const recipients = demand.get(resource) ?? new Map<Seat, number>();
      recipients.set(
        building.seat,
        (recipients.get(building.seat) ?? 0) + (building.kind === 'city' ? 2 : 1),
      );
      demand.set(resource, recipients);
    }
  }
  return [...demand].some(([resource, recipients]) => {
    const total = [...recipients.values()].reduce((sum, count) => sum + count, 0);
    return total > (state.bank[resource] ?? 0);
  });
}

function featureSet(
  engine: ReturnType<typeof createBaseEngine>,
  initial: GameState,
  inputs: readonly Input[],
): Set<GoldenFeature> {
  const features = new Set<GoldenFeature>();
  let state = initial;
  let pendingAwardClaims: { feature: GoldenFeature; seat: Seat }[] = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    if (!input) throw new Error(`Golden feature scan missing input ${index}`);
    const before = state;
    if (
      input.kind === 'system' &&
      input.type === 'DICE_RESULT' &&
      Array.isArray(input.dice) &&
      input.dice.length === 2 &&
      typeof input.dice[0] === 'number' &&
      typeof input.dice[1] === 'number'
    ) {
      if (input.index !== undefined) features.add('balanced-dice');
      if (hasProductionShortage(state, input.dice[0] + input.dice[1]))
        features.add('bank-shortage');
    }
    if (input.kind === 'command' && input.command.type === 'MOVE_ROBBER') {
      if (
        state.config.options.base &&
        Reflect.get(state.config.options.base, 'friendlyRobber') === true
      ) {
        const restricted = state.board.hexes.some((hex) => {
          if (hex.id === state.board.robberHex) return false;
          const testInput: Input = {
            kind: 'command',
            seat: input.seat,
            command: { type: 'MOVE_ROBBER', hex: hex.id },
          };
          return !engine.validate(before, testInput).ok;
        });
        if (restricted) features.add('friendly-robber-restriction');
      }
    }
    const applied = engine.apply(state, input);
    if (!applied.ok) throw new Error(`Golden analysis input rejected: ${applied.error.message}`);
    state = applied.value.state;
    if (input.kind === 'command' && input.command.type === 'CLAIM_VICTORY') {
      for (const pending of pendingAwardClaims) {
        if (pending.seat === input.seat && state.result?.winner === input.seat)
          features.add(pending.feature);
      }
    }
    pendingAwardClaims = [];
    const next = inputs[index + 1];
    const nextClaim =
      next?.kind === 'command' && next.command.type === 'CLAIM_VICTORY' ? next : null;
    for (const [award, feature] of [
      ['longestRoad', 'longest-road-win'],
      ['largestArmy', 'largest-army-win'],
    ] as const) {
      const holder = state.awards[award];
      if (holder === null || holder === undefined || holder === before.awards[award]) continue;
      if (state.result?.winner === holder) features.add(feature);
      else if (nextClaim?.seat === holder) pendingAwardClaims.push({ feature, seat: holder });
    }
    if (
      input.kind === 'command' &&
      input.command.type === 'PLAY_DEV_CARD' &&
      input.command.card === 'roadBuilding' &&
      applied.value.state.turn.phase.at(-1)?.id !== 'roadBuilding' &&
      !applied.value.state.board.roads.some(
        (road) =>
          road.seat === input.seat && !before.board.roads.some((old) => old.edge === road.edge),
      ) &&
      applied.value.state.seats
        .find((seat) => seat.seat === input.seat)
        ?.cardSlots.some(
          (slot) => slot.slotId === input.command.slotId && slot.revealed === 'roadBuilding',
        )
    )
      features.add('road-building-no-legal-spots');
    if (engine.checkInvariants(state).length > 0)
      throw new Error(`Golden analysis found invalid state at input ${state.counters.inputSeq}`);
  }

  if (state.result) {
    features.add('normal-completion');
    if (state.result.reason === 'claimed-vp') features.add('hidden-vp-win');
  }
  const dealt = new Set(
    inputs.flatMap((input) =>
      input.kind === 'system' && input.type === 'CARD_DEALT' && typeof input.card === 'string'
        ? [input.card]
        : [],
    ),
  );
  const played = new Set(
    inputs.flatMap((input) =>
      input.kind === 'command' && input.command.type === 'PLAY_DEV_CARD'
        ? [input.command.card]
        : [],
    ),
  );
  if (
    ['knight', 'victoryPoint', 'roadBuilding', 'yearOfPlenty', 'monopoly'].every((card) =>
      dealt.has(card),
    ) &&
    ['knight', 'roadBuilding', 'yearOfPlenty', 'monopoly'].every((card) => played.has(card))
  )
    features.add('all-development-card-types');
  return features;
}

function finalReplayState(
  engine: ReturnType<typeof createBaseEngine>,
  config: GameState['config'],
  seed: Uint8Array,
  inputs: readonly Input[],
): GameState {
  let state = engine.createGame(config, seed);
  for (const input of inputs) {
    const result = engine.apply(state, input);
    if (!result.ok) throw new Error(`Replay input rejected: ${result.error.message}`);
    state = result.value.state;
  }
  return state;
}

function expectedShortageStop(error: unknown, item: GoldenCase): error is SimulationFailure {
  return (
    error instanceof SimulationFailure &&
    item.features?.includes('bank-shortage') === true &&
    (error.category === 'dead-turn' || error.category === 'dead-stall')
  );
}

function verifyExistingBaselines(
  engine: Engine,
  cases: readonly GoldenCase[],
  outputDirectory: string,
): void {
  for (const item of cases) {
    const path = join(outputDirectory, `${item.name}.replay.json`);
    if (!existsSync(path)) continue;
    const replay = readReplay(path);
    const currentVersion = engine.createGame(
      replay.config,
      fromBase64Url(replay.genesisSeed),
    ).engineVersion;
    if (replay.engineVersion !== currentVersion) continue;
    try {
      verifyReplay(engine, replay);
    } catch (error) {
      throw new Error(
        `Golden replay ${replay.engineVersion} no longer verifies for ${item.name}; bump engineVersion before updating baselines: ${String(error)}`,
        { cause: error },
      );
    }
  }
}

const directedDevDeck = [
  'roadBuilding',
  ...Array<string>(14).fill('knight'),
  ...Array<string>(5).fill('victoryPoint'),
  'roadBuilding',
  ...Array<string>(2).fill('yearOfPlenty'),
  ...Array<string>(2).fill('monopoly'),
];

interface DirectedScenario {
  config: GameState['config'];
  genesisSeed: Uint8Array;
  inputs: Input[];
  state: GameState;
}

function pendingForSeat(
  pending: readonly Pending[],
  activeSeat: Seat,
): Extract<Pending, { kind: 'player' }> | undefined {
  return pending.find(
    (item): item is Extract<Pending, { kind: 'player' }> =>
      item.kind === 'player' &&
      (item.seat === activeSeat ||
        item.allowed.includes('DISCARD') ||
        item.allowed.includes('RESPOND_TRADE')),
  );
}

/** Build all roads through legal turns, then consume the directed Road Building card. */
function runNoRoadSpotsScenario(seed: number, gameIndex: number): DirectedScenario {
  const engine = createBaseEngine();
  const config = {
    modules: [{ id: 'base', version: '1.0.0' }],
    seats: [0, 1, 2, 3] as Seat[],
    options: { base: { vpTarget: 20 } },
  };
  const genesisSeed = deriveSeed(seed, gameIndex, 'genesis');
  const source: LocalRandomSource = createLocalRandomSource(deriveSeed(seed, gameIndex, 'system'), {
    devCardOrder: directedDevDeck,
  });
  const created = LocalGame.create(engine, config, genesisSeed, source);
  if (!created.ok) throw new Error(`Directed game genesis failed: ${created.error.message}`);
  const game = created.value;
  const bots = config.seats.map(() => new RandomBot(engine));
  const botRngs = config.seats.map((seat) =>
    createBotRng(deriveSeed(seed, gameIndex, 'bot', seat)),
  );
  let hasRoadBuilding = false;
  for (let steps = 0; steps < 30_000 && !hasRoadBuilding; steps += 1) {
    const state = game.snapshot();
    const pending = pendingForSeat(game.getPending(), state.turn.activeSeat);
    if (!pending) throw new Error(`Directed game has no player pending at step ${steps}`);
    const seat = pending.seat;
    const priv = game.privateState(seat);
    const bot = bots[seat];
    const rng = botRngs[seat];
    if (!priv || !bot || !rng) throw new Error(`Missing directed bot state for seat ${seat}`);
    let command = bot.decide({ state, priv, seat }, pending, rng);
    if (seat === 0) {
      const phase = state.turn.phase.at(-1)?.id;
      const legal = engine.getLegalCommands(state, seat, priv).commands;
      const roadsLeft = state.seats.find((player) => player.seat === seat)?.piecesLeft.road ?? 0;
      if (roadsLeft === 0) {
        const cardPlay = legal.find(
          (item) => item.type === 'PLAY_DEV_CARD' && item.card === 'roadBuilding',
        );
        if (cardPlay) command = cardPlay;
        else if (phase === 'main')
          command = legal.find((item) => item.type === 'END_TURN') ?? command;
      } else if (phase === 'main') {
        const road = legal.find((item) => item.type === 'BUILD_ROAD');
        const buyCard = legal.find((item) => item.type === 'BUY_DEV_CARD');
        const end = legal.find((item) => item.type === 'END_TURN');
        const alreadyOwnsRoadBuilding = Object.values(priv.slots).includes('roadBuilding');
        if (buyCard && !alreadyOwnsRoadBuilding) command = buyCard;
        else if (road) command = road;
        else if (buyCard) command = buyCard;
        else if (end) command = end;
      } else if (command.type === 'PLAY_DEV_CARD' && command.card === 'roadBuilding') {
        command = legal.find((item) => item.type === 'ROLL_DICE') ?? command;
      }
    } else if (command.type === 'BUY_DEV_CARD') {
      const end = engine
        .getLegalCommands(state, seat, priv)
        .commands.find((item) => item.type === 'END_TURN');
      if (end) command = end;
    }
    const result = game.submit({ kind: 'command', seat, command });
    if (!result.ok)
      throw new Error(`Directed input failed: ${result.error.code}: ${result.error.message}`);
    const latest = game.snapshot();
    if (seat === 0 && command.type === 'PLAY_DEV_CARD' && command.card === 'roadBuilding') {
      const roadsBefore = state.board.roads.filter((road) => road.seat === seat).length;
      const roadsAfter = latest.board.roads.filter((road) => road.seat === seat).length;
      const slot = latest.seats
        .find((player) => player.seat === seat)
        ?.cardSlots.find((item) => item.slotId === command.slotId);
      if (
        roadsBefore === 15 &&
        roadsAfter === roadsBefore &&
        latest.turn.phase.at(-1)?.id !== 'roadBuilding' &&
        slot?.revealed === 'roadBuilding'
      )
        hasRoadBuilding = true;
      else
        throw new Error(
          `Directed Road Building card failed: roads ${roadsBefore}->${roadsAfter}, phase ${latest.turn.phase.at(-1)?.id}, slot ${slot?.revealed}`,
        );
    }
  }
  if (!hasRoadBuilding)
    throw new Error('Directed scenario did not reach the no-road-pieces card play');
  return { config, genesisSeed, inputs: [...game.log], state: game.snapshot() };
}

/** Regenerate coverage-checked replay fixtures; omitted update flags never write files. */
export function updateGoldens(options: UpdateGoldensOptions): { written: string[] } {
  if (options.update !== true)
    throw new Error('Golden replay updates require explicit update mode');
  const outputDirectory = resolve(options.outputDirectory ?? defaultOutputDirectory);
  const cases = options.cases ?? DEFAULT_GOLDEN_CASES;
  if (cases.length === 0) throw new Error('At least one golden case is required');
  const names = new Set<string>();
  for (const item of cases) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(item.name) || names.has(item.name))
      throw new Error(`Golden case name is invalid or duplicated: ${item.name}`);
    names.add(item.name);
  }

  const engine = createBaseEngine();
  verifyExistingBaselines(engine, cases, outputDirectory);
  const pending: {
    item: GoldenCase;
    replay: ReplayFile;
    features: Set<GoldenFeature>;
    winner: Seat | null;
  }[] = [];
  for (const item of cases) {
    let result:
      | DirectedScenario
      | ReturnType<typeof runGame>
      | { config: GameState['config']; genesisSeed: Uint8Array; inputs: Input[]; state: GameState };
    if (item.name === 'road-building-no-legal-spots') {
      result = runNoRoadSpotsScenario(item.seed, item.gameIndex);
    } else {
      try {
        result = runGame({
          seed: item.seed,
          gameIndex: item.gameIndex,
          ...(item.players === undefined ? {} : { players: item.players }),
          ...(item.baseOptions === undefined ? {} : { baseOptions: item.baseOptions }),
          ...(item.devCardOrder === undefined ? {} : { devCardOrder: item.devCardOrder }),
          ...(item.fixedDiceTotal === undefined ? {} : { fixedDiceTotal: item.fixedDiceTotal }),
        });
      } catch (error) {
        if (!expectedShortageStop(error, item)) throw error;
        result = {
          config: error.config,
          genesisSeed: error.genesisSeed,
          inputs: error.inputs,
          state: finalReplayState(engine, error.config, error.genesisSeed, error.inputs),
        };
      }
    }
    const initial = engine.createGame(result.config, result.genesisSeed);
    const features = featureSet(engine, initial, result.inputs);
    for (const expected of item.features ?? []) {
      if (!features.has(expected))
        throw new Error(`Golden case ${item.name} does not demonstrate ${expected}`);
    }
    const replay = makeReplay(engine, result.config, result.genesisSeed, result.inputs);
    pending.push({ item, replay, features, winner: result.state.result?.winner ?? null });
  }

  mkdirSync(outputDirectory, { recursive: true });
  const manifest: GoldenManifestEntry[] = [];
  const written: string[] = [];
  for (const { item, replay, features, winner } of pending) {
    const file = `${item.name}.replay.json`;
    writeReplay(join(outputDirectory, file), replay);
    manifest.push({
      name: item.name,
      file,
      seed: item.seed,
      gameIndex: item.gameIndex,
      players: item.players ?? 4,
      baseOptions: item.baseOptions ?? {},
      ...(item.fixedDiceTotal === undefined ? {} : { fixedDiceTotal: item.fixedDiceTotal }),
      features: [...features].toSorted(),
      inputs: replay.inputs.length,
      winner,
      engineVersion: replay.engineVersion,
    });
    written.push(file);
  }
  const manifestPath = join(outputDirectory, 'manifest.json');
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ format: 'cp2p-golden-manifest', version: 1, fixtures: manifest }, null, 2)}\n`,
  );
  written.push(manifestPath);
  return { written };
}
