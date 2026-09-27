import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { identityFromSecret, parsePeerId, signObject, verifyObject } from '@cp2p/crypto';
import { BASE_VERSION, ENGINE_VERSION, createBaseEngine, failure, success } from '@cp2p/engine';
import type { GameConfig, Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { genesisSchema } from './schemas.js';
import {
  hashSchema,
  key32Schema,
  nonnegativeIntegerSchema,
  seatSchema,
  signature64Schema,
} from './schema-values.js';
import { PROTOCOL_VERSION } from './types.js';
import { decodeMessage, encodeMessage } from './wire.js';
import type { PeerId, ProtocolClock, Transport, Unsubscribe } from './transport.js';
import { LOBBY_COLOURS } from './lobby-types.js';
import type {
  LobbyBotLevel,
  LobbyDiagnostic,
  LobbyFreezeAck,
  LobbyFreezeAgreement,
  LobbyRequest,
  LobbySeat,
  LobbyState,
} from './lobby-types.js';

const MAX_SPECTATORS = 8;
const MAX_PEERS = 12;
const MAX_FREEZE_ATTEMPTS = 32;
const HELLO_RETRY_MS = 1_000;
const MAX_HELLO_ATTEMPTS = 12;
const HELLO_REPLY_MIN_MS = 500;
const roomSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(128),
  v.regex(/^[A-Za-z0-9_-]+$/),
);
const nameSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(40),
  v.check((name) => name.trim() === name),
);
const colourSchema = v.picklist(LOBBY_COLOURS);
const botLevelSchema = v.picklist(['easy', 'medium', 'hard'] as const);
const openSeatSchema = v.strictObject({
  seat: seatSchema,
  kind: v.literal('open'),
  colour: colourSchema,
  ready: v.literal(false),
});
const humanSeatSchema = v.strictObject({
  seat: seatSchema,
  kind: v.literal('human'),
  peer: key32Schema,
  name: nameSchema,
  colour: colourSchema,
  ready: v.boolean(),
});
const botSeatSchema = v.strictObject({
  seat: seatSchema,
  kind: v.literal('bot'),
  name: nameSchema,
  colour: colourSchema,
  ready: v.literal(false),
  botLevel: botLevelSchema,
  botHost: key32Schema,
});
const stateSchema = v.strictObject({
  lobbyId: roomSchema,
  hostPeer: key32Schema,
  hostEpoch: nonnegativeIntegerSchema,
  version: nonnegativeIntegerSchema,
  name: nameSchema,
  seats: v.pipe(
    v.array(v.variant('kind', [openSeatSchema, humanSeatSchema, botSeatSchema])),
    v.minLength(2),
    v.maxLength(4),
  ),
  spectators: v.pipe(v.array(key32Schema), v.maxLength(MAX_SPECTATORS)),
  config: v.unknown(),
  status: v.picklist(['open', 'starting', 'started'] as const),
  ceremonyNonce: v.nullable(key32Schema),
});
const requestSchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('takeSeat'), seat: seatSchema }),
  v.strictObject({ kind: v.literal('leaveSeat') }),
  v.strictObject({ kind: v.literal('setName'), name: nameSchema }),
  v.strictObject({ kind: v.literal('setColour'), colour: colourSchema }),
  v.strictObject({ kind: v.literal('setReady'), ready: v.boolean() }),
  v.strictObject({ kind: v.literal('spectate') }),
]);
const requestBodySchema = v.strictObject({
  lobbyId: roomSchema,
  hostEpoch: nonnegativeIntegerSchema,
  baseVersion: nonnegativeIntegerSchema,
  nonce: nonnegativeIntegerSchema,
  peer: key32Schema,
  action: requestSchema,
});
const signedRequestSchema = v.strictObject({ body: requestBodySchema, sig: signature64Schema });
const stateBodySchema = v.strictObject({
  protocolVersion: nonnegativeIntegerSchema,
  engineVersion: v.string(),
  state: stateSchema,
});
const signedStateSchema = v.strictObject({ body: stateBodySchema, sig: signature64Schema });
const ackBodySchema = v.strictObject({
  lobbyId: roomSchema,
  hostEpoch: nonnegativeIntegerSchema,
  ceremonyNonce: key32Schema,
  stateHash: hashSchema,
  peer: key32Schema,
});
const signedAckSchema = v.strictObject({ body: ackBodySchema, sig: signature64Schema });
const hostBodySchema = v.strictObject({
  lobbyId: roomSchema,
  hostEpoch: nonnegativeIntegerSchema,
  baseVersion: nonnegativeIntegerSchema,
  nonce: nonnegativeIntegerSchema,
  peer: key32Schema,
});
const signedConfigSchema = v.strictObject({
  body: v.strictObject({ ...hostBodySchema.entries, config: v.unknown() }),
  sig: signature64Schema,
});
const signedKickSchema = v.strictObject({
  body: v.strictObject({ ...hostBodySchema.entries, target: key32Schema }),
  sig: signature64Schema,
});
const signedStartSchema = v.strictObject({
  body: v.strictObject({ ...hostBodySchema.entries, ceremonyNonce: key32Schema }),
  sig: signature64Schema,
});
const signedHelloSchema = v.strictObject({
  body: v.strictObject({
    lobbyId: roomSchema,
    peer: key32Schema,
    protocolVersion: nonnegativeIntegerSchema,
    engineVersion: v.string(),
  }),
  sig: signature64Schema,
});
const frozenBodySchema = v.strictObject({
  lobbyId: roomSchema,
  hostEpoch: nonnegativeIntegerSchema,
  stateHash: hashSchema,
  acks: v.pipe(v.array(signedAckSchema), v.minLength(1), v.maxLength(4)),
});
const signedFrozenSchema = v.strictObject({ body: frozenBodySchema, sig: signature64Schema });
const messageSchema = v.variant('t', [
  v.strictObject({ t: v.literal('LOBBY_HELLO'), hello: signedHelloSchema }),
  v.strictObject({ t: v.literal('LOBBY_STATE'), snapshot: signedStateSchema }),
  v.strictObject({ t: v.literal('LOBBY_REQ'), request: signedRequestSchema }),
  v.strictObject({ t: v.literal('LOBBY_CONFIG'), edit: signedConfigSchema }),
  v.strictObject({ t: v.literal('LOBBY_KICK'), edit: signedKickSchema }),
  v.strictObject({ t: v.literal('LOBBY_START'), edit: signedStartSchema }),
  v.strictObject({ t: v.literal('LOBBY_FREEZE_ACK'), ack: signedAckSchema }),
  v.strictObject({ t: v.literal('LOBBY_FROZEN'), agreement: signedFrozenSchema }),
]);

