import { hashValue, toHex } from '@cp2p/codec';
import { parsePeerId, signObject, verifyObject } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Engine, GameEvent, GameState, Input, Result, Seat } from '@cp2p/engine';
import { entryBody, entryHash, genesisDigest } from './genesis.js';
import { logEntrySchema, signedCommandSchema } from './schemas.js';
import type { PeerId } from './transport.js';
import type {
  CommandBody,
  ExcludeProposerControl,
  Genesis,
  LogEntry,
  SignedCommand,
  SystemEvidence,
} from './types.js';
import { parseCanonical } from './validation.js';

export interface LogContext {
  genesis: Genesis;
  engine: Engine;
  head: LogEntry;
  state: GameState;
  lastNonces: ReadonlyMap<Seat, number>;
}

export interface EntryPolicy {
  /** Derived from the agreed height/round, never from an incoming entry. */
  term: number;
  sequencer: PeerId;
  /** Simulation opt-in; stub evidence binds inputs but cannot prove hidden facts or deadlines. */
  allowStub?: boolean;
  verifyCommand?: (command: SignedCommand, context: LogContext) => Result<void>;
  verifySystem?: (
    input: Extract<Input, { kind: 'system' }>,
    evidence: SystemEvidence,
    context: LogContext,
  ) => Result<void>;
  verifyControl?: (control: ExcludeProposerControl, context: LogContext) => Result<void>;
}

export interface ValidatedEntry {
  entry: LogEntry;
  hash: string;
  input: Input | null;
  state: GameState;
  events: readonly GameEvent[];
  lastNonces: ReadonlyMap<Seat, number>;
}

export function signCommand(body: CommandBody, secretKey: Uint8Array): SignedCommand {
  return { body, sig: signObject('cmd', body, secretKey) };
}

/** A delayed command cannot be applied to a different parent or later turn. */
export function validateSignedCommand(value: unknown, context: LogContext): Result<SignedCommand> {
  const parsed = parseCanonical(value, signedCommandSchema);
  if (!parsed.ok) return parsed;
  const signed = parsed.value;
  const { body } = signed;
  if (
    body.gameId !== context.genesis.gameId ||
    body.genesisDigest !== genesisDigest(context.genesis)
  )
    return failure('wrong-game', 'Command belongs to another game');
  const owner = context.genesis.seats.find((seat) => seat.seat === body.seat);
  if (!owner) return failure('unknown-seat', 'Command has no genesis seat');
  if (!verifyObject('cmd', body, signed.sig, parsePeerId(owner.publicKey)))
    return failure('command-signature', 'Command signature does not match its seat');
  if (body.nonce <= (context.lastNonces.get(body.seat) ?? 0))
    return failure('replayed-nonce', 'Command nonce has already been applied');
  if (body.headSeq > context.head.seq)
    return failure('future-head', 'Command refers to a log head not yet available');
  if (body.headSeq < context.head.seq)
    return failure('stale-head', 'Command must be confirmed again against the current state');
  if (body.headHash !== entryHash(context.head))
    return failure('command-parent', 'Command refers to a different log parent');
  const valid = context.engine.validate(context.state, {
    kind: 'command',
    seat: body.seat,
    command: body.command,
  });
  return valid.ok ? success(signed) : valid;
}

/** Binds simulation evidence to exactly one game, parent and system input. */
export function stubEvidence(context: LogContext, input: Input): SystemEvidence {
  return {
    kind: 'stub',
    context: toHex(
      hashValue({ gameId: context.genesis.gameId, parent: entryHash(context.head), input }),
    ),
  };
}

