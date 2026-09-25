import { hashValue, toHex } from '@cp2p/codec';
import { describe, expect, test } from 'vitest';
import type { CommandShape, Input, SystemInput } from '@cp2p/engine';
import { entryHash, signEntry } from './genesis.js';
import { signCommand, stubEvidence } from './log.js';
import {
  initialProposalContext,
  replayCertifiedPrefix,
  snapshotFromContext,
  verifyReplaySnapshot,
} from './replay.js';
import type { ReplayPolicy } from './replay.js';
import { proposerFor } from './proposal.js';
import type { CertifiedEntry, ProposalContext } from './proposal.js';
import { protocolFixture } from './testing/fixtures.js';
import type { EntryPayload, LogEntry } from './types.js';
import { signVote } from './votes.js';

const policy: ReplayPolicy = { genesis: { allowStub: true }, entry: { allowStub: true } };

function value<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) throw new Error(`Expected success, received ${result.error.code}`);
  return result.value;
}

function record(valueToCheck: unknown): Record<string, unknown> {
  if (typeof valueToCheck !== 'object' || valueToCheck === null || Array.isArray(valueToCheck))
    throw new Error('Expected object fixture');
  return Object.fromEntries(Object.entries(valueToCheck));
}

function certificateFor(
  fixture: ReturnType<typeof protocolFixture>,
  context: ProposalContext,
  entry: LogEntry,
) {
  const valueHash = entryHash(entry);
  return context.membership.voters.map((voter) => {
    const voterIdentity = fixture.identities.find(
      (candidate) => candidate.peerId === voter.publicKey,
    );
    if (!voterIdentity) throw new Error('Expected voter identity');
    return signVote(
      {
        genesisDigest: context.membership.genesisDigest,
        epoch: context.membership.epoch,
        seat: voter.seat,
        seq: entry.seq,
        term: entry.term,
        phase: 'precommit',
        valueHash,
      },
      voterIdentity.secretKey,
    );
  });
}

function nextCertified(
  fixture: ReturnType<typeof protocolFixture>,
  context: ProposalContext,
  input: Input,
  payload: EntryPayload,
): CertifiedEntry {
  const applied = fixture.engine.apply(context.log.state, input);
  if (!applied.ok) throw new Error(`Expected legal replay input: ${applied.error.code}`);
  const seq = context.log.head.seq + 1;
  const term = context.log.head.term;
  const proposer = proposerFor(seq, term, context.membership, context.excludedProposers);
  const identity = fixture.identities.find((candidate) => candidate.peerId === proposer.publicKey);
  if (!identity) throw new Error('Expected proposer identity');
  const entry = signEntry(
    {
      seq,
      term,
      prevHash: entryHash(context.log.head),
      payload,
      stateHash: toHex(hashValue(applied.value.state)),
      sequencer: proposer.publicKey,
    },
    identity.secretKey,
  );
  return { entry, certificate: certificateFor(fixture, context, entry) };
}

function setup() {
  const fixture = protocolFixture();
  const context = value(initialProposalContext(fixture.entry, fixture.engine, policy));
  return { fixture, context };
}

function startEntry(fixture: ReturnType<typeof protocolFixture>, context: ProposalContext) {
  const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
  return nextCertified(fixture, context, input, {
    kind: 'system',
    input,
    evidence: stubEvidence(context.log, input),
  });
}

function commandEntry(
  fixture: ReturnType<typeof protocolFixture>,
  context: ProposalContext,
  command: CommandShape,
  nonce: number,
): CertifiedEntry {
  const owner = fixture.identities[0];
  if (!owner) throw new Error('Expected command owner identity');
  const signed = signCommand(
    {
      gameId: context.log.genesis.gameId,
      genesisDigest: context.membership.genesisDigest,
      seat: 0,
      nonce,
      headSeq: context.log.head.seq,
      headHash: entryHash(context.log.head),
      command,
    },
    owner.secretKey,
  );
  const input: Input = { kind: 'command', seat: 0, command };
  return nextCertified(fixture, context, input, { kind: 'command', signed });
}