type LobbyMessage = v.InferOutput<typeof messageSchema>;

export interface LobbyControllerOptions {
  readonly lobbyId: string;
  readonly transport: Transport;
  readonly clock: ProtocolClock;
  /** Authenticated device identity, distinct from the fresh game key. */
  readonly secretKey: Uint8Array;
}

export interface HostLobbyOptions extends LobbyControllerOptions {
  readonly name: string;
  readonly hostName: string;
  readonly config: GameConfig;
}

export interface JoinLobbyOptions extends LobbyControllerOptions {
  readonly hostPeer: PeerId;
}

function clone<T>(value: T): T {
  // The caller passes only schema-checked lobby data or a signed value built here.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return canonicalDecode(canonicalEncode(value)) as T;
}

function resetSeatReady(seat: LobbySeat): LobbySeat {
  return seat.kind === 'human' ? { ...seat, ready: false } : seat;
}

function resetReady(seats: readonly LobbySeat[]): LobbySeat[] {
  return seats.map(resetSeatReady);
}

function stateHash(state: LobbyState): string {
  return toHex(hashValue(state));
}

function connected(transport: Transport, peer: PeerId): boolean {
  return peer === transport.self || transport.peers().includes(peer);
}

function validConfig(value: unknown): Result<GameConfig> {
  const parsed = v.safeParse(v.pick(genesisSchema, ['config']), { config: value });
  if (!parsed.success) return failure('lobby-config', 'Game configuration is malformed');
  const config = parsed.output.config;
  if (
    config.seats.length < 2 ||
    config.seats.length > 4 ||
    config.seats.some((seat, index) => seat !== index) ||
    config.modules.length !== 1 ||
    config.modules[0]?.id !== 'base' ||
    config.modules[0].version !== BASE_VERSION
  )
    return failure('lobby-config', 'Only two to four base seats are supported');
  try {
    createBaseEngine().createGame(config, new Uint8Array(32));
    return success(config);
  } catch {
    return failure('lobby-config', 'Game configuration fails engine validation');
  }
}

function validState(value: unknown): Result<LobbyState> {
  const parsed = v.safeParse(stateSchema, value);
  if (!parsed.success) return failure('lobby-state', 'Lobby snapshot is malformed');
  const checkedConfig = validConfig(parsed.output.config);
  if (!checkedConfig.ok) return checkedConfig;
  const state: LobbyState = { ...parsed.output, config: checkedConfig.value };
  const colours = new Set(state.seats.map((seat) => seat.colour));
  const humans = state.seats.filter((seat) => seat.kind === 'human');
  const members = [...humans.map((seat) => seat.peer), ...state.spectators];
  if (
    state.config.seats.length !== state.seats.length ||
    state.seats.some((seat, index) => seat.seat !== index) ||
    colours.size !== state.seats.length ||
    new Set(members).size !== members.length ||
    !members.includes(state.hostPeer) ||
    state.seats.some(
      (seat) => seat.kind === 'bot' && !humans.some((human) => human.peer === seat.botHost),
    ) ||
    (state.status === 'open') !== (state.ceremonyNonce === null) ||
    (state.status !== 'open' &&
      (state.seats.some((seat) => seat.kind === 'open') || humans.some((seat) => !seat.ready)))
  )
    return failure('lobby-state', 'Lobby snapshot violates seat or freeze rules');
  try {
    for (const peer of members) parsePeerId(peer);
    for (const seat of state.seats) if (seat.kind === 'bot') parsePeerId(seat.botHost);
  } catch {
    return failure('lobby-state', 'Lobby contains an invalid peer identity');
  }
  return success(state);
}

