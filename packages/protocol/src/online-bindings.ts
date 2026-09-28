import { hashValue, toHex } from '@cp2p/codec';
import {
  decodePoint,
  encodePoint,
  identityFromSecret,
  parsePeerId,
  signObject,
  verifyObject,
} from '@cp2p/crypto';
import { ENGINE_VERSION, failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import type { MasterCommitment } from './genesis-masters.js';
import { verifyLobbyFreezeAgreement } from './lobby.js';
import type { LobbyFreezeAgreement, LobbyState } from './lobby-types.js';
import {
  hashSchema,
  key32Schema,
  nonnegativeIntegerSchema,
  seatSchema,
  signature64Schema,
} from './schema-values.js';
import type { PeerId } from './transport.js';
import { PROTOCOL_VERSION } from './types.js';
import type { GenesisSeat } from './types.js';
import { parseCanonical } from './validation.js';

export const ONLINE_SEAT_BINDING_PROTOCOL = 'online-seat-binding-v1';
export const ONLINE_SEAT_BINDING_DOMAIN = ONLINE_SEAT_BINDING_PROTOCOL;

const bodySchema = v.strictObject({
  protocol: v.literal(ONLINE_SEAT_BINDING_PROTOCOL),
  freezeHash: hashSchema,
  ceremonyNonce: key32Schema,
  protocolVersion: nonnegativeIntegerSchema,
  engineVersion: v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
  seat: seatSchema,
  devicePeer: key32Schema,
  gamePeer: key32Schema,
  masterPub: key32Schema,
  encryptionKey: key32Schema,
});
const signedSchema = v.strictObject({ body: bodySchema, sig: signature64Schema });
// One binding per seat: two to six seats.
const bindingsSchema = v.pipe(v.array(signedSchema), v.minLength(2), v.maxLength(6));

export type GameSeatBindingBody = v.InferOutput<typeof bodySchema>;
export type SignedGameSeatBinding = v.InferOutput<typeof signedSchema>;

export interface VerifiedGameSeatBindings {
  readonly agreement: LobbyFreezeAgreement;
  readonly freezeHash: string;
  readonly bindings: readonly SignedGameSeatBinding[];
  readonly genesisSeats: readonly GenesisSeat[];
  readonly masters: readonly MasterCommitment[];
}

export interface SignGameSeatBindingInput {
  readonly agreement: unknown;
  readonly seat: Seat;
  readonly deviceSecretKey: Uint8Array;
  readonly gamePeer: PeerId;
  readonly masterPub: string;
  readonly encryptionKey: string;
}

function ownerDevice(state: LobbyState, seat: Seat): PeerId | null {
  const frozen = state.seats.find((item) => item.seat === seat);
  return frozen?.kind === 'human' ? frozen.peer : frozen?.kind === 'bot' ? frozen.botHost : null;
}

function deviceIdentities(state: LobbyState): Set<PeerId> {
  return new Set([
    state.hostPeer,
    ...state.spectators,
    ...state.seats.flatMap((seat) => (seat.kind === 'human' ? [seat.peer] : [])),
  ]);
}

function validPoint(encoded: string): boolean {
  try {
    return encodePoint(decodePoint(encoded, { nonIdentity: true })) === encoded;
  } catch {
    return false;
  }
}

function validateBody(
  body: GameSeatBindingBody,
  agreement: LobbyFreezeAgreement,
  freezeHash: string,
): Result<void> {
  if (body.protocolVersion !== PROTOCOL_VERSION || body.engineVersion !== ENGINE_VERSION)
    return failure('online-binding-version', 'Binding uses another protocol or engine version');
  if (
    body.freezeHash !== freezeHash ||
    body.ceremonyNonce !== agreement.state.ceremonyNonce ||
    body.devicePeer !== ownerDevice(agreement.state, body.seat)
  )
    return failure('online-binding-owner', 'Binding differs from the exact frozen seat or attempt');
  try {
    parsePeerId(body.gamePeer);
  } catch {
    return failure('online-binding-game-key', 'Fresh game signing key is invalid');
  }
  if (deviceIdentities(agreement.state).has(body.gamePeer))
    return failure('online-binding-game-key', 'Game signing key reuses a lobby device identity');
  if (!validPoint(body.masterPub) || !validPoint(body.encryptionKey))
    return failure('online-binding-point', 'Master or encryption point is invalid or identity');
  if (
    body.gamePeer === body.masterPub ||
    body.gamePeer === body.encryptionKey ||
    body.masterPub === body.encryptionKey
  )
    return failure('online-binding-duplicate', 'Independent seat keys must differ');
  return success(undefined);
}

/** Signs one frozen human seat or a bot hosted by this device. */
export function signGameSeatBinding(
  input: SignGameSeatBindingInput,
): Result<SignedGameSeatBinding> {
  const agreement = verifyLobbyFreezeAgreement(input.agreement);
  if (!agreement.ok) return agreement;
  const ceremonyNonce = agreement.value.state.ceremonyNonce;
  if (!ceremonyNonce)
    return failure('online-binding-freeze', 'A frozen ceremony nonce is required');
  let devicePeer: PeerId;
  try {
    const identity = identityFromSecret(input.deviceSecretKey);
    devicePeer = identity.peerId;
    identity.secretKey.fill(0);
  } catch {
    return failure('online-binding-device-key', 'Device signing key is invalid');
  }
  const body: GameSeatBindingBody = {
    protocol: ONLINE_SEAT_BINDING_PROTOCOL,
    freezeHash: toHex(hashValue(agreement.value.state)),
    ceremonyNonce,
    protocolVersion: PROTOCOL_VERSION,
    engineVersion: ENGINE_VERSION,
    seat: input.seat,
    devicePeer,
    gamePeer: input.gamePeer,
    masterPub: input.masterPub,
    encryptionKey: input.encryptionKey,
  };
  const parsed = parseCanonical(body, bodySchema);
  if (!parsed.ok) return parsed;
  const checked = validateBody(parsed.value, agreement.value, body.freezeHash);
  if (!checked.ok) return checked;
  try {
    return success({
      body: parsed.value,
      sig: signObject(ONLINE_SEAT_BINDING_DOMAIN, body, input.deviceSecretKey),
    });
  } catch {
    return failure('online-binding-signature', 'Could not sign the frozen seat binding');
  }
}

/** Validates the exact device-signed seat roster and constructs its game-key genesis seats. */
export function verifyGameSeatBindings(
  agreementValue: unknown,
  bindingsValue: unknown,
): Result<VerifiedGameSeatBindings> {
  const agreement = verifyLobbyFreezeAgreement(agreementValue);
  if (!agreement.ok) return agreement;
  const bindings = parseCanonical(bindingsValue, bindingsSchema);
  if (!bindings.ok) return bindings;
  const state = agreement.value.state;
  if (bindings.value.length !== state.seats.length)
    return failure('online-binding-roster', 'Every frozen seat needs one ordered binding');
  const freezeHash = toHex(hashValue(state));
  const used = deviceIdentities(state);
  const genesisSeats: GenesisSeat[] = [];
  const masters: MasterCommitment[] = [];
  const gameByDevice = new Map<PeerId, PeerId>();
  for (const [index, frozen] of state.seats.entries()) {
    const binding = bindings.value[index];
    if (!binding || binding.body.seat !== frozen.seat)
      return failure('online-binding-roster', 'Bindings must follow the exact frozen seat order');
    const body = binding.body;
    const checked = validateBody(body, agreement.value, freezeHash);
    if (!checked.ok) return checked;
    try {
      if (
        !verifyObject(ONLINE_SEAT_BINDING_DOMAIN, body, binding.sig, parsePeerId(body.devicePeer))
      )
        return failure('online-binding-signature', 'Device signature does not authorize binding');
    } catch {
      return failure('online-binding-signature', 'Device signature does not authorize binding');
    }
    for (const key of [body.gamePeer, body.masterPub, body.encryptionKey]) {
      if (used.has(key))
        return failure('online-binding-duplicate', 'Public keys or points repeat across seats');
      used.add(key);
    }
    if (frozen.kind === 'human') {
      gameByDevice.set(frozen.peer, body.gamePeer);
      genesisSeats.push({
        seat: frozen.seat,
        kind: 'human',
        publicKey: body.gamePeer,
        encryptionKey: body.encryptionKey,
        name: frozen.name,
        colour: frozen.colour,
      });
    } else if (frozen.kind === 'bot') {
      genesisSeats.push({
        seat: frozen.seat,
        kind: 'bot',
        publicKey: body.gamePeer,
        encryptionKey: body.encryptionKey,
        botHost: frozen.botHost,
        name: frozen.name,
        colour: frozen.colour,
      });
    }
    masters.push({ seat: frozen.seat, masterPub: body.masterPub });
  }
  for (const seat of genesisSeats) {
    if (seat.kind !== 'bot') continue;
    const host = gameByDevice.get(seat.botHost);
    if (!host) return failure('online-binding-host', 'Frozen bot host has no human game key');
    seat.botHost = host;
  }
  return success({
    agreement: agreement.value,
    freezeHash,
    bindings: bindings.value,
    genesisSeats,
    masters,
  });
}
