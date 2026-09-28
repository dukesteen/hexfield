import { canonicalDecode, canonicalEncode, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import {
  decodePoint,
  encodePoint,
  encodeScalar,
  G,
  identityFromSecret,
  proveDleq,
  scalarToBytes,
  scalePoint,
  sealWithEphemeralProof,
  signObject,
} from '@cp2p/crypto';
import { BASE_VERSION, createBaseEngine } from '@cp2p/engine';
import type { GameConfig, Result } from '@cp2p/engine';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as deckSetup from './deck-setup.js';
import * as escrowDistribution from './escrow-distribution.js';
import * as ceremonyWire from './online-ceremony-wire.js';
import type { DeckSetupState } from './deck-setup.js';
import { MemoryEscrowLifecycleStore } from './escrow-lifecycle.js';
import { LOBBY_COLOURS } from './lobby-types.js';
import type { LobbyFreezeAgreement, LobbyState } from './lobby-types.js';
import { prepareOnlineDisclosureGuard } from './online-disclosure.js';
import { OnlineCeremony } from './online-ceremony.js';
import type { OnlineCeremonyResult } from './online-ceremony.js';
import { signOnlineCeremonyPacket, verifyOnlineCeremonyPacket } from './online-ceremony-wire.js';
import type { OnlineCeremonyPacket } from './online-ceremony-wire.js';
import { escrowDeliveryContexts } from './escrow-opening.js';
import { escrowShareEnvelopeHash, escrowShareEnvelopeSchema } from './escrow-distribution.js';
import type { EscrowShareEnvelope } from './escrow-distribution.js';
import { validateGenesisEscrow } from './genesis-escrow.js';
import { createStealSecretSource } from './steal-source.js';
import { parseCanonical } from './validation.js';
import { createMemnet } from './testing/memnet.js';
import type { Transport } from './transport.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing online ceremony fixture value');
  return item;
}

function setup(mode: LobbyState['seedMode'] = { kind: 'joint' }, humanCount = 2) {
  const deviceKeys = [1, 2, 3, 4].map((number) => new Uint8Array(32).fill(number));
  const devicePeers = deviceKeys.map((key) => identityFromSecret(key).peerId);
  const gameKeys = [11, 12, 13, 14].map((number) => new Uint8Array(32).fill(number));
  const masters = [17n, 18n, 19n, 20n].map(scalarToBytes);
  const network = createMemnet({ peers: devicePeers });
  const config: GameConfig = {
    modules: [{ id: 'base', version: BASE_VERSION }],
    seats: [0, 1, 2, 3],
    options: { base: { mapLayout: 'random' } },
  };
  const state: LobbyState = {
    lobbyId: 'online_ceremony_test',
    hostPeer: required(devicePeers[0]),
    hostEpoch: 0,
    version: 0,
    name: 'Ceremony test',
    seats: [
      {
        seat: 0,
        kind: 'human',
        peer: required(devicePeers[0]),
        name: 'A',
        colour: required(LOBBY_COLOURS[0]),
        ready: true,
      },
      humanCount >= 2
        ? {
            seat: 1,
            kind: 'human',
            peer: required(devicePeers[1]),
            name: 'B',
            colour: required(LOBBY_COLOURS[1]),
            ready: true,
          }
        : {
            seat: 1,
            kind: 'bot',
            botHost: required(devicePeers[0]),
            name: 'B',
            colour: required(LOBBY_COLOURS[1]),
            botLevel: 'easy',
            ready: false,
          },
      humanCount >= 3
        ? {
            seat: 2,
            kind: 'human',
            peer: required(devicePeers[2]),
            name: 'C',
            colour: required(LOBBY_COLOURS[2]),
            ready: true,
          }
        : {
            seat: 2,
            kind: 'bot',
            botHost: required(devicePeers[0]),
            name: 'C',
            colour: required(LOBBY_COLOURS[2]),
            botLevel: 'easy',
            ready: false,
          },
      humanCount === 4
        ? {
            seat: 3,
            kind: 'human',
            peer: required(devicePeers[3]),
            name: 'D',
            colour: required(LOBBY_COLOURS[3]),
            ready: true,
          }
        : {
            seat: 3,
            kind: 'bot',
            botHost: required(devicePeers[humanCount - 1]),
            name: 'D',
            colour: required(LOBBY_COLOURS[3]),
            botLevel: 'easy',
            ready: false,
          },
    ],
    spectators: [],
    config,
    seedMode: mode,
    takeover: { mode: 'vote', afterSeconds: 120 },
    status: 'starting',
    ceremonyNonce: toBase64Url(new Uint8Array(32).fill(91)),
  };
  const stateHash = toHex(hashValue(state));
  const agreement: LobbyFreezeAgreement = {
    state,
    acks: Array.from({ length: humanCount }, (_, seat) => {
      const body = {
        lobbyId: state.lobbyId,
        hostEpoch: state.hostEpoch,
        ceremonyNonce: required(state.ceremonyNonce),
        stateHash,
        peer: required(devicePeers[seat]),
      };
      return { body, sig: signObject('lobby-freeze-ack', body, required(deviceKeys[seat])) };
    }),
  };
  const stores = devicePeers.map(() => new MemoryEscrowLifecycleStore());
  const create = (
    device: number,
    store = required(stores[device]),
    transport?: Transport,
    restoreResult?: OnlineCeremonyResult,
  ) =>
    value(
      OnlineCeremony.create({
        agreement,
        transport: transport ?? network.transport(required(devicePeers[device])),
        clock: network.clock,
        deviceSigningKey: required(deviceKeys[device]),
        ownedSeats: state.seats
          .filter((seat) =>
            seat.kind === 'human'
              ? seat.peer === devicePeers[device]
              : seat.kind === 'bot' && seat.botHost === devicePeers[device],
          )
          .map(({ seat }) => ({
            seat,
            master: required(masters[seat]),
            signingKey: required(gameKeys[seat]),
          })),
        store,
        engine: createBaseEngine(),
        ...(restoreResult ? { restoreResult } : {}),
        ...(device === 0 ? { hostCreatedAt: 1_700_000_000_000 } : {}),
      }),
    );
  return { agreement, network, create, stores, deviceKeys, gameKeys, masters };
}

const active: { dispose(): void }[] = [];
afterEach(() => {
  while (active.length) active.pop()?.dispose();
  vi.restoreAllMocks();
});

async function settle(room: ReturnType<typeof setup>, peers: readonly OnlineCeremony[]) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    room.network.clock.advanceBy(0);
    // oxlint-disable-next-line no-await-in-loop -- Drain queued transport work between virtual-clock ticks.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (peers.every((peer) => peer.result() !== null)) return;
    if (peers.some((peer) => peer.snapshot().phase === 'error')) break;
  }
  throw new Error(
    `Ceremony did not finish: ${JSON.stringify(peers.map((peer) => peer.snapshot()))}`,
  );
}

async function until(room: ReturnType<typeof setup>, predicate: () => boolean) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    room.network.clock.advanceBy(0);
    // oxlint-disable-next-line no-await-in-loop -- Drain the serialized protocol queue after each delivery.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (predicate()) return;
  }
  throw new Error('Expected ceremony packet was not produced');
}

function interceptTransport(
  room: ReturnType<typeof setup>,
  seat: number,
  intercept: (to: string, bytes: Uint8Array, packet: OnlineCeremonyPacket) => boolean,
  onListen?: () => void,
): Transport {
  const member = required(room.agreement.state.seats[seat]);
  if (member.kind !== 'human') throw new Error('Expected human transport owner');
  const actual = room.network.transport(member.peer);
  return {
    self: actual.self,
    peers: () => actual.peers(),
    send(to, bytes) {
      const checked = verifyOnlineCeremonyPacket(
        bytes,
        actual.self,
        toHex(hashValue(room.agreement.state)),
        required(room.agreement.state.ceremonyNonce),
      );
      if (checked.ok && intercept(to, bytes, checked.value)) return;
      actual.send(to, bytes);
    },
    broadcast: (bytes) => actual.broadcast(bytes),
    onMessage: (listener) => {
      const off = actual.onMessage(listener);
      onListen?.();
      return off;
    },
    onPeerChange: (listener) => actual.onPeerChange(listener),
    disconnect: (other) => actual.disconnect(other),
  };
}