function verify(domain: string, body: unknown, sig: string, peer: PeerId): boolean {
  try {
    return verifyObject(domain, body, sig, parsePeerId(peer));
  } catch {
    return false;
  }
}

/** Host-owned lobby document. No secret material or genesis consent lives here. */
export class LobbyController {
  private current: LobbyState | null;
  private readonly peer: PeerId;
  private readonly key: Uint8Array;
  private readonly offMessage: Unsubscribe;
  private readonly offPeer: Unsubscribe;
  private readonly listeners = new Set<(state: LobbyState | null) => void>();
  private readonly diagnosticListeners = new Set<(diagnostic: LobbyDiagnostic | null) => void>();
  private readonly seenNonce = new Map<PeerId, number>();
  private readonly freezeSignatures = new Map<PeerId, LobbyFreezeAck>();
  private readonly ackedAttempts = new Map<string, string>();
  private readonly startedNonces = new Set<string>();
  private readonly helloReplies = new Map<PeerId, number>();
  private agreement: LobbyFreezeAgreement | null = null;
  private diagnostic: LobbyDiagnostic | null = null;
  private disrupted = false;
  private sentNonce = 0;
  private lastChangedAt: number;
  private disposed = false;
  private helloAttempts = 0;
  private helloTimer: unknown = null;

  private constructor(
    private readonly options: LobbyControllerOptions,
    private readonly initialHost: PeerId,
    initial: LobbyState | null,
  ) {
    const identity = identityFromSecret(options.secretKey);
    this.peer = identity.peerId;
    identity.secretKey.fill(0);
    this.key = options.secretKey.slice();
    this.lastChangedAt = options.clock.now();
    this.current = initial;
    this.offMessage = options.transport.onMessage((from, bytes) => this.receive(from, bytes));
    this.offPeer = options.transport.onPeerChange((peer, online) => this.peerChanged(peer, online));
  }

  static createHost(options: HostLobbyOptions): Result<LobbyController> {
    const checked = validConfig(options.config);
    if (!checked.ok) return checked;
    const room = v.safeParse(roomSchema, options.lobbyId);
    const name = v.safeParse(nameSchema, options.name);
    const hostName = v.safeParse(nameSchema, options.hostName);
    if (!room.success || !name.success || !hostName.success)
      return failure('lobby-input', 'Lobby ID or name is invalid');
    try {
      const identity = identityFromSecret(options.secretKey);
      const peer = identity.peerId;
      identity.secretKey.fill(0);
      if (peer !== options.transport.self)
        return failure('lobby-key', 'Local key differs from transport identity');
      const seats: LobbySeat[] = checked.value.seats.map((seat, index) =>
        index === 0
          ? {
              seat,
              kind: 'human',
              peer,
              name: hostName.output,
              colour: LOBBY_COLOURS[0],
              ready: false,
            }
          : { seat, kind: 'open', colour: LOBBY_COLOURS[index] ?? 'blue', ready: false },
      );
      const initial: LobbyState = {
        lobbyId: room.output,
        hostPeer: peer,
        hostEpoch: 0,
        version: 0,
        name: name.output,
        seats,
        spectators: [],
        config: checked.value,
        status: 'open',
        ceremonyNonce: null,
      };
      return success(new LobbyController(options, peer, initial));
    } catch {
      return failure('lobby-key', 'Local signing key is invalid');
    }
  }

  static join(options: JoinLobbyOptions): Result<LobbyController> {
    const room = v.safeParse(roomSchema, options.lobbyId);
    if (!room.success) return failure('lobby-input', 'Lobby ID is invalid');
    try {
      parsePeerId(options.hostPeer);
      const identity = identityFromSecret(options.secretKey);
      const matches = identity.peerId === options.transport.self;
      identity.secretKey.fill(0);
      if (!matches || options.hostPeer === options.transport.self)
        return failure('lobby-key', 'Join identity or host is invalid');
      const controller = new LobbyController(options, options.hostPeer, null);
      controller.hello();
      controller.scheduleHello();
      return success(controller);
    } catch {
      return failure('lobby-key', 'Join identity or host is invalid');
    }
  }

