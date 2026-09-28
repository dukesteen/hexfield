import { createCatalogueEngine, success } from '@cp2p/engine';
import { auditCertifiedGame, validateDeckGenesisCommitments } from '@cp2p/protocol';
import type { AuditReport, ReplayPolicy, SessionAuditInput } from '@cp2p/protocol';

export const baseAuditPolicy: ReplayPolicy = {
  genesis: {
    verifyCommitments(genesis) {
      const checked = validateDeckGenesisCommitments(genesis);
      return checked.ok ? success(undefined) : checked;
    },
  },
  // Built-in crypto transitions validate supported system evidence. Unknown
  // callback-only proof evidence remains rejected by replay.
  entry: {},
};

export interface AuditWorkerRequest extends SessionAuditInput {
  readonly id: number;
}

export type AuditWorkerResponse =
  | { readonly id: number; readonly report: AuditReport }
  | { readonly id: number; readonly error: string };

export function performAuditRequest(request: AuditWorkerRequest): AuditReport {
  return auditCertifiedGame({
    genesisEntry: request.genesisEntry,
    entries: request.entries,
    masters: request.masters,
    engine: createCatalogueEngine(),
    policy: baseAuditPolicy,
  });
}
