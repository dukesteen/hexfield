import { canonicalEncode } from '@cp2p/codec';
import { scalarToBytes } from '@cp2p/crypto';
import type { Result, Seat } from '@cp2p/engine';
import { expect, test, vi } from 'vitest';
import { createBeaconSecretSource } from './beacon-source.js';
import { MemoryBeaconContributionStore } from './beacon-contributions.js';
import { MemoryCheatCandidateStore } from './cheat-candidates.js';
import { MemoryCountContributionStore } from './count-contributions.js';
import { createConsensusState } from './consensus.js';
import { deckCeremonyId } from './deck-genesis.js';
import { createDeckSecretSource } from './deck-source.js';
import { entryHash, genesisDigest } from './genesis.js';
import { MemoryGenesisConsentStore } from './genesis-outbox.js';
import { createHandSecretSource } from './hand-source.js';
import { MemoryProtocolJournal } from './journal.js';
import { P2PSession } from './p2p-session.js';
import { parseMembershipChange } from './membership-change.js';
import { quorumSize } from './votes.js';
import type { LogEntry } from './types.js';
import type { P2PSessionOptions } from './p2p-session.js';
import { replayCertifiedPrefix } from './replay.js';
import { MemoryStealDeliveryStore } from './steal-contributions.js';
import { createStealSecretSource } from './steal-source.js';
import { createMemnet } from './testing/memnet.js';
import {
  advanceRecoveryFixture,
  createRecoveryFixture,
  recoveryFixtureKey,
} from './testing/recovery-fixture.js';
import { VerifiedSessionDriver } from './verified-session-driver.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
function required<T>(item: T | undefined | null): T {
  if (item === undefined || item === null) throw new Error('Missing automatic takeover fixture');
  return item;
}
function hasChange(entry: LogEntry, kind: string): boolean {
  if (entry.payload.kind !== 'membership') return false;
  const change = parseMembershipChange(entry.payload.change);
  return change.ok && change.value.kind === kind;
}
const master = (owner: Seat) => scalarToBytes(BigInt(17 + owner));

