import {
  canonicalDecode,
  canonicalEncode,
  fromBase64Url,
  hashValue,
  toBase64Url,
  toHex,
} from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Engine, Result } from '@cp2p/engine';
import { OnlineCeremony, genesisDigest, verifyLobbyFreezeAgreement } from '@cp2p/protocol';
import type {
  EscrowCeremonyStore,
  LobbyController,
  LobbyFreezeAgreement,
  OnlineCeremonyProgress,
  LobbyState,
  ProtocolClock,
  Transport,
  Unsubscribe,
} from '@cp2p/protocol';
import { loadCeremonyMaterial, prepareCeremonyMaterial } from './online-credentials.js';
import type { DisposableOnlineIdentity, OwnedCeremonyMaterial } from './online-credentials.js';
import { openOnlineGame } from './online-game.js';
import type { OnlineGame, OnlineGameRuntime } from './online-game.js';
import type { OnlineInvite } from './online-invite.js';
import { assertSupportedOnlineGameVersion, saveOnlineGameRecord } from './online-game-records.js';
import type { SavedOnlineGameRecord } from './online-game-records.js';
import { loadActiveOnlineResume } from './online-resume-binding.js';

export interface OnlineStartupSnapshot {
  readonly phase: OnlineCeremonyProgress['phase'] | 'freezing' | 'opening' | 'playing' | 'halted';
  readonly awaitingSeats: readonly number[];
  readonly locallyConsented: boolean;
  readonly error: string | null;
  readonly gameId: string | null;
}

interface OnlineStartupBase {
  readonly invite: OnlineInvite;
  readonly identity: DisposableOnlineIdentity;
  readonly transport: Transport;
  readonly store: EscrowCeremonyStore;
  readonly clock: ProtocolClock;
  readonly engine: Engine;
  readonly gameRuntime?: OnlineGameRuntime;
  readonly onGameFatal?: (error: Error) => void;
}

export type OnlineStartupOptions = OnlineStartupBase &
  (
    | {
        readonly lobby: LobbyController;
        /** Removes unseated connections and freezes discovery before key disclosure. */
        readonly freezePeers: (peers: readonly string[]) => void;
        readonly resume?: never;
        readonly approved?: never;
      }
    | {
        readonly resume: SavedOnlineGameRecord;
        readonly lobby?: never;
        readonly freezePeers?: never;
        readonly approved?: never;
      }
    | {
        /** The worker receives this only after the main lobby formed every signed ACK. */
        readonly approved: LobbyFreezeAgreement;
        readonly lobby?: never;
        readonly freezePeers?: never;
        readonly resume?: never;
      }
  );

/** Owns the immutable transition from device-key lobby consent to a game-key session. */
export class OnlineStartup {
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribers: Unsubscribe[] = [];
  private current: OnlineStartupSnapshot | null = null;
  private approved: LobbyFreezeAgreement | null = null;
  private material: Pick<OwnedCeremonyMaterial, 'keys' | 'dispose'> | null = null;
  private ceremony: OnlineCeremony | null = null;
  private activeGame: OnlineGame | null = null;
  private work: Promise<void> | null = null;
  private retry: unknown = null;
  private closed = false;
  private closing: Promise<void> | null = null;
  private activationAttempted = false;
  private revoked = false;
  private stoppingGame: Promise<void> | null = null;
  private readonly abort = new AbortController();
  private readonly resume: SavedOnlineGameRecord | null;
  private readonly invite: OnlineInvite;

