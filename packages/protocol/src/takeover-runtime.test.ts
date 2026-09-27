import { canonicalEncode } from '@cp2p/codec';
import { scalarToBytes } from '@cp2p/crypto';
import { failure } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import { expect, test } from 'vitest';
import { createBeaconSecretSource } from './beacon-source.js';
import { MemoryBeaconContributionStore } from './beacon-contributions.js';
import { MemoryCheatCandidateStore } from './cheat-candidates.js';
import { MemoryCountContributionStore } from './count-contributions.js';
import { createConsensusState } from './consensus.js';
import { deckCeremonyId } from './deck-genesis.js';
import type { DeckContributionStore } from './deck-outbox.js';
import { MemoryProtocolJournal } from './journal.js';
import { ReplicatedLog } from './replicated-log.js';
import type { ReplicatedLogOptions } from './replicated-log.js';
import { MemoryStealDeliveryStore } from './steal-contributions.js';
import { createMemnet } from './testing/memnet.js';
import {
  advanceRecoveryFixture,
  createRecoveryFixture,
  recoveryFixtureKey,
} from './testing/recovery-fixture.js';
import type { RecoveryFixture } from './testing/recovery-fixture.js';
import type { VirtualClock } from './testing/virtual-clock.js';
import type { Transport } from './transport.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

async function readyJournal(fixture: RecoveryFixture, seat: Seat): Promise<MemoryProtocolJournal> {
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
    expect(
      // oxlint-disable-next-line no-await-in-loop -- Certified ancestry is sequential.
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

function replicaOptions(
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
  const deckStore: DeckContributionStore = {
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
      throw new Error('No draw in presence test');
    },
    deckContributions: deckStore,
    countProof: () => failure('unused-count', 'No count is active'),
    countContributionStore: new MemoryCountContributionStore(),
    stealContribution: () => failure('unused-steal', 'No steal is active'),
    stealResponse: () => failure('unused-steal', 'No steal is active'),
    stealDeliveryStore: new MemoryStealDeliveryStore(),
  };
}

test('takeover requires certified offline notice and local quorum-qualified policy time', async () => {
  // Leave the public marker uncertified so this trace exercises live 15-second admission.
  const fixture = createRecoveryFixture({ masterBackedBeacon: true, offlineSeat: null });
  const network = createMemnet({ peers: fixture.genesis.seats.map((seat) => seat.publicKey) });
  const absent = fixture.genesis.seats.find((seat) => seat.seat === 0);
  if (!absent) throw new Error('Missing target');
  network.crash(absent.publicKey);
  const replicas: ReplicatedLog[] = [];
  try {
    for (const seat of [1, 2, 3] as const) {
      const identity = fixture.source.identities.get(seat);
      if (!identity) throw new Error('Missing voter identity');
      // oxlint-disable-next-line no-await-in-loop -- Restore uses each independent durable journal.
      const journal = await readyJournal(fixture, seat);
      replicas.push(
        value(
          // oxlint-disable-next-line no-await-in-loop -- Restore uses each independent durable journal.
          await ReplicatedLog.restore(
            replicaOptions(
              fixture,
              seat,
              network.transport(identity.peerId),
              network.clock,
              journal,
            ),
          ),
        ),
      );
    }
    expect((await replicas[0]?.canRequestTakeover(0))?.ok).toBe(false);
    let certifiedOffline = false;
    for (let tick = 0; tick < 30 && !certifiedOffline; tick += 1) {
      network.clock.advanceBy(1_000);
      // oxlint-disable-next-line no-await-in-loop -- Each pulse and delivery must settle.
      await Promise.all(replicas.map((replica) => replica.flush()));
      certifiedOffline = replicas.every((replica) =>
        replica.getContext().log.recovery?.offline.some((marker) => marker.seat === 0),
      );
    }
    expect(certifiedOffline).toBe(true);
    expect((await replicas[0]?.canRequestTakeover(0))?.ok).toBe(false);

    // Seat 1 has observed the target absent, but temporarily loses seat 3 as
    // well. Its local connected voter count is then below the three-seat quorum.
    const seat1 = fixture.source.identities.get(1);
    const seat3 = fixture.source.identities.get(3);
    if (!seat1 || !seat3) throw new Error('Missing survivor identity');
    network.disconnect(seat1.peerId, seat3.peerId);
    await Promise.all(replicas.map((replica) => replica.flush()));
    network.clock.advanceBy(120_000);
    await Promise.all(replicas.map((replica) => replica.flush()));
    expect((await replicas[0]?.canRequestTakeover(0))?.ok).toBe(false);

    network.connect(seat1.peerId, seat3.peerId);
    await Promise.all(replicas.map((replica) => replica.flush()));
    // The roughly 15 seconds before the outage plus 90 seconds after it are
    // still short of the 120 seconds required. The outage must add no time.
    for (let tick = 0; tick < 90; tick += 1) {
      network.clock.advanceBy(1_000);
      // oxlint-disable-next-line no-await-in-loop -- Observe every quorum interval.
      await Promise.all(replicas.map((replica) => replica.flush()));
    }
    expect((await replicas[0]?.canRequestTakeover(0))?.ok).toBe(false);
    let eligible = false;
    for (let tick = 0; tick < 40 && !eligible; tick += 1) {
      network.clock.advanceBy(1_000);
      // oxlint-disable-next-line no-await-in-loop -- Virtual-time absence must accumulate.
      await Promise.all(replicas.map((replica) => replica.flush()));
      // oxlint-disable-next-line no-await-in-loop -- Eligibility is serialized with received votes.
      eligible = (await replicas[0]?.canRequestTakeover(0))?.ok ?? false;
    }
    expect(eligible).toBe(true);
    const returned = network.restart(absent.publicKey);
    expect(returned.self).toBe(absent.publicKey);
    await Promise.all(replicas.map((replica) => replica.flush()));
    expect((await replicas[0]?.canRequestTakeover(0))?.ok).toBe(false);
  } finally {
    for (const replica of replicas) replica.dispose();
    network.dispose();
  }
}, 60_000);