  state(): LobbyState | null {
    return this.current ? clone(this.current) : null;
  }
  getDiagnostic(): LobbyDiagnostic | null {
    return this.diagnostic ? clone(this.diagnostic) : null;
  }
  changedAt(): number {
    return this.lastChangedAt;
  }
  onChange(listener: (state: LobbyState | null) => void): Unsubscribe {
    this.listeners.add(listener);
    listener(this.state());
    return () => {
      this.listeners.delete(listener);
    };
  }
  onDiagnostic(listener: (diagnostic: LobbyDiagnostic | null) => void): Unsubscribe {
    this.diagnosticListeners.add(listener);
    listener(this.getDiagnostic());
    return () => {
      this.diagnosticListeners.delete(listener);
    };
  }
  freezeAgreement(): LobbyFreezeAgreement | null {
    return this.agreement && this.fullHumanMesh() ? clone(this.agreement) : null;
  }

  request(action: LobbyRequest): Result<void> {
    const state = this.current;
    if (this.disposed || !state || state.status !== 'open')
      return failure('lobby-unavailable', 'Lobby is not open');
    const parsed = v.safeParse(requestSchema, action);
    if (!parsed.success) return failure('lobby-request', 'Lobby request is malformed');
    const body = {
      lobbyId: state.lobbyId,
      hostEpoch: state.hostEpoch,
      baseVersion: state.version,
      nonce: ++this.sentNonce,
      peer: this.peer,
      action: parsed.output,
    };
    const request = { body, sig: signObject('lobby-request', body, this.key) };
    return this.peer === state.hostPeer
      ? this.applyRequest(this.peer, request)
      : this.send(state.hostPeer, { t: 'LOBBY_REQ', request });
  }

  configure(config: GameConfig): Result<void> {
    const checked = validConfig(config);
    if (!checked.ok) return checked;
    const authority = this.hostOpen();
    if (!authority.ok) return authority;
    const state = authority.value;
    const edit = this.hostEdit(state, 'lobby-config', { config: checked.value });
    const announced = this.broadcast({ t: 'LOBBY_CONFIG', edit });
    if (!announced.ok) return announced;
    const seats = checked.value.seats.map((seat, index) => {
      const current = state.seats[index];
      return current
        ? resetSeatReady(current)
        : {
            seat,
            kind: 'open' as const,
            colour: LOBBY_COLOURS[index] ?? 'blue',
            ready: false as const,
          };
    });
    return this.commit({ ...state, config: checked.value, seats });
  }

  setBot(seat: Seat, level: LobbyBotLevel, botHost = this.peer): Result<void> {
    const authority = this.hostOpen();
    if (!authority.ok) return authority;
    const state = authority.value;
    if (
      !v.safeParse(botLevelSchema, level).success ||
      !state.seats.some((item) => item.kind === 'human' && item.peer === botHost)
    )
      return failure('lobby-bot', 'Bot host or level is invalid');
    const current = state.seats[seat];
    if (!current || current.kind === 'human')
      return failure('lobby-bot', 'Bot needs an open or bot seat');
    return this.commit({
      ...state,
      seats: state.seats.map((item): LobbySeat =>
        item.seat === seat
          ? {
              seat,
              kind: 'bot',
              name: `Bot ${seat + 1}`,
              colour: item.colour,
              ready: false,
              botLevel: level,
              botHost,
            }
          : { ...item, ready: false },
      ),
    });
  }

  openSeat(seat: Seat): Result<void> {
    const authority = this.hostOpen();
    if (!authority.ok) return authority;
    const state = authority.value;
    const current = state.seats[seat];
    if (!current || current.kind === 'human')
      return failure('lobby-seat', 'Only a bot seat can be opened by the host');
    return this.commit({
      ...state,
      seats: state.seats.map((item): LobbySeat =>
        item.seat === seat
          ? { seat, kind: 'open', colour: item.colour, ready: false }
          : { ...item, ready: false },
      ),
    });
  }

  kick(peer: PeerId): Result<void> {
    const authority = this.hostOpen();
    if (!authority.ok) return authority;
    const state = authority.value;
    if (peer === this.peer || !this.member(state, peer))
      return failure('lobby-kick', 'Target is not another lobby member');
    const edit = this.hostEdit(state, 'lobby-kick', { target: peer });
    const announced = this.broadcast({ t: 'LOBBY_KICK', edit });
    if (!announced.ok) return announced;
    return this.commit({
      ...state,
      seats: state.seats.map((seat): LobbySeat =>
        (seat.kind === 'human' && seat.peer === peer) ||
        (seat.kind === 'bot' && seat.botHost === peer)
          ? { seat: seat.seat, kind: 'open', colour: seat.colour, ready: false }
          : { ...seat, ready: false },
      ),
      spectators: state.spectators.filter((item) => item !== peer),
    });
  }

