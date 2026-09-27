import { scalarToBytes } from '@cp2p/crypto';
import type { CommandShape, Result, Seat } from '@cp2p/engine';
import { expect, test } from 'vitest';
import { MemoryBeaconContributionStore } from './beacon-contributions.js';
import { MemoryCheatCandidateStore } from './cheat-candidates.js';
import { MemoryCountContributionStore } from './count-contributions.js';
import { genesisDigest } from './genesis.js';
import { validateGenesisEscrow } from './genesis-escrow.js';
import { MemoryGenesisConsentStore } from './genesis-outbox.js';
import { createHandSecretSource } from './hand-source.js';
import { MemoryProtocolJournal } from './journal.js';
import { decodeProtocolMessage } from './messages.js';
import { P2PSession } from './p2p-session.js';
import type { P2PSessionOptions } from './p2p-session.js';
import { MemoryStealDeliveryStore } from './steal-contributions.js';
import { createStealSecretSource } from './steal-source.js';
import { createMemnet } from './testing/memnet.js';
import { createVerifiedDeckSession } from './testing/verified-deck-session.js';
import { VerifiedSessionDriver } from './verified-session-driver.js';
import type { Transport } from './transport.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing departure fixture value');
  return item;
}

function master(seat: Seat): Uint8Array {
  return scalarToBytes(BigInt(17 + seat));
}

function expectSameHistory(
  sessions: ReadonlyMap<Seat, P2PSession>,
  head: ReturnType<P2PSession['getCommittedHead']>,
  entries: ReturnType<P2PSession['exportSave']>['entries'],
): void {
  for (const session of sessions.values()) {
    expect(session.getCommittedHead()).toEqual(head);
    expect(session.exportSave().entries).toEqual(entries);
  }
}

function observed(inner: Transport, recoveryMessages: string[]): Transport {
  const record = (bytes: Uint8Array) => {
    const decoded = decodeProtocolMessage(bytes);
    if (
      decoded.ok &&
      (decoded.value.t === 'RECOVERY_RELEASE' || decoded.value.t === 'RECOVERY_CHECK')
    )
      recoveryMessages.push(decoded.value.t);
  };
  return {
    self: inner.self,
    peers: () => inner.peers(),
    send(to, bytes) {
      record(bytes);
      inner.send(to, bytes);
    },
    broadcast(bytes) {
      record(bytes);
      inner.broadcast(bytes);
    },
    onMessage: (listener) => inner.onMessage(listener),
    onPeerChange: (listener) => inner.onPeerChange(listener),
    disconnect: (peer) => inner.disconnect(peer),
  };
}

