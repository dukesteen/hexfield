import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { createBaseEngine, success } from '@cp2p/engine';
import { verifyLobbyFreezeAgreement } from '@cp2p/protocol';
import type { ProtocolClock, SessionUpdate, Unsubscribe } from '@cp2p/protocol';
import { IndexedDbByteStore } from '@cp2p/storage';
import { loadOnlineIdentity } from './online-credentials.js';
import type { DisposableOnlineIdentity } from './online-credentials.js';
import { validateOnlineInvite } from './online-invite.js';
import type { OnlineInvite } from './online-invite.js';
import { loadOnlineGameRecord } from './online-game-records.js';
import type { SavedOnlineGameRecord } from './online-game-records.js';
import { loadActiveOnlineResume } from './online-resume-binding.js';
import { OnlineStartup, pinOnlineFreeze } from './online-startup.js';
import { createWorkerDeviceTransport } from './online-worker-transport.js';
import {
  MAX_ONLINE_WORKER_REQUEST_BYTES,
  MAX_ONLINE_WORKER_PENDING_REQUESTS,
  MAX_ONLINE_WORKER_SNAPSHOT_BYTES,
  ONLINE_WORKER_PROTOCOL,
} from './online-worker-messages.js';
import type {
  OnlineWorkerEvent,
  OnlineWorkerReply,
  OnlineWorkerReplyByKind,
  OnlineWorkerRequest,
  OnlineWorkerRequestBody,
  OnlineWorkerSessionSnapshot,
} from './online-worker-messages.js';

type WorkerTransport = ReturnType<typeof createWorkerDeviceTransport>;
type WorkerStore = Pick<
  IndexedDbByteStore,
  'load' | 'putIfAbsent' | 'compareAndSwap' | 'withCeremonyLock' | 'close'
>;

export interface OnlineWorkerRuntimeOptions {
  readonly emit: (event: OnlineWorkerEvent) => void;
  readonly store?: WorkerStore;
  readonly clock?: ProtocolClock;
}

function workerClock(): ProtocolClock {
  const epoch = Date.now();
  const started = performance.now();
  return {
    now: () => epoch + performance.now() - started,
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => {
      if (typeof handle === 'number') globalThis.clearTimeout(handle);
    },
  };
}

function copyPublic<T>(value: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Canonical encoding detaches only public evidence and snapshots.
  return canonicalDecode(canonicalEncode(value)) as T;
}

function errorResult(error: unknown): {
  ok: false;
  error: { code: string; message: string; savedVersion?: number };
} {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'online-worker';
  const message = error instanceof Error ? error.message : 'Online worker request failed';
  const savedVersion =
    typeof error === 'object' &&
    error !== null &&
    'savedVersion' in error &&
    typeof error.savedVersion === 'number'
      ? error.savedVersion
      : undefined;
  return {
    ok: false,
    error: savedVersion === undefined ? { code, message } : { code, message, savedVersion },
  };
}

/** Owns one room's certified online ceremony and session, never exposing its keys to main. */
export class OnlineWorkerRuntime {
  private readonly store: WorkerStore;
  private readonly clock: ProtocolClock;
  private readonly emit: (event: OnlineWorkerEvent) => void;
  private generation: string | null = null;
  private lastId = 0;
  private pending = 0;
  private pendingBytes = 0;
  private work: Promise<void> = Promise.resolve();
  private readonly sessionWork = new Set<Promise<unknown>>();
  private identity: DisposableOnlineIdentity | null = null;
  private invite: OnlineInvite | null = null;
  private resume: SavedOnlineGameRecord | null = null;
  private transport: WorkerTransport | null = null;
  private startup: OnlineStartup | null = null;
  private sessionUnsubscribe: Unsubscribe | null = null;
  private startupUnsubscribe: Unsubscribe | null = null;
  private gameAnnounced = false;
  private lastUpdate: SessionUpdate | null = null;
  private pinnedFreezeHash: string | null = null;
  private visible = true;
  private visibilityToken = 0;
  private lastSnapshotId = 0;
  private unackedSnapshotId: number | null = null;
  private queuedSnapshot: OnlineWorkerSessionSnapshot | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(options: OnlineWorkerRuntimeOptions) {
    this.store = options.store ?? new IndexedDbByteStore();
    this.clock = options.clock ?? workerClock();
    this.emit = options.emit;
  }

