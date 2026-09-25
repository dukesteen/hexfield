import { hashValue, toHex } from '@cp2p/codec';
import { verifyObject } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { CommandShape, Input, Result, SystemInput } from '@cp2p/engine';
import { describe, expect, test, vi } from 'vitest';
import {
  entryBody,
  entryHash,
  genesisDigest,
  genesisId,
  signEntry,
  signGenesis,
} from './genesis.js';
import { signCommand, stubEvidence, validateNextEntry, validateSignedCommand } from './log.js';
import type { EntryPolicy, LogContext } from './log.js';
import { fixtureAt, protocolFixture } from './testing/fixtures.js';
import type { CommandBody, EntryPayload, Genesis, GenesisBody, LogEntry } from './types.js';

function errorCode(result: Result<unknown>): string | undefined {
  return result.ok ? undefined : result.error.code;
}

function initial() {
  const fixture = protocolFixture();
  const sequencer = fixture.identities[0];
  if (!sequencer) throw new Error('Missing sequencer fixture');
  const context: LogContext = {
    genesis: fixture.genesis,
    engine: fixture.engine,
    head: fixture.entry,
    state: fixture.state,
    lastNonces: new Map(),
  };
  const policy: EntryPolicy = { term: 1, sequencer: sequencer.peerId, allowStub: true };
  return { ...fixture, sequencer, context, policy };
}

function nextEntry(
  context: LogContext,
  input: Input,
  payload: EntryPayload,
  secretKey: Uint8Array,
): LogEntry {
  const applied = context.engine.apply(context.state, input);
  if (!applied.ok) throw new Error(`Expected legal fixture input: ${applied.error.code}`);
  return signEntry(
    {
      seq: context.head.seq + 1,
      term: context.head.term,
      prevHash: entryHash(context.head),
      payload,
      stateHash: toHex(hashValue(applied.value.state)),
      sequencer: context.head.sequencer,
    },
    secretKey,
  );
}

function started() {
  const fixture = initial();
  const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
  const entry = nextEntry(
    fixture.context,
    input,
    { kind: 'system', input, evidence: stubEvidence(fixture.context, input) },
    fixture.sequencer.secretKey,
  );
  const accepted = validateNextEntry(entry, fixture.context, fixture.policy);
  if (!accepted.ok) throw new Error(`Could not start protocol fixture: ${accepted.error.code}`);
  const context: LogContext = {
    ...fixture.context,
    head: entry,
    state: accepted.value.state,
    lastNonces: accepted.value.lastNonces,
  };
  return { ...fixture, context, entry };
}

function setupCommand(context: LogContext, secretKey: Uint8Array, command?: CommandShape) {
  const legal = context.engine
    .getLegalCommands(context.state, 0)
    .commands.find((choice) => choice.type === 'PLACE_SETTLEMENT');
  if (!legal) throw new Error('Expected a legal setup settlement');
  const body: CommandBody = {
    gameId: context.genesis.gameId,
    genesisDigest: genesisDigest(context.genesis),
    seat: 0,
    nonce: 1,
    headSeq: context.head.seq,
    headHash: entryHash(context.head),
    command: command ?? legal,
  };
  return { body, signed: signCommand(body, secretKey) };
}

