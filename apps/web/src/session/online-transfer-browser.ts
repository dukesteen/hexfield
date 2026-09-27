import { toBase64Url } from '@cp2p/codec';
import type { Seat } from '@cp2p/engine';
import type { EscrowCeremonyStore, ProtocolClock, Unsubscribe } from '@cp2p/protocol';
import type { DisposableOnlineIdentity } from './online-credentials.js';
import {
  createTransferInvite,
  decodeTransferInvite,
  encodeTransferInvite,
  OnlineTransferLink,
} from './online-transfer-link.js';
import type { OnlineTransferInvite, OnlineTransferLinkOptions } from './online-transfer-link.js';
import type { OnlineTransferChannel } from './online-transfer-channel.js';
import { DestinationTransferExchange, SourceTransferExchange } from './online-transfer-exchange.js';
import type { TransferExchangePhase } from './online-transfer-exchange.js';
import {
  loadCurrentTransferInvite,
  OnlineTransferRecordStore,
  saveCurrentTransferInvite,
} from './online-transfer-records.js';
import type { OnlineTransferExchangeRecord } from './online-transfer-records.js';
import type { OnlineWorkerClient } from './online-worker-client.js';

export interface OnlineTransferBrowserSnapshot {
  readonly role: 'source' | 'destination';
  readonly invite: OnlineTransferInvite;
  readonly selfDevice: string;
  readonly candidates: readonly string[];
  readonly selectedDevice: string | null;
  readonly phase: TransferExchangePhase;
  readonly busy: boolean;
  readonly error: string | null;
  readonly promotedGameId: string | null;
  readonly closed: boolean;
}

interface BrowserOptions {
  readonly identity: DisposableOnlineIdentity;
  readonly store: EscrowCeremonyStore;
  readonly worker: OnlineWorkerClient;
  readonly clock: ProtocolClock;
  readonly network: Pick<
    OnlineTransferLinkOptions,
    'iceServers' | 'iceTransportPolicy' | 'rtcFactory' | 'socketFactory'
  >;
}

/** Owns the temporary transfer link. Its supplied identity and source game remain caller-owned. */
export class OnlineTransferBrowser {
  readonly #listeners = new Set<() => void>();
  readonly #records: OnlineTransferRecordStore;
  #record: OnlineTransferExchangeRecord | null;
  #snapshot: OnlineTransferBrowserSnapshot;
  #link: OnlineTransferLink | null = null;
  #channel: OnlineTransferChannel | null = null;
  #exchange: SourceTransferExchange | DestinationTransferExchange | null = null;
  #linkSelected = false;
  #linkGeneration = 0;
  #restoredTerminal = false;
  #pending = 0;
  #closing: Promise<void> | null = null;

