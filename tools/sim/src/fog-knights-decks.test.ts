import { scalarToBytes } from '@cp2p/crypto';
import { knightsExt } from '@cp2p/engine';
import type { Engine, GameState, Seat } from '@cp2p/engine';
import { FOGBOUND_FOG, scenarioById, scenarioConfig } from '@cp2p/maps';
import { genesisDeckDefinitions, replayCertifiedPrefix } from '@cp2p/protocol';
import { certifyPublicDraws, createTerminalAuditFixture } from '@cp2p/protocol/testing';
import { describe, expect, test } from 'vitest';

const scenario = scenarioById('fogbound-knights');
if (!scenario) throw new Error('Missing fogbound-knights');
const config = scenarioConfig(scenario, 3);
const FOG_DECKS = ['fog-terrain', 'fog-token'];
const PROGRESS_DECKS = ['progress-politics', 'progress-science', 'progress-trade'];

/** The first fog hexes waiting in the fog frame, as after a ship that touches them. */
function revealFirstHexes(state: GameState, count: number): GameState {
  const hexes = state.board.hexes
    .filter((hex) => hex.terrain === 'fog')
    .map((hex) => hex.id)
    .toSorted()
    .slice(0, count);
  const ext = state.ext.seafaring;
  if (typeof ext !== 'object' || ext === null) throw new Error('Missing seafaring state');
  return {
    ...state,
    ext: { ...state.ext, seafaring: { ...ext, fog: { seat: 0, hexes, terrain: null } } },
    turn: {
      ...state.turn,
      phase: [...state.turn.phase, { id: 'fogReveal', module: 'seafaring', data: null }],
    },
  };
}

const drawnFrom = (state: GameState, decks: readonly string[]) =>
  decks.reduce((sum, deck) => sum + (state.decks[deck]?.drawn.length ?? 0), 0);

/**
 * Test-only rules: every seat starts at level 3 on each improvement track, so gate faces of the
 * event die deal progress cards early, and seat 0's first setup road also touches two fog hexes
 * (as a setup ship beside the fog would), so a public fog draw follows the deck ceremony.
 */
function foggyAndProgressive(engine: Engine): Engine {
  return {
    ...engine,
    createGame(genesisConfig, seed) {
      const state = engine.createGame(genesisConfig, seed);
      const ext = knightsExt(state);
      return {
        ...state,
        ext: {
          ...state.ext,
          knights: {
            ...ext,
            improvements: ext.improvements.map(() => ({ trade: 3, politics: 3, science: 3 })),
          },
        },
      };
    },
    apply(state, input) {
      const applied = engine.apply(state, input);
      const firstRoad =
        input.kind === 'command' &&
        input.seat === 0 &&
        input.command.type === 'PLACE_ROAD' &&
        drawnFrom(state, FOG_DECKS) === 0 &&
        state.turn.phase.every((frame) => frame.id !== 'fogReveal');
      if (!applied.ok || !firstRoad) return applied;
      return {
        ...applied,
        value: { ...applied.value, state: revealFirstHexes(applied.value.state, 2) },
      };
    },
  };
}

const master = (seat: Seat): Uint8Array => scalarToBytes(BigInt(29 + seat));

const yieldTask = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('Fogbound with knights over the verified deck ceremony', () => {
  test('the public fog stacks and the private progress decks are committed side by side', async () => {
    const certified = await certifyPublicDraws({
      seed: 41,
      config,
      master,
      prepare: (state) => revealFirstHexes(state, 3),
    });
    // The fog draws went through the certified public path while the progress decks sat unused.
    const decks = certified.draws.map((draw) => draw.deck);
    expect(new Set(decks)).toEqual(new Set(FOG_DECKS));
    for (const draw of certified.draws) {
      const declared = draw.deck === 'fog-terrain' ? FOGBOUND_FOG.terrains : FOGBOUND_FOG.tokens;
      expect(Reflect.get(declared, draw.card)).toBeGreaterThan(0);
    }
    expect(drawnFrom(certified.state, PROGRESS_DECKS)).toBe(0);
    expect(certified.state.ext.seafaring).toMatchObject({ fog: null });
  }, 300_000);

  test('one verified game draws a fog tile in public and progress cards in private', async () => {
    const fixture = await createTerminalAuditFixture({
      config,
      simulationSeed: 5,
      humanCount: 2,
      prioritizeDevBuy: false,
      wrapEngine: foggyAndProgressive,
      maxElapsedMs: 1_500_000,
      maxSteps: 600,
      yieldTask,
      stopWhen: (state) => drawnFrom(state, FOG_DECKS) > 0 && drawnFrom(state, PROGRESS_DECKS) > 0,
    });
    const payload = fixture.genesisEntry.payload;
    if (payload.kind !== 'genesis') throw new Error('Missing genesis payload');
    const decks = genesisDeckDefinitions(payload.genesis);
    if (!decks.ok) throw new Error(decks.error.message);
    expect(decks.value.map((deck) => deck.deckId).toSorted()).toEqual(
      [...FOG_DECKS, ...PROGRESS_DECKS].toSorted(),
    );
    const state = fixture.finalState;
    expect(drawnFrom(state, FOG_DECKS)).toBeGreaterThan(0);
    expect(drawnFrom(state, PROGRESS_DECKS)).toBeGreaterThan(0);
    // The fog tiles are public: the first fog hexes now show a tile from the stack.
    const fog = new Set(
      (config.board?.hexes ?? []).filter((hex) => hex.terrain === 'fog').map((hex) => hex.id),
    );
    const shown = state.board.hexes.filter((hex) => fog.has(hex.id) && hex.terrain !== 'fog');
    expect(shown.length).toBeGreaterThanOrEqual(2);
    for (const hex of shown)
      expect(Reflect.get(FOGBOUND_FOG.terrains, hex.terrain)).toBeGreaterThan(0);
    // Every certified entry replays under the same rules.
    const replay = replayCertifiedPrefix(
      fixture.genesisEntry,
      fixture.entries,
      fixture.engine,
      fixture.policy,
    );
    if (!replay.ok) throw new Error(replay.error.message);
    expect(replay.value.context.log.state.decks).toEqual(state.decks);
  }, 1_800_000);
});
