import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  exportStoredOnlineFullSave,
  importOnlineFullSaveFile,
  listImportedOnlineFullSaves,
  openImportedOnlineFullSave,
} from '../session/online-full-save-client.js';

const catalogueKey = ['online-full-saves'] as const;

export function useExportOnlineFullSave() {
  return useMutation({
    mutationFn: ({
      gameId,
      includePrivate,
      passphrase,
    }: {
      gameId: string;
      includePrivate: boolean;
      passphrase?: string;
    }) =>
      exportStoredOnlineFullSave(gameId, {
        includePrivate,
        ...(passphrase === undefined ? {} : { passphrase }),
      }),
  });
}

export function useImportOnlineFullSave() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ bytes, passphrase }: { bytes: Uint8Array; passphrase?: string }) =>
      importOnlineFullSaveFile(bytes, passphrase),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: catalogueKey });
    },
  });
}

export function useImportedOnlineFullSaves() {
  return useQuery({
    queryKey: catalogueKey,
    queryFn: () => listImportedOnlineFullSaves(),
    retry: false,
  });
}

export function useImportedOnlineFullSave(id: string) {
  return useQuery({
    queryKey: [...catalogueKey, id],
    queryFn: ({ signal }) => openImportedOnlineFullSave(id, signal),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
