import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'vitest';
import { createBaseEngine } from '@cp2p/engine';
import { hashValue, toHex } from '@cp2p/codec';
import { failureMatches, main, replayCommand } from './cli.js';
import { runBatch } from './batch.js';
import { makeReplay, verifyReplay, writeReplay } from './replay.js';
import { runGame } from './run-game.js';

describe('failure replay', () => {
  test('recognizes recorded trace invariant failures by their observed result', () => {
    expect(failureMatches('trace-public-violation', 'invariant-violation')).toBe(true);
    expect(failureMatches('trace-invariant-throw', 'invariant-throw')).toBe(true);
    expect(failureMatches('trace-public-violation', 'accepted-valid')).toBe(false);
    expect(failureMatches('trace-invariant-throw', 'invariant-violation')).toBe(false);
  });

  test('rejects zero games before spawning workers', async () => {
    await expect(main(['run', '--games', '0', '--parallel', '4'])).rejects.toThrow(
      '--games must be positive',
    );
  });

  test('requires one worker for per-game latency benchmarks', async () => {
    await expect(main(['bench', '--games', '1', '--parallel', '2'])).rejects.toThrow(
      'Benchmark requires --parallel 1',
    );
  });

  test('a mutation rejected by current rules no longer reproduces accepted-invalid', () => {
    const game = runGame({ seed: 42, gameIndex: 0, players: 3, baseOptions: { vpTarget: 3 } });
    const directory = mkdtempSync(join(tmpdir(), 'cp2p-replay-'));
    const replayPath = join(directory, 'fixed.replay.json');
    writeReplay(
      replayPath,
      makeReplay(createBaseEngine(), game.config, game.genesisSeed, game.inputs),
    );
    writeFileSync(
      join(directory, 'fixed.failure.json'),
      JSON.stringify({
        source: 'fuzz',
        category: 'accepted-invalid',
        message: 'Invalid mutation was accepted',
        stateHash: toHex(hashValue(game.state)),
        attemptedInput: { kind: 'command', seat: 0, command: { type: '__unknown__' } },
      }),
    );
    expect(replayCommand(replayPath)).toMatchObject({
      category: 'accepted-invalid',
      observed: 'rejected',
      reproduced: false,
    });
    writeFileSync(
      join(directory, 'fixed.failure.json'),
      JSON.stringify({
        source: 'fuzz',
        category: 'accepted-invalid',
        stateHash: 'wrong-state-hash',
        attemptedInput: { kind: 'command', seat: 0, command: { type: '__unknown__' } },
      }),
    );
    expect(replayCommand(replayPath)).toMatchObject({
      observed: 'different-state',
      reproduced: false,
    });
  });

  test('accepted-invalid means validation accepted the recorded input', () => {
    const game = runGame({ seed: 42, gameIndex: 0, players: 3, baseOptions: { vpTarget: 3 } });
    const engine = createBaseEngine();
    const first = game.inputs[0];
    if (!first) throw new Error('Game has no inputs');
    const directory = mkdtempSync(join(tmpdir(), 'cp2p-accepted-replay-'));
    const replayPath = join(directory, 'accepted.replay.json');
    writeReplay(replayPath, makeReplay(engine, game.config, game.genesisSeed, []));
    writeFileSync(
      join(directory, 'accepted.failure.json'),
      JSON.stringify({
        source: 'fuzz',
        category: 'accepted-invalid',
        stateHash: toHex(hashValue(engine.createGame(game.config, game.genesisSeed))),
        originalInput: first,
        attemptedInput: first,
      }),
    );
    expect(replayCommand(replayPath)).toMatchObject({ observed: 'validated', reproduced: true });
  });

  test('a local card deal uses its recorded private identity when the mutant omits it', () => {
    let game: ReturnType<typeof runGame> | undefined;
    let dealIndex = -1;
    for (let gameIndex = 0; gameIndex < 10; gameIndex++) {
      const candidate = runGame({ seed: 42, gameIndex });
      const index = candidate.inputs.findIndex(
        (input) => input.kind === 'system' && input.type === 'CARD_DEALT',
      );
      if (index >= 0) {
        game = candidate;
        dealIndex = index;
        break;
      }
    }
    if (!game || dealIndex < 0) throw new Error('Expected a real local card deal');
    const original = game.inputs[dealIndex];
    if (!original || original.kind !== 'system' || original.type !== 'CARD_DEALT')
      throw new Error('Expected CARD_DEALT');
    const { card: _card, ...withoutCard } = original;
    const engine = createBaseEngine();
    const directory = mkdtempSync(join(tmpdir(), 'cp2p-private-replay-'));
    const replayPath = join(directory, 'private.replay.json');
    const prefix = makeReplay(
      engine,
      game.config,
      game.genesisSeed,
      game.inputs.slice(0, dealIndex),
    );
    writeReplay(replayPath, prefix);
    const state = verifyReplay(engine, prefix);
    const sidecarPath = join(directory, 'private.failure.json');
    const sidecar = {
      source: 'fuzz',
      category: 'trace-private-rejected',
      stateHash: toHex(hashValue(state)),
      attemptedInput: withoutCard,
    };
    writeFileSync(sidecarPath, JSON.stringify(sidecar));
    expect(replayCommand(replayPath)).toMatchObject({
      observed: 'private-rejected',
      reproduced: true,
    });
    writeFileSync(sidecarPath, JSON.stringify({ ...sidecar, originalInput: original }));
    expect(replayCommand(replayPath)).toMatchObject({
      observed: 'accepted-valid',
      reproduced: false,
    });
  });

  test('dead-turn replay reruns the configured limit through LocalGame', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cp2p-dead-replay-'));
    const batch = runBatch({
      seed: 42,
      games: 1,
      players: 3,
      baseOptions: { vpTarget: 3 },
      maxTurns: 0,
      failuresDirectory: directory,
    });
    expect(batch.failures).toHaveLength(1);
    const failure = batch.failures[0];
    if (!failure) throw new Error('Expected a dead game');
    expect(replayCommand(failure.replayPath)).toMatchObject({
      category: 'dead-turn',
      observed: 'dead-turn',
      reproduced: true,
    });
  });
});
