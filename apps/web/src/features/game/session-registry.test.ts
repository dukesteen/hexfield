import { expect, test } from 'vitest';
import { baseModule, type GameConfig } from '@cp2p/engine';
import { standardFixedBoard } from '@cp2p/maps';
import { LocalSession } from '../../session';
import { acquireLocalSession } from './session-registry';

test('restore rejects metadata revision that disagrees with the validated input log', () => {
  const config: GameConfig = {
    modules: [{ id: 'base', version: baseModule().version }],
    seats: [0, 1],
    options: { base: { mapLayout: 'standard-fixed' } },
    board: standardFixedBoard(),
  };
  const made = LocalSession.create({
    config,
    humanSeats: [0, 1],
    botSeats: [],
    genesisSeed: new Uint8Array(32).fill(9),
    entropy: { randomBytes: (target) => target.fill(7) },
  });
  if (!made.ok) throw new Error(made.error.message);
  const save = made.value.exportSave();
  made.value.dispose();
  expect(() => acquireLocalSession('forged', save, {}, save.genesis.length + 1)).toThrow(
    'Saved game revision differs from its input log',
  );
});
