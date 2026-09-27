import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getOnlineVaultController } from '../session/online-vault-controller.js';
import type { OnlineVaultController } from '../session/online-vault-controller.js';
import { queryKeys } from './keys.js';

const vaultKey = ['online-vault'] as const;

export function useOnlineVault(controller: OnlineVaultController = getOnlineVaultController()) {
  const client = useQueryClient();
  useEffect(
    () => controller.subscribe(() => client.setQueryData(vaultKey, controller.snapshot())),
    [client, controller],
  );
  return useQuery({
    queryKey: vaultKey,
    queryFn: () => controller.ready(),
    retry: false,
    staleTime: Infinity,
  });
}

export type VaultCommand =
  | { kind: 'lock' }
  | { kind: 'unlock' | 'enable' | 'disable'; passphrase: string }
  | { kind: 'change'; passphrase: string; nextPassphrase: string };

/** Secret input stays outside TanStack's mutation variables and devtools cache. */
export function useChangeOnlineVault(
  controller: OnlineVaultController = getOnlineVaultController(),
) {
  const pending = useRef<VaultCommand | null>(null);
  const client = useQueryClient();
  const mutation = useMutation({
    gcTime: 0,
    mutationFn: async () => {
      const command = pending.current;
      if (!command) throw new Error('No vault operation was requested');
      try {
        switch (command.kind) {
          case 'lock':
            return await controller.lock();
          case 'unlock':
            return await controller.unlock(command.passphrase);
          case 'enable':
            return await controller.enable(command.passphrase);
          case 'disable':
            return await controller.disable(command.passphrase);
          case 'change':
            return await controller.changePassphrase(command.passphrase, command.nextPassphrase);
        }
      } finally {
        if ('passphrase' in command) command.passphrase = '';
        if ('nextPassphrase' in command) command.nextPassphrase = '';
        pending.current = null;
      }
    },
    onSettled: async () => {
      client.setQueryData(vaultKey, controller.snapshot());
      await client.invalidateQueries({ queryKey: queryKeys.settings() });
      await client.invalidateQueries({ queryKey: ['onlineGames'] });
      await client.invalidateQueries({ queryKey: ['online-full-saves'] });
    },
  });
  const run = async (command: VaultCommand) => {
    if (pending.current) throw new Error('A vault operation is already running');
    pending.current = { ...command };
    if ('passphrase' in command) command.passphrase = '';
    if ('nextPassphrase' in command) command.nextPassphrase = '';
    return mutation.mutateAsync();
  };
  return { run, isPending: mutation.isPending, error: mutation.error };
}
