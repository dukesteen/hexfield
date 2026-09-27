import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { scalarToBytes } from '@cp2p/crypto';
import { failure } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { createBeaconSecretSource } from './beacon-source.js';
import { MemoryBeaconContributionStore } from './beacon-contributions.js';
import { MemoryCheatCandidateStore } from './cheat-candidates.js';
import { MemoryCountContributionStore } from './count-contributions.js';
import { createConsensusState } from './consensus.js';
import { deckCeremonyId } from './deck-genesis.js';
import type { DeckContributionStore } from './deck-outbox.js';
import { entryHash } from './genesis.js';
import { MemoryProtocolJournal } from './journal.js';
import { decodeProtocolMessage } from './messages.js';
import { ReplicatedLog } from './replicated-log.js';
import type { ReplicatedLogOptions } from './replicated-log.js';
import { restoreRetiredSafety } from './retired-safety.js';
import { MemoryStealDeliveryStore } from './steal-contributions.js';
import { createMemnet } from './testing/memnet.js';
import {
  advanceRecoveryFixture,
  createRecoveryFixture,
  recoveryFixtureKey,
  recoveryFixtureReadiness,
  recoveryFixtureReplacement,
  signRecoveryFixtureActivation,
  signRecoveryFixtureAuthorization,
} from './testing/recovery-fixture.js';
import type { RecoveryFixture } from './testing/recovery-fixture.js';
import type { VirtualClock } from './testing/virtual-clock.js';
import type { Transport } from './transport.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | undefined | null): T {
  if (item === undefined || item === null) throw new Error('Missing recovery fixture item');
  return item;
}

async function journalAtReady(
  fixture: RecoveryFixture,
  seat: Seat,
): Promise<MemoryProtocolJournal> {
  const journal = new MemoryProtocolJournal();
  let context = fixture.beforeSetup;
  expect(
    await journal.initialize(
      fixture.genesisEntry,
      canonicalEncode(value(createConsensusState(context, seat))),
    ),
  ).toBe(true);
  for (const certified of fixture.deckEntries) {
    const next = advanceRecoveryFixture(context, certified);
    // A certified deck prefix is installed atomically with the next voting height.
    expect(
      // oxlint-disable-next-line no-await-in-loop -- Every journal commit depends on its predecessor.
      await journal.commit(
        certified.entry.seq,
        0,
        certified,
        canonicalEncode(value(createConsensusState(next, seat))),
      ),
    ).toBe(true);
    context = next;
  }
  return journal;
}

function optionsFor(
  fixture: RecoveryFixture,
  seat: Seat,
  transport: Transport,
  clock: VirtualClock,
  journal: MemoryProtocolJournal,
): ReplicatedLogOptions {
  const beacon = createBeaconSecretSource(
    scalarToBytes(BigInt(17 + seat)),
    { ceremonyId: deckCeremonyId(fixture.genesis), seat },
    2,
  );
  const emptyDeckStore: DeckContributionStore = {
    load: async () => null,
    putIfAbsent: async () => false,
  };
  return {
    genesisEntry: fixture.genesisEntry,
    engine: fixture.source.engine,
    policy: fixture.policy,
    seat,
    secretKey: recoveryFixtureKey(fixture, seat),
    transport,
    clock,
    journal,
    cheatCandidateStore: new MemoryCheatCandidateStore(),
    beaconSource: beacon.source,
    beaconContributions: new MemoryBeaconContributionStore(),
    createDeckSource: () => {
      throw new Error('No active deck draw in this fixture');
    },
    deckContributions: emptyDeckStore,
    countProof: () => failure('unused-count', 'No Monopoly is active'),
    countContributionStore: new MemoryCountContributionStore(),
    stealContribution: () => failure('unused-steal', 'No steal is active'),
    stealResponse: () => failure('unused-steal', 'No steal is active'),
    stealDeliveryStore: new MemoryStealDeliveryStore(),
  };
}

