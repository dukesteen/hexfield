import { hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type {
  GameSession,
  LobbyController,
  LobbyFreezeAgreement,
  ProtocolClock,
  Transport,
  Unsubscribe,
} from '@cp2p/protocol';
import type { OnlineGame } from './online-game.js';
import type { OnlineDeviceRoutes } from './online-game-transport.js';
import type { OnlineInvite } from './online-invite.js';
import type { OnlineStartupSnapshot } from './online-startup.js';
import { OnlineWorkerClient } from './online-worker-client.js';
import type {
  OnlineWorkerEvent,
  OnlineWorkerInitialization,
  OnlineWorkerResumeInfo,
} from './online-worker-messages.js';
import { OnlineWorkerSession } from './online-worker-session.js';
import { createMainThreadTransportBridge } from './online-worker-transport.js';

interface WorkerStartupOptions {
  invite: OnlineInvite;
  self: string;
  transport: Transport;
  clock: ProtocolClock;
  lobby?: LobbyController;
  freezePeers?: (peers: readonly string[]) => void;
  onDeviceRoutes?: (routes: OnlineDeviceRoutes) => void;
  resume?: OnlineWorkerResumeInfo;
  client?: OnlineWorkerClient;
  initialization?: OnlineWorkerInitialization;
  createClient?: () => OnlineWorkerClient;
}

/** The UI pins consent through the worker before ACKing; certified work stays there. */
export class OnlineWorkerStartup {
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribers: Unsubscribe[] = [];
  private client: OnlineWorkerClient | null = null;
  private bridge: ReturnType<typeof createMainThreadTransportBridge> | null = null;
  private attached: Promise<void> | null = null;
  private approved: LobbyFreezeAgreement | null;
  private current: OnlineStartupSnapshot | null;
  private activeGame: OnlineGame<GameSession> | null = null;
  private gameInfo: Extract<OnlineWorkerEvent, { kind: 'gameReady' }>['game'] | null = null;
  private work: Promise<void> | null = null;
  private retry: unknown = null;
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(private readonly options: WorkerStartupOptions) {
    this.approved = options.resume?.agreement ?? null;
    this.current = options.resume
      ? {
          phase: 'opening',
          awaitingSeats: [],
          locallyConsented: true,
          error: null,
          gameId: options.resume.gameId,
        }
      : null;
    if (options.client) this.connectClient(options.client);
    if (options.lobby) this.unsubscribers.push(options.lobby.onChange(() => this.observe()));
    this.unsubscribers.push(options.transport.onPeerChange(() => this.observe()));
    this.observe();
  }

  snapshot() {
    return this.current;
  }
  agreement() {
    return this.approved;
  }
  game() {
    return this.activeGame;
  }

  transferClient(): OnlineWorkerClient {
    if (this.closed || !this.activeGame || !this.client)
      throw new Error('An active online game is required for device transfer');
    return this.client;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  begin() {
    if (this.closed || !this.options.lobby || this.current)
      return failure('online-start-active', 'An online start is already active');
    return this.options.lobby.start(toBase64Url(crypto.getRandomValues(new Uint8Array(32))));
  }

  async retryFailed() {
    if (this.closed || this.activeGame || this.work || this.current?.phase !== 'error')
      return failure('online-start-retry', 'There is no failed start ready to retry');
    if (this.approved && this.client) {
      const result = await this.client.request({ kind: 'retryStart' });
      if (!result.ok) return result;
    }
    this.update({
      phase: this.approved ? 'opening' : 'freezing',
      awaitingSeats: [],
      locallyConsented: this.approved !== null,
      error: null,
      gameId: this.current.gameId,
    });
    this.observe();
    return success(undefined);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.bridge?.stopOutput();
    if (this.retry !== null) this.options.clock.clearTimeout(this.retry);
    this.retry = null;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.closing = (async () => {
      try {
        await this.client?.shutdown();
      } finally {
        this.bridge?.close();
      }
    })();
    this.activeGame?.session.dispose();
    this.listeners.clear();
    return this.closing;
  }

  private update(snapshot: OnlineStartupSnapshot): void {
    if (this.closed) return;
    this.current = snapshot;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Keep lifecycle independent of UI listeners. */
      }
    }
  }

  private fail(error: Error, halted = false): void {
    if (this.closed) return;
    this.bridge?.stopOutput();
    if (this.activeGame?.session instanceof OnlineWorkerSession)
      this.activeGame.session.fail(error);
    this.update({
      phase: halted ? 'halted' : 'error',
      awaitingSeats: [],
      locallyConsented: this.approved !== null,
      error: error.message,
      gameId: this.activeGame?.gameId ?? this.options.resume?.gameId ?? null,
    });
  }

  private connectClient(client: OnlineWorkerClient): void {
    this.client = client;
    this.unsubscribers.push(
      client.subscribe((event) => this.receive(event)),
      client.onFailure((error) => this.fail(error, true)),
    );
  }

  private inactive(): boolean {
    return this.closed || this.current?.phase === 'halted';
  }

  private receive(event: OnlineWorkerEvent): void {
    if (this.inactive()) return;
    if (event.kind === 'deviceRoutes') {
      this.options.onDeviceRoutes?.(event.routes);
    } else if (event.kind === 'startup') {
      if (event.snapshot?.phase === 'halted') {
        this.fail(new Error(event.snapshot.error ?? 'Online game stopped'), true);
        // Block output immediately, then allow the worker to drain durable writes and its lease.
        void this.client?.shutdown().catch(() => undefined);
      } else if (event.snapshot) this.update(event.snapshot);
    } else if (event.kind === 'gameReady') {
      this.gameInfo = event.game;
    } else if (event.kind === 'session') {
      if (!this.gameInfo || !this.client)
        throw new Error('Worker published a session before admitting the game');
      if (event.snapshot.localHumanSeat !== this.gameInfo.seat)
        throw new Error('Worker display seat differs from the admitted game');
      if (this.activeGame?.session instanceof OnlineWorkerSession)
        this.activeGame.session.accept(event.snapshot);
      else {
        const session = new OnlineWorkerSession(this.client, event.snapshot, () => {
          void this.close().catch(() => undefined);
        });
        this.activeGame = { ...this.gameInfo, session, close: () => this.close() };
        this.update({
          phase: 'playing',
          awaitingSeats: [],
          locallyConsented: true,
          error: null,
          gameId: this.gameInfo.gameId,
        });
      }
    }
  }

  private ensureAttached(): Promise<void> {
    if (this.attached) return this.attached;
    this.attached = (async () => {
      if (!this.client)
        this.connectClient(this.options.createClient?.() ?? new OnlineWorkerClient());
      const client = this.client;
      if (!client) throw new Error('Online worker is unavailable');
      if (!this.options.initialization) {
        const result = await client.request({
          kind: 'initialize',
          mode: 'fresh',
          self: this.options.self,
          invite: this.options.invite,
        });
        if (!result.ok) throw new Error(result.error.message);
        if (result.value.self !== this.options.self)
          throw new Error('Online worker device identity differs');
      }
      if (this.inactive()) return;
      const channel = new MessageChannel();
      this.bridge = createMainThreadTransportBridge({
        transport: this.options.transport,
        port: channel.port1,
        generation: client.generation,
        onFailure: (error) => client.fail(error),
      });
      const attached = await client.request({
        kind: 'attachTransport',
        self: this.options.self,
        peers: this.options.transport.peers(),
        port: channel.port2,
      });
      if (!attached.ok) throw new Error(attached.error.message);
    })().catch((error: unknown) => {
      const cause = error instanceof Error ? error : new Error('Could not attach online worker');
      this.client?.fail(cause);
      throw cause;
    });
    return this.attached;
  }

  private observe(): void {
    if (
      this.closed ||
      this.work ||
      this.activeGame ||
      this.current?.phase === 'error' ||
      this.current?.phase === 'halted'
    )
      return;
    this.work = this.advance()
      .catch((error: unknown) => {
        if (!this.closed && this.current?.phase !== 'halted')
          this.update({
            phase: 'error',
            awaitingSeats: [],
            locallyConsented: this.approved !== null,
            error: error instanceof Error ? error.message : 'Online startup failed',
            gameId: this.options.resume?.gameId ?? null,
          });
      })
      .finally(() => {
        this.work = null;
        if (
          this.closed ||
          this.approved ||
          this.activeGame ||
          this.current?.phase === 'error' ||
          this.current?.phase === 'halted'
        )
          return;
        if (this.retry === null)
          this.retry = this.options.clock.setTimeout(() => {
            this.retry = null;
            this.observe();
          }, 1_000);
      });
  }

  private async advance(): Promise<void> {
    if (this.options.resume) {
      await this.ensureAttached();
      return;
    }
    const lobby = this.options.lobby;
    const state = lobby?.state();
    if (
      !state ||
      state.status !== 'starting' ||
      this.approved ||
      !state.seats.some((seat) => seat.kind === 'human' && seat.peer === this.options.self)
    )
      return;
    this.update({
      phase: 'freezing',
      awaitingSeats: [],
      locallyConsented: false,
      error: null,
      gameId: null,
    });
    await this.ensureAttached();
    if (this.inactive() || !this.client || !lobby) return;
    const pinned = await this.client.request({ kind: 'pinFreeze', state });
    if (!pinned.ok) throw new Error(pinned.error.message);
    if (this.inactive()) return;
    const current = lobby.state();
    if (!current || toHex(hashValue(current)) !== pinned.value.freezeHash) return;
    const acknowledged = lobby.ackFreeze();
    if (!acknowledged.ok) return;
    const agreement = lobby.freezeAgreement();
    if (!agreement) return;
    if (toHex(hashValue(agreement.state)) !== pinned.value.freezeHash) {
      const error = new Error('Lobby changed after pinned consent');
      this.client.fail(error);
      throw error;
    }
    // Freeze authenticated device discovery before the worker discloses ceremony material.
    if (!this.options.freezePeers) {
      const error = new Error('Fresh online start has no roster freeze');
      this.client.fail(error);
      throw error;
    }
    try {
      this.options.freezePeers(
        agreement.state.seats.flatMap((seat) => (seat.kind === 'human' ? [seat.peer] : [])),
      );
    } catch (error) {
      const cause = error instanceof Error ? error : new Error('Could not freeze device roster');
      this.client.fail(cause);
      throw cause;
    }
    this.approved = agreement;
    const started = await this.client.request({ kind: 'startCeremony', agreement });
    if (!started.ok) {
      const error = new Error(started.error.message);
      this.client.fail(error);
      throw error;
    }
  }
}
