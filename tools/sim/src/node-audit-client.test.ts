import { hashValue, toHex } from '@cp2p/codec';
import { success } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { createVerifiedNetworkFixture, performVerifiedNetworkAudit } from '@cp2p/protocol/testing';
import type {
  VerifiedNetworkAuditRequest,
  VerifiedNetworkPrivateSnapshot,
} from '@cp2p/protocol/testing';
import {
  advanceContext,
  proposerFor,
  validateCertifiedEntry,
} from '../../../packages/protocol/src/proposal.js';
import type { CertifiedEntry } from '../../../packages/protocol/src/proposal.js';
import { replayCertifiedPrefix } from '../../../packages/protocol/src/replay.js';
import { entryHash, signEntry } from '../../../packages/protocol/src/genesis.js';
import { signVote } from '../../../packages/protocol/src/votes.js';
import { reconstructPrivateSeats } from '../../../packages/protocol/src/private-replay.js';
import { createVerifiedNetworkAuditJob } from './node-audit-client.js';

function auditJob(request: VerifiedNetworkAuditRequest) {
  return createVerifiedNetworkAuditJob(
    request,
    new URL('../dist/node-audit-worker.js', import.meta.url),
  );
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error('Fixture preparation failed');
  return result.value;
}

describe('Node independent audit worker', () => {
  test('matches synchronous audit and every owned snapshot on a certified deck prefix; rejects altered evidence and cancels', async () => {
    const fixture = createVerifiedNetworkFixture({ seed: 982 });
    try {
      const options = fixture.sessionOptions(0);
      let context = value(
        replayCertifiedPrefix(fixture.entry, [], fixture.engine, fixture.policy),
      ).context;
      const identity = (seat: 0 | 1 | 2) => {
        const found = fixture.identities.get(seat);
        if (!found) throw new Error('Missing identity');
        return found;
      };
      const entries: CertifiedEntry[] = [];
      for (const pass of options.deckSetupPasses ?? []) {
        const proposer = fixture.identities.get(
          proposerFor(context.log.head.seq + 1, 1, context.membership).seat,
        );
        if (!proposer) throw new Error('Missing proposer');
        const entry = signEntry(
          {
            seq: context.log.head.seq + 1,
            term: 1,
            prevHash: entryHash(context.log.head),
            payload: { kind: 'crypto', action: 'deck-pass', evidence: pass },
            stateHash: context.log.head.stateHash,
            sequencer: proposer.peerId,
          },
          proposer.secretKey,
        );
        const certified = {
          entry,
          certificate: ([0, 1, 2] as const).map((seat) =>
            signVote(
              {
                genesisDigest: context.membership.genesisDigest,
                epoch: 0,
                seat,
                seq: entry.seq,
                term: 1,
                phase: 'precommit',
                valueHash: entryHash(entry),
              },
              identity(seat).secretKey,
            ),
          ),
        };
        context = value(advanceContext(context, value(validateCertifiedEntry(certified, context))));
        entries.push(certified);
      }
      const snapshots: VerifiedNetworkPrivateSnapshot[] = [];
      const masters = fixture.mastersForAudit();
      const rebuilt = value(
        reconstructPrivateSeats({
          genesisEntry: fixture.entry,
          entries,
          engine: fixture.engine,
          policy: fixture.policy,
          secrets: masters,
          verifyPrivateState(seq, states) {
            snapshots.push({
              seq,
              seats: [...states]
                .map(([seat, state]) => [seat, toHex(hashValue(state))] as const)
                .toSorted(([a], [b]) => a - b),
            });
            return success(undefined);
          },
        }),
      );
      rebuilt.dispose();
      for (const item of masters) item.master.fill(0);
      // Recover only public transcripts from the signed genesis fixture policy inputs.
      const deckTranscripts = [
        ...new Set((options.deckSetupPasses ?? []).map((pass) => pass.deckId)),
      ].map((deckId) => ({
        deckId,
        passes: (options.deckSetupPasses ?? [])
          .filter((pass) => pass.deckId === deckId)
          .map((pass) => pass.pass),
      }));
      const request = (): VerifiedNetworkAuditRequest => ({
        genesisEntry: fixture.entry,
        entries,
        masters: fixture.mastersForAudit(),
        deckTranscripts,
        privateStates: { snapshots, digest: toHex(hashValue(snapshots)) },
      });
      const synchronousInput = request();
      const synchronous = performVerifiedNetworkAudit(synchronousInput);
      for (const item of synchronousInput.masters) item.master.fill(0);
      const input = request();
      const job = auditJob(input);
      expect(input.masters.every(({ master }) => master.every((byte) => byte === 0))).toBe(true);
      const worker = await job.result;
      expect(worker.report).toEqual(synchronous.report);
      expect(worker.checkedPrivateSequences).toBe(entries.length + 1);
      expect(worker.privateStateDigest).toBe(synchronous.privateStateDigest);
      // This bounded branch has certified setup, not a completed game.
      expect(worker.report.complete).toBe(false);
      const bad = request();
      const altered = snapshots.map((snapshot) => ({
        ...snapshot,
        seats: snapshot.seats.map(
          ([seat, hash]) =>
            [seat, snapshot.seq === 0 && seat === 0 ? '0'.repeat(64) : hash] as const,
        ),
      }));
      await expect(
        auditJob({
          ...bad,
          privateStates: { snapshots: altered, digest: toHex(hashValue(altered)) },
        }).result,
      ).rejects.toThrow('worker failed');
      const cancelled = auditJob(request());
      cancelled.cancel();
      await expect(cancelled.result).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      fixture.dispose();
    }
  }, 60_000);
});
