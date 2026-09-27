import { useQuery } from '@tanstack/react-query';
import { IndexedDbByteStore } from '@cp2p/storage';
import { listOnlineGameRecords } from '../session/online-game-records.js';
import { deriveOnlineGameStats, loadOnlineGameOutcome } from '../session/online-game-history.js';
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
            try {
              const outcome = await loadOnlineGameOutcome(store, game.gameId, game.genesisDigest);
              return { ...game, outcome, outcomeUnavailable: false };
            } catch {
              // Display metadata is separate from the certified resume record.
              return { ...game, outcome: null, outcomeUnavailable: true };
            }
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
