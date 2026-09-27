import { useMutation } from '@tanstack/react-query';
import { acquireGameWriterLease, IndexedDbByteStore } from '@cp2p/storage';
import { loadOnlineConnectionSettings } from './network.js';
import { loadOrCreateOnlineIdentity } from '../session/online-credentials.js';
import { getOnlineVaultController } from '../session/online-vault-controller.js';
import { OnlineTransferBrowser } from '../session/online-transfer-browser.js';
import type { OnlineTransferInvite } from '../session/online-transfer-link.js';
import { OnlineWorkerClient } from '../session/online-worker-client.js';
import type { OnlineRoomHandleValue } from '../features/online/room-registry.js';

export function useSourceTransfer(room: OnlineRoomHandleValue) {
  return useMutation({
    mutationFn: async () => {
      if (!room.startTransfer) throw new Error('Device transfer is unavailable');
      return room.startTransfer(await loadOnlineConnectionSettings());
    },
  });
}

export interface DestinationTransferHandle {
  readonly browser: OnlineTransferBrowser;
  close(): Promise<void>;
}

/** An explicit user action opens the isolated importer; no game signer runs here. */
export async function openDestinationTransfer(
  invite: OnlineTransferInvite,
  importedArchiveId?: string,
): Promise<DestinationTransferHandle> {
  if (importedArchiveId !== undefined && !/^[0-9a-f]{64}$/.test(importedArchiveId))
    throw new TypeError('Imported checkpoint identifier is malformed');
  const network = await loadOnlineConnectionSettings();
  const vaultController = getOnlineVaultController();
  let vaultScope: Awaited<ReturnType<typeof vaultController.acquireScope>> | null = null;
  let scopeCancelled = false;
  let store: IndexedDbByteStore | null = null;
  let identity: Awaited<ReturnType<typeof loadOrCreateOnlineIdentity>> | null = null;
  let worker: OnlineWorkerClient | null = null;
  let lease: Awaited<ReturnType<typeof acquireGameWriterLease>> = null;
  let browser: OnlineTransferBrowser | null = null;
  let leaseLost = false;
  let closing: Promise<void> | null = null;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      try {
        try {
          await browser?.close();
        } finally {
          await worker?.shutdown();
        }
      } finally {
        identity?.dispose();
        try {
          await lease?.close();
        } finally {
          try {
            await store?.close();
          } finally {
            if (vaultScope) await vaultController.releaseScope(vaultScope);
          }
        }
      }
    })();
    return closing;
  };
  try {
    vaultScope = await vaultController.acquireScope(async () => {
      scopeCancelled = true;
      await close();
    });
    store = new IndexedDbByteStore({ vault: vaultScope });
    if (scopeCancelled) throw new Error('Transfer storage was closed');
    identity = await loadOrCreateOnlineIdentity(store);
    if (scopeCancelled) {
      identity.dispose();
      identity = null;
      throw new Error('Transfer storage was closed');
    }
    lease = await acquireGameWriterLease(`transfer-${invite.body.attemptId}`, identity.peerId, {
      onLost: () => {
        leaseLost = true;
        void browser?.close().catch(() => undefined);
        worker?.fail(new Error('Transfer opened elsewhere'));
      },
    });
    if (!lease) throw new Error('This transfer is already open in another tab');
    if (scopeCancelled) {
      await lease.close();
      lease = null;
      identity.dispose();
      identity = null;
      throw new Error('Transfer storage was closed');
    }
    if (leaseLost) throw new Error('Transfer opened elsewhere');
    worker = new OnlineWorkerClient({ vaultHandoff: vaultScope.handoff() });
    browser = await OnlineTransferBrowser.openDestination({
      invite,
      ...(importedArchiveId === undefined ? {} : { importedArchiveId }),
      identity,
      store,
      worker,
      network,
      clock: {
        now: () => performance.now(),
        setTimeout: (callback, delay) => window.setTimeout(callback, delay),
        clearTimeout: (handle) => {
          if (typeof handle === 'number') window.clearTimeout(handle);
        },
      },
    });
    if (scopeCancelled) {
      await browser.close();
      browser = null;
      throw new Error('Transfer storage was closed');
    }
    if (leaseLost) throw new Error('Transfer opened elsewhere');
    return { browser, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

export function useDestinationTransfer() {
  return useMutation({
    mutationFn: ({
      invite,
      importedArchiveId,
    }: {
      invite: OnlineTransferInvite;
      importedArchiveId?: string;
    }) => openDestinationTransfer(invite, importedArchiveId),
  });
}
