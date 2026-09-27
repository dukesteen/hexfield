# Local vault live integration review

Review the pinned source-only patch for the optional browser local vault. Tools and MCP are disabled. Do not infer behavior from runtime secrets or saves; none are included.

Focus on concrete release blockers in:

- lock/unlock and cross-tab lease ordering, especially room/worker opening or closing during a lock;
- stale generation and absent identity handling, with no plaintext fallback or silent key remint;
- non-extractable key handoff to the protocol worker and one-shot full-save/public-archive workers;
- every protected byte-store and journal consumer reached by these app paths, including nested private-export inventory;
- whether storage operations or worker requests can continue after key disposal, or whether the controller can wait forever on its own closer.

Treat the repository's injected worker/store factories as test seams. The attached diff and new controller source are the review boundary. Give file/line evidence for each actionable finding, explain a realistic trigger and smallest safe correction. Distinguish a confirmed defect from a limitation needing a wider app integration. Do not propose changing consensus, certified replay, or wire protocol.

## Exact new controller source
import {
  acquireVaultOwner,
  migrateLocalVault,
  readLocalVaultStatus,
  VaultError,
} from '@cp2p/storage';
import type { VaultKeyHandoff, VaultOwnerLease } from '@cp2p/storage';

export interface OnlineVaultSnapshot {
  readonly mode: 'clear' | 'locked';
  readonly state: 'loading' | 'ready' | 'locked' | 'busy' | 'error';
  readonly generation: number;
  readonly errorCode?: VaultError['code'];
}

type VaultLocks = Pick<LockManager, 'request'>;

export interface OnlineVaultControllerOptions {
  /** Test seam; production uses the browser's same-origin Web Locks. */
  readonly lockManager?: VaultLocks;
  readonly channel?: Pick<BroadcastChannel, 'postMessage' | 'close' | 'addEventListener'> | null;
}

/** A tab owns one vault lease; each live signer gets a separately closed shared lease. */
export class OnlineVaultController {
  readonly #lockManager: VaultLocks | undefined;
  readonly #channel: OnlineVaultControllerOptions['channel'];
  readonly #listeners = new Set<() => void>();
  readonly #scopes = new Map<VaultOwnerLease, () => Promise<void>>();
  #current: OnlineVaultSnapshot = { mode: 'clear', state: 'loading', generation: 0 };
  #loading: Promise<OnlineVaultSnapshot> | null = null;
  #owner: VaultOwnerLease | null = null;
  #closing: Promise<void> | null = null;
  #disposed = false;

  constructor(options: OnlineVaultControllerOptions = {}) {
    this.#lockManager = options.lockManager;
    this.#channel =
      options.channel === undefined && typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel('cp2p/local-vault/v1')
        : options.channel;
    if (this.#channel)
      this.#channel.addEventListener('message', (event) => {
        if (event.data === 'lock-request') void this.lock().catch(() => undefined);
        if (event.data === 'vault-changed')
          void this.lock()
            .then(() => this.#refreshStatus())
            .catch(() => undefined);
      });
  }

