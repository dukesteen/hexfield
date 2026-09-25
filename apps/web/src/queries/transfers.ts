import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as v from 'valibot';
import type { Seat } from '@cp2p/engine';
import { LocalSession } from '../session/local-session';
import { parseSave, sameCanonical } from '../session/save';
import type { LocalSessionSave } from '../session/types';
import { getWebRepositories } from './hooks';
import { queryKeys } from './keys';
import type { GamePresentation, SavedGameRecord } from './repositories/saved-games';

const presentationSchema = v.strictObject({
  players: v.pipe(
    v.array(
      v.strictObject({
        seat: v.picklist([0, 1, 2, 3]),
        name: v.pipe(v.string(), v.minLength(1), v.maxLength(40)),
        color: v.picklist(['blue', 'orange', 'green', 'magenta']),
        shape: v.picklist(['circle', 'triangle', 'square', 'diamond']),
      }),
    ),
    v.minLength(2),
    v.maxLength(4),
  ),
  botDelayMs: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(60_000)),
});

const replaySchema = v.strictObject({
  format: v.literal('hexfield-local-replay'),
  v: v.literal(2),
  engineVersion: v.string(),
  save: v.unknown(),
  inputs: v.array(v.unknown()),
  finalHash: v.string(),
  presentation: v.optional(presentationSchema),
});

export interface LocalReplay {
  format: 'hexfield-local-replay';
  v: 2;
  engineVersion: string;
  save: LocalSessionSave;
  inputs: readonly unknown[];
  finalHash: string;
  presentation?: GamePresentation;
}

function flattenedInputs(save: LocalSessionSave): unknown[] {
  return [
    ...save.genesis,
    ...save.batches.flatMap((batch) => [batch.submitted, ...batch.generated]),
  ];
}

function verifiedSave(raw: unknown): LocalSessionSave {
  const restored = LocalSession.restore(raw);
  if (!restored.ok) throw new Error(`${restored.error.code}: ${restored.error.message}`);
  try {
    restored.value.setPaused(true);
    return restored.value.exportSave();
  } finally {
    restored.value.dispose();
  }
}

function checkedPresentation(raw: unknown, save: LocalSessionSave): GamePresentation {
  const presentation = v.parse(presentationSchema, raw);
  const seats: number[] = presentation.players.map((player) => player.seat);
  if (
    new Set(seats).size !== seats.length ||
    seats.length !== save.config.seats.length ||
    save.config.seats.some((seat) => !seats.includes(seat))
  )
    throw new Error('Replay presentation seats differ from the game');
  return presentation;
}

/** Keep batch boundaries so an exported replay remains a verifiable local authority. */
export function createLocalReplay(raw: unknown, presentation?: GamePresentation): LocalReplay {
  const save = verifiedSave(raw);
  return {
    format: 'hexfield-local-replay',
    v: 2,
    engineVersion: save.engineVersion,
    save,
    inputs: flattenedInputs(save),
    finalHash: save.finalHash,
    ...(presentation ? { presentation: checkedPresentation(presentation, save) } : {}),
  };
}

/** Validate an untrusted replay envelope and its complete public/private input history. */
export function parseLocalReplay(raw: unknown): LocalReplay {
  const envelope = v.parse(replaySchema, raw);
  const save = verifiedSave(envelope.save);
  if (
    envelope.engineVersion !== save.engineVersion ||
    envelope.finalHash !== save.finalHash ||
    !sameCanonical(envelope.inputs, flattenedInputs(save))
  )
    throw new Error('Replay envelope differs from its authoritative save');
  return {
    format: envelope.format,
    v: envelope.v,
    engineVersion: envelope.engineVersion,
    save,
    inputs: envelope.inputs,
    finalHash: envelope.finalHash,
    ...(envelope.presentation
      ? { presentation: checkedPresentation(envelope.presentation, save) }
      : {}),
  };
}

export function parseLocalImport(raw: unknown): {
  save: LocalSessionSave;
  presentation?: GamePresentation;
} {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    !Array.isArray(raw) &&
    Reflect.get(raw, 'format') === 'hexfield-local-replay'
  ) {
    const replay = parseLocalReplay(raw);
    return {
      save: replay.save,
      ...(replay.presentation ? { presentation: replay.presentation } : {}),
    };
  }
  return { save: verifiedSave(raw) };
}

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
    mutationFn: async ({
      name,
      save,
      presentation,
    }: {
      name: string;
      save: unknown;
      presentation?: GamePresentation;
    }) => {
      downloadJson(`${name}.replay.json`, createLocalReplay(save, presentation));
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
      const payload = parseLocalImport(raw);
      const restored = LocalSession.restore(payload.save);
      if (!restored.ok) throw new Error(restored.error.message);
      const session = restored.value;
      try {
        session.setPaused(true);
        const save = session.exportSave();
        const seats = session.getState().config.seats;
        const presentation: GamePresentation = payload.presentation ?? {
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

/** Async replay data is checked against persisted authority before reaching a viewer. */
export function useReplay(gameId: string) {
  return useQuery({
    queryKey: queryKeys.replay(gameId),
    queryFn: async (): Promise<LocalReplay | null> => {
      const record = await getWebRepositories().savedGames.get(gameId);
      return record ? createLocalReplay(record.save, record.presentation) : null;
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
