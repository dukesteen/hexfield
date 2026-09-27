import { useQuery } from '@tanstack/react-query';
import { IndexedDbByteStore } from '@cp2p/storage';
import { listOnlineGameRecords } from '../session/online-game-records.js';
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
        return await listOnlineGameRecords(store);
      } finally {
        await store.close();
      }
    },
  });
}