  start(ceremonyNonce: string): Result<void> {
    const authority = this.hostOpen();
    if (!authority.ok) return authority;
    const state = authority.value;
    if (!v.safeParse(key32Schema, ceremonyNonce).success)
      return failure('lobby-nonce', 'Freeze requires a fresh canonical ceremony nonce');
    if (this.startedNonces.has(ceremonyNonce))
      return failure('lobby-nonce-reuse', 'This ceremony nonce was already frozen');
    if (this.startedNonces.size >= MAX_FREEZE_ATTEMPTS)
      return failure('lobby-freeze-limit', 'Lobby has exhausted its freeze attempts');
    if (
      state.seats.some((seat) => seat.kind === 'open') ||
      state.seats.some((seat) => seat.kind === 'human' && !seat.ready) ||
      !this.fullHumanMesh()
    )
      return failure('lobby-not-ready', 'Every filled seat and connected human must be ready');
    const edit = this.hostEdit(state, 'lobby-start', { ceremonyNonce });
    const announced = this.broadcast({ t: 'LOBBY_START', edit });
    if (!announced.ok) return announced;
    this.startedNonces.add(ceremonyNonce);
    return this.commit({ ...state, status: 'starting', ceremonyNonce });
  }

  ackFreeze(): Result<void> {
    const state = this.current;
    if (
      this.disposed ||
      !state ||
      state.status !== 'starting' ||
      !state.ceremonyNonce ||
      !this.fullHumanMesh()
    )
      return failure('lobby-freeze', 'A connected exact starting snapshot is required');
    if (!state.seats.some((seat) => seat.kind === 'human' && seat.peer === this.peer))
      return failure('lobby-freeze', 'Only a seated human can freeze');
    const hash = stateHash(state);
    const prior = this.ackedAttempts.get(state.ceremonyNonce);
    if (prior && prior !== hash)
      return failure('lobby-freeze-conflict', 'A different freeze already used this nonce');
    if (!prior && this.ackedAttempts.size >= MAX_FREEZE_ATTEMPTS)
      return failure('lobby-freeze-limit', 'Lobby has exhausted its freeze attempts');
    this.ackedAttempts.set(state.ceremonyNonce, hash);
    const body = {
      lobbyId: state.lobbyId,
      hostEpoch: state.hostEpoch,
      ceremonyNonce: state.ceremonyNonce,
      stateHash: hash,
      peer: this.peer,
    };
    const ack = { body, sig: signObject('lobby-freeze-ack', body, this.key) };
    return this.peer === state.hostPeer
      ? this.receiveAck(this.peer, ack)
      : this.send(state.hostPeer, { t: 'LOBBY_FREEZE_ACK', ack });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offMessage();
    this.offPeer();
    this.stopHello();
    this.key.fill(0);
    this.listeners.clear();
    this.diagnosticListeners.clear();
    this.freezeSignatures.clear();
    this.helloReplies.clear();
    this.agreement = null;
  }

