import { deflateRawSync } from 'node:zlib';
import { toBase64Url } from '@cp2p/codec';
import { engineForConfig } from '@cp2p/engine';
import { hexId } from '@cp2p/engine/geometry';
import { describe, expect, test } from 'vitest';
import { SCENARIOS, scenarioById, scenarioOfConfig } from '../scenarios.js';
import {
  MAP_LIMITS,
  MAP_PREFIX,
  autoTokens,
  decodeMap,
  defaultFogStack,
  defaultTokenBag,
  emptyMap,
  encodeMap,
  importMap,
  isCustomConfig,
  mapBoard,
  mapConfig,
  mapFromScenario,
  mapJson,
  mapOfConfig,
  mapSeatCounts,
  parseMapDef,
  randomiseMap,
  setupSpots,
  validateMap,
  widenSeats,
} from './index.js';
import type { MapDef, MapProblemCode } from './index.js';

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing');
  return value;
}

/** The standard fixed board as a map. */
function classic(): MapDef {
  return required(mapFromScenario(required(scenarioById('standard-fixed')), 'Classic'));
}

/** Four Isles as a map: seafaring, sea hexes, a pirate and setup areas. */
function isles(): MapDef {
  return required(mapFromScenario(required(scenarioById('four-isles')), 'Isles'));
}

const numbers = (m: MapDef) => m.hexes.map((h) => h.token ?? 0).toSorted((a, b) => a - b);
const codes = (problems: readonly { code: MapProblemCode }[]) => problems.map((p) => p.code);

describe('MapDef schema', () => {
  test('canonical form sorts hexes, harbors and setup areas', () => {
    const map = classic();
    const shuffled = { ...map, hexes: map.hexes.toReversed(), harbors: map.harbors.toReversed() };
    const parsed = parseMapDef(shuffled);
    expect(parsed.ok && mapJson(parsed.value)).toBe(mapJson(map));
    expect(mapJson(map)).not.toContain(' ');
  });

  test('rejects malformed maps', () => {
    const map = classic();
    for (const bad of [
      null,
      { ...map, v: 2 },
      { ...map, name: '' },
      { ...map, name: 'x'.repeat(MAP_LIMITS.name + 1) },
      { ...map, vpTarget: 40 },
      { ...map, seats: { min: 5, max: 3 } },
      { ...map, modules: ['frontier'] },
      { ...map, hexes: [...map.hexes, map.hexes[0]] },
      { ...map, hexes: [{ q: 0, r: 0, terrain: 'lava', token: null }] },
      { ...map, hexes: [{ q: 0, r: 0, terrain: 'forest', token: 7 }] },
      { ...map, harbors: [{ edge: 'e:0,0,E', kind: 'generic' }] },
      { ...map, robber: 'somewhere' },
      { ...map, extra: true },
    ])
      expect(parseMapDef(bad).ok).toBe(false);
  });
});

describe('share string codec', () => {
  test('round-trips through HXMAP1 and is compact', async () => {
    const maps = [classic(), isles()];
    const texts = await Promise.all(maps.map((map) => encodeMap(map)));
    for (const text of texts) expect(text).toMatch(/^HXMAP1\.[A-Za-z0-9_-]+$/);
    const decoded = await Promise.all(texts.map((text) => decodeMap(text)));
    expect(decoded.map((result) => result.ok && mapJson(result.value))).toEqual(
      maps.map((map) => mapJson(map)),
    );
    expect(texts[0]?.startsWith(MAP_PREFIX)).toBe(true);
    expect((await encodeMap(classic())).length).toBeLessThan(700);
  });

  test('imports a string, a link carrying one, or JSON', async () => {
    const map = classic();
    const text = await encodeMap(map);
    const imported = await Promise.all(
      [`  ${text}\n`, `https://playhexfield.com/#/editor?map=${text}`, mapJson(map)].map((input) =>
        importMap(input),
      ),
    );
    for (const result of imported) expect(result.ok && mapJson(result.value)).toBe(mapJson(map));
  });

  test('refuses malformed, damaged and oversized input without throwing', async () => {
    const bad = [
      'hello',
      'HXMAP2.abc',
      `${MAP_PREFIX}!!!`,
      `${MAP_PREFIX}${toBase64Url(Uint8Array.of(1, 2, 3))}`,
      `${MAP_PREFIX}${toBase64Url(deflateRawSync(Buffer.from('not json')))}`,
      `${MAP_PREFIX}${toBase64Url(deflateRawSync(Buffer.from('{"v":1}')))}`,
      `${MAP_PREFIX}${'A'.repeat(MAP_LIMITS.shareChars)}`,
    ];
    const results = await Promise.all(bad.map((text) => decodeMap(text)));
    expect(results.map((result) => result.ok)).toEqual(bad.map(() => false));
    // A deflate bomb inflates past the JSON limit and is stopped while streaming.
    const bomb = deflateRawSync(Buffer.alloc(MAP_LIMITS.jsonBytes * 4, 32));
    const refused = await decodeMap(`${MAP_PREFIX}${toBase64Url(bomb)}`);
    expect(!refused.ok && refused.error.code).toBe('MAP_TOO_LARGE');
    expect((await importMap(`{"v":1,"pad":"${'x'.repeat(MAP_LIMITS.jsonBytes)}"}`)).ok).toBe(false);
  });
});

