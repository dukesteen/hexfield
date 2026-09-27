import type { Seat } from '@cp2p/engine';
import type { CheatFinding } from './cheat-types.js';

export interface AuditEntryRef {
  readonly seq: number;
  readonly hash: string;
}

/** An authenticated inconsistency. A null seat makes no accusation about an owner. */
export interface AuditViolation {
  readonly seq: number;
  readonly seat: Seat | null;
  readonly kind: string;
  readonly detail: string;
}

/** Problems with supplied reveals are not findings against the original owner. */
export interface AuditInputError {
  readonly seat: Seat | null;
  readonly kind: string;
}

export interface AuditReport {
  readonly ok: boolean;
  readonly complete: boolean;
  readonly missingSeats: readonly Seat[];
  readonly violations: readonly AuditViolation[];
  readonly inputErrors: readonly AuditInputError[];
  readonly cheatFindings: readonly CheatFinding[];
  readonly terminal: AuditEntryRef | null;
  readonly finalHead: AuditEntryRef | null;
  readonly historyError: { readonly code: string } | null;
  /** Local reconstruction or engine failure, without attributing misconduct. */
  readonly auditError: { readonly seq: number; readonly code: string } | null;
}
