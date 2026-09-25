import { expect, test } from 'vitest';
import { baseModule, type GameConfig } from '@cp2p/engine';
import { standardFixedBoard } from '@cp2p/maps';
import { LocalSession } from '../../session';
import { LocalSavedGameRepository } from '../../queries/repositories/saved-games';
import { MemoryStorage } from '../../queries/repositories/storage';
import { SaveCoordinator, type SaveStatus } from './save-coordinator';

test('flush retries the same revision after an async write fails', async () => {
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
  const session = made.value;
  const storage = new MemoryStorage();
  const repository = new LocalSavedGameRepository(() => storage);
  const presentation = {
    players: [
      { seat: 0 as const, name: 'A', color: 'blue' as const, shape: 'circle' as const },
      { seat: 1 as const, name: 'B', color: 'orange' as const, shape: 'triangle' as const },
    ],
    botDelayMs: 0,
  };
  const initialRevision = session.exportSave().genesis.length;
  await repository.save({
    id: 'retry',
    revision: initialRevision,
    presentation,
    save: session.exportSave(),
  });
  let writes = 0;
  const statuses: SaveStatus[] = [];
  const coordinator = new SaveCoordinator(
    'retry',
    session,
    presentation,
    repository,
    async (input) => {
      writes += 1;
      if (writes === 1) throw new Error('Transient storage failure');
      return repository.save(input);
    },
    initialRevision,
    (status) => statuses.push(status),
  );
  const pending = session.getPending().find((item) => item.kind === 'player');
  if (pending?.kind !== 'player') throw new Error('Missing setup action');
  const command = session.getLegalCommands(pending.seat).commands[0];
  if (!command) throw new Error('Missing legal setup command');
  const applied = await session.submit(pending.seat, command);
  if (!applied.ok) throw new Error(applied.error.message);
  await coordinator.flush();
  expect(writes).toBe(2);
  expect((await repository.get('retry'))?.revision).toBe(session.exportSave().genesis.length + 1);
  expect(statuses.at(-1)).toBe('saved');
  coordinator.dispose();
  session.dispose();
  repository.dispose();
});
