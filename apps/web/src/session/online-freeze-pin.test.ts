import { canonicalEncode, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { BASE_VERSION, createBaseEngine } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { LobbyController } from '@cp2p/protocol';
import { createMemnet, MemoryEscrowLifecycleStore } from '@cp2p/protocol/testing';
import { expect, test, vi } from 'vitest';
import { loadOrCreateOnlineIdentity } from './online-credentials.js';
import { OnlineStartup } from './online-startup.js';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

test('a retained nonce cannot ACK a different freeze after browser restart', async () => {
  const store = new MemoryEscrowLifecycleStore();
  const identity = await loadOrCreateOnlineIdentity(store, (length) =>
    new Uint8Array(length).fill(6),
  );
  const network = createMemnet({ peers: [identity.peerId] });
  const lobby = unwrap(
    LobbyController.createHost({
      lobbyId: 'freeze_restart',
      name: 'New settings',
      hostName: 'Avery',
      config: {
        modules: [{ id: 'base', version: BASE_VERSION }],
        seats: [0, 1],
        options: { base: { mapLayout: 'random' } },
      },
      transport: network.transport(identity.peerId),
      clock: network.clock,
      secretKey: identity.secretKey,
    }),
  );
  unwrap(lobby.setBot(1, 'easy'));
  unwrap(lobby.request({ kind: 'setReady', ready: true }));
  const nonce = toBase64Url(new Uint8Array(32).fill(29));
  unwrap(lobby.start(nonce));
  const state = lobby.state();
  if (!state) throw new Error('Missing frozen state');
  await store.putIfAbsent(
    `online-freeze/${identity.peerId}/${nonce}`,
    canonicalEncode({
      protocol: 'online-freeze-pin-v1',
      freezeHash: toHex(hashValue({ ...state, name: 'Old settings' })),
    }),
  );
  const freeze = vi.fn<(peers: readonly string[]) => void>();
  const startup = new OnlineStartup({
    invite: { roomId: state.lobbyId, hostPeer: identity.peerId, serverUrl: 'ws://localhost:3009' },
    identity,
    lobby,
    transport: network.transport(identity.peerId),
    store,
    clock: network.clock,
    engine: createBaseEngine(),
    freezePeers: freeze,
  });
  try {
    for (let step = 0; step < 50 && startup.snapshot()?.phase !== 'error'; step += 1) {
      network.clock.advanceBy(0);
      // oxlint-disable-next-line no-await-in-loop -- Observe the bounded asynchronous storage decision.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(lobby.freezeAgreement()).toBeNull();
    expect(freeze).not.toHaveBeenCalled();
    expect(startup.snapshot()?.phase).toBe('error');
  } finally {
    await startup.close();
    lobby.dispose();
    network.dispose();
    identity.dispose();
  }
}, 15_000);
