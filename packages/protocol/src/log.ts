import { hashValue, toHex } from '@cp2p/codec';
import { parsePeerId, verifyObject } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { GameEvent, GameState, Input, Result, Seat, Transition } from '@cp2p/engine';
import { entryBody, entryHash, genesisDigest } from './genesis.js';
import { captureCryptoPending, validateCryptoTransition } from './crypto-context.js';
import type { CryptoContext } from './crypto-context.js';
import { logEntrySchema } from './schemas.js';
import type { LogEntry, SystemEvidence } from './types.js';
import { parseCanonical } from './validation.js';
import { planHandTransition, verifyHandProofs } from './hand-transition.js';
import { completeCountHandPlan, verifyCountInput } from './count-reveal.js';
import { completeStealResult, verifyStealResult } from './steal-state.js';
import { firstCheatFindings, verifyCheatProof } from './cheat-proof.js';
import { validateCommandForEntry } from './command-validation.js';
import type { EntryPolicy, LogContext } from './log-types.js';
import { resolveArtifactSigner } from './authority.js';
import { seatSchema } from './schema-values.js';
import { validateRecoveryTransition } from './recovery-membership.js';
import type { SeatAuthorities } from './authority-types.js';
import type { RecoveryState } from './recovery-types.js';

export {
  signCommand,
  validateSignedCommand,
  validateCommandForEntry,
} from './command-validation.js';
export type { EntryPolicy, LogContext } from './log-types.js';

