import { scalarToBytes } from '@cp2p/crypto';
import { RandomBot, createBotRng } from '../../bots/src/index.js';
import type { Seat } from '@cp2p/engine';
import { expect, test } from 'vitest';
import { auditCertifiedGame } from './audit.js';
import type { AuditReport } from './audit-types.js';
import { decodeProtocolMessage } from './messages.js';
import { P2PSession } from './p2p-session.js';
import type { P2PSessionOptions } from './p2p-session.js';
import type { SessionAuditInput } from './session-audit-types.js';
import { createTerminalAuditFixture } from './testing/audit-fixture.js';
import type { VirtualClock } from './testing/virtual-clock.js';

async function settle(sessions: readonly P2PSession[], clock: VirtualClock): Promise<void> {
  for (let index = 0; index < 32; index += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Deliver each queued batch before the next clock step.
    await Promise.all(sessions.map((session) => session.flush()));
    clock.advanceBy(0);
  }
}

test('finished sessions retry reveals, audit separately and cancel a closing worker', async () => {
  const bot = new RandomBot();
  const rng = createBotRng(new Uint8Array(32).fill(59));
  let dropReveals = true;
  let sourceCalls = 0;
  const relayedMasters: { relay: Seat; publisher: Seat }[] = [];
  const sourceHeads: number[] = [];
  const optionsBySeat = new Map<Seat, P2PSessionOptions>();
  const jobs = new Map<
    Seat,
    { input: SessionAuditInput; resolve: (report: AuditReport) => void; cancelled: boolean }
  >();
  await createTerminalAuditFixture({
    yieldTask: () => new Promise<void>((resolve) => setImmediate(resolve)),
    chooseCommand(host, pending) {
      const priv = host.getPrivate(pending.seat);
      if (!priv) throw new Error('Audit bot lacks its private seat');
      return bot.decide({ state: host.getState(), priv, seat: pending.seat }, pending, rng);
    },
    sessionOptions(options) {
      const records = new Map<string, Uint8Array>();
      const prepared: P2PSessionOptions = {
        ...options,
        transport: {
          self: options.transport.self,
          peers: () => options.transport.peers(),
          send: (to, bytes) => options.transport.send(to, bytes),
          onMessage: (listener) => options.transport.onMessage(listener),
          onPeerChange: (listener) => options.transport.onPeerChange(listener),
          disconnect: (peer) => options.transport.disconnect(peer),
          broadcast(bytes) {
            const decoded = decodeProtocolMessage(bytes);
            if (dropReveals && decoded.ok && decoded.value.t === 'MASTER_REVEAL') return;
            if (
              decoded.ok &&
              decoded.value.t === 'MASTER_REVEAL' &&
              decoded.value.reveal.body.publisherSeat !== options.seat
            )
              relayedMasters.push({
                relay: options.seat,
                publisher: decoded.value.reveal.body.publisherSeat,
              });
            options.transport.broadcast(bytes);
          },
        },
        masterReveal: {
          store: {
            async load(id) {
              return records.get(id)?.slice() ?? null;
            },
            async putIfAbsent(id, bytes) {
              if (records.has(id)) return false;
              records.set(id, bytes.slice());
              return true;
            },
          },
          async loadOwnedMaster(seat) {
            sourceCalls += 1;
            const record = await options.journal.load();
            sourceHeads.push(record?.entries.at(-1)?.entry.seq ?? 0);
            return scalarToBytes(BigInt(17 + seat));
          },
        },
        auditRunner(input) {
          let resolve!: (report: AuditReport) => void;
          const result = new Promise<AuditReport>((done) => {
            resolve = done;
          });
          const job = { input, resolve, cancelled: false };
          jobs.set(options.seat, job);
          return {
            result,
            cancel() {
              job.cancelled = true;
            },
          };
        },
      };
      optionsBySeat.set(options.seat, prepared);
      return prepared;
    },
    async onTerminal(sessions, clock) {
      await settle(sessions, clock);
      expect(sourceCalls).toBe(4);
      expect(jobs.size).toBe(0);
      for (const session of sessions) {
        expect(session.getAudit()).toMatchObject({ kind: 'awaiting-reveals' });
        expect(session.getState().result).not.toBeNull();
        expect(sourceHeads.every((seq) => seq === session.getCommittedHead().seq)).toBe(true);
      }
      const first = sessions[0];
      const second = sessions[1];
      const firstOptions = optionsBySeat.get(0);
      if (!first || !second || !firstOptions) throw new Error('Missing live audit sessions');
      const certifiedResult = first.getState().result;
      dropReveals = false;
      clock.advanceBy(2_000);
      await settle(sessions, clock);
      clock.advanceBy(2_000);
      await settle(sessions, clock);
      expect(relayedMasters).toContainEqual({ relay: 1, publisher: 0 });
      expect(sourceCalls).toBe(4);
      expect(jobs.size).toBe(2);
      expect(sessions.map((session) => session.getAudit().kind)).toEqual([
        'verifying',
        'verifying',
      ]);
      const firstJob = jobs.get(0);
      const secondJob = jobs.get(1);
      if (!firstJob || !secondJob) throw new Error('Missing audit jobs');
      const report = auditCertifiedGame({
        ...firstJob.input,
        engine: firstOptions.engine,
        policy: firstOptions.policy,
      });
      expect(report.ok).toBe(true);
      firstJob.resolve(report);
      await settle(sessions, clock);
      expect(first.getAudit()).toEqual({ kind: 'complete', report });
      expect(first.getState().result).toEqual(certifiedResult);
      expect(firstJob.input.masters.every(({ master }) => master.every((byte) => byte === 0))).toBe(
        true,
      );
      second.dispose();
      expect(secondJob.cancelled).toBe(true);
      expect(
        secondJob.input.masters.every(({ master }) => master.every((byte) => byte === 0)),
      ).toBe(true);
      secondJob.resolve(report);
      await settle(sessions, clock);
      expect(second.getAudit().kind).toBe('verifying');
      expect(
        secondJob.input.masters.every(({ master }) => master.every((byte) => byte === 0)),
      ).toBe(true);
      const secondOptions = optionsBySeat.get(1);
      if (!secondOptions) throw new Error('Missing second session options');
      const emptyReveals = new Map<string, Uint8Array>();
      const relayRestored = await P2PSession.restore({
        ...secondOptions,
        masterReveal: {
          store: {
            async load(id) {
              return emptyReveals.get(id)?.slice() ?? null;
            },
            async putIfAbsent(id, bytes) {
              if (emptyReveals.has(id)) return false;
              emptyReveals.set(id, bytes.slice());
              return true;
            },
          },
          // The original publisher is closed and its reveal sidecar is unavailable.
          // The survivor must relay the retained, already signed original packet.
          async loadOwnedMaster() {
            return null;
          },
        },
        auditRunner: () => ({ result: Promise.resolve(report), cancel() {} }),
      });
      if (!relayRestored.ok) throw new Error(relayRestored.error.code);
      try {
        clock.advanceBy(2_000);
        await settle([first, relayRestored.value], clock);
        expect(relayRestored.value.getAudit()).toEqual({ kind: 'complete', report });
        expect(emptyReveals.size).toBeGreaterThan(0);
      } finally {
        relayRestored.value.dispose();
      }
      first.dispose();
      let failNextAudit = true;
      const restored = await P2PSession.restore({
        ...firstOptions,
        auditRunner: () => ({
          result: failNextAudit
            ? Promise.reject(new Error('Worker unavailable'))
            : Promise.resolve(report),
          cancel() {},
        }),
      });
      if (!restored.ok) throw new Error(restored.error.code);
      try {
        await settle([restored.value], clock);
        expect(sourceCalls).toBe(4);
        expect(restored.value.getAudit()).toEqual({ kind: 'error', code: 'audit-worker' });
        failNextAudit = false;
        expect(restored.value.retryAudit()).toBe(true);
        await settle([restored.value], clock);
        expect(restored.value.getAudit()).toEqual({ kind: 'complete', report });
        expect(restored.value.getState().result).toEqual(certifiedResult);
      } finally {
        restored.value.dispose();
      }
      // A worker may reject history that the live session accepted under another
      // policy. Preserve that audit outcome even when replay never reaches a result.
      const rejectedHistory = auditCertifiedGame({
        ...firstJob.input,
        entries: firstJob.input.entries.map((item, index) =>
          index === 0 ? { ...item, certificate: [] } : item,
        ),
        engine: firstOptions.engine,
        policy: firstOptions.policy,
      });
      expect(rejectedHistory.historyError).not.toBeNull();
      expect(rejectedHistory.terminal).toBeNull();
      expect(rejectedHistory.finalHead).toBeNull();
      const failedAudit = await P2PSession.restore({
        ...firstOptions,
        auditRunner: () => ({ result: Promise.resolve(rejectedHistory), cancel() {} }),
      });
      if (!failedAudit.ok) throw new Error(failedAudit.error.code);
      try {
        await settle([failedAudit.value], clock);
        expect(failedAudit.value.getAudit()).toEqual({ kind: 'complete', report: rejectedHistory });
        expect(failedAudit.value.getState().result).toEqual(certifiedResult);
      } finally {
        failedAudit.value.dispose();
      }
    },
  });
  expect(sourceCalls).toBe(4);
}, 180_000);
