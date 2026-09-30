import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IndexedDbByteStore } from '@cp2p/storage';
import { getOnlineVaultController } from '../session/online-vault-controller.js';
import { listOnlineGameRecords } from '../session/online-game-records.js';
import {
  deriveOnlineGameStats,
  loadOnlineGameOutcome,
  loadOnlineGameVoid,
} from '../session/online-game-history.js';
import { isOnlineGameAbandoned, loadOnlineGameActivity } from '../session/online-game-activity.js';
import {
  deleteStoredGame,
  exportStoredGameReplay,
  exportStoredGameReplayWithMasters,
} from '../session/online-saved-game-client.js';
import { importPublicReplay } from '../session/online-public-archive-client.js';
import { queryKeys } from './keys.js';

/** Lists public game locators. A resume still validates the certified journal and keys. */
export function useResumableGames() {
  return useQuery({
    queryKey: queryKeys.onlineGames(),
    staleTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      const vault = getOnlineVaultController();
      let active: Promise<unknown> | null = null;
      let cancelled = signal.aborted;
      const onAbort = () => {
        cancelled = true;
      };
      const scope = await vault.acquireScope(async () => {
        cancelled = true;
        await active?.catch(() => undefined);
      });
      if (cancelled) {
        await vault.releaseScope(scope);
        throw new DOMException('Online history query was cancelled', 'AbortError');
      }
      signal.addEventListener('abort', onAbort, { once: true });
      let store: IndexedDbByteStore | null = null;
      const assertActive = () => {
        if (cancelled) throw new DOMException('Online history query was cancelled', 'AbortError');
      };
      const run = async () => {
        assertActive();
        const currentStore = store;
        if (!currentStore) throw new Error('Online history store is unavailable');
        const listed = await listOnlineGameRecords(currentStore);
        assertActive();
        const games = await Promise.all(
          listed.games.map(async (game) => {
            const [result, recent, termination] = await Promise.allSettled([
              loadOnlineGameOutcome(currentStore, game.gameId, game.genesisDigest),
              loadOnlineGameActivity(currentStore, game.gameId, game.genesisDigest),
              loadOnlineGameVoid(currentStore, game.gameId, game.genesisDigest),
            ]);
            assertActive();
            const voided = termination.status === 'fulfilled' ? termination.value : null;
            const outcome =
              !voided && termination.status === 'fulfilled' && result.status === 'fulfilled'
                ? result.value
                : null;
            const activity = recent.status === 'fulfilled' ? recent.value : null;
            // Missing display metadata cannot change certified resume authority.
            return {
              ...game,
              outcome,
              voided,
              outcomeUnavailable: result.status === 'rejected' || termination.status === 'rejected',
              activity,
              abandoned:
                result.status === 'fulfilled' &&
                termination.status === 'fulfilled' &&
                !outcome &&
                !voided &&
                isOnlineGameAbandoned(activity),
            };
          }),
        );
        assertActive();
        return {
          ...listed,
          games,
          stats: deriveOnlineGameStats(games.flatMap(({ outcome }) => (outcome ? [outcome] : []))),
        };
      };
      try {
        store = new IndexedDbByteStore({ vault: scope });
        const pending = run();
        active = pending;
        return await pending;
      } finally {
        signal.removeEventListener('abort', onAbort);
        try {
          await store?.close();
        } finally {
          await vault.releaseScope(scope);
        }
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
    // An audited game brings its revealed masters, so the viewer can show every hand.
    mutationFn: async (gameId: string) => {
      const { bytes, masters } = await exportStoredGameReplayWithMasters(gameId);
      try {
        return await importPublicReplay(bytes, undefined, masters);
      } finally {
        for (const item of masters) item.master.fill(0);
      }
    },
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