test('production pulse automatically certifies takeover after quorum-qualified signed policy time', async () => {
  const fixture = createRecoveryFixture({
    masterBackedBeacon: true,
    chainLength: 4,
    offlineSeat: null,
    takeoverMode: 'auto',
  });
  const seats = [1, 2, 3] as const;
  const network = createMemnet({
    peers: fixture.genesis.seats.map(({ publicKey }) => publicKey),
  });
  network.crash(required(fixture.genesis.seats[0]).publicKey);
  const sessions = new Map<Seat, P2PSession>();
  const providers: ReturnType<typeof createBeaconSecretSource>[] = [];

  async function pumpUntil(condition: () => boolean, limit = 100): Promise<void> {
    for (let tick = 0; tick < limit; tick += 1) {
      // Each delivery batch must settle before the next virtual-time tick.
      // oxlint-disable-next-line no-await-in-loop
      await Promise.all([...sessions.values()].map((session) => session.flush()));
      if (condition()) return;
      network.clock.advanceBy(250);
      // oxlint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(
      `Recovery did not converge: ${JSON.stringify(
        [...sessions].map(([seat, session]) => ({
          seat,
          head: session.getCommittedHead(),
          status: session.getProtocolStatus(),
        })),
      )}`,
    );
  }

  try {
    for (const seat of seats) {
      const journal = new MemoryProtocolJournal();
      let context = fixture.beforeSetup;
      expect(
        // oxlint-disable-next-line no-await-in-loop -- Preload each independent journal with its certified ancestry.
        await journal.initialize(
          fixture.genesisEntry,
          canonicalEncode(value(createConsensusState(context, seat))),
        ),
      ).toBe(true);
      for (const certified of fixture.deckEntries) {
        const next = advanceRecoveryFixture(context, certified);
        expect(
          // oxlint-disable-next-line no-await-in-loop -- Each durable commit depends on the preceding parent.
          await journal.commit(
            certified.entry.seq,
            0,
            certified,
            canonicalEncode(value(createConsensusState(next, seat))),
          ),
        ).toBe(true);
        context = next;
      }
      const store = new MemoryGenesisConsentStore();
      const stealSource = (owner: Seat) =>
        createStealSecretSource(
          master(owner),
          fixture.genesis.ceremonyNonce,
          owner,
          required(fixture.genesis.seats.find((item) => item.seat === owner)).publicKey,
        );
      const deckSource = (deckId: string, owner: Seat) =>
        createDeckSecretSource(
          master(owner),
          required(
            fixture.ready.log.crypto?.decks.decks.find(
              (deck) => deck.commitment.definition.deckId === deckId,
            ),
          ).commitment.definition,
          owner,
        );
      const beacon = createBeaconSecretSource(
        master(seat),
        { ceremonyId: deckCeremonyId(fixture.genesis), seat },
        4,
      );
      providers.push(beacon);
      const current: P2PSessionOptions = {
        genesisEntry: fixture.genesisEntry,
        engine: fixture.source.engine,
        policy: fixture.policy,
        seat,
        secretKey: recoveryFixtureKey(fixture, seat),
        transport: network.transport(required(fixture.source.identities.get(seat)).peerId),
        clock: network.clock,
        journal,
        cheatCandidateStore: new MemoryCheatCandidateStore(),
        beaconSource: beacon.source,
        beaconContributions: new MemoryBeaconContributionStore(),
        createDeckSource: deckSource,
        deckContributions: store,
        countContributionStore: new MemoryCountContributionStore(),
        stealDeliveryStore: new MemoryStealDeliveryStore(),
        recoveryStore: store,
        recoveryParticipant: {
          store,
          privateEntropy: () => new Uint8Array(32).fill(100 + seat),
          encryptionSecret: () => {
            const source = stealSource(seat);
            try {
              return source.encryptionSecret();
            } finally {
              source.dispose();
            }
          },
        },
        createDriver: (engine, genesis, _clock, owned) =>
          new VerifiedSessionDriver(
            engine,
            genesis,
            owned,
            deckSource,
            (owner) => createHandSecretSource(master(owner), genesisDigest(genesis), owner),
            stealSource,
          ),
        botDelayMs: 100,
        decideBot: () => null,
      };
      // oxlint-disable-next-line no-await-in-loop -- Each restored session keeps its own durable safety record.
      sessions.set(seat, value(await P2PSession.restore(current)));
    }

    expect(fixture.genesis.takeover).toEqual({ mode: 'auto', afterSeconds: 120 });
    const host = required(sessions.get(1));
    const automaticRequest = vi.spyOn(host, 'requestTakeover');
    const manualApprovals = [...sessions.values()].map((session) =>
      vi.spyOn(session, 'approveRecoveryAuthorization'),
    );
    await pumpUntil(() =>
      [...sessions.values()].every((session) =>
        session.exportSave().entries.some(({ entry }) => hasChange(entry, 'seat-offline')),
      ),
    );
    expect(automaticRequest).not.toHaveBeenCalled();
    const offline = required(
      host.exportSave().entries.find(({ entry }) => hasChange(entry, 'seat-offline')),
    );
    expect(
      offline.certificate.map((vote) => vote.body.seat).toSorted((left, right) => left - right),
    ).toEqual([1, 2, 3]);

    const hostPeer = required(fixture.source.identities.get(1)).peerId;
    const thirdPeer = required(fixture.source.identities.get(3)).peerId;
    network.disconnect(hostPeer, thirdPeer);
    await Promise.all([...sessions.values()].map((session) => session.flush()));
    network.clock.advanceBy(120_000);
    await Promise.all([...sessions.values()].map((session) => session.flush()));
    expect(automaticRequest).not.toHaveBeenCalled();
    expect(host.getState().seats.find(({ seat }) => seat === 0)?.status).not.toBe('bot');
    network.connect(hostPeer, thirdPeer);
    await Promise.all([...sessions.values()].map((session) => session.flush()));
    for (let second = 0; second < 90; second += 1) {
      network.clock.advanceBy(1_000);
      // oxlint-disable-next-line no-await-in-loop -- Settle each production pulse before advancing observed time.
      await Promise.all([...sessions.values()].map((session) => session.flush()));
    }
    expect(automaticRequest).not.toHaveBeenCalled();
    expect(host.getState().seats.find(({ seat }) => seat === 0)?.status).not.toBe('bot');
    await pumpUntil(
      () =>
        [...sessions.values()].every(
          (session) => session.getState().seats.find(({ seat }) => seat === 0)?.status === 'bot',
        ),
      200,
    );
    expect(automaticRequest).toHaveBeenCalledTimes(1);
    expect(automaticRequest).toHaveBeenCalledWith(0, 'easy');
    for (const approval of manualApprovals) expect(approval).not.toHaveBeenCalled();
    const history = host.exportSave();
    const authorization = required(
      history.entries.find(({ entry }) => hasChange(entry, 'recovery-authorize')),
    );
    const activation = required(
      history.entries.find(({ entry }) => hasChange(entry, 'recovery-activate')),
    );
    expect(authorization.entry.seq).toBeGreaterThan(offline.entry.seq);
    expect(activation.entry.seq).toBeGreaterThan(authorization.entry.seq);
    expect(
      authorization.certificate
        .map((vote) => vote.body.seat)
        .toSorted((left, right) => left - right),
    ).toEqual([1, 2, 3]);
    expect(
      activation.certificate.map((vote) => vote.body.seat).toSorted((left, right) => left - right),
    ).toEqual([1, 2, 3]);
    const rebuilt = value(
      replayCertifiedPrefix(
        history.genesis,
        history.entries,
        fixture.source.engine,
        fixture.policy,
      ),
    );
    expect(rebuilt.context.membership.epoch).toBe(2);
    expect(quorumSize(rebuilt.context.membership.voters.length)).toBe(3);
    expect(rebuilt.context.membership.voters.map(({ seat }) => seat)).toEqual([1, 2, 3]);
    const head = host.getCommittedHead();
    expect(head.seq).toBeGreaterThanOrEqual(activation.entry.seq);
    expect(entryHash(required(history.entries.at(-1)).entry)).toBe(head.hash);
    await pumpUntil(() =>
      [...sessions.values()].every((session) => session.getCommittedHead().hash === head.hash),
    );
    expect(host.getPrivate(0)).not.toBeNull();
    expect(required(sessions.get(2)).getPrivate(0)).toBeNull();
    expect(required(sessions.get(3)).getPrivate(0)).toBeNull();
    // oxlint-disable-next-line no-console -- Archive public signed refs from this production scheduler trace.
    console.log(
      'AUTOMATIC_TAKEOVER_TRACE',
      JSON.stringify({
        signedPolicy: fixture.genesis.takeover,
        virtualTimeMs: network.clock.now(),
        offline: { seq: offline.entry.seq, hash: entryHash(offline.entry) },
        authorization: { seq: authorization.entry.seq, hash: entryHash(authorization.entry) },
        activation: { seq: activation.entry.seq, hash: entryHash(activation.entry) },
        head,
        originalQuorum: quorumSize(rebuilt.context.membership.voters.length),
        voters: rebuilt.context.membership.voters.map(({ seat }) => seat),
        automaticCalls: automaticRequest.mock.calls,
        manualApprovalCalls: manualApprovals.map((spy) => spy.mock.calls.length),
      }),
    );
  } finally {
    vi.restoreAllMocks();
    for (const session of sessions.values()) session.dispose();
    for (const provider of providers) provider.dispose();
    network.dispose();
  }
}, 60_000);