  /** Request IDs are one-way and generation-scoped; shutdown bypasses queued work. */
  handle(request: OnlineWorkerRequest): Promise<OnlineWorkerReply> {
    if (
      request.protocol !== ONLINE_WORKER_PROTOCOL ||
      !Number.isSafeInteger(request.id) ||
      request.id <= this.lastId ||
      typeof request.generation !== 'string' ||
      request.generation.length < 1 ||
      request.generation.length > 256 ||
      (this.generation !== null && request.generation !== this.generation)
    )
      return Promise.resolve(this.reply(request, errorResult(new Error('Stale worker request'))));
    if (this.generation === null) this.generation = request.generation;
    this.lastId = request.id;
    if (request.body.kind === 'shutdown') {
      return this.close().then(
        () => this.reply(request, success(undefined)),
        (error: unknown) => this.reply(request, errorResult(error)),
      );
    }
    let bytes: number;
    try {
      const body =
        request.body.kind === 'attachTransport'
          ? { kind: request.body.kind, self: request.body.self, peers: request.body.peers }
          : request.body;
      bytes = canonicalEncode({
        protocol: request.protocol,
        generation: request.generation,
        id: request.id,
        body,
      }).byteLength;
    } catch {
      return Promise.resolve(
        this.reply(request, errorResult(new Error('Malformed worker request'))),
      );
    }
    const control =
      request.body.kind === 'ackSession' ||
      request.body.kind === 'setPrivateVisible' ||
      request.body.kind === 'cancelPending';
    const countLimit = control
      ? MAX_ONLINE_WORKER_PENDING_REQUESTS
      : MAX_ONLINE_WORKER_PENDING_REQUESTS - 4;
    const byteLimit = control
      ? MAX_ONLINE_WORKER_REQUEST_BYTES
      : MAX_ONLINE_WORKER_REQUEST_BYTES - 65_536;
    if (
      this.closed ||
      bytes > MAX_ONLINE_WORKER_REQUEST_BYTES ||
      this.pending >= countLimit ||
      this.pendingBytes + bytes > byteLimit
    )
      return Promise.resolve(
        this.reply(request, errorResult(new Error('Worker is closed or busy'))),
      );
    this.pending += 1;
    this.pendingBytes += bytes;
    const lifecycle = [
      'initialize',
      'attachTransport',
      'pinFreeze',
      'startCeremony',
      'retryStart',
    ].includes(request.body.kind);
    const operation = async () => {
      if (this.closed) throw new Error('Worker is closed');
      return this.dispatch(request.body);
    };
    const result = lifecycle ? this.work.then(operation) : Promise.resolve().then(operation);
    if (lifecycle)
      this.work = result.then(
        () => undefined,
        () => undefined,
      );
    else {
      this.sessionWork.add(result);
      void result.finally(() => this.sessionWork.delete(result)).catch(() => undefined);
    }
    return result
      .then(
        (value) => this.reply(request, success(value)),
        (error: unknown) => this.reply(request, errorResult(error)),
      )
      .finally(() => {
        this.pending -= 1;
        this.pendingBytes -= bytes;
      });
  }

