import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import {
  G,
  encodePoint,
  identityFromSecret,
  scalarToBytes,
  scalePoint,
  signObject,
} from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import { beforeAll, describe, expect, test } from 'vitest';
import { resolveArtifactSigner } from './authority.js';
import { createBeaconSecretSource } from './beacon-source.js';
import { BeaconInbox } from './beacon-inbox.js';
import {
  MemoryBeaconContributionStore,
  prepareBeaconContribution,
} from './beacon-contributions.js';
import { MemoryCheatCandidateStore } from './cheat-candidates.js';
import { MemoryCountContributionStore } from './count-contributions.js';
import { createConsensusState } from './consensus.js';
import { deckCeremonyId } from './deck-genesis.js';
import { createDeckSecretSource } from './deck-source.js';
import { createHandSecretSource } from './hand-source.js';
import type { DeckContributionStore } from './deck-outbox.js';
import { entryHash, genesisDigest } from './genesis.js';
import { MemoryGenesisConsentStore } from './genesis-outbox.js';
import { MemoryProtocolJournal } from './journal.js';
import { decodeProtocolMessage, encodeProtocolMessage } from './messages.js';
import { proposerFor, signProposal } from './proposal.js';
import { previewRecoveryAuthorization } from './recovery-facade.js';
import { ReplicatedLog } from './replicated-log.js';
import { P2PSession } from './p2p-session.js';
import { VerifiedSessionDriver } from './verified-session-driver.js';
import type { ReplicatedLogOptions } from './replicated-log.js';
import {
  RECOVERY_CHECK_DOMAIN,
  RECOVERY_READINESS_DOMAIN,
  RECOVERY_VOID_DOMAIN,
  recoveryChangeSchema,
  recoveryCheckDigest,
} from './recovery-membership.js';
import { restoreRetiredSafety } from './retired-safety.js';
import { MemoryStealDeliveryStore } from './steal-contributions.js';
import { createStealSecretSource } from './steal-source.js';
import { createMemnet } from './testing/memnet.js';
import {
  advanceRecoveryFixture,
  certifyRecoveryFixtureFirstBeacon,
  certifyRecoveryFixtureEntry,
  createRecoveryFixture,
  recoveryFixtureKey,
  recoveryFixtureReadiness,
  recoveryFixtureReplacement,
  signRecoveryFixtureActivation,
  signRecoveryFixtureAuthorization,
  signRecoveryFixtureEntry,
} from './testing/recovery-fixture.js';
import type { RecoveryFixture } from './testing/recovery-fixture.js';
import type { VirtualClock } from './testing/virtual-clock.js';
import type { Transport } from './transport.js';
import type { ProposalContext } from './proposal.js';
import { parseCanonical } from './validation.js';
import {
  TRANSFER_DESTINATION_CHECK_DOMAIN,
  TRANSFER_DEVICE_DOMAIN,
  TRANSFER_GAME_KEY_DOMAIN,
  TRANSFER_OWNER_GAME_DOMAIN,
  transferCheckDigest,
  transferEntryRef,
} from './transfer-readiness.js';
import type {
  SeatTransferAuthorization,
  SeatTransferAuthorizationStatement,
} from './transfer-types.js';

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

