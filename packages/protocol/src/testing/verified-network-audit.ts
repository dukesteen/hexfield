import { hashValue, toHex } from '@cp2p/codec';
import { createCatalogueEngine, failure, success } from '@cp2p/engine';
import type { Seat } from '@cp2p/engine';
import { auditCertifiedGame } from '../audit.js';
import type { AuditReport } from '../audit-types.js';
import { validateDeckCeremony } from '../deck-genesis.js';
import { reconstructPrivateSeats } from '../private-replay.js';
import type { SessionAuditInput } from '../session-audit-types.js';
import type { DeckTranscript } from './deck-fixture.js';

declare const performance: { now(): number };

export interface VerifiedNetworkPrivateSnapshot {
  readonly seq: number;
  readonly seats: readonly (readonly [Seat, string])[];
}
export interface VerifiedNetworkAuditRequest extends SessionAuditInput {
  readonly deckTranscripts: readonly DeckTranscript[];
  readonly privateStates?: {
    readonly snapshots: readonly VerifiedNetworkPrivateSnapshot[];
    readonly digest: string;
  };
}
export interface VerifiedNetworkAuditResult {
  readonly report: AuditReport;
  readonly checkedPrivateSequences: number;
  readonly privateStateDigest: string | null;
  readonly privateComparisonMilliseconds: number;
}
export interface VerifiedNetworkAuditJob {
  readonly result: Promise<VerifiedNetworkAuditResult>;
  cancel(): void;
}

/** Uses only terminal-authorized masters supplied by the caller. */
export function performVerifiedNetworkAudit(
  input: VerifiedNetworkAuditRequest,
): VerifiedNetworkAuditResult {
  const engine = createCatalogueEngine();
  const policy = {
    genesis: {
      verifyCommitments: (candidate: Parameters<typeof validateDeckCeremony>[0]) =>
        validateDeckCeremony(candidate, input.deckTranscripts),
    },
    entry: {},
  };
  let checkedPrivateSequences = 0;
  let privateComparisonMilliseconds = 0;
  const expected = input.privateStates;
  if (expected) {
    const started = performance.now();
    if (
      expected.snapshots.length !== input.entries.length + 1 ||
      toHex(hashValue(expected.snapshots)) !== expected.digest ||
      expected.snapshots.some(
        (snapshot, seq) =>
          snapshot.seq !== seq ||
          snapshot.seats.length !== 4 ||
          snapshot.seats.some(
            ([seat, hash], index) => seat !== index || !/^[0-9a-f]{64}$/.test(hash),
          ),
      )
    )
      throw new Error('fixture-live-private-state: Invalid owned snapshot evidence');
    const rebuilt = reconstructPrivateSeats({
      ...input,
      engine,
      policy,
      secrets: input.masters,
      verifyPrivateState(seq, states) {
        const snapshot = expected.snapshots[seq];
        if (
          seq !== checkedPrivateSequences ||
          !snapshot ||
          states.size !== 4 ||
          snapshot.seats.some(([seat, hash]) => {
            const state = states.get(seat);
            return !state || toHex(hashValue(state)) !== hash;
          })
        )
          return failure(
            'fixture-live-private-state',
            'Live owned state differs from terminal reconstruction',
            { seq },
          );
        checkedPrivateSequences++;
        return success(undefined);
      },
    });
    if (!rebuilt.ok) throw new Error(`${rebuilt.error.code}: ${rebuilt.error.message}`);
    rebuilt.value.dispose();
    if (checkedPrivateSequences !== expected.snapshots.length)
      throw new Error('fixture-live-private-state: Reconstruction omitted a certified sequence');
    privateComparisonMilliseconds = performance.now() - started;
  }
  return {
    report: auditCertifiedGame({ ...input, engine, policy }),
    checkedPrivateSequences,
    privateStateDigest: expected?.digest ?? null,
    privateComparisonMilliseconds,
  };
}
