import { hashValue, toHex } from '@cp2p/codec';
import { describe, expect, test } from 'vitest';
import type { SystemInput } from '@cp2p/engine';
import {
  entryHash,
  genesisDigest,
  initialProposalContext,
  proposerFor,
  signEntry,
  signProposal,
  stubEvidence,
  validateObjectiveAccusation,
} from '@cp2p/protocol';
import { createSimulationGenesis } from '@cp2p/protocol/testing';
import { invalidCommandProposal } from './net-adversary.js';

describe('network Byzantine fault helper', () => {
  test('replaces only the elected signer’s outbound proposal with verifiable invalid-command evidence', () => {
    const game = createSimulationGenesis({ seed: 42 });
    const contextResult = initialProposalContext(game.entry, game.engine, {
      genesis: { allowStub: true },
      entry: { allowStub: true },
    });
    if (!contextResult.ok) throw new Error(contextResult.error.message);
    const context = contextResult.value;
    const offender = game.identities.get(0);
    if (!offender) throw new Error('Missing offender identity');
    const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
    const applied = game.engine.apply(context.log.state, input);
    if (!applied.ok) throw new Error(applied.error.message);
    const entry = signEntry(
      {
        seq: 1,
        term: 1,
        prevHash: entryHash(context.log.head),
        payload: { kind: 'system', input, evidence: stubEvidence(context.log, input) },
        stateHash: toHex(hashValue(applied.value.state)),
        sequencer: offender.peerId,
      },
      offender.secretKey,
    );
    const original = signProposal(
      {
        genesisDigest: genesisDigest(game.genesis),
        epoch: 0,
        entry,
        validRound: null,
        prevotes: [],
      },
      offender.secretKey,
    );

    const altered = invalidCommandProposal(original, game.genesis, 0, offender.secretKey);
    expect(original.body.entry.payload.kind).toBe('system');
    expect(altered.body.entry.payload.kind).toBe('command');
    expect(altered.body.entry.prevHash).toBe(original.body.entry.prevHash);
    expect(altered.body.entry.seq).toBe(original.body.entry.seq);
    expect(altered.body.entry.term).toBe(original.body.entry.term);
    expect(
      validateObjectiveAccusation(
        {
          kind: 'control',
          action: 'exclude-proposer',
          offender: 0,
          evidence: { kind: 'invalid-command', proposal: altered },
        },
        {
          log: context.log,
          membership: context.membership,
          excludedProposers: context.excludedProposers,
          proposerFor: (seq, term) =>
            proposerFor(seq, term, context.membership, context.excludedProposers),
        },
      ).ok,
    ).toBe(true);
    const wrong = game.identities.get(1);
    if (!wrong) throw new Error('Missing other identity');
    expect(() => invalidCommandProposal(original, game.genesis, 0, wrong.secretKey)).toThrow(
      'fault hook requires',
    );
  });
});