  private emit(): void {
    const snapshot = this.state();
    this.lastChangedAt = this.options.clock.now();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        /* UI observers cannot change lobby authority. */
      }
    }
  }

  private setDiagnostic(diagnostic: LobbyDiagnostic | null): void {
    this.diagnostic = diagnostic;
    for (const listener of this.diagnosticListeners) {
      try {
        listener(this.getDiagnostic());
      } catch {
        /* UI observers cannot change lobby authority. */
      }
    }
  }

  private send(to: PeerId, message: LobbyMessage): Result<void> {
    const encoded = encodeMessage(message, messageSchema);
    if (!encoded.ok) return encoded;
    try {
      this.options.transport.send(to, encoded.value);
      return success(undefined);
    } catch {
      return failure('lobby-transport', 'Could not send lobby packet');
    }
  }

  private broadcast(message: LobbyMessage): Result<void> {
    const encoded = encodeMessage(message, messageSchema);
    if (!encoded.ok) return encoded;
    try {
      this.options.transport.broadcast(encoded.value);
      return success(undefined);
    } catch {
      return failure('lobby-transport', 'Could not broadcast lobby packet');
    }
  }

  private hello(): void {
    if (this.disposed || this.peer === (this.current?.hostPeer ?? this.initialHost)) return;
    this.helloAttempts += 1;
    const body = {
      lobbyId: this.options.lobbyId,
      peer: this.peer,
      protocolVersion: PROTOCOL_VERSION,
      engineVersion: ENGINE_VERSION,
    };
    this.send(this.current?.hostPeer ?? this.initialHost, {
      t: 'LOBBY_HELLO',
      hello: { body, sig: signObject('lobby-hello', body, this.key) },
    });
  }

  private stopHello(): void {
    if (this.helloTimer !== null) this.options.clock.clearTimeout(this.helloTimer);
    this.helloTimer = null;
  }

  private scheduleHello(): void {
    if (
      this.disposed ||
      this.current ||
      this.helloTimer !== null ||
      this.helloAttempts >= MAX_HELLO_ATTEMPTS
    )
      return;
    this.helloTimer = this.options.clock.setTimeout(() => {
      this.helloTimer = null;
      if (this.disposed || this.current) return;
      this.hello();
      this.scheduleHello();
    }, HELLO_RETRY_MS);
  }

  private publish(): Result<void> {
    const state = this.current;
    if (!state || state.hostPeer !== this.peer)
      return failure('lobby-host', 'Only the host can publish');
    const body = {
      protocolVersion: PROTOCOL_VERSION,
      engineVersion: ENGINE_VERSION,
      state: v.parse(stateSchema, state),
    };
    return this.broadcast({
      t: 'LOBBY_STATE',
      snapshot: { body, sig: signObject('lobby-state', body, this.key) },
    });
  }

  private sendState(to: PeerId): void {
    const state = this.current;
    if (!state || state.hostPeer !== this.peer) return;
    const body = {
      protocolVersion: PROTOCOL_VERSION,
      engineVersion: ENGINE_VERSION,
      state: v.parse(stateSchema, state),
    };
    this.send(to, {
      t: 'LOBBY_STATE',
      snapshot: { body, sig: signObject('lobby-state', body, this.key) },
    });
  }

  private receive(from: PeerId, bytes: Uint8Array): void {
    if (this.disposed) return;
    const decoded = decodeMessage(bytes, messageSchema);
    if (!decoded.ok) {
      this.setDiagnostic({ kind: 'invalid-message', code: decoded.error.code });
      return;
    }
    const message = decoded.value;
    switch (message.t) {
      case 'LOBBY_HELLO':
        if (
          this.current?.hostPeer === this.peer &&
          message.hello.body.lobbyId === this.options.lobbyId &&
          message.hello.body.peer === from &&
          verify('lobby-hello', message.hello.body, message.hello.sig, from)
        ) {
          const now = this.options.clock.now();
          const prior = this.helloReplies.get(from);
          if (prior !== undefined && now >= prior && now - prior < HELLO_REPLY_MIN_MS) break;
          if (prior === undefined && this.helloReplies.size >= MAX_PEERS) {
            const oldest = this.helloReplies.keys().next().value;
            if (oldest !== undefined) this.helloReplies.delete(oldest);
          }
          this.helloReplies.set(from, now);
          this.sendState(from);
        }
        break;
      case 'LOBBY_STATE':
        this.receiveState(from, message.snapshot);
        break;
      case 'LOBBY_REQ':
        this.applyRequest(from, message.request);
        break;
      case 'LOBBY_FREEZE_ACK':
        this.receiveAck(from, message.ack);
        break;
      case 'LOBBY_FROZEN':
        this.receiveFrozen(from, message.agreement);
        break;
      case 'LOBBY_CONFIG':
      case 'LOBBY_KICK':
      case 'LOBBY_START':
        if (
          !this.current ||
          from !== this.current.hostPeer ||
          message.edit.body.peer !== from ||
          message.edit.body.lobbyId !== this.current.lobbyId ||
          message.edit.body.hostEpoch !== this.current.hostEpoch ||
          !verify(
            message.t === 'LOBBY_CONFIG'
              ? 'lobby-config'
              : message.t === 'LOBBY_KICK'
                ? 'lobby-kick'
                : 'lobby-start',
            message.edit.body,
            message.edit.sig,
            from,
          )
        )
          this.setDiagnostic({ kind: 'invalid-message', code: 'lobby-host-edit' });
        // These announcements never mutate the document. The signed snapshot does.
        break;
    }
  }

  private receiveState(from: PeerId, snapshot: v.InferOutput<typeof signedStateSchema>): void {
    const body = snapshot.body;
    if (
      body.state.lobbyId !== this.options.lobbyId ||
      from !== body.state.hostPeer ||
      !verify('lobby-state', body, snapshot.sig, from)
    )
      return;
    if (body.protocolVersion !== PROTOCOL_VERSION) {
      this.setDiagnostic({ kind: 'protocol-version', hostVersion: body.protocolVersion });
      return;
    }
    if (body.engineVersion !== ENGINE_VERSION) {
      this.setDiagnostic({ kind: 'engine-version', hostVersion: body.engineVersion });
      return;
    }
    const checked = validState(body.state);
    if (!checked.ok) return;
    const next = checked.value;
    const prior = this.current;
    if (!prior) {
      if (from !== this.initialHost) return;
    } else if (next.hostEpoch === prior.hostEpoch) {
      if (from !== prior.hostPeer || next.version <= prior.version) return;
    } else {
      if (
        next.hostEpoch !== prior.hostEpoch + 1 ||
        prior.status === 'started' ||
        (!this.disrupted && connected(this.options.transport, prior.hostPeer)) ||
        !this.member(prior, from) ||
        next.status !== 'open' ||
        next.seats.some((seat) => seat.ready)
      )
        return;
      const candidates = this.members(prior).filter((peer) =>
        connected(this.options.transport, peer),
      );
      if (candidates.toSorted()[0] !== from) return;
    }
    this.current = next;
    this.stopHello();
    this.helloAttempts = 0;
    this.agreement = null;
    this.freezeSignatures.clear();
    this.setDiagnostic(null);
    this.emit();
  }

  private applyRequest(
    from: PeerId,
    signed: v.InferOutput<typeof signedRequestSchema>,
  ): Result<void> {
    const state = this.current;
    if (!state || this.peer !== state.hostPeer || state.status !== 'open')
      return failure('lobby-host', 'No open host can accept this request');
    const { body } = signed;
    if (
      body.peer !== from ||
      body.lobbyId !== state.lobbyId ||
      body.hostEpoch !== state.hostEpoch ||
      body.baseVersion !== state.version ||
      !connected(this.options.transport, from) ||
      !verify('lobby-request', body, signed.sig, from)
    )
      return failure('lobby-request-binding', 'Request differs from the current host or sender');
    if (body.nonce <= (this.seenNonce.get(from) ?? 0))
      return failure('lobby-request-replay', 'Request nonce was already used');
    if (!this.seenNonce.has(from) && this.seenNonce.size >= MAX_PEERS)
      return failure('lobby-capacity', 'Lobby request roster is full');
    const action = body.action;
    const seats = state.seats.map((seat): LobbySeat => ({ ...seat }));
    const ownIndex = seats.findIndex((seat) => seat.kind === 'human' && seat.peer === from);
    let spectators = [...state.spectators];
    switch (action.kind) {
      case 'takeSeat': {
        const target = seats[action.seat];
        if (ownIndex >= 0 || !target || target.kind !== 'open')
          return failure('lobby-seat', 'Peer must take one open seat');
        seats[action.seat] = {
          seat: action.seat,
          kind: 'human',
          peer: from,
          name: `Player ${action.seat + 1}`,
          colour: target.colour,
          ready: false,
        };
        spectators = spectators.filter((peer) => peer !== from);
        break;
      }
      case 'leaveSeat':
      case 'spectate': {
        if (ownIndex >= 0) {
          const previous = seats[ownIndex];
          if (!previous) return failure('lobby-seat', 'Peer seat is unavailable');
          seats[ownIndex] = {
            seat: previous.seat,
            kind: 'open',
            colour: previous.colour,
            ready: false,
          };
        }
        if (!spectators.includes(from)) spectators.push(from);
        if (spectators.length > MAX_SPECTATORS)
          return failure('lobby-capacity', 'Lobby spectator roster is full');
        break;
      }
      case 'setName':
        if (ownIndex < 0 || seats[ownIndex]?.kind !== 'human')
          return failure('lobby-seat', 'Peer does not own a human seat');
        seats[ownIndex] = { ...seats[ownIndex], name: action.name };
        break;
      case 'setColour':
        if (
          ownIndex < 0 ||
          seats.some((seat, index) => index !== ownIndex && seat.colour === action.colour)
        )
          return failure('lobby-colour', 'Colour must be unique to this seat');
        if (seats[ownIndex]?.kind !== 'human')
          return failure('lobby-seat', 'Peer seat is unavailable');
        seats[ownIndex] = { ...seats[ownIndex], colour: action.colour };
        break;
      case 'setReady':
        if (ownIndex < 0 || seats[ownIndex]?.kind !== 'human')
          return failure('lobby-seat', 'Peer does not own a human seat');
        seats[ownIndex] = { ...seats[ownIndex], ready: action.ready };
        break;
    }
    if (action.kind === 'takeSeat' || action.kind === 'leaveSeat' || action.kind === 'spectate')
      for (const seat of seats) if (seat.kind === 'human') seat.ready = false;
    const next = validState({ ...state, seats, spectators });
    if (!next.ok) return next;
    this.seenNonce.set(from, body.nonce);
    return this.commit(next.value);
  }

  private receiveAck(from: PeerId, ack: LobbyFreezeAck): Result<void> {
    const state = this.current;
    if (
      !state ||
      state.hostPeer !== this.peer ||
      state.status !== 'starting' ||
      !state.ceremonyNonce ||
      !this.fullHumanMesh()
    )
      return failure('lobby-freeze', 'Host has no connected freeze attempt');
    if (
      ack.body.peer !== from ||
      ack.body.lobbyId !== state.lobbyId ||
      ack.body.hostEpoch !== state.hostEpoch ||
      ack.body.ceremonyNonce !== state.ceremonyNonce ||
      ack.body.stateHash !== stateHash(state) ||
      !state.seats.some((seat) => seat.kind === 'human' && seat.peer === from) ||
      !verify('lobby-freeze-ack', ack.body, ack.sig, from)
    )
      return failure('lobby-freeze-ack', 'Freeze ACK differs from the exact connected attempt');
    this.freezeSignatures.set(from, clone(ack));
    const humans = state.seats.filter((seat) => seat.kind === 'human').map((seat) => seat.peer);
    if (humans.every((peer) => this.freezeSignatures.has(peer))) {
      const acks = humans.flatMap((peer) => {
        const signature = this.freezeSignatures.get(peer);
        return signature ? [signature] : [];
      });
      this.agreement = { state: clone(state), acks: clone(acks) };
      const body = {
        lobbyId: state.lobbyId,
        hostEpoch: state.hostEpoch,
        stateHash: stateHash(state),
        acks,
      };
      this.broadcast({
        t: 'LOBBY_FROZEN',
        agreement: { body, sig: signObject('lobby-frozen', body, this.key) },
      });
      this.emit();
    }
    return success(undefined);
  }

  private receiveFrozen(from: PeerId, signed: v.InferOutput<typeof signedFrozenSchema>): void {
    const state = this.current;
    if (
      !state ||
      state.status !== 'starting' ||
      !this.fullHumanMesh() ||
      from !== state.hostPeer ||
      signed.body.lobbyId !== state.lobbyId ||
      signed.body.hostEpoch !== state.hostEpoch ||
      signed.body.stateHash !== stateHash(state) ||
      !verify('lobby-frozen', signed.body, signed.sig, from)
    )
      return;
    const humans = state.seats.filter((seat) => seat.kind === 'human').map((seat) => seat.peer);
    if (
      signed.body.acks.length !== humans.length ||
      new Set(signed.body.acks.map((ack) => ack.body.peer)).size !== humans.length ||
      signed.body.acks.some(
        (ack) =>
          !humans.includes(ack.body.peer) ||
          ack.body.stateHash !== signed.body.stateHash ||
          ack.body.ceremonyNonce !== state.ceremonyNonce ||
          ack.body.hostEpoch !== state.hostEpoch ||
          ack.body.lobbyId !== state.lobbyId ||
          !verify('lobby-freeze-ack', ack.body, ack.sig, ack.body.peer),
      )
    )
      return;
    this.agreement = { state: clone(state), acks: clone(signed.body.acks) };
    this.emit();
  }

  private peerChanged(peer: PeerId, online: boolean): void {
    if (this.disposed) return;
    if (online && peer === (this.current?.hostPeer ?? this.initialHost) && peer !== this.peer) {
      if (!this.current) this.helloAttempts = 0;
      this.hello();
      this.scheduleHello();
    }
    if (!this.current || !this.member(this.current, peer)) return;
    if (!online) this.disrupted = true;
    this.agreement = null;
    this.freezeSignatures.clear();
    const state = this.current;
    if (state.status === 'started') return;
    if (!connected(this.options.transport, state.hostPeer)) {
      const nextHost = this.members(state)
        .filter((member) => connected(this.options.transport, member))
        .toSorted()[0];
      if (nextHost === this.peer) {
        this.current = {
          ...state,
          hostPeer: this.peer,
          hostEpoch: state.hostEpoch + 1,
          version: 0,
          status: 'open',
          ceremonyNonce: null,
          seats: resetReady(state.seats),
        };
        this.seenNonce.clear();
        this.publish();
        this.emit();
      }
    } else if (state.hostPeer === this.peer && !online) {
      this.commit({
        ...state,
        status: 'open',
        ceremonyNonce: null,
        seats: resetReady(state.seats),
      });
    }
  }

  private hostOpen(): Result<LobbyState> {
    const state = this.current;
    return !this.disposed && state && state.hostPeer === this.peer && state.status === 'open'
      ? success(state)
      : failure('lobby-host', 'Only the open lobby host can edit');
  }

  private hostEdit<T extends Record<string, unknown>>(
    state: LobbyState,
    domain: string,
    fields: T,
  ): {
    body: {
      lobbyId: string;
      hostEpoch: number;
      baseVersion: number;
      nonce: number;
      peer: PeerId;
    } & T;
    sig: string;
  } {
    const body = {
      lobbyId: state.lobbyId,
      hostEpoch: state.hostEpoch,
      baseVersion: state.version,
      nonce: ++this.sentNonce,
      peer: this.peer,
      ...fields,
    };
    return { body, sig: signObject(domain, body, this.key) };
  }

  private commit(next: LobbyState): Result<void> {
    const current = this.current;
    if (!current || current.hostPeer !== this.peer)
      return failure('lobby-host', 'Only the host can commit');
    const checked = validState({ ...next, version: current.version + 1 });
    if (!checked.ok) return checked;
    this.current = checked.value;
    this.agreement = null;
    this.freezeSignatures.clear();
    const sent = this.publish();
    this.emit();
    return sent;
  }

  private members(state: LobbyState): PeerId[] {
    return [
      ...new Set([
        ...state.seats.filter((seat) => seat.kind === 'human').map((seat) => seat.peer),
        ...state.spectators,
      ]),
    ];
  }
  private member(state: LobbyState, peer: PeerId): boolean {
    return this.members(state).includes(peer);
  }
  private fullHumanMesh(): boolean {
    const state = this.current;
    return (
      !!state &&
      state.seats.every(
        (seat) => seat.kind !== 'human' || connected(this.options.transport, seat.peer),
      )
    );
  }
}
