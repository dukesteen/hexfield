Read-only correctness/security review. Current lobby rejects any signed request whose baseVersion differs from global hostversion. Every Ready commit increments thatversion, so normal simultaneous Readyup requests from unchanged settings/roster are silently rejected; deterministic before regression leaves only hostready, and real browser preceremony trace confirms all3guestsstayNotready. Proposed minimal fix: host-private readinessVersionFloor permits signed setReady with floor<=baseVersion<=currentversion; all other requests stillrequire exactversion. Floor initializedfrominitialstate, resetoneverysignedsnapshotadoption/authoritymigration and everyhostcommit except checked setReady alone. Signature/from/hostEpoch/membership/nonce guards unchanged. Host ownReady is included. Settings/roster/anyother mutation establishes freshfloor, no globalversion/protocolshape change. No new request rejection protocol: existing LOBBY_REQ handling ignores applyRequest result and there is no request-specific ACK/rejection message. Review authority/consent safety, stale context across settings/roster/migration, futureversion rejection, nonce/out-of-order toggles, hostcommit identification. No secrets, only task-scoped deterministic testsource. Require blockers with locations or APPROVE.

{
  "packages/protocol/src/lobby.ts": "9bb3cd7a6215981648bff67b0bea10aa3c12af9bfc62c6c48bcd56e6bd4aa4dc",
  "packages/protocol/src/lobby.test.ts": "c3560299550ac43522e58e04c1debdbc3b2ac1df71dbba78d726e4f767e7a22d",
  "packages/protocol/src/lobby-types.ts": "d4cf75e4495171a02c7ea4006812ab36aaa7eb87b037e9804e8731a789471c00"
}
Diff:
diff --git a/packages/protocol/src/lobby.test.ts b/packages/protocol/src/lobby.test.ts
index 4ffb7bc..e7f1d45 100644
--- a/packages/protocol/src/lobby.test.ts
+++ b/packages/protocol/src/lobby.test.ts
@@ -283,6 +283,160 @@ describe('signed lobby controller', () => {
     expect(room.host.start(nonce).ok).toBe(false);
   });
 
