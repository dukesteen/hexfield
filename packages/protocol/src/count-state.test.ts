import { hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { createHashChain, encodeScalar, pedersenCommit } from '@cp2p/crypto';
import { RESOURCES, createResourceBounds, success, zeroCounts } from '@cp2p/engine';
import type { GameState, Result, Seat, SystemInput } from '@cp2p/engine';
import { describe, expect, test, vi } from 'vitest';
import { captureCountPending, validateCountState } from './count-state.js';
import { countOperationId, proveCountOpening, signCountContribution } from './count-reveal.js';
import { entryHash, genesisDigest, signEntry } from './genesis.js';
import { emptyHandCommitments } from './hand-commitments.js';
import type { LogContext } from './log.js';
import { validateNextEntry } from './log.js';
import { fixtureAt, protocolFixture } from './testing/fixtures.js';
import type { EntryPayload } from './types.js';
import { signVote } from './votes.js';
import { freezeBeaconRequest, getBeaconOperation } from './beacon-state.js';
import { signBeaconReveal } from './beacon.js';
import { createRandomDerivations } from './random-derivations.js';
import { validateCryptoTransition } from './crypto-context.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function fixture() {
  const source = protocolFixture();
  const genesis = { ...source.genesis, security: 'verified' as const };
  const zero = zeroCounts(RESOURCES);
  const uncertain = value(createResourceBounds(1, zero, { ...zero, wool: 1, ore: 1 }));
  const exact = value(createResourceBounds(2, { ...zero, ore: 2 }, { ...zero, ore: 2 }));
  // Focused validator fixture: real engine effects and genuine nonzero-blinding
  // commitments, but a synthetic pre-existing Monopoly phase and trusted head.
  // Legal genesis/card/deal progression is covered separately by count-replica.
  const state: GameState = {
    ...source.state,
    bank: { ...source.state.bank, ore: 17, wool: 18 },
    seats: source.state.seats.map((seat) => ({
      ...seat,
      resources: seat.seat === 1 ? uncertain : seat.seat === 2 ? exact : seat.resources,
    })),
    turn: {
      number: 5,
      activeSeat: 0,
      phase: [
        { module: 'base', id: 'main', data: null },
        { module: 'base', id: 'monopoly', data: { seat: 0, resource: 'ore', remaining: [1, 2] } },
      ],
    },
  };
  const hands = value(emptyHandCommitments(genesis.config.seats)).map((hand) => ({
    ...hand,
    commitments: {
      ...hand.commitments,
      wool: hand.seat === 1 ? pedersenCommit(1n, 0n) : hand.commitments.wool,
      ore:
        hand.seat === 1
          ? pedersenCommit(0n, 5n)
          : hand.seat === 2
            ? pedersenCommit(2n, 7n)
            : hand.commitments.ore,
    },
  }));
  const counts = value(
    captureCountPending(null, genesis, source.engine, state, hands, 0, {
      seq: 10,
      hash: 'ab'.repeat(32),
    }),
  );
  if (!counts) throw new Error('Missing frozen fixture counts');
  const digest = genesisDigest(genesis);
  const sequencer = fixtureAt(source.identities, 0);
  const head = signEntry(
    { ...source.entry, seq: 10, stateHash: toHex(hashValue(state)) },
    sequencer.secretKey,
  );
  const context: LogContext = {
    genesis,
    engine: source.engine,
    state,
    head,
    lastNonces: new Map(),
    crypto: {
      epoch: 0,
      hands,
      counts,
      // Minimal replay metadata for this isolated hand validator. No deck or
      // random operation is exercised or substituted by these tests.
      decks: { genesisDigest: digest, decks: [], active: null },
      beacon: {
        genesisDigest: digest,
        chains: [
          {
            seat: 0,
            publicKey: sequencer.peerId,
            chainEpoch: 0,
            index: 0,
            length: 8,
            tip: toBase64Url(new Uint8Array(32)),
          },
        ],
        round: 0,
        active: null,
        fixed: null,
      },
    },
  };
  const verifySystem = vi.fn<() => Result<void>>(() => success(undefined));
  const policy = {
    sequencer: sequencer.peerId,
    term: 1,
    verifySystem,
    verifyControl: () => success(undefined),
  };
  const contribution = (seat: Seat, count: number, blinding: bigint) =>
    signCountContribution(
      counts.operation,
      seat,
      count,
      value(
        proveCountOpening(
          counts.operation,
          seat,
          count,
          encodeScalar(blinding),
          new Uint8Array(32).fill(21 + seat),
        ),
      ),
      fixtureAt(source.identities, seat).secretKey,
    );
  const zeroReveal = contribution(1, 0, 5n);
  const positiveReveal = contribution(2, 2, 7n);
  const payload = (signed: typeof zeroReveal): EntryPayload => ({
    kind: 'system',
    input: {
      kind: 'system',
      type: 'REVEAL_COUNT',
      seat: signed.body.seat,
      resource: 'ore',
      count: signed.body.count,
    },
    evidence: { kind: 'proof', protocol: 'monopoly-count-v1', data: signed },
  });
  const entry = (at: LogContext, contents: EntryPayload, input?: SystemInput) =>
    signEntry(
      {
        seq: at.head.seq + 1,
        term: 1,
        prevHash: entryHash(at.head),
        payload: contents,
        stateHash: input
          ? toHex(hashValue(value(source.engine.apply(at.state, input)).state))
          : at.head.stateHash,
        sequencer: sequencer.peerId,
      },
      sequencer.secretKey,
    );
  const revealEntry = (at: LogContext, signed: typeof zeroReveal) => {
    const contents = payload(signed);
    if (contents.kind !== 'system') throw new Error('Expected count input');
    return entry(at, contents, contents.input);
  };
  return {
    source,
    context,
    counts,
    hands,
    policy,
    payload,
    entry,
    revealEntry,
    zeroReveal,
    positiveReveal,
  };
}

