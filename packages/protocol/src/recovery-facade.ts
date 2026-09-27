import { hashValue, toHex } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import { entryHash } from './genesis.js';
import type { LogContext } from './log-types.js';
import { recoveryChangeSchema, validateRecoveryTransition } from './recovery-membership.js';
import type { RecoveryAuthorization } from './recovery-types.js';
import type { LogEntry } from './types.js';
import { parseCanonical } from './validation.js';

export interface RecoveryApprovalPreview {
  readonly parent: { readonly seq: number; readonly hash: string };
  readonly statementHash: string;
  readonly departedSeat: Seat;
  readonly hostSeat: Seat;
  readonly botLevel: 'easy' | 'medium' | 'hard';
  readonly amendment: boolean;
  readonly affectedSeats: readonly Seat[];
  readonly recoverers: readonly Seat[];
  readonly canApprove: boolean;
}

export interface RecoveryApprovalCandidate {
  readonly change: RecoveryAuthorization;
  readonly preview: RecoveryApprovalPreview;
}

/** A local UI preview only; an actual proposal still runs full signed-entry validation. */
export function previewRecoveryAuthorization(
  value: unknown,
  context: LogContext,
  localSeat: Seat,
): Result<RecoveryApprovalCandidate> {
  const parsed = parseCanonical(value, recoveryChangeSchema);
  if (!parsed.ok) return parsed;
  if (parsed.value.kind !== 'recovery-authorize')
    return failure('recovery-preview-kind', 'Only a takeover authorization needs user approval');
  if (!Number.isSafeInteger(context.head.seq + 1))
    return failure('recovery-preview-height', 'Certified height cannot advance');
  const parent = { seq: context.head.seq, hash: entryHash(context.head) };
  // The membership validator needs an entry ref to derive the prospective transition.
  // No provisional signature is transmitted or accepted as a certified entry.
  const provisional: LogEntry = {
    ...context.head,
    seq: context.head.seq + 1,
    prevHash: parent.hash,
    payload: { kind: 'membership', change: parsed.value },
    stateHash: context.head.stateHash,
  };
  const checked = validateRecoveryTransition(parsed.value, provisional, context, context.crypto);
  if (!checked.ok) return checked;
  const statement = parsed.value.statement;
  const amendment = context.recovery?.pending !== null && context.recovery?.pending !== undefined;
  if (!amendment) {
    const canonicalHost = context.authority?.controllers
      .filter(
        (item) =>
          item.kind === 'human' && item.status === 'active' && item.seat !== statement.departedSeat,
      )
      .map((item) => item.seat)
      .toSorted((a, b) => a - b)[0];
    if (canonicalHost !== statement.hostSeat)
      return failure('recovery-preview-host', 'A different surviving seat initiates this takeover');
  }
  const local = context.authority?.controllers.find((item) => item.seat === localSeat);
  const preview: RecoveryApprovalPreview = {
    parent,
    statementHash: toHex(hashValue(statement)),
    departedSeat: statement.departedSeat,
    hostSeat: statement.hostSeat,
    botLevel: statement.botLevel,
    amendment,
    affectedSeats: statement.replacements.map((item) => item.seat),
    recoverers: statement.recoverers.map((item) => item.seat),
    canApprove:
      local?.kind === 'human' && local.status === 'active' && local.seat !== statement.departedSeat,
  };
  return success({ change: parsed.value, preview });
}
