import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { fromBase64Url, hashValue, toHex } from '@cp2p/codec';
import { createBaseEngine } from '../src/index.js';
import type { GameConfig, GameState, Input, Seat } from '../src/index.js';
import { buildBoardGraph } from '../src/geometry.js';

interface Checkpoint {
  index: number;
  stateHash: string;
}

interface Replay {
  format: 'cp2p-replay';
  version: 1;
  engineVersion: string;
  config: GameConfig;
  genesisSeed: string;
  inputs: Input[];
  checkpoints: Checkpoint[];
}

interface GoldenEntry {
  name: string;
  file: string;
  features: string[];
  inputs: number;
  winner: Seat | null;
  engineVersion: string;
  baseOptions: Record<string, unknown>;
}

const directory = join(dirname(fileURLToPath(import.meta.url)), 'golden');
const engine = createBaseEngine();
const entries = readManifest();

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSeat(value: unknown): value is Seat {
  return value === 0 || value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

function isInput(value: unknown): value is Input {
  if (!isRecord(value)) return false;
  if (value.kind === 'system') return typeof value.type === 'string';
  return (
    value.kind === 'command' &&
    isSeat(value.seat) &&
    isRecord(value.command) &&
    typeof value.command.type === 'string'
  );
}

function isConfig(value: unknown): value is GameConfig {
  return (
    isRecord(value) &&
    Array.isArray(value.modules) &&
    value.modules.every(
      (item) => isRecord(item) && typeof item.id === 'string' && typeof item.version === 'string',
    ) &&
    Array.isArray(value.seats) &&
    value.seats.every(isSeat) &&
    isRecord(value.options) &&
    (value.board === undefined || isRecord(value.board))
  );
}

function isReplay(value: unknown): value is Replay {
  return (
    isRecord(value) &&
    value.format === 'cp2p-replay' &&
    value.version === 1 &&
    typeof value.engineVersion === 'string' &&
    isConfig(value.config) &&
    typeof value.genesisSeed === 'string' &&
    Array.isArray(value.inputs) &&
    value.inputs.every(isInput) &&
    Array.isArray(value.checkpoints) &&
    value.checkpoints.every(
      (item) =>
        isRecord(item) &&
        Number.isSafeInteger(item.index) &&
        typeof item.stateHash === 'string' &&
        /^[0-9a-f]{64}$/.test(item.stateHash),
    )
  );
}

function isGoldenEntry(value: unknown): value is GoldenEntry {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.file === 'string' &&
    Array.isArray(value.features) &&
    value.features.every((feature) => typeof feature === 'string') &&
    Number.isSafeInteger(value.inputs) &&
    (value.winner === null || isSeat(value.winner)) &&
    typeof value.engineVersion === 'string' &&
    isRecord(value.baseOptions)
  );
}

function readManifest(): GoldenEntry[] {
  const value: unknown = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  if (
    !isRecord(value) ||
    value.format !== 'cp2p-golden-manifest' ||
    value.version !== 1 ||
    !Array.isArray(value.fixtures) ||
    !value.fixtures.every(isGoldenEntry)
  )
    throw new Error('Golden replay manifest is malformed');
  return value.fixtures;
}

function readFixture(entry: GoldenEntry): Replay {
  const value: unknown = JSON.parse(readFileSync(join(directory, entry.file), 'utf8'));
  if (!isReplay(value)) throw new Error(`Golden replay ${entry.file} is malformed`);
  expect(value.engineVersion).toBe(entry.engineVersion);
  expect(value.inputs).toHaveLength(entry.inputs);
  expect(value.checkpoints[0]?.index).toBe(0);
  expect(value.checkpoints.at(-1)?.index).toBe(value.inputs.length);
  expect(value.checkpoints.map(({ index }) => index)).toEqual(
    value.checkpoints.map(({ index }) => index).toSorted((left, right) => left - right),
  );
  expect(new Set(value.checkpoints.map(({ index }) => index)).size).toBe(value.checkpoints.length);
  return value;
}

