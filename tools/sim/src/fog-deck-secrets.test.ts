import { hashValue, toHex } from '@cp2p/codec';
import { scalarToBytes } from '@cp2p/crypto';
import type { GameState, Seat } from '@cp2p/engine';
import { FOGBOUND_FOG, SCENARIOS, scenarioConfig } from '@cp2p/maps';
import { certifyPublicDraws } from '@cp2p/protocol/testing';
import { describe, expect, test } from 'vitest';

const scenario = SCENARIOS.find((item) => item.id === 'fogbound');
if (!scenario) throw new Error('Missing fogbound scenario');
const config = scenarioConfig(scenario, 3);
const GENESIS_SEED = 61;
/** Fog hexes revealed at once: enough terrain and token draws for two secrets to differ. */
const REVEALS = 5;

const masterA = (seat: Seat): Uint8Array => scalarToBytes(BigInt(17 + seat));
const masterB = (seat: Seat): Uint8Array => scalarToBytes(BigInt(1_017 + seat * 3));

/** One placement's worth of fog hexes waiting in the fog frame, as after a road or ship. */
function revealFirstHexes(state: GameState): GameState {
  const hexes = state.board.hexes
    .filter((hex) => hex.terrain === 'fog')
    .map((hex) => hex.id)
    .toSorted()
    .slice(0, REVEALS);
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

function run(master: (seat: Seat) => Uint8Array) {
  return certifyPublicDraws({
    seed: GENESIS_SEED,
    config,
    master,
    prepare: revealFirstHexes,
  });
}

/** What the hexes that were fog at genesis now show. */
const revealed = (initial: GameState, state: GameState) => {
  const hidden = new Set(
    initial.board.hexes.filter((hex) => hex.terrain === 'fog').map((hex) => hex.id),
  );
  return state.board.hexes
    .filter((hex) => hidden.has(hex.id) && hex.terrain !== 'fog')
    .map((hex) => `${hex.id}:${hex.terrain}:${String(hex.token)}`);
};

describe('fog contents come from the deck secrets, not the genesis seed', () => {
  test('two games with one genesis seed and different deck secrets reveal different fog tiles', async () => {
    const [a, b] = [await run(masterA), await run(masterB)];
    // Identical public genesis: the seed fixes the board, and only how many tiles are hidden.
    expect(toHex(hashValue(a.initial))).toBe(toHex(hashValue(b.initial)));
    expect(a.initial.board.hexes.filter((hex) => hex.terrain === 'fog')).toHaveLength(13);
    // Every draw went through the certified public path, terrain before token for a land tile.
    for (const game of [a, b]) {
      expect(game.draws.length).toBeGreaterThanOrEqual(REVEALS);
      expect(game.state.ext.seafaring).toMatchObject({ fog: null });
      expect(game.state.turn.phase.some((frame) => frame.id === 'fogReveal')).toBe(false);
    }
    const seen = (draws: typeof a.draws) => draws.map((draw) => `${draw.deck}:${draw.card}`);
    expect(seen(a.draws)).not.toEqual(seen(b.draws));
    const hexesA = revealed(a.initial, a.state);
    expect(hexesA).toHaveLength(REVEALS);
    expect(hexesA).not.toEqual(revealed(b.initial, b.state));
  }, 300_000);

  test('the same secrets reveal the same tiles, and every tile is one the stack holds', async () => {
    const [first, second] = [await run(masterA), await run(masterA)];
    expect(first.draws).toEqual(second.draws);
    expect(toHex(hashValue(first.state))).toBe(toHex(hashValue(second.state)));
    const declared: Record<string, Readonly<Record<string, number>>> = {
      'fog-terrain': FOGBOUND_FOG.terrains,
      'fog-token': FOGBOUND_FOG.tokens,
    };
    for (const draw of first.draws) expect(declared[draw.deck]?.[draw.card]).toBeGreaterThan(0);
  }, 300_000);
});
