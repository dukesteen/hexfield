/* oxlint-disable vitest/no-standalone-expect -- The opt-in test alias still runs every assertion inside its test callback. */
import { writeFile } from 'node:fs/promises';
import { hashValue, toHex } from '@cp2p/codec';
import { scalarToBytes } from '@cp2p/crypto';
import { RandomBot, createBotRng } from '../../bots/src/index.js';
import type { GameState, Seat } from '@cp2p/engine';
import { expect, test } from 'vitest';
import { auditCertifiedGame } from './audit.js';
import type { AuditReport } from './audit-types.js';
import { genesisDigest } from './genesis.js';
import { PROTOCOL_VERSION } from './types.js';
import type { P2PSession, P2PSessionOptions } from './p2p-session.js';
import type { SessionAuditInput } from './session-audit-types.js';
import { createTerminalAuditFixture } from './testing/audit-fixture.js';
import type { VirtualClock } from './testing/virtual-clock.js';

interface AuditJob {
  input: SessionAuditInput;
  resolve: (report: AuditReport) => void;
}

async function settle(sessions: readonly P2PSession[], clock: VirtualClock): Promise<void> {
  for (let pass = 0; pass < 24; pass += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each pass delivers the next packet batch.
    await Promise.all(sessions.map((session) => session.flush()));
    clock.advanceBy(0);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Yield so long replay work does not starve Vitest.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const acceptanceTest = process.env.CP2P_BETA_GAME_ARTIFACT ? test : test.skip;

acceptanceTest(
  'one signed current-protocol default-ten-point game finishes and both peers independently audit it',
  async () => {
    const startedAt = performance.now();
    const bot = new RandomBot();
    const rng = createBotRng(new Uint8Array(32).fill(59));
    const optionsBySeat = new Map<Seat, P2PSessionOptions>();
    const jobs = new Map<Seat, AuditJob>();
    const reports = new Map<Seat, AuditReport>();
    const terminalStates = new Map<string, GameState>();
    const fixture = await createTerminalAuditFixture({
      defaultVpTarget: true,
      prioritizeDevBuy: false,
      maxElapsedMs: 480_000,
      yieldTask: () => new Promise<void>((resolve) => setImmediate(resolve)),
      onProgress(step, state) {
        process.stdout.write(
          `verified game: command ${step}, turn ${state.turn.number}, result ${!!state.result}\n`,
        );
      },
      chooseCommand(host, pending) {
        const priv = host.getPrivate(pending.seat);
        if (!priv) throw new Error('Game policy lacks its private seat');
        return bot.decide({ state: host.getState(), priv, seat: pending.seat }, pending, rng);
      },
      sessionOptions(options) {
        const records = new Map<string, Uint8Array>();
        const prepared: P2PSessionOptions = {
          ...options,
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
              return scalarToBytes(BigInt(17 + seat));
            },
          },
          auditRunner(input) {
            let resolve!: (report: AuditReport) => void;
            const result = new Promise<AuditReport>((done) => {
              resolve = done;
            });
            jobs.set(options.seat, { input, resolve });
            return { result, cancel() {} };
          },
        };
        optionsBySeat.set(options.seat, prepared);
        return prepared;
      },
      async onTerminal(sessions, clock) {
        const state = sessions[0]?.getState();
        if (state) terminalStates.set('terminal', state);
        for (let retry = 0; retry < 12 && jobs.size < sessions.length; retry += 1) {
          clock.advanceBy(2_000);
          // oxlint-disable-next-line eslint/no-await-in-loop -- Reveal delivery is driven by each clock tick.
          await settle(sessions, clock);
        }
        expect(jobs.size).toBe(sessions.length);
        for (const session of sessions) {
          const seat = session.controllableSeats()[0];
          if (seat === undefined) throw new Error('Missing human session seat');
          const job = jobs.get(seat);
          const options = optionsBySeat.get(seat);
          if (!job || !options) throw new Error('Missing independent audit job');
          // oxlint-disable-next-line eslint/no-await-in-loop -- Let the test runner process I/O before each full replay.
          await new Promise<void>((resolve) => setImmediate(resolve));
          const report = auditCertifiedGame({
            ...job.input,
            engine: options.engine,
            policy: options.policy,
          });
          reports.set(seat, report);
          job.resolve(report);
          // oxlint-disable-next-line eslint/no-await-in-loop -- The session must install its own report.
          await settle(sessions, clock);
        }
        for (const session of sessions) {
          const audit = session.getAudit();
          expect(audit.kind).toBe('complete');
          if (audit.kind !== 'complete') throw new Error('Session audit did not complete');
          expect(audit.report).toMatchObject({
            ok: true,
            complete: true,
            missingSeats: [],
            violations: [],
            inputErrors: [],
            cheatFindings: [],
            historyError: null,
            auditError: null,
          });
        }
      },
    });

    if (fixture.genesisEntry.payload.kind !== 'genesis') throw new Error('Missing signed genesis');
    const genesis = fixture.genesisEntry.payload.genesis;
    expect(genesis.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(genesis.security).toBe('verified');
    expect(genesis.config.options.base).toEqual({ mapLayout: 'random' });
    expect(genesis.commitments.onlineStart).toBeDefined();
    const terminalState = terminalStates.get('terminal');
    if (!terminalState?.result) throw new Error('Certified game has no terminal result');
    expect(reports.size).toBe(2);
    const reportHashes = [...reports.entries()]
      .toSorted(([left], [right]) => left - right)
      .map(([seat, report]) => ({ seat, digest: toHex(hashValue(report)) }));
    expect(reportHashes[0]?.digest).toBe(reportHashes[1]?.digest);
    const commands: Record<string, number> = {};
    for (const certified of fixture.entries) {
      const { payload } = certified.entry;
      expect(payload.kind).not.toBe('cheat-proof');
      if (payload.kind === 'command') {
        const type = payload.signed.body.command.type;
        commands[type] = (commands[type] ?? 0) + 1;
      }
    }
    const artifact = {
      protocolVersion: genesis.protocolVersion,
      engineVersion: genesis.engineVersion,
      security: genesis.security,
      config: genesis.config,
      genesisDigest: genesisDigest(genesis),
      finalHead: reports.get(0)?.finalHead,
      terminal: reports.get(0)?.terminal,
      result: terminalState.result,
      turn: terminalState.turn.number,
      certifiedEntries: fixture.entries.length,
      commandCount: Object.values(commands).reduce((sum, count) => sum + count, 0),
      commands,
      commandBreakdownDigest: toHex(hashValue(commands)),
      cheatProofCount: 0,
      auditReportDigests: reportHashes,
      elapsedMs: Math.round(performance.now() - startedAt),
    };
    const artifactPath = process.env.CP2P_BETA_GAME_ARTIFACT;
    if (artifactPath) await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
    process.stdout.write(
      `verified game complete: ${JSON.stringify({ ...artifact, commands: undefined })}\n`,
    );
  },
  600_000,
);
