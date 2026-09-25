import { describe, expect, test } from 'vitest';
import type { GameConfig } from '@cp2p/engine';
import { standardFixedBoard } from '@cp2p/maps';
import { LocalSession } from '../session/local-session.js';
import type { GamePresentation } from './repositories/saved-games.js';
import { createLocalReplay, parseLocalImport, parseLocalReplay } from './transfers.js';

const config: GameConfig = {
  modules: [{ id: 'base', version: '1.0.0' }],
  seats: [0, 1, 2],
  options: { base: { mapLayout: 'standard-fixed' } },
  board: standardFixedBoard(),
};

const presentation: GamePresentation = {
  players: [
    { seat: 0, name: 'Ari', color: 'blue', shape: 'circle' },
    { seat: 1, name: 'Bea', color: 'orange', shape: 'triangle' },
    { seat: 2, name: 'Cai', color: 'green', shape: 'square' },
  ],
  botDelayMs: 500,
};

async function playedSave() {
  const made = LocalSession.create({
    config,
    humanSeats: [0, 1, 2],
    botSeats: [],
    genesisSeed: new Uint8Array(32).fill(7),
  });
  if (!made.ok) throw new Error(made.error.message);
  const session = made.value;
  try {
    const pending = session.getPending().find((item) => item.kind === 'player');
    if (pending?.kind !== 'player') throw new Error('Setup choice missing');
    const command = session.getLegalCommands(pending.seat).commands[0];
    if (!command) throw new Error('Setup command missing');
    const applied = await session.submit(pending.seat, command);
    if (!applied.ok) throw new Error(applied.error.message);
    return session.exportSave();
  } finally {
    session.dispose();
  }
}

describe('local replay transfer', () => {
  test('exports batch boundaries and imports a verified replay with presentation', async () => {
    const save = await playedSave();
    const replay = createLocalReplay(save, presentation);
    expect(replay.inputs.length).toBeGreaterThan(save.genesis.length);
    expect(replay.save.batches).toHaveLength(1);
    expect(parseLocalReplay(JSON.parse(JSON.stringify(replay)) as unknown)).toEqual(replay);
    expect(parseLocalImport(replay)).toEqual({ save, presentation });
    expect(parseLocalImport(save)).toEqual({ save });
  });

  test('rejects envelope, input-log, hash, role, and presentation tampering', async () => {
    const replay = createLocalReplay(await playedSave(), presentation);
    expect(() => parseLocalImport({ ...replay, v: 1 })).toThrow(/Expected 2/);
    expect(() => parseLocalImport({ ...replay, inputs: [] })).toThrow(/Replay envelope differs/);
    expect(() => parseLocalImport({ ...replay, finalHash: '00' })).toThrow(
      /Replay envelope differs/,
    );
    expect(() =>
      parseLocalImport({ ...replay, save: { ...replay.save, finalHash: '0'.repeat(64) } }),
    ).toThrow(/Saved final hash differs/);
    expect(() =>
      parseLocalImport({
        ...replay,
        presentation: { ...presentation, players: presentation.players.slice(1) },
      }),
    ).toThrow(/presentation seats differ/);
    expect(() =>
      parseLocalImport({
        ...replay,
        save: {
          ...replay.save,
          roles: { humanSeats: [0, 1], botSeats: [] },
        },
      }),
    ).toThrow(/exactly one human or bot role/);
  });
});
