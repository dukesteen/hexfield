import { hashValue, toHex } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import type { Result } from '@cp2p/engine';
import {
  encodeMap,
  mapConfig,
  mapFromScenario,
  randomiseMap,
  scenarioById,
  validateMap,
} from '@cp2p/maps';
import type { MapDef } from '@cp2p/maps';
import { LobbyController } from '@cp2p/protocol';
import { createMemnet } from '@cp2p/protocol/testing';
import { describe, expect, test } from 'vitest';
import { runNetworkGame } from './net.js';
import { runGame } from './run-game.js';

const HEAVY = process.env.CP2P_HEAVY_TESTS === '1';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** A 23-hex base map in a shape no scenario has: a long island with a bay. */
function longIsland(): MapDef {
  const cells: [number, number][] = [];
  for (let r = -2; r <= 2; r++) for (let q = -3; q <= 2; q++) cells.push([q, r]);
  const bay = new Set(['0,-2', '1,-2', '-1,2', '2,2', '-3,-2', '-3,-1', '2,0']);
  const map: MapDef = {
    v: 1,
    name: 'Long island',
    modules: [],
    seats: { min: 2, max: 6 },
    vpTarget: 10,
    hexes: cells
      .filter(([q, r]) => !bay.has(`${q},${r}`))
      .map(([q, r]) => ({ q, r, terrain: 'forest', token: null })),
    harbors: [
      { edge: 'e:-2,-2,NW', kind: 'generic' },
      { edge: 'e:2,-1,NE', kind: 'ore' },
      { edge: 'e:-3,2,W', kind: 'wool' },
    ],
    robber: 'h:0,0',
    pirate: null,
    setupAreas: null,
    fog: null,
  };
  const dealt = value(randomiseMap(map, 17));
  expect(validateMap(dealt, { engine: true }).errors).toEqual([]);
  return dealt;
}

/** Four Isles, re-dealt: a seafaring map with its own tiles and numbers. */
function redealtIsles(modules: MapDef['modules'] = ['seafaring']): MapDef {
  const isles = mapFromScenario(scenarioById('four-isles') ?? SCENARIO_MISSING(), 'Isles');
  if (!isles) throw new Error('Four Isles has a fixed board');
  const dealt = value(randomiseMap({ ...isles, modules }, 5));
  expect(validateMap(dealt, { engine: true }).errors).toEqual([]);
  return dealt;
}

function SCENARIO_MISSING(): never {
  throw new Error('Missing scenario');
}

describe('custom maps in the engine', () => {
  test('random bots finish base, five-six and knights games on an editor map with invariants on', () => {
    const map = longIsland();
    for (const [seats, modules] of [
      [3, []],
      [4, ['knights']],
      [5, []],
    ] as const) {
      const config = value(mapConfig({ ...map, modules: [...modules] }, seats));
      const result = runGame({ seed: 41, gameIndex: seats, config });
      expect(result.state.result).not.toBeNull();
      expect(result.state.board.hexes).toHaveLength(map.hexes.length);
    }
  }, 240_000);

  test('random bots finish seafaring games on an editor map, with and without knights', () => {
    for (const modules of [['seafaring'], ['seafaring', 'knights']] as const) {
      const map = redealtIsles([...modules]);
      for (const seats of [3, 4]) {
        const result = runGame({
          seed: 43,
          gameIndex: seats,
          config: value(mapConfig(map, seats)),
        });
        expect(result.state.result).not.toBeNull();
        expect(result.stats.commands.BUILD_SHIP ?? 0).toBeGreaterThan(0);
      }
    }
  }, 240_000);
});

describe('custom maps between peers', () => {
  test('the lobby replicates a custom map board and options byte for byte', () => {
    const keys = [1, 2].map((number) => new Uint8Array(32).fill(number));
    const peers = keys.map((key) => identityFromSecret(key).peerId);
    const net = createMemnet({ peers });
    const [hostKey, guestKey, hostPeer, guestPeer] = [keys[0], keys[1], peers[0], peers[1]];
    if (!hostKey || !guestKey || !hostPeer || !guestPeer) throw new Error('Missing keys');
    const config = value(mapConfig(redealtIsles(), 4));
    const host = value(
      LobbyController.createHost({
        lobbyId: 'room_map',
        name: 'Map',
        hostName: 'Avery',
        config,
        transport: net.transport(hostPeer),
        clock: net.clock,
        secretKey: hostKey,
      }),
    );
    const guest = value(
      LobbyController.join({
        lobbyId: 'room_map',
        hostPeer,
        transport: net.transport(guestPeer),
        clock: net.clock,
        secretKey: guestKey,
      }),
    );
    try {
      net.clock.advanceBy(0);
      const replicated = guest.state()?.config;
      expect(toHex(hashValue(replicated ?? null))).toBe(toHex(hashValue(config)));
    } finally {
      host.dispose();
      guest.dispose();
      net.dispose();
    }
  }, 30_000);

  // Four peers run the real sessions, signatures, wire encoding and journals (stub randomness) on a
  // map passed as its share string: every peer decodes it, builds the same genesis and agrees on
  // every certified entry. A short race to 3 points keeps the regular run fast; the full game is
  // opt-in (`CP2P_HEAVY_TESTS=1`, about two minutes).
  test.each([
    [3, false],
    [10, true],
  ] as const)(
    'four peers certify a game to %i points on a map shared as a string',
    async (vpTarget, heavy) => {
      if (heavy && !HEAVY) return;
      const text = await encodeMap({ ...longIsland(), vpTarget, seats: { min: 4, max: 4 } });
      const result = await runNetworkGame({ seed: 42, gameIndex: 0, scenario: 1, map: text });
      expect(result.map?.id).toBe('custom');
      expect(result.finalStateHash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.map?.inputCounts.PLACE_SETTLEMENT).toBe(8);
      expect(result.map?.inputCounts.END_TURN ?? 0).toBeGreaterThan(0);
    },
    300_000,
  );
});
