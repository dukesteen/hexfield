import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { createBaseEngine } from '@cp2p/engine';
import type { GameConfig } from '@cp2p/engine';
import { runGame, SimulationFailure } from './run-game.js';
import { readReplay, verifyReplay } from './replay.js';
import type { ReplayFile } from './replay.js';
import { DEFAULT_GOLDEN_CASES, updateGoldens } from './golden.js';

vi.mock('./run-game.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./run-game.js')>();
  return { ...actual, runGame: vi.fn<typeof actual.runGame>(actual.runGame) };
});

const runGameMock = vi.mocked(runGame);
const mockConfig: GameConfig = { modules: [], seats: [], options: {} };

describe('golden replay updates', () => {
  test('refuses to rewrite fixtures without the explicit update flag', () => {
    expect(() => updateGoldens({ update: false, cases: [] })).toThrow(
      'Golden replay updates require explicit update mode',
    );
    expect(() => updateGoldens({ cases: [] })).toThrow(
      'Golden replay updates require explicit update mode',
    );
  });

  test('rejects empty and duplicate fixture sets before starting games', () => {
    expect(() => updateGoldens({ update: true, cases: [] })).toThrow(
      'At least one golden case is required',
    );
    expect(() =>
      updateGoldens({
        update: true,
        cases: [
          { name: 'same', seed: 1, gameIndex: 0 },
          { name: 'same', seed: 1, gameIndex: 1 },
        ],
      }),
    ).toThrow('invalid or duplicated');
  });

  test('does not turn a private failure into a bank-shortage prefix', () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'cp2p-golden-private-failure-'));
    try {
      const shortageCase = DEFAULT_GOLDEN_CASES.find(({ name }) => name === 'bank-shortage');
      if (!shortageCase) throw new Error('No bank-shortage scenario is configured');
      const failure = new SimulationFailure(
        'private invariant failed',
        mockConfig,
        new Uint8Array(32),
        [],
        undefined,
        'private-failure',
      );
      runGameMock.mockImplementationOnce(() => {
        throw failure;
      });

      expect(() => updateGoldens({ update: true, outputDirectory, cases: [shortageCase] })).toThrow(
        failure,
      );
      expect(readdirSync(outputDirectory)).toEqual([]);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  test('generates and verifies the accepted bank-shortage prefix', () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'cp2p-golden-shortage-'));
    try {
      const shortageCase = DEFAULT_GOLDEN_CASES.find(({ name }) => name === 'bank-shortage');
      if (!shortageCase) throw new Error('No bank-shortage scenario is configured');
      updateGoldens({ update: true, outputDirectory, cases: [shortageCase] });
      const path = join(outputDirectory, 'bank-shortage.replay.json');
      const replay = readReplay(path);
      const state = verifyReplay(createBaseEngine(), replay);

      expect(state.result).toBeNull();
      expect(replay.inputs.length).toBeGreaterThan(100);
      expect(readdirSync(outputDirectory).toSorted()).toEqual([
        'bank-shortage.replay.json',
        'manifest.json',
      ]);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  test('builds the no-road-spots fixture through legal play from genesis', () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'cp2p-golden-'));
    try {
      const scenario = DEFAULT_GOLDEN_CASES.find(
        ({ name }) => name === 'road-building-no-legal-spots',
      );
      if (!scenario) throw new Error('No directed road-building scenario is configured');
      updateGoldens({ update: true, outputDirectory, cases: [scenario] });
      const replay = readReplay(join(outputDirectory, 'road-building-no-legal-spots.replay.json'));
      const state = verifyReplay(createBaseEngine(), replay);
      expect(state.result).toBeNull();
      expect(replay.inputs).toContainEqual(
        expect.objectContaining({
          kind: 'command',
          command: expect.objectContaining({ type: 'PLAY_DEV_CARD', card: 'roadBuilding' }),
        }),
      );
      expect(replay.inputs.length).toBeGreaterThan(100);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  test('rejects changed same-version baseline behavior before writing fixtures', () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'cp2p-golden-version-'));
    try {
      const scenario = DEFAULT_GOLDEN_CASES.find(
        ({ name }) => name === 'road-building-no-legal-spots',
      );
      if (!scenario) throw new Error('No directed road-building scenario is configured');
      updateGoldens({ update: true, outputDirectory, cases: [scenario] });
      const path = join(outputDirectory, 'road-building-no-legal-spots.replay.json');
      const baseline = readReplay(path);
      const altered: ReplayFile = {
        ...baseline,
        checkpoints: baseline.checkpoints.map((checkpoint, index) =>
          index === baseline.checkpoints.length - 1
            ? { ...checkpoint, stateHash: '0'.repeat(64) }
            : checkpoint,
        ),
      };
      writeFileSync(path, JSON.stringify(altered));
      const previousFile = readFileSync(path, 'utf8');

      expect(() => updateGoldens({ update: true, outputDirectory, cases: [scenario] })).toThrow(
        /bump engineVersion before updating baselines/,
      );
      expect(readFileSync(path, 'utf8')).toBe(previousFile);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  }, 60_000);

  test('regenerates baselines from an older engine version', () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'cp2p-golden-bump-'));
    try {
      const scenario = DEFAULT_GOLDEN_CASES.find(
        ({ name }) => name === 'road-building-no-legal-spots',
      );
      if (!scenario) throw new Error('No directed road-building scenario is configured');
      updateGoldens({ update: true, outputDirectory, cases: [scenario] });
      const path = join(outputDirectory, 'road-building-no-legal-spots.replay.json');
      const oldVersion = { ...readReplay(path), engineVersion: '0.0.9' };
      writeFileSync(path, JSON.stringify(oldVersion));

      updateGoldens({ update: true, outputDirectory, cases: [scenario] });

      expect(readReplay(path).engineVersion).toBe('0.1.0');
      expect(verifyReplay(createBaseEngine(), readReplay(path)).result).toBeNull();
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  }, 60_000);
});