describe('replayed Monopoly count state', () => {
  test('consumes zero and positive reveals once, preserving frozen proofs across a control entry', () => {
    const data = fixture();
    const first = value(
      validateNextEntry(data.revealEntry(data.context, data.zeroReveal), data.context, data.policy),
    );
    expect(first.crypto?.counts?.remaining).toEqual([2]);
    expect(first.state.seats[1]?.resources.max.ore).toBe(0);
    expect(first.crypto?.hands).toEqual(data.hands);
    const afterFirst: LogContext = { ...data.context, ...first, head: first.entry };
    const vote = {
      genesisDigest: genesisDigest(data.context.genesis),
      epoch: 0,
      seat: 1 as const,
      seq: first.entry.seq + 1,
      term: 1,
      phase: 'prevote' as const,
      valueHash: 'cd'.repeat(32),
    };
    const key = fixtureAt(data.source.identities, 1).secretKey;
    const control: EntryPayload = {
      kind: 'control',
      action: 'exclude-proposer',
      offender: 1,
      evidence: {
        kind: 'vote-equivocation',
        first: signVote(vote, key),
        second: signVote({ ...vote, valueHash: 'ef'.repeat(32) }, key),
      },
    };
    const controlled = value(
      validateNextEntry(data.entry(afterFirst, control), afterFirst, data.policy),
    );
    expect(controlled.crypto?.counts).toEqual(first.crypto?.counts);
    const afterControl: LogContext = { ...afterFirst, ...controlled, head: controlled.entry };
    expect(
      validateNextEntry(
        data.entry(afterControl, data.payload(data.zeroReveal)),
        afterControl,
        data.policy,
      ),
    ).toMatchObject({ ok: false, error: { code: 'count-pending' } });
    const final = value(
      validateNextEntry(
        data.revealEntry(afterControl, data.positiveReveal),
        afterControl,
        data.policy,
      ),
    );
    expect(final.crypto?.counts).toBeNull();
    expect(final.state.seats[0]?.resources.min.ore).toBe(2);
    expect(final.state.seats[2]?.resources.max.ore).toBe(0);
    expect(final.crypto?.hands[0]?.commitments.ore).toBe(pedersenCommit(2n, 0n));
    expect(final.crypto?.hands[2]?.commitments.ore).toBe(pedersenCommit(0n, 7n));
    expect(data.policy.verifySystem).not.toHaveBeenCalled();
  });

  test('requires the signed count before a permissive system policy and cannot substitute a victim or amount', () => {
    const data = fixture();
    const valid = data.payload(data.positiveReveal);
    if (valid.kind !== 'system' || valid.evidence.kind !== 'proof')
      throw new Error('Expected count payload and proof');
    for (const [invalid, code] of [
      [
        {
          ...valid,
          evidence: { kind: 'proof' as const, protocol: 'generic-accept-all', data: null },
        },
        'count-pending',
      ],
      [{ ...valid, evidence: { ...valid.evidence, data: data.zeroReveal } }, 'count-input'],
    ] as const)
      expect(
        validateNextEntry(
          data.entry(data.context, invalid, invalid.input),
          data.context,
          data.policy,
        ),
      ).toMatchObject({ ok: false, error: { code } });
    const zero = data.payload(data.zeroReveal);
    if (zero.kind !== 'system') throw new Error('Expected zero count payload');
    // Seat 1 may publicly hold ore or wool. The engine accepts a count of one,
    // so only the mismatch with its owner-signed zero count rejects this entry.
    const falseCount = { ...zero, input: { ...zero.input, count: 1 } };
    expect(
      validateNextEntry(
        data.entry(data.context, falseCount, falseCount.input),
        data.context,
        data.policy,
      ),
    ).toMatchObject({ ok: false, error: { code: 'count-input' } });
    const wrongResource = { ...valid, input: { ...valid.input, resource: 'brick' } };
    expect(
      validateNextEntry(
        data.entry(data.context, wrongResource, valid.input),
        data.context,
        data.policy,
      ),
    ).toMatchObject({ ok: false, error: { code: 'count-pending' } });
    expect(data.policy.verifySystem).not.toHaveBeenCalled();
  });

  test('a registered beacon derivation cannot replace the count owner signature', () => {
    const data = fixture();
    const crypto = data.context.crypto;
    if (!crypto) throw new Error('Missing fixture crypto');
    const owner = fixtureAt(data.source.identities, 0);
    const chain = createHashChain(new Uint8Array(32).fill(31), 8);
    const tip = fixtureAt(chain, 0);
    const link = fixtureAt(chain, 1);
    const countInput: SystemInput = {
      kind: 'system',
      type: 'REVEAL_COUNT',
      seat: 1,
      resource: 'ore',
      count: 0,
    };
    const registry = createRandomDerivations([
      {
        type: 'extension-count',
        validate: () => success(undefined),
        derive: () => success({ kind: 'system', input: countInput }),
      },
    ]);
    const beacon = value(
      freezeBeaconRequest(
        {
          ...crypto.beacon,
          chains: crypto.beacon.chains.map((item) => ({ ...item, tip: toBase64Url(tip) })),
        },
        { kind: 'random', request: { type: 'extension-count' }, systemType: 'REVEAL_COUNT' },
        data.context.state,
        { seq: 10, hash: entryHash(data.context.head) },
        0,
        registry,
      ),
    );
    const operation = value(getBeaconOperation(beacon));
    const payload: EntryPayload = {
      kind: 'system',
      input: countInput,
      evidence: {
        kind: 'proof',
        protocol: 'beacon-v1',
        data: [signBeaconReveal(operation, 0, link, owner.secretKey)],
      },
    };
    const context = { ...data.context, crypto: { ...crypto, beacon } };
    const entry = data.entry(context, payload, countInput);
    // The synthetic extension really passes the separate beacon handler. Owner
    // authentication must therefore live on the common selected-input path.
    expect(
      validateCryptoTransition(
        context.genesis,
        context.crypto,
        context.engine,
        context.state,
        entry,
        registry,
      ),
    ).toMatchObject({ ok: true, value: { handled: true, input: countInput } });
    expect(
      validateNextEntry(entry, context, { ...data.policy, randomDerivations: registry }),
    ).toMatchObject({ ok: false, error: { code: 'count-pending' } });
    expect(data.policy.verifySystem).not.toHaveBeenCalled();
  });

  test('requires exact pending victims and commitments, and closes remaining requests only at game end', () => {
    const data = fixture();
    const { genesis, engine, state } = data.context;
    const validate = (counts: unknown, hands = data.hands) =>
      validateCountState(counts, genesis, engine, state, hands, 0);
    expect(validate(data.counts).ok).toBe(true);
    expect(validate(null)).toMatchObject({ ok: false, error: { code: 'count-context-required' } });
    expect(validate({ ...data.counts, remaining: [2] }).ok).toBe(false);
    expect(validate({ ...data.counts, remaining: [2, 1] }).ok).toBe(false);
    expect(validate({ ...data.counts, operation: { ...data.counts.operation, epoch: 1 } }).ok).toBe(
      false,
    );
    expect(
      validate(
        data.counts,
        data.hands.map((hand) =>
          hand.seat === 2
            ? { ...hand, commitments: { ...hand.commitments, ore: pedersenCommit(1n, 7n) } }
            : hand,
        ),
      ),
    ).toMatchObject({ ok: false, error: { code: 'count-commitment-changed' } });
    const original = countOperationId(data.counts.operation);
    const recaptured = value(
      captureCountPending(data.counts, genesis, engine, state, data.hands, 0, {
        seq: 50,
        hash: 'cd'.repeat(32),
      }),
    );
    if (!recaptured) throw new Error('Frozen count request disappeared');
    expect(countOperationId(recaptured.operation)).toBe(original);
    expect(
      captureCountPending(
        data.counts,
        genesis,
        engine,
        { ...state, result: { winner: 0, reason: 'victory', atTurn: 5 } },
        data.hands,
        0,
        { seq: 51, hash: 'ef'.repeat(32) },
      ),
    ).toEqual({ ok: true, value: null });
  });
});
