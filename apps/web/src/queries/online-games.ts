import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IndexedDbByteStore } from '@cp2p/storage';
import { listOnlineGameRecords } from '../session/online-game-records.js';
import { deriveOnlineGameStats, loadOnlineGameOutcome } from '../session/online-game-history.js';
import { isOnlineGameAbandoned, loadOnlineGameActivity } from '../session/online-game-activity.js';
import { deleteStoredGame, exportStoredGameReplay } from '../session/online-saved-game-client.js';
import { importPublicReplay } from '../session/online-public-archive-client.js';
import { queryKeys } from './keys.js';

/** Lists public game locators. A resume still validates the certified journal and keys. */
export function useResumableGames() {
  return useQuery({
    queryKey: queryKeys.onlineGames(),
    staleTime: 0,
    retry: false,
    queryFn: async () => {
      const store = new IndexedDbByteStore();
      try {
        const listed = await listOnlineGameRecords(store);
        const games = await Promise.all(
          listed.games.map(async (game) => {
            const [result, recent] = await Promise.allSettled([
              loadOnlineGameOutcome(store, game.gameId, game.genesisDigest),
              loadOnlineGameActivity(store, game.gameId, game.genesisDigest),
            ]);
            const outcome = result.status === 'fulfilled' ? result.value : null;
            const activity = recent.status === 'fulfilled' ? recent.value : null;
            // Missing display metadata cannot change certified resume authority.
            return {
              ...game,
              outcome,
              outcomeUnavailable: result.status === 'rejected',
              activity,
              abandoned:
                result.status === 'fulfilled' && !outcome && isOnlineGameAbandoned(activity),
            };
          }),
        );
        return {
          ...listed,
          games,
          stats: deriveOnlineGameStats(games.flatMap(({ outcome }) => (outcome ? [outcome] : []))),
        };
      } finally {
        await store.close();
      }
    },
  });
}

/** Both actions verify the stored certified prefix in a worker, without joining the game. */
export function useExportOnlineReplay() {
  return useMutation({ mutationFn: exportStoredGameReplay });
}

export function useOpenOnlineReplay() {
  return useMutation({
    mutationFn: async (gameId: string) => importPublicReplay(await exportStoredGameReplay(gameId)),
  });
}

export function useDeleteOnlineGame() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ gameId, genesisDigest }: { gameId: string; genesisDigest: string }) =>
      deleteStoredGame(gameId, genesisDigest),
    onSuccess: async (result) => {
      if (result !== 'busy') await client.invalidateQueries({ queryKey: queryKeys.onlineGames() });
    },
  });
}
