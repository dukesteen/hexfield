import {
  acquireVaultOwner,
  IndexedDbByteStore,
  migrateLocalVault,
  readLocalVaultStatus,
  VaultError,
} from '@cp2p/storage';
import type { VaultKeyHandoff, VaultOwnerLease } from '@cp2p/storage';
import { loadOrCreateOnlineIdentity } from './online-credentials.js';

export interface OnlineVaultSnapshot {
  readonly mode: 'clear' | 'locked';
  readonly state: 'loading' | 'ready' | 'locked' | 'busy' | 'error';
  readonly generation: number;
  readonly errorCode?: VaultError['code'];
}

type VaultLocks = Pick<LockManager, 'request'>;
const CLOSE_DEADLINE_MS = 30_000;

async function closeWithinDeadline(close: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      close(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new VaultError('busy', 'A live signer did not stop')),
          CLOSE_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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
  #ownerOpening: Promise<VaultOwnerLease> | null = null;
  #closing: Promise<void> | null = null;
  #lockEpoch = 0;
  #migration = false;
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
    if (this.#current.state === 'error' && (this.#owner || this.#scopes.size > 0))
      return Promise.resolve(this.snapshot());
    if (this.#current.state !== 'loading' && this.#current.state !== 'error')
      return Promise.resolve(this.snapshot());
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
    if (this.#current.mode === 'clear' && !this.#owner) await this.#refreshStatus();
    this.#assertIdle();
    const epoch = this.#lockEpoch;
    if (this.#current.mode !== 'locked') throw new VaultError('invalid-key', 'Vault is not locked');
    if (this.#owner) return;
    this.#set({ ...this.#current, state: 'busy' });
    try {
      const owner = await acquireVaultOwner({
        passphrase,
        ...(this.#lockManager ? { lockManager: this.#lockManager } : {}),
      });
      if (this.#disposed || this.#closing || epoch !== this.#lockEpoch) {
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
    const epoch = this.#lockEpoch;
    let parent: VaultOwnerLease;
    try {
      parent = await this.#openOwner();
    } catch (error) {
      if (error instanceof VaultError && ['locked', 'stale-generation'].includes(error.code))
        await this.#refreshStatus().catch(() => undefined);
      throw error;
    }
    this.#assertIdle();
    if (epoch !== this.#lockEpoch)
      throw new VaultError('closed', 'Vault locked while opening a scope');
    const handoff = parent.handoff();
    let scope: VaultOwnerLease;
    try {
      scope = await acquireVaultOwner({
        ...(handoff ? { handoff } : {}),
        ...(this.#lockManager ? { lockManager: this.#lockManager } : {}),
      });
    } catch (error) {
      if (error instanceof VaultError && ['locked', 'stale-generation'].includes(error.code))
        await this.#refreshStatus().catch(() => undefined);
      throw error;
    }
    if (this.#disposed || this.#closing || this.#owner !== parent || epoch !== this.#lockEpoch) {
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

  /** Deletion needs an exclusive vault lock; never close a live signer to obtain it. */
  async withIdleVaultReleased<T>(task: () => Promise<T>): Promise<T | null> {
    await this.ready();
    this.#assertIdle();
    if (this.#scopes.size > 0) return null;
    this.#migration = true;
    this.#lockEpoch += 1;
    this.#set({ ...this.#current, state: 'busy' });
    let failed = false;
    try {
      // An acquisition already opening must notice the changed epoch and close itself.
      await this.#ownerOpening?.catch(() => undefined);
      const owner = this.#owner;
      this.#owner = null;
      await owner?.close();
      return await task();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // Deletion drops the idle unlock key. A protected vault must be unlocked again.
      try {
        const status = await readLocalVaultStatus();
        this.#set({ ...status, state: status.mode === 'locked' ? 'locked' : 'ready' });
      } catch (error) {
        this.#set({ ...this.#current, state: 'error', errorCode: vaultCode(error) });
        // oxlint-disable-next-line no-unsafe-finally -- Preserve task failures; report refresh failure only after a successful task.
        if (!failed) throw error;
      } finally {
        this.#migration = false;
      }
    }
  }

  lock(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#lockEpoch += 1;
    this.#closing = this.#closeScopes().finally(() => {
      this.#closing = null;
    });
    return this.#closing;
  }

  async enable(passphrase: string): Promise<void> {
    await this.ready();
    this.#assertIdle();
    if (this.#current.mode !== 'clear')
      throw new VaultError('stale-generation', 'Vault mode changed before migration');
    let active: Promise<void> | null = null;
    const scope = await this.acquireScope(async () => {
      await active?.catch(() => undefined);
    });
    const store = new IndexedDbByteStore({ vault: scope });
    try {
      active = loadOrCreateOnlineIdentity(store).then((identity) => identity.dispose());
      await active;
    } finally {
      await store.close();
      await this.releaseScope(scope);
    }
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
    await this.#ownerOpening?.catch(() => undefined);
    const results = await Promise.allSettled(
      [...this.#scopes.values()].map((close) => closeWithinDeadline(close)),
    );
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
    this.#assertIdle();
    if (this.#current.mode !== expectedMode)
      throw new VaultError('stale-generation', 'Vault mode changed before migration');
    this.#migration = true;
    try {
      this.#channel?.postMessage('lock-request');
      await this.lock();
      this.#set({ ...this.#current, state: 'busy' });
      const timeout = new AbortController();
      const deadline = setTimeout(() => timeout.abort(), CLOSE_DEADLINE_MS);
      try {
        await migrateLocalVault({
          ...passphrases,
          signal: timeout.signal,
          ...(this.#lockManager ? { lockManager: this.#lockManager } : {}),
        });
      } catch (error) {
        if (timeout.signal.aborted)
          throw new VaultError('busy', 'Another tab did not release its vault owner');
        throw error;
      } finally {
        clearTimeout(deadline);
      }
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
    } finally {
      this.#migration = false;
    }
  }

  #assertIdle(): void {
    if (this.#disposed) throw new VaultError('closed', 'Vault controller is closed');
    if (
      this.#closing ||
      this.#migration ||
      this.#current.state === 'busy' ||
      this.#current.state === 'loading'
    )
      throw new VaultError('busy', 'Vault operation is in progress');
    if (this.#current.state === 'error')
      throw new VaultError(this.#current.errorCode ?? 'corrupt', 'Local vault is unavailable');
  }

  #openOwner(): Promise<VaultOwnerLease> {
    if (this.#owner) return Promise.resolve(this.#owner);
    if (this.#ownerOpening) return this.#ownerOpening;
    if (this.#current.mode === 'locked')
      return Promise.reject(new VaultError('locked', 'Local vault is locked'));
    const openedAt = this.#lockEpoch;
    this.#ownerOpening = acquireVaultOwner(
      this.#lockManager ? { lockManager: this.#lockManager } : {},
    )
      .then(async (owner) => {
        if (
          this.#disposed ||
          this.#closing ||
          this.#migration ||
          openedAt !== this.#lockEpoch ||
          this.#current.state !== 'ready'
        ) {
          await owner.close();
          throw new VaultError('closed', 'Vault closed while opening a scope');
        }
        this.#owner = owner;
        return owner;
      })
      .finally(() => {
        this.#ownerOpening = null;
      });
    return this.#ownerOpening;
  }

  async #refreshStatus(): Promise<void> {
    if (this.#disposed) return;
    const status = await readLocalVaultStatus();
    if (
      this.#owner &&
      (this.#owner.generation !== status.generation || this.#owner.mode !== status.mode)
    )
      await this.lock();
    if (!this.#disposed && !this.#owner && !this.#closing && !this.#migration)
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
