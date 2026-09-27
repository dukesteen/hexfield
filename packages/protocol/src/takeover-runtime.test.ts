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
    // oxlint-disable-next-line no-await-in-loop -- Certified ancestry is sequential.
    expect(
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
  const fixture = createRecoveryFixture({ masterBackedBeacon: true });
  const network = createMemnet({ peers: fixture.genesis.seats.map((seat) => seat.publicKey) });
  const absent = fixture.genesis.seats.find((seat) => seat.seat === 0);
  if (!absent) throw new Error('Missing target');
  network.crash(absent.publicKey);
  const replicas: ReplicatedLog[] = [];
  try {
    for (const seat of [1, 2, 3] as const) {
      const identity = fixture.source.identities.get(seat);
      if (!identity) throw new Error('Missing voter identity');
      const journal = await readyJournal(fixture, seat);
      // oxlint-disable-next-line no-await-in-loop -- Restore uses each independent durable journal.
      replicas.push(
        value(
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
    let eligible = false;
    for (let tick = 0; tick < 120 && !eligible; tick += 1) {
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