function productionShortage(state: GameState, roll: number): boolean {
  const terrain: Readonly<Record<string, string | undefined>> = {
    hills: 'brick',
    forest: 'lumber',
    pasture: 'wool',
    fields: 'grain',
    mountains: 'ore',
  };
  const coords = state.board.hexes.map(({ q, r }) => ({ q, r }));
  const graph = buildBoardGraph(coords);
  const demand = new Map<string, Map<Seat, number>>();
  for (const hex of state.board.hexes) {
    const resource = terrain[hex.terrain];
    if (!resource || hex.token !== roll || hex.id === state.board.robberHex) continue;
    const index = graph.hexIndex[hex.id];
    const vertices = new Set<string>(index === undefined ? [] : (graph.hexVertices[index] ?? []));
    for (const building of state.board.buildings) {
      if (!vertices.has(building.vertex)) continue;
      const seats = demand.get(resource) ?? new Map<Seat, number>();
      seats.set(
        building.seat,
        (seats.get(building.seat) ?? 0) + (building.kind === 'city' ? 2 : 1),
      );
      demand.set(resource, seats);
    }
  }
  return [...demand].some(([resource, seats]) => {
    const total = [...seats.values()].reduce((sum, count) => sum + count, 0);
    return total > (state.bank[resource] ?? 0);
  });
}

function assertDeclaredFeatures(entry: GoldenEntry, replay: Replay, finalState: GameState): void {
  const features = new Set(entry.features);
  const dealt = new Set(
    replay.inputs.flatMap((input) =>
      input.kind === 'system' && input.type === 'CARD_DEALT' && typeof input.card === 'string'
        ? [input.card]
        : [],
    ),
  );
  const played = new Set(
    replay.inputs.flatMap((input) =>
      input.kind === 'command' && input.command.type === 'PLAY_DEV_CARD'
        ? [input.command.card]
        : [],
    ),
  );
  const balancedDice = replay.inputs
    .filter((input) => input.kind === 'system' && input.type === 'DICE_RESULT')
    .every((input) => Reflect.get(input, 'index') !== undefined);
  const checks = [
    !features.has('normal-completion') || finalState.result !== null,
    !features.has('hidden-vp-win') || finalState.result?.reason === 'claimed-vp',
    !features.has('longest-road-win') ||
      awardWonInReplay(replay, 'longestRoad', finalState.result?.winner),
    !features.has('largest-army-win') ||
      awardWonInReplay(replay, 'largestArmy', finalState.result?.winner),
    !features.has('road-building-no-legal-spots') || roadBuildingNoSpotsOccurred(replay),
    !features.has('balanced-dice') || entry.baseOptions.diceMode === 'balanced',
    !features.has('balanced-dice') || balancedDice,
    !features.has('all-development-card-types') ||
      ['knight', 'victoryPoint', 'roadBuilding', 'yearOfPlenty', 'monopoly'].every((card) =>
        dealt.has(card),
      ),
    !features.has('all-development-card-types') ||
      ['knight', 'roadBuilding', 'yearOfPlenty', 'monopoly'].every((card) => played.has(card)),
  ];
  expect(checks.every(Boolean)).toBe(true);
}

function awardWonInReplay(
  replay: Replay,
  award: 'longestRoad' | 'largestArmy',
  winner: Seat | undefined,
): boolean {
  if (winner === undefined) return false;
  let state = engine.createGame(replay.config, fromBase64Url(replay.genesisSeed));
  for (let index = 0; index < replay.inputs.length; index += 1) {
    const input = replay.inputs[index];
    if (!input) return false;
    const previousHolder = state.awards[award];
    const applied = engine.apply(state, input);
    if (!applied.ok) return false;
    state = applied.value.state;
    if (state.awards[award] === null || state.awards[award] === previousHolder) continue;
    if (state.result?.winner === winner && state.awards[award] === winner) return true;
    const next = replay.inputs[index + 1];
    if (next?.kind !== 'command' || next.command.type !== 'CLAIM_VICTORY') continue;
    const claim = engine.apply(state, next);
    if (claim.ok && claim.value.state.result?.winner === winner && next.seat === winner)
      return true;
  }
  return false;
}

