import { identityFromSecret } from '@cp2p/crypto';
import type { GameConfig, Result, Seat } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { genesisDeckDefinitions } from './deck-genesis.js';
import { applyDeckPass, initDeckSetup, signDeckShuffle } from './deck-setup.js';
import { entryHash, genesisBody, genesisDigest, signEntry } from './genesis.js';
import { encodeProtocolMessage } from './messages.js';
import { signProposal } from './proposal.js';
import { createSimulationGenesis } from './testing/simulation-genesis.js';
import type { GenesisBody } from './types.js';
import { MAX_MESSAGE_BYTES } from './validation.js';
import { signVote } from './votes.js';

function checked<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing six-seat envelope fixture value');
  return value;
}

const SIX_SEAT_CONFIG: GameConfig = {
  modules: [{ id: 'base', version: '1.0.0' }],
  seats: [0, 1, 2, 3, 4, 5],
  options: { base: { mapLayout: 'random' } },
};

describe('six-seat base deck wire envelope bounds', () => {
  test('a real 25-card shuffle proof fits full proposal, commit and two-proposal accusation envelopes', () => {
    const source = createSimulationGenesis({ seed: 819, humanCount: 4 });
    // Base gameplay currently permits at most four seats. Six is a bounded
    // protocol envelope fixture only; it never asks the engine to create a game.
    const identities = new Map<Seat, ReturnType<typeof identityFromSecret>>(source.identities);
    identities.set(4, identityFromSecret(new Uint8Array(32).fill(5)));
    identities.set(5, identityFromSecret(new Uint8Array(32).fill(6)));
    const body: GenesisBody = {
      ...genesisBody(source.genesis),
      config: SIX_SEAT_CONFIG,
      seats: [
        ...source.genesis.seats,
        {
          seat: 4,
          kind: 'human',
          publicKey: need(identities.get(4)).peerId,
          name: 'Emery',
          colour: '#c48b2c',
        },
        {
          seat: 5,
          kind: 'human',
          publicKey: need(identities.get(5)).peerId,
          name: 'Finley',
          colour: '#4574a8',
        },
      ],
    };
    const definition = need(checked(genesisDeckDefinitions(body))[0]);
    expect(definition.cards).toHaveLength(25);
    expect(definition.participants).toHaveLength(6);
    const initial = checked(initDeckSetup(definition));
    const permutation = definition.cards.map((_, index) => index);
    const firstKey = need(identities.get(0)).secretKey;
    const pass = signDeckShuffle(initial, 17n, permutation, new Uint8Array(32).fill(41), firstKey);
    expect(applyDeckPass(initial, pass).ok).toBe(true);

    // The surrounding height/round, votes and state hashes below are synthetic
    // envelope-size inputs. They are signed and schema-valid, not a claim that
    // a six-voter game certified this standalone first ceremony pass.
    const seq = Number.MAX_SAFE_INTEGER;
    const term = Number.MAX_SAFE_INTEGER;
    const priorRound = term - 1;
    const entry = signEntry(
      {
        seq,
        term,
        prevHash: 'a'.repeat(64),
        payload: {
          kind: 'crypto',
          action: 'deck-pass',
          evidence: { deckId: definition.deckId, pass },
        },
        stateHash: 'b'.repeat(64),
        sequencer: need(identities.get(0)).peerId,
      },
      firstKey,
    );
    const alternate = signEntry(
      {
        seq,
        term,
        prevHash: entry.prevHash,
        payload: entry.payload,
        stateHash: 'c'.repeat(64),
        sequencer: entry.sequencer,
      },
      firstKey,
    );
    const digest = genesisDigest(body);
    const votes = (valueHash: string, phase: 'prevote' | 'precommit', round: number) =>
      SIX_SEAT_CONFIG.seats.map((seat) =>
        signVote(
          {
            genesisDigest: digest,
            epoch: 0,
            seat,
            seq,
            term: round,
            phase,
            valueHash,
          },
          need(identities.get(seat)).secretKey,
        ),
      );
    const proposal = (value: typeof entry) =>
      signProposal(
        {
          genesisDigest: digest,
          epoch: 0,
          entry: value,
          validRound: priorRound,
          prevotes: votes(entryHash(value), 'prevote', priorRound),
        },
        firstKey,
      );
    const firstProposal = proposal(entry);
    const secondProposal = proposal(alternate);
    const proposalBytes = checked(
      encodeProtocolMessage({ t: 'PROPOSAL', proposal: firstProposal }),
    );
    const commitBytes = checked(
      encodeProtocolMessage({
        t: 'COMMIT',
        certified: { entry, certificate: votes(entryHash(entry), 'precommit', term) },
      }),
    );
    const accusationBytes = checked(
      encodeProtocolMessage({
        t: 'ACCUSE',
        control: {
          kind: 'control',
          action: 'exclude-proposer',
          offender: 0 as Seat,
          evidence: { kind: 'proposal-equivocation', first: firstProposal, second: secondProposal },
        },
      }),
    );
    for (const bytes of [proposalBytes, commitBytes, accusationBytes]) {
      expect(bytes.byteLength).toBeLessThan(MAX_MESSAGE_BYTES);
      expect(bytes.byteLength).toBeGreaterThan(0);
    }
  }, 120_000);
});