function encryptionSecret(fixture: RecoveryFixture, seat: Seat): bigint {
  const original = required(fixture.genesis.seats.find((item) => item.seat === seat));
  const source = createStealSecretSource(
    scalarToBytes(BigInt(17 + seat)),
    fixture.genesis.ceremonyNonce,
    seat,
    original.publicKey,
  );
  try {
    return source.encryptionSecret();
  } finally {
    source.dispose();
  }
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
      ['MEMBERSHIP_SUBMIT', 'PROPOSAL', 'VOTE', 'COMMIT', 'SYNC_RES'].includes(decoded.value.t)
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
  let fixture: RecoveryFixture;
  beforeAll(() => {
    fixture = createRecoveryFixture({ masterBackedBeacon: true });
  }, 30_000);

  test('out-of-parent recovery checks never strike an honest current recoverer', async () => {
    const replacement = recoveryFixtureReplacement(89);
    const peers = ([1, 2, 3] as const).map(
      (seat) => required(fixture.source.identities.get(seat)).peerId,
    );
    const receiverPeer = required(peers[0]);
    const senderPeer = required(peers[1]);
    const network = createMemnet({ peers });
    let replica: ReplicatedLog | null = null;
    try {
      const change = signRecoveryFixtureAuthorization(
        fixture,
        recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId),
        replacement.secretKey,
      );
      const entry = signRecoveryFixtureEntry(
        fixture,
        fixture.ready,
        { kind: 'membership', change },
        fixture.ready.log.head.stateHash,
      );
      const certified = certifyRecoveryFixtureEntry(fixture, fixture.ready, entry, [1, 2, 3]);
      const authorized = advanceRecoveryFixture(fixture.ready, certified);
      const journal = await journalAtReady(fixture, 1);
      expect(
        await journal.commit(
          certified.entry.seq,
          0,
          certified,
          canonicalEncode(value(createConsensusState(authorized, 1))),
        ),
      ).toBe(true);
      const inner = network.transport(receiverPeer);
      let disconnected = 0;
      const transport: Transport = {
        self: inner.self,
        peers: () => inner.peers(),
        send: (to, bytes) => inner.send(to, bytes),
        broadcast: (bytes) => inner.broadcast(bytes),
        onMessage: (listener) => inner.onMessage(listener),
        onPeerChange: (listener) => inner.onPeerChange(listener),
        disconnect: (peer) => {
          disconnected += 1;
          inner.disconnect(peer);
        },
      };
      replica = value(
        await ReplicatedLog.restore({
          ...optionsFor(fixture, 1, transport, network.clock, journal),
          recoveryParticipant: {
            encryptionSecret: () => encryptionSecret(fixture, 1),
            privateEntropy: () => new Uint8Array(32).fill(91),
            store: new MemoryGenesisConsentStore(),
          },
        }),
      );
      const authorization = required(authorized.log.recovery?.pending);
      const digest = genesisDigest(fixture.genesis);
      const sender = network.transport(senderPeer);
      for (let offset = 1; offset <= 6; offset += 1) {
        const parent = {
          seq: authorized.log.head.seq + offset,
          hash: entryHash(authorized.log.head),
        };
        const activation = {
          genesisDigest: digest,
          parent,
          nextEpoch: required(authorized.log.authority).epoch + 1,
          authorization,
          checkDigest: recoveryCheckDigest(authorized.log, authorization),
        };
        const voided = {
          genesisDigest: digest,
          parent,
          authorization,
          dealerSeat: 0 as const,
          reason: 'master-beacon-tip' as const,
        };
        sender.send(
          receiverPeer,
          value(
            encodeProtocolMessage({
              t: 'RECOVERY_CHECK',
              genesisDigest: digest,
              check: {
                statement: activation,
                check: {
                  seat: 2,
                  sig: signObject(
                    RECOVERY_CHECK_DOMAIN,
                    activation,
                    recoveryFixtureKey(fixture, 2),
                  ),
                },
              },
            }),
          ),
        );
        sender.send(
          receiverPeer,
          value(
            encodeProtocolMessage({
              t: 'RECOVERY_VOID_CHECK',
              genesisDigest: digest,
              check: {
                statement: voided,
                check: {
                  seat: 2,
                  sig: signObject(RECOVERY_VOID_DOMAIN, voided, recoveryFixtureKey(fixture, 2)),
                },
              },
            }),
          ),
        );
      }
      network.clock.advanceBy(1_000);
      await replica.flush();
      expect(disconnected).toBe(0);
    } finally {
      replica?.dispose();
      replacement.secretKey.fill(0);
      network.dispose();
    }
  }, 30_000);

  test('does not durably vote for a valid takeover until this voter approves that parent', async () => {
    const seats = [0, 1, 2, 3] as const;
    const peers = seats.map((seat) => required(fixture.source.identities.get(seat)).peerId);
    const network = createMemnet({ peers });
    const elected = proposerFor(
      fixture.ready.log.head.seq + 1,
      1,
      fixture.ready.membership,
      fixture.ready.excludedProposers,
    );
    const targetSeat = elected.seat === 2 ? 3 : 2;
    const journal = await journalAtReady(fixture, targetSeat);
    const observed: unknown[] = [];
    const target = value(
      await ReplicatedLog.restore({
        ...optionsFor(
          fixture,
          targetSeat,
          network.transport(required(peers[targetSeat])),
          network.clock,
          journal,
        ),
        onRecoveryCandidate: (candidate) => observed.push(candidate),
      }),
    );
    try {
      const replacement = recoveryFixtureReplacement(81);
      const authorization = signRecoveryFixtureAuthorization(
        fixture,
        recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId),
        replacement.secretKey,
      );
      const entry = signRecoveryFixtureEntry(
        fixture,
        fixture.ready,
        { kind: 'membership', change: authorization },
        fixture.ready.log.head.stateHash,
      );
      const proposal = signProposal(
        {
          genesisDigest: fixture.ready.membership.genesisDigest,
          epoch: fixture.ready.membership.epoch,
          entry,
          validRound: null,
          prevotes: [],
        },
        recoveryFixtureKey(fixture, elected.seat),
      );
      const height = entry.seq;
      const safetyBefore = await journal.loadSafety(height);
      network
        .transport(elected.publicKey)
        .send(
          required(peers[targetSeat]),
          value(encodeProtocolMessage({ t: 'PROPOSAL', proposal })),
        );
      network.clock.advanceBy(1);
      await target.flush();
      const refused = required(await journal.loadSafety(height));
      expect(refused.revision).toBe((safetyBefore?.revision ?? 0) + 1);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Inspect serialized consensus safety in this focused regression.
      const refusedState = canonicalDecode(refused.bytes) as {
        votes: { body: { seat: Seat; valueHash: string | null } }[];
      };
      expect(refusedState.votes.filter((vote) => vote.body.seat === targetSeat)).toMatchObject([
        { body: { valueHash: null } },
      ]);
      expect(target.getRecoveryCandidate()?.change).toEqual(authorization);
      expect(observed.at(-1)).toMatchObject({ departedSeat: 0, canApprove: true });
      const clearedBeforeQueue = target.approveRecoveryAuthorization(authorization);
      target.clearRecoveryApproval();
      expect(await clearedBeforeQueue).toMatchObject({
        ok: false,
        error: { code: 'recovery-approval-cleared' },
      });
      expect(await target.approveRecoveryAuthorization(authorization)).toMatchObject({ ok: true });
      expect(target.getContext().log.head.seq).toBe(fixture.ready.log.head.seq);
      target.clearRecoveryApproval();
      expect(target.getRecoveryCandidate()).not.toBeNull();
    } finally {
      target.dispose();
      network.dispose();
    }
  }, 30_000);

  test('rejects stale approval parents and a second takeover with only two survivors', () => {
    const replacement = recoveryFixtureReplacement(82);
    const authorization = signRecoveryFixtureAuthorization(
      fixture,
      recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId),
      replacement.secretKey,
    );
    const first = value(previewRecoveryAuthorization(authorization, fixture.ready.log, 1));
    expect(first.preview.canApprove).toBe(true);
    const otherHostStatement = { ...authorization.statement, hostSeat: 2 as const };
    const otherHost = {
      ...authorization,
      statement: otherHostStatement,
      hostSig: signObject(
        RECOVERY_READINESS_DOMAIN,
        otherHostStatement,
        recoveryFixtureKey(fixture, 2),
      ),
      keySigs: [
        {
          seat: 0 as const,
          sig: signObject(RECOVERY_READINESS_DOMAIN, otherHostStatement, replacement.secretKey),
        },
      ],
    };
    expect(previewRecoveryAuthorization(otherHost, fixture.ready.log, 2)).toMatchObject({
      ok: false,
      error: { code: 'recovery-preview-host' },
    });
    expect(
      value(previewRecoveryAuthorization(authorization, fixture.ready.log, 0)).preview.canApprove,
    ).toBe(false);
    const stale = {
      ...authorization,
      statement: {
        ...authorization.statement,
        parent: { seq: 0, hash: entryHash(fixture.genesisEntry) },
      },
    };
    expect(previewRecoveryAuthorization(stale, fixture.ready.log, 1)).toMatchObject({
      ok: false,
      error: { code: 'recovery-parent' },
    });
    const authorizationEntry = signRecoveryFixtureEntry(
      fixture,
      fixture.ready,
      { kind: 'membership', change: authorization },
      fixture.ready.log.head.stateHash,
    );
    const afterAuthorization = advanceRecoveryFixture(
      fixture.ready,
      certifyRecoveryFixtureEntry(fixture, fixture.ready, authorizationEntry, [0, 1, 2]),
    );
    const amendedReplacement = recoveryFixtureReplacement(85);
    const amendment = signRecoveryFixtureAuthorization(
      fixture,
      recoveryFixtureReadiness(fixture, afterAuthorization, amendedReplacement.peerId, {
        seq: authorizationEntry.seq,
        hash: entryHash(authorizationEntry),
      }),
      amendedReplacement.secretKey,
    );
    expect(previewRecoveryAuthorization(amendment, afterAuthorization.log, 2)).toMatchObject({
      ok: true,
      value: { preview: { amendment: true, canApprove: true } },
    });
    const activation = signRecoveryFixtureActivation(
      fixture,
      afterAuthorization,
      authorizationEntry,
    );
    const status = value(
      fixture.source.engine.apply(afterAuthorization.log.state, {
        kind: 'system',
        type: 'SEAT_STATUS',
        seat: 0,
        status: 'bot',
      }),
    );
    const activationEntry = signRecoveryFixtureEntry(
      fixture,
      afterAuthorization,
      { kind: 'membership', change: activation },
      toHex(hashValue(status.state)),
    );
    const afterActivation = advanceRecoveryFixture(
      afterAuthorization,
      certifyRecoveryFixtureEntry(fixture, afterAuthorization, activationEntry, [1, 2, 3]),
    );
    const secondOffline = signRecoveryFixtureEntry(
      fixture,
      afterActivation,
      { kind: 'membership', change: { kind: 'seat-offline', seat: 1 } },
      afterActivation.log.head.stateHash,
    );
    const afterSecondOffline = advanceRecoveryFixture(
      afterActivation,
      certifyRecoveryFixtureEntry(fixture, afterActivation, secondOffline, [1, 2, 3]),
    );
    const nextReplacement = recoveryFixtureReplacement(83);
    const next = {
      ...authorization,
      statement: {
        ...authorization.statement,
        parent: {
          seq: afterSecondOffline.log.head.seq,
          hash: entryHash(afterSecondOffline.log.head),
        },
        nextEpoch: afterSecondOffline.membership.epoch + 1,
        departedSeat: 1,
        hostSeat: 2,
        replacements: [{ seat: 1, publicKey: nextReplacement.peerId }],
        recoverers: [2, 3].map((seat) => ({
          seat,
          publicKey: required(fixture.genesis.seats[seat]).publicKey,
        })),
      },
    };
    expect(previewRecoveryAuthorization(next, afterSecondOffline.log, 2)).toMatchObject({
      ok: false,
      error: { code: 'recovery-quorum' },
    });
  });

  test('a remote voter retains an approved signed submit before any takeover proposal exists', async () => {
    // The certified offline marker shifts round-one proposer to the host. A
    // genuine beacon child keeps this case about approval by another proposer.
    const beaconChild = certifyRecoveryFixtureFirstBeacon(fixture, fixture.ready);
    const remoteFixture = {
      ...fixture,
      deckEntries: [...fixture.deckEntries, beaconChild],
      ready: advanceRecoveryFixture(fixture.ready, beaconChild),
    };
    const seats = [1, 2, 3] as const;
    const peers = seats.map((seat) => required(remoteFixture.source.identities.get(seat)).peerId);
    const network = createMemnet({ peers });
    const firstProposer = proposerFor(
      remoteFixture.ready.log.head.seq + 1,
      1,
      remoteFixture.ready.membership,
      remoteFixture.ready.excludedProposers,
    );
    const hostSeat = 1 as const;
    expect(hostSeat).not.toBe(firstProposer.seat);
    const replicas = new Map<Seat, ReplicatedLog>();
    const proposals: Seat[] = [];
    try {
      for (const [index, seat] of seats.entries()) {
        const inner = network.transport(required(peers[index]));
        const transport: Transport = {
          self: inner.self,
          peers: () => inner.peers(),
          send: (to, bytes) => inner.send(to, bytes),
          broadcast: (bytes) => {
            const decoded = decodeProtocolMessage(bytes);
            if (
              decoded.ok &&
              decoded.value.t === 'PROPOSAL' &&
              decoded.value.proposal.body.entry.payload.kind === 'membership'
            )
              proposals.push(seat);
            inner.broadcast(bytes);
          },
          onMessage: (listener) => inner.onMessage(listener),
          onPeerChange: (listener) => inner.onPeerChange(listener),
          disconnect: (peer) => inner.disconnect(peer),
        };
        // oxlint-disable-next-line no-await-in-loop -- Each voter restores its own durable certified prefix.
        const journal = await journalAtReady(remoteFixture, seat);
        replicas.set(
          seat,
          value(
            // oxlint-disable-next-line no-await-in-loop -- Restores are independent but keep test resource use bounded.
            await ReplicatedLog.restore(
              optionsFor(remoteFixture, seat, transport, network.clock, journal),
            ),
          ),
        );
      }
      await settle([...replicas.values()], network.clock, 120);
      const replacement = recoveryFixtureReplacement(84);
      const statement = {
        ...recoveryFixtureReadiness(remoteFixture, remoteFixture.ready, replacement.peerId),
        hostSeat,
      };
      const authorization = {
        kind: 'recovery-authorize' as const,
        statement,
        hostSig: signObject(
          RECOVERY_READINESS_DOMAIN,
          statement,
          recoveryFixtureKey(remoteFixture, hostSeat),
        ),
        keySigs: [
          { seat: 0, sig: signObject(RECOVERY_READINESS_DOMAIN, statement, replacement.secretKey) },
        ],
      };
      expect(
        await required(replicas.get(hostSeat)).approveRecoveryAuthorization(authorization),
      ).toMatchObject({ ok: true });
      const submitted = required(replicas.get(hostSeat)).submitRecovery(authorization);
      await settle([...replicas.values()], network.clock, 1);
      const candidate = required(replicas.get(2)).getRecoveryCandidate();
      expect(candidate?.change).toEqual(authorization);
      expect(proposals).toEqual([]);
      const approvals = await Promise.all(
        seats
          .filter((seat) => seat !== hostSeat)
          .map((seat) => required(replicas.get(seat)).approveRecoveryAuthorization(authorization)),
      );
      expect(approvals.every((result) => result.ok)).toBe(true);
      const competingKey = recoveryFixtureReplacement(86);
      const competing = signRecoveryFixtureAuthorization(
        remoteFixture,
        recoveryFixtureReadiness(remoteFixture, remoteFixture.ready, competingKey.peerId),
        competingKey.secretKey,
      );
      expect(await required(replicas.get(2)).approveRecoveryAuthorization(competing)).toMatchObject(
        {
          ok: false,
          error: { code: 'recovery-intent-pending' },
        },
      );
      await settle([...replicas.values()], network.clock, 25);
      expect(await submitted).toMatchObject({ ok: true });
      expect(proposals).toContain(firstProposer.seat);
      expect(
        [...replicas.values()].every(
          (replica) => replica.getContext().log.head.seq === remoteFixture.ready.log.head.seq + 1,
        ),
      ).toBe(true);
    } finally {
      for (const replica of replicas.values()) replica.dispose();
      network.dispose();
    }
  }, 30_000);

  test('a returning target cancels the queued host intent and releases its promise', async () => {
    const hostPeer = required(fixture.source.identities.get(1)).peerId;
    const targetPeer = required(fixture.source.identities.get(0)).peerId;
    const network = createMemnet({ peers: [hostPeer, targetPeer] });
    const journal = await journalAtReady(fixture, 1);
    const host = value(
      await ReplicatedLog.restore(
        optionsFor(fixture, 1, network.transport(hostPeer), network.clock, journal),
      ),
    );
    try {
      const replacement = recoveryFixtureReplacement(87);
      const authorization = signRecoveryFixtureAuthorization(
        fixture,
        recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId),
        replacement.secretKey,
      );
      expect(await host.approveRecoveryAuthorization(authorization)).toMatchObject({ ok: true });
      const submitted = host.submitRecovery(authorization);
      await host.flush();
      network.disconnect(targetPeer, hostPeer);
      network.connect(targetPeer, hostPeer);
      await host.flush();
      expect(await submitted).toMatchObject({
        ok: false,
        error: { code: 'recovery-target-returned' },
      });
      expect(host.getRecoveryCandidate()).toBeNull();
      expect(await host.canStartRecoveryRequest()).toMatchObject({ ok: true });
    } finally {
      host.dispose();
      network.dispose();
    }
  }, 30_000);

  test('gossips authorization during a frozen beacon and activates under the remaining quorum', async () => {
    const seats = [0, 1, 2, 3] as const;
    const peers = seats.map((seat) => required(fixture.source.identities.get(seat)).peerId);
    const network = createMemnet({ peers });
    for (const peer of peers.slice(1)) network.disconnect(required(peers[0]), peer);
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
      // The 15-second public marker is already certified in the fixture. Each
      // honest survivor still needs its own restart-conservative 120-second
      // quorum-qualified observation before signing a positive vote.
      network.clock.advanceBy(120_000);
      await Promise.all(replicas.map((replica) => replica.flush()));
      const replacement = recoveryFixtureReplacement(77);
      const authorization = signRecoveryFixtureAuthorization(
        fixture,
        recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId),
        replacement.secretKey,
      );
      const approvals = await Promise.all(
        replicas.slice(1).map((replica) => replica.approveRecoveryAuthorization(authorization)),
      );
      expect(approvals.every((result) => result.ok)).toBe(true);
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
      for (const peer of peers.slice(1)) network.connect(required(peers[0]), peer);
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

  test('exchanges durable releases and checks, then finishes the carried beacon with the replacement key', async () => {
    const seats = [1, 2, 3] as const;
    const peers = seats.map((seat) => required(fixture.source.identities.get(seat)).peerId);
    const network = createMemnet({ peers });
    const replacement = recoveryFixtureReplacement(78);
    const recoveredBeacon = createBeaconSecretSource(
      scalarToBytes(17n),
      { ceremonyId: deckCeremonyId(fixture.genesis), seat: 0 },
      2,
    );
    const replicas: ReplicatedLog[] = [];
    const sent: { from: Seat; type: string; beaconSeat?: Seat }[] = [];
    let activationContext: ProposalContext | null = null;
    try {
      for (const [index, seat] of seats.entries()) {
        // oxlint-disable-next-line no-await-in-loop -- Every replica gets its own certified journal.
        const journal = await journalAtReady(fixture, seat);
        const inner = network.transport(required(peers[index]));
        const transport: Transport = {
          self: inner.self,
          peers: () => inner.peers(),
          send: (to, bytes) => {
            const decoded = decodeProtocolMessage(bytes);
            if (decoded.ok) sent.push({ from: seat, type: decoded.value.t });
            inner.send(to, bytes);
          },
          broadcast: (bytes) => {
            const decoded = decodeProtocolMessage(bytes);
            if (decoded.ok)
              sent.push({
                from: seat,
                type: decoded.value.t,
                ...(decoded.value.t === 'SYS_CONTRIB'
                  ? { beaconSeat: decoded.value.contribution.signed.body.seat }
                  : {}),
              });
            inner.broadcast(bytes);
          },
          onMessage: (listener) => inner.onMessage(listener),
          onPeerChange: (listener) => inner.onPeerChange(listener),
          disconnect: (peer) => inner.disconnect(peer),
        };
        const options = optionsFor(fixture, seat, transport, network.clock, journal);
        replicas.push(
          value(
            // oxlint-disable-next-line no-await-in-loop -- Restore starts one independent live voter.
            await ReplicatedLog.restore({
              ...options,
              recoveryParticipant: {
                encryptionSecret: () => encryptionSecret(fixture, seat),
                privateEntropy: () => new Uint8Array(32).fill(80 + seat),
                store: new MemoryGenesisConsentStore(),
              },
              ...(seat === 1
                ? {
                    onAuthorityChange: async () =>
                      success({
                        keys: new Map([[0, replacement.secretKey.slice()]]),
                        beaconSources: new Map([[0, recoveredBeacon.source]]),
                      }),
                    onCommit: (entry, _previous, next) => {
                      if (
                        entry.entry.payload.kind === 'membership' &&
                        parseCanonical(entry.entry.payload.change, recoveryChangeSchema).ok &&
                        value(parseCanonical(entry.entry.payload.change, recoveryChangeSchema))
                          .kind === 'recovery-activate'
                      )
                        activationContext = next;
                    },
                  }
                : {}),
            }),
          ),
        );
      }
      network.clock.advanceBy(120_000);
      await Promise.all(replicas.map((replica) => replica.flush()));
      const authorization = signRecoveryFixtureAuthorization(
        fixture,
        recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId),
        replacement.secretKey,
      );
      const approvals = await Promise.all(
        replicas.map((replica) => replica.approveRecoveryAuthorization(authorization)),
      );
      expect(approvals.every((result) => result.ok)).toBe(true);
      const submitted = required(replicas[0]).submitRecovery(authorization);
      await settle(replicas, network.clock, 50);
      expect(await submitted).toMatchObject({ ok: true });
      const histories = replicas.map((replica) => replica.getEntries());
      const latest = required(histories[0]);
      expect(
        new Set(replicas.map((replica) => entryHash(replica.getContext().log.head))).size,
      ).toBe(1);
      expect(
        latest.slice(fixture.ready.log.head.seq).map(({ entry }) => entry.payload.kind),
      ).toEqual(['membership', 'membership', 'system']);
      expect(latest.at(-2)?.entry.payload).toMatchObject({
        kind: 'membership',
        change: { kind: 'recovery-activate' },
      });
      expect(latest.at(-1)?.entry.payload).toMatchObject({
        kind: 'system',
        input: { type: 'START_SEAT' },
      });
      expect(sent.filter(({ type }) => type === 'RECOVERY_RELEASE').length).toBeGreaterThanOrEqual(
        6,
      );
      expect(sent.filter(({ type }) => type === 'RECOVERY_CHECK').length).toBeGreaterThanOrEqual(3);
      expect(
        sent.some(
          ({ from, type, beaconSeat }) => from === 1 && type === 'SYS_CONTRIB' && beaconSeat === 0,
        ),
      ).toBe(true);
      const activated = required<ProposalContext>(activationContext);
      const signer = value(
        resolveArtifactSigner(
          activated.log.authority,
          activated.log.genesis,
          required(activated.log.crypto).epoch,
          0,
        ),
      );
      expect(
        await prepareBeaconContribution(
          required(activated.log.crypto),
          0,
          recoveryFixtureKey(fixture, 0),
          recoveredBeacon.source,
          new MemoryBeaconContributionStore(),
          signer,
        ),
      ).toMatchObject({ ok: false });
    } finally {
      for (const replica of replicas) replica.dispose();
      recoveredBeacon.dispose();
      replacement.secretKey.fill(0);
      network.dispose();
    }
  }, 60_000);
});

