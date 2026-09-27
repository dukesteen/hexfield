import type { Seat } from '@cp2p/engine';
import type { AuditReport } from './audit-types.js';
import type { CertifiedEntry } from './proposal.js';
import type { LogEntry } from './types.js';

/** Each invocation owns these master buffers and must erase or transfer them. */
export interface SessionAuditInput {
  readonly genesisEntry: LogEntry;
  readonly entries: readonly CertifiedEntry[];
  readonly masters: readonly { readonly seat: Seat; readonly master: Uint8Array }[];
}

/** Browser callers run the audit in a worker; protocol tests may inject a local runner. */
export interface SessionAuditJob {
  readonly result: Promise<AuditReport>;
  cancel(): void;
}
export type SessionAuditRunner = (input: SessionAuditInput) => SessionAuditJob;

/** This report is separate from the certified engine result. */
export type SessionAuditState =
  | { readonly kind: 'not-started' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'awaiting-reveals'; readonly missingSeats: readonly Seat[] }
  | { readonly kind: 'verifying' }
  | { readonly kind: 'complete'; readonly report: AuditReport }
  | { readonly kind: 'error'; readonly code: string };
