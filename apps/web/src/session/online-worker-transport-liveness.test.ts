import { describe, expect, test } from 'vitest';
import { MemoryProtocolJournal, P2PSession, decodeProtocolMessage } from '@cp2p/protocol';
import type { P2PSessionOptions, ReplayPolicy, Transport } from '@cp2p/protocol';
import { createMemnet, SimulationDriver, VirtualClock } from '@cp2p/protocol/testing';
import { protocolFixture } from '../../../../packages/protocol/src/testing/fixtures.js';
import type { OnlineTransportPort } from './online-worker-transport.js';
import {
  createMainThreadTransportBridge,
  createWorkerDeviceTransport,
} from './online-worker-transport.js';

class TestPort implements OnlineTransportPort {
  private peer!: TestPort;
  private readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
  private closed = false;

  connect(peer: TestPort): void {
    this.peer = peer;
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    if (this.closed || this.peer.closed) throw new Error('MessagePort is closed');
    const copied = structuredClone(message, transfer.length ? { transfer } : {});
    queueMicrotask(() => {
      if (this.peer.closed) return;
      for (const listener of this.peer.listeners)
        listener(new MessageEvent('message', { data: copied }));
    });
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.delete(listener);
  }

  start(): void {}

  close(): void {
    this.closed = true;
  }
}