  constructor(private readonly options: OnlineStartupOptions) {
    this.invite = copyEvidence(options.invite);
    if (options.resume) {
      assertSupportedOnlineGameVersion(options.resume.result.genesis);
      if (options.resume.result.entry.payload.kind === 'genesis')
        assertSupportedOnlineGameVersion(options.resume.result.entry.payload.genesis);
    }
    this.resume = options.resume ? copyEvidence(options.resume) : null;
    if (this.resume) {
      const checked = verifyLobbyFreezeAgreement(this.resume.agreement);
      if (
        !checked.ok ||
        genesisDigest(this.resume.result.genesis) !== this.resume.genesisDigest ||
        this.resume.result.genesis.gameId !== this.resume.gameId ||
        !sameBytes(canonicalEncode(this.resume.invite), canonicalEncode(this.invite))
      )
        throw new Error('Saved online game does not match its signed agreement');
      this.approved = checked.value;
      this.current = {
        phase: 'opening',
        awaitingSeats: [],
        locallyConsented: true,
        error: null,
        gameId: this.resume.gameId,
      };
    } else if (options.approved) {
      const checked = verifyLobbyFreezeAgreement(options.approved);
      if (!checked.ok || checked.value.state.lobbyId !== this.invite.roomId)
        throw new Error('Approved online start has an invalid signed agreement');
      this.approved = checked.value;
      this.current = {
        phase: 'frozen',
        awaitingSeats: [],
        locallyConsented: true,
        error: null,
        gameId: null,
      };
    }
    if (options.lobby) this.unsubscribers.push(options.lobby.onChange(() => this.observe()));
    this.unsubscribers.push(options.transport.onPeerChange(() => this.observe()));
    this.observe();
  }

  snapshot(): OnlineStartupSnapshot | null {
    return this.current
      ? { ...this.current, awaitingSeats: [...this.current.awaitingSeats] }
      : null;
  }

  agreement(): LobbyFreezeAgreement | null {
    // The verifier returns detached data; callers never receive the retained snapshot.
    if (!this.approved) return null;
    const checked = verifyLobbyFreezeAgreement(this.approved);
    return checked.ok ? checked.value : null;
  }

  game(): OnlineGame | null {
    return this.activeGame;
  }

  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  begin(): Result<void> {
    if (!this.options.lobby)
      return failure('online-start-resume', 'A saved game cannot start a new lobby ceremony');
    if (this.closed || this.approved || this.current)
      return failure('online-start-active', 'An online start is already active');
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    return this.options.lobby.start(toBase64Url(bytes));
  }

  /** Retry this exact attempt after storage or writer contention, never a new freeze. */
  async retryFailed(): Promise<Result<void>> {
    if (
      this.closed ||
      this.revoked ||
      this.activeGame ||
      this.work ||
      this.current?.phase !== 'error'
    )
      return failure('online-start-retry', 'There is no failed start ready to retry');
    if (this.ceremony && !this.ceremony.result()) {
      this.ceremony.dispose();
      await this.ceremony.flush();
      this.ceremony = null;
    }
    if (this.closed) return failure('online-start-closed', 'The room is closed');
    this.activationAttempted = false;
    this.update({
      phase: 'frozen',
      awaitingSeats: [],
      locallyConsented: this.current.locallyConsented,
      error: null,
      gameId: this.current.gameId,
    });
    this.observe();
    return success(undefined);
  }

