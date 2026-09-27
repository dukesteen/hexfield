import { hashValue, toHex } from '@cp2p/codec';
import {
  G,
  decodePoint,
  encodePoint,
  encodeScalar,
  pedersenCommit,
  proveRange,
  verifyRange,
} from '@cp2p/crypto';
import { RESOURCES, createResourceBounds, zeroCounts } from '@cp2p/engine';
import type { Input, Result } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { verifyCheatProof } from './cheat-proof.js';
import { composeCommandProofs, readCommandProofs } from './command-proofs.js';
import { validateCommandForEntry, validateCommandStatement } from './command-validation.js';
import { createConsensusState, receiveProposal } from './consensus.js';
import { entryHash, signEntry } from './genesis.js';
import { handProofContext, proveHandObligation, verifyHandProofs } from './hand-transition.js';
import { signCommand } from './log.js';
import {
  proposerFor,
  signProposal,
  validateObjectiveForProposal,
  validateProposal,
} from './proposal.js';
import {
  advanceRecoveryFixture,
  certifyRecoveryFixtureFirstBeacon,
  createRecoveryFixture,
  recoveryFixtureKey,
} from './testing/recovery-fixture.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing admission fixture value');
  return item;
}

describe('signed hidden-hand admission', () => {
  test('an engine-legal purchase with a plausible public hand still needs its true range witness', () => {
    const fixture = createRecoveryFixture({ offlineSeat: null });
    const first = certifyRecoveryFixtureFirstBeacon(fixture, fixture.ready);
    const context = advanceRecoveryFixture(fixture.ready, first);
    const engine = fixture.source.engine;
    let state = context.log.state;
    const history: Input[] = [];
    const apply = (input: Input) => {
      state = value(engine.apply(state, input)).state;
      history.push(input);
    };
    while (engine.getPending(state).some((pending) => pending.kind === 'player')) {
      const pending = required(engine.getPending(state).find((item) => item.kind === 'player'));
      if (pending.kind !== 'player') throw new Error('Expected setup player');
      const command = required(engine.getLegalCommands(state, pending.seat).commands[0]);
      if (command.type !== 'PLACE_SETTLEMENT' && command.type !== 'PLACE_ROAD') break;
      apply({ kind: 'command', seat: pending.seat, command });
    }
    const roller = required(engine.getPending(state).find((item) => item.kind === 'player'));
    if (roller.kind !== 'player') throw new Error('Expected roll player');
    apply({ kind: 'command', seat: roller.seat, command: { type: 'ROLL_DICE' } });
    apply({ kind: 'system', type: 'DICE_RESULT', dice: [1, 1] });
    const actor = required(engine.getPending(state).find((item) => item.kind === 'player'));
    if (actor.kind !== 'player') throw new Error('Expected main-phase player');
    const zero = zeroCounts(RESOURCES);
    const uncertain = value(
      createResourceBounds(3, zero, { ...zero, brick: 1, wool: 1, grain: 1, ore: 1 }),
    );
    state = {
      ...state,
      bank: {
        ...state.bank,
        brick: required(state.bank.brick) - 1,
        grain: required(state.bank.grain) - 1,
        ore: required(state.bank.ore) - 1,
      },
      seats: state.seats.map((seat) =>
        seat.seat === actor.seat ? { ...seat, resources: uncertain } : seat,
      ),
    };
    const command = { type: 'BUY_DEV_CARD' as const };
    expect(engine.validate(state, { kind: 'command', seat: actor.seat, command }).ok).toBe(true);
    expect(engine.getLegalCommands(state, actor.seat).commands).toContainEqual(command);
    expect(engine.checkInvariants(state)).toEqual([]);
    expect(
      engine.checkInvariants(
        value(engine.apply(state, { kind: 'command', seat: actor.seat, command })).state,
      ),
    ).toEqual([]);
    const source = required(fixture.source.identities.get(actor.seat));
    // Setup and dice reach a legal phase. The bank, bounds and commitments are then
    // edited into an invariant-clean test state. This actor-signed head skips the
    // uncertified intermediate entries, so the test isolates admission, not replay.
    const head = signEntry(
      {
        ...context.log.head,
        seq: context.log.head.seq + history.length,
        stateHash: toHex(hashValue(state)),
        prevHash: entryHash(context.log.head),
        sequencer: source.peerId,
      },
      source.secretKey,
    );
    const hands = required(context.log.crypto).hands.map((row) =>
      row.seat === actor.seat
        ? {
            ...row,
            commitments: {
              ...row.commitments,
              brick: pedersenCommit(1n, 0n),
              wool: pedersenCommit(0n, 19n),
              grain: pedersenCommit(1n, 0n),
              ore: pedersenCommit(1n, 0n),
            },
          }
        : row,
    );
    const log = {
      ...context.log,
      head,
      state,
      crypto: { ...required(context.log.crypto), hands },
    };
    const bare = {
      gameId: fixture.genesis.gameId,
      genesisDigest: context.membership.genesisDigest,
      seat: actor.seat,
      nonce: 1,
      headSeq: head.seq,
      headHash: entryHash(head),
      command,
    };
    const unsigned = signCommand(bare, source.secretKey);
    const statement = value(validateCommandStatement(unsigned, log));
    const plan = required(statement.plan);
    expect(plan.obligations.map(({ resource }) => resource)).toEqual(['wool', 'grain', 'ore']);
    const binding = {
      genesisDigest: bare.genesisDigest,
      epoch: required(log.crypto).epoch,
      anchor: { seq: head.seq, hash: entryHash(head) },
      command: bare,
    };
    const counts = { ...zero, brick: 1, grain: 1, ore: 1 };
    const blindings = Object.fromEntries(
      RESOURCES.map((resource) => [resource, encodeScalar(resource === 'wool' ? 19n : 0n)]),
    );
    const seed = new Uint8Array(32).fill(7);
    const proofs = plan.obligations.map((obligation, index) => {
      if (obligation.resource !== 'wool')
        return value(proveHandObligation(plan, index, counts, blindings, seed, binding));
      const proofContext = handProofContext(plan, index, binding);
      expect(proveHandObligation(plan, index, counts, blindings, seed, binding)).toMatchObject({
        ok: false,
        error: { code: 'hand-proof-witness' },
      });
      const falseStatement = { commitment: obligation.commitment, bits: 6 };
      const falseProof = proveRange(falseStatement, 0n, 19n, seed, proofContext);
      expect(verifyRange(falseStatement, falseProof, proofContext)).toBe(true);
      const requiredStatement = {
        commitment: encodePoint(decodePoint(obligation.commitment).subtract(G)),
        bits: 6,
      };
      expect(verifyRange(requiredStatement, falseProof, proofContext)).toBe(false);
      return {
        kind: 'range' as const,
        seat: actor.seat,
        resource: 'wool' as const,
        count: 1,
        proof: falseProof,
      };
    });
    expect(verifyHandProofs(plan, proofs, binding)).toMatchObject({
      ok: false,
      error: { code: 'hand-proof-invalid' },
    });
    const evidence = composeCommandProofs([], proofs);
    if (!evidence) throw new Error('Expected hand-proof evidence');
    expect(readCommandProofs(evidence, plan).ok).toBe(true);
    const signed = signCommand({ ...bare, evidence }, source.secretKey);
    expect(validateCommandForEntry(signed, log, context.policy)).toMatchObject({
      ok: false,
      error: { code: 'hand-proof-invalid' },
    });
    expect(
      verifyCheatProof(
        {
          seat: actor.seat,
          evidence: {
            kind: 'command-proof',
            at: { seq: head.seq, hash: entryHash(head) },
            artifact: signed,
          },
        },
        log,
      ),
    ).toMatchObject({ ok: true, value: { seat: actor.seat, kind: 'command-proof' } });

    const proposalContext = { ...context, log };
    const elected = proposerFor(head.seq + 1, 1, context.membership);
    expect(elected.seat).not.toBe(actor.seat);
    const applied = value(engine.apply(state, { kind: 'command', seat: actor.seat, command }));
    const entry = signEntry(
      {
        seq: head.seq + 1,
        term: 1,
        prevHash: entryHash(head),
        payload: { kind: 'command', signed },
        stateHash: toHex(hashValue(applied.state)),
        sequencer: elected.publicKey,
      },
      recoveryFixtureKey(fixture, elected.seat),
    );
    const proposal = signProposal(
      {
        genesisDigest: context.membership.genesisDigest,
        epoch: context.membership.epoch,
        entry,
        validRound: null,
        prevotes: [],
      },
      recoveryFixtureKey(fixture, elected.seat),
    );
    expect(validateProposal(proposal, proposalContext)).toMatchObject({
      ok: false,
      error: { code: 'hand-proof-invalid', details: { proposalEntryRejected: true } },
    });
    const voter = required(context.membership.voters.find((item) => item.seat !== elected.seat));
    const safety = value(createConsensusState(proposalContext, voter.seat));
    const received = receiveProposal(
      safety,
      proposalContext,
      recoveryFixtureKey(fixture, voter.seat),
      proposal,
    );
    expect(received).toMatchObject({ ok: false, error: { code: 'hand-proof-invalid' } });
    const control = {
      kind: 'control' as const,
      action: 'exclude-proposer' as const,
      offender: elected.seat,
      evidence: { kind: 'invalid-command' as const, proposal },
    };
    expect(validateObjectiveForProposal(control, proposalContext).ok).toBe(true);
  }, 20_000);
});