function roadBuildingNoSpotsOccurred(replay: Replay): boolean {
  let state = engine.createGame(replay.config, fromBase64Url(replay.genesisSeed));
  for (const input of replay.inputs) {
    const before = state;
    const applied = engine.apply(state, input);
    if (!applied.ok) return false;
    state = applied.value.state;
    if (
      input.kind !== 'command' ||
      input.command.type !== 'PLAY_DEV_CARD' ||
      input.command.card !== 'roadBuilding'
    )
      continue;
    const roadsBefore = before.board.roads.filter((road) => road.seat === input.seat).length;
    const roadsAfter = state.board.roads.filter((road) => road.seat === input.seat).length;
    const slot = state.seats
      .find((player) => player.seat === input.seat)
      ?.cardSlots.find((card) => card.slotId === input.command.slotId);
    if (
      roadsBefore === 15 &&
      roadsAfter === roadsBefore &&
      slot?.revealed === 'roadBuilding' &&
      state.turn.phase.at(-1)?.id !== 'roadBuilding'
    )
      return true;
  }
  return false;
}

describe('golden replays', () => {
  test('manifest contains all required coverage fixtures exactly once', () => {
    expect(entries).toHaveLength(20);
    expect(new Set(entries.map(({ name }) => name)).size).toBe(entries.length);
    expect(new Set(entries.map(({ file }) => file)).size).toBe(entries.length);
    expect(readdirSync(directory).filter((file) => file.endsWith('.replay.json'))).toHaveLength(
      entries.length,
    );
    const features = new Set(entries.flatMap(({ features: declared }) => declared));
    for (const feature of [
      'normal-completion',
      'longest-road-win',
      'largest-army-win',
      'hidden-vp-win',
      'bank-shortage',
      'friendly-robber-restriction',
      'balanced-dice',
      'all-development-card-types',
      'road-building-no-legal-spots',
    ])
      expect(features.has(feature), `missing ${feature}`).toBe(true);
  });

  test.each(entries)('$name replays and matches every canonical checkpoint', (entry) => {
    const replay = readFixture(entry);
    const seed = fromBase64Url(replay.genesisSeed);
    expect(seed).toHaveLength(32);
    let state = engine.createGame(replay.config, seed);
    let privates = new Map(
      replay.config.seats.map((seat) => [seat, engine.createPrivateState(seat)] as const),
    );
    expect(replay.engineVersion).toBe(state.engineVersion);
    expect(entry.engineVersion).toBe(state.engineVersion);
    expect(engine.checkInvariants(state)).toEqual([]);
    expect(engine.checkPrivateInvariants(state, privates)).toEqual([]);
    const checkpoints = new Map(
      replay.checkpoints.map(({ index, stateHash }) => [index, stateHash]),
    );
    expect(checkpoints.get(0)).toBe(toHex(hashValue(state)));
    for (let index = 0; index < replay.inputs.length; index += 1) {
      const input = replay.inputs[index];
      if (!input) throw new Error(`Missing golden replay input ${index}`);
      const applied = engine.apply(state, input);
      if (!applied.ok)
        throw new Error(
          `Golden replay ${entry.file} input ${index} rejected: ${applied.error.message}`,
        );
      const batchedPrivates = engine.applyAllPrivates(privates, state, input);
      if (!batchedPrivates.ok)
        throw new Error(
          `Golden replay ${entry.file} batch private input ${index} rejected: ${batchedPrivates.error.message}`,
        );
      const nextPrivates = new Map(privates);
      for (const seat of replay.config.seats) {
        const previous = privates.get(seat);
        if (!previous) throw new Error(`Missing private state for seat ${seat}`);
        const next = engine.applyPrivate(previous, state, input);
        if (!next.ok)
          throw new Error(
            `Golden replay ${entry.file} private input ${index} rejected for seat ${seat}: ${next.error.message}`,
          );
        nextPrivates.set(seat, next.value);
      }
      expect(batchedPrivates.value).toEqual(nextPrivates);
      state = applied.value.state;
      privates = nextPrivates;
      expect(engine.checkInvariants(state)).toEqual([]);
      expect(engine.checkPrivateInvariants(state, privates)).toEqual([]);
      expect(state.result !== null || engine.getPending(state).length > 0).toBe(true);
      const expected = checkpoints.get(index + 1);
      expect(expected === undefined || toHex(hashValue(state)) === expected).toBe(true);
    }
    const hiddenCardsStayWithTheirOwner = state.seats.flatMap(({ seat, cardSlots }) =>
      cardSlots.map((slot) => {
        const ownerCard = privates.get(seat)?.slots[slot.slotId];
        if (slot.revealed) return ownerCard === undefined;
        const ownerHasCard = typeof ownerCard === 'string';
        return (
          ownerHasCard &&
          replay.config.seats
            .filter((other) => other !== seat)
            .every((other) => privates.get(other)?.slots[slot.slotId] === undefined)
        );
      }),
    );
    expect(hiddenCardsStayWithTheirOwner.every(Boolean)).toBe(true);
    expect(state.result?.winner ?? null).toBe(entry.winner);
    assertDeclaredFeatures(entry, replay, state);
  });

  test('manifest reports shortage and friendly-robber behavior from accepted transitions', () => {
    const shortage = entries.find((entry) => entry.features.includes('bank-shortage'));
    const friendly = entries.find((entry) =>
      entry.features.includes('friendly-robber-restriction'),
    );
    expect(shortage).toBeDefined();
    expect(friendly).toBeDefined();
    if (!shortage || !friendly) throw new Error('Required feature fixtures are missing');

    const shortageReplay = readFixture(shortage);
    let shortageState = engine.createGame(
      shortageReplay.config,
      fromBase64Url(shortageReplay.genesisSeed),
    );
    let foundShortage = false;
    for (const input of shortageReplay.inputs) {
      if (
        input.kind === 'system' &&
        input.type === 'DICE_RESULT' &&
        Array.isArray(input.dice) &&
        typeof input.dice[0] === 'number' &&
        typeof input.dice[1] === 'number' &&
        productionShortage(shortageState, input.dice[0] + input.dice[1])
      )
        foundShortage = true;
      const applied = engine.apply(shortageState, input);
      if (!applied.ok) throw new Error(`Shortage replay rejected: ${applied.error.message}`);
      shortageState = applied.value.state;
    }
    expect(foundShortage).toBe(true);

    const friendlyReplay = readFixture(friendly);
    let friendlyState = engine.createGame(
      friendlyReplay.config,
      fromBase64Url(friendlyReplay.genesisSeed),
    );
    let restrictedTarget = false;
    for (const input of friendlyReplay.inputs) {
      if (
        input.kind === 'command' &&
        input.command.type === 'MOVE_ROBBER' &&
        friendlyState.config.options.base
      ) {
        for (const hex of friendlyState.board.hexes) {
          if (hex.id === friendlyState.board.robberHex) continue;
          const probe: Input = {
            kind: 'command',
            seat: input.seat,
            command: { type: 'MOVE_ROBBER', hex: hex.id },
          };
          if (!engine.validate(friendlyState, probe).ok) restrictedTarget = true;
        }
      }
      const applied = engine.apply(friendlyState, input);
      if (!applied.ok) throw new Error(`Friendly robber replay rejected: ${applied.error.message}`);
      friendlyState = applied.value.state;
    }
    expect(restrictedTarget).toBe(true);
  });
});