function makePorts(): [TestPort, TestPort] {
  const main = new TestPort();
  const worker = new TestPort();
  main.connect(worker);
  worker.connect(main);
  return [main, worker];
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function drain(sessions: readonly P2PSession[], clock: VirtualClock): Promise<void> {
  for (let turn = 0; turn < 16; turn++) {
    // oxlint-disable-next-line no-await-in-loop -- Each flush pass drains deliveries from the preceding clock tick.
    await Promise.all(sessions.map((session) => session.flush()));
    clock.advanceBy(0);
    // oxlint-disable-next-line no-await-in-loop -- Let MessagePort deliveries run before the next flush.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  await Promise.all(sessions.map((session) => session.flush()));
}

describe('online worker transport liveness', () => {
  test('a dropped consensus submit is retried and commits the same head without disconnecting', async () => {
    const fixture = protocolFixture();
    const host = fixture.identities[0];
    const guest = fixture.identities[1];
    const hostBot = fixture.identities[2];
    const guestBot = fixture.identities[3];
    if (!host || !guest || !hostBot || !guestBot) throw new Error('Missing fixture identity');

    const clock = new VirtualClock();
    const network = createMemnet({ peers: [host.peerId, guest.peerId], clock });
    const actualHostTransport = network.transport(host.peerId);
    let droppedSubmit = false;
    const outboundTypes: string[] = [];
    const disconnected: string[] = [];
    const send = (peer: string, bytes: Uint8Array) => {
      const decoded = decodeProtocolMessage(bytes);
      if (decoded.ok) outboundTypes.push(decoded.value.t);
      if (!droppedSubmit && decoded.ok && decoded.value.t === 'SUBMIT') {
        droppedSubmit = true;
        return;
      }
      actualHostTransport.send(peer, bytes);
    };
    const flakyHostTransport: Transport = {
      self: actualHostTransport.self,
      peers: () => actualHostTransport.peers(),
      send,
      broadcast(bytes) {
        for (const peer of actualHostTransport.peers()) send(peer, bytes);
      },
      onMessage: (listener) => actualHostTransport.onMessage(listener),
      onPeerChange: (listener) => actualHostTransport.onPeerChange(listener),
      disconnect(peer) {
        disconnected.push(peer);
        actualHostTransport.disconnect(peer);
      },
    };
    const [mainPort, workerPort] = makePorts();
    const bridgeFailures: Error[] = [];
    const bridge = createMainThreadTransportBridge({
      transport: flakyHostTransport,
      port: mainPort,
      generation: 'liveness-generation',
      onFailure: (error) => bridgeFailures.push(error),
    });
    const workerTransport = createWorkerDeviceTransport({
      self: host.peerId,
      peers: [guest.peerId],
      port: workerPort,
      generation: 'liveness-generation',
      onFailure: (error) => bridgeFailures.push(error),
    });

    const policy: ReplayPolicy = {
      genesis: { allowStub: true },
      entry: { allowStub: true },
    };
    const createSession = async (seat: 0 | 1, transport: Transport): Promise<P2PSession> => {
      const identity = seat === 0 ? host : guest;
      const bot = seat === 0 ? hostBot : guestBot;
      const options: P2PSessionOptions = {
        genesisEntry: fixture.entry,
        engine: fixture.engine,
        policy,
        seat,
        secretKey: identity.secretKey,
        transport,
        clock,
        journal: new MemoryProtocolJournal(),
        botKeys: new Map([[seat === 0 ? 2 : 3, bot.secretKey]]),
        createDriver: (engine, genesis, driverClock) =>
          new SimulationDriver(engine, genesis, driverClock),
      };
      return value(await P2PSession.create(options));
    };

    const sessions = [
      await createSession(0, workerTransport),
      await createSession(1, network.transport(guest.peerId)),
    ];
    try {
      await drain(sessions, clock);
      const ownerIndexForTurn = () => {
        const activeSeat = sessions[0]?.getState().turn.activeSeat;
        return activeSeat === 0 || activeSeat === 2
          ? 0
          : activeSeat === 1 || activeSeat === 3
            ? 1
            : -1;
      };
      for (let step = 0; ownerIndexForTurn() === 1 && step < 4; step++) {
        const guestSession = sessions[1];
        if (!guestSession) throw new Error('Missing guest session');
        const seat = guestSession.getState().turn.activeSeat;
        const setupCommand = guestSession.getLegalCommands(seat).commands[0];
        if (!setupCommand) throw new Error('Expected a guest setup command');
        const prepared = guestSession.submit(seat, setupCommand);
        // oxlint-disable-next-line no-await-in-loop -- Each setup action changes the next legal turn.
        await drain(sessions, clock);
        // oxlint-disable-next-line no-await-in-loop -- The next owner depends on this certified setup commit.
        await expect(prepared).resolves.toMatchObject({ ok: true });
      }
      const ownerIndex = ownerIndexForTurn();
      const owner = sessions[ownerIndex];
      if (!owner || ownerIndex < 0) throw new Error('No session owns the active setup seat');
      const activeSeat = owner.getState().turn.activeSeat;
      const command = owner.getLegalCommands(activeSeat).commands[0];
      if (!command) throw new Error('Expected a legal setup command');

      const before = owner.getCommittedHead();
      const submission = owner.submit(activeSeat, command);
      await drain(sessions, clock);
      expect(droppedSubmit).toBe(true);
      expect(outboundTypes).toContain('SUBMIT');
      expect(sessions[1]?.getCommittedHead()).toEqual(before);
      expect(disconnected).toEqual([]);
      expect(bridgeFailures).toEqual([]);

      for (
        let pulse = 0;
        pulse < 5 && sessions[0]?.getCommittedHead().seq === before.seq;
        pulse++
      ) {
        clock.advanceBy(2_000);
        // oxlint-disable-next-line no-await-in-loop -- Each pulse may deliver the retry needed for the next check.
        await drain(sessions, clock);
      }
      await expect(submission).resolves.toMatchObject({ ok: true });
      expect(sessions[0]?.getCommittedHead()).toEqual(sessions[1]?.getCommittedHead());
      expect(sessions[0]?.getCommittedHead().seq).toBe(before.seq + 1);
      expect(disconnected).toEqual([]);
      expect(bridgeFailures).toEqual([]);
    } finally {
      sessions.forEach((session) => session.dispose());
      workerTransport.close();
      bridge.close();
      network.dispose();
    }
  }, 15_000);
});