describe('signed commands and next log entries', () => {
  test('applies a signed system start and a legal signed command without mutating its context', () => {
    const fixture = started();
    const { body, signed } = setupCommand(fixture.context, fixture.sequencer.secretKey);
    const input: Input = { kind: 'command', seat: 0, command: body.command };
    const entry = nextEntry(
      fixture.context,
      input,
      { kind: 'command', signed },
      fixture.sequencer.secretKey,
    );
    const beforeState = fixture.context.state;
    const accepted = validateNextEntry(entry, fixture.context, fixture.policy);

    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value.hash).toBe(entryHash(entry));
    expect(accepted.value.input).toEqual(input);
    expect(accepted.value.state).not.toBe(beforeState);
    expect(accepted.value.lastNonces.get(0)).toBe(1);
    expect(fixture.context.lastNonces.size).toBe(0);
    expect(fixture.context.state).toBe(beforeState);
    expect(
      errorCode(
        validateSignedCommand(signed, {
          ...fixture.context,
          head: entry,
          state: accepted.value.state,
          lastNonces: accepted.value.lastNonces,
        }),
      ),
    ).toBe('replayed-nonce');
  });

  test('binds each command to game, signer, nonce, exact parent and live engine legality', () => {
    const fixture = started();
    const { body, signed } = setupCommand(fixture.context, fixture.sequencer.secretKey);
    const owner = fixture.identities[1];
    if (!owner) throw new Error('Missing second identity');
    const altered = (change: Partial<CommandBody>) =>
      signCommand({ ...body, ...change }, fixture.sequencer.secretKey);
    const validate = (value: unknown, context = fixture.context) =>
      errorCode(validateSignedCommand(value, context));

    expect(validate(signed)).toBeUndefined();
    expect(validate(altered({ gameId: 'A'.repeat(22) }))).toBe('wrong-game');
    expect(
      validate(altered({ genesisDigest: genesisDigest({ ...fixture.genesis, createdAt: 9 }) })),
    ).toBe('wrong-game');
    expect(validate(signCommand(body, owner.secretKey))).toBe('command-signature');
    expect(validate(signed, { ...fixture.context, lastNonces: new Map([[0, 1]]) })).toBe(
      'replayed-nonce',
    );
    expect(validate(altered({ headSeq: 0 }))).toBe('stale-head');
    expect(validate(altered({ headSeq: fixture.context.head.seq + 1 }))).toBe('future-head');
    expect(validate(altered({ headHash: 'f'.repeat(64) }))).toBe('command-parent');
    expect(validate(altered({ seat: 4 }))).toBe('unknown-seat');
    expect(validate(altered({ command: { type: 'END_TURN' } }))).toBe('not-pending');
    expect(validate({ ...signed, sig: 'A'.repeat(86) })).toBe('command-signature');
    const cyclicCommand: CommandShape = { type: 'PLACE_SETTLEMENT' };
    cyclicCommand.self = cyclicCommand;
    expect(validate({ ...signed, body: { ...body, command: cyclicCommand } })).toBe(
      'invalid-encoding',
    );
  });

  test('rejects wrong entry position, term, parent, signer, and claimed state hash', () => {
    const { context, policy, sequencer, identities } = initial();
    const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
    const base = nextEntry(
      context,
      input,
      { kind: 'system', input, evidence: stubEvidence(context, input) },
      sequencer.secretKey,
    );
    const resign = (change: Partial<LogEntry>, key = sequencer.secretKey) =>
      signEntry({ ...base, ...change }, key);
    const validate = (value: unknown, rules = policy) =>
      errorCode(validateNextEntry(value, context, rules));

    expect(validate(resign({ seq: 0 }))).toBe('stale-entry');
    expect(validate(resign({ seq: 3 }))).toBe('missing-ancestor');
    expect(validate(resign({ term: 2 }))).toBe('wrong-term');
    expect(validate(base, { ...policy, sequencer: fixtureAt(identities, 1).peerId })).toBe(
      'wrong-term',
    );
    expect(validate(resign({ prevHash: 'f'.repeat(64) }))).toBe('previous-hash');
    expect(validate({ ...base, sig: 'A'.repeat(86) })).toBe('sequencer-signature');
    expect(
      validate(
        resign({ sequencer: fixtureAt(identities, 1).peerId }, fixtureAt(identities, 1).secretKey),
      ),
    ).toBe('wrong-term');
    expect(validate(resign({ stateHash: 'f'.repeat(64) }))).toBe('state-hash');
    const nextRound = resign({ term: 2 });
    expect(entryHash(nextRound)).toBe(entryHash(base));
    expect(validateNextEntry(nextRound, context, { ...policy, term: 2 }).ok).toBe(true);
    expect(
      errorCode(validateNextEntry({ ...base, term: 2 }, context, { ...policy, term: 2 })),
    ).toBe('sequencer-signature');
    const otherSequencer = fixtureAt(identities, 1);
    const changedProposer = resign({ sequencer: otherSequencer.peerId }, otherSequencer.secretKey);
    expect(entryHash(changedProposer)).toBe(entryHash(base));
    expect(
      errorCode(
        validateNextEntry({ ...base, sequencer: otherSequencer.peerId }, context, {
          ...policy,
          sequencer: otherSequencer.peerId,
        }),
      ),
    ).toBe('sequencer-signature');
    expect(
      validateNextEntry(changedProposer, context, {
        ...policy,
        sequencer: otherSequencer.peerId,
      }).ok,
    ).toBe(true);
    expect(verifyObject('entry', entryBody(base), base.sig, sequencer.publicKey)).toBe(true);
    const faultyEngine = { ...context.engine, checkInvariants: () => ['broken derived state'] };
    expect(errorCode(validateNextEntry(base, { ...context, engine: faultyEngine }, policy))).toBe(
      'entry-state',
    );
    const rejectingEngine = {
      ...context.engine,
      apply: () => failure('forced-apply', 'Application refused'),
    };
    expect(
      errorCode(validateNextEntry(base, { ...context, engine: rejectingEngine }, policy)),
    ).toBe('forced-apply');
    const throwingEngine = {
      ...context.engine,
      apply: () => {
        throw new Error('broken engine');
      },
    };
    expect(errorCode(validateNextEntry(base, { ...context, engine: throwingEngine }, policy))).toBe(
      'entry-verification-failed',
    );
  });

  test('requires bound stub evidence and excludes private card identity and seat status', () => {
    const { context, policy, sequencer } = initial();
    const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
    const base = nextEntry(
      context,
      input,
      { kind: 'system', input, evidence: stubEvidence(context, input) },
      sequencer.secretKey,
    );
    const payload = (replacement: EntryPayload) =>
      signEntry({ ...base, payload: replacement }, sequencer.secretKey);
    const validate = (value: unknown, rules = policy) =>
      errorCode(validateNextEntry(value, context, rules));

    expect(validate(base)).toBeUndefined();
    expect(validate(base, { ...policy, allowStub: false })).toBe('stub-forbidden');
    expect(
      validate(
        payload({ kind: 'system', input, evidence: { kind: 'stub', context: 'f'.repeat(64) } }),
      ),
    ).toBe('stub-context');
    expect(
      validate(
        payload({
          kind: 'system',
          input,
          evidence: { kind: 'proof', protocol: 'beacon', data: {} },
        }),
      ),
    ).toBe('system-proof-unavailable');
    expect(
      validate(
        payload({
          kind: 'system',
          input: { kind: 'system', type: 'CARD_DEALT', card: 'knight' },
          evidence: stubEvidence(context, input),
        }),
      ),
    ).toBe('private-card-in-log');
    expect(
      validate(
        payload({
          kind: 'system',
          input: { kind: 'system', type: 'SEAT_STATUS', seat: 0, status: 'departed' },
          evidence: stubEvidence(context, input),
        }),
      ),
    ).toBe('membership-required');
    expect(validate(payload({ kind: 'membership', change: { seat: 0 } }))).toBe(
      'membership-unavailable',
    );
    expect(validate(payload({ kind: 'genesis', genesis: context.genesis }))).toBe(
      'duplicate-genesis',
    );
  });

  test('requires command and verified-system proof callbacks before applying', () => {
    const fixture = started();
    const { body, signed } = setupCommand(fixture.context, fixture.sequencer.secretKey);
    const withEvidence = signCommand(
      { ...body, evidence: { protocol: 'spend', data: { proof: 1 } } },
      fixture.sequencer.secretKey,
    );
    const input: Input = { kind: 'command', seat: 0, command: body.command };
    const entry = nextEntry(
      fixture.context,
      input,
      { kind: 'command', signed: withEvidence },
      fixture.sequencer.secretKey,
    );
    expect(errorCode(validateNextEntry(entry, fixture.context, fixture.policy))).toBe(
      'command-proof-unavailable',
    );
    const rejectProof = vi.fn<() => Result<void>>(() => failure('bad-proof', 'invalid proof'));
    expect(
      errorCode(
        validateNextEntry(entry, fixture.context, {
          ...fixture.policy,
          verifyCommand: rejectProof,
        }),
      ),
    ).toBe('bad-proof');
    expect(rejectProof).toHaveBeenCalledOnce();
    expect(
      errorCode(
        validateNextEntry(entry, fixture.context, {
          ...fixture.policy,
          verifyCommand: () => {
            throw new Error('malformed proof');
          },
        }),
      ),
    ).toBe('entry-verification-failed');
    const acceptProof = vi.fn<() => Result<void>>(() => success(undefined));
    expect(
      validateNextEntry(entry, fixture.context, { ...fixture.policy, verifyCommand: acceptProof })
        .ok,
    ).toBe(true);
    expect(acceptProof).toHaveBeenCalledOnce();

    const original = initial();
    const verifiedBody: GenesisBody = {
      ...original.body,
      security: 'verified',
      commitments: { beacon: 'opaque' },
    };
    const second = original.identities[1];
    if (!second) throw new Error('Missing second identity');
    const verifiedGenesis: Genesis = {
      ...verifiedBody,
      gameId: genesisId(verifiedBody),
      signatures: [
        signGenesis(verifiedBody, 0, original.sequencer.secretKey),
        signGenesis(verifiedBody, 1, second.secretKey),
      ],
    };
    const verifiedHead = signEntry(
      { ...original.entry, payload: { kind: 'genesis', genesis: verifiedGenesis } },
      original.sequencer.secretKey,
    );
    const verifiedContext: LogContext = {
      ...original.context,
      genesis: verifiedGenesis,
      head: verifiedHead,
    };
    const system: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
    const proofEntry = nextEntry(
      verifiedContext,
      system,
      { kind: 'system', input: system, evidence: { kind: 'proof', protocol: 'beacon', data: {} } },
      original.sequencer.secretKey,
    );
    expect(
      errorCode(
        validateNextEntry(proofEntry, verifiedContext, {
          term: 1,
          sequencer: original.sequencer.peerId,
        }),
      ),
    ).toBe('system-proof-unavailable');
    const verifySystem = vi.fn<() => Result<void>>(() => success(undefined));
    expect(
      validateNextEntry(proofEntry, verifiedContext, {
        term: 1,
        sequencer: original.sequencer.peerId,
        verifySystem,
      }).ok,
    ).toBe(true);
    expect(verifySystem).toHaveBeenCalledOnce();
    expect(
      errorCode(
        validateNextEntry(proofEntry, verifiedContext, {
          term: 1,
          sequencer: original.sequencer.peerId,
          verifySystem: () => failure('bad-system-proof', 'Invalid proof'),
        }),
      ),
    ).toBe('bad-system-proof');
    expect(
      errorCode(
        validateNextEntry(proofEntry, verifiedContext, {
          term: 1,
          sequencer: original.sequencer.peerId,
          verifySystem: () => {
            throw new Error('malformed proof');
          },
        }),
      ),
    ).toBe('entry-verification-failed');
    expect(signed.sig).not.toBe(withEvidence.sig);
  });

  test('returns detached command and entry payloads after caller mutation', () => {
    const fixture = started();
    const original = setupCommand(fixture.context, fixture.sequencer.secretKey);
    const evidenceData = { nested: { marker: 'original' } };
    const body: CommandBody = {
      ...original.body,
      evidence: { protocol: 'spend', data: evidenceData },
    };
    const signed = signCommand(body, fixture.sequencer.secretKey);
    const validatedCommand = validateSignedCommand(signed, fixture.context);
    const input: Input = { kind: 'command', seat: 0, command: body.command };
    const entry = nextEntry(
      fixture.context,
      input,
      { kind: 'command', signed },
      fixture.sequencer.secretKey,
    );
    const accepted = validateNextEntry(entry, fixture.context, {
      ...fixture.policy,
      verifyCommand: () => success(undefined),
    });
    expect(validatedCommand.ok).toBe(true);
    expect(accepted.ok).toBe(true);
    if (!validatedCommand.ok || !accepted.ok) return;
    const vertex = validatedCommand.value.body.command.vertex;
    const originalSignature = signed.sig;
    evidenceData.nested.marker = 'tampered';
    body.command.vertex = 'bad-vertex';
    signed.sig = 'A'.repeat(86);
    entry.payload = { kind: 'membership', change: {} };
    expect(validatedCommand.value.body.command.vertex).toBe(vertex);
    expect(validatedCommand.value.body.evidence?.data).toEqual({ nested: { marker: 'original' } });
    expect(accepted.value.entry.payload).toMatchObject({
      kind: 'command',
      signed: {
        sig: originalSignature,
        body: { evidence: { data: { nested: { marker: 'original' } } } },
      },
    });
    expect(accepted.value.input).toMatchObject({ kind: 'command', command: { vertex } });
  });
});
