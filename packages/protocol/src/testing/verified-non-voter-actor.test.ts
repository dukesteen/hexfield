import { enumerateCommands } from '@cp2p/engine';
import type { Seat } from '@cp2p/engine';
import { canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { describe, expect, test, vi } from 'vitest';
import { entryHash, genesisDigest, signEntry } from '../genesis.js';
import { MasterRevealCoordinator } from '../master-reveal.js';
import { MemoryProtocolJournal } from '../journal.js';
import { decodeProtocolMessage } from '../messages.js';
import type { ProtocolMessage } from '../messages.js';
import { P2PSession } from '../p2p-session.js';
import { proposerFor } from '../proposal.js';
import type { CertifiedEntry } from '../proposal.js';
import { replayCertifiedPrefix } from '../replay.js';
import { signVote } from '../votes.js';
import { createMemnet } from './memnet.js';
import { VirtualClock } from './virtual-clock.js';
import { createVerifiedNetworkFixture } from './verified-network-fixture.js';
import { createVerifiedNonVoterActor } from './verified-non-voter-actor.js';
import type { VerifiedNonVoterActor } from './verified-non-voter-actor.js';

async function submitAndPump(
  session: P2PSession,
  seat: Seat,
  command: Parameters<P2PSession['submit']>[1],
  sessions: ReadonlyMap<Seat, P2PSession>,
  clock: VirtualClock,
): Promise<void> {
  const outcome: { result: Awaited<ReturnType<P2PSession['submit']>> | null } = { result: null };
  const pending = session.submit(seat, command, {
    expectedRevision: session.getCommittedHead().seq,
  });
  void pending.then((value) => {
    outcome.result = value;
    return value;
  });
  // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- Promise completion updates the captured result asynchronously.
  for (let step = 0; step < 80 && outcome.result === null; step += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Flush replicas between virtual-clock delivery steps.
    await Promise.all([...sessions.values()].map((replica) => replica.flush()));
    clock.advanceBy(0);
  }
  const result = outcome.result;
  if (result === null)
    throw new Error('Signed command did not finish within the virtual delivery bound');
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  await pending;
}

function sameCommand(left: unknown, right: unknown): boolean {
  const a = canonicalEncode(left);
  const b = canonicalEncode(right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function copyPrefix(entries: readonly CertifiedEntry[]): CertifiedEntry[] {
  return entries.map(({ entry, certificate }) => ({
    entry: { ...entry },
    certificate: certificate.map((vote) => ({ ...vote, body: { ...vote.body } })),
  }));
}

describe('VerifiedNonVoterActor', () => {
  test('cleans up its driver when transport subscription throws', () => {
    const fixture = createVerifiedNetworkFixture({ seed: 731, gameIndex: 2, vpTarget: 3 });
    const clock = new VirtualClock();
    const owner = fixture.identities.get(0);
    if (!owner) throw new Error('Missing actor identity');
    const options = fixture.sessionOptions(0);
    const disposed = vi.fn<() => void>();
    try {
      const created = createVerifiedNonVoterActor({
        seat: 0,
        identity: owner,
        clock,
        sessionOptions: {
          ...options,
          createDriver: (...args) => {
            const driver = options.createDriver(...args);
            const dispose = driver.dispose?.bind(driver);
            driver.dispose = () => {
              disposed();
              dispose?.();
            };
            return driver;
          },
        },
        transport: {
          self: owner.peerId,
          peers: () => [],
          disconnect: () => undefined,
          broadcast: () => undefined,
          send: () => undefined,
          onPeerChange: () => () => undefined,
          onMessage: () => {
            throw new Error('Subscription unavailable');
          },
        },
      });
      expect(created.ok).toBe(false);
      expect(disposed).toHaveBeenCalledOnce();
      expect(owner.secretKey.some((byte) => byte !== 0)).toBe(true);
    } finally {
      fixture.dispose();
    }
  }, 30_000);

  test('replays a certified exclusion and command with three non-offender signers', async () => {
    const fixture = createVerifiedNetworkFixture({ seed: 731, gameIndex: 2, vpTarget: 3 });
    const clock = new VirtualClock();
    const peers = [...fixture.identities.values()].map(({ peerId }) => peerId);
    const network = createMemnet({ peers, clock });
    const outgoingByPeer = new Map<string, ProtocolMessage[]>();
    const transports = new Map<string, ReturnType<typeof network.transport>>();
    for (const peer of peers) {
      const raw = network.transport(peer);
      const captured: ProtocolMessage[] = [];
      outgoingByPeer.set(peer, captured);
      transports.set(peer, {
        self: raw.self,
        peers: () => raw.peers(),
        onMessage: (listener: Parameters<typeof raw.onMessage>[0]) => raw.onMessage(listener),
        onPeerChange: (listener: Parameters<typeof raw.onPeerChange>[0]) =>
          raw.onPeerChange(listener),
        disconnect: (target: string) => raw.disconnect(target),
        broadcast(bytes: Uint8Array) {
          const decoded = decodeProtocolMessage(bytes);
          if (decoded.ok) captured.push(decoded.value);
          raw.broadcast(bytes);
        },
        send(target: string, bytes: Uint8Array) {
          const decoded = decodeProtocolMessage(bytes);
          if (decoded.ok) captured.push(decoded.value);
          raw.send(target, bytes);
        },
      });
    }

    const sessions = new Map<Seat, P2PSession>();
    let actor: VerifiedNonVoterActor | null = null;
    let actorMessages: ProtocolMessage[] = [];
    let actorSeat: Seat | null = null;
    let actorHistory: CertifiedEntry[] | null = null;
    let publishedOwnedContribution = false;
    try {
      for (const seat of [0, 1, 2, 3] as const) {
        const owner = fixture.identities.get(seat);
        const transport = transports.get(owner?.peerId ?? '');
        if (!owner || !transport) throw new Error(`Fixture seat ${seat} identity is missing`);
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each session binds a distinct identity and journal.
        const opened = await P2PSession.create({
          ...fixture.sessionOptions(seat),
          seat,
          secretKey: owner.secretKey,
          transport,
          clock,
          journal: new MemoryProtocolJournal(),
        });
        if (!opened.ok) throw new Error(`${opened.error.code}: ${opened.error.message}`);
        sessions.set(seat, opened.value);
      }

      for (let pass = 0; pass < 120; pass += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Flush all real replicas before advancing simulated time.
        await Promise.all([...sessions.values()].map((session) => session.flush()));
        clock.advanceBy(0);
        const source = sessions.get(0);
        if (source) {
          const history = source.exportSave();
          const replayed = replayCertifiedPrefix(
            history.genesis,
            history.entries,
            fixture.engine,
            fixture.policy,
          );
          if (!replayed.ok) throw new Error(`${replayed.error.code}: ${replayed.error.message}`);
          if (
            replayed.value.context.log.crypto?.beacon.active &&
            replayed.value.context.log.crypto.decks.decks.every(
              (deck) => deck.nextPass === deck.commitment.passHashes.length,
            )
          ) {
            const seat: Seat = 0;
            const owner = fixture.identities.get(seat);
            const transport = transports.get(owner?.peerId ?? '');
            if (!owner || !transport) throw new Error(`Fixture actor seat ${seat} is unavailable`);
            actorSeat = seat;
            actorHistory = copyPrefix(history.entries);
            const rawActorTransport = network.transport(owner.peerId);
            actorMessages = [];
            const created = createVerifiedNonVoterActor({
              seat,
              identity: owner,
              sessionOptions: fixture.sessionOptions(seat),
              transport: {
                self: rawActorTransport.self,
                peers: () => rawActorTransport.peers(),
                onMessage: (listener) => rawActorTransport.onMessage(listener),
                onPeerChange: (listener) => rawActorTransport.onPeerChange(listener),
                disconnect: (target) => rawActorTransport.disconnect(target),
                broadcast(bytes) {
                  const decoded = decodeProtocolMessage(bytes);
                  if (decoded.ok) actorMessages.push(decoded.value);
                  rawActorTransport.broadcast(bytes);
                },
                send(target, bytes) {
                  const decoded = decodeProtocolMessage(bytes);
                  if (decoded.ok) actorMessages.push(decoded.value);
                  rawActorTransport.send(target, bytes);
                },
              },
              clock,
            });
            if (!created.ok) throw new Error(`${created.error.code}: ${created.error.message}`);
            actor = created.value;
            // oxlint-disable-next-line eslint/no-await-in-loop -- Advance only after the selected live certified head is captured.
            const published = await actor.advance(actorHistory);
            if (!published.ok)
              throw new Error(`${published.error.code}: ${published.error.message}`);
            const contributionCount = actorMessages.length;
            // oxlint-disable-next-line eslint/no-await-in-loop -- Duplicate publication at the same virtual time must not enqueue deliveries.
            await actor.publishContributions();
            if (actorMessages.length !== contributionCount)
              throw new Error('Contribution publication flooded the transport');
            const privateCopy = actor.privateState();
            if (!privateCopy) throw new Error('Actor private state is missing');
            privateCopy.hand['alias-test'] = 42;
            if (actor.privateState()?.hand['alias-test'] !== undefined)
              throw new Error('Actor private snapshot was aliased');
            const acceptedHead = actor.head();
            const originalPrefix = copyPrefix(actorHistory);
            const callerMutatedPrefix = copyPrefix(actorHistory);
            const firstCallerEntry = callerMutatedPrefix[0];
            if (!firstCallerEntry) throw new Error('Accepted prefix unexpectedly empty');
            callerMutatedPrefix[0] = {
              ...firstCallerEntry,
              entry: { ...firstCallerEntry.entry, stateHash: 'e'.repeat(64) },
            };
            // oxlint-disable-next-line eslint/no-await-in-loop -- Reject entry forks after retaining the original accepted prefix.
            const forked = await actor.advance(callerMutatedPrefix);
            if (forked.ok || forked.error.code !== 'non-voter-prefix-fork')
              throw new Error('Actor accepted a changed signed entry in its prefix');
            // Different valid quorum subsets may certify the same signed entry;
            // the actor retains its already-validated wrapper for that entry.
            const alternateCertificatePrefix = copyPrefix(actorHistory);
            const firstAccepted = alternateCertificatePrefix[0];
            if (!firstAccepted) throw new Error('Accepted prefix unexpectedly empty');
            const alternateCertificate = ([0, 1, 3] as const).map((voterSeat) => {
              const signer = fixture.identities.get(voterSeat);
              if (!signer) throw new Error(`Fixture voter ${voterSeat} is missing`);
              return signVote(
                {
                  genesisDigest: genesisDigest(fixture.genesis),
                  epoch: 0,
                  seat: voterSeat,
                  seq: firstAccepted.entry.seq,
                  term: firstAccepted.entry.term,
                  phase: 'precommit',
                  valueHash: entryHash(firstAccepted.entry),
                },
                signer.secretKey,
              );
            });
            alternateCertificatePrefix[0] = {
              ...firstAccepted,
              certificate: alternateCertificate,
            };
            // oxlint-disable-next-line eslint/no-await-in-loop -- Accept the same entry under another valid quorum wrapper.
            const alternate = await actor.advance(alternateCertificatePrefix);
            if (!alternate.ok)
              throw new Error(`Actor rejected an equivalent certificate: ${alternate.error.code}`);
            // Mutating the caller's original object after acceptance must not
            // alter the actor's stored prefix.
            const mutatedEntry = callerMutatedPrefix[0];
            if (!mutatedEntry) throw new Error('Mutated caller prefix unexpectedly empty');
            const callerOwned = actorHistory[0];
            if (!callerOwned) throw new Error('Caller prefix unexpectedly empty');
            callerOwned.entry.stateHash = mutatedEntry.entry.stateHash;
            // oxlint-disable-next-line eslint/no-await-in-loop -- Re-submit the original detached prefix after caller mutation.
            const detached = await actor.advance(originalPrefix);
            if (!detached.ok) throw new Error('Caller mutation changed the actor accepted prefix');
            actorHistory = originalPrefix;
            if (actor.head().seq !== acceptedHead.seq || actor.head().hash !== acceptedHead.hash)
              throw new Error('Mutated caller prefix changed the actor head');
            const lastAccepted = actorHistory.at(-1);
            if (!lastAccepted) throw new Error('Actor prefix unexpectedly lacks an entry');
            const changedPrefix = [
              ...actorHistory.slice(0, -1),
              {
                ...lastAccepted,
                entry: { ...lastAccepted.entry, stateHash: 'f'.repeat(64) },
              },
            ];
            // oxlint-disable-next-line eslint/no-await-in-loop -- Test the invalid fork without racing another prefix update.
            const fork = await actor.advance(changedPrefix);
            if (fork.ok || fork.error.code !== 'non-voter-prefix-fork')
              throw new Error('Actor accepted a changed certified prefix');
            if (actor.head().seq !== acceptedHead.seq || actor.head().hash !== acceptedHead.hash)
              throw new Error('Rejected prefix changed the actor head');
            publishedOwnedContribution = actorMessages.some(
              (message) =>
                message.t === 'SYS_CONTRIB' && message.contribution.signed.body.seat === seat,
            );
            if (!publishedOwnedContribution)
              throw new Error('Actor did not publish its owned beacon contribution');
            break;
          }
        }

        for (const [seat, session] of sessions) {
          const pending = session
            .getPending()
            .some((item) => item.kind === 'player' && item.seat === seat);
          if (!pending) continue;
          const privateState = session.getPrivate(seat);
          if (!privateState) continue;
          const command = enumerateCommands(
            fixture.engine,
            session.getState(),
            seat,
            privateState,
            {
              sampleIndex: () => 0,
            },
          )[0];
          if (command)
            // oxlint-disable-next-line eslint/no-await-in-loop -- Drive an admitted command to certification before polling the next action.
            await submitAndPump(session, seat, command, sessions, clock);
        }
      }
      if (!actor || actorSeat === null || !actorHistory)
        throw new Error('Did not reach a verified player turn');
      const nonVoter = actor;

      let submitted: ReturnType<VerifiedNonVoterActor['submit']> extends Promise<infer T>
        ? T | null
        : never = null;
      for (let pass = 0; pass < 160 && !submitted?.ok; pass += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Flush all real replicas before advancing simulated time.
        await Promise.all([...sessions.values()].map((session) => session.flush()));
        clock.advanceBy(0);
        const latestSource = [...sessions.values()].find(
          (session) => session.getCommittedHead().seq >= nonVoter.head().seq,
        );
        const history = latestSource?.exportSave();
        if (!history) throw new Error('Certified source history is unavailable');
        // oxlint-disable-next-line eslint/no-await-in-loop -- Prefix validation completes before the next virtual-clock step.
        const advanced = await nonVoter.advance(history.entries);
        if (!advanced.ok) throw new Error(`${advanced.error.code}: ${advanced.error.message}`);
        const actorSession = sessions.get(actorSeat);
        const actorHasTurn = actorSession
          ?.getPending()
          .some((item) => item.kind === 'player' && item.seat === actorSeat);
        if (!actorHasTurn) {
          for (const [seat, session] of sessions) {
            const pending = session
              .getPending()
              .some((item) => item.kind === 'player' && item.seat === seat);
            const privateState = session.getPrivate(seat);
            if (!pending || !privateState) continue;
            const command = enumerateCommands(
              fixture.engine,
              session.getState(),
              seat,
              privateState,
              { sampleIndex: () => 0 },
            )[0];
            if (command)
              // oxlint-disable-next-line eslint/no-await-in-loop -- Advance the actual game until the tested actor has a player action.
              await submitAndPump(session, seat, command, sessions, clock);
          }
          continue;
        }
        const command = nonVoter.legalCommands().commands[0];
        if (!command) continue;

        const current = replayCertifiedPrefix(
          history.genesis,
          history.entries,
          fixture.engine,
          fixture.policy,
        );
        if (!current.ok) throw new Error(`${current.error.code}: ${current.error.message}`);
        const parent = current.value.context;
        const offender = actorSeat;
        const offenderIdentity = fixture.identities.get(offender);
        if (!offenderIdentity) throw new Error(`Fixture identity ${offender} is missing`);
        const vote = (valueHash: string) =>
          signVote(
            {
              genesisDigest: parent.membership.genesisDigest,
              epoch: parent.membership.epoch,
              seat: offender,
              seq: parent.log.head.seq + 1,
              term: 1,
              phase: 'prevote',
              valueHash,
            },
            offenderIdentity.secretKey,
          );
        let term = 1;
        while (
          proposerFor(parent.log.head.seq + 1, term, parent.membership, parent.excludedProposers)
            .seat === offender
        )
          term += 1;
        const elected = proposerFor(
          parent.log.head.seq + 1,
          term,
          parent.membership,
          parent.excludedProposers,
        );
        const sequencer = fixture.identities.get(elected.seat);
        if (!sequencer) throw new Error(`Fixture proposer ${elected.seat} is missing`);
        const entry = signEntry(
          {
            seq: parent.log.head.seq + 1,
            term,
            prevHash: entryHash(parent.log.head),
            payload: {
              kind: 'control',
              action: 'exclude-proposer',
              offender,
              evidence: {
                kind: 'vote-equivocation',
                first: vote('a'.repeat(64)),
                second: vote('b'.repeat(64)),
              },
            },
            stateHash: parent.log.head.stateHash,
            sequencer: elected.publicKey,
          },
          sequencer.secretKey,
        );
        const certificate = ([1, 2, 3] as const).map((seat) => {
          const signer = fixture.identities.get(seat);
          if (!signer) throw new Error(`Fixture voter ${seat} is missing`);
          return signVote(
            {
              genesisDigest: parent.membership.genesisDigest,
              epoch: parent.membership.epoch,
              seat,
              seq: entry.seq,
              term: entry.term,
              phase: 'precommit',
              valueHash: entryHash(entry),
            },
            signer.secretKey,
          );
        });
        const exclusion: CertifiedEntry = { entry, certificate };
        // oxlint-disable-next-line eslint/no-await-in-loop -- Apply the synthetic certified control before testing its next command.
        const rejected = await nonVoter.advance([...history.entries, exclusion]);
        if (!rejected.ok) throw new Error(`${rejected.error.code}: ${rejected.error.message}`);
        const postExclusionCommand = nonVoter.legalCommands().commands[0];
        if (!postExclusionCommand)
          throw new Error('Actor lost its legal command after proposer exclusion');

        sessions.get(actorSeat)?.dispose();
        sessions.delete(actorSeat);
        // oxlint-disable-next-line eslint/no-await-in-loop -- Command preparation includes an optional proof round-trip.
        const submission = nonVoter.submit(postExclusionCommand, nonVoter.head());
        void submission.then((result) => {
          submitted = result;
          return result;
        });
        // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- Promise settlement updates submitted asynchronously.
        for (let step = 0; step < 100 && submitted === null; step += 1) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Pump the asynchronous actor proof request with its virtual deadline.
          await Promise.all([...sessions.values()].map((session) => session.flush()));
          clock.advanceBy(250);
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- Actor resolves after the virtual proof request deadline.
        submitted = await submission;
        if (!submitted.ok) throw new Error(`${submitted.error.code}: ${submitted.error.message}`);
        if (submitted.ok) {
          const legal = nonVoter.legalCommands().commands;
          const different = legal.find(
            (candidate) => !sameCommand(candidate, postExclusionCommand),
          );
          if (legal.length < 2 || !different)
            throw new Error('Fixture did not provide two distinct legal actions for one parent');
          // oxlint-disable-next-line eslint/no-await-in-loop -- Verify competing command is refused while the first is pending.
          const conflict = await nonVoter.submit(different, nonVoter.head());
          if (conflict.ok || conflict.error.code !== 'non-voter-command-pending')
            throw new Error('Actor accepted a second command at the same parent');
          // oxlint-disable-next-line eslint/no-await-in-loop -- Retry the identical signed command at the same parent.
          const retry = await nonVoter.submit(postExclusionCommand, nonVoter.head());
          if (!retry.ok || retry.value.sig !== submitted.value.sig)
            throw new Error('Actor retry did not reuse its retained signed command');
          const excludedPrefix = [...history.entries, exclusion];
          const excluded = replayCertifiedPrefix(
            history.genesis,
            excludedPrefix,
            fixture.engine,
            fixture.policy,
          );
          if (!excluded.ok) throw new Error(excluded.error.code);
          const after = excluded.value.context;
          const applied = fixture.engine.apply(after.log.state, {
            kind: 'command',
            seat: actorSeat,
            command: submitted.value.body.command,
          });
          if (!applied.ok) throw new Error(applied.error.code);
          const commandProposer = proposerFor(
            after.log.head.seq + 1,
            1,
            after.membership,
            after.excludedProposers,
          );
          const proposerIdentity = fixture.identities.get(commandProposer.seat);
          if (!proposerIdentity) throw new Error('Missing post-exclusion proposer');
          if (commandProposer.seat === actorSeat) throw new Error('Excluded proposer elected');
          const committedCommand = signEntry(
            {
              seq: after.log.head.seq + 1,
              term: 1,
              prevHash: entryHash(after.log.head),
              payload: { kind: 'command', signed: submitted.value },
              stateHash: toHex(hashValue(applied.value.state)),
              sequencer: commandProposer.publicKey,
            },
            proposerIdentity.secretKey,
          );
          const commandCertificate = ([1, 2, 3] as const).map((voterSeat) => {
            const signer = fixture.identities.get(voterSeat);
            if (!signer) throw new Error('Missing non-offender voter');
            return signVote(
              {
                genesisDigest: after.membership.genesisDigest,
                epoch: after.membership.epoch,
                seat: voterSeat,
                seq: committedCommand.seq,
                term: committedCommand.term,
                phase: 'precommit',
                valueHash: entryHash(committedCommand),
              },
              signer.secretKey,
            );
          });
          // oxlint-disable-next-line eslint/no-await-in-loop -- Validate the signed actor command through strict certified replay.
          const certified = await nonVoter.advance([
            ...excludedPrefix,
            { entry: committedCommand, certificate: commandCertificate },
          ]);
          if (!certified.ok) throw new Error(`${certified.error.code}: ${certified.error.message}`);
          if (nonVoter.head().seq !== committedCommand.seq)
            throw new Error('Actor command not applied');
        }
      }
      if (!submitted?.ok) throw new Error('Actor could not submit a legal command after exclusion');
      // The focused fixture validates offline certificates. Live network liveness
      // after exclusion belongs to the scenario-6 simulation acceptance run.
      const exclusionMessage = actorMessages.find((message) => message.t === 'SUBMIT');
      if (!exclusionMessage || exclusionMessage.t !== 'SUBMIT')
        throw new Error('Missing actor command');
      expect(submitted.value.body.headSeq + 1).toBe(nonVoter.head().seq);
      const messages = actorMessages;
      expect(actor?.privateState()?.seat).toBe(actorSeat);
      expect(
        messages.some((message) => message.t === 'SUBMIT' && message.cmd.body.seat === actorSeat),
      ).toBe(true);
      expect(messages.some((message) => ['PROPOSAL', 'VOTE', 'COMMIT'].includes(message.t))).toBe(
        false,
      );
      expect(publishedOwnedContribution).toBe(true);
      // Exercise the actual journal-to-terminal-replay path while the retained
      // prefix is available. It is valid but unfinished, so encoding must succeed.
      const metadataChecks: ReturnType<MasterRevealCoordinator['metadata']>[] = [];
      // oxlint-disable-next-line typescript/unbound-method -- The saved implementation is called with its coordinator receiver.
      const dispose = MasterRevealCoordinator.prototype.dispose;
      const metadataSpy = vi
        .spyOn(MasterRevealCoordinator.prototype, 'dispose')
        .mockImplementation(function (this: MasterRevealCoordinator) {
          metadataChecks.push(this.metadata().finally(() => dispose.call(this)));
        });
      try {
        nonVoter.dispose();
        actor = null;
        const checked = metadataChecks[0];
        if (!checked || metadataChecks.length !== 1)
          throw new Error('Missing actor master journal check');
        const metadata = await checked;
        expect(metadata).toMatchObject({ ok: false, error: { code: 'master-reveal-unfinished' } });
      } finally {
        metadataSpy.mockRestore();
      }
    } finally {
      actor?.dispose();
      for (const session of sessions.values()) session.dispose();
      network.dispose();
      fixture.dispose();
    }
  }, 90_000);
});