  /** Closing stops output immediately, then drains writes before the room releases its lock. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.abort.abort();
    if (this.retry !== null) this.options.clock.clearTimeout(this.retry);
    this.retry = null;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.ceremony?.dispose();
    this.listeners.clear();
    this.closing = Promise.resolve().then(() => this.releaseResources());
    return this.closing;
  }

  private async releaseResources(): Promise<void> {
    try {
      await this.work;
      await this.ceremony?.flush();
      await this.stoppingGame;
      await this.activeGame?.close();
    } finally {
      this.material?.dispose();
      this.material = null;
    }
  }

  private update(value: OnlineStartupSnapshot): void {
    if (this.closed) return;
    this.current = value;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* A view cannot interrupt the durable start. */
      }
    }
  }

  private fail(error: unknown): void {
    if (this.revoked) return;
    this.update({
      phase: 'error',
      awaitingSeats: [],
      locallyConsented: this.ceremony?.snapshot().locallyConsented ?? Boolean(this.resume),
      error: error instanceof Error ? error.message : 'Online startup failed',
      gameId: this.resume?.gameId ?? this.current?.gameId ?? null,
    });
  }

  private observe(): void {
    if (
      this.closed ||
      this.revoked ||
      this.work ||
      this.activeGame ||
      this.current?.phase === 'error'
    )
      return;
    this.work = Promise.resolve()
      .then(() => this.advance())
      .catch((error: unknown) => this.fail(error))
      .finally(() => {
        this.work = null;
        if (this.closed || this.revoked || this.activeGame || this.current?.phase === 'error')
          return;
        if (this.retry === null) {
          this.retry = this.options.clock.setTimeout(() => {
            this.retry = null;
            this.observe();
          }, 1_000);
        }
      });
  }

  private async advance(): Promise<void> {
    if (this.closed || this.revoked) return;
    if (!this.approved) {
      const lobby = this.options.lobby;
      if (!lobby) throw new Error('Saved game has no verified freeze agreement');
      const state = lobby.state();
      if (!state || state.status !== 'starting') return;
      if (
        !state.seats.some(
          (seat) => seat.kind === 'human' && seat.peer === this.options.identity.peerId,
        )
      )
        return;
      this.update({
        phase: 'freezing',
        awaitingSeats: [],
        locallyConsented: false,
        error: null,
        gameId: null,
      });
      const freezeHash = toHex(hashValue(state));
      await this.pin(`online-freeze/${this.options.identity.peerId}/${state.ceremonyNonce}`, {
        protocol: 'online-freeze-pin-v1',
        freezeHash,
      });
      if (this.closed) return;
      const current = lobby.state();
      if (!current || toHex(hashValue(current)) !== freezeHash) return;
      // Exact ACK retries also let the host retransmit a dropped all-human agreement.
      const acknowledged = lobby.ackFreeze();
      if (!acknowledged.ok) return;
      const agreement = lobby.freezeAgreement();
      if (!agreement) return;
      const checked = verifyLobbyFreezeAgreement(agreement);
      if (!checked.ok) throw new Error(checked.error.message);
      const approved = checked.value;
      if (toHex(hashValue(approved.state)) !== freezeHash)
        throw new Error('Lobby changed after the locally pinned freeze');
      await this.pin(`online-start/${freezeHash}/agreement`, {
        protocol: 'online-browser-start-v1',
        invite: this.invite,
        agreement: approved,
      });
      if (this.closed) return;
      const freezePeers = this.options.freezePeers;
      if (!freezePeers) throw new Error('Fresh online start has no roster freeze');
      freezePeers(
        approved.state.seats.flatMap((seat) => (seat.kind === 'human' ? [seat.peer] : [])),
      );
      this.approved = approved;
    }
    if (this.resume && !this.ceremony) {
      const active = await loadActiveOnlineResume({
        store: this.options.store,
        record: this.resume,
        devicePeer: this.options.identity.peerId,
        engine: this.options.engine,
        includeMaterial: true,
        ...(this.options.gameRuntime?.createJournal
          ? { createJournal: this.options.gameRuntime.createJournal }
          : {}),
      });
      if (this.closed) {
        active.material?.dispose();
        return;
      }
      const original = this.resume.result.genesis.seats.some(
        (seat) =>
          seat.seat === active.humanSeat &&
          seat.kind === 'human' &&
          seat.publicKey === active.gamePeer &&
          this.approved?.state.seats.some(
            (frozen) =>
              frozen.seat === seat.seat &&
              frozen.kind === 'human' &&
              frozen.peer === this.options.identity.peerId,
          ),
      );
      if (!original) {
        if (!active.material) throw new Error('Transferred device has no active owned binding');
        this.material?.dispose();
        this.material = active.material;
        await this.openTransferredResume();
        return;
      }
      active.material?.dispose();
    }
    if (!this.ceremony) {
      const approved = this.approved;
      if (!this.resume && this.options.approved) {
        const freezeHash = toHex(hashValue(approved.state));
        await this.requirePin(
          `online-freeze/${this.options.identity.peerId}/${approved.state.ceremonyNonce}`,
          { protocol: 'online-freeze-pin-v1', freezeHash },
        );
        await this.pin(`online-start/${freezeHash}/agreement`, {
          protocol: 'online-browser-start-v1',
          invite: this.invite,
          agreement: approved,
        });
      }
      if (this.resume) {
        const freezeHash = toHex(hashValue(approved.state));
        await this.requirePin(
          `online-freeze/${this.options.identity.peerId}/${approved.state.ceremonyNonce}`,
          {
            protocol: 'online-freeze-pin-v1',
            freezeHash,
          },
        );
        await this.requirePin(`online-start/${freezeHash}/agreement`, {
          protocol: 'online-browser-start-v1',
          invite: this.invite,
          agreement: approved,
        });
        await this.requirePin(`online-game/${this.resume.genesisDigest}/start`, {
          protocol: 'online-browser-game-v1',
          invite: this.invite,
          agreement: approved,
          result: this.resume.result,
        });
      }
      const nonce = approved.state.ceremonyNonce;
      if (!nonce) throw new Error('Frozen lobby has no ceremony nonce');
      const layout = approved.state.seats.map((seat) => {
        if (seat.kind === 'open') throw new Error('Frozen lobby still contains an open seat');
        return seat.kind === 'human'
          ? { seat: seat.seat, kind: seat.kind, devicePeerId: seat.peer }
          : { seat: seat.seat, kind: seat.kind, botHost: seat.botHost };
      });
      this.material?.dispose();
      this.material = null;
      const materialInput = {
        store: this.options.store,
        identity: this.options.identity,
        ceremonyNonce: fromBase64Url(nonce),
        layout,
      };
      this.material = this.resume
        ? await loadCeremonyMaterial(materialInput)
        : await prepareCeremonyMaterial(materialInput);
      if (this.closed) return;
      const created = OnlineCeremony.create({
        agreement: approved,
        transport: this.options.transport,
        clock: this.options.clock,
        deviceSigningKey: this.options.identity.secretKey,
        ownedSeats: this.material.keys,
        store: this.options.store,
        engine: this.options.engine,
        ...(this.resume ? { restoreResult: this.resume.result } : {}),
        ...(!this.resume && approved.state.hostPeer === this.options.identity.peerId
          ? { hostCreatedAt: Math.floor(this.options.clock.now()) }
          : {}),
      });
      if (!created.ok) throw new Error(created.error.message);
      this.ceremony = created.value;
      this.unsubscribers.push(
        this.ceremony.onChange((progress) => {
          if (progress.locallyConsented && progress.error === 'online-ceremony-disputed') {
            this.haltDisputedGame();
            return;
          }
          if (this.revoked) return;
          if (this.activeGame || this.activationAttempted) return;
          this.update({ ...progress, gameId: this.resume?.gameId ?? null });
          this.observe();
        }),
      );
      const started = await this.ceremony.start();
      if (!started.ok) throw new Error(started.error.message);
      await this.ceremony.flush();
    }
    const result = this.ceremony.result();
    if (this.closed || this.revoked || !result || this.activationAttempted) return;
    if (this.resume && !sameBytes(canonicalEncode(result), canonicalEncode(this.resume.result)))
      throw new Error('Restored ceremony differs from the saved certified game');
    if (!this.material) throw new Error('Owned game material is unavailable');
    this.activationAttempted = true;
    this.update({
      phase: 'opening',
      awaitingSeats: [],
      locallyConsented: true,
      error: null,
      gameId: result.genesis.gameId,
    });
    if (!this.resume)
      await saveOnlineGameRecord(this.options.store, {
        invite: this.invite,
        agreement: this.approved,
        result,
      });
    if (this.closed || this.revoked) return;
    const game = await openOnlineGame(
      {
        ...result,
        agreement: this.approved,
        material: this.material.keys,
        deviceTransport: this.options.transport,
        store: this.options.store,
        clock: this.options.clock,
        engine: this.options.engine,
        signal: this.abort.signal,
        ...(this.options.onGameFatal ? { onFatal: this.options.onGameFatal } : {}),
        ...(this.resume ? { journalMode: 'restore-only' as const } : {}),
      },
      this.options.gameRuntime,
    );
    if (this.closed || this.revoked) {
      await game.close();
      return;
    }
    this.activeGame = game;
    this.material.dispose();
    this.material = null;
    this.update({
      phase: 'playing',
      awaitingSeats: [],
      locallyConsented: true,
      error: null,
      gameId: game.gameId,
    });
  }

  private async openTransferredResume(): Promise<void> {
    const resume = this.resume;
    const material = this.material;
    const agreement = this.approved;
    if (!resume || !material || !agreement || this.closed || this.revoked)
      throw new Error('Transferred resume is incomplete');
    this.activationAttempted = true;
    this.update({
      phase: 'opening',
      awaitingSeats: [],
      locallyConsented: true,
      error: null,
      gameId: resume.gameId,
    });
    const game = await openOnlineGame(
      {
        ...resume.result,
        agreement,
        material: material.keys,
        deviceTransport: this.options.transport,
        store: this.options.store,
        clock: this.options.clock,
        engine: this.options.engine,
        signal: this.abort.signal,
        journalMode: 'restore-only',
        ...(this.options.onGameFatal ? { onFatal: this.options.onGameFatal } : {}),
      },
      this.options.gameRuntime,
    ).finally(() => {
      material.dispose();
      if (this.material === material) this.material = null;
    });
    if (this.closed || this.revoked) {
      await game.close();
      return;
    }
    this.activeGame = game;
    this.update({
      phase: 'playing',
      awaitingSeats: [],
      locallyConsented: true,
      error: null,
      gameId: resume.gameId,
    });
  }

  private haltDisputedGame(): void {
    if (this.closed || this.revoked) return;
    this.revoked = true;
    // The coordinator has authenticated a secret disclosure, including after genesis.
    // Stop game output synchronously; preserve its public board and durable evidence.
    this.abort.abort();
    this.activeGame?.session.dispose();
    this.stoppingGame = this.activeGame?.close() ?? null;
    // close() will surface cleanup errors to the room owner after draining its work.
    void this.stoppingGame?.catch(() => undefined);
    if (this.retry !== null) this.options.clock.clearTimeout(this.retry);
    this.retry = null;
    this.update({
      phase: 'halted',
      awaitingSeats: [],
      locallyConsented: true,
      error: 'online-ceremony-disputed',
      gameId: this.activeGame?.gameId ?? this.current?.gameId ?? null,
    });
  }

  private async pin(id: string, value: unknown): Promise<void> {
    const bytes = canonicalEncode(value);
    const stored = this.options.store;
    await stored.withCeremonyLock(id, async () => {
      if (await stored.putIfAbsent(id, bytes)) return;
      const existing = await stored.load(id);
      if (
        !existing ||
        existing.length !== bytes.length ||
        existing.some((byte, index) => byte !== bytes[index])
      )
        throw new Error('Stored online start differs from the approved game');
    });
  }

  private async requirePin(id: string, value: unknown): Promise<void> {
    const bytes = canonicalEncode(value);
    const existing = await this.options.store.load(id);
    if (!existing || !sameBytes(existing, bytes))
      throw new Error('Saved online consent or game record is missing or differs');
  }
}

/** The worker durably pins the exact lobby state before the device signs its freeze ACK. */
export async function pinOnlineFreeze(
  store: EscrowCeremonyStore,
  self: string,
  supplied: LobbyState,
): Promise<string> {
  const state = copyEvidence(supplied);
  if (
    state.status !== 'starting' ||
    !state.ceremonyNonce ||
    !state.seats.some((seat) => seat.kind === 'human' && seat.peer === self)
  )
    throw new Error('Only a seated human can pin a starting lobby');
  const freezeHash = toHex(hashValue(state));
  const id = `online-freeze/${self}/${state.ceremonyNonce}`;
  const bytes = canonicalEncode({ protocol: 'online-freeze-pin-v1', freezeHash });
  await store.withCeremonyLock(id, async () => {
    if (await store.putIfAbsent(id, bytes)) return;
    const existing = await store.load(id);
    if (!existing || !sameBytes(existing, bytes))
      throw new Error('Stored online freeze differs from this lobby state');
  });
  return freezeHash;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function copyEvidence<T>(value: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Canonical data is detached and checked before use.
  return canonicalDecode(canonicalEncode(value)) as T;
}
