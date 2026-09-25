import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Seat } from '@cp2p/engine';
import { getWebRepositories } from './hooks';
import { queryKeys } from './keys';
import type { GamePresentation, SavedGameRecord } from './repositories/saved-games';

function downloadJson(name: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Browser file export remains an async Query operation like persisted game writes. */
export function useExportGame() {
  return useMutation({
    mutationFn: async ({ name, save }: { name: string; save: unknown }) => {
      downloadJson(`${name}.save.json`, save);
    },
  });
}

export function useExportReplay() {
  return useMutation({
    mutationFn: async ({ name, save }: { name: string; save: unknown }) => {
      const { parseSave } = await import('../session/save');
      const local = parseSave(save);
      downloadJson(`${name}.replay.json`, {
        format: 'hexfield-local-replay',
        v: 1,
        engineVersion: local.engineVersion,
        config: local.config,
        genesisSeed: local.genesisSeed,
        inputs: [
          ...local.genesis,
          ...local.batches.flatMap((batch) => [batch.submitted, ...batch.generated]),
        ],
        finalHash: local.finalHash,
      });
    },
  });
}

const colors = ['blue', 'orange', 'green', 'magenta'] as const;
const shapes = ['circle', 'triangle', 'square', 'diamond'] as const;

/** Restore an imported local save as a separate game, preserving validated input history. */
export function useImportLocalSave(playerName: (seat: Seat) => string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (raw: unknown): Promise<SavedGameRecord> => {
      const { LocalSession } = await import('../session');
      const restored = LocalSession.restore(raw);
      if (!restored.ok) throw new Error(restored.error.message);
      const session = restored.value;
      try {
        session.setPaused(true);
        const save = session.exportSave();
        const seats = session.getState().config.seats;
        const presentation: GamePresentation = {
          players: seats.map((seat, index) => {
            const displaySeat = ([0, 1, 2, 3] as const).find((candidate) => candidate === seat);
            if (displaySeat === undefined) throw new Error('Imported game has unsupported seats');
            return {
              seat: displaySeat,
              name: playerName(seat),
              color: colors[index] ?? 'blue',
              shape: shapes[index] ?? 'circle',
            };
          }),
          botDelayMs: 500,
        };
        const revision =
          save.genesis.length +
          save.batches.reduce((sum, batch) => sum + 1 + batch.generated.length, 0);
        return getWebRepositories().savedGames.save({
          id: crypto.randomUUID(),
          revision,
          presentation,
          save,
        });
      } finally {
        session.dispose();
      }
    },
    onSuccess: async (record) => {
      queryClient.setQueryData(queryKeys.savedGame(record.id), record);
      await queryClient.invalidateQueries({ queryKey: queryKeys.savedGames(), exact: true });
    },
  });
}

/** A rematch keeps rules and seats, but starts from fresh browser entropy. */
export function useCreateRematch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      save: raw,
      presentation,
    }: {
      save: unknown;
      presentation: GamePresentation;
    }) => {
      const [{ parseSave }, { LocalSession }] = await Promise.all([
        import('../session/save'),
        import('../session'),
      ]);
      const previous = parseSave(raw);
      const created = LocalSession.create({
        config: previous.config,
        humanSeats: previous.roles.humanSeats,
        botSeats: previous.roles.botSeats,
        botDelayMs: presentation.botDelayMs,
      });
      if (!created.ok) throw new Error(created.error.message);
      const session = created.value;
      try {
        session.setPaused(true);
        const save = session.exportSave();
        return getWebRepositories().savedGames.save({
          id: crypto.randomUUID(),
          revision: save.genesis.length,
          presentation,
          save,
        });
      } finally {
        session.dispose();
      }
    },
    onSuccess: async (record) => {
      queryClient.setQueryData(queryKeys.savedGame(record.id), record);
      await queryClient.invalidateQueries({ queryKey: queryKeys.savedGames(), exact: true });
    },
  });
}