function entryInput(entry: LogEntry, context: LogContext, policy: EntryPolicy): Result<Input> {
  const payload = entry.payload;
  if (payload.kind === 'genesis')
    return failure('duplicate-genesis', 'Genesis is only valid at sequence zero');
  if (payload.kind === 'membership')
    return failure('membership-unavailable', 'Membership changes need the membership verifier');
  if (payload.kind === 'control')
    return failure('control-unavailable', 'Control entries need the certified evidence verifier');
  if (payload.kind === 'command') {
    const command = validateSignedCommand(payload.signed, context);
    if (!command.ok) return command;
    if (context.genesis.security === 'verified' || command.value.body.evidence !== undefined) {
      if (!policy.verifyCommand)
        return failure('command-proof-unavailable', 'Command proof verification is unavailable');
      const proof = policy.verifyCommand(command.value, context);
      if (!proof.ok) return proof;
    }
    return success({
      kind: 'command',
      seat: command.value.body.seat,
      command: command.value.body.command,
    });
  }
  if (payload.input.type === 'CARD_DEALT' && Object.hasOwn(payload.input, 'card'))
    return failure('private-card-in-log', 'Dealt card identities must be delivered privately');
  if (payload.input.type === 'SEAT_STATUS')
    return failure('membership-required', 'Seat status may change only through membership entries');
  if (payload.evidence.kind === 'stub') {
    if (context.genesis.security !== 'stub' || !policy.allowStub)
      return failure('stub-forbidden', 'Stub evidence is forbidden in this session');
    const expected = stubEvidence(context, payload.input);
    if (expected.kind !== 'stub' || payload.evidence.context !== expected.context)
      return failure('stub-context', 'Stub evidence belongs to another input or parent');
  } else {
    if (context.genesis.security !== 'verified' || !policy.verifySystem)
      return failure('system-proof-unavailable', 'System proof verification is unavailable');
    const proof = policy.verifySystem(payload.input, payload.evidence, context);
    if (!proof.ok) return proof;
  }
  return success(payload.input);
}

/**
 * Validate and derive a next state without mutating the caller's log or nonces.
 * A rejection alone is not accusation evidence: the session must first establish
 * the entry's parent and election context, and distinguish local desync.
 */
export function validateNextEntry(
  value: unknown,
  context: LogContext,
  policy: EntryPolicy,
): Result<ValidatedEntry> {
  if (context.genesis.security === 'stub' && !policy.allowStub)
    return failure('stub-forbidden', 'Stub genesis is forbidden in this session');
  const parsed = parseCanonical(value, logEntrySchema);
  if (!parsed.ok) return parsed;
  const entry = parsed.value;
  if (entry.seq <= context.head.seq) return failure('stale-entry', 'Entry was already superseded');
  if (entry.seq !== context.head.seq + 1)
    return failure('missing-ancestor', 'Fetch missing log entries before validating this entry');
  if (entry.term !== policy.term || entry.sequencer !== policy.sequencer)
    return failure('wrong-term', 'Entry does not belong to the verified sequencer term');
  if (entry.prevHash !== entryHash(context.head))
    return failure('previous-hash', 'Entry does not extend this log prefix');
  const sequencer = context.genesis.seats.find(
    (seat) => seat.kind === 'human' && seat.publicKey === policy.sequencer,
  );
  if (
    !sequencer ||
    !verifyObject('entry', entryBody(entry), entry.sig, parsePeerId(sequencer.publicKey))
  )
    return failure('sequencer-signature', 'Entry signature does not match the sequencer');
  try {
    if (entry.payload.kind === 'control') {
      if (!policy.verifyControl)
        return failure(
          'control-unavailable',
          'Control entries need the certified evidence verifier',
        );
      const verified = policy.verifyControl(entry.payload, context);
      if (!verified.ok) return verified;
      const priorHash = toHex(hashValue(context.state));
      if (priorHash !== context.head.stateHash || entry.stateHash !== priorHash)
        return failure(
          'control-state',
          'Protocol control must preserve the certified public state',
        );
      return success({
        entry,
        hash: entryHash(entry),
        input: null,
        state: context.state,
        events: [],
        lastNonces: new Map(context.lastNonces),
      });
    }
    const input = entryInput(entry, context, policy);
    if (!input.ok) return input;
    const applied = context.engine.apply(context.state, input.value);
    if (!applied.ok) return applied;
    const violations = context.engine.checkInvariants(applied.value.state);
    if (violations.length !== 0)
      return failure('entry-state', 'Entry violates engine invariants', { violations });
    if (entry.stateHash !== toHex(hashValue(applied.value.state)))
      return failure('state-hash', 'Entry and locally derived public state hashes differ');
    const lastNonces = new Map(context.lastNonces);
    if (entry.payload.kind === 'command') {
      const { seat, nonce } = entry.payload.signed.body;
      lastNonces.set(seat, nonce);
    }
    return success({
      entry,
      hash: entryHash(entry),
      input: input.value,
      state: applied.value.state,
      events: applied.value.events,
      lastNonces,
    });
  } catch {
    return failure('entry-verification-failed', 'Entry proof or state derivation failed');
  }
}