describe('validation', () => {
  test('every fixed scenario board validates without errors', () => {
    for (const scenario of SCENARIOS) {
      const map = mapFromScenario(scenario, scenario.id);
      if (!map) continue;
      expect({ id: scenario.id, errors: codes(validateMap(map).errors) }).toEqual({
        id: scenario.id,
        errors: [],
      });
    }
  });

  test('the engine dry run accepts good maps and reports what genesis refuses', () => {
    expect(codes(validateMap(classic(), { engine: true }).errors)).toEqual([]);
    expect(codes(validateMap(isles(), { engine: true }).errors)).toEqual([]);
  }, 20_000);

  test('an empty map has no land', () => {
    expect(codes(validateMap(emptyMap()).errors)).toEqual(['no-land']);
  });

  test('tokens: missing, on the desert, and too many of one number', () => {
    const map = classic();
    const missing = {
      ...map,
      hexes: map.hexes.map((hex, i) => (i === 1 ? { ...hex, token: null } : hex)),
    };
    expect(codes(validateMap(missing).errors)).toContain('missing-token');
    const desert = {
      ...map,
      hexes: map.hexes.map((hex) =>
        hex.terrain === 'desert' ? { ...hex, token: 5 as const } : hex,
      ),
    };
    expect(codes(validateMap(desert).errors)).toContain('token-on-tokenless');
    const sixes = {
      ...map,
      hexes: map.hexes.map((hex) => (hex.token === null ? hex : { ...hex, token: 6 as const })),
    };
    const report = validateMap(sixes);
    expect(codes(report.errors)).toContain('too-many-of-number');
    expect(codes(report.warnings)).toContain('adjacent-red');
  });

  test('land beyond the water is unreachable without ships, and reachable with them', () => {
    const map = classic();
    const island = {
      ...map,
      hexes: [...map.hexes, { q: 6, r: 0, terrain: 'forest' as const, token: 5 as const }],
    };
    const report = validateMap(island);
    expect(report.errors.find((p) => p.code === 'unreachable-land')?.hexes).toEqual(['h:6,0']);
    const sea = isles();
    expect(codes(validateMap(sea).errors)).toEqual([]);
    // A home island in open sea reaches everything the water touches, but not an island beyond it.
    const home = required(sea.setupAreas);
    expect(codes(validateMap({ ...sea, setupAreas: [home[0] ?? ''] }).errors)).not.toContain(
      'unreachable-land',
    );
    const stranded = {
      ...sea,
      hexes: [...sea.hexes, { q: 30, r: 0, terrain: 'forest' as const, token: 5 as const }],
    };
    expect(validateMap(stranded).errors.find((p) => p.code === 'unreachable-land')?.hexes).toEqual([
      'h:30,0',
    ]);
  });

  test('harbors: inland, facing one water hex twice, or sharing a corner', () => {
    const map = classic();
    const inland = { ...map, harbors: [{ edge: 'e:0,0,NE', kind: 'generic' as const }] };
    expect(validateMap(inland).errors.find((p) => p.code === 'harbor-not-coastal')?.edges).toEqual([
      'e:0,0,NE',
    ]);
    // Two sides of the corner hex h:2,-2 that face the same sea hex across its NE corner.
    const crowded = {
      ...map,
      harbors: [
        { edge: 'e:2,-2,NE', kind: 'generic' as const },
        { edge: 'e:2,-2,NW', kind: 'ore' as const },
      ],
    };
    expect(codes(validateMap(crowded).errors)).toContain('harbor-shared-vertex');
  });

  test('robber, pirate, setup areas and seats', () => {
    const map = classic();
    expect(codes(validateMap({ ...map, robber: null }).errors)).toContain('robber-missing');
    expect(codes(validateMap({ ...map, robber: 'h:9,9' }).errors)).toContain('robber-not-land');
    expect(codes(validateMap({ ...map, pirate: 'h:0,0' }).errors)).toContain('pirate-not-sea');
    expect(codes(validateMap({ ...map, setupAreas: ['h:0,0'] }).errors)).toContain(
      'setup-needs-seafaring',
    );
    const sea = isles();
    expect(
      codes(validateMap({ ...sea, pirate: required(sea.setupAreas)[0] ?? '' }).errors),
    ).toContain('pirate-not-sea');
    expect(codes(validateMap({ ...sea, seats: { min: 2, max: 2 } }).errors)).toContain(
      'seats-too-few',
    );
  });

  test('a three-hex map has no room for four players to set up', () => {
    const tiny: MapDef = {
      ...emptyMap('Tiny'),
      seats: { min: 2, max: 4 },
      hexes: [
        { q: 0, r: 0, terrain: 'forest', token: 5 },
        { q: 1, r: 0, terrain: 'hills', token: 9 },
        { q: 0, r: 1, terrain: 'fields', token: 4 },
      ],
      robber: 'h:0,0',
    };
    expect(setupSpots(tiny)).toBeLessThan(8);
    expect(codes(validateMap(tiny).errors)).toContain('setup-too-small');
    expect(codes(validateMap({ ...tiny, seats: { min: 2, max: 2 } }).errors)).toEqual([]);
  });

  test('fog needs a stack that covers the fog hexes and numbers its land', () => {
    const map = required(mapFromScenario(required(scenarioById('fogbound')), 'Fog'));
    expect(codes(validateMap(map).errors)).toEqual([]);
    expect(codes(validateMap({ ...map, fog: null }).errors)).toContain('fog-stack-mismatch');
    const fog = required(map.fog);
    expect(
      codes(validateMap({ ...map, fog: { ...fog, tokens: { ...fog.tokens, '5': 9 } } }).errors),
    ).toContain('fog-tokens-mismatch');
  });

  test('seafaring terrain needs the module', () => {
    const map = classic();
    const gold = {
      ...map,
      hexes: map.hexes.map((hex, i) => (i === 0 ? { ...hex, terrain: 'gold' as const } : hex)),
    };
    expect(codes(validateMap(gold).errors)).toContain('terrain-needs-seafaring');
  });
});