  private reply(
    request: OnlineWorkerRequest,
    result:
      | { ok: true; value: unknown }
      | { ok: false; error: { code: string; message: string; savedVersion?: number } },
  ): OnlineWorkerReply {
    const reply = {
      protocol: ONLINE_WORKER_PROTOCOL,
      generation: request.generation,
      id: request.id,
      kind: request.body.kind,
      result,
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dispatch fixes the response value for each request kind.
    return reply as OnlineWorkerReply;
  }

  private async dispatch(body: OnlineWorkerRequestBody): Promise<unknown> {
    switch (body.kind) {
      case 'initialize':
        return this.initialize(body);
      case 'attachTransport':
        return this.attachTransport(body);
      case 'pinFreeze':
        return this.pinFreeze(body.state);
      case 'startCeremony':
        return this.startCeremony(body.agreement);
      case 'retryStart': {
        const retried = await this.requireStartup().retryFailed();
        if (!retried.ok) throw new Error(retried.error.message);
        return undefined;
      }
      case 'validate':
      case 'submit': {
        const session = this.requireSession();
        this.requireHead(body.head);
        if (body.seat !== this.requireStartup().game()?.seat)
          throw new Error('Only the local human seat accepts UI commands');
        const result =
          body.kind === 'validate'
            ? session.validate(body.seat, body.command)
            : await session.submit(body.seat, body.command, { expectedRevision: body.head.seq });
        if (!result.ok)
          throw Object.assign(new Error(result.error.message), { code: result.error.code });
        return undefined;
      }
      case 'setPrivateVisible':
        if (
          !Number.isSafeInteger(body.visibilityToken) ||
          body.visibilityToken <= this.visibilityToken
        )
          throw new Error('Private visibility token must increase');
        this.visibilityToken = body.visibilityToken;
        this.visible = body.visible;
        this.publishSession();
        return undefined;
      case 'exportSave': {
        const history = this.requireSession().exportSave();
        if (canonicalEncode(history).byteLength > MAX_ONLINE_WORKER_SNAPSHOT_BYTES)
          throw new Error('Certified history exceeds the worker export limit');
        return history;
      }
      case 'retryAudit':
        return this.requireSession().retryAudit();
      case 'ackSession':
        if (body.snapshotId !== this.unackedSnapshotId)
          throw new Error('Session snapshot acknowledgement is stale');
        this.unackedSnapshotId = null;
        if (this.queuedSnapshot) {
          const next = this.queuedSnapshot;
          this.queuedSnapshot = null;
          this.sendSessionSnapshot(next);
        }
        return undefined;
      case 'approveRecoveryAuthorization': {
        const result = await this.requireSession().approveRecoveryAuthorization(body.change);
        if (!result.ok)
          throw Object.assign(new Error(result.error.message), { code: result.error.code });
        return result.value;
      }
      case 'clearRecoveryApproval':
        this.requireSession().clearRecoveryApproval();
        return undefined;
      case 'requestTakeover': {
        const result = await this.requireSession().requestTakeover(
          body.departedSeat,
          body.botLevel,
        );
        if (!result.ok)
          throw Object.assign(new Error(result.error.message), { code: result.error.code });
        return undefined;
      }
      case 'cancelPending':
        if (body.seat !== this.requireStartup().game()?.seat)
          throw new Error('Only the local human seat can cancel a UI command');
        return this.requireSession().cancelPending(body.seat);
      case 'shutdown':
        return undefined;
    }
    return undefined;
  }

  private async initialize(
    body: Extract<OnlineWorkerRequestBody, { kind: 'initialize' }>,
  ): Promise<OnlineWorkerReplyByKind['initialize']> {
    if (this.identity || this.transport || this.startup)
      throw new Error('Worker already initialized');
    const identity = await loadOnlineIdentity(this.store);
    if (this.closed) {
      identity.dispose();
      throw new Error('Worker closed while loading identity');
    }
    if (identity.peerId !== body.self) {
      identity.dispose();
      throw new Error('Stored device identity differs from authenticated transport');
    }
    let resume: SavedOnlineGameRecord | null = null;
    let resumePeers: readonly string[] = [];
    let invite: OnlineInvite;
    try {
      if (body.mode === 'resume') {
        resume = await loadOnlineGameRecord(this.store, body.gameId);
        if (!resume) throw new Error('Saved online game is missing');
        invite = validateOnlineInvite(resume.invite);
        const active = await loadActiveOnlineResume({
          store: this.store,
          record: resume,
          devicePeer: body.self,
          engine: createBaseEngine(),
        });
        resumePeers = active.peers;
      } else invite = validateOnlineInvite(body.invite);
      if (this.closed) throw new Error('Worker closed while loading saved game');
      this.identity = identity;
      this.invite = copyPublic(invite);
      this.resume = resume;
      return {
        self: identity.peerId,
        invite: copyPublic(invite),
        resume: resume
          ? {
              gameId: resume.gameId,
              genesisDigest: resume.genesisDigest,
              agreement: copyPublic(resume.agreement),
              genesis: copyPublic(resume.result.genesis),
              peers: [...resumePeers],
            }
          : null,
      };
    } catch (error) {
      identity.dispose();
      throw error;
    }
  }

  private attachTransport(
    body: Extract<OnlineWorkerRequestBody, { kind: 'attachTransport' }>,
  ): void {
    if (!this.identity || !this.invite || this.transport || !this.generation)
      throw new Error('Worker transport cannot attach before initialization');
    if (body.self !== this.identity.peerId) throw new Error('Worker transport identity differs');
    this.transport = createWorkerDeviceTransport({
      self: body.self,
      peers: body.peers,
      port: body.port,
      generation: this.generation,
      onFailure: (error) => this.fatal(error, 'online-worker-transport'),
    });
    if (this.resume) this.openStartup({ resume: this.resume });
  }

  private async pinFreeze(
    state: Extract<OnlineWorkerRequestBody, { kind: 'pinFreeze' }>['state'],
  ): Promise<{ freezeHash: string }> {
    if (!this.identity || !this.invite || this.resume || this.startup)
      throw new Error('Fresh freeze is unavailable in this worker');
    if (state.lobbyId !== this.invite.roomId) throw new Error('Freeze belongs to a different room');
    const freezeHash = await pinOnlineFreeze(this.store, this.identity.peerId, state);
    if (this.closed) throw new Error('Worker closed during freeze pin');
    this.pinnedFreezeHash = freezeHash;
    return { freezeHash };
  }

  private startCeremony(
    agreement: Extract<OnlineWorkerRequestBody, { kind: 'startCeremony' }>['agreement'],
  ): void {
    if (!this.identity || !this.invite || !this.transport || this.resume || this.startup)
      throw new Error('Fresh ceremony cannot start yet');
    const checked = verifyLobbyFreezeAgreement(agreement);
    if (!checked.ok) throw new Error(checked.error.message);
    if (
      checked.value.state.lobbyId !== this.invite.roomId ||
      toHex(hashValue(checked.value.state)) !== this.pinnedFreezeHash
    )
      throw new Error('Signed agreement differs from the local durable freeze pin');
    this.openStartup({ approved: checked.value });
  }

  private openStartup(
    mode:
      | { resume: SavedOnlineGameRecord }
      | { approved: Extract<OnlineWorkerRequestBody, { kind: 'startCeremony' }>['agreement'] },
  ): void {
    if (!this.identity || !this.invite || !this.transport) throw new Error('Worker is not ready');
    const startup = new OnlineStartup({
      invite: this.invite,
      identity: this.identity,
      transport: this.transport,
      store: this.store,
      clock: this.clock,
      engine: createBaseEngine(),
      onGameFatal: (error) => this.fatal(error, 'game-writer-lost'),
      ...mode,
    });
    this.startup = startup;
    this.startupUnsubscribe = startup.subscribe(() => this.publishStartup());
    this.publishStartup();
  }

  private publishStartup(): void {
    if (!this.generation || !this.startup || this.closed) return;
    const snapshot = this.startup.snapshot();
    if (snapshot?.phase === 'halted') this.transport?.stopOutput();
    this.emit({
      protocol: ONLINE_WORKER_PROTOCOL,
      generation: this.generation,
      kind: 'startup',
      snapshot,
    });
    const game = this.startup.game();
    if (!game || this.gameAnnounced) return;
    this.gameAnnounced = true;
    this.emit({
      protocol: ONLINE_WORKER_PROTOCOL,
      generation: this.generation,
      kind: 'gameReady',
      game: { gameId: game.gameId, genesis: copyPublic(game.genesis), seat: game.seat },
    });
    this.sessionUnsubscribe = game.session.subscribe((update) => {
      this.lastUpdate = update;
      this.publishSession();
    });
  }

  private publishSession(): void {
    if (!this.generation || this.closed) return;
    const game = this.startup?.game();
    if (!game || !this.lastUpdate) return;
    const session = game.session;
    const privateState = this.visible ? session.getPrivate(game.seat) : null;
    const snapshot: OnlineWorkerSessionSnapshot = {
      committedHead: session.getCommittedHead(),
      update: this.lastUpdate,
      events: session.getEvents(),
      localHumanSeat: game.seat,
      privateState: privateState
        ? {
            seat: game.seat,
            hand: { ...privateState.hand },
            slots: { ...privateState.slots },
            ext: {},
          }
        : null,
      legal: privateState ? session.getLegalCommands(game.seat) : null,
      controllableSeats: session.controllableSeats().includes(game.seat) ? [game.seat] : [],
      visibilityToken: this.visibilityToken,
    };
    const encoded = canonicalEncode(snapshot);
    if (encoded.byteLength > MAX_ONLINE_WORKER_SNAPSHOT_BYTES) {
      this.fatal(
        new Error('Session snapshot exceeds the worker output limit'),
        'online-worker-output',
      );
      return;
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Canonical decoding detaches the bounded public snapshot.
    const detached = canonicalDecode(encoded) as OnlineWorkerSessionSnapshot;
    if (this.unackedSnapshotId !== null) this.queuedSnapshot = detached;
    else this.sendSessionSnapshot(detached);
  }

  private sendSessionSnapshot(snapshot: OnlineWorkerSessionSnapshot): void {
    if (!this.generation || this.closed) return;
    const snapshotId = ++this.lastSnapshotId;
    this.unackedSnapshotId = snapshotId;
    this.emit({
      protocol: ONLINE_WORKER_PROTOCOL,
      generation: this.generation,
      kind: 'session',
      snapshotId,
      snapshot,
    });
  }

  private requireStartup(): OnlineStartup {
    if (!this.startup) throw new Error('Online startup is not active');
    return this.startup;
  }

  private requireSession() {
    const game = this.requireStartup().game();
    if (!game || this.closed) throw new Error('Online game is not active');
    return game.session;
  }

  private requireHead(head: { seq: number; hash: string }): void {
    const current = this.requireSession().getCommittedHead();
    if (current.seq !== head.seq || current.hash !== head.hash)
      throw Object.assign(new Error('Certified head changed'), { code: 'stale-head' });
  }

  private fatal(error: Error, code: string): void {
    if (this.closed) return;
    this.stopOutput();
    if (this.generation)
      this.emit({
        protocol: ONLINE_WORKER_PROTOCOL,
        generation: this.generation,
        kind: 'fatal',
        error: { code, message: error.message },
      });
    // oxlint-disable-next-line promise/no-promise-in-callback -- Fatal transport/lease callbacks must start cleanup without blocking their caller.
    void this.close().catch(() => undefined);
  }

  private stopOutput(): void {
    this.transport?.stopOutput();
    this.startup?.game()?.session.dispose();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.stopOutput();
    this.closing = (async () => {
      await this.work;
      await Promise.allSettled(this.sessionWork);
      this.sessionUnsubscribe?.();
      this.startupUnsubscribe?.();
      try {
        await this.startup?.close();
      } finally {
        this.transport?.close();
        this.identity?.dispose();
        await this.store.close();
      }
    })();
    return this.closing;
  }
}
