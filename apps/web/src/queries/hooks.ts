import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { queryKeys } from './keys';
import {
  LocalSavedGameRepository,
  SaveConflictError,
  type SaveInput,
  type SavedGameRecord,
  type SavedGameRepository,
} from './repositories/saved-games';
import {
  LocalSettingsRepository,
  type SettingsPatch,
  type SettingsRepository,
} from './repositories/settings';

export interface WebRepositories {
  settings: SettingsRepository;
  savedGames: SavedGameRepository;
}

let browserRepositories: WebRepositories | undefined;

export function getWebRepositories(): WebRepositories {
  browserRepositories ??= {
    settings: new LocalSettingsRepository(),
    savedGames: new LocalSavedGameRepository(),
  };
  return browserRepositories;
}

function newerRecord(
  cached: SavedGameRecord | null | undefined,
  persisted: SavedGameRecord | null,
): SavedGameRecord | null {
  if (!persisted) return null;
  if (!cached || persisted.revision > cached.revision) return persisted;
  if (persisted.revision === cached.revision) {
    if (
      JSON.stringify(persisted.save) !== JSON.stringify(cached.save) ||
      JSON.stringify(persisted.presentation) !== JSON.stringify(cached.presentation)
    ) {
      throw new SaveConflictError(
        persisted.id,
        'Cached and stored games disagree at one revision.',
      );
    }
    return persisted;
  }
  return cached;
}

/** Bypass an Infinity-stale cache when opening a save; never regress its revision. */
export async function loadSavedGame(
  queryClient: QueryClient,
  id: string,
  repository: SavedGameRepository = getWebRepositories().savedGames,
): Promise<SavedGameRecord | null> {
  const key = queryKeys.savedGame(id);
  return queryClient.fetchQuery({
    queryKey: key,
    staleTime: 0,
    queryFn: async () =>
      newerRecord(queryClient.getQueryData<SavedGameRecord | null>(key), await repository.get(id)),
  });
}

export function useSettings(repository: SettingsRepository = getWebRepositories().settings) {
  return useQuery({ queryKey: queryKeys.settings(), queryFn: () => repository.get() });
}

export function useUpdateSettings(repository: SettingsRepository = getWebRepositories().settings) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => repository.update(patch),
    onSuccess: (settings) => queryClient.setQueryData(queryKeys.settings(), settings),
  });
}

export function useSavedGames(repository: SavedGameRepository = getWebRepositories().savedGames) {
  return useQuery({ queryKey: queryKeys.savedGames(), queryFn: () => repository.list() });
}

export function useSavedGame(
  id: string,
  repository: SavedGameRepository = getWebRepositories().savedGames,
) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: queryKeys.savedGame(id),
    queryFn: async () =>
      newerRecord(
        queryClient.getQueryData<SavedGameRecord | null>(queryKeys.savedGame(id)),
        await repository.get(id),
      ),
    staleTime: 0,
  });
}

export function useSaveGame(repository: SavedGameRepository = getWebRepositories().savedGames) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveInput) => repository.save(input),
    onSuccess: async (saved) => {
      queryClient.setQueryData<SavedGameRecord | null>(queryKeys.savedGame(saved.id), (cached) =>
        newerRecord(cached, saved),
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.savedGames(), exact: true });
    },
  });
}