describe('solver and randomiser', () => {
  test('the default bag repeats the base numbers', () => {
    expect(defaultTokenBag(18).toSorted((a, b) => a - b)).toEqual([
      2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12,
    ]);
  });

  test('auto tokens keep the numbers and remove every adjacency warning', () => {
    const map = classic();
    const bunched = {
      ...map,
      hexes: map.hexes.map((hex, i) => (i === 3 ? { ...hex, token: null } : hex)),
    };
    const solved = autoTokens(bunched, 5);
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(codes(validateMap(solved.value).warnings)).not.toContain('adjacent-red');
    expect(codes(validateMap(solved.value).errors)).toEqual([]);
    const kept = autoTokens(map, 9);
    expect(kept.ok && numbers(kept.value)).toEqual(numbers(map));
    expect(autoTokens(map, 9)).toEqual(kept);
  });

  test('a default fog stack fits its fog hexes', () => {
    const map = required(mapFromScenario(required(scenarioById('fogbound')), 'Fog'));
    const fogHexes = map.hexes.filter((hex) => hex.terrain === 'fog').length;
    expect(codes(validateMap({ ...map, fog: defaultFogStack(fogHexes) }).errors)).toEqual([]);
  });

  test('randomise deals a playable map on any shape', () => {
    for (const [source, seed] of [
      [classic(), 1],
      [isles(), 2],
    ] as const) {
      const map = randomiseMap(source, seed);
      expect(map.ok).toBe(true);
      if (!map.ok) continue;
      expect(map.value.hexes.map(hexId)).toEqual(source.hexes.map(hexId));
      expect(codes(validateMap(map.value).errors)).toEqual([]);
    }
  });
});

describe('lobby configs', () => {
  test('a map builds a signed-config board every engine accepts, and is recognised again', () => {
    const map = { ...classic(), seats: { min: 2, max: 6 } };
    expect(mapSeatCounts(map)).toEqual([2, 3, 4, 5, 6]);
    for (const seats of [2, 4, 5, 6]) {
      const config = mapConfig(map, seats, { base: { vpTarget: 9 } });
      if (!config.ok) throw new Error(config.error.message);
      expect(config.value.board).toEqual(mapBoard(map));
      expect(config.value.options.base).toMatchObject({ mapLayout: 'custom', vpTarget: 9 });
      expect(config.value.modules.map((m) => m.id)).toEqual(
        seats > 4 ? ['base', 'five-six'] : ['base'],
      );
      expect(isCustomConfig(config.value)).toBe(true);
      expect(scenarioOfConfig(config.value)).toBeUndefined();
      const state = engineForConfig(config.value).createGame(config.value, new Uint8Array(32));
      expect(state.board.hexes).toHaveLength(19);
      const back = required(mapOfConfig(config.value, map.name));
      expect(mapBoard(back)).toEqual(mapBoard(map));
      expect(widenSeats(back).seats).toEqual({ min: 2, max: 6 });
    }
    expect(mapConfig(map, 7).ok).toBe(false);
  });

  test('seafaring and knights maps carry their options and rules module', () => {
    const map = { ...isles(), modules: ['seafaring', 'knights'] as MapDef['modules'] };
    const config = mapConfig(map, 4);
    if (!config.ok) throw new Error(config.error.message);
    expect(config.value.modules.map((m) => m.id)).toContain('scenario:seafarers-knights');
    expect(config.value.options.seafaring).toMatchObject({
      pirateHex: map.pirate,
      setupAreas: map.setupAreas,
    });
    expect(mapOfConfig(config.value, 'Isles')?.modules).toEqual(['seafaring', 'knights']);
    expect(codes(validateMap(map).errors)).toEqual([]);
  });
});
