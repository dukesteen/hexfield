import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  importPublicReplay,
  listPublicReplays,
  openPublicReplay,
} from '../session/online-public-archive-client.js';

const catalogueKey = ['online-public-replays'] as const;

export function usePublicReplays() {
  return useQuery({ queryKey: catalogueKey, queryFn: listPublicReplays, retry: false });
}

export function usePublicReplay(id: string) {
  return useQuery({
    queryKey: [...catalogueKey, id],
    queryFn: ({ signal }) => openPublicReplay(id, undefined, signal),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function useImportPublicReplay() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (bytes: Uint8Array) => importPublicReplay(bytes),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: catalogueKey });
    },
  });
}