  private constructor(
    private readonly options: BrowserOptions,
    invite: OnlineTransferInvite,
    role: 'source' | 'destination',
    record: OnlineTransferExchangeRecord | null,
  ) {
    const pinnedInvite = decodeTransferInvite(encodeTransferInvite(invite));
    Object.freeze(pinnedInvite.body);
    Object.freeze(pinnedInvite);
    this.#records = new OnlineTransferRecordStore(
      options.store,
      options.identity.peerId,
      pinnedInvite,
      role,
    );
    this.#record = record;
    this.#snapshot = Object.freeze({
      role,
      invite: pinnedInvite,
      selfDevice: options.identity.peerId,
      candidates: Object.freeze([]),
      selectedDevice:
        role === 'source' ? (record?.destinationDevice ?? null) : invite.body.sourceDevice,
      phase: 'connecting',
      busy: false,
      error: null,
      promotedGameId: null,
      closed: false,
    });
    if (role === 'source' && record) this.#ensureExchange();
  }

  static async openSource(
    options: BrowserOptions & {
      readonly gameId: string;
      readonly genesisDigest: string;
      readonly seat: Seat;
      readonly serverUrl: string;
    },
  ): Promise<OnlineTransferBrowser> {
    let invite = await loadCurrentTransferInvite(
      options.store,
      options.identity.peerId,
      options.gameId,
    );
    if (invite) {
      const records = new OnlineTransferRecordStore(
        options.store,
        options.identity.peerId,
        invite,
        'source',
      );
      if ((await records.load()).finished) invite = null;
    }
    if (!invite) {
      invite = createTransferInvite({
        identity: options.identity,
        gameId: options.gameId,
        genesisDigest: options.genesisDigest,
        seat: options.seat,
        serverUrl: options.serverUrl,
        attemptId: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
      });
      await saveCurrentTransferInvite(options.store, options.identity.peerId, invite);
    }
    if (invite.body.genesisDigest !== options.genesisDigest || invite.body.seat !== options.seat)
      throw new Error('Saved transfer invitation differs from this game and seat');
    const progress = await new OnlineTransferRecordStore(
      options.store,
      options.identity.peerId,
      invite,
      'source',
    ).load();
    const browser = new OnlineTransferBrowser(options, invite, 'source', progress.record);
    browser.#connect();
    return browser;
  }

  static async openDestination(
    options: BrowserOptions & { readonly invite: OnlineTransferInvite },
  ): Promise<OnlineTransferBrowser> {
    const records = new OnlineTransferRecordStore(
      options.store,
      options.identity.peerId,
      options.invite,
      'destination',
    );
    const progress = await records.load();
    const browser = new OnlineTransferBrowser(
      options,
      options.invite,
      'destination',
      progress.record,
    );
    if (progress.finished && (!browser.#record || !browser.#record.authorization))
      throw new TypeError('Finished transfer has no pinned destination authorization');
    if (!browser.#record) {
      browser.#record = browser.#emptyRecord(options.identity.peerId);
      await records.save(browser.#record);
    }
    try {
      if (progress.finished) {
        const restored = await options.worker.request({
          kind: 'initializeTransfer',
          self: options.identity.peerId,
          attemptId: options.invite.body.attemptId,
          mode: 'resume',
          expected: {
            gameId: options.invite.body.gameId,
            genesisDigest: options.invite.body.genesisDigest,
          },
        });
        if (!restored.ok) throw new Error(restored.error.message);
        browser.#ensureExchange();
        if (!(browser.#exchange instanceof DestinationTransferExchange))
          throw new TypeError('Finished transfer has no destination exchange');
        browser.#exchange.restoreTerminal(restored.value);
        browser.#restoredTerminal = true;
        if (restored.value.phase === 'promoted')
          browser.#update({ promotedGameId: options.invite.body.gameId });
        await options.worker.shutdown();
      }
      if (browser.#restoredTerminal) {
        // Receipt repair is best effort; a retired source need not be online to display
        // a locally verified terminal result.
        try {
          browser.#connect();
        } catch {
          browser.#link = null;
        }
      } else browser.#connect();
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
    return browser;
  }

  getSnapshot = (): OnlineTransferBrowserSnapshot => this.#snapshot;
  subscribe = (listener: () => void): Unsubscribe => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  selectDevice(peer: string): Promise<void> {
    return this.#perform(async () => {
      if (
        this.#snapshot.role !== 'source' ||
        this.#record ||
        !this.#link?.candidates().includes(peer)
      )
        throw new Error('Choose a connected destination for this transfer');
      const record = this.#emptyRecord(peer);
      await this.#records.save(record);
      this.#record = record;
      this.#update({ selectedDevice: peer });
      this.#ensureExchange();
      this.#selectKnownDestination();
    });
  }

  confirm(): Promise<void> {
    return this.#perform(async () => {
      if (!(this.#exchange instanceof SourceTransferExchange))
        throw new Error('Destination is not ready');
      await this.#exchange.confirm();
    });
  }

  cancel(): Promise<void> {
    return this.#perform(async () => {
      if (this.#snapshot.role !== 'source') {
        // The destination cannot unilaterally cancel a certified handoff.
        await this.close();
        return;
      }
      if (this.#exchange instanceof SourceTransferExchange) await this.#exchange.cancel();
      else if (!this.#record?.approved) this.#update({ phase: 'cancelled' });
      else throw new Error('Reconnect before cancelling the approved transfer');
      if (this.#snapshot.phase === 'cancelled') this.#link?.close();
    });
  }

  retry(): Promise<void> {
    return this.#perform(async () => {
      this.#update({ error: null });
      if (!this.#channel) this.#connect();
      await this.#exchange?.retry();
    });
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#update({ closed: true });
    this.#linkGeneration += 1;
    this.#link?.close();
    this.#channel = null;
    this.#exchange?.close();
    this.#closing =
      this.#snapshot.role === 'destination' ? this.options.worker.shutdown() : Promise.resolve();
    this.#listeners.clear();
    return this.#closing;
  }

  #emptyRecord(destinationDevice: string): OnlineTransferExchangeRecord {
    const { body } = this.#snapshot.invite;
    return {
      protocol: 'online-transfer-exchange-v1',
      role: this.#snapshot.role,
      attemptId: body.attemptId,
      gameId: body.gameId,
      genesisDigest: body.genesisDigest,
      sourceDevice: body.sourceDevice,
      destinationDevice,
      seat: body.seat,
      offer: null,
      approved: null,
      authorization: null,
      cancelRequested: false,
    };
  }

  #connect(): void {
    if (this.#snapshot.closed) throw new Error('Transfer is closed');
    const generation = ++this.#linkGeneration;
    const current = () => !this.#snapshot.closed && generation === this.#linkGeneration;
    this.#link?.close();
    this.#channel = null;
    this.#linkSelected = false;
    const options: OnlineTransferLinkOptions = {
      ...this.options.network,
      identity: this.options.identity,
      clock: this.options.clock,
      invite: this.#snapshot.invite,
      onChannel: (channel) => {
        if (!current()) return;
        this.#channel = channel;
        if (this.#restoredTerminal) {
          void this.#exchange?.retry().catch(() => undefined);
          return;
        }
        void this.#perform(async () => {
          this.#ensureExchange();
          if (this.#exchange instanceof SourceTransferExchange) await this.#exchange.start();
          else await this.#exchange?.retry();
        }).catch(() => undefined);
      },
      onArtifact: (artifact) => {
        if (!current()) return;
        if (this.#restoredTerminal) {
          void this.#exchange?.receive(artifact).catch(() => undefined);
          return;
        }
        void this.#perform(async () => {
          this.#ensureExchange();
          await this.#exchange?.receive(artifact);
        }).catch(() => undefined);
      },
      onError: (error) => {
        if (!current()) return;
        this.#channel = null;
        if (this.#restoredTerminal) return;
        this.#update({ error: error.message });
      },
    };
    this.#link =
      this.#snapshot.role === 'source'
        ? OnlineTransferLink.openSource(options)
        : OnlineTransferLink.openDestination(options);
    if (this.#snapshot.role === 'source')
      this.#link.onCandidates((peers) => {
        if (!current()) return;
        this.#update({ candidates: peers });
        this.#selectKnownDestination();
      });
  }

  #selectKnownDestination(): void {
    const peer = this.#record?.destinationDevice;
    if (!this.#linkSelected && peer && this.#link?.candidates().includes(peer)) {
      try {
        this.#link.selectDestination(peer);
        this.#linkSelected = true;
      } catch (error) {
        this.#channel = null;
        this.#update({
          error: error instanceof Error ? error.message : 'Transfer connection failed',
        });
        throw error;
      }
    }
  }

  #ensureExchange(): void {
    if (this.#exchange) return;
    const record = this.#record;
    if (!record) throw new Error('Transfer destination has not been selected');
    const common = {
      worker: this.options.worker,
      channel: {
        send: async (artifact: Parameters<OnlineTransferChannel['send']>[0]) => {
          if (!this.#channel) throw new Error('Transfer connection is unavailable');
          await this.#channel.send(artifact);
        },
      },
      savePublicRecord: async (next: OnlineTransferExchangeRecord) => {
        await this.#records.save(next);
        this.#record = next;
      },
      onChange: (phase: TransferExchangePhase) => this.#update({ phase }),
    };
    this.#exchange =
      record.role === 'source'
        ? new SourceTransferExchange({ ...common, record: { ...record, role: 'source' } })
        : new DestinationTransferExchange({
            ...common,
            record: { ...record, role: 'destination' },
            expected: { gameId: record.gameId, genesisDigest: record.genesisDigest },
            shutdownWorker: () => this.options.worker.shutdown(),
            onPromoted: (gameId) => {
              this.#update({ promotedGameId: gameId });
            },
          });
  }

  async #perform(task: () => Promise<void>): Promise<void> {
    if (this.#snapshot.closed) throw new Error('Transfer is closed');
    this.#pending += 1;
    this.#update({ busy: true, error: null });
    let failure: Error | null = null;
    try {
      await task();
    } catch (error) {
      failure = error instanceof Error ? error : new Error('Transfer failed');
    }
    try {
      if (
        this.#snapshot.phase === 'activated' ||
        this.#snapshot.phase === 'cancelled' ||
        this.#snapshot.phase === 'cancelled-awaiting-receipt'
      )
        await this.#records.finish();
    } catch (error) {
      failure ??=
        error instanceof Error ? error : new Error('Transfer progress could not be saved');
    } finally {
      this.#pending -= 1;
      this.#update({ busy: this.#pending > 0 });
    }
    if (failure) {
      this.#update({ error: failure.message });
      throw failure;
    }
  }

  #update(patch: Partial<OnlineTransferBrowserSnapshot>): void {
    if (this.#snapshot.closed) return;
    this.#snapshot = Object.freeze({
      ...this.#snapshot,
      ...patch,
      ...(patch.candidates ? { candidates: Object.freeze([...patch.candidates]) } : {}),
    });
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        /* A view cannot interrupt transfer work. */
      }
    }
  }
}