function dealerSignedBadEnvelope(
  good: EscrowShareEnvelope,
  signingKey: Uint8Array,
): EscrowShareEnvelope {
  const prior = good.body;
  const payload = canonicalEncode({
    protocol: prior.protocol,
    ceremonyId: prior.ceremonyId,
    dealerSeat: prior.dealer.seat,
    holderSeat: prior.holder.seat,
    holderIndex: prior.holder.index,
    threshold: prior.threshold,
    masterPub: prior.masterPub,
    share: encodeScalar(999n),
  });
  const body = {
    ...prior,
    shareHash: toHex(hashValue({ domain: 'cp2p/v1/escrow-share-payload', payload })),
  };
  const contexts = escrowDeliveryContexts(body);
  const sealed = sealWithEphemeralProof(
    payload,
    prior.holder.encryptionKey,
    new Uint8Array(32).fill(95),
    contexts.seal,
    contexts.proof,
  );
  payload.fill(0);
  const signed = { ...body, ...sealed };
  return { body: signed, sig: signObject('escrow-share', signed, signingKey) };
}

function signedFalseComplaint(
  envelope: EscrowShareEnvelope,
  recipientSecret: bigint,
  holderKey: Uint8Array,
) {
  const context = {
    protocol: 'escrow-share-dispute-v1' as const,
    ceremonyId: envelope.body.ceremonyId,
    dealerSeat: envelope.body.dealer.seat,
    holderSeat: envelope.body.holder.seat,
    envelopeHash: escrowShareEnvelopeHash(envelope),
  };
  const sharedPoint = encodePoint(
    scalePoint(decodePoint(envelope.body.sealed.ephemeral), recipientSecret),
  );
  const proof = proveDleq(
    {
      base1: encodePoint(G),
      point1: envelope.body.holder.encryptionKey,
      base2: envelope.body.sealed.ephemeral,
      point2: sharedPoint,
    },
    recipientSecret,
    new Uint8Array(32).fill(99),
    context,
  );
  const body = { ...context, sharedPoint, proof };
  return { body, sig: signObject('escrow-share-dispute', body, holderKey) };
}

