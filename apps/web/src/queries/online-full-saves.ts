import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import {
  exportStoredOnlineFullSave,
  importOnlineFullSaveFile,
  listImportedOnlineFullSaves,
  openImportedOnlineFullSave,
} from '../session/online-full-save-client.js';

const catalogueKey = ['online-full-saves'] as const;

/** Passphrases are transient input, never query-devtools mutation variables. */
function useFullSaveMutation<Input extends { passphrase?: string }, Output>(
  execute: (input: Input) => Promise<Output>,
  onSuccess?: () => Promise<void>,
) {
  const pending = useRef<Input | null>(null);
  const mutation = useMutation({
    gcTime: 0,
    mutationFn: async () => {
      const input = pending.current;
      if (!input) throw new Error('No full-save operation was requested');
      try {
        return await execute(input);
      } finally {
        if ('passphrase' in input) input.passphrase = '';
        pending.current = null;
      }
    },
    ...(onSuccess ? { onSuccess } : {}),
  });
  return {
    isPending: mutation.isPending,
    mutateAsync: async (input: Input) => {
      if (pending.current) throw new Error('A full-save operation is already running');
      pending.current = { ...input };
      return mutation.mutateAsync();
    },
  };
}

export function useExportOnlineFullSave() {
  return useFullSaveMutation(
    ({
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
  );
}

export function useImportOnlineFullSave() {
  const client = useQueryClient();
  return useFullSaveMutation(
    ({ bytes, passphrase }: { bytes: Uint8Array; passphrase?: string }) =>
      importOnlineFullSaveFile(bytes, passphrase),
    async () => {
      await client.invalidateQueries({ queryKey: catalogueKey });
    },
  );
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