  snapshot(): OnlineVaultSnapshot {
    return { ...this.#current };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  ready(): Promise<OnlineVaultSnapshot> {
    if (this.#disposed)
      return Promise.reject(new VaultError('closed', 'Vault controller is closed'));
    if (this.#loading) return this.#loading;
    if (this.#current.state !== 'loading') return Promise.resolve(this.snapshot());
    const loading = readLocalVaultStatus()
      .then((status) => {
        if (this.#disposed) throw new VaultError('closed', 'Vault controller is closed');
        this.#set({
          ...status,
          state: status.mode === 'locked' ? 'locked' : 'ready',
        });
        return this.snapshot();
      })
      .catch((error: unknown) => {
        this.#set({
          ...this.#current,
          state: 'error',
          errorCode: vaultCode(error),
        });
        throw error;
      })
      .finally(() => {
        this.#loading = null;
      });
    this.#loading = loading;
    return loading;
  }

  /** Returns only a non-extractable key handle; never a passphrase or raw key. */
  handoff(): VaultKeyHandoff | null {
    return this.#owner?.handoff() ?? null;
  }

  async unlock(passphrase: string): Promise<void> {
    await this.ready();
    this.#assertIdle();
    if (this.#current.mode !== 'locked') throw new VaultError('invalid-key', 'Vault is not locked');
    if (this.#owner) return;
    this.#set({ ...this.#current, state: 'busy' });
    try {
      const owner = await acquireVaultOwner({
        passphrase,
        ...(this.#lockManager ? { lockManager: this.#lockManager } : {}),
      });
      if (this.#disposed || this.#closing) {
        await owner.close();
        throw new VaultError('closed', 'Vault closed during unlock');
      }
      this.#owner = owner;
      this.#set({ mode: 'locked', state: 'ready', generation: owner.generation });
    } catch (error) {
      this.#set({ ...this.#current, state: 'locked', errorCode: vaultCode(error) });
      throw error;
    }
  }

  async acquireScope(close: () => Promise<void>): Promise<VaultOwnerLease> {
    await this.ready();
    this.#assertIdle();
    if (!this.#owner) {
      if (this.#current.mode === 'locked') throw new VaultError('locked', 'Local vault is locked');
      const owner = await acquireVaultOwner(
        this.#lockManager ? { lockManager: this.#lockManager } : {},
      );
      if (this.#disposed || this.#closing || this.#current.state !== 'ready') {
        await owner.close();
        throw new VaultError('closed', 'Vault closed while opening a scope');
      }
      this.#owner = owner;
    }
    const parent = this.#owner;
    const handoff = parent.handoff();
    const scope = await acquireVaultOwner({
      ...(handoff ? { handoff } : {}),
      ...(this.#lockManager ? { lockManager: this.#lockManager } : {}),
    });
    if (this.#disposed || this.#closing || this.#owner !== parent) {
      await scope.close();
      throw new VaultError('closed', 'Vault closed while opening a scope');
    }
    this.#scopes.set(scope, close);
    return scope;
  }

  async releaseScope(scope: VaultOwnerLease): Promise<void> {
    this.#scopes.delete(scope);
    await scope.close();
  }

  lock(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = this.#closeScopes().finally(() => {
      this.#closing = null;
    });
    return this.#closing;
  }

  async enable(passphrase: string): Promise<void> {
    await this.#migrate('clear', { newPassphrase: passphrase });
  }

  async changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void> {
    await this.#migrate('locked', { oldPassphrase, newPassphrase });
  }

  async disable(passphrase: string): Promise<void> {
    await this.#migrate('locked', { oldPassphrase: passphrase });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    await this.lock();
    this.#disposed = true;
    this.#channel?.close();
    this.#listeners.clear();
  }

  async #closeScopes(): Promise<void> {
    await this.ready();
    if (this.#current.state === 'busy')
      throw new VaultError('busy', 'Vault operation is in progress');
    this.#set({ ...this.#current, state: 'busy' });
    const results = await Promise.allSettled([...this.#scopes.values()].map((close) => close()));
    if (results.some((result) => result.status === 'rejected')) {
      const error = new VaultError('busy', 'A live signer could not be closed');
      this.#set({ ...this.#current, state: 'error', errorCode: error.code });
      throw error;
    }
    await Promise.all([...this.#scopes.keys()].map((scope) => this.releaseScope(scope)));
    await this.#owner?.close();
    this.#owner = null;
    this.#set({
      mode: this.#current.mode,
      generation: this.#current.generation,
      state: this.#current.mode === 'locked' ? 'locked' : 'ready',
    });
  }

  async #migrate(
    expectedMode: 'clear' | 'locked',
    passphrases: { oldPassphrase?: string; newPassphrase?: string },
  ): Promise<void> {
    await this.ready();
    if (this.#current.mode !== expectedMode)
      throw new VaultError('stale-generation', 'Vault mode changed before migration');
    this.#channel?.postMessage('lock-request');
    await this.lock();
    this.#set({ ...this.#current, state: 'busy' });
    try {
      await migrateLocalVault({
        ...passphrases,
        ...(this.#lockManager ? { lockManager: this.#lockManager } : {}),
      });
      const status = await readLocalVaultStatus();
      this.#set({ ...status, state: status.mode === 'locked' ? 'locked' : 'ready' });
      this.#channel?.postMessage('vault-changed');
    } catch (error) {
      const status = await readLocalVaultStatus().catch(() => null);
      this.#set({
        mode: status?.mode ?? this.#current.mode,
        generation: status?.generation ?? this.#current.generation,
        state: status?.mode === 'locked' ? 'locked' : 'error',
        errorCode: vaultCode(error),
      });
      throw error;
    }
  }

  #assertIdle(): void {
    if (this.#disposed) throw new VaultError('closed', 'Vault controller is closed');
    if (this.#closing || this.#current.state === 'busy')
      throw new VaultError('busy', 'Vault operation is in progress');
  }

  async #refreshStatus(): Promise<void> {
    if (this.#disposed || this.#owner || this.#scopes.size > 0) return;
    const status = await readLocalVaultStatus();
    if (!this.#disposed)
      this.#set({ ...status, state: status.mode === 'locked' ? 'locked' : 'ready' });
  }

  #set(value: OnlineVaultSnapshot): void {
    this.#current = value;
    for (const listener of this.#listeners) listener();
  }
}

function vaultCode(error: unknown): VaultError['code'] {
  return error instanceof VaultError ? error.code : 'corrupt';
}

let browserController: OnlineVaultController | null = null;

export function getOnlineVaultController(): OnlineVaultController {
  browserController ??= new OnlineVaultController();
  return browserController;
}

## Existing source patch
diff --git a/apps/web/src/queries/hooks.ts b/apps/web/src/queries/hooks.ts
index 08a266e..3e019f6 100644
--- a/apps/web/src/queries/hooks.ts
+++ b/apps/web/src/queries/hooks.ts
@@ -1,4 +1,6 @@
 import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
+import { IndexedDbByteStore } from '@cp2p/storage';
+import { getOnlineVaultController } from '../session/online-vault-controller.js';
 import { queryKeys } from './keys';
 import {
   LocalSavedGameRepository,
@@ -20,9 +22,34 @@ export interface WebRepositories {
 
 let browserRepositories: WebRepositories | undefined;
 
+async function withVaultSettings<T>(
+  run: (repository: SettingsRepository) => Promise<T>,
+): Promise<T> {
+  const vault = getOnlineVaultController();
+  let active: Promise<T> | null = null;
+  const scope = await vault.acquireScope(async () => {
+    await active?.catch(() => undefined);
+  });
+  const store = new IndexedDbByteStore({ vault: scope });
+  try {
+    active = run(new IndexedDbSettingsRepository({ store }));
+    return await active;
+  } finally {
+    await store.close();
+    await vault.releaseScope(scope);
+  }
+}
+
+const browserSettings: SettingsRepository = {
+  get: () => withVaultSettings((repository) => repository.get()),
+  update: (patch) => withVaultSettings((repository) => repository.update(patch)),
+  claimStoragePersistenceRequest: () =>
+    withVaultSettings((repository) => repository.claimStoragePersistenceRequest()),
+};
+
 export function getWebRepositories(): WebRepositories {
   browserRepositories ??= {
-    settings: new IndexedDbSettingsRepository(),
+    settings: browserSettings,
     savedGames: new LocalSavedGameRepository(),
   };
   return browserRepositories;
diff --git a/apps/web/src/session/online-full-save-client.ts b/apps/web/src/session/online-full-save-client.ts
index b1d4233..9dea2c2 100644
--- a/apps/web/src/session/online-full-save-client.ts
+++ b/apps/web/src/session/online-full-save-client.ts
@@ -1,4 +1,5 @@
 import { MAX_ONLINE_FULL_SAVE_BYTES } from './online-full-save.js';
+import { getOnlineVaultController } from './online-vault-controller.js';
 import type { ImportedOnlineFullSaveSummary } from './online-full-save-catalogue.js';
 import type {
   OnlineFullSaveDisplay,
@@ -130,7 +131,7 @@ type Body =
   | Omit<Extract<OnlineFullSaveWorkerRequest, { kind: 'list' }>, 'id'>
   | Omit<Extract<OnlineFullSaveWorkerRequest, { kind: 'open' }>, 'id'>;
 
-function runJob(
+async function runJob(
   body: Body,
   factory: OnlineFullSaveWorkerFactory,
   transfer: Transferable[] = [],
@@ -138,76 +139,99 @@ function runJob(
 ): Promise<OnlineFullSaveWorkerResponse> {
   if (signal?.aborted)
     return Promise.reject(new DOMException('Full-save operation cancelled', 'AbortError'));
-  let worker: WorkerPort;
+  // The injected worker factory is a test seam. Production jobs hold a shared
+  // owner until their one-shot worker has stopped.
+  let worker: WorkerPort | null = null;
+  let cancelJob: (() => void) | null = null;
+  const vault = factory === defaultWorker ? getOnlineVaultController() : null;
+  const scope = vault
+    ? await vault.acquireScope(async () => {
+        cancelJob?.();
+        worker?.terminate();
+      })
+    : null;
   try {
+    scope?.assertActive();
     worker = factory();
   } catch {
+    if (scope) await vault?.releaseScope(scope);
     return Promise.reject(
       new OnlineFullSaveClientError('full-save-worker', 'Full-save worker could not start'),
     );
   }
+  const activeWorker = worker;
   const id = nextId++;
-  return new Promise((resolve, reject) => {
-    let settled = false;
-    const finish = (outcome: OnlineFullSaveWorkerResponse | Error) => {
-      if (settled) return;
-      settled = true;
-      clearTimeout(deadline);
-      worker.removeEventListener('message', onMessage);
-      worker.removeEventListener('error', onFailure);
-      worker.removeEventListener('messageerror', onFailure);
-      signal?.removeEventListener('abort', onAbort);
-      worker.terminate();
-      if (outcome instanceof Error) reject(outcome);
-      else if (outcome.kind === 'error')
-        reject(new OnlineFullSaveClientError(outcome.code, outcome.message));
-      else resolve(outcome);
-    };
-    const onMessage: EventListener = (event) => {
+  try {
+    return await new Promise((resolve, reject) => {
+      let settled = false;
+      const finish = (outcome: OnlineFullSaveWorkerResponse | Error) => {
+        if (settled) return;
+        settled = true;
+        clearTimeout(deadline);
+        activeWorker.removeEventListener('message', onMessage);
+        activeWorker.removeEventListener('error', onFailure);
+        activeWorker.removeEventListener('messageerror', onFailure);
+        signal?.removeEventListener('abort', onAbort);
+        activeWorker.terminate();
+        if (outcome instanceof Error) reject(outcome);
+        else if (outcome.kind === 'error')
+          reject(new OnlineFullSaveClientError(outcome.code, outcome.message));
+        else resolve(outcome);
+      };
+      const onMessage: EventListener = (event) => {
+        try {
+          const value: unknown = Reflect.get(event, 'data');
+          finish(
+            validResponse(value, id)
+              ? value
+              : new OnlineFullSaveClientError(
+                  'full-save-worker',
+                  'Full-save worker returned an invalid response',
+                ),
+          );
+        } catch {
+          finish(
+            new OnlineFullSaveClientError(
+              'full-save-worker',
+              'Full-save worker returned an invalid response',
+            ),
+          );
+        }
+      };
+      const onFailure: EventListener = () =>
+        finish(new OnlineFullSaveClientError('full-save-worker', 'Full-save worker failed'));
+      const onAbort = () => finish(new DOMException('Full-save operation cancelled', 'AbortError'));
+      cancelJob = onAbort;
+      const deadline = setTimeout(
+        () =>
+          finish(
+            new OnlineFullSaveClientError('full-save-timeout', 'Full-save operation timed out'),
+          ),
+        DEADLINE_MS,
+      );
+      activeWorker.addEventListener('message', onMessage);
+      activeWorker.addEventListener('error', onFailure);
+      activeWorker.addEventListener('messageerror', onFailure);
+      signal?.addEventListener('abort', onAbort, { once: true });
+      if (signal?.aborted) {
+        onAbort();
+        return;
+      }
       try {
-        const value: unknown = Reflect.get(event, 'data');
-        finish(
-          validResponse(value, id)
-            ? value
-            : new OnlineFullSaveClientError(
-                'full-save-worker',
-                'Full-save worker returned an invalid response',
-              ),
+        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Dedicated Worker messages do not take a target origin.
+        activeWorker.postMessage(
+          scope ? { request: { ...body, id }, handoff: scope.handoff() } : { ...body, id },
+          transfer,
         );
       } catch {
         finish(
-          new OnlineFullSaveClientError(
-            'full-save-worker',
-            'Full-save worker returned an invalid response',
-          ),
+          new OnlineFullSaveClientError('full-save-worker', 'Full-save request could not be sent'),
         );
       }
-    };
-    const onFailure: EventListener = () =>
-      finish(new OnlineFullSaveClientError('full-save-worker', 'Full-save worker failed'));
-    const onAbort = () => finish(new DOMException('Full-save operation cancelled', 'AbortError'));
-    const deadline = setTimeout(
-      () =>
-        finish(new OnlineFullSaveClientError('full-save-timeout', 'Full-save operation timed out')),
-      DEADLINE_MS,
-    );
-    worker.addEventListener('message', onMessage);
-    worker.addEventListener('error', onFailure);
-    worker.addEventListener('messageerror', onFailure);
-    signal?.addEventListener('abort', onAbort, { once: true });
-    if (signal?.aborted) {
-      onAbort();
-      return;
-    }
-    try {
-      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Dedicated Worker messages do not take a target origin.
-      worker.postMessage({ ...body, id }, transfer);
-    } catch {
-      finish(
-        new OnlineFullSaveClientError('full-save-worker', 'Full-save request could not be sent'),
-      );
-    }
-  });
+    });
+  } finally {
+    if (scope) await vault?.releaseScope(scope);
+  }
 }
 
 /** Loads journal and optional private material by ID inside a one-shot worker. */
diff --git a/apps/web/src/session/online-full-save-inventory.ts b/apps/web/src/session/online-full-save-inventory.ts
index 9f00886..185ea53 100644
--- a/apps/web/src/session/online-full-save-inventory.ts
+++ b/apps/web/src/session/online-full-save-inventory.ts
@@ -29,6 +29,10 @@ export async function loadStoredOnlineMasterInventory(input: {
   readonly start: SavedOnlineGameRecord;
   readonly journal: Pick<ProtocolJournal, 'load'>;
   readonly store: EscrowCeremonyStore;
+  readonly createJournal?: (
+    gameId: string,
+    keyBinding: { recordKey: string; bytes: Uint8Array },
+  ) => Pick<ProtocolJournal, 'load'> & { close(): Promise<void> };
 }): Promise<OwnedMasterInventory> {
   const identity = await loadOnlineIdentity(input.store);
   const devicePeer = identity.peerId;
@@ -49,6 +53,7 @@ export async function loadStoredOnlineMasterInventory(input: {
     devicePeer,
     engine,
     includeMaterial: true,
+    ...(input.createJournal ? { createJournal: input.createJournal } : {}),
   });
   if (!material.material) throw new Error('Current bound game material is missing');
   const masters = new Map<Seat, Uint8Array>();
diff --git a/apps/web/src/session/online-full-save-worker-entry.ts b/apps/web/src/session/online-full-save-worker-entry.ts
index a6f442b..d69a382 100644
--- a/apps/web/src/session/online-full-save-worker-entry.ts
+++ b/apps/web/src/session/online-full-save-worker-entry.ts
@@ -1,9 +1,58 @@
 /* oxlint-disable unicorn/require-post-message-target-origin -- Dedicated Worker messages have no target origin. */
+import { acquireVaultOwner, IndexedDbByteStore, IndexedDbProtocolJournal } from '@cp2p/storage';
+import type { VaultKeyHandoff } from '@cp2p/storage';
 import { runOnlineFullSaveWorkerRequest } from './online-full-save-worker.js';
 
+function isRecord(value: unknown): value is Record<string, unknown> {
+  return typeof value === 'object' && value !== null && !Array.isArray(value);
+}
+
+function requestId(value: unknown): number {
+  const request = isRecord(value) ? value.request : null;
+  const id = isRecord(request) ? request.id : null;
+  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : 0;
+}
+
+async function run(supplied: unknown) {
+  const id = requestId(supplied);
+  if (
+    !isRecord(supplied) ||
+    Object.keys(supplied).toSorted().join(',') !== 'handoff,request' ||
+    !isRecord(supplied.request)
+  )
+    return { id, kind: 'error' as const, code: 'full-save-request', message: 'Invalid worker job' };
+  let owner;
+  try {
+    // The lease pins vault generation for the entire one-shot job. A missing
+    // handoff is valid only while the vault is in default clear mode.
+    owner = await acquireVaultOwner(
+      supplied.handoff === null ? {} : { handoff: supplied.handoff as VaultKeyHandoff },
+    );
+  } catch {
+    return {
+      id,
+      kind: 'error' as const,
+      code: 'full-save-locked',
+      message: 'Local vault is locked',
+    };
+  }
+  try {
+    return await runOnlineFullSaveWorkerRequest(supplied.request, {
+      createStore: () => new IndexedDbByteStore({ vault: owner }),
+      createJournal: (gameId, keyBinding) =>
+        new IndexedDbProtocolJournal(gameId, {
+          vault: owner,
+          ...(keyBinding ? { keyBinding } : {}),
+        }),
+    });
+  } finally {
+    await owner.close();
+  }
+}
+
 self.addEventListener('message', (event: MessageEvent<unknown>) => {
-  const request = event.data;
-  void runOnlineFullSaveWorkerRequest(request).then(
+  const supplied = event.data;
+  void run(supplied).then(
     (response) => {
       self.postMessage(response, {
         transfer:
@@ -14,11 +63,8 @@ self.addEventListener('message', (event: MessageEvent<unknown>) => {
       return undefined;
     },
     () => {
-      const rawId =
-        typeof request === 'object' && request !== null ? Reflect.get(request, 'id') : 0;
-      const id = Number.isSafeInteger(rawId) && Number(rawId) > 0 ? Number(rawId) : 0;
       self.postMessage({
-        id,
+        id: requestId(supplied),
         kind: 'error',
         code: 'full-save-storage',
         message: 'Full-save worker failed',
diff --git a/apps/web/src/session/online-full-save-worker.ts b/apps/web/src/session/online-full-save-worker.ts
index a4887b4..f89d07e 100644
--- a/apps/web/src/session/online-full-save-worker.ts
+++ b/apps/web/src/session/online-full-save-worker.ts
@@ -65,7 +65,10 @@ type Journal = Pick<ProtocolJournal, 'load'> & { close(): Promise<void> };
 
 export interface OnlineFullSaveWorkerDependencies {
   readonly createStore?: () => Store;
-  readonly createJournal?: (gameId: string) => Journal;
+  readonly createJournal?: (
+    gameId: string,
+    keyBinding?: { recordKey: string; bytes: Uint8Array },
+  ) => Journal;
   readonly loadMasterInventory?: typeof loadStoredOnlineMasterInventory;
 }
 
@@ -254,6 +257,7 @@ export async function runOnlineFullSaveWorkerRequest(
             start,
             journal: resources.journal,
             store,
+            ...(dependencies.createJournal ? { createJournal: dependencies.createJournal } : {}),
           });
         } catch {
           throw new FullSaveTaskError(
diff --git a/apps/web/src/session/online-protocol-worker.ts b/apps/web/src/session/online-protocol-worker.ts
index e13955a..b547fae 100644
--- a/apps/web/src/session/online-protocol-worker.ts
+++ b/apps/web/src/session/online-protocol-worker.ts
@@ -10,6 +10,7 @@ const scope = globalThis as unknown as {
 };
 
 const kinds = {
+  unlockVault: true,
   initializeTransfer: true,
   transferSnapshot: true,
   prepareTransferOffer: true,
@@ -79,6 +80,23 @@ function bootstrap(value: unknown): boolean {
 
 function validBody(body: Record<string, unknown>): boolean {
   switch (body.kind) {
+    case 'unlockVault': {
+      const handoff = object(body.handoff);
+      return (
+        onlyKeys(body, ['kind', 'handoff']) &&
+        !!handoff &&
+        onlyKeys(handoff, ['key', 'vaultId', 'generation']) &&
+        typeof handoff.vaultId === 'string' &&
+        /^[0-9a-f]{64}$/.test(handoff.vaultId) &&
+        typeof handoff.generation === 'number' &&
+        Number.isSafeInteger(handoff.generation) &&
+        handoff.generation >= 1 &&
+        typeof CryptoKey !== 'undefined' &&
+        handoff.key instanceof CryptoKey &&
+        !handoff.key.extractable &&
+        handoff.key.algorithm.name === 'AES-GCM'
+      );
+    }
     case 'initializeTransfer': {
       const expected = object(body.expected);
       return (
diff --git a/apps/web/src/session/online-public-archive-client.ts b/apps/web/src/session/online-public-archive-client.ts
index 58615c4..b8f0224 100644
--- a/apps/web/src/session/online-public-archive-client.ts
+++ b/apps/web/src/session/online-public-archive-client.ts
@@ -1,4 +1,5 @@
 import type { PublicArchiveSummary } from './online-public-archive-store.js';
+import { getOnlineVaultController } from './online-vault-controller.js';
 import { MAX_ONLINE_PUBLIC_ARCHIVE_BYTES } from './online-public-archive-format.js';
 import type {
   PublicArchiveDisplay,
@@ -47,7 +48,7 @@ function validResponse(value: unknown, id: number): value is PublicArchiveWorker
   );
 }
 
-function runJob(
+async function runJob(
   body:
     | { readonly kind: 'import'; readonly bytes: Uint8Array }
     | {
@@ -63,50 +64,69 @@ function runJob(
   if (signal?.aborted)
     return Promise.reject(new DOMException('Replay opening cancelled', 'AbortError'));
   const id = nextRequestId++;
-  const worker = factory();
-  return new Promise((resolve, reject) => {
-    let done = false;
-    const finish = (outcome: PublicArchiveWorkerResponse | Error) => {
-      if (done) return;
-      done = true;
-      clearTimeout(deadline);
-      worker.removeEventListener('message', onMessage);
-      worker.removeEventListener('error', onFailure);
-      worker.removeEventListener('messageerror', onFailure);
-      signal?.removeEventListener('abort', onAbort);
-      worker.terminate();
-      if (outcome instanceof Error) reject(outcome);
-      else if (outcome.kind === 'error') reject(new Error(outcome.error));
-      else resolve(outcome);
-    };
-    const onMessage: EventListener = (event) => {
-      const value: unknown = Reflect.get(event, 'data');
-      finish(
-        validResponse(value, id)
-          ? value
-          : new Error('Public replay worker returned an invalid response'),
+  let worker: WorkerPort | null = null;
+  let cancelJob: (() => void) | null = null;
+  const vault = factory === defaultWorker ? getOnlineVaultController() : null;
+  const scope = vault
+    ? await vault.acquireScope(async () => {
+        cancelJob?.();
+        worker?.terminate();
+      })
+    : null;
+  try {
+    scope?.assertActive();
+    worker = factory();
+    const activeWorker = worker;
+    return await new Promise((resolve, reject) => {
+      let done = false;
+      const finish = (outcome: PublicArchiveWorkerResponse | Error) => {
+        if (done) return;
+        done = true;
+        clearTimeout(deadline);
+        activeWorker.removeEventListener('message', onMessage);
+        activeWorker.removeEventListener('error', onFailure);
+        activeWorker.removeEventListener('messageerror', onFailure);
+        signal?.removeEventListener('abort', onAbort);
+        activeWorker.terminate();
+        if (outcome instanceof Error) reject(outcome);
+        else if (outcome.kind === 'error') reject(new Error(outcome.error));
+        else resolve(outcome);
+      };
+      const onMessage: EventListener = (event) => {
+        const value: unknown = Reflect.get(event, 'data');
+        finish(
+          validResponse(value, id)
+            ? value
+            : new Error('Public replay worker returned an invalid response'),
+        );
+      };
+      const onFailure: EventListener = () => finish(new Error('Public replay worker failed'));
+      const onAbort = () => finish(new DOMException('Replay opening cancelled', 'AbortError'));
+      cancelJob = onAbort;
+      const deadline = setTimeout(
+        () => finish(new Error('Public replay verification timed out')),
+        WORKER_DEADLINE_MS,
       );
-    };
-    const onFailure: EventListener = () => finish(new Error('Public replay worker failed'));
-    const onAbort = () => finish(new DOMException('Replay opening cancelled', 'AbortError'));
-    const deadline = setTimeout(
-      () => finish(new Error('Public replay verification timed out')),
-      WORKER_DEADLINE_MS,
-    );
-    worker.addEventListener('message', onMessage);
-    worker.addEventListener('error', onFailure);
-    worker.addEventListener('messageerror', onFailure);
-    signal?.addEventListener('abort', onAbort, { once: true });
-    if (signal?.aborted) {
-      onAbort();
-      return;
-    }
-    try {
-      worker.postMessage({ ...body, id }, transfer);
-    } catch {
-      finish(new Error('Public replay could not be sent to its worker'));
-    }
-  });
+      activeWorker.addEventListener('message', onMessage);
+      activeWorker.addEventListener('error', onFailure);
+      activeWorker.addEventListener('messageerror', onFailure);
+      signal?.addEventListener('abort', onAbort, { once: true });
+      if (signal?.aborted) {
+        onAbort();
+        return;
+      }
+      try {
+        activeWorker.postMessage(
+          scope ? { request: { ...body, id }, handoff: scope.handoff() } : { ...body, id },
+          transfer,
+        );
+      } catch {
+        finish(new Error('Public replay could not be sent to its worker'));
+      }
+    });
+  } finally {
+    if (scope) await vault?.releaseScope(scope);
+  }
 }
 
 /** The caller must check File.size before reading; this repeats the byte-level bound. */
diff --git a/apps/web/src/session/online-public-archive-worker-entry.ts b/apps/web/src/session/online-public-archive-worker-entry.ts
index bbf24b7..bf00485 100644
--- a/apps/web/src/session/online-public-archive-worker-entry.ts
+++ b/apps/web/src/session/online-public-archive-worker-entry.ts
@@ -1,19 +1,61 @@
+/* oxlint-disable unicorn/require-post-message-target-origin -- Dedicated Worker messages have no target origin. */
+import { acquireVaultOwner, IndexedDbByteStore } from '@cp2p/storage';
+import type { VaultKeyHandoff } from '@cp2p/storage';
 import { runPublicArchiveWorkerRequest } from './online-public-archive-worker.js';
 
+function isRecord(value: unknown): value is Record<string, unknown> {
+  return typeof value === 'object' && value !== null && !Array.isArray(value);
+}
+
+function requestId(value: unknown): number {
+  try {
+    const request = isRecord(value) ? value.request : null;
+    const id = isRecord(request) ? request.id : null;
+    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : 0;
+  } catch {
+    return 0;
+  }
+}
+
+async function run(supplied: unknown) {
+  const id = requestId(supplied);
+  if (
+    !isRecord(supplied) ||
+    Object.keys(supplied).toSorted().join(',') !== 'handoff,request' ||
+    !isRecord(supplied.request)
+  )
+    return { id, kind: 'error' as const, error: 'Invalid public replay job' };
+  let owner;
+  try {
+    owner = await acquireVaultOwner(
+      supplied.handoff === null ? {} : { handoff: supplied.handoff as VaultKeyHandoff },
+    );
+  } catch {
+    return { id, kind: 'error' as const, error: 'Local vault is locked' };
+  }
+  try {
+    return await runPublicArchiveWorkerRequest(
+      supplied.request,
+      new IndexedDbByteStore({ vault: owner }),
+    );
+  } finally {
+    await owner.close();
+  }
+}
+
 self.addEventListener('message', (event: MessageEvent<unknown>) => {
-  const request = event.data;
-  void runPublicArchiveWorkerRequest(request).then(
+  const supplied = event.data;
+  void run(supplied).then(
     (response) => {
-      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Dedicated Worker messages do not take a target origin.
       self.postMessage(response);
       return undefined;
     },
     () => {
-      const rawId =
-        typeof request === 'object' && request !== null ? Reflect.get(request, 'id') : 0;
-      const id = Number.isSafeInteger(rawId) && Number(rawId) > 0 ? Number(rawId) : 0;
-      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Dedicated Worker messages do not take a target origin.
-      self.postMessage({ id, kind: 'error', error: 'Public replay worker failed' });
+      self.postMessage({
+        id: requestId(supplied),
+        kind: 'error',
+        error: 'Public replay worker failed',
+      });
       return undefined;
     },
   );
diff --git a/apps/web/src/session/online-room.ts b/apps/web/src/session/online-room.ts
index 91eece8..211c6dc 100644
--- a/apps/web/src/session/online-room.ts
+++ b/apps/web/src/session/online-room.ts
@@ -24,6 +24,7 @@ import type {
 } from '@cp2p/protocol';
 import { acquireGameWriterLease, IndexedDbByteStore } from '@cp2p/storage';
 import type { GameWriterLease } from '@cp2p/storage';
+import type { VaultOwnerLease } from '@cp2p/storage';
 import { loadOnlineIdentity, loadOrCreateOnlineIdentity } from './online-credentials.js';
 import type { DisposableOnlineIdentity } from './online-credentials.js';
 import { createRoomId, validateOnlineInvite } from './online-invite.js';
@@ -48,6 +49,8 @@ import {
 import { OnlineChat } from './online-chat.js';
 import type { ChatContent, ChatSnapshot } from './online-chat.js';
 import { planPregameRoster } from './online-room-roster.js';
+import { getOnlineVaultController } from './online-vault-controller.js';
+import type { OnlineVaultController } from './online-vault-controller.js';
 
 export type OpenOnlineRoom =
   | {
@@ -99,6 +102,11 @@ function humanChatPeers(state: LobbyState): PeerId[] {
   return state.seats.flatMap((seat) => (seat.kind === 'human' ? [seat.peer] : []));
 }
 
+function requiredVault(value: VaultOwnerLease | null): VaultOwnerLease {
+  if (!value) throw new Error('Online vault owner is unavailable');
+  return value;
+}
+
 export interface OnlineRoomRuntime {
   readonly store?: EscrowCeremonyStore;
   readonly clock?: ProtocolClock;
@@ -177,6 +185,8 @@ export class OnlineRoom {
     controller: LobbyController | null,
     resume: OnlineWorkerResumeInfo | null,
     private readonly ownedStore: IndexedDbByteStore | null,
+    private readonly vaultController: OnlineVaultController | null,
+    private readonly vaultScope: VaultOwnerLease | null,
     private readonly store: EscrowCeremonyStore,
     private readonly clock: ProtocolClock,
     private readonly manualRtcFactory: () => RTCPeerConnection,
@@ -270,22 +280,54 @@ export class OnlineRoom {
   }
 
   static async open(request: OpenOnlineRoom, runtime: OnlineRoomRuntime = {}): Promise<OnlineRoom> {
-    const ownedStore = runtime.store ? null : new IndexedDbByteStore();
-    const store = runtime.store ?? ownedStore;
-    if (!store) throw new Error('Online storage is unavailable');
+    let room: OnlineRoom | null = null;
+    let scopeCancelled = false;
+    const vaultController = runtime.store ? null : getOnlineVaultController();
+    let vaultScope: VaultOwnerLease | null = null;
+    let ownedStore: IndexedDbByteStore | null = null;
+    let store: EscrowCeremonyStore | null = runtime.store ?? null;
     let identity: DisposableOnlineIdentity | null = null;
     let lease: GameWriterLease | null = null;
     let signaling: ServerSignalingAdapter | null = null;
     let relay: MeshRelaySignalingAdapter | null = null;
     let transport: WebRtcTransport | null = null;
     let controller: LobbyController | null = null;
-    let room: OnlineRoom | null = null;
     let worker: { client: OnlineWorkerClient; initialization: OnlineWorkerInitialization } | null =
       null;
     let workerClient: OnlineWorkerClient | null = null;
-    const createWorkerClient = () =>
-      new OnlineWorkerClient(runtime.workerFactory ? { worker: runtime.workerFactory() } : {});
+    const createWorkerClient = () => {
+      const handoff = vaultScope?.handoff();
+      return new OnlineWorkerClient({
+        ...(runtime.workerFactory ? { worker: runtime.workerFactory() } : {}),
+        ...(handoff ? { vaultHandoff: handoff } : {}),
+      });
+    };
     try {
+      vaultScope = vaultController
+        ? await vaultController.acquireScope(async () => {
+            scopeCancelled = true;
+            if (room) {
+              await room.close();
+              return;
+            }
+            workerClient?.fail(new Error('Local vault locked during room opening'));
+            controller?.dispose();
+            if (transport) transport.dispose();
+            else if (relay) relay.close();
+            else signaling?.close();
+            identity?.dispose();
+            try {
+              await lease?.close();
+            } finally {
+              await ownedStore?.close();
+            }
+          })
+        : null;
+      ownedStore = runtime.store
+        ? null
+        : new IndexedDbByteStore({ vault: requiredVault(vaultScope) });
+      store = runtime.store ?? ownedStore;
+      if (!store || scopeCancelled) throw new Error('Online storage is unavailable');
       identity =
         request.kind === 'resume'
           ? await loadOnlineIdentity(store)
@@ -395,6 +437,8 @@ export class OnlineRoom {
         controller,
         resume,
         ownedStore,
+        vaultController,
+        vaultScope,
         store,
         clock,
         runtime.manualRtcFactory ??
@@ -407,6 +451,7 @@ export class OnlineRoom {
         worker,
       );
       room.update({ signaling: status });
+      if (scopeCancelled) throw new Error('Online room closed during vault acquisition');
       if (request.kind === 'manual-join') {
         const answered = await room.answerManualOffer(request.offerCode);
         if (!answered.ok) throw new Error(answered.error.message);
@@ -430,7 +475,11 @@ export class OnlineRoom {
           try {
             await lease?.close();
           } finally {
-            await ownedStore?.close();
+            try {
+              await ownedStore?.close();
+            } finally {
+              if (vaultScope) await vaultController?.releaseScope(vaultScope);
+            }
           }
         }
       }
@@ -834,7 +883,11 @@ export class OnlineRoom {
       try {
         await this.lease.close();
       } finally {
-        await this.ownedStore?.close();
+        try {
+          await this.ownedStore?.close();
+        } finally {
+          if (this.vaultScope) await this.vaultController?.releaseScope(this.vaultScope);
+        }
       }
     }
   }
diff --git a/apps/web/src/session/online-transfer-destination.ts b/apps/web/src/session/online-transfer-destination.ts
index 9764258..29b52eb 100644
--- a/apps/web/src/session/online-transfer-destination.ts
+++ b/apps/web/src/session/online-transfer-destination.ts
@@ -23,6 +23,7 @@ import type {
   TransferPrivateEnvelope,
 } from '@cp2p/protocol';
 import { IndexedDbByteStore, IndexedDbProtocolJournal, TransferImportStore } from '@cp2p/storage';
+import type { VaultOwnerLease } from '@cp2p/storage';
 import * as v from 'valibot';
 import type { DisposableOnlineIdentity } from './online-credentials.js';
 import { saveOnlineGameRecord } from './online-game-records.js';
@@ -106,6 +107,7 @@ export interface OnlineTransferDestinationOptions {
   readonly expected: ExpectedOnlineTransferGame;
   readonly identity: DisposableOnlineIdentity;
   readonly store: IndexedDbByteStore;
+  readonly vault?: VaultOwnerLease;
   readonly bootstrapBytes?: Uint8Array;
   readonly importStore?: TransferImportStore;
   readonly importedArchiveId?: string;
@@ -308,6 +310,13 @@ export class OnlineTransferDestination {
     this.#phase = locator.stageKey ? 'imported' : locator.scope ? 'offered' : 'prepared';
   }
 
+  #journal(gameId: string, keyBinding?: { recordKey: string; bytes: Uint8Array }) {
+    return new IndexedDbProtocolJournal(gameId, {
+      ...(keyBinding ? { keyBinding } : {}),
+      ...(this.#options.vault ? { vault: this.#options.vault } : {}),
+    });
+  }
+
   static async create(
     options: OnlineTransferDestinationOptions,
   ): Promise<OnlineTransferDestination> {
@@ -487,11 +496,19 @@ export class OnlineTransferDestination {
           record: final.record,
           engine: createBaseEngine(),
           devicePeer: this.#options.identity.peerId,
+          ...(this.#options.vault
+            ? {
+                createJournal: (
+                  gameId: string,
+                  keyBinding: { recordKey: string; bytes: Uint8Array },
+                ) => this.#journal(gameId, keyBinding),
+              }
+            : {}),
         });
         const expectedGame = this.#locator.scope?.replacements[0]?.seat;
         if (active.humanSeat !== expectedGame)
           throw new TypeError('Promoted destination seat differs from reserved transfer');
-        const journal = new IndexedDbProtocolJournal(this.#options.expected.gameId);
+        const journal = this.#journal(this.#options.expected.gameId);
         try {
           const saved = await journal.load();
           if (!saved?.entries.some((item) => sameRef(transferEntryRef(item.entry), entry)))
@@ -1132,10 +1149,18 @@ export class OnlineTransferDestination {
             record: next.record,
             engine: createBaseEngine(),
             devicePeer: this.#options.identity.peerId,
+            ...(this.#options.vault
+              ? {
+                  createJournal: (
+                    gameId: string,
+                    keyBinding: { recordKey: string; bytes: Uint8Array },
+                  ) => this.#journal(gameId, keyBinding),
+                }
+              : {}),
           });
           if (active.gamePeer !== change.output.statement.destinationGame)
             throw new TypeError('Promoted journal binding differs from certified destination');
-          const journal = new IndexedDbProtocolJournal(this.#options.expected.gameId);
+          const journal = this.#journal(this.#options.expected.gameId);
           try {
             const saved = await journal.load();
             if (
@@ -1168,8 +1193,9 @@ export class OnlineTransferDestination {
           if (oldBinding) {
             if (oldBinding.length > 16 * 1024)
               throw new TypeError('Existing game binding is oversized');
-            const oldJournal = new IndexedDbProtocolJournal(this.#options.expected.gameId, {
-              keyBinding: { recordKey: bindingKey, bytes: oldBinding },
+            const oldJournal = this.#journal(this.#options.expected.gameId, {
+              recordKey: bindingKey,
+              bytes: oldBinding,
             });
             try {
               const saved = await oldJournal.load();
@@ -1222,11 +1248,9 @@ export class OnlineTransferDestination {
               await oldJournal.close();
             }
           }
-          const journal = new IndexedDbProtocolJournal(this.#options.expected.gameId, {
-            keyBinding: {
-              recordKey: bindingKey,
-              bytes: stage.bindingBytes,
-            },
+          const journal = this.#journal(this.#options.expected.gameId, {
+            recordKey: bindingKey,
+            bytes: stage.bindingBytes,
           });
           try {
             if (
diff --git a/apps/web/src/session/online-worker-client.ts b/apps/web/src/session/online-worker-client.ts
index 22ca18a..cafdc0c 100644
--- a/apps/web/src/session/online-worker-client.ts
+++ b/apps/web/src/session/online-worker-client.ts
@@ -1,6 +1,7 @@
 import { failure } from '@cp2p/engine';
 import type { Result } from '@cp2p/engine';
 import type { Unsubscribe } from '@cp2p/protocol';
+import type { VaultKeyHandoff } from '@cp2p/storage';
 import {
   MAX_ONLINE_WORKER_PENDING_REQUESTS,
   MAX_ONLINE_WORKER_REQUEST_BYTES,
@@ -156,9 +157,18 @@ export class OnlineWorkerClient {
   private stopped = false;
   private closing: Promise<void> | null = null;
   private fatalError: Error | null = null;
+  private readonly vaultHandoff: VaultKeyHandoff | null;
+  private vaultReady: Promise<Result<void>> | null = null;
 
-  constructor(options: { worker?: OnlineProtocolWorkerPort; generation?: string } = {}) {
+  constructor(
+    options: {
+      worker?: OnlineProtocolWorkerPort;
+      generation?: string;
+      vaultHandoff?: VaultKeyHandoff | null;
+    } = {},
+  ) {
     this.generation = options.generation ?? crypto.randomUUID();
+    this.vaultHandoff = options.vaultHandoff ?? null;
     this.worker =
       options.worker ??
       new Worker(new URL('./online-protocol-worker.ts', import.meta.url), { type: 'module' });
@@ -170,6 +180,19 @@ export class OnlineWorkerClient {
   request<K extends OnlineWorkerRequestBody['kind']>(
     body: Extract<OnlineWorkerRequestBody, { kind: K }>,
     options: { timeoutMs?: number } = {},
+  ): Promise<Result<OnlineWorkerReplyByKind[K]>> {
+    if (body.kind !== 'unlockVault' && body.kind !== 'shutdown' && this.vaultHandoff) {
+      this.vaultReady ??= this.send({ kind: 'unlockVault', handoff: this.vaultHandoff });
+      return this.vaultReady.then((ready) =>
+        ready.ok ? this.send(body, options) : failure(ready.error.code, ready.error.message),
+      );
+    }
+    return this.send(body, options);
+  }
+
+  private send<K extends OnlineWorkerRequestBody['kind']>(
+    body: Extract<OnlineWorkerRequestBody, { kind: K }>,
+    options: { timeoutMs?: number } = {},
   ): Promise<Result<OnlineWorkerReplyByKind[K]>> {
     if (this.stopped || (this.closing && body.kind !== 'shutdown'))
       return Promise.resolve(failure('online-worker-closed', 'The online worker is unavailable'));
diff --git a/apps/web/src/session/online-worker-messages.ts b/apps/web/src/session/online-worker-messages.ts
index 39cf3aa..49d64d3 100644
--- a/apps/web/src/session/online-worker-messages.ts
+++ b/apps/web/src/session/online-worker-messages.ts
@@ -17,6 +17,7 @@ import type {
   OnlineTransferDestination,
   OnlineTransferDestinationSnapshot,
 } from './online-transfer-destination.js';
+import type { VaultKeyHandoff } from '@cp2p/storage';
 
 export const ONLINE_WORKER_PROTOCOL = 'cp2p-online-worker-v1' as const;
 export const MAX_ONLINE_WORKER_REQUEST_BYTES = 1_048_576;
@@ -29,6 +30,7 @@ export interface OnlineWorkerHead {
 }
 
 export type OnlineWorkerRequestBody =
+  | { readonly kind: 'unlockVault'; readonly handoff: VaultKeyHandoff }
   | {
       readonly kind: 'initializeTransfer';
       readonly self: string;
@@ -133,6 +135,7 @@ export interface OnlineWorkerInitialization {
 }
 
 export interface OnlineWorkerReplyByKind {
+  unlockVault: void;
   initializeTransfer: OnlineTransferDestinationSnapshot;
   transferSnapshot: OnlineTransferDestinationSnapshot;
   prepareTransferOffer: SeatTransferAuthorization;
diff --git a/apps/web/src/session/online-worker-request-size.ts b/apps/web/src/session/online-worker-request-size.ts
index c256ddd..dc03e33 100644
--- a/apps/web/src/session/online-worker-request-size.ts
+++ b/apps/web/src/session/online-worker-request-size.ts
@@ -11,6 +11,25 @@ export function prepareOnlineWorkerRequest(body: OnlineWorkerRequestBody): {
   bytes: number;
   heavy: boolean;
 } {
+  if (body.kind === 'unlockVault') {
+    const { handoff } = body;
+    if (
+      !/^[0-9a-f]{64}$/.test(handoff.vaultId) ||
+      !Number.isSafeInteger(handoff.generation) ||
+      handoff.generation < 1 ||
+      !(handoff.key instanceof CryptoKey) ||
+      handoff.key.extractable ||
+      handoff.key.algorithm.name !== 'AES-GCM' ||
+      !handoff.key.usages.includes('encrypt') ||
+      !handoff.key.usages.includes('decrypt')
+    )
+      throw new TypeError('Vault key handoff is malformed');
+    return {
+      body: { kind: 'unlockVault', handoff: structuredClone(handoff) },
+      bytes: 128,
+      heavy: false,
+    };
+  }
   const bootstrap =
     body.kind === 'initializeTransfer' ||
     body.kind === 'refreshTransferBootstrap' ||
diff --git a/apps/web/src/session/online-worker-runtime.ts b/apps/web/src/session/online-worker-runtime.ts
index 125fea8..b2c3671 100644
--- a/apps/web/src/session/online-worker-runtime.ts
+++ b/apps/web/src/session/online-worker-runtime.ts
@@ -2,7 +2,8 @@ import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec'
 import { createBaseEngine, success } from '@cp2p/engine';
 import { transferChangeSchema, verifyLobbyFreezeAgreement } from '@cp2p/protocol';
 import type { ProtocolClock, SessionUpdate, Unsubscribe } from '@cp2p/protocol';
-import { IndexedDbByteStore } from '@cp2p/storage';
+import { acquireVaultOwner, IndexedDbByteStore, IndexedDbProtocolJournal } from '@cp2p/storage';
+import type { VaultKeyHandoff, VaultOwnerLease } from '@cp2p/storage';
 import * as v from 'valibot';
 import { loadOnlineIdentity } from './online-credentials.js';
 import type { DisposableOnlineIdentity } from './online-credentials.js';
@@ -85,7 +86,9 @@ function errorResult(error: unknown): {
 
 /** Owns one room's certified online ceremony and session, never exposing its keys to main. */
 export class OnlineWorkerRuntime {
-  private readonly store: WorkerStore;
+  private store: WorkerStore;
+  private readonly injectedStore: boolean;
+  private vaultOwner: VaultOwnerLease | null = null;
   private readonly clock: ProtocolClock;
   private readonly emit: (event: OnlineWorkerEvent) => void;
   private generation: string | null = null;
@@ -116,6 +119,7 @@ export class OnlineWorkerRuntime {
   private closing: Promise<void> | null = null;
 
   constructor(options: OnlineWorkerRuntimeOptions) {
+    this.injectedStore = options.store !== undefined;
     this.store = options.store ?? new IndexedDbByteStore();
     this.clock = options.clock ?? workerClock();
     this.emit = options.emit;
@@ -173,6 +177,7 @@ export class OnlineWorkerRuntime {
     if (heavy) this.pendingHeavy = true;
     else this.pendingBytes += bytes;
     const lifecycle = [
+      'unlockVault',
       'initialize',
       'initializeTransfer',
       'prepareTransferOffer',
@@ -232,6 +237,9 @@ export class OnlineWorkerRuntime {
 
   private async dispatch(body: OnlineWorkerRequestBody): Promise<unknown> {
     switch (body.kind) {
+      case 'unlockVault':
+        await this.ensureVaultOwner(body.handoff);
+        return undefined;
       case 'initializeTransfer':
         return this.initializeTransfer(body);
       case 'transferSnapshot':
@@ -419,6 +427,7 @@ export class OnlineWorkerRuntime {
   ): Promise<OnlineWorkerReplyByKind['initialize']> {
     if (this.identity || this.transport || this.startup)
       throw new Error('Worker already initialized');
+    await this.ensureVaultOwner();
     const identity = await loadOnlineIdentity(this.store);
     if (this.closed) {
       identity.dispose();
@@ -436,11 +445,24 @@ export class OnlineWorkerRuntime {
         resume = await loadOnlineGameRecord(this.store, body.gameId);
         if (!resume) throw new Error('Saved online game is missing');
         invite = validateOnlineInvite(resume.invite);
+        const vault = this.vaultOwner;
         const active = await loadActiveOnlineResume({
           store: this.store,
           record: resume,
           devicePeer: body.self,
           engine: createBaseEngine(),
+          ...(vault
+            ? {
+                createJournal: (
+                  gameId: string,
+                  keyBinding: { recordKey: string; bytes: Uint8Array },
+                ) =>
+                  new IndexedDbProtocolJournal(gameId, {
+                    keyBinding,
+                    vault,
+                  }),
+              }
+            : {}),
         });
         resumePeers = active.peers;
       } else invite = validateOnlineInvite(body.invite);
@@ -474,6 +496,7 @@ export class OnlineWorkerRuntime {
       throw new Error('Worker already initialized');
     if (!(this.store instanceof IndexedDbByteStore))
       throw new Error('Transfer promotion requires the atomic IndexedDB store');
+    await this.ensureVaultOwner();
     const identity = await loadOnlineIdentity(this.store);
     let destination: OnlineTransferDestination | undefined;
     try {
@@ -485,6 +508,7 @@ export class OnlineWorkerRuntime {
         expected: body.expected,
         identity,
         store: this.store,
+        ...(this.vaultOwner ? { vault: this.vaultOwner } : {}),
         signal: this.destinationAbort.signal,
         ...(body.bootstrapBytes === undefined ? {} : { bootstrapBytes: body.bootstrapBytes }),
         ...(body.importedArchiveId === undefined
@@ -510,6 +534,31 @@ export class OnlineWorkerRuntime {
     return this.destination;
   }
 
+  private async ensureVaultOwner(handoff?: VaultKeyHandoff): Promise<void> {
+    if (this.injectedStore) {
+      if (handoff) throw new Error('Injected worker storage cannot accept a vault handoff');
+      return;
+    }
+    if (this.vaultOwner) {
+      if (
+        handoff &&
+        (handoff.generation !== this.vaultOwner.generation ||
+          handoff.vaultId !== this.vaultOwner.handoff()?.vaultId)
+      )
+        throw new Error('Worker vault handoff differs from its pinned owner');
+      return;
+    }
+    const owner = await acquireVaultOwner(handoff ? { handoff } : {});
+    if (this.closed) {
+      await owner.close();
+      throw new Error('Worker closed during vault acquisition');
+    }
+    const oldStore = this.store;
+    this.store = new IndexedDbByteStore({ vault: owner });
+    this.vaultOwner = owner;
+    await oldStore.close();
+  }
+
   private async transferResult<T>(operation: Promise<T>): Promise<T> {
     const result = await operation;
     if (this.closed) throw new Error('Worker closed during transfer operation');
@@ -565,11 +614,26 @@ export class OnlineWorkerRuntime {
       | { approved: Extract<OnlineWorkerRequestBody, { kind: 'startCeremony' }>['agreement'] },
   ): void {
     if (!this.identity || !this.invite || !this.transport) throw new Error('Worker is not ready');
+    const vault = this.vaultOwner;
     const startup = new OnlineStartup({
       invite: this.invite,
       identity: this.identity,
       transport: this.transport,
       store: this.store,
+      ...(vault
+        ? {
+            gameRuntime: {
+              createJournal: (
+                gameId: string,
+                keyBinding: { recordKey: string; bytes: Uint8Array },
+              ) =>
+                new IndexedDbProtocolJournal(gameId, {
+                  keyBinding,
+                  vault,
+                }),
+            },
+          }
+        : {}),
       clock: this.clock,
       engine: createBaseEngine(),
       onGameFatal: (error) => this.fatal(error, 'game-writer-lost'),
@@ -721,7 +785,12 @@ export class OnlineWorkerRuntime {
         } finally {
           this.transport?.close();
           this.identity?.dispose();
-          await this.store.close();
+          try {
+            await this.store.close();
+          } finally {
+            await this.vaultOwner?.close();
+            this.vaultOwner = null;
+          }
         }
       }
     })();
diff --git a/packages/storage/src/local-vault.ts b/packages/storage/src/local-vault.ts
index ed62390..ae895b0 100644
--- a/packages/storage/src/local-vault.ts
+++ b/packages/storage/src/local-vault.ts
@@ -83,6 +83,20 @@ export interface VaultMigrationOptions {
   readonly lockManager?: VaultLockManager;
 }
 
+/** Public mode metadata only; acquiring an owner remains mandatory before private work. */
+export async function readLocalVaultStatus(): Promise<{
+  mode: 'clear' | 'locked';
+  generation: number;
+}> {
+  const access = new VaultRecordAccess(true);
+  try {
+    await access.pin();
+    return { mode: access.mode, generation: access.generation };
+  } finally {
+    access.close();
+  }
+}
+
 /** Exact public records needed by locked deletion, escrow retirement and transfer tombstones. */
 export function isPublicVaultRecord(key: string): boolean {
   return (