+  test('simultaneous Ready requests commute only across readiness commits', () => {
+    const room = setup();
+    active.push(room);
+    room.flush();
+    value(room.second.request({ kind: 'takeSeat', seat: 1 }));
+    room.flush();
+    value(room.third.request({ kind: 'takeSeat', seat: 2 }));
+    room.flush();
+    const version = required(room.host.state()).version;
+    value(room.host.request({ kind: 'setReady', ready: true }));
+    // Both guests still sign the same base version, before the host's Ready arrives.
+    expect(room.second.state()?.version).toBe(version);
+    expect(room.third.state()?.version).toBe(version);
+    value(room.second.request({ kind: 'setReady', ready: true }));
+    value(room.third.request({ kind: 'setReady', ready: true }));
+    room.flush();
+    expect(room.host.state()?.seats.map((seat) => seat.ready)).toEqual([true, true, true]);
+    expect(room.host.state()?.version).toBe(version + 3);
+  });
+
+  test.each(['settings', 'roster'] as const)('Ready intent cannot cross a %s change', (change) => {
+    const room = setup();
+    active.push(room);
+    room.flush();
+    value(room.second.request({ kind: 'takeSeat', seat: 1 }));
+    room.flush();
+    value(room.third.request({ kind: 'takeSeat', seat: 2 }));
+    room.flush();
+    value(room.second.request({ kind: 'setReady', ready: true }));
+    // Mutate the consent context before this already-signed Ready reaches the host.
+    if (change === 'settings') value(room.host.configure(room.config));
+    else value(room.host.kick(required(room.peers[2])));
+    const version = room.host.state()?.version;
+    room.flush();
+    expect(room.host.state()?.version).toBe(version);
+    expect(room.host.state()?.seats[1]?.ready).toBe(false);
+  });
+
+  test('readiness window does not widen other requests or future versions', () => {
+    const room = setup();
+    active.push(room);
+    room.flush();
+    value(room.second.request({ kind: 'takeSeat', seat: 1 }));
+    room.flush();
+    value(room.host.request({ kind: 'setReady', ready: true }));
+    value(room.second.request({ kind: 'setName', name: 'Stale name' }));
+    const version = required(room.host.state()).version;
+    room.flush();
+    expect(room.host.state()?.seats[1]).toMatchObject({ name: 'Player 2', ready: false });
+    const body = {
+      lobbyId: 'room_one',
+      hostEpoch: 0,
+      baseVersion: version + 1,
+      nonce: 100,
+      peer: required(room.peers[1]),
+      action: { kind: 'setReady', ready: true },
+    };
+    room.net.transport(required(room.peers[1])).send(
+      required(room.peers[0]),
+      canonicalEncode({
+        t: 'LOBBY_REQ',
+        request: { body, sig: signObject('lobby-request', body, required(room.keys[1])) },
+      }),
+    );
+    room.flush();
+    expect(room.host.state()?.version).toBe(version);
+    expect(room.host.state()?.seats[1]?.ready).toBe(false);
+  });
+
+  test('out-of-order Ready toggles and stale host epochs remain rejected', () => {
+    const room = setup();
+    active.push(room);
+    room.flush();
+    value(room.second.request({ kind: 'takeSeat', seat: 1 }));
+    room.flush();
+    value(room.second.request({ kind: 'setReady', ready: true }));
+    room.flush();
+    const baseVersion = required(room.host.state()).version;
+    const send = (nonce: number, ready: boolean, hostEpoch = 0) => {
+      const body = {
+        lobbyId: 'room_one',
+        hostEpoch,
+        baseVersion,
+        nonce,
+        peer: required(room.peers[1]),
+        action: { kind: 'setReady', ready },
+      };
+      room.net.transport(required(room.peers[1])).send(
+        required(room.peers[0]),
+        canonicalEncode({
+          t: 'LOBBY_REQ',
+          request: { body, sig: signObject('lobby-request', body, required(room.keys[1])) },
+        }),
+      );
+    };
+    send(100, false);
+    send(99, true);
+    send(100, true);
+    room.flush();
+    expect(room.host.state()?.seats[1]?.ready).toBe(false);
+    expect(room.host.state()?.version).toBe(baseVersion + 1);
+    send(101, true, 1);
+    room.flush();
+    expect(room.host.state()?.seats[1]?.ready).toBe(false);
+    expect(room.host.state()?.version).toBe(baseVersion + 1);
+  });
+
+  test('host migration clears the readiness window and rejects the old epoch', () => {
+    const room = setup();
+    active.push(room);
+    room.flush();
+    value(room.second.request({ kind: 'takeSeat', seat: 1 }));
+    room.flush();
+    value(room.third.request({ kind: 'takeSeat', seat: 2 }));
+    room.flush();
+    value(room.host.request({ kind: 'setReady', ready: true }));
+    room.flush();
+    const priorVersion = required(room.host.state()).version;
+    room.net.partition([
+      [required(room.peers[0])],
+      [required(room.peers[1]), required(room.peers[2])],
+    ]);
+    room.flush();
+    const electedIndex = required(room.peers[1]) < required(room.peers[2]) ? 1 : 2;
+    const senderIndex = electedIndex === 1 ? 2 : 1;
+    const elected = electedIndex === 1 ? room.second : room.third;
+    const body = {
+      lobbyId: 'room_one',
+      hostEpoch: 0,
+      baseVersion: priorVersion,
+      nonce: 100,
+      peer: required(room.peers[senderIndex]),
+      action: { kind: 'setReady', ready: true },
+    };
+    room.net.transport(required(room.peers[senderIndex])).send(
+      required(room.peers[electedIndex]),
+      canonicalEncode({
+        t: 'LOBBY_REQ',
+        request: { body, sig: signObject('lobby-request', body, required(room.keys[senderIndex])) },
+      }),
+    );
+    room.flush();
+    expect(elected.state()?.hostEpoch).toBe(1);
+    expect(elected.state()?.version).toBe(0);
+    expect(elected.state()?.seats.every((seat) => !seat.ready)).toBe(true);
+    value(elected.request({ kind: 'setReady', ready: true }));
+    // The remaining guest still sees version 0 in the new epoch; that Ready is allowed.
+    const sender = senderIndex === 1 ? room.second : room.third;
+    value(sender.request({ kind: 'setReady', ready: true }));
+    room.flush();
+    expect(elected.state()?.version).toBe(2);
+    expect(elected.state()?.seats[senderIndex]?.ready).toBe(true);
+  });
+
   test('rejects unauthorized edits, spoofed requests, stale replay, and reports version mismatch', () => {
     const room = setup();
     active.push(room);
diff --git a/packages/protocol/src/lobby.ts b/packages/protocol/src/lobby.ts
index 2516480..c41bfaa 100644
--- a/packages/protocol/src/lobby.ts
+++ b/packages/protocol/src/lobby.ts
@@ -334,6 +334,8 @@ export class LobbyController {
   private diagnostic: LobbyDiagnostic | null = null;
   private disrupted = false;
   private sentNonce = 0;
+  // Older Ready intents may commute only across commits that changed readiness alone.
+  private readinessVersionFloor = 0;
   private lastChangedAt: number;
   private disposed = false;
   private helloAttempts = 0;
@@ -350,6 +352,7 @@ export class LobbyController {
     this.key = options.secretKey.slice();
     this.lastChangedAt = options.clock.now();
     this.current = initial;
+    this.readinessVersionFloor = initial?.version ?? 0;
     this.offMessage = options.transport.onMessage((from, bytes) => this.receive(from, bytes));
     this.offPeer = options.transport.onPeerChange((peer, online) => this.peerChanged(peer, online));
   }
@@ -868,6 +871,7 @@ export class LobbyController {
       if (candidates.toSorted()[0] !== from) return;
     }
     this.current = next;
+    this.readinessVersionFloor = next.version;
     this.stopHello();
     this.helloAttempts = 0;
     this.agreement = null;
@@ -888,7 +892,10 @@ export class LobbyController {
       body.peer !== from ||
       body.lobbyId !== state.lobbyId ||
       body.hostEpoch !== state.hostEpoch ||
-      body.baseVersion !== state.version ||
+      (body.baseVersion !== state.version &&
+        (body.action.kind !== 'setReady' ||
+          body.baseVersion < this.readinessVersionFloor ||
+          body.baseVersion > state.version)) ||
       !connected(this.options.transport, from) ||
       !verify('lobby-request', body, signed.sig, from)
     )
@@ -960,7 +967,7 @@ export class LobbyController {
     const next = validState({ ...state, seats, spectators });
     if (!next.ok) return next;
     this.seenNonce.set(from, body.nonce);
-    return this.commit(next.value);
+    return this.commit(next.value, action.kind === 'setReady');
   }
 
   private receiveAck(from: PeerId, ack: LobbyFreezeAck): Result<void> {
@@ -1065,6 +1072,7 @@ export class LobbyController {
           ceremonyNonce: null,
           seats: resetReady(state.seats),
         };
+        this.readinessVersionFloor = this.current.version;
         this.seenNonce.clear();
         this.publish();
         this.emit();
@@ -1111,13 +1119,14 @@ export class LobbyController {
     return { body, sig: signObject(domain, body, this.key) };
   }
 
-  private commit(next: LobbyState): Result<void> {
+  private commit(next: LobbyState, readinessOnly = false): Result<void> {
     const current = this.current;
     if (!current || current.hostPeer !== this.peer)
       return failure('lobby-host', 'Only the host can commit');
     const checked = validState({ ...next, version: current.version + 1 });
     if (!checked.ok) return checked;
     this.current = checked.value;
+    if (!readinessOnly) this.readinessVersionFloor = checked.value.version;
     this.agreement = null;
     this.freezeSignatures.clear();
     const sent = this.publish();

FULL FILE packages/protocol/src/lobby.ts
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
import { genesisSeedModeSchema } from './genesis-seed.js';
import type { GenesisSeedMode } from './genesis-seed.js';
import { DEFAULT_TAKEOVER_POLICY, takeoverPolicySchema } from './takeover-policy.js';
import type { TakeoverPolicy } from './takeover-policy.js';
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
  seedMode: genesisSeedModeSchema,
  takeover: takeoverPolicySchema,
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
  state: v.unknown(),
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
  body: v.strictObject({
    ...hostBodySchema.entries,
    config: v.unknown(),
    seedMode: genesisSeedModeSchema,
    takeover: takeoverPolicySchema,
  }),
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
  readonly seedMode?: GenesisSeedMode;
  readonly takeover?: TakeoverPolicy;
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

/** Validates a persisted freeze without relying on a live lobby or transport. */
export function verifyLobbyFreezeAgreement(value: unknown): Result<LobbyFreezeAgreement> {
  const parsed = v.safeParse(
    v.strictObject({
      state: stateSchema,
      acks: v.pipe(v.array(signedAckSchema), v.minLength(1), v.maxLength(4)),
    }),
    value,
  );
  if (!parsed.success) return failure('lobby-freeze', 'Freeze agreement is malformed');
  const checked = validState(parsed.output.state);
  if (!checked.ok) return checked;
  const state = checked.value;
  if (state.status !== 'starting' || !state.ceremonyNonce)
    return failure('lobby-freeze', 'Agreement requires a starting snapshot');
  const humans = state.seats.filter((seat) => seat.kind === 'human');
  if (parsed.output.acks.length !== humans.length)
    return failure('lobby-freeze-ack', 'Every seated human must sign exactly once');
  const byPeer = new Map(parsed.output.acks.map((ack) => [ack.body.peer, ack]));
  if (byPeer.size !== humans.length)
    return failure('lobby-freeze-ack', 'Freeze ACK signer is missing or repeated');
  const hash = stateHash(state);
  const acks: LobbyFreezeAck[] = [];
  for (const human of humans) {
    const ack = byPeer.get(human.peer);
    if (
      !ack ||
      ack.body.lobbyId !== state.lobbyId ||
      ack.body.hostEpoch !== state.hostEpoch ||
      ack.body.ceremonyNonce !== state.ceremonyNonce ||
      ack.body.stateHash !== hash ||
      !verify('lobby-freeze-ack', ack.body, ack.sig, human.peer)
    )
      return failure('lobby-freeze-ack', 'Freeze ACK does not bind the exact seated snapshot');
    acks.push(ack);
  }
  return success(clone({ state, acks }));
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
  // Older Ready intents may commute only across commits that changed readiness alone.
  private readinessVersionFloor = 0;
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
    this.readinessVersionFloor = initial?.version ?? 0;
    this.offMessage = options.transport.onMessage((from, bytes) => this.receive(from, bytes));
    this.offPeer = options.transport.onPeerChange((peer, online) => this.peerChanged(peer, online));
  }

  static createHost(options: HostLobbyOptions): Result<LobbyController> {
    const checked = validConfig(options.config);
    if (!checked.ok) return checked;
    const seedMode = v.safeParse(genesisSeedModeSchema, options.seedMode ?? { kind: 'joint' });
    if (!seedMode.success) return failure('lobby-seed', 'Board seed selection is invalid');
    const takeover = v.safeParse(takeoverPolicySchema, options.takeover ?? DEFAULT_TAKEOVER_POLICY);
    if (!takeover.success) return failure('lobby-takeover', 'Takeover policy is invalid');
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
        seedMode: seedMode.output,
        takeover: takeover.output,
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

  configure(
    config: GameConfig,
    seedMode?: GenesisSeedMode,
    takeover?: TakeoverPolicy,
  ): Result<void> {
    const checked = validConfig(config);
    if (!checked.ok) return checked;
    const authority = this.hostOpen();
    if (!authority.ok) return authority;
    const state = authority.value;
    const seed = v.safeParse(genesisSeedModeSchema, seedMode ?? state.seedMode);
    if (!seed.success) return failure('lobby-seed', 'Board seed selection is invalid');
    const policy = v.safeParse(takeoverPolicySchema, takeover ?? state.takeover);
    if (!policy.success) return failure('lobby-takeover', 'Takeover policy is invalid');
    const edit = this.hostEdit(state, 'lobby-config', {
      config: checked.value,
      seedMode: seed.output,
      takeover: policy.output,
    });
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
    return this.commit({
      ...state,
      config: checked.value,
      seedMode: seed.output,
      takeover: policy.output,
      seats,
    });
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
    const header = v.safeParse(
      v.object({ lobbyId: roomSchema, hostPeer: key32Schema }),
      body.state,
    );
    if (
      !header.success ||
      header.output.lobbyId !== this.options.lobbyId ||
      from !== header.output.hostPeer ||
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
    this.readinessVersionFloor = next.version;
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
      (body.baseVersion !== state.version &&
        (body.action.kind !== 'setReady' ||
          body.baseVersion < this.readinessVersionFloor ||
          body.baseVersion > state.version)) ||
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
    return this.commit(next.value, action.kind === 'setReady');
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
        this.readinessVersionFloor = this.current.version;
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

  private commit(next: LobbyState, readinessOnly = false): Result<void> {
    const current = this.current;
    if (!current || current.hostPeer !== this.peer)
      return failure('lobby-host', 'Only the host can commit');
    const checked = validState({ ...next, version: current.version + 1 });
    if (!checked.ok) return checked;
    this.current = checked.value;
    if (!readinessOnly) this.readinessVersionFloor = checked.value.version;
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

FULL FILE packages/protocol/src/lobby.test.ts
import { canonicalEncode, toBase64Url } from '@cp2p/codec';
import { identityFromSecret, signObject } from '@cp2p/crypto';
import { BASE_VERSION, ENGINE_VERSION } from '@cp2p/engine';
import type { GameConfig, Result } from '@cp2p/engine';
import { afterEach, describe, expect, test } from 'vitest';
import { LobbyController, verifyLobbyFreezeAgreement } from './lobby.js';
import { createMemnet } from './testing/memnet.js';
import type { Transport } from './transport.js';
import { PROTOCOL_VERSION } from './types.js';

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing lobby fixture value');
  return item;
}

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function setup() {
  const keys = [1, 2, 3].map((number) => new Uint8Array(32).fill(number));
  const peers = keys.map((key) => identityFromSecret(key).peerId);
  const net = createMemnet({ peers });
  const config: GameConfig = {
    modules: [{ id: 'base', version: BASE_VERSION }],
    seats: [0, 1, 2],
    options: { base: { mapLayout: 'random', vpTarget: 3 } },
  };
  const host = value(
    LobbyController.createHost({
      lobbyId: 'room_one',
      name: 'Friday game',
      hostName: 'Avery',
      config,
      transport: net.transport(required(peers[0])),
      clock: net.clock,
      secretKey: required(keys[0]),
    }),
  );
  const second = value(
    LobbyController.join({
      lobbyId: 'room_one',
      hostPeer: required(peers[0]),
      transport: net.transport(required(peers[1])),
      clock: net.clock,
      secretKey: required(keys[1]),
    }),
  );
  const third = value(
    LobbyController.join({
      lobbyId: 'room_one',
      hostPeer: required(peers[0]),
      transport: net.transport(required(peers[2])),
      clock: net.clock,
      secretKey: required(keys[2]),
    }),
  );
  const flush = () => net.clock.advanceBy(0);
  const dispose = () => {
    host.dispose();
    second.dispose();
    third.dispose();
    net.dispose();
  };
  return { keys, peers, net, config, host, second, third, flush, dispose };
}

const active: { dispose(): void }[] = [];
afterEach(() => {
  while (active.length) active.pop()?.dispose();
});

describe('signed lobby controller', () => {
  test('retries an initial pre-auth HELLO and a dropped authenticated HELLO', () => {
    const keys = [new Uint8Array(32).fill(31), new Uint8Array(32).fill(32)];
    const peers = keys.map((key) => identityFromSecret(key).peerId);
    const hostPeer = required(peers[0]);
    const guestPeer = required(peers[1]);
    const net = createMemnet({ peers });
    let authenticated = false;
    let dropNextHello = true;
    const actual = net.transport(guestPeer);
    const delayed: Transport = {
      self: actual.self,
      peers: () => (authenticated ? actual.peers() : []),
      send(to, bytes) {
        if (!authenticated) throw new Error('WebRTC peer is not authenticated');
        if (dropNextHello) {
          dropNextHello = false;
          return;
        }
        actual.send(to, bytes);
      },
      broadcast: (bytes) => actual.broadcast(bytes),
      onMessage: (listener) => actual.onMessage(listener),
      onPeerChange: (listener) => actual.onPeerChange(listener),
      disconnect: (peer) => actual.disconnect(peer),
    };
    const config: GameConfig = {
      modules: [{ id: 'base', version: BASE_VERSION }],
      seats: [0, 1],
      options: { base: { mapLayout: 'random', vpTarget: 3 } },
    };
    const host = value(
      LobbyController.createHost({
        lobbyId: 'delayed_room',
        name: 'Room',
        hostName: 'Host',
        config,
        transport: net.transport(hostPeer),
        clock: net.clock,
        secretKey: required(keys[0]),
      }),
    );
    const guest = value(
      LobbyController.join({
        lobbyId: 'delayed_room',
        hostPeer,
        transport: delayed,
        clock: net.clock,
        secretKey: required(keys[1]),
      }),
    );
    active.push({
      dispose() {
        guest.dispose();
        host.dispose();
        net.dispose();
      },
    });
    net.clock.advanceBy(0);
    expect(guest.state()).toBeNull();
    net.disconnect(hostPeer, guestPeer);
    authenticated = true;
    net.connect(hostPeer, guestPeer);
    net.clock.advanceBy(0);
    expect(guest.state()).toBeNull();
    net.clock.advanceBy(999);
    expect(guest.state()).toBeNull();
    net.clock.advanceBy(1);
    expect(guest.state()?.hostPeer).toBe(hostPeer);
    expect(guest.state()?.version).toBe(0);
    net.disconnect(hostPeer, guestPeer);
    value(host.configure({ ...config, options: { base: { vpTarget: 4 } } }));
    net.clock.advanceBy(0);
    expect(guest.state()?.version).toBe(0);
    net.clock.advanceBy(500);
    net.connect(hostPeer, guestPeer);
    net.clock.advanceBy(0);
    expect(guest.state()?.version).toBe(1);
  });

  test('three peers join, configure, ready, and agree on one exact freeze before ceremony', () => {
    const room = setup();
    active.push(room);
    room.flush();
    expect(room.second.state()?.hostPeer).toBe(room.peers[0]);
    value(room.second.request({ kind: 'takeSeat', seat: 1 }));
    room.flush();
    value(room.third.request({ kind: 'takeSeat', seat: 2 }));
    room.flush();
    value(room.second.request({ kind: 'setName', name: 'Blake' }));
    room.flush();
    value(room.third.request({ kind: 'setColour', colour: 'yellow' }));
    room.flush();
    value(room.host.request({ kind: 'setReady', ready: true }));
    room.flush();
    value(room.second.request({ kind: 'setReady', ready: true }));
    room.flush();
    value(room.third.request({ kind: 'setReady', ready: true }));
    room.flush();
    expect(room.host.state()?.seats.every((seat) => seat.ready)).toBe(true);
    expect(room.host.state()?.seedMode).toEqual({ kind: 'joint' });
    expect(room.host.state()?.takeover).toEqual({ mode: 'vote', afterSeconds: 120 });
    const fixedSeed = { kind: 'fixed' as const, seed: toBase64Url(new Uint8Array(32).fill(4)) };
    const takeover = { mode: 'auto' as const, afterSeconds: 30 };
    value(
      room.host.configure(
        { ...room.config, options: { base: { vpTarget: 4 } } },
        fixedSeed,
        takeover,
      ),
    );
    room.flush();
    expect(room.second.state()?.seats.every((seat) => !seat.ready)).toBe(true);
    expect(room.second.state()?.seedMode).toEqual(fixedSeed);
    expect(room.second.state()?.takeover).toEqual(takeover);
    expect(room.third.configure(room.config, { kind: 'joint' }).ok).toBe(false);
    expect(room.host.configure(room.config, { kind: 'fixed', seed: 'not-a-seed' }).ok).toBe(false);
    expect(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise malformed input from an untyped caller.
      room.host.configure(room.config, undefined, { mode: 'auto', afterSeconds: 'never' } as never)
        .ok,
    ).toBe(false);
    expect(room.host.configure(room.config, undefined, { mode: 'vote', afterSeconds: 14 }).ok).toBe(
      false,
    );
    expect(room.host.start(toBase64Url(new Uint8Array(32).fill(7))).ok).toBe(false);
    value(room.host.request({ kind: 'setReady', ready: true }));
    room.flush();
    value(room.second.request({ kind: 'setReady', ready: true }));
    room.flush();
    value(room.third.request({ kind: 'setReady', ready: true }));
    room.flush();
    const nonce = toBase64Url(new Uint8Array(32).fill(8));
    value(room.host.start(nonce));
    room.flush();
    expect(room.host.freezeAgreement()).toBeNull();
    value(room.host.ackFreeze());
    value(room.second.ackFreeze());
    value(room.third.ackFreeze());
    room.flush();
    const agreements = [room.host, room.second, room.third].map((peer) => peer.freezeAgreement());
    expect(agreements.every(Boolean)).toBe(true);
    expect(agreements.map((agreement) => agreement?.state.ceremonyNonce)).toEqual([
      nonce,
      nonce,
      nonce,
    ]);
    expect(agreements[0]?.acks).toHaveLength(3);
    const agreement = required(agreements[0]);
    const verified = value(
      verifyLobbyFreezeAgreement({
        state: agreement.state,
        acks: agreement.acks.toReversed(),
      }),
    );
    expect(verified.acks.map((ack) => ack.body.peer)).toEqual(
      agreement.state.seats.filter((seat) => seat.kind === 'human').map((seat) => seat.peer),
    );
    expect(verified).not.toBe(agreement);
    expect(verified.state).not.toBe(agreement.state);
    expect(verified.acks[0]).not.toBe(agreement.acks[0]);
    const changedState = { ...agreement.state, name: 'Different room' };
    expect(verifyLobbyFreezeAgreement({ ...agreement, state: changedState }).ok).toBe(false);
    expect(
      verifyLobbyFreezeAgreement({
        ...agreement,
        state: { ...agreement.state, seedMode: { kind: 'joint' } },
      }).ok,
    ).toBe(false);
    expect(
      verifyLobbyFreezeAgreement({
        ...agreement,
        state: { ...agreement.state, takeover: { mode: 'vote', afterSeconds: 30 } },
      }).ok,
    ).toBe(false);
    expect(
      verifyLobbyFreezeAgreement({ ...agreement, state: { ...agreement.state, status: 'started' } })
        .ok,
    ).toBe(false);
    expect(verifyLobbyFreezeAgreement({ ...agreement, acks: agreement.acks.slice(1) }).ok).toBe(
      false,
    );
    expect(
      verifyLobbyFreezeAgreement({
        ...agreement,
        acks: [agreement.acks[0], agreement.acks[0], agreement.acks[1]],
      }).ok,
    ).toBe(false);
    const firstAck = required(agreement.acks[0]);
    for (const body of [
      { ...firstAck.body, lobbyId: 'another_room' },
      { ...firstAck.body, hostEpoch: firstAck.body.hostEpoch + 1 },
      { ...firstAck.body, ceremonyNonce: toBase64Url(new Uint8Array(32).fill(9)) },
      { ...firstAck.body, stateHash: '0'.repeat(64) },
      { ...firstAck.body, peer: required(room.peers[2]) },
    ]) {
      expect(
        verifyLobbyFreezeAgreement({
          ...agreement,
          acks: [{ ...firstAck, body }, ...agreement.acks.slice(1)],
        }).ok,
      ).toBe(false);
    }
    expect(
      verifyLobbyFreezeAgreement({
        ...agreement,
        acks: [{ ...firstAck, sig: required(agreement.acks[1]).sig }, ...agreement.acks.slice(1)],
      }).ok,
    ).toBe(false);
    expect(room.host.start(nonce).ok).toBe(false);
  });

  test('simultaneous Ready requests commute only across readiness commits', () => {
    const room = setup();
    active.push(room);
    room.flush();
    value(room.second.request({ kind: 'takeSeat', seat: 1 }));
    room.flush();
    value(room.third.request({ kind: 'takeSeat', seat: 2 }));
    room.flush();
    const version = required(room.host.state()).version;
    value(room.host.request({ kind: 'setReady', ready: true }));
    // Both guests still sign the same base version, before the host's Ready arrives.
    expect(room.second.state()?.version).toBe(version);
    expect(room.third.state()?.version).toBe(version);
    value(room.second.request({ kind: 'setReady', ready: true }));
    value(room.third.request({ kind: 'setReady', ready: true }));
    room.flush();
    expect(room.host.state()?.seats.map((seat) => seat.ready)).toEqual([true, true, true]);
    expect(room.host.state()?.version).toBe(version + 3);
  });

  test.each(['settings', 'roster'] as const)('Ready intent cannot cross a %s change', (change) => {
    const room = setup();
    active.push(room);
    room.flush();
    value(room.second.request({ kind: 'takeSeat', seat: 1 }));
    room.flush();
    value(room.third.request({ kind: 'takeSeat', seat: 2 }));
    room.flush();
    value(room.second.request({ kind: 'setReady', ready: true }));
    // Mutate the consent context before this already-signed Ready reaches the host.
    if (change === 'settings') value(room.host.configure(room.config));
    else value(room.host.kick(required(room.peers[2])));
    const version = room.host.state()?.version;
    room.flush();
    expect(room.host.state()?.version).toBe(version);
    expect(room.host.state()?.seats[1]?.ready).toBe(false);
  });

  test('readiness window does not widen other requests or future versions', () => {
    const room = setup();
    active.push(room);
    room.flush();
    value(room.second.request({ kind: 'takeSeat', seat: 1 }));
    room.flush();
    value(room.host.request({ kind: 'setReady', ready: true }));
    value(room.second.request({ kind: 'setName', name: 'Stale name' }));
    const version = required(room.host.state()).version;
    room.flush();
    expect(room.host.state()?.seats[1]).toMatchObject({ name: 'Player 2', ready: false });
    const body = {
      lobbyId: 'room_one',
      hostEpoch: 0,
      baseVersion: version + 1,
      nonce: 100,
      peer: required(room.peers[1]),
      action: { kind: 'setReady', ready: true },
    };
    room.net.transport(required(room.peers[1])).send(
      required(room.peers[0]),
      canonicalEncode({
        t: 'LOBBY_REQ',
        request: { body, sig: signObject('lobby-request', body, required(room.keys[1])) },
      }),
    );
    room.flush();
    expect(room.host.state()?.version).toBe(version);
    expect(room.host.state()?.seats[1]?.ready).toBe(false);
  });

  test('out-of-order Ready toggles and stale host epochs remain rejected', () => {
    const room = setup();
    active.push(room);
    room.flush();
    value(room.second.request({ kind: 'takeSeat', seat: 1 }));
    room.flush();
    value(room.second.request({ kind: 'setReady', ready: true }));
    room.flush();
    const baseVersion = required(room.host.state()).version;
    const send = (nonce: number, ready: boolean, hostEpoch = 0) => {
      const body = {
        lobbyId: 'room_one',
        hostEpoch,
        baseVersion,
        nonce,
        peer: required(room.peers[1]),
        action: { kind: 'setReady', ready },
      };
      room.net.transport(required(room.peers[1])).send(
        required(room.peers[0]),
        canonicalEncode({
          t: 'LOBBY_REQ',
          request: { body, sig: signObject('lobby-request', body, required(room.keys[1])) },
        }),
      );
    };
    send(100, false);
    send(99, true);
    send(100, true);
    room.flush();
    expect(room.host.state()?.seats[1]?.ready).toBe(false);
    expect(room.host.state()?.version).toBe(baseVersion + 1);
    send(101, true, 1);
    room.flush();
    expect(room.host.state()?.seats[1]?.ready).toBe(false);
    expect(room.host.state()?.version).toBe(baseVersion + 1);
  });

  test('host migration clears the readiness window and rejects the old epoch', () => {
    const room = setup();
    active.push(room);
    room.flush();
    value(room.second.request({ kind: 'takeSeat', seat: 1 }));
    room.flush();
    value(room.third.request({ kind: 'takeSeat', seat: 2 }));
    room.flush();
    value(room.host.request({ kind: 'setReady', ready: true }));
    room.flush();
    const priorVersion = required(room.host.state()).version;
    room.net.partition([
      [required(room.peers[0])],
      [required(room.peers[1]), required(room.peers[2])],
    ]);
    room.flush();
    const electedIndex = required(room.peers[1]) < required(room.peers[2]) ? 1 : 2;
    const senderIndex = electedIndex === 1 ? 2 : 1;
    const elected = electedIndex === 1 ? room.second : room.third;
    const body = {
      lobbyId: 'room_one',
      hostEpoch: 0,
      baseVersion: priorVersion,
      nonce: 100,
      peer: required(room.peers[senderIndex]),
      action: { kind: 'setReady', ready: true },
    };
    room.net.transport(required(room.peers[senderIndex])).send(
      required(room.peers[electedIndex]),
      canonicalEncode({
        t: 'LOBBY_REQ',
        request: { body, sig: signObject('lobby-request', body, required(room.keys[senderIndex])) },
      }),
    );
    room.flush();
    expect(elected.state()?.hostEpoch).toBe(1);
    expect(elected.state()?.version).toBe(0);
    expect(elected.state()?.seats.every((seat) => !seat.ready)).toBe(true);
    value(elected.request({ kind: 'setReady', ready: true }));
    // The remaining guest still sees version 0 in the new epoch; that Ready is allowed.
    const sender = senderIndex === 1 ? room.second : room.third;
    value(sender.request({ kind: 'setReady', ready: true }));
    room.flush();
    expect(elected.state()?.version).toBe(2);
    expect(elected.state()?.seats[senderIndex]?.ready).toBe(true);
  });

  test('rejects unauthorized edits, spoofed requests, stale replay, and reports version mismatch', () => {
    const room = setup();
    active.push(room);
    room.flush();
    expect(room.second.configure(room.config)).toMatchObject({
      ok: false,
      error: { code: 'lobby-host' },
    });
    expect(room.second.kick(required(room.peers[2]))).toMatchObject({
      ok: false,
      error: { code: 'lobby-host' },
    });
    expect(room.second.start(toBase64Url(new Uint8Array(32).fill(9)))).toMatchObject({
      ok: false,
      error: { code: 'lobby-host' },
    });
    const baseVersion = required(room.host.state()).version;
    const unauthorizedEdit = {
      lobbyId: 'room_one',
      hostEpoch: 0,
      baseVersion,
      nonce: 1,
      peer: required(room.peers[1]),
      config: room.config,
      seedMode: required(room.host.state()).seedMode,
      takeover: required(room.host.state()).takeover,
    };
    room.net.transport(required(room.peers[1])).send(
      required(room.peers[0]),
      canonicalEncode({
        t: 'LOBBY_CONFIG',
        edit: {
          body: unauthorizedEdit,
          sig: signObject('lobby-config', unauthorizedEdit, required(room.keys[1])),
        },
      }),
    );
    room.flush();
    expect(room.host.getDiagnostic()).toEqual({ kind: 'invalid-message', code: 'lobby-host-edit' });
    expect(room.host.state()?.version).toBe(baseVersion);
    const body = {
      lobbyId: 'room_one',
      hostEpoch: 0,
      baseVersion,
      nonce: 1,
      peer: room.peers[0],
      action: { kind: 'takeSeat', seat: 1 },
    };
    const spoof = canonicalEncode({
      t: 'LOBBY_REQ',
      request: { body, sig: signObject('lobby-request', body, required(room.keys[1])) },
    });
    room.net.transport(required(room.peers[1])).send(required(room.peers[0]), spoof);
    room.flush();
    expect(room.host.state()?.seats[1]?.kind).toBe('open');
    const realBody = { ...body, peer: room.peers[1] };
    const packet = canonicalEncode({
      t: 'LOBBY_REQ',
      request: {
        body: realBody,
        sig: signObject('lobby-request', realBody, required(room.keys[1])),
      },
    });
    room.net.transport(required(room.peers[1])).send(required(room.peers[0]), packet);
    room.flush();
    expect(room.host.state()?.seats[1]?.kind).toBe('human');
    const version = room.host.state()?.version;
    room.net.transport(required(room.peers[1])).send(required(room.peers[0]), packet);
    room.flush();
    expect(room.host.state()?.version).toBe(version);
    const state = required(room.host.state());
    const incompatible = {
      protocolVersion: PROTOCOL_VERSION + 1,
      engineVersion: ENGINE_VERSION,
      state,
    };
    room.net.transport(required(room.peers[0])).send(
      required(room.peers[1]),
      canonicalEncode({
        t: 'LOBBY_STATE',
        snapshot: {
          body: incompatible,
          sig: signObject('lobby-state', incompatible, required(room.keys[0])),
        },
      }),
    );
    room.flush();
    expect(room.second.getDiagnostic()).toEqual({
      kind: 'protocol-version',
      hostVersion: PROTOCOL_VERSION + 1,
    });
    const oldState = { ...state } as Record<string, unknown>;
    delete oldState.takeover;
    const oldBody = { protocolVersion: 2, engineVersion: ENGINE_VERSION, state: oldState };
    room.net.transport(required(room.peers[0])).send(
      required(room.peers[1]),
      canonicalEncode({
        t: 'LOBBY_STATE',
        snapshot: {
          body: oldBody,
          sig: signObject('lobby-state', oldBody, required(room.keys[0])),
        },
      }),
    );
    room.flush();
    expect(room.second.getDiagnostic()).toEqual({ kind: 'protocol-version', hostVersion: 2 });
  });

  test('requires every bot host to occupy a human seat before signing a freeze', () => {
    const room = setup();
    active.push(room);
    room.flush();
    value(room.second.request({ kind: 'spectate' }));
    room.flush();
    expect(room.host.setBot(2, 'easy', required(room.peers[1]))).toMatchObject({
      ok: false,
      error: { code: 'lobby-bot' },
    });
    const current = required(room.host.state());
    const forged = {
      ...current,
      version: current.version + 1,
      seats: current.seats.map((seat) =>
        seat.seat === 2
          ? {
              seat: 2,
              kind: 'bot',
              name: 'Bot',
              colour: seat.colour,
              ready: false,
              botLevel: 'easy',
              botHost: required(room.peers[1]),
            }
          : seat,
      ),
    };
    const body = {
      protocolVersion: PROTOCOL_VERSION,
      engineVersion: ENGINE_VERSION,
      state: forged,
    };
    room.net.transport(required(room.peers[0])).send(
      required(room.peers[1]),
      canonicalEncode({
        t: 'LOBBY_STATE',
        snapshot: { body, sig: signObject('lobby-state', body, required(room.keys[0])) },
      }),
    );
    room.flush();
    expect(room.second.state()?.version).toBe(current.version);
  });

  test('host departure resets readiness; a partition cannot complete stale freeze', () => {
    const room = setup();
    active.push(room);
    room.flush();
    value(room.second.request({ kind: 'takeSeat', seat: 1 }));
    room.flush();
    value(room.third.request({ kind: 'takeSeat', seat: 2 }));
    room.flush();
    value(room.host.request({ kind: 'setReady', ready: true }));
    room.flush();
    value(room.second.request({ kind: 'setReady', ready: true }));
    room.flush();
    value(room.third.request({ kind: 'setReady', ready: true }));
    room.flush();
    const nonce = toBase64Url(new Uint8Array(32).fill(10));
    value(room.host.start(nonce));
    room.flush();
    value(room.host.ackFreeze());
    room.net.partition([
      [required(room.peers[0])],
      [required(room.peers[1]), required(room.peers[2])],
    ]);
    room.flush();
    const electedIndex = required(room.peers[1]) < required(room.peers[2]) ? 1 : 2;
    const electedPeer = required(room.peers[electedIndex]);
    const elected = electedIndex === 1 ? room.second : room.third;
    expect(room.host.freezeAgreement()).toBeNull();
    expect(room.second.ackFreeze().ok).toBe(false);
    expect(room.third.state()?.hostPeer).toBe(electedPeer);
    expect(elected.state()?.status).toBe('open');
    expect(elected.state()?.seats.every((seat) => !seat.ready)).toBe(true);
    room.net.crash(required(room.peers[0]));
    room.flush();
    value(elected.kick(required(room.peers[0])));
    room.flush();
    value(elected.setBot(0, 'easy', electedPeer));
    room.flush();
    value(room.second.request({ kind: 'setReady', ready: true }));
    room.flush();
    value(room.third.request({ kind: 'setReady', ready: true }));
    room.flush();
    value(elected.start(toBase64Url(new Uint8Array(32).fill(11))));
    room.flush();
    value(elected.ackFreeze());
    value(electedIndex === 1 ? room.third.ackFreeze() : room.second.ackFreeze());
    room.flush();
    expect(room.second.freezeAgreement()?.acks).toHaveLength(2);
    expect(room.third.freezeAgreement()?.acks).toHaveLength(2);
  });
});

FULL FILE packages/protocol/src/lobby-types.ts
import type { GameConfig, Seat } from '@cp2p/engine';
import type { PeerId } from './transport.js';
import type { GenesisSeedMode } from './genesis-seed.js';
import type { TakeoverPolicy } from './takeover-policy.js';

export const LOBBY_COLOURS = ['blue', 'orange', 'green', 'magenta', 'yellow', 'red'] as const;
export type LobbyColour = (typeof LOBBY_COLOURS)[number];
export type LobbyBotLevel = 'easy' | 'medium' | 'hard';

export type LobbySeat =
  | { seat: Seat; kind: 'open'; colour: LobbyColour; ready: false }
  | { seat: Seat; kind: 'human'; peer: PeerId; name: string; colour: LobbyColour; ready: boolean }
  | {
      seat: Seat;
      kind: 'bot';
      name: string;
      colour: LobbyColour;
      ready: false;
      botLevel: LobbyBotLevel;
      botHost: PeerId;
    };

/** A host-signed draft. The ceremony must issue new per-game keys after freeze. */
export interface LobbyState {
  readonly lobbyId: string;
  readonly hostPeer: PeerId;
  readonly hostEpoch: number;
  readonly version: number;
  readonly name: string;
  readonly seats: readonly LobbySeat[];
  readonly spectators: readonly PeerId[];
  readonly config: GameConfig;
  readonly seedMode: GenesisSeedMode;
  readonly takeover: TakeoverPolicy;
  readonly status: 'open' | 'starting' | 'started';
  readonly ceremonyNonce: string | null;
}

export type LobbyRequest =
  | { kind: 'takeSeat'; seat: Seat }
  | { kind: 'leaveSeat' }
  | { kind: 'setName'; name: string }
  | { kind: 'setColour'; colour: LobbyColour }
  | { kind: 'setReady'; ready: boolean }
  | { kind: 'spectate' };

export interface LobbyFreezeAck {
  readonly body: {
    readonly lobbyId: string;
    readonly hostEpoch: number;
    readonly ceremonyNonce: string;
    readonly stateHash: string;
    readonly peer: PeerId;
  };
  readonly sig: string;
}

export interface LobbyFreezeAgreement {
  readonly state: LobbyState;
  readonly acks: readonly LobbyFreezeAck[];
}

export type LobbyDiagnostic =
  | { kind: 'protocol-version'; hostVersion: number }
  | { kind: 'engine-version'; hostVersion: string }
  | { kind: 'invalid-message'; code: string };
