import { parsePeerId } from '@cp2p/crypto';
import type { PeerId } from '@cp2p/protocol';

export interface OnlineInvite {
  readonly roomId: string;
  readonly hostPeer: PeerId;
  readonly serverUrl: string;
}

const roomPattern = /^[a-z2-7]{10}$/;
const roomAlphabet = 'abcdefghijklmnopqrstuvwxyz234567';

export function createRoomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (byte) =>
    roomAlphabet.charAt(byte & 31),
  ).join('');
}

/** A link pins the host identity; the signaling server cannot choose another host. */
export function validateOnlineInvite(invite: OnlineInvite): OnlineInvite {
  if (!roomPattern.test(invite.roomId)) throw new Error('Invalid room code');
  parsePeerId(invite.hostPeer);
  if (invite.serverUrl === '') return { ...invite };
  const server = new URL(invite.serverUrl);
  if (
    !['ws:', 'wss:'].includes(server.protocol) ||
    server.username ||
    server.password ||
    server.search ||
    server.hash ||
    server.pathname !== '/'
  )
    throw new Error('Enter the signaling server origin, using ws:// or wss://');
  return { roomId: invite.roomId, hostPeer: invite.hostPeer, serverUrl: server.origin };
}

export function createOnlineInviteUrl(appUrl: string, invite: OnlineInvite): string {
  const checked = validateOnlineInvite(invite);
  const url = new URL(appUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Invalid app URL');
  url.search = '';
  const params = new URLSearchParams({ host: checked.hostPeer, server: checked.serverUrl });
  url.hash = `/join/${checked.roomId}?${params}`;
  return url.href;
}

export function parseOnlineInviteUrl(value: string): OnlineInvite {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Invalid invitation URL');
  const route = url.hash.slice(1);
  const separator = route.indexOf('?');
  if (separator < 0) throw new Error('The invitation is missing its host and server');
  const path = route.slice(0, separator);
  const params = new URLSearchParams(route.slice(separator + 1));
  const roomId = path.startsWith('/join/') ? path.slice('/join/'.length) : '';
  if (params.getAll('host').length !== 1 || params.getAll('server').length !== 1)
    throw new Error('The invitation needs exactly one host and server');
  return validateOnlineInvite({
    roomId,
    hostPeer: params.get('host') ?? '',
    serverUrl: params.get('server') ?? '',
  });
}
