import { identityFromSecret } from '@cp2p/crypto';
import { describe, expect, test } from 'vitest';
import {
  createOnlineInviteUrl,
  createRoomId,
  parseOnlineInviteUrl,
  validateOnlineInvite,
} from './online-invite.js';

const identity = identityFromSecret(new Uint8Array(32).fill(4));
identity.secretKey.fill(0);
const invite = {
  roomId: 'abcdefgh23',
  hostPeer: identity.peerId,
  serverUrl: 'wss://signal.example.test',
};

describe('online invitation', () => {
  test('keeps the GitHub Pages base path and pins host and signaling origin', () => {
    const url = createOnlineInviteUrl('https://example.test/hexfield/#/online/create', invite);
    expect(new URL(url).pathname).toBe('/hexfield/');
    expect(parseOnlineInviteUrl(url)).toEqual(invite);
    expect(createRoomId()).toMatch(/^[a-z2-7]{10}$/);
  });

  test('rejects ambiguous, incomplete and malformed invitations', () => {
    const valid = createOnlineInviteUrl('http://localhost:5187/', invite);
    expect(() => parseOnlineInviteUrl(`${valid}&host=${identity.peerId}`)).toThrow(
      /exactly one host/,
    );
    expect(() => parseOnlineInviteUrl('https://example.test/#/join/abcdefgh23')).toThrow(
      /missing its host/,
    );
    expect(() => validateOnlineInvite({ ...invite, roomId: '../bad' })).toThrow(
      /Invalid room code/,
    );
    expect(() => validateOnlineInvite({ ...invite, hostPeer: 'another-host' })).toThrow(
      /public key|Peer ID/i,
    );
  });

  test('refuses embedded credentials, non-websocket origins and ignored server paths', () => {
    for (const serverUrl of [
      'https://signal.example.test',
      'wss://name:password@signal.example.test',
      'wss://signal.example.test/private',
      'wss://signal.example.test?token=secret',
      'wss://signal.example.test#fragment',
    ])
      expect(() => validateOnlineInvite({ ...invite, serverUrl })).toThrow(
        /signaling server origin/,
      );
    expect(validateOnlineInvite({ ...invite, serverUrl: 'ws://127.0.0.1:8787/' }).serverUrl).toBe(
      'ws://127.0.0.1:8787',
    );
  });
});