test.each([2, 3] as const)(
  '%i humans pause without recovery release, then resume the same certified history',
  async (humanCount) => {
    const fixture = createVerifiedDeckSession(7, humanCount, 8);
    expect(value(validateGenesisEscrow(fixture.genesis))).toEqual([]);
    const peers = fixture.humans.map(
      ({ seat }) => required(fixture.simulation.identities.get(seat)).peerId,
    );
    const net = createMemnet({ peers });
    const journals = new Map<Seat, MemoryProtocolJournal>();
    const options = new Map<Seat, P2PSessionOptions>();
    const sessions = new Map<Seat, P2PSession>();
    const recoveryMessages: string[] = [];
    const targetSeat = 0 as const;
    const targetPeer = required(peers[0]);

    const makeOptions = (seat: Seat, transport: Transport): P2PSessionOptions => {
      const journal = journals.get(seat) ?? new MemoryProtocolJournal();
      journals.set(seat, journal);
      const recoveryStore = new MemoryGenesisConsentStore();
      const steal = createStealSecretSource(
        master(seat),
        fixture.genesis.ceremonyNonce,
        seat,
        required(fixture.genesis.seats.find((item) => item.seat === seat)).publicKey,
      );
      return {
        genesisEntry: fixture.entry,
        engine: fixture.simulation.engine,
        policy: fixture.policy,
        seat,
        secretKey: required(fixture.simulation.identities.get(seat)).secretKey,
        botKeys: fixture.botKeysFor(seat),
        transport: observed(transport, recoveryMessages),
        clock: net.clock,
        journal,
        cheatCandidateStore: new MemoryCheatCandidateStore(),
        beaconSource: fixture.beaconSourceFor(seat),
        beaconContributions: new MemoryBeaconContributionStore(),
        deckSetupPasses: fixture.deckSetupPasses,
        createDeckSource: fixture.createDeckSourceFor(seat),
        deckContributions: new MemoryGenesisConsentStore(),
        countContributionStore: new MemoryCountContributionStore(),
        stealDeliveryStore: new MemoryStealDeliveryStore(),
        recoveryStore,
        recoveryParticipant: {
          store: recoveryStore,
          privateEntropy: () => new Uint8Array(32).fill(90 + seat),
          encryptionSecret: () => steal.encryptionSecret(),
        },
        createDriver: (engine, genesis, _clock, owned) =>
          new VerifiedSessionDriver(
            engine,
            genesis,
            owned,
            fixture.createDeckSourceFor(seat),
            (owner) => createHandSecretSource(master(owner), genesisDigest(genesis), owner),
            fixture.createStealSourceFor(seat),
          ),
      };
    };

    const flush = async () => {
      await Promise.all([...sessions.values()].map((session) => session.flush()));
      net.clock.advanceBy(0);
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const pumpUntil = async (condition: () => boolean, limit = 150) => {
      for (let step = 0; step < limit; step += 1) {
        // oxlint-disable-next-line no-await-in-loop -- Each certified round depends on the prior delivery.
        await flush();
        if (condition()) return;
        net.clock.advanceBy(250);
      }
      throw new Error(
        `Departure trace did not converge: ${JSON.stringify(
          [...sessions].map(([seat, session]) => ({
            seat,
            head: session.getCommittedHead(),
            active: session.getState().turn.activeSeat,
            phase: session.getState().turn.phase,
            status: session.getProtocolStatus(),
            legal: session.getLegalCommands(session.getState().turn.activeSeat).commands.length,
          })),
        )}`,
      );
    };
    const commonHead = () => {
      const heads = [...sessions.values()].map((session) => session.getCommittedHead());
      return heads.every((head) => head.seq === heads[0]?.seq && head.hash === heads[0]?.hash);
    };

    try {
      for (const human of fixture.humans) {
        const current = makeOptions(human.seat, net.transport(required(peers[human.seat])));
        options.set(human.seat, current);
        // oxlint-disable-next-line no-await-in-loop -- Each replica owns one independent durable journal.
        sessions.set(human.seat, value(await P2PSession.create(current)));
      }
      await pumpUntil(() => commonHead() && required(sessions.get(0)).getCommittedHead().seq >= 1);
      const before = required(sessions.get(1)).getCommittedHead();
      const beforeEntries = required(sessions.get(1)).exportSave().entries;
      required(sessions.get(targetSeat)).dispose();
      sessions.delete(targetSeat);
      net.crash(targetPeer);
      net.clock.advanceBy(200_000);
      for (let tick = 0; tick < 6; tick += 1) {
        // oxlint-disable-next-line no-await-in-loop -- Give delayed consensus retries a bounded turn.
        await flush();
        net.clock.advanceBy(1_000);
      }
      expect(
        [...sessions.values()].every((session) => session.getCommittedHead().hash === before.hash),
      ).toBe(true);
      expect(recoveryMessages).toEqual([]);
      expect(await required(sessions.get(1)).requestTakeover(targetSeat, 'easy')).toMatchObject({
        ok: false,
        error: { code: 'recovery-offline-required' },
      });
      expect(recoveryMessages).toEqual([]);
      expect(
        [...sessions.values()].every((session) => session.getRecoveryCandidate() === null),
      ).toBe(true);

      const returnedTransport = net.restart(targetPeer);
      const returnedOptions = {
        ...required(options.get(targetSeat)),
        transport: observed(returnedTransport, recoveryMessages),
      };
      sessions.set(targetSeat, value(await P2PSession.restore(returnedOptions)));
      await pumpUntil(() => {
        if (!commonHead()) return false;
        const state = required(sessions.get(0)).getState();
        return [...sessions.values()].some(
          (session) => session.getLegalCommands(state.turn.activeSeat).commands.length > 0,
        );
      });
      const resumed = required(sessions.get(targetSeat)).exportSave();
      expect(resumed.entries.slice(0, before.seq)).toEqual(beforeEntries);
      expect(recoveryMessages).toEqual([]);
      const active = required(sessions.get(0)).getState().turn.activeSeat;
      const owner = [...sessions.values()].find(
        (session) => session.getLegalCommands(active).commands.length > 0,
      );
      const command: CommandShape = required(owner?.getLegalCommands(active).commands[0]);
      const submitted = required(owner).submit(active, command);
      const nextSeq = required(owner).getCommittedHead().seq + 1;
      await pumpUntil(() => commonHead() && required(owner).getCommittedHead().seq >= nextSeq);
      expect(await submitted).toMatchObject({ ok: true });
      expect(recoveryMessages).toEqual([]);

      if (humanCount === 2) {
        const allAwayHead = required(sessions.get(0)).getCommittedHead();
        const allAwayEntries = required(sessions.get(0)).exportSave().entries;
        for (const [seat, session] of sessions) {
          session.dispose();
          net.crash(required(peers[seat]));
        }
        sessions.clear();
        net.clock.advanceBy(200_000);
        for (const human of fixture.humans) {
          const transport = net.restart(required(peers[human.seat]));
          const restored = {
            ...required(options.get(human.seat)),
            transport: observed(transport, recoveryMessages),
          };
          // oxlint-disable-next-line no-await-in-loop -- Each peer restores its own durable journal.
          sessions.set(human.seat, value(await P2PSession.restore(restored)));
        }
        await pumpUntil(commonHead);
        expectSameHistory(sessions, allAwayHead, allAwayEntries);
      }
      expect(recoveryMessages).toEqual([]);
    } finally {
      for (const session of sessions.values()) session.dispose();
      net.dispose();
    }
  },
  90_000,
);
