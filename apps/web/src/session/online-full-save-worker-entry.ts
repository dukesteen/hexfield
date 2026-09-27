/* oxlint-disable unicorn/require-post-message-target-origin -- Dedicated Worker messages have no target origin. */
import { acquireVaultOwner, IndexedDbByteStore, IndexedDbProtocolJournal } from '@cp2p/storage';
import type { VaultKeyHandoff } from '@cp2p/storage';
import { runOnlineFullSaveWorkerRequest } from './online-full-save-worker.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestId(value: unknown): number {
  try {
    const request = isRecord(value) ? value.request : null;
    const id = isRecord(request) ? request.id : null;
    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : 0;
  } catch {
    return 0;
  }
}

function validHandoff(value: unknown): value is VaultKeyHandoff | null {
  if (value === null) return true;
  if (!isRecord(value) || Object.keys(value).toSorted().join(',') !== 'generation,key,vaultId')
    return false;
  const key = value.key;
  return (
    typeof value.vaultId === 'string' &&
    /^[0-9a-f]{64}$/.test(value.vaultId) &&
    typeof value.generation === 'number' &&
    Number.isSafeInteger(value.generation) &&
    value.generation > 0 &&
    typeof CryptoKey !== 'undefined' &&
    key instanceof CryptoKey &&
    !key.extractable &&
    key.algorithm.name === 'AES-GCM' &&
    key.usages.includes('encrypt') &&
    key.usages.includes('decrypt')
  );
}

async function run(supplied: unknown) {
  const id = requestId(supplied);
  if (
    !isRecord(supplied) ||
    Object.keys(supplied).toSorted().join(',') !== 'handoff,request' ||
    !isRecord(supplied.request) ||
    !validHandoff(supplied.handoff)
  )
    return { id, kind: 'error' as const, code: 'full-save-request', message: 'Invalid worker job' };
  let owner;
  try {
    // The lease pins vault generation for the entire one-shot job. A missing
    // handoff is valid only while the vault is in default clear mode.
    owner = await acquireVaultOwner(supplied.handoff === null ? {} : { handoff: supplied.handoff });
  } catch {
    return {
      id,
      kind: 'error' as const,
      code: 'full-save-locked',
      message: 'Local vault is locked',
    };
  }
  try {
    return await runOnlineFullSaveWorkerRequest(supplied.request, {
      createStore: () => new IndexedDbByteStore({ vault: owner }),
      createJournal: (gameId, keyBinding) =>
        new IndexedDbProtocolJournal(gameId, {
          vault: owner,
          ...(keyBinding ? { keyBinding } : {}),
        }),
    });
  } finally {
    await owner.close();
  }
}

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const supplied = event.data;
  void run(supplied).then(
    (response) => {
      self.postMessage(response, {
        transfer:
          response.kind === 'exported' && response.bytes.buffer instanceof ArrayBuffer
            ? [response.bytes.buffer]
            : [],
      });
      return undefined;
    },
    () => {
      self.postMessage({
        id: requestId(supplied),
        kind: 'error',
        code: 'full-save-storage',
        message: 'Full-save worker failed',
      });
      return undefined;
    },
  );
});