test('live owner countersigns a recent certified offer after an ordinary beacon child', async () => {
  const fixture = createRecoveryFixture({ masterBackedBeacon: true });
  const seats = [0, 1, 2, 3] as const;
  const initialHead = transferEntryRef(fixture.ready.log.head);
  const reveals = await Promise.all(
    seats.map(async (seat) => {
      const source = createBeaconSecretSource(
        scalarToBytes(BigInt(17 + seat)),
        { ceremonyId: deckCeremonyId(fixture.genesis), seat },
        2,
      );
      try {
        const contribution = required(
          value(
            await prepareBeaconContribution(
              required(fixture.ready.log.crypto),
              seat,
              recoveryFixtureKey(fixture, seat),
              source.source,
              new MemoryBeaconContributionStore(),
            ),
          ),
        );
        if (contribution.kind !== 'beacon-reveal')
          throw new Error('Expected a signed initial beacon reveal');
        return contribution.signed;
      } finally {
        source.dispose();
      }
    }),
  );
  const inbox = new BeaconInbox();
  value(inbox.refresh(fixture.ready.log.crypto, fixture.genesis, fixture.ready.log.authority));
  for (const signed of reveals) value(inbox.remember({ kind: 'beacon-reveal', signed }));
  const payload = required(value(inbox.candidate(fixture.ready.log)));
  if (payload.kind !== 'system') throw new Error('Expected a certified start-seat input');
  const applied = value(fixture.source.engine.apply(fixture.ready.log.state, payload.input));
  const child = signRecoveryFixtureEntry(
    fixture,
    fixture.ready,
    payload,
    toHex(hashValue(applied.state)),
  );
  const certified = certifyRecoveryFixtureEntry(fixture, fixture.ready, child, seats);
  const advanced = advanceRecoveryFixture(fixture.ready, certified);
  const journal = await journalAtReady(fixture, 0);
  expect(
    await journal.commit(
      child.seq,
      0,
      certified,
      canonicalEncode(value(createConsensusState(advanced, 0))),
    ),
  ).toBe(true);
  const ownerKey = required(fixture.source.identities.get(0));
  const network = createMemnet({ peers: [ownerKey.peerId] });
  const device = identityFromSecret(new Uint8Array(32).fill(140));
  const game = identityFromSecret(new Uint8Array(32).fill(141));
  let owner: ReplicatedLog | undefined;
  try {
    owner = value(
      await ReplicatedLog.restore(
        optionsFor(fixture, 0, network.transport(ownerKey.peerId), network.clock, journal),
      ),
    );
    const controller = required(advanced.log.authority?.controllers[0]);
    const statement: SeatTransferAuthorizationStatement = {
      protocol: 'seat-transfer-v1',
      genesisDigest: advanced.membership.genesisDigest,
      anchor: initialHead,
      validUntilSeq: initialHead.seq + 64,
      mode: 'live',
      seat: 0,
      currentController: {
        publicKey: controller.publicKey,
        kind: controller.kind,
        activatedAt: controller.activatedAt,
        hostSeat: controller.hostSeat,
      },
      recovery: null,
      nextEpoch: advanced.membership.epoch + 1,
      destination: {
        devicePeer: device.peerId,
        gamePeer: game.peerId,
        transferEncryptionKey: encodePoint(scalePoint(G, 142n)),
      },
      replacements: [
        {
          seat: 0,
          oldPublicKey: controller.publicKey,
          newPublicKey: game.peerId,
          newHostSeat: 0,
        },
      ],
    };
    const offer = {
      kind: 'transfer-authorize' as const,
      statement,
      destinationDeviceSig: signObject(TRANSFER_DEVICE_DOMAIN, statement, device.secretKey),
      destinationGameSig: signObject(TRANSFER_GAME_KEY_DOMAIN, statement, game.secretKey),
      replacementKeySigs: [],
    };
    const expectedHead = transferEntryRef(advanced.log.head);
    expect(transferEntryRef(owner.getContext().log.head)).toEqual(expectedHead);
    expect(value(await owner.authorizeLiveTransfer(offer, expectedHead)).ownerIntent).toEqual({
      signer: 'current-game',
      sig: signObject(TRANSFER_OWNER_GAME_DOMAIN, statement, ownerKey.secretKey),
    });
    expect(await owner.authorizeLiveTransfer(offer, initialHead)).toMatchObject({
      ok: false,
      error: { code: 'transfer-head' },
    });
    const expired = { ...statement, validUntilSeq: expectedHead.seq };
    expect(
      await owner.authorizeLiveTransfer(
        {
          ...offer,
          statement: expired,
          destinationDeviceSig: signObject(TRANSFER_DEVICE_DOMAIN, expired, device.secretKey),
          destinationGameSig: signObject(TRANSFER_GAME_KEY_DOMAIN, expired, game.secretKey),
        },
        expectedHead,
      ),
    ).toMatchObject({ ok: false, error: { code: 'transfer-anchor' } });
    const wrongController = {
      ...statement,
      currentController: { ...statement.currentController, publicKey: game.peerId },
    };
    expect(
      await owner.authorizeLiveTransfer(
        {
          ...offer,
          statement: wrongController,
          destinationDeviceSig: signObject(
            TRANSFER_DEVICE_DOMAIN,
            wrongController,
            device.secretKey,
          ),
          destinationGameSig: signObject(TRANSFER_GAME_KEY_DOMAIN, wrongController, game.secretKey),
        },
        expectedHead,
      ),
    ).toMatchObject({ ok: false, error: { code: 'transfer-controller' } });
  } finally {
    owner?.dispose();
    device.secretKey.fill(0);
    game.secretKey.fill(0);
    network.dispose();
  }
}, 30_000);