export interface ValidatedEntry {
  entry: LogEntry;
  hash: string;
  input: Input | null;
  state: GameState;
  events: readonly GameEvent[];
  lastNonces: ReadonlyMap<Seat, number>;
  crypto: CryptoContext | null;
  authority?: SeatAuthorities;
  recovery?: RecoveryState;
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

function entryInput(
  entry: LogEntry,
  context: LogContext,
  policy: EntryPolicy,
  crypto: CryptoContext | null,
): Result<{ input: Input; crypto: CryptoContext | null; applied?: Transition }> {
  const payload = entry.payload;
  if (payload.kind === 'genesis')
    return failure('duplicate-genesis', 'Genesis is only valid at sequence zero');
  if (payload.kind === 'membership')
    return failure('membership-unavailable', 'Membership changes need the membership verifier');
  if (payload.kind === 'control')
    return failure('control-unavailable', 'Control entries need the certified evidence verifier');
  if (payload.kind === 'crypto')
    return failure('crypto-unavailable', 'Crypto entries require built-in evidence verification');
  if (payload.kind === 'command') {
    const checked = validateCommandForEntry(payload.signed, { ...context, crypto }, policy);
    if (!checked.ok) return checked;
    return success({
      input: {
        kind: 'command',
        seat: checked.value.signed.body.seat,
        command: checked.value.signed.body.command,
      },
      crypto: checked.value.crypto,
      applied: checked.value.applied,
    });
  }
  if (payload.kind === 'cheat-proof')
    return failure('cheat-routing', 'Cheat records require protocol validation');
  if (payload.input.type === 'CARD_DEALT' && Object.hasOwn(payload.input, 'card'))
    return failure('private-card-in-log', 'Dealt card identities must be delivered privately');
  if (payload.input.type === 'SEAT_STATUS')
    return failure('membership-required', 'Seat status may change only through membership entries');
  if (context.genesis.security === 'verified' && payload.input.type === 'REVEAL_COUNT') {
    // The shared input path checks owner evidence even for built-in crypto results.
    // A generic system callback never authorizes this input.
    return success({ input: payload.input, crypto });
  }
  if (context.genesis.security === 'verified' && payload.input.type === 'STEAL_RESULT')
    return failure('steal-result-unverified', 'Verified steals require a certified signed receipt');
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
  return success({ input: payload.input, crypto });
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
  const sequencer = (context.authority?.controllers ?? context.genesis.seats).find(
    (seat) => seat.kind === 'human' && seat.publicKey === policy.sequencer,
  );
  if (!sequencer)
    return failure('sequencer-signature', 'Entry signature does not match the sequencer');
  const signer = resolveArtifactSigner(
    context.authority,
    context.genesis,
    context.crypto?.epoch ?? context.authority?.epoch ?? 0,
    sequencer.seat,
  );
  if (!signer.ok) return signer;
  if (!verifyObject('entry', entryBody(entry), entry.sig, parsePeerId(signer.value.publicKey)))
    return failure('sequencer-signature', 'Entry signature does not match the sequencer');
  if (
    context.recovery?.pending &&
    !['membership', 'control', 'cheat-proof'].includes(entry.payload.kind)
  )
    return failure('recovery-pending', 'Finish the certified takeover before resuming gameplay');
  try {
    const transition = validateCryptoTransition(
      context.genesis,
      context.crypto,
      context.engine,
      context.state,
      entry,
      policy.randomDerivations,
      context.authority,
    );
    if (!transition.ok) return transition;
    if (entry.payload.kind === 'membership') {
      const recovered = validateRecoveryTransition(
        entry.payload.change,
        entry,
        context,
        transition.value.crypto,
      );
      if (!recovered.ok) return recovered;
      return success({
        ...recovered.value,
        entry,
        hash: entryHash(entry),
        events: [],
        lastNonces: new Map(context.lastNonces),
      });
    }
    if (entry.payload.kind === 'cheat-proof') {
      const priorHash = toHex(hashValue(context.state));
      if (priorHash !== context.head.stateHash || entry.stateHash !== priorHash)
        return failure('cheat-state', 'Cheat records must preserve the certified public state');
      const claim = entry.payload.claim;
      if (
        claim.evidence.at.seq >= context.head.seq &&
        !(
          claim.evidence.at.seq === context.head.seq &&
          claim.evidence.at.hash === entryHash(context.head)
        )
      )
        return failure('cheat-history', 'Cheat evidence parent is not in this certified context');
      const finding =
        claim.evidence.at.seq === context.head.seq &&
        claim.evidence.at.hash === entryHash(context.head)
          ? verifyCheatProof(claim, context)
          : (policy.verifyHistoricalCheat?.(claim) ??
            failure('cheat-history', 'Certified evidence parent is unavailable'));
      if (!finding.ok) return finding;
      const crypto = transition.value.crypto;
      if (!crypto) return failure('cheat-context', 'Cheat records require verified crypto state');
      if (
        crypto.cheats.some(
          (item) => item.seat === finding.value.seat && item.kind === finding.value.kind,
        )
      )
        return failure('cheat-duplicate', 'A finding for this seat and kind is already certified');
      const cheats = firstCheatFindings(crypto.cheats, finding.value, context.genesis.config.seats);
      if (cheats.length !== crypto.cheats.length + 1)
        return failure('cheat-summary', 'Certified finding could not be recorded');
      return success({
        entry,
        hash: entryHash(entry),
        input: null,
        state: context.state,
        events: [],
        lastNonces: new Map(context.lastNonces),
        crypto: { ...crypto, cheats },
      });
    }
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
        crypto: transition.value.crypto,
      });
    }
    const selected: Result<{
      input: Input | null;
      crypto: CryptoContext | null;
      applied?: Transition;
    }> = transition.value.handled
      ? success({ input: transition.value.input, crypto: transition.value.crypto })
      : entryInput(entry, context, policy, transition.value.crypto);
    if (!selected.ok) return selected;
    const { input, crypto } = selected.value;
    if (input === null) {
      const priorHash = toHex(hashValue(context.state));
      if (priorHash !== context.head.stateHash || entry.stateHash !== priorHash)
        return failure('crypto-state', 'Cryptographic entries must preserve engine state');
      return success({
        entry,
        hash: entryHash(entry),
        input: null,
        state: context.state,
        events: [],
        lastNonces: new Map(context.lastNonces),
        crypto,
      });
    }
    if (crypto && input.kind === 'system' && input.type === 'REVEAL_COUNT') {
      if (entry.payload.kind !== 'system')
        return failure('count-evidence', 'Count inputs require system evidence');
      const seat = parseCanonical(input.seat, seatSchema);
      if (!seat.ok) return seat;
      const inputSigner = resolveArtifactSigner(
        context.authority,
        context.genesis,
        crypto.epoch,
        seat.value,
      );
      if (!inputSigner.ok) return inputSigner;
      const checked = verifyCountInput(
        crypto.counts,
        input,
        entry.payload.evidence,
        inputSigner.value,
      );
      if (!checked.ok) return checked;
    }
    if (
      context.genesis.security === 'verified' &&
      input.kind === 'system' &&
      input.type === 'STEAL_RESULT'
    ) {
      if (entry.payload.kind !== 'system')
        return failure('steal-result-evidence', 'Steal results require system evidence');
      const seat = parseCanonical(input.thief, seatSchema);
      if (!seat.ok) return seat;
      const inputSigner = resolveArtifactSigner(
        context.authority,
        context.genesis,
        crypto?.epoch ?? 0,
        seat.value,
      );
      if (!inputSigner.ok) return inputSigner;
      const checked = verifyStealResult(
        crypto?.steal ?? null,
        input,
        entry.payload.evidence,
        inputSigner.value,
      );
      if (!checked.ok) return checked;
    }
    const applied = selected.value.applied
      ? success(selected.value.applied)
      : context.engine.apply(context.state, input);
    if (!applied.ok) return applied;
    let committedCrypto = crypto;
    if (committedCrypto && input.kind === 'system' && input.type === 'STEAL_RESULT') {
      if (!committedCrypto.steal)
        return failure('steal-state-required', 'Steal result has no frozen operation');
      const completed = completeStealResult(
        committedCrypto.steal,
        committedCrypto.beacon,
        committedCrypto.hands,
        context.state,
        applied.value.state,
        applied.value.effects,
      );
      if (!completed.ok) return completed;
      committedCrypto = { ...committedCrypto, ...completed.value };
    } else if (committedCrypto && entry.payload.kind !== 'command') {
      const planned = planHandTransition(
        committedCrypto.hands,
        context.state,
        input,
        applied.value,
      );
      if (!planned.ok) return planned;
      if (input.kind === 'system' && input.type === 'REVEAL_COUNT') {
        if (!committedCrypto.counts)
          return failure('count-context-required', 'Count input has no frozen operation');
        const completed = completeCountHandPlan(committedCrypto.counts, planned.value);
        if (!completed.ok) return completed;
        committedCrypto = { ...committedCrypto, counts: completed.value };
      } else {
        const verified = verifyHandProofs(planned.value, [], {
          genesisDigest: genesisDigest(context.genesis),
          epoch: committedCrypto.epoch,
          anchor: { seq: context.head.seq, hash: entryHash(context.head) },
          command: null,
        });
        if (!verified.ok) return verified;
      }
      committedCrypto = { ...committedCrypto, hands: planned.value.hands };
    }
    if (entry.payload.kind !== 'command') {
      const violations = context.engine.checkInvariants(applied.value.state);
      if (violations.length !== 0)
        return failure('entry-state', 'Entry violates engine invariants', { violations });
    }
    if (entry.stateHash !== toHex(hashValue(applied.value.state)))
      return failure('state-hash', 'Entry and locally derived public state hashes differ');
    const captured =
      committedCrypto === null
        ? success(null)
        : captureCryptoPending(
            committedCrypto,
            context.genesis,
            context.engine,
            applied.value.state,
            { seq: entry.seq, hash: entryHash(entry) },
            policy.randomDerivations,
            context.authority,
          );
    if (!captured.ok) return captured;
    const lastNonces = new Map(context.lastNonces);
    if (entry.payload.kind === 'command') {
      const { seat, nonce } = entry.payload.signed.body;
      lastNonces.set(seat, nonce);
    }
    return success({
      entry,
      hash: entryHash(entry),
      input,
      state: applied.value.state,
      events: applied.value.events,
      lastNonces,
      crypto: captured.value,
    });
  } catch {
    return failure('entry-verification-failed', 'Entry proof or state derivation failed');
  }
}
