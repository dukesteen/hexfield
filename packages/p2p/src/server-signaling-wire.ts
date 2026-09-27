import { identityFromSecret, signObject } from '@cp2p/crypto';
import { fromBase64Url, toBase64Url } from '@cp2p/codec';
import type { PeerId } from '@cp2p/protocol';

export const ROOM_JOIN_DOMAIN = 'p2p-room-join';
export const SERVER_WIRE_LIMIT = 65_536;
export const SERVER_BUFFER_LIMIT = 4 * SERVER_WIRE_LIMIT;
export const ROOM_JOIN_TIMEOUT_MS = 10_000;

export function validRoomChallenge(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const bytes = fromBase64Url(value);
    return bytes.length === 32 && toBase64Url(bytes) === value;
  } catch {
    return false;
  }
}

export interface RoomJoinBody {
  readonly version: 1;
  readonly roomId: string;
  readonly peerId: PeerId;
  readonly challenge: string;
}

export interface SignedRoomJoin {
  readonly type: 'join';
  readonly body: RoomJoinBody;
  readonly sig: string;
}

export function signRoomJoin(
  roomId: string,
  challenge: string,
  secretKey: Uint8Array,
): SignedRoomJoin {
  if (!/^[a-z2-7]{10}$/.test(roomId) || !validRoomChallenge(challenge))
    throw new TypeError('Invalid signaling room challenge');
  const owned = identityFromSecret(secretKey);
  try {
    const body: RoomJoinBody = { version: 1, roomId, peerId: owned.peerId, challenge };
    return { type: 'join', body, sig: signObject(ROOM_JOIN_DOMAIN, body, owned.secretKey) };
  } finally {
    owned.secretKey.fill(0);
  }
}