describe('certified protocol replay', () => {
  test('validates signed certificates, parent links, command nonces and derives full state', () => {
    const { fixture, context } = setup();
    const start = startEntry(fixture, context);
    const afterStart = value(replayCertifiedPrefix(fixture.entry, [start], fixture.engine, policy));
    const settlement = afterStart.context.log.engine
      .getLegalCommands(afterStart.context.log.state, 0)
      .commands.find((command) => command.type === 'PLACE_SETTLEMENT');
    if (!settlement) throw new Error('Expected legal setup settlement');
    const placement = commandEntry(fixture, afterStart.context, settlement, 1);

    const replayed = replayCertifiedPrefix(
      fixture.entry,
      [start, placement],
      fixture.engine,
      policy,
    );
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) return;
    expect(replayed.value.context.log.head).toEqual(placement.entry);
    expect(replayed.value.context.log.lastNonces.get(0)).toBe(1);
    expect(replayed.value.inputs).toHaveLength(2);
    expect(replayed.value.context.log.state).toEqual(
      value(
        fixture.engine.apply(afterStart.context.log.state, {
          kind: 'command',
          seat: 0,
          command: settlement,
        }),
      ).state,
    );

    const afterPlacement = replayed.value.context;
    const road = afterPlacement.log.engine
      .getLegalCommands(afterPlacement.log.state, 0)
      .commands.find((command) => command.type === 'PLACE_ROAD');
    if (!road) throw new Error('Expected legal setup road');
    const repeatedNonce = commandEntry(fixture, afterPlacement, road, 1);
    expect(
      replayCertifiedPrefix(
        fixture.entry,
        [start, placement, repeatedNonce],
        fixture.engine,
        policy,
      ),
    ).toMatchObject({ ok: false, error: { code: 'replayed-nonce' } });
  });

  test('rejects forged certificates and correctly signed entries with a wrong parent', () => {
    const { fixture, context } = setup();
    const valid = startEntry(fixture, context);
    const forged = {
      ...valid,
      certificate: valid.certificate.map((vote, index) =>
        index === 0 ? { ...vote, sig: 'A'.repeat(86) } : vote,
      ),
    };
    expect(replayCertifiedPrefix(fixture.entry, [forged], fixture.engine, policy)).toMatchObject({
      ok: false,
      error: { code: 'vote-signature' },
    });

    const signer = fixture.identities[0];
    if (!signer) throw new Error('Expected initial sequencer identity');
    const wrongParentEntry = signEntry(
      { ...valid.entry, prevHash: 'f'.repeat(64) },
      signer.secretKey,
    );
    const wrongParent = {
      entry: wrongParentEntry,
      certificate: certificateFor(fixture, context, wrongParentEntry),
    };
    expect(
      replayCertifiedPrefix(fixture.entry, [wrongParent], fixture.engine, policy),
    ).toMatchObject({ ok: false, error: { code: 'previous-hash' } });
  });

  test('rejects snapshot nonce and membership metadata even when engine state is unchanged', () => {
    const { fixture, context } = setup();
    const start = startEntry(fixture, context);
    const replayed = value(replayCertifiedPrefix(fixture.entry, [start], fixture.engine, policy));
    const snapshot = snapshotFromContext(replayed.context);
    expect(verifyReplaySnapshot(snapshot, replayed.context)).toMatchObject({ ok: true });

    const nonceTamper = { ...record(snapshot), lastNonces: [[0, 99]] };
    expect(verifyReplaySnapshot(nonceTamper, replayed.context)).toMatchObject({
      ok: false,
      error: { code: 'snapshot-mismatch' },
    });

    const membership = record(record(snapshot).membership);
    const membershipTamper = {
      ...record(snapshot),
      membership: { ...membership, epoch: 1 },
    };
    expect(verifyReplaySnapshot(membershipTamper, replayed.context)).toMatchObject({
      ok: false,
      error: { code: 'snapshot-mismatch' },
    });
  });
});
