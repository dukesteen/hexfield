import { hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { identityFromSecret, scalarToBytes, signObject } from '@cp2p/crypto';
import { engineForModules, moduleSelection } from '@cp2p/engine';
import type { GameConfig } from '@cp2p/engine';
import { expect, test } from 'vitest';
import { MemoryEscrowLifecycleStore } from './escrow-lifecycle.js';
import { LOBBY_COLOURS } from './lobby-types.js';
import type { LobbyFreezeAgreement, LobbySeat, LobbyState } from './lobby-types.js';
import { validateDeckCeremony } from './deck-genesis.js';
import { OnlineCeremony } from './online-ceremony.js';
import { initialProposalContext } from './replay.js';
import { createMemnet } from './testing/memnet.js';

const SEATS = 3;
const SEAT_IDS = [0, 1, 2] as const;

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing ceremony fixture value');
  return item;
}

/** Three humans freeze a knights lobby; each runs the real ceremony on an in-memory mesh. */
function room() {
  const deviceKeys = Array.from({ length: SEATS }, (_, seat) => new Uint8Array(32).fill(seat + 1));
  const devicePeers = deviceKeys.map((key) => identityFromSecret(key).peerId);
  const gameKeys = Array.from({ length: SEATS }, (_, seat) => new Uint8Array(32).fill(seat + 11));
  const masters = Array.from({ length: SEATS }, (_, seat) => scalarToBytes(BigInt(17 + seat)));
  const network = createMemnet({ peers: devicePeers });
  const modules = moduleSelection(['base', 'knights']);
  const config: GameConfig = {
    modules,
    seats: [0, 1, 2],
    options: { base: { mapLayout: 'random' } },
  };
  const seats: LobbySeat[] = devicePeers.map((peer, seat) => ({
    seat: required(SEAT_IDS[seat]),
    kind: 'human',
    peer,
    name: `P${seat + 1}`,
    colour: required(LOBBY_COLOURS[seat]),
    ready: true,
  }));
  const state: LobbyState = {
    lobbyId: 'online_ceremony_knights',
    hostPeer: required(devicePeers[0]),
    hostEpoch: 0,
    version: 0,
    name: 'Knights ceremony',
    seats,
    spectators: [],
    config,
    seedMode: { kind: 'joint' },
    takeover: { mode: 'vote', afterSeconds: 120 },
    status: 'starting',
    ceremonyNonce: toBase64Url(new Uint8Array(32).fill(91)),
  };
  const stateHash = toHex(hashValue(state));
  const agreement: LobbyFreezeAgreement = {
    state,
    acks: devicePeers.map((peer, seat) => {
      const body = {
        lobbyId: state.lobbyId,
        hostEpoch: state.hostEpoch,
        ceremonyNonce: required(state.ceremonyNonce),
        stateHash,
        peer,
      };
      return { body, sig: signObject('lobby-freeze-ack', body, required(deviceKeys[seat])) };
    }),
  };
  const engine = engineForModules(modules);
  const peers = devicePeers.map((peer, device) => {
    const created = OnlineCeremony.create({
      agreement,
      transport: network.transport(peer),
      clock: network.clock,
      deviceSigningKey: required(deviceKeys[device]),
      ownedSeats: [
        {
          seat: required(SEAT_IDS[device]),
          master: required(masters[device]),
          signingKey: required(gameKeys[device]),
        },
      ],
      store: new MemoryEscrowLifecycleStore(),
      engine,
      ...(device === 0 ? { hostCreatedAt: 1_700_000_000_000 } : {}),
    });
    if (!created.ok) throw new Error(created.error.message);
    return created.value;
  });
  return { network, peers };
}

test('three humans complete a knights ceremony that shuffles the three progress decks', async () => {
  const { network, peers } = room();
  try {
    for (const peer of peers) {
      // oxlint-disable-next-line no-await-in-loop -- Peers join the frozen attempt in order.
      expect((await peer.start()).ok).toBe(true);
    }
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      network.clock.advanceBy(0);
      // oxlint-disable-next-line no-await-in-loop -- Drain queued transport work between ticks.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (peers.every((peer) => peer.result() !== null)) break;
      if (peers.some((peer) => ['error', 'retired'].includes(peer.snapshot().phase))) break;
    }
    const snapshots = peers.map((peer) => peer.snapshot());
    expect(snapshots.map((snapshot) => [snapshot.phase, snapshot.error])).toEqual(
      peers.map(() => ['ready', null]),
    );
    const result = required(peers[0]?.result());
    expect(result.genesis.signatures).toHaveLength(SEATS);
    // Knights declares an empty development deck (no ceremony) and three progress decks.
    expect(result.transcripts.map((transcript) => transcript.deckId).toSorted()).toEqual([
      'progress-politics',
      'progress-science',
      'progress-trade',
    ]);
    expect(result.genesis.config.modules.map((module) => module.id)).toEqual(['base', 'knights']);
    for (const peer of peers) expect(peer.result()?.entry).toEqual(result.entry);
    // The ceremony's genesis is a valid verified genesis: hands start empty over eight kinds.
    const initial = initialProposalContext(
      result.entry,
      engineForModules(result.genesis.config.modules),
      {
        genesis: {
          verifyCommitments: (candidate) => validateDeckCeremony(candidate, result.transcripts),
        },
        entry: {},
      },
    );
    if (!initial.ok) throw new Error(initial.error.message);
    expect(
      initial.value.log.crypto?.hands.every((row) => Object.keys(row.commitments).length === 8),
    ).toBe(true);
  } finally {
    for (const peer of peers) peer.dispose();
    network.dispose();
  }
}, 600_000);
