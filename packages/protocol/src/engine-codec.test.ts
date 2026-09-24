import { describe, expect, test } from 'vitest';
import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { createEngine } from '@cp2p/engine';
import type { GameConfig, GameModule, Input } from '@cp2p/engine';

const module: GameModule = {
  id: 'replay-counter',
  version: '1',
  dependsOn: [],
  conflictsWith: [],
  optionsSchema: [],
  initState: () => ({ count: 0 }),
  initialPhase: () => ({ id: 'turn', module: 'replay-counter', data: null }),
  phases: {
    turn: { pending: () => [{ kind: 'player', seat: 0, allowed: ['INC'] }] },
  },
  commands: {
    INC: {
      validate: () => ({ ok: true, value: undefined }),
      apply: (state) => {
        const ext = state.ext['replay-counter'];
        if (
          typeof ext !== 'object' ||
          ext === null ||
          !('count' in ext) ||
          typeof ext.count !== 'number'
        ) {
          throw new Error('Invalid replay counter state');
        }
        return {
          state: { ...state, ext: { ...state.ext, 'replay-counter': { count: ext.count + 1 } } },
          events: [],
        };
      },
    },
  },
  systemInputs: {},
};

const config: GameConfig = {
  modules: [{ id: 'replay-counter', version: '1' }],
  seats: [0, 1],
  options: {},
};
const inputs: Input[] = [
  { kind: 'command', seat: 0, command: { type: 'INC' } },
  { kind: 'command', seat: 0, command: { type: 'INC' } },
];

describe('engine and canonical codec integration', () => {
  test('genesis and replay state encode canonically and hash equally', () => {
    const engine = createEngine([module]);
    const seed = new Uint8Array(32);
    const genesis = engine.createGame(config, seed);
    expect(canonicalDecode(canonicalEncode(genesis))).toEqual(genesis);

    const replay = () => {
      let state = engine.createGame(config, seed);
      for (const input of inputs) {
        const result = engine.apply(state, input);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error.message);
        state = result.value.state;
      }
      return state;
    };
    const first = replay();
    const second = replay();
    expect(first.counters.inputSeq).toBe(2);
    expect(canonicalDecode(canonicalEncode(first))).toEqual(first);
    expect(toHex(hashValue(first))).toBe(toHex(hashValue(second)));
    expect(engine.checkInvariants(first)).toEqual([]);
  });
});