async function settle(replicas: readonly ReplicatedLog[], clock: VirtualClock, steps = 30) {
  for (let step = 0; step < steps; step += 1) {
    // oxlint-disable-next-line no-await-in-loop -- Each network batch must finish before advancing virtual time.
    await Promise.all(replicas.map((replica) => replica.flush()));
    clock.advanceBy(1_000);
    // oxlint-disable-next-line no-await-in-loop -- Give queued transport deliveries a turn.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await Promise.all(replicas.map((replica) => replica.flush()));
}

function isBeaconMessage(bytes: Uint8Array): boolean {
  const decoded = decodeProtocolMessage(bytes);
  return decoded.ok && decoded.value.t === 'SYS_CONTRIB';
}

interface SeatZeroGate {
  holdRecovery: boolean;
  syncRequests: number;
  syncResponses: number;
}

function delayedSeatZero(inner: Transport, gate: SeatZeroGate): Transport {
  const withheld = (bytes: Uint8Array) => {
    const decoded = decodeProtocolMessage(bytes);
    return (
      decoded.ok &&
      gate.holdRecovery &&
      ['RECOVERY_SUBMIT', 'PROPOSAL', 'VOTE', 'COMMIT', 'SYNC_RES'].includes(decoded.value.t)
    );
  };
  return {
    self: inner.self,
    peers: () => inner.peers(),
    send: (to, bytes) => {
      const decoded = decodeProtocolMessage(bytes);
      if (decoded.ok && decoded.value.t === 'SYNC_REQ') gate.syncRequests += 1;
      if (!isBeaconMessage(bytes)) inner.send(to, bytes);
    },
    broadcast: (bytes) => {
      const decoded = decodeProtocolMessage(bytes);
      if (decoded.ok && decoded.value.t === 'SYNC_REQ') gate.syncRequests += 1;
      if (!isBeaconMessage(bytes)) inner.broadcast(bytes);
    },
    onMessage: (listener) =>
      inner.onMessage((from, bytes) => {
        if (isBeaconMessage(bytes) || withheld(bytes)) return;
        const decoded = decodeProtocolMessage(bytes);
        if (decoded.ok && decoded.value.t === 'SYNC_RES') gate.syncResponses += 1;
        listener(from, bytes);
      }),
    onPeerChange: (listener) => inner.onPeerChange(listener),
    disconnect: (peer) => inner.disconnect(peer),
  };
}

describe('live certified recovery', () => {
  test('gossips authorization during a frozen beacon and activates under the remaining quorum', async () => {
    const fixture = createRecoveryFixture({ masterBackedBeacon: true });
    const seats = [0, 1, 2, 3] as const;
    const peers = seats.map((seat) => required(fixture.source.identities.get(seat)).peerId);
    const network = createMemnet({ peers });
    const replicas: ReplicatedLog[] = [];
    const journals = new Map<Seat, MemoryProtocolJournal>();
    const retired: Seat[] = [];
    const gate: SeatZeroGate = { holdRecovery: true, syncRequests: 0, syncResponses: 0 };
    try {
      for (const [index, seat] of seats.entries()) {
        // oxlint-disable-next-line no-await-in-loop -- Restores consume independent preloaded journals.
        const journal = await journalAtReady(fixture, seat);
        journals.set(seat, journal);
        const inner = network.transport(required(peers[index]));
        const transport = seat === 0 ? delayedSeatZero(inner, gate) : inner;
        const options = optionsFor(fixture, seat, transport, network.clock, journal);
        replicas.push(
          value(
            // oxlint-disable-next-line no-await-in-loop -- Each restore uses its own prepared journal.
            await ReplicatedLog.restore({
              ...options,
              onStatus: (status) => {
                if (status.kind === 'retired') retired.push(status.seat);
              },
            }),
          ),
        );
      }
      const readySeq = fixture.ready.log.head.seq;
      expect(replicas.every((replica) => replica.getContext().log.head.seq === readySeq)).toBe(
        true,
      );
      const replacement = recoveryFixtureReplacement(77);
      const authorization = signRecoveryFixtureAuthorization(
        fixture,
        recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId),
        replacement.secretKey,
      );
      const authorizationResult = required(replicas[1]).submitRecovery(authorization);
      await settle(replicas, network.clock);
      expect(await authorizationResult).toMatchObject({ ok: true });
      expect(
        replicas.slice(1).every((replica) => replica.getContext().log.head.seq === readySeq + 1),
      ).toBe(true);
      expect(required(replicas[0]).getContext().log.head.seq).toBe(readySeq);
      expect(retired).toEqual([]);
      const afterAuthorization = required(replicas[1]).getContext();
      expect(afterAuthorization.log.crypto?.beacon.active).toEqual(
        fixture.ready.log.crypto?.beacon.active,
      );
      expect(
        afterAuthorization.log.authority?.controllers.find((item) => item.seat === 0)?.status,
      ).toBe('pending-recovery');
      const authorizationEntry = required(required(replicas[1]).getEntries().at(-1)).entry;
      const activation = signRecoveryFixtureActivation(
        fixture,
        afterAuthorization,
        authorizationEntry,
      );
      const activationResult = required(replicas[2]).submitRecovery(activation);
      await settle(replicas, network.clock);
      expect(await activationResult).toMatchObject({ ok: true });
      const survivors = replicas.slice(1);
      const heads = survivors.map((replica) => entryHash(replica.getContext().log.head));
      expect(new Set(heads).size).toBe(1);
      expect(survivors.every((replica) => replica.getContext().membership.epoch === 2)).toBe(true);
      expect(
        survivors.every((replica) => replica.getContext().log.crypto?.beacon.active !== null),
      ).toBe(true);
      expect(
        survivors.every((replica) => replica.getContext().membership.voters.length === 3),
      ).toBe(true);
      expect(required(replicas[0]).getContext().membership.epoch).toBe(0);
      gate.holdRecovery = false;
      await settle(replicas, network.clock);
      expect(gate.syncRequests).toBeGreaterThan(0);
      expect(gate.syncResponses).toBeGreaterThan(0);
      expect(retired).toEqual([0]);
      const removed = required(replicas[0]);
      expect(await removed.submitRecovery(activation)).toMatchObject({
        ok: false,
        error: { code: 'replica-disposed' },
      });
      const retiredJournal = required(journals.get(0));
      const marker = required((await retiredJournal.load())?.safety);
      expect(
        restoreRetiredSafety(
          canonicalDecode(marker.bytes),
          removed.getContext(),
          0,
          required(peers[0]),
        ).ok,
      ).toBe(true);
      expect(
        await ReplicatedLog.restore(
          optionsFor(
            fixture,
            0,
            network.transport(required(peers[0])),
            network.clock,
            retiredJournal,
          ),
        ),
      ).toMatchObject({ ok: false, error: { code: 'replica-retired' } });
    } finally {
      for (const replica of replicas) replica.dispose();
      network.dispose();
    }
  }, 60_000);
});