describe('online genesis ceremony', () => {
  test('two real humans and two hosted bots produce one signed playable genesis', async () => {
    const room = setup();
    const host = room.create(0);
    const guest = room.create(1);
    active.push({
      dispose() {
        host.dispose();
        guest.dispose();
        room.network.dispose();
      },
    });
    expect((await host.start()).ok).toBe(true);
    expect((await guest.start()).ok).toBe(true);
    await settle(room, [host, guest]);
    expect(host.result()?.entry).toEqual(guest.result()?.entry);
    expect(host.result()?.genesis.signatures).toHaveLength(2);
    expect(host.result()?.transcripts[0]?.passes).toHaveLength(8);
    expect(host.snapshot()).toMatchObject({ phase: 'ready', locallyConsented: true });
    expect(guest.snapshot()).toMatchObject({ phase: 'ready', locallyConsented: true });
  }, 60_000);

  test('one human can freeze a fixed seed and start with three hosted bots', async () => {
    const seed = toBase64Url(new Uint8Array(32).fill(37));
    const room = setup({ kind: 'fixed', seed }, 1);
    const host = room.create(0);
    active.push({
      dispose() {
        host.dispose();
        room.network.dispose();
      },
    });
    expect((await host.start()).ok).toBe(true);
    await settle(room, [host]);
    expect(host.result()?.genesis.genesisSeed).toBe(seed);
    expect(host.result()?.genesis.signatures).toHaveLength(1);
    expect(host.result()?.transcripts[0]?.passes).toHaveLength(8);
    const entry = host.result()?.entry;
    host.dispose();
    room.network.clock.advanceBy(21_000);
    const restored = room.create(0);
    active.push(restored);
    expect((await restored.start()).ok).toBe(true);
    await settle(room, [restored]);
    expect(restored.result()?.entry).toEqual(entry);
    expect(restored.snapshot()).toMatchObject({ phase: 'ready', locallyConsented: true });
  }, 60_000);

  test('completed restore uses exact persisted result without new phase output', async () => {
    const room = setup({ kind: 'fixed', seed: toBase64Url(new Uint8Array(32).fill(37)) }, 1);
    const host = room.create(0);
    active.push({ dispose: () => room.network.dispose() });
    expect((await host.start()).ok).toBe(true);
    await settle(room, [host]);
    const result = required(host.result());
    host.dispose();
    room.network.clock.advanceBy(20_001);
    const restored = room.create(0, required(room.stores[0]), undefined, result);
    active.push(restored);
    expect((await restored.start()).ok).toBe(true);
    await restored.flush();
    expect(restored.result()).toEqual(result);
    expect(restored.snapshot()).toMatchObject({ phase: 'ready', locallyConsented: true });
    restored.dispose();
    const store = required(room.stores[0]);
    const originalLoad = store.load.bind(store);
    store.load = (id) => (id.includes('/binding/') ? Promise.resolve(null) : originalLoad(id));
    const missing = room.create(0, store, undefined, result);
    active.push(missing);
    expect(await missing.start()).toMatchObject({
      ok: false,
      error: { code: 'online-ceremony-restore' },
    });
    store.load = originalLoad;
    const different = room.create(0, store, undefined, { ...result, bindings: [] });
    active.push(different);
    expect(await different.start()).toMatchObject({
      ok: false,
      error: { code: 'online-ceremony-restore' },
    });
  }, 60_000);

  test('a signed packet from outside the frozen human roster cannot retire a waiting guest', async () => {
    const room = setup();
    const guest = room.create(1);
    active.push({
      dispose: () => {
        guest.dispose();
        room.network.dispose();
      },
    });
    expect((await guest.start()).ok).toBe(true);
    const outsider = identityFromSecret(required(room.deviceKeys[2])).peerId;
    const recipient = required(room.agreement.state.seats[1]);
    if (recipient.kind !== 'human') throw new Error('Expected guest');
    const packet = value(
      signOnlineCeremonyPacket(
        {
          protocol: 'online-ceremony-v1',
          freezeHash: toHex(hashValue(room.agreement.state)),
          ceremonyNonce: required(room.agreement.state.ceremonyNonce),
          senderDevice: outsider,
          kind: 'created-at',
          seat: 0,
          step: 0,
          payload: { createdAt: 1_700_000_000_000 },
        },
        required(room.deviceKeys[2]),
      ),
    );
    room.network.transport(outsider).send(recipient.peer, packet.bytes);
    room.network.clock.advanceBy(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await guest.flush();
    expect(guest.snapshot().phase).toBe('frozen');
  });

  test('three humans and one hosted bot sign the same joint-seed genesis', async () => {
    const room = setup({ kind: 'joint' }, 3);
    const peers = [room.create(0), room.create(1), room.create(2)];
    active.push({
      dispose() {
        for (const peer of peers) peer.dispose();
        room.network.dispose();
      },
    });
    for (const peer of peers) {
      // oxlint-disable-next-line no-await-in-loop -- Exercise peers joining the same frozen attempt in order.
      expect((await peer.start()).ok).toBe(true);
    }
    await settle(room, peers);
    expect(peers.map((peer) => peer.result()?.entry)).toEqual([
      peers[0]?.result()?.entry,
      peers[0]?.result()?.entry,
      peers[0]?.result()?.entry,
    ]);
    expect(peers[0]?.result()?.genesis.signatures).toHaveLength(3);
  }, 60_000);

  test('four humans exchange sealed escrow shares before signing genesis', async () => {
    const room = setup({ kind: 'joint' }, 4);
    const peers = [0, 1, 2, 3].map((seat) => room.create(seat));
    active.push({
      dispose() {
        for (const peer of peers) peer.dispose();
        room.network.dispose();
      },
    });
    for (const peer of peers) {
      // oxlint-disable-next-line no-await-in-loop -- Peers join the frozen attempt in order.
      expect((await peer.start()).ok).toBe(true);
    }
    await settle(room, peers);
    expect(peers.every((peer) => peer.result()?.entry !== null)).toBe(true);
    expect(peers[0]?.result()?.genesis.signatures).toHaveLength(4);
    expect(peers[0]?.result()?.genesis.commitments.escrow).toHaveLength(4);
  }, 60_000);

  test('restarts a dropped private share and a dropped public ACK with exact bytes', async () => {
    const room = setup({ kind: 'joint' }, 4);
    let holdApproval = true;
    let dropShare = true;
    let dropAccepted = true;
    let share: Uint8Array | null = null;
    let resentShare: Uint8Array | null = null;
    let accepted: Uint8Array | null = null;
    let resentAccepted: Uint8Array | null = null;
    const dealerTransport = interceptTransport(room, 0, (_to, bytes, packet) => {
      if (
        packet.body.kind !== 'escrow-envelope' ||
        packet.body.seat !== 0 ||
        packet.body.step !== 1
      )
        return false;
      if (dropShare) {
        share ??= bytes.slice();
        return true;
      }
      resentShare ??= bytes.slice();
      return false;
    });
    const holderTransport = interceptTransport(room, 1, (_to, bytes, packet) => {
      if (holdApproval && packet.body.kind === 'approval') return true;
      if (
        packet.body.kind !== 'escrow-accepted' ||
        packet.body.seat !== 1 ||
        packet.body.step !== 0
      )
        return false;
      if (dropAccepted) {
        accepted ??= bytes.slice();
        return true;
      }
      resentAccepted ??= bytes.slice();
      return false;
    });
    let dealer = room.create(0, required(room.stores[0]), dealerTransport);
    let holder = room.create(1, required(room.stores[1]), holderTransport);
    const other = [room.create(2), room.create(3)];
    active.push({
      dispose() {
        dealer.dispose();
        holder.dispose();
        for (const peer of other) peer.dispose();
        room.network.dispose();
      },
    });
    for (const peer of [dealer, holder, ...other]) {
      // oxlint-disable-next-line no-await-in-loop -- Ordered joins expose restart gaps deterministically.
      expect((await peer.start()).ok).toBe(true);
    }
    await until(room, () => dealer.snapshot().phase === 'approvals');
    room.network.clock.advanceBy(15_000);
    holdApproval = false;
    room.network.clock.advanceBy(1_001);
    await until(room, () => share !== null);
    room.network.clock.advanceBy(10_000);
    expect(holder.snapshot().phase).toBe('escrow');
    dealer.dispose();
    await dealer.flush();
    dropShare = false;
    dealer = room.create(0, required(room.stores[0]), dealerTransport);
    expect((await dealer.start()).ok).toBe(true);
    await until(room, () => accepted !== null);
    holder.dispose();
    await holder.flush();
    dropAccepted = false;
    holder = room.create(1, required(room.stores[1]), holderTransport);
    expect((await holder.start()).ok).toBe(true);
    await settle(room, [dealer, holder, ...other]);
    expect(resentShare).toEqual(share);
    expect(resentAccepted).toEqual(accepted);
  }, 60_000);

  test('restart finishes attempt retirement after escrow retirement committed first', async () => {
    const room = setup({ kind: 'joint' }, 4);
    let heldShare = false;
    const dealerTransport = interceptTransport(room, 0, (_to, _bytes, packet) => {
      if (
        packet.body.kind === 'escrow-envelope' &&
        packet.body.seat === 0 &&
        packet.body.step === 1
      ) {
        heldShare = true;
        return true;
      }
      return false;
    });
    const dealer = room.create(0, required(room.stores[0]), dealerTransport);
    const others = [1, 2, 3].map((seat) => room.create(seat));
    active.push({
      dispose() {
        dealer.dispose();
        for (const peer of others) peer.dispose();
        room.network.dispose();
      },
    });
    for (const peer of [dealer, ...others]) {
      // oxlint-disable-next-line no-await-in-loop -- Start fixed roster in order.
      expect((await peer.start()).ok).toBe(true);
    }
    await until(room, () => heldShare);
    const store = required(room.stores[0]);
    const originalCas = store.compareAndSwap.bind(store);
    let interrupted = true;
    store.compareAndSwap = async (id, expected, replacement) => {
      if (interrupted && id.startsWith('online-attempt/')) {
        interrupted = false;
        throw new Error('interrupted after escrow retirement');
      }
      return originalCas(id, expected, replacement);
    };
    expect((await dealer.abort()).ok).toBe(false);
    store.compareAndSwap = originalCas;
    dealer.dispose();
    room.network.clock.advanceBy(21_000);
    const restored = room.create(0);
    active.push(restored);
    expect((await restored.start()).ok).toBe(true);
    expect(restored.snapshot().phase).toBe('retired');
  }, 60_000);

  test('a genuinely bad signed share publishes a DLEQ dispute and retires before genesis', async () => {
    const room = setup({ kind: 'joint' }, 4);
    let malicious: Uint8Array | null = null;
    let published: Uint8Array | null = null;
    let retried: Uint8Array | null = null;
    let restarted = false;
    const transport = interceptTransport(room, 0, (to, _bytes, packet) => {
      if (
        packet.body.kind !== 'escrow-envelope' ||
        packet.body.seat !== 0 ||
        packet.body.step !== 1
      )
        return false;
      if (!malicious) {
        const inner = parseCanonical(packet.body.payload, escrowShareEnvelopeSchema);
        if (!inner.ok) throw new Error('Expected a public valid dealer envelope');
        const bad = dealerSignedBadEnvelope(inner.value, required(room.gameKeys[0]));
        malicious = value(
          signOnlineCeremonyPacket({ ...packet.body, payload: bad }, required(room.deviceKeys[0])),
        ).bytes;
      }
      room.network.transport(packet.body.senderDevice).send(to, required(malicious));
      return true;
    });
    const holderTransport = interceptTransport(room, 1, (_to, bytes, packet) => {
      if (packet.body.kind === 'escrow-dispute') {
        if (restarted) retried ??= bytes.slice();
        else published ??= bytes.slice();
      }
      return false;
    });
    const peers = [
      room.create(0, required(room.stores[0]), transport),
      room.create(1, required(room.stores[1]), holderTransport),
      room.create(2),
      room.create(3),
    ];
    active.push({
      dispose() {
        for (const peer of peers) peer.dispose();
        room.network.dispose();
      },
    });
    for (const peer of peers) {
      // oxlint-disable-next-line no-await-in-loop -- Ordered joins expose the bad private delivery.
      expect((await peer.start()).ok).toBe(true);
    }
    await until(room, () => peers[1]?.snapshot().phase === 'retired');
    await until(room, () => peers.every((peer) => peer.snapshot().phase === 'retired'));
    expect(peers[1]?.snapshot().error).toBe('online-ceremony-disputed');
    expect(peers.every((peer) => peer.result() === null)).toBe(true);
    expect(published).not.toBeNull();
    peers[1]?.dispose();
    restarted = true;
    const restored = room.create(1, required(room.stores[1]), holderTransport);
    active.push(restored);
    expect((await restored.start()).ok).toBe(true);
    expect(restored.snapshot().phase).toBe('retired');
    expect(retried).toEqual(published);
  }, 60_000);

  test('authenticated post-consent disclosure clears ready and survives restart', async () => {
    const room = setup({ kind: 'joint' }, 4);
    const peers = [0, 1, 2, 3].map((seat) => room.create(seat));
    active.push({
      dispose() {
        for (const peer of peers) peer.dispose();
        room.network.dispose();
      },
    });
    for (const peer of peers) {
      // oxlint-disable-next-line no-await-in-loop -- Join all four original voters.
      expect((await peer.start()).ok).toBe(true);
    }
    await settle(room, peers);
    const completedResult = required(peers[0]?.result());
    const genesis = required(peers[0]?.result()?.genesis);
    const transcript = value(validateGenesisEscrow(genesis));
    const envelope = required(transcript[0]?.shares[0]?.envelope);
    expect(envelope.body.holder.seat).toBe(1);
    const key = required(room.gameKeys[1]);
    const gamePeer = identityFromSecret(key).peerId;
    const source = createStealSecretSource(
      required(room.masters[1]),
      required(room.agreement.state.ceremonyNonce),
      1,
      gamePeer,
    );
    const complaint = signedFalseComplaint(envelope, source.encryptionSecret(), key);
    source.dispose();
    const holder = required(room.agreement.state.seats[1]);
    const host = required(room.agreement.state.seats[0]);
    if (holder.kind !== 'human' || host.kind !== 'human') throw new Error('Expected human peers');
    const packet = value(
      signOnlineCeremonyPacket(
        {
          protocol: 'online-ceremony-v1',
          freezeHash: toHex(hashValue(room.agreement.state)),
          ceremonyNonce: required(room.agreement.state.ceremonyNonce),
          senderDevice: holder.peer,
          kind: 'escrow-dispute',
          seat: 1,
          step: 0,
          payload: { envelope, dispute: complaint },
        },
        required(room.deviceKeys[1]),
      ),
    );
    room.network.transport(holder.peer).send(host.peer, packet.bytes);
    await until(room, () => peers[0]?.snapshot().error === 'online-ceremony-disputed');
    expect(
      await value(prepareOnlineDisclosureGuard(genesis)).check(required(room.stores[0])),
    ).toEqual({ ok: true, value: true });
    expect(peers[0]?.result()).toBeNull();
    expect(peers[0]?.snapshot()).toMatchObject({ phase: 'waiting', locallyConsented: true });
    peers[0]?.dispose();
    const restored = room.create(0, required(room.stores[0]), undefined, completedResult);
    active.push(restored);
    expect((await restored.start()).ok).toBe(true);
    await restored.flush();
    expect(restored.result()).toBeNull();
    expect(restored.snapshot()).toMatchObject({
      phase: 'waiting',
      error: 'online-ceremony-disputed',
      locallyConsented: true,
    });
  }, 60_000);

  test('post-consent dispute for another dealer-signed envelope is ignored', async () => {
    const room = setup({ kind: 'joint' }, 4);
    const peers = [0, 1, 2, 3].map((seat) => room.create(seat));
    active.push({
      dispose() {
        for (const peer of peers) peer.dispose();
        room.network.dispose();
      },
    });
    for (const peer of peers) {
      // oxlint-disable-next-line no-await-in-loop -- Join the fixed roster in order.
      expect((await peer.start()).ok).toBe(true);
    }
    await settle(room, peers);
    const certified = required(peers[0]?.result());
    const transcript = value(validateGenesisEscrow(certified.genesis));
    const original = required(transcript[0]?.shares[0]?.envelope);
    const dealerKey = required(room.gameKeys[original.body.dealer.seat]);
    const alternate = dealerSignedBadEnvelope(original, dealerKey);
    const holderKey = required(room.gameKeys[original.body.holder.seat]);
    const holderIdentity = identityFromSecret(holderKey);
    const source = createStealSecretSource(
      required(room.masters[original.body.holder.seat]),
      required(room.agreement.state.ceremonyNonce),
      original.body.holder.seat,
      holderIdentity.peerId,
    );
    holderIdentity.secretKey.fill(0);
    const complaint = signedFalseComplaint(alternate, source.encryptionSecret(), holderKey);
    source.dispose();
    expect(escrowShareEnvelopeHash(alternate)).not.toBe(escrowShareEnvelopeHash(original));

    const holder = required(room.agreement.state.seats[original.body.holder.seat]);
    const host = required(room.agreement.state.seats[0]);
    if (holder.kind !== 'human' || host.kind !== 'human') throw new Error('Expected humans');
    const packet = value(
      signOnlineCeremonyPacket(
        {
          protocol: 'online-ceremony-v1',
          freezeHash: toHex(hashValue(room.agreement.state)),
          ceremonyNonce: required(room.agreement.state.ceremonyNonce),
          senderDevice: holder.peer,
          kind: 'escrow-dispute',
          seat: holder.seat,
          step: original.body.dealer.seat,
          payload: { envelope: alternate, dispute: complaint },
        },
        required(room.deviceKeys[holder.seat]),
      ),
    );

    room.network.transport(holder.peer).send(host.peer, packet.bytes);
    await peers[0]?.flush();
    expect(peers[0]?.result()?.entry).toEqual(certified.entry);
    expect(peers[0]?.snapshot()).toMatchObject({ phase: 'ready', error: null });
  }, 60_000);

  test('a dispute delivered during completed replay prevents a ready notification', async () => {
    const room = setup({ kind: 'joint' }, 4);
    const peers = [0, 1, 2, 3].map((seat) => room.create(seat));
    active.push({
      dispose() {
        for (const peer of peers) peer.dispose();
        room.network.dispose();
      },
    });
    for (const peer of peers) {
      // oxlint-disable-next-line no-await-in-loop -- Start fixed roster in order.
      expect((await peer.start()).ok).toBe(true);
    }
    await settle(room, peers);
    const result = required(peers[0]?.result());
    const envelope = required(value(validateGenesisEscrow(result.genesis))[0]?.shares[0]?.envelope);
    const holderKey = required(room.gameKeys[1]);
    const source = createStealSecretSource(
      required(room.masters[1]),
      required(room.agreement.state.ceremonyNonce),
      1,
      identityFromSecret(holderKey).peerId,
    );
    const complaint = signedFalseComplaint(envelope, source.encryptionSecret(), holderKey);
    source.dispose();
    const holder = required(room.agreement.state.seats[1]);
    const host = required(room.agreement.state.seats[0]);
    if (holder.kind !== 'human' || host.kind !== 'human') throw new Error('Expected humans');
    const packet = value(
      signOnlineCeremonyPacket(
        {
          protocol: 'online-ceremony-v1',
          freezeHash: toHex(hashValue(room.agreement.state)),
          ceremonyNonce: required(room.agreement.state.ceremonyNonce),
          senderDevice: holder.peer,
          kind: 'escrow-dispute',
          seat: 1,
          step: 0,
          payload: { envelope, dispute: complaint },
        },
        required(room.deviceKeys[1]),
      ),
    );
    peers[0]?.dispose();
    const store = required(room.stores[0]);
    const originalLoad = store.load.bind(store);
    let injected = false;
    let listening = false;
    const replayTransport = interceptTransport(
      room,
      0,
      () => false,
      () => {
        listening = true;
      },
    );
    store.load = async (id) => {
      const bytes = await originalLoad(id);
      if (listening && !injected && id.startsWith('online-manifest/')) {
        injected = true;
        room.network.transport(holder.peer).send(host.peer, packet.bytes);
        room.network.clock.advanceBy(0);
      }
      return bytes;
    };
    const restored = room.create(0, store, replayTransport, result);
    active.push(restored);
    const phases: string[] = [];
    restored.onChange((progress) => phases.push(progress.phase));
    expect((await restored.start()).ok).toBe(true);
    await restored.flush();
    expect(injected).toBe(true);
    expect(restored.result()).toBeNull();
    expect(restored.snapshot()).toMatchObject({
      phase: 'waiting',
      error: 'online-ceremony-disputed',
    });
    expect(phases).not.toContain('ready');
  }, 60_000);

  test('late malformed dealer packet cannot revoke certified ready result', async () => {
    const room = setup({ kind: 'joint' }, 4);
    const peers = [0, 1, 2, 3].map((seat) => room.create(seat));
    active.push({
      dispose() {
        for (const peer of peers) peer.dispose();
        room.network.dispose();
      },
    });
    for (const peer of peers) {
      // oxlint-disable-next-line no-await-in-loop -- Start the fixed four-device roster.
      expect((await peer.start()).ok).toBe(true);
    }
    await settle(room, peers);
    const result = required(peers[0]?.result());
    const envelope = required(value(validateGenesisEscrow(result.genesis))[0]?.shares[0]?.envelope);
    const dealer = required(room.agreement.state.seats[0]);
    const holder = required(room.agreement.state.seats[1]);
    if (dealer.kind !== 'human' || holder.kind !== 'human') throw new Error('Expected humans');
    const invalid = value(
      signOnlineCeremonyPacket(
        {
          protocol: 'online-ceremony-v1',
          freezeHash: toHex(hashValue(room.agreement.state)),
          ceremonyNonce: required(room.agreement.state.ceremonyNonce),
          senderDevice: dealer.peer,
          kind: 'escrow-envelope',
          seat: 0,
          step: 1,
          payload: { ...envelope, sig: toBase64Url(new Uint8Array(64)) },
        },
        required(room.deviceKeys[0]),
      ),
    );
    room.network.transport(dealer.peer).send(holder.peer, invalid.bytes);
    room.network.clock.advanceBy(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await peers[1]?.flush();
    room.network.clock.advanceBy(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await peers[0]?.flush();
    expect(peers[0]?.result()).toEqual(result);
    expect(peers[1]?.result()).not.toBeNull();
    peers[0]?.dispose();
    const restored = room.create(0, required(room.stores[0]), undefined, result);
    active.push(restored);
    expect((await restored.start()).ok).toBe(true);
    await restored.flush();
    expect(restored.result()).toEqual(result);
  }, 60_000);

  test('a dealer-signed publicly invalid envelope yields verifiable retirement evidence', async () => {
    const room = setup({ kind: 'joint' }, 4);
    let invalid: Uint8Array | null = null;
    const transport = interceptTransport(room, 0, (to, _bytes, packet) => {
      if (
        packet.body.kind !== 'escrow-envelope' ||
        packet.body.seat !== 0 ||
        packet.body.step !== 1
      )
        return false;
      if (!invalid) {
        const inner = parseCanonical(packet.body.payload, escrowShareEnvelopeSchema);
        if (!inner.ok) throw new Error('Expected a valid source envelope');
        invalid = value(
          signOnlineCeremonyPacket(
            {
              ...packet.body,
              payload: { ...inner.value, sig: toBase64Url(new Uint8Array(64)) },
            },
            required(room.deviceKeys[0]),
          ),
        ).bytes;
      }
      room.network.transport(packet.body.senderDevice).send(to, required(invalid));
      return true;
    });
    const peers = [
      room.create(0, required(room.stores[0]), transport),
      ...[1, 2, 3].map((seat) => room.create(seat)),
    ];
    active.push({
      dispose() {
        for (const peer of peers) peer.dispose();
        room.network.dispose();
      },
    });
    for (const peer of peers) {
      // oxlint-disable-next-line no-await-in-loop -- Start the signed frozen roster in order.
      expect((await peer.start()).ok).toBe(true);
    }
    await until(room, () => peers.every((peer) => peer.snapshot().phase === 'retired'));
    expect(peers[1]?.snapshot().error).toBe('online-ceremony-escrow-invalid');
    expect(peers.every((peer) => peer.result() === null)).toBe(true);
  }, 60_000);

  // oxlint-disable vitest/no-conditional-expect -- Each parameter represents a different durable winner and its required outcome.
  test.each(['retirement', 'consent'] as const)(
    'durable %s wins a cross-coordinator abort versus consent race',
    async (winner) => {
      const room = setup({ kind: 'fixed', seed: toBase64Url(new Uint8Array(32).fill(37)) }, 1);
      const store = required(room.stores[0]);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached = false;
      let consentWrites = 0;
      const actualLock = store.withCeremonyLock.bind(store);
      vi.spyOn(store, 'withCeremonyLock').mockImplementation(async (id, task) => {
        const bytes = await store.load(`online-attempt/${id}`);
        const record = bytes ? canonicalDecode(bytes) : null;
        if (
          winner === 'retirement' &&
          !reached &&
          record &&
          typeof record === 'object' &&
          'phase' in record &&
          record.phase === 'consent'
        ) {
          // Pause before acquiring the outer attempt lock: another coordinator may retire first.
          reached = true;
          await gate;
        }
        return actualLock(id, task);
      });
      const actualCas = store.compareAndSwap.bind(store);
      vi.spyOn(store, 'compareAndSwap').mockImplementation(async (id, expected, replacement) => {
        const won = await actualCas(id, expected, replacement);
        if (id === 'escrow-lifecycle/device-index-v1' && won) {
          const registry = canonicalDecode(replacement);
          if (
            registry &&
            typeof registry === 'object' &&
            'consentingCeremonies' in registry &&
            Array.isArray(registry.consentingCeremonies) &&
            registry.consentingCeremonies.length > 0
          ) {
            consentWrites += 1;
            if (winner === 'consent' && !reached) {
              reached = true;
              await gate;
            }
          }
        }
        return won;
      });
      const producer = room.create(0);
      const contender = room.create(0);
      active.push(producer, contender, room.network);
      const started = producer.start();
      await until(room, () => reached);
      let aborted: Result<void> | null = null;
      const abort = contender.abort().then((result) => {
        aborted = result;
        return result;
      });
      if (winner === 'retirement') {
        expect((await abort).ok).toBe(true);
        expect(contender.snapshot().phase).toBe('retired');
        release();
        await started;
        await producer.flush();
        expect(producer.result()).toBeNull();
        expect(consentWrites).toBe(0);
        expect(producer.snapshot().locallyConsented).toBe(false);
        const restored = room.create(0);
        active.push(restored);
        expect(await restored.start()).toMatchObject({
          ok: false,
          error: { code: 'online-ceremony-retired' },
        });
        expect(restored.result()).toBeNull();
      } else {
        // The competing coordinator must wait for the same device-global lock.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(aborted).toBeNull();
        release();
        expect(await abort).toMatchObject({
          ok: false,
          error: { code: 'escrow-ceremony-completed' },
        });
        expect((await started).ok).toBe(true);
        await settle(room, [producer]);
        const result = required(producer.result());
        expect(consentWrites).toBeGreaterThan(0);
        expect(producer.snapshot().locallyConsented).toBe(true);
        producer.dispose();
        contender.dispose();
        const restored = room.create(0);
        active.push(restored);
        expect((await restored.start()).ok).toBe(true);
        await settle(room, [restored]);
        expect(restored.result()).toEqual(result);
        expect(await restored.abort()).toMatchObject({
          ok: false,
          error: { code: 'online-ceremony-consented' },
        });
      }
    },
    60000,
  );

  // oxlint-enable vitest/no-conditional-expect

  test('timeout after durable local consent waits for the exact missing peer packet', async () => {
    const room = setup();
    const guestSeat = required(room.agreement.state.seats[1]);
    if (guestSeat.kind !== 'human') throw new Error('Expected guest human');
    const actual = room.network.transport(guestSeat.peer);
    const guestTransport: Transport = {
      self: actual.self,
      peers: () => actual.peers(),
      send(to, bytes) {
        const packet = verifyOnlineCeremonyPacket(
          bytes,
          actual.self,
          toHex(hashValue(room.agreement.state)),
          required(room.agreement.state.ceremonyNonce),
        );
        if (packet.ok && packet.value.body.kind === 'consent') return;
        actual.send(to, bytes);
      },
      broadcast: (bytes) => actual.broadcast(bytes),
      onMessage: (listener) => actual.onMessage(listener),
      onPeerChange: (listener) => actual.onPeerChange(listener),
      disconnect: (other) => actual.disconnect(other),
    };
    const host = room.create(0);
    const guest = room.create(1, required(room.stores[1]), guestTransport);
    active.push({
      dispose() {
        host.dispose();
        guest.dispose();
        room.network.dispose();
      },
    });
    expect((await host.start()).ok).toBe(true);
    expect((await guest.start()).ok).toBe(true);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      room.network.clock.advanceBy(0);
      // oxlint-disable-next-line no-await-in-loop -- Drain serialized packet delivery after each virtual tick.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (host.snapshot().phase === 'consent' && host.snapshot().locallyConsented) break;
    }
    expect(host.snapshot()).toMatchObject({ phase: 'consent', locallyConsented: true });
    room.network.clock.advanceBy(21_000);
    await host.flush();
    expect(host.snapshot()).toMatchObject({ phase: 'waiting', locallyConsented: true });
    expect(await host.abort()).toMatchObject({
      ok: false,
      error: { code: 'online-ceremony-consented' },
    });
  }, 60_000);

  test('retains the exact signed packet across a failed durable write and restart', async () => {
    class InterruptedStore extends MemoryEscrowLifecycleStore {
      interruptBinding = true;
      retainedBinding: Uint8Array | null = null;
      override async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
        if (this.interruptBinding && id.includes('/binding/')) {
          this.interruptBinding = false;
          await super.putIfAbsent(id, bytes);
          this.retainedBinding = bytes.slice();
          throw new Error('write outcome unknown after commit');
        }
        return super.putIfAbsent(id, bytes);
      }
    }
    const room = setup();
    const store = new InterruptedStore();
    const peer = required(room.agreement.state.seats[0]);
    if (peer.kind !== 'human') throw new Error('Expected host human');
    const actual = room.network.transport(peer.peer);
    const sent: Uint8Array[] = [];
    const transport: Transport = {
      self: actual.self,
      peers: () => actual.peers(),
      send(to, bytes) {
        sent.push(bytes.slice());
        throw new Error(`link unavailable: ${to}`);
      },
      broadcast: (bytes) => actual.broadcast(bytes),
      onMessage: (listener) => actual.onMessage(listener),
      onPeerChange: (listener) => actual.onPeerChange(listener),
      disconnect: (other) => actual.disconnect(other),
    };
    const first = room.create(0, store, transport);
    active.push({
      dispose() {
        first.dispose();
        room.network.dispose();
      },
    });
    expect(await first.start()).toMatchObject({
      ok: false,
      error: { code: 'online-ceremony-store' },
    });
    const original = required(sent[0]);
    expect(sent).toHaveLength(1);
    first.dispose();
    const resumed = room.create(0, store, transport);
    active.push(resumed);
    expect((await resumed.start()).ok).toBe(true);
    expect(required(sent[1])).toEqual(original);
    expect(
      sent.some(
        (bytes) =>
          bytes.length === required(store.retainedBinding).length &&
          bytes.every((byte, index) => byte === required(store.retainedBinding)[index]),
      ),
    ).toBe(true);
    expect(resumed.snapshot().phase).toBe('bindings');
  });

  test('pre-manifest abort retires the attempt before another process can emit', async () => {
    const room = setup();
    const store = new MemoryEscrowLifecycleStore();
    const first = room.create(0, store);
    active.push({
      dispose() {
        first.dispose();
        room.network.dispose();
      },
    });
    expect((await first.start()).ok).toBe(true);
    expect(first.snapshot().phase).toBe('bindings');
    expect((await first.abort()).ok).toBe(true);
    expect(first.snapshot().phase).toBe('retired');
    first.dispose();
    const resumed = room.create(0, store);
    active.push(resumed);
    expect(await resumed.start()).toMatchObject({
      ok: false,
      error: { code: 'online-ceremony-retired' },
    });
  });

  test('a preconsent timeout retains its bounded phase diagnostic after restart', async () => {
    const room = setup();
    const store = new MemoryEscrowLifecycleStore();
    const first = room.create(0, store);
    active.push({
      dispose() {
        first.dispose();
        room.network.dispose();
      },
    });
    expect((await first.start()).ok).toBe(true);
    expect(first.snapshot().phase).toBe('bindings');
    room.network.clock.advanceBy(20_001);
    await until(room, () => first.snapshot().phase === 'retired');
    expect(first.snapshot().error).toBe('online-ceremony-timeout:bindings');
    first.dispose();
    const restored = room.create(0, store);
    active.push(restored);
    expect(await restored.start()).toMatchObject({
      ok: false,
      error: { code: 'online-ceremony-timeout' },
    });
    expect(restored.snapshot()).toMatchObject({
      phase: 'retired',
      error: 'online-ceremony-timeout:bindings',
      locallyConsented: false,
    });
  });

  test.each([
    { phase: 'frozen', kind: 'created-at', sender: 0, observer: 1 },
    { phase: 'approvals', kind: 'approval', sender: 1, observer: 0 },
    { phase: 'beacon-tips', kind: 'beacon-tip', sender: 1, observer: 0 },
    { phase: 'seed-reveals', kind: 'seed-reveal', sender: 1, observer: 0 },
  ])(
    'missing $kind retires $phase before consent and stays retired on restore',
    async ({ phase, kind, sender, observer }) => {
      const room = setup();
      let consentSends = 0;
      const transports = [0, 1].map((device) =>
        interceptTransport(room, device, (_to, _bytes, packet) => {
          if (packet.body.kind === 'consent') consentSends += 1;
          return device === sender && packet.body.kind === kind;
        }),
      );
      const peers = [0, 1].map((device) =>
        room.create(device, required(room.stores[device]), required(transports[device])),
      );
      active.push(...peers, room.network);
      for (const peer of peers) {
        // oxlint-disable-next-line no-await-in-loop -- Start both members of the same signed frozen attempt.
        expect((await peer.start()).ok).toBe(true);
      }
      const target = required(peers[observer]);
      await until(room, () => target.snapshot().phase === phase);
      expect(target.snapshot().locallyConsented).toBe(false);
      room.network.clock.advanceBy(20_001);
      await until(room, () => target.snapshot().phase === 'retired');
      expect(target.snapshot().error).toBe(`online-ceremony-timeout:${phase}`);
      expect(target.result()).toBeNull();
      expect(consentSends).toBe(0);
      target.dispose();
      const restored = room.create(
        observer,
        required(room.stores[observer]),
        required(transports[observer]),
      );
      active.push(restored);
      expect(await restored.start()).toMatchObject({
        ok: false,
        error: { code: 'online-ceremony-timeout' },
      });
      expect(restored.snapshot()).toMatchObject({
        phase: 'retired',
        locallyConsented: false,
        error: `online-ceremony-timeout:${phase}`,
      });
      expect(restored.result()).toBeNull();
      expect(consentSends).toBe(0);
    },
    60_000,
  );

  test('later signed phases get their own 20-second window without renewing earlier phases', async () => {
    const room = setup();
    let holdGuestCommit = true;
    const guestTransport = interceptTransport(
      room,
      1,
      (_to, _bytes, packet) => holdGuestCommit && packet.body.kind === 'seed-commit',
    );
    const host = room.create(0);
    const guest = room.create(1, required(room.stores[1]), guestTransport);
    active.push({
      dispose() {
        host.dispose();
        guest.dispose();
        room.network.dispose();
      },
    });
    expect((await host.start()).ok).toBe(true);
    expect(host.snapshot().phase).toBe('bindings');
    room.network.clock.advanceBy(15_000);
    expect((await guest.start()).ok).toBe(true);
    await until(room, () => host.snapshot().phase === 'seed-commits');
    room.network.clock.advanceBy(10_000);
    await until(room, () => host.snapshot().phase === 'seed-commits');
    expect(host.snapshot().phase).not.toBe('retired');
    holdGuestCommit = false;
    room.network.clock.advanceBy(1_001);
    await settle(room, [host, guest]);
    expect(host.snapshot().phase).toBe('ready');
    expect(guest.snapshot().phase).toBe('ready');
  }, 60_000);

  test('already accepted escrow retries do not repeat proof verification', async () => {
    const room = setup({ kind: 'joint' }, 4);
    const hostPeer = identityFromSecret(required(room.deviceKeys[0])).peerId;
    const acknowledgement: { bytes: Uint8Array | null } = { bytes: null };
    let heldDeck = false;
    const commitment: { packet: OnlineCeremonyPacket | null } = { packet: null };
    const guestTransport = interceptTransport(room, 1, (to, bytes, packet) => {
      if (to === hostPeer && packet.body.kind === 'seed-commit') commitment.packet = packet;
      if (to === hostPeer && packet.body.kind === 'escrow-accepted')
        acknowledgement.bytes = bytes.slice();
      if (to === hostPeer && packet.body.kind === 'deck-pass' && packet.body.step === 1) {
        heldDeck = true;
        return true;
      }
      return false;
    });
    const host = room.create(0);
    const guest = room.create(1, required(room.stores[1]), guestTransport);
    const others = [room.create(2), room.create(3)];
    active.push(host, guest, ...others, room.network);
    expect((await host.start()).ok).toBe(true);
    expect((await guest.start()).ok).toBe(true);
    for (const peer of others) {
      // oxlint-disable-next-line no-await-in-loop -- Start each frozen participant.
      expect((await peer.start()).ok).toBe(true);
    }
    await until(room, () => heldDeck);
    await host.flush();
    expect(host.snapshot().phase).toBe('deck');
    const proof = vi.spyOn(escrowDistribution, 'verifyEscrowShareAck');
    const persisted = vi.spyOn(required(room.stores[0]), 'load');
    const retry = required(acknowledgement.bytes);
    const sender = room.network.transport(identityFromSecret(required(room.deviceKeys[1])).peerId);
    for (let index = 0; index < 8; index += 1) sender.send(hostPeer, retry);
    room.network.clock.advanceBy(0);
    await host.flush();
    expect(proof).not.toHaveBeenCalled();
    expect(persisted).not.toHaveBeenCalled();
    const packet = value(
      verifyOnlineCeremonyPacket(
        retry,
        sender.self,
        toHex(hashValue(room.agreement.state)),
        required(room.agreement.state.ceremonyNonce),
      ),
    );
    const payload = packet.body.payload;
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('ack' in payload) ||
      !payload.ack ||
      typeof payload.ack !== 'object'
    )
      throw new Error('Missing escrow acknowledgement');
    const invalid = value(
      signOnlineCeremonyPacket(
        {
          ...packet.body,
          payload: { ...payload, ack: { ...payload.ack, sig: toBase64Url(new Uint8Array(64)) } },
        },
        required(room.deviceKeys[1]),
      ),
    ).bytes;
    sender.send(hostPeer, invalid);
    room.network.clock.advanceBy(0);
    await host.flush();
    sender.send(hostPeer, invalid);
    room.network.clock.advanceBy(0);
    await host.flush();
    expect(proof).toHaveBeenCalledTimes(2);
    proof.mockClear();
    const outer = vi.spyOn(ceremonyWire, 'verifyOnlineCeremonyPacket');
    const wrongSender = identityFromSecret(required(room.deviceKeys[2])).peerId;
    room.network
      .transport(identityFromSecret(required(room.deviceKeys[2])).peerId)
      .send(hostPeer, retry);
    sender.send(hostPeer, retry);
    room.network.clock.advanceBy(0);
    await host.flush();
    expect(proof).not.toHaveBeenCalled();
    expect(outer).toHaveBeenCalledTimes(1);
    expect(outer.mock.calls[0]?.[1]).toBe(wrongSender);
    expect(outer.mock.results[0]?.value.ok).toBe(false);
    expect(host.snapshot().phase).toBe('deck');
    const committed = required(commitment.packet);
    const original = value(
      signOnlineCeremonyPacket(committed.body, required(room.deviceKeys[1])),
    ).bytes;
    const attemptId = ceremonyWire.onlineCeremonyAttemptId(
      committed.body.freezeHash,
      committed.body.ceremonyNonce,
    );
    expect(
      await required(room.stores[0]).load(`online-ceremony/${attemptId}/seed-commit/1/0`),
    ).toEqual(original);
    const conflicting = value(
      signOnlineCeremonyPacket({ ...committed.body, payload: null }, required(room.deviceKeys[1])),
    ).bytes;
    sender.send(hostPeer, original);
    sender.send(hostPeer, original);
    sender.send(hostPeer, conflicting);
    room.network.clock.advanceBy(0);
    await host.flush();
    expect(host.snapshot().phase).toBe('retired');
    expect(host.snapshot().error).toBe('online-ceremony-conflict:deck');
  }, 60_000);

  test('failed escrow persistence remains retryable after ingress coalescing', async () => {
    const room = setup({ kind: 'joint' }, 4);
    const hostPeer = identityFromSecret(required(room.deviceKeys[0])).peerId;
    const held: { bytes: Uint8Array | null } = { bytes: null };
    const guestTransport = interceptTransport(room, 1, (to, bytes, packet) => {
      if (to !== hostPeer || packet.body.kind !== 'escrow-accepted' || packet.body.step !== 0)
        return false;
      held.bytes = bytes.slice();
      return true;
    });
    const peers = [
      room.create(0),
      room.create(1, required(room.stores[1]), guestTransport),
      room.create(2),
      room.create(3),
    ];
    active.push(...peers, room.network);
    for (const peer of peers) {
      // oxlint-disable-next-line no-await-in-loop -- Start each frozen participant.
      expect((await peer.start()).ok).toBe(true);
    }
    await until(room, () => held.bytes !== null);
    await required(peers[0]).flush();
    const store = required(room.stores[0]);
    const actualPut = store.putIfAbsent.bind(store);
    let failures = 0;
    let key = '';
    vi.spyOn(store, 'putIfAbsent').mockImplementation(async (id, bytes) => {
      if (id.endsWith('/escrow-accepted/1/0')) {
        key = id;
        if (failures++ === 0) throw new Error('Transient durable write failure');
      }
      return actualPut(id, bytes);
    });
    const sender = room.network.transport(identityFromSecret(required(room.deviceKeys[1])).peerId);
    const retry = required(held.bytes);
    for (let index = 0; index < 8; index += 1) sender.send(hostPeer, retry);
    room.network.clock.advanceBy(0);
    await required(peers[0]).flush();
    expect(failures).toBe(1);
    expect(await store.load(key)).toBeNull();
    sender.send(hostPeer, retry);
    room.network.clock.advanceBy(0);
    await required(peers[0]).flush();
    expect(failures).toBe(2);
    expect(await store.load(key)).toEqual(retry);
    expect(required(peers[0]).snapshot().phase).not.toBe('retired');
  }, 60_000);

  /* oxlint-disable vitest/no-conditional-expect -- Each parameter exercises a distinct delivery outcome. */
  test.each(['valid', 'invalid', 'restart'] as const)(
    'future deck delivery %s waits privately for its exact predecessor',
    async (mode) => {
      const room = setup({ kind: 'joint' }, 4);
      const observer = identityFromSecret(required(room.deviceKeys[3])).peerId;
      const held: { bytes: Uint8Array | null } = { bytes: null };
      let futureDelivered = false;
      const hostTransport = interceptTransport(room, 0, (to, bytes, packet) => {
        if (to !== observer || packet.body.kind !== 'deck-pass' || packet.body.step !== 0)
          return false;
        held.bytes = bytes.slice();
        return true;
      });
      const guestTransport = interceptTransport(room, 1, (to, _bytes, packet) => {
        if (to === observer && packet.body.kind === 'deck-pass' && packet.body.step === 1)
          futureDelivered = true;
        if (
          mode === 'invalid' &&
          to === observer &&
          packet.body.kind === 'deck-pass' &&
          packet.body.step === 1
        ) {
          const payload = packet.body.payload;
          if (!payload || typeof payload !== 'object') throw new Error('Missing signed pass');
          const invalid = value(
            signOnlineCeremonyPacket(
              {
                ...packet.body,
                payload: { ...payload, sig: toBase64Url(new Uint8Array(64)) },
              },
              required(room.deviceKeys[1]),
            ),
          );
          room.network
            .transport(identityFromSecret(required(room.deviceKeys[1])).peerId)
            .send(to, invalid.bytes);
          return true;
        }
        return false;
      });
      const peers = [
        room.create(0, required(room.stores[0]), hostTransport),
        room.create(1, required(room.stores[1]), guestTransport),
        room.create(2),
        room.create(3),
      ];
      active.push(...peers, room.network);
      const persisted = vi.spyOn(required(room.stores[3]), 'putIfAbsent');
      // oxlint-disable-next-line no-await-in-loop -- Start peers in deterministic actor order.
      for (const peer of peers) expect((await peer.start()).ok).toBe(true);
      await until(room, () => held.bytes !== null && futureDelivered);
      room.network.clock.advanceBy(0);
      await required(peers[3]).flush();
      expect(required(peers[3]).snapshot().phase).toBe('deck');
      expect(persisted.mock.calls.some(([key]) => key.endsWith('/deck-pass/1/1'))).toBe(false);
      if (mode === 'restart') {
        required(peers[3]).dispose();
        peers[3] = room.create(3);
        active.push(required(peers[3]));
        expect((await required(peers[3]).start()).ok).toBe(true);
      }
      room.network
        .transport(identityFromSecret(required(room.deviceKeys[0])).peerId)
        .send(observer, required(held.bytes));
      if (mode === 'invalid') {
        await until(room, () => required(peers[3]).snapshot().phase === 'retired');
        expect(required(peers[3]).snapshot().error).toBe('online-ceremony-invalid-packet:deck');
        expect(required(peers[3]).result()).toBeNull();
        return;
      }
      if (mode === 'restart') {
        room.network.clock.advanceBy(0);
        await required(peers[3]).flush();
        expect(required(peers[3]).snapshot().phase).toBe('deck');
        room.network.clock.advanceBy(1_001);
      }
      await settle(room, peers);
      expect(peers.map((peer) => peer.snapshot().phase)).toEqual(Array(4).fill('ready'));
    },
    60_000,
  );

  /* oxlint-enable vitest/no-conditional-expect */

  test('cached deck retries skip validated passes, restart revalidates and retains deadline', async () => {
    const room = setup();
    let held = false;
    let retries = 0;
    const guestTransport = interceptTransport(room, 1, (_to, _bytes, packet) => {
      if (packet.body.kind !== 'deck-pass' || packet.body.step !== 5) return false;
      held = true;
      retries += 1;
      return true;
    });
    const host = room.create(0);
    const guest = room.create(1, required(room.stores[1]), guestTransport);
    active.push(host, guest, room.network);
    const applied = vi.spyOn(deckSetup, 'applyDeckPass');
    expect((await host.start()).ok).toBe(true);
    expect((await guest.start()).ok).toBe(true);
    await until(room, () => held && host.snapshot().phase === 'deck');
    await Promise.all([host.flush(), guest.flush()]);
    // Let the one-time background proof checks of already accepted passes run first; retries
    // themselves must not validate those passes again.
    room.network.clock.advanceBy(0);
    await Promise.all([host.flush(), guest.flush()]);
    applied.mockClear();
    const previousRetries = retries;
    room.network.clock.advanceBy(1_001);
    await until(room, () => retries > previousRetries);
    await Promise.all([host.flush(), guest.flush()]);
    expect(applied).not.toHaveBeenCalled();
    expect(host.snapshot().phase).toBe('deck');
    host.dispose();
    const restored = room.create(0);
    active.push(restored);
    expect((await restored.start()).ok).toBe(true);
    await until(room, () => restored.snapshot().phase === 'deck');
    expect(applied).toHaveBeenCalled();
    room.network.clock.advanceBy(18_999);
    await until(room, () => restored.snapshot().phase === 'retired');
    expect(restored.snapshot().error).toBe('online-ceremony-timeout:deck');
  }, 60_000);

  test('mutating validator outputs cannot poison the coordinator-owned prefix', async () => {
    const room = setup();
    let hold = true;
    let held = false;
    const guestTransport = interceptTransport(room, 1, (_to, _bytes, packet) => {
      if (!hold || packet.body.kind !== 'deck-pass' || packet.body.step !== 5) return false;
      held = true;
      return true;
    });
    const host = room.create(0);
    const guest = room.create(1, required(room.stores[1]), guestTransport);
    active.push(host, guest, room.network);
    const originalApply = deckSetup.applyDeckPass;
    const outputs: DeckSetupState[] = [];
    vi.spyOn(deckSetup, 'applyDeckPass').mockImplementation((state, pass) => {
      const applied = originalApply(state, pass);
      if (applied.ok) outputs.push(applied.value);
      return applied;
    });
    expect((await host.start()).ok).toBe(true);
    expect((await guest.start()).ok).toBe(true);
    await until(room, () => held && host.snapshot().phase === 'deck');
    await Promise.all([host.flush(), guest.flush()]);
    expect(outputs.length).toBeGreaterThan(0);
    // These are the exact mutable values returned by the public validator.
    // Cached states must own copies rather than retaining these references.
    for (const output of outputs) output.points[0] = toBase64Url(new Uint8Array(32));
    hold = false;
    room.network.clock.advanceBy(1_001);
    await settle(room, [host, guest]);
    expect(host.snapshot().phase).toBe('ready');
    expect(guest.snapshot().phase).toBe('ready');
    expect(host.result()?.entry).toEqual(guest.result()?.entry);
  }, 60_000);

  test('an invalid late deck pass is rejected after caching its valid predecessors', async () => {
    const room = setup();
    const held: OnlineCeremonyPacket[] = [];
    const guestTransport = interceptTransport(room, 1, (_to, _bytes, packet) => {
      if (packet.body.kind !== 'deck-pass' || packet.body.step !== 5) return false;
      held.push(packet);
      return true;
    });
    const host = room.create(0);
    const guest = room.create(1, required(room.stores[1]), guestTransport);
    active.push(host, guest, room.network);
    expect((await host.start()).ok).toBe(true);
    expect((await guest.start()).ok).toBe(true);
    await until(room, () => held.length > 0 && host.snapshot().phase === 'deck');
    await Promise.all([host.flush(), guest.flush()]);
    const packet = required(held[0]);
    const payload = packet.body.payload;
    if (!payload || typeof payload !== 'object') throw new Error('Missing held signed pass');
    const invalid = value(
      signOnlineCeremonyPacket(
        {
          ...packet.body,
          payload: { ...payload, sig: toBase64Url(new Uint8Array(64)) },
        },
        required(room.deviceKeys[1]),
      ),
    );
    room.network
      .transport(
        required(
          room.agreement.state.seats[1]?.kind === 'human'
            ? room.agreement.state.seats[1].peer
            : null,
        ),
      )
      .send(required(room.agreement.state.hostPeer), invalid.bytes);
    await until(room, () => host.snapshot().phase === 'retired');
    expect(host.snapshot().error).toBe('online-ceremony-invalid-packet:deck');
    expect(host.result()).toBeNull();
  }, 60_000);

  test('same-phase retries and restart retain the original deadline', async () => {
    const room = setup();
    const store = new MemoryEscrowLifecycleStore();
    const first = room.create(0, store);
    active.push({
      dispose() {
        first.dispose();
        room.network.dispose();
      },
    });
    expect((await first.start()).ok).toBe(true);
    room.network.clock.advanceBy(10_000);
    await until(room, () => first.snapshot().phase === 'bindings');
    first.dispose();
    const restored = room.create(0, store);
    active.push(restored);
    expect((await restored.start()).ok).toBe(true);
    room.network.clock.advanceBy(9_999);
    await until(room, () => restored.snapshot().phase === 'bindings');
    room.network.clock.advanceBy(1);
    await until(room, () => restored.snapshot().phase === 'retired');
    expect(restored.snapshot().error).toBe('online-ceremony-timeout:bindings');
  });

  test('a persisted private packet cannot send after waiting for the escrow lock past deadline', async () => {
    const room = setup({ kind: 'joint' }, 4);
    const store = required(room.stores[0]);
    const originalPut = store.putIfAbsent.bind(store);
    const originalLock = store.withCeremonyLock.bind(store);
    let expireNextLock = false;
    let envelopeSends = 0;
    store.putIfAbsent = async (id, bytes) => {
      const saved = await originalPut(id, bytes);
      if (saved && id.includes('/escrow-envelope/')) expireNextLock = true;
      return saved;
    };
    store.withCeremonyLock = (id, task) => {
      if (expireNextLock) {
        expireNextLock = false;
        room.network.clock.advanceBy(20_000);
      }
      return originalLock(id, task);
    };
    const dealerTransport = interceptTransport(room, 0, (_to, _bytes, packet) => {
      if (packet.body.kind === 'escrow-envelope') envelopeSends += 1;
      return false;
    });
    const peers = [
      room.create(0, store, dealerTransport),
      room.create(1),
      room.create(2),
      room.create(3),
    ];
    active.push({
      dispose() {
        for (const peer of peers) peer.dispose();
        room.network.dispose();
      },
    });
    for (const peer of peers) {
      // oxlint-disable-next-line no-await-in-loop -- Start the frozen roster before withholding the local send lock.
      expect((await peer.start()).ok).toBe(true);
    }
    await until(room, () => peers[0]?.snapshot().phase === 'retired');
    expect(peers[0]?.snapshot().error).toBe('online-ceremony-timeout:escrow');
    expect(envelopeSends).toBe(0);
  }, 60_000);
});
