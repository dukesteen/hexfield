/**
 * The service-worker update state, kept apart from the `virtual:pwa-register` glue so it is
 * testable. Nothing here reloads the page unless the player asked for the update in this tab.
 */
export type UpdateStatus =
  /** No newer version is known. */
  | 'idle'
  /** A newer version is installed and waits for the player's confirmation. */
  | 'waiting'
  /** The player asked for the update; the new version installs or takes over. */
  | 'updating'
  /** The player asked for an update check and this device already runs the newest version. */
  | 'latest';

export interface UpdateSnapshot {
  readonly status: UpdateStatus;
  /** Every precached asset is stored, so local games work offline. */
  readonly offlineReady: boolean;
}

/** Checks the server for a newer service worker; `found` when one is installing or waiting. */
export type UpdateCheck = () => Promise<'found' | 'none'>;

export interface UpdateStoreOptions {
  readonly reload: () => void;
  /** How long a confirmed update may take to take control before the page reloads anyway. */
  readonly takeoverMs?: number;
}

export interface UpdateStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => UpdateSnapshot;
  /** A newer service worker is waiting; `activate` asks it to skip waiting. */
  needRefresh: (activate: () => Promise<void>) => void;
  /** A newer service worker took control of this page. */
  controllerChanged: () => void;
  offlineReady: () => void;
  setChecker: (check: UpdateCheck | null) => void;
  /** The player confirmed: activate the waiting version and reload this tab. */
  applyUpdate: () => Promise<void>;
  /** "Update now" from a version notice: check, install and reload, or report `latest`. */
  updateNow: () => Promise<void>;
}

export function createUpdateStore({ reload, takeoverMs = 4000 }: UpdateStoreOptions): UpdateStore {
  let snapshot: UpdateSnapshot = { status: 'idle', offlineReady: false };
  let activate: (() => Promise<void>) | null = null;
  let check: UpdateCheck | null = null;
  // Set only by an explicit confirmation in this tab; another tab's update never reloads us.
  let requested = false;
  const listeners = new Set<() => void>();
  const set = (next: Partial<UpdateSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };

  const store: UpdateStore = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    needRefresh(next) {
      activate = next;
      if (requested) void store.applyUpdate();
      else set({ status: 'waiting' });
    },
    controllerChanged() {
      if (requested) {
        reload();
        return;
      }
      // Another tab activated the new version. This page still runs the old code, so offer the
      // same deferred prompt; confirming only reloads.
      activate = async () => reload();
      set({ status: 'waiting' });
    },
    offlineReady() {
      set({ offlineReady: true });
    },
    setChecker(next) {
      check = next;
    },
    async applyUpdate() {
      requested = true;
      set({ status: 'updating' });
      const pending = activate;
      if (!pending) {
        reload();
        return;
      }
      try {
        await pending();
      } finally {
        // If the new worker never takes control (it was already active elsewhere, or the
        // message was lost), a plain reload still loads the newest precached version.
        setTimeout(reload, takeoverMs);
      }
    },
    async updateNow() {
      if (activate) return store.applyUpdate();
      if (!check) {
        // No service worker (development or an unsupported browser): the network has the latest.
        requested = true;
        reload();
        return;
      }
      requested = true;
      set({ status: 'updating' });
      let found: 'found' | 'none';
      try {
        found = await check();
      } catch {
        found = 'none';
      }
      if (found === 'none' && !activate) {
        requested = false;
        set({ status: 'latest' });
      }
    },
  };
  return store;
}

/** The app-wide store; `register.ts` feeds it from the service worker. */
export const pwaUpdates = createUpdateStore({ reload: () => window.location.reload() });