// Exercise the actual gossip/voting path, rather than constructing its certificates.
test('live transfer submission certifies cancellation and replacement, then fences the old signer', async () => {
  const fixture = createRecoveryFixture({ masterBackedBeacon: true });
  const seats = [0, 1, 2, 3] as const;
  const peers = seats.map((seat) => required(fixture.source.identities.get(seat)).peerId);
  const network = createMemnet({ peers });
  const replicas: ReplicatedLog[] = [];
  const journals: MemoryProtocolJournal[] = [];
  const wire: string[] = [];
  const routeUpdates: { seat: Seat; head: number }[] = [];
  const unresolvedAtRouteHook: boolean[] = [];
  let pendingTransferResult: Result<void> | undefined;
  let committingTransfer = false;
  let failRouteHook = false;
  const secrets: Uint8Array[] = [];
  try {
    for (const [index, seat] of seats.entries()) {
      const inner = network.transport(required(peers[index]));
      // Hold the initial beacon so these assertions isolate membership commits.
      const transport: Transport = {
        ...delayedSeatZero(inner, { holdRecovery: false, syncRequests: 0, syncResponses: 0 }),
        broadcast: (bytes) => {
          const decoded = decodeProtocolMessage(bytes);
          if (decoded.ok) wire.push(decoded.value.t);
          if (!isBeaconMessage(bytes)) inner.broadcast(bytes);
        },
      };
      // oxlint-disable-next-line no-await-in-loop -- Keep cryptographic restores bounded on small CI workers.
      const journal = await journalAtReady(fixture, seat);
      journals.push(journal);
      replicas.push(
        value(
          // oxlint-disable-next-line no-await-in-loop -- Each replica owns its durable voting journal.
          await ReplicatedLog.restore({
            ...optionsFor(fixture, seat, transport, network.clock, journal),
            onMembershipCommitted(entries) {
              expect(wire.at(-1)).toBe('COMMIT');
              if (seat === 1 && committingTransfer)
                unresolvedAtRouteHook.push(pendingTransferResult === undefined);
              routeUpdates.push({ seat, head: required(entries.at(-1)).entry.seq });
              if (seat === 1 && failRouteHook)
                return failure('route-test', 'Simulated route installation failure');
              return success(undefined);
            },
          }),
        ),
      );
    }
    const submitter = required(replicas[1]);
    const prepare = (keyByte: number, movingSeat: Seat = 0) => {
      const context = submitter.getContext();
      const controller = required(
        context.log.authority?.controllers.find((item) => item.seat === movingSeat),
      );
      const device = identityFromSecret(new Uint8Array(32).fill(keyByte - 1));
      const game = identityFromSecret(new Uint8Array(32).fill(keyByte));
      secrets.push(device.secretKey, game.secretKey);
      const statement: SeatTransferAuthorizationStatement = {
        protocol: 'seat-transfer-v1',
        genesisDigest: context.membership.genesisDigest,
        anchor: transferEntryRef(context.log.head),
        validUntilSeq: context.log.head.seq + 64,
        mode: 'live',
        seat: movingSeat,
        currentController: {
          publicKey: controller.publicKey,
          kind: controller.kind,
          activatedAt: controller.activatedAt,
          hostSeat: controller.hostSeat,
        },
        recovery: null,
        nextEpoch: context.membership.epoch + 1,
        destination: {
          devicePeer: device.peerId,
          gamePeer: game.peerId,
          transferEncryptionKey: encodePoint(scalePoint(G, BigInt(keyByte + 30))),
        },
        replacements: [
          {
            seat: movingSeat,
            oldPublicKey: controller.publicKey,
            newPublicKey: game.peerId,
            newHostSeat: movingSeat,
          },
        ],
      };
      const change: SeatTransferAuthorization = {
        kind: 'transfer-authorize',
        statement,
        destinationDeviceSig: signObject(TRANSFER_DEVICE_DOMAIN, statement, device.secretKey),
        destinationGameSig: signObject(TRANSFER_GAME_KEY_DOMAIN, statement, game.secretKey),
        replacementKeySigs: [],
        ownerIntent: {
          signer: 'current-game',
          sig: signObject(
            TRANSFER_OWNER_GAME_DOMAIN,
            statement,
            recoveryFixtureKey(fixture, movingSeat),
          ),
        },
      };
      return { change, game };
    };
    const commit = async (change: unknown) => {
      pendingTransferResult = undefined;
      committingTransfer = true;
      let result: Result<void> | undefined;
      const submitted = submitter.submitTransfer(change).then((answer) => {
        result = answer;
        pendingTransferResult = answer;
        return undefined;
      });
      for (let step = 0; step < 30; step++) {
        if (result !== undefined) break;
        // oxlint-disable-next-line no-await-in-loop -- Advance only until this membership decision settles.
        await settle(replicas, network.clock, 1);
      }
      expect(result).toMatchObject({ ok: true });
      await submitted;
      committingTransfer = false;
      await settle(replicas, network.clock, 1);
      const hashes = replicas.map((replica) => entryHash(replica.getContext().log.head));
      expect(new Set(hashes).size).toBe(1);
    };
    const first = prepare(120);
    const offer = {
      kind: first.change.kind,
      statement: first.change.statement,
      destinationDeviceSig: first.change.destinationDeviceSig,
      destinationGameSig: first.change.destinationGameSig,
      replacementKeySigs: first.change.replacementKeySigs,
    };
    const initialHead = transferEntryRef(submitter.getContext().log.head);
    const owner = required(replicas[0]);
    expect(await owner.authorizeLiveTransfer(offer, initialHead)).toEqual({
      ok: true,
      value: first.change,
    });
    expect(
      await owner.authorizeLiveTransfer(offer, { ...initialHead, seq: initialHead.seq - 1 }),
    ).toMatchObject({ ok: false, error: { code: 'transfer-head' } });
    expect(
      await owner.authorizeLiveTransfer(offer, { ...initialHead, hash: '0'.repeat(64) }),
    ).toMatchObject({
      ok: false,
      error: { code: 'transfer-head' },
    });
    expect(
      await owner.authorizeLiveTransfer(
        {
          ...offer,
          statement: { ...offer.statement, anchor: { ...initialHead, seq: initialHead.seq - 1 } },
        },
        initialHead,
      ),
    ).toMatchObject({ ok: false, error: { code: 'transfer-anchor' } });
    expect(
      await owner.authorizeLiveTransfer(
        { ...offer, destinationDeviceSig: first.change.destinationGameSig },
        initialHead,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'transfer-possession' },
    });
    expect(
      await owner.authorizeLiveTransfer(
        { ...offer, destinationGameSig: first.change.destinationDeviceSig },
        initialHead,
      ),
    ).toMatchObject({ ok: false, error: { code: 'transfer-possession' } });
    expect(await required(replicas[1]).authorizeLiveTransfer(offer, initialHead)).toMatchObject({
      ok: false,
      error: { code: 'transfer-owner' },
    });
    expect(
      await owner.authorizeLiveTransfer(
        { ...offer, ownerIntent: first.change.ownerIntent },
        initialHead,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'transfer-offer' },
    });
    expect(
      await owner.authorizeLiveTransfer(
        { ...offer, statement: { ...offer.statement, mode: 'return' } },
        initialHead,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'transfer-offer' },
    });
    expect(await submitter.submitRecovery(first.change)).toMatchObject({ ok: false });
    expect(
      await submitter.submitTransfer({
        ...first.change,
        ownerIntent: { signer: 'current-game', sig: first.change.destinationGameSig },
      }),
    ).toMatchObject({ ok: false, error: { code: 'transfer-owner-intent' } });
    await commit(first.change);
    const authorized = submitter.getContext();
    expect(authorized.membership.voters).toEqual(fixture.ready.membership.voters);
    expect(authorized.log.transfer?.pending).toEqual(transferEntryRef(authorized.log.head));
    expect(
      await owner.authorizeLiveTransfer(
        {
          ...offer,
          statement: { ...offer.statement, anchor: transferEntryRef(authorized.log.head) },
        },
        transferEntryRef(authorized.log.head),
      ),
    ).toMatchObject({ ok: false, error: { code: 'transfer-unavailable' } });
    await commit({
      kind: 'transfer-cancel',
      genesisDigest: authorized.membership.genesisDigest,
      authorization: transferEntryRef(authorized.log.head),
      parent: transferEntryRef(authorized.log.head),
    });
    expect(submitter.getContext().log.transfer?.pending).toBeNull();
    expect(
      await owner.authorizeLiveTransfer(offer, transferEntryRef(owner.getContext().log.head)),
    ).toMatchObject({ ok: false, error: { code: 'transfer-anchor' } });
    expect(await submitter.submitTransfer(first.change)).toMatchObject({
      ok: false,
      error: { code: 'transfer-anchor' },
    });
    const second = prepare(124);
    await commit(second.change);
    const parent = submitter.getContext();
    const authorization = transferEntryRef(parent.log.head);
    const statement = {
      protocol: 'seat-transfer-activation-v1' as const,
      genesisDigest: parent.membership.genesisDigest,
      authorization,
      parent: authorization,
      nextEpoch: second.change.statement.nextEpoch,
      destinationDevice: second.change.statement.destination.devicePeer,
      destinationGame: second.game.peerId,
      replacements: second.change.statement.replacements,
      checkDigest: transferCheckDigest(parent.log, authorization),
    };
    const activation = {
      kind: 'transfer-activate',
      statement,
      destinationCheck: signObject(
        TRANSFER_DESTINATION_CHECK_DOMAIN,
        statement,
        second.game.secretKey,
      ),
      replacementChecks: [],
    };
    await commit(activation);
    expect(unresolvedAtRouteHook).toEqual([true, true, true, true]);
    expect(routeUpdates).toHaveLength(16);
    expect(routeUpdates).toContainEqual({ seat: 0, head: parent.log.head.seq + 1 });
    expect(wire).toContain('MEMBERSHIP_SUBMIT');
    expect(submitter.getContext().membership.epoch).toBe(parent.membership.epoch + 1);
    expect(submitter.getContext().membership.voters[0]?.publicKey).toBe(second.game.peerId);
    expect(submitter.getContext().log.transfer?.routes[0]?.devicePeer).toBe(
      second.change.statement.destination.devicePeer,
    );
    expect(
      await owner.authorizeLiveTransfer(offer, transferEntryRef(submitter.getContext().log.head)),
    ).toMatchObject({
      ok: false,
      error: { code: 'replica-disposed' },
    });
    expect(await submitter.submitTransfer(activation)).toMatchObject({ ok: false });
    const oldJournal = required(journals[0]);
    const stored = required(await oldJournal.load());
    expect(canonicalDecode(stored.safety.bytes)).toMatchObject({
      kind: 'retired-controller',
      version: 1,
    });
    expect(
      await ReplicatedLog.restore(
        optionsFor(fixture, 0, network.transport(required(peers[0])), network.clock, oldJournal),
      ),
    ).toMatchObject({ ok: false, error: { code: 'replica-retired' } });

    // Model a fresh promoted journal: verified public ancestry, fresh safety at
    // every height, and no safety tuple copied from the retiring signer.
    const destinationJournal = await journalAtReady(fixture, 0);
    let destinationContext = fixture.ready;
    for (const certified of submitter.getEntries().slice(fixture.deckEntries.length)) {
      destinationContext = advanceRecoveryFixture(destinationContext, certified);
      expect(
        // oxlint-disable-next-line no-await-in-loop -- Install the exact contiguous certified history.
        await destinationJournal.commit(
          certified.entry.seq,
          0,
          certified,
          canonicalEncode(value(createConsensusState(destinationContext, 0))),
        ),
      ).toBe(true);
    }
    const destinationNetwork = createMemnet({ peers: [second.game.peerId, ...peers.slice(1)] });
    let destination: P2PSession | undefined;
    try {
      const base = optionsFor(
        fixture,
        0,
        destinationNetwork.transport(second.game.peerId),
        destinationNetwork.clock,
        destinationJournal,
      );
      const createDriver = () =>
        new VerifiedSessionDriver(
          fixture.source.engine,
          fixture.genesis,
          [0],
          (deckId, seat) => {
            const definition = required(
              fixture.ready.log.crypto?.decks.decks.find(
                (deck) => deck.commitment.definition.deckId === deckId,
              ),
            ).commitment.definition;
            return createDeckSecretSource(scalarToBytes(17n), definition, seat);
          },
          (seat) =>
            createHandSecretSource(
              scalarToBytes(17n),
              fixture.ready.membership.genesisDigest,
              seat,
            ),
          (seat) =>
            createStealSecretSource(
              scalarToBytes(17n),
              fixture.genesis.ceremonyNonce,
              seat,
              required(fixture.genesis.seats[seat]).publicKey,
            ),
        );
      expect(await P2PSession.restore({ ...base, createDriver })).toMatchObject({
        ok: false,
        error: { code: 'session-key' },
      });
      destination = value(
        await P2PSession.restore({
          ...base,
          secretKey: second.game.secretKey,
          createDriver,
        }),
      );
      expect(destination.exportSave().entries).toEqual(submitter.getEntries());
      expect(destination.getState()).toEqual(submitter.getContext().log.state);
      expect(destination.getPrivate(0)).not.toBeNull();
      expect(destination.getPrivate(1)).toBeNull();
      const nextDevice = identityFromSecret(new Uint8Array(32).fill(135));
      const nextGame = identityFromSecret(new Uint8Array(32).fill(136));
      secrets.push(nextDevice.secretKey, nextGame.secretKey);
      const current = submitter.getContext();
      const controller = required(current.log.authority?.controllers[0]);
      const nextStatement: SeatTransferAuthorizationStatement = {
        protocol: 'seat-transfer-v1',
        genesisDigest: current.membership.genesisDigest,
        anchor: transferEntryRef(current.log.head),
        validUntilSeq: current.log.head.seq + 64,
        mode: 'live',
        seat: 0,
        currentController: {
          publicKey: controller.publicKey,
          kind: controller.kind,
          activatedAt: controller.activatedAt,
          hostSeat: controller.hostSeat,
        },
        recovery: null,
        nextEpoch: current.membership.epoch + 1,
        destination: {
          devicePeer: nextDevice.peerId,
          gamePeer: nextGame.peerId,
          transferEncryptionKey: encodePoint(scalePoint(G, 137n)),
        },
        replacements: [
          {
            seat: 0,
            oldPublicKey: controller.publicKey,
            newPublicKey: nextGame.peerId,
            newHostSeat: 0,
          },
        ],
      };
      const nextOffer = {
        kind: 'transfer-authorize' as const,
        statement: nextStatement,
        destinationDeviceSig: signObject(
          TRANSFER_DEVICE_DOMAIN,
          nextStatement,
          nextDevice.secretKey,
        ),
        destinationGameSig: signObject(TRANSFER_GAME_KEY_DOMAIN, nextStatement, nextGame.secretKey),
        replacementKeySigs: [],
      };
      const signed = value(
        await destination.authorizeLiveTransfer(nextOffer, destination.getCommittedHead()),
      );
      expect(signed.ownerIntent).toEqual({
        signer: 'current-game',
        sig: signObject(TRANSFER_OWNER_GAME_DOMAIN, nextStatement, second.game.secretKey),
      });
      expect(destination.getCommittedHead().seq).toBe(current.log.head.seq);
    } finally {
      destination?.dispose();
      destinationNetwork.dispose();
    }
    const beforeFailure = submitter.getContext().log.head.seq;
    const failedRoute = prepare(130, 1);
    failRouteHook = true;
    let failedResult: Result<void> | undefined;
    const outcome = submitter.submitTransfer(failedRoute.change).then((result) => {
      failedResult = result;
      return result;
    });
    for (let step = 0; step < 30; step += 1) {
      if (failedResult !== undefined) break;
      // oxlint-disable-next-line no-await-in-loop -- Wait for the one certified change and failed route hook.
      await settle(replicas, network.clock, 1);
    }
    expect(failedResult).toBeDefined();
    expect(await outcome).toMatchObject({
      ok: false,
      error: { code: 'replica-outcome-unknown' },
    });
    expect(required(await required(journals[1]).load()).entries.at(-1)?.entry.seq).toBe(
      beforeFailure + 1,
    );
  } finally {
    for (const replica of replicas) replica.dispose();
    for (const key of secrets) key.fill(0);
    network.dispose();
  }
}, 30_000);
