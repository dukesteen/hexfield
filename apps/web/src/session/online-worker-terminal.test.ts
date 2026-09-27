import { RandomBot, createBotRng } from '@cp2p/bots';
import { canonicalEncode } from '@cp2p/codec';
import { scalarToBytes } from '@cp2p/crypto';
import { writeFile } from 'node:fs/promises';
import type { Seat } from '@cp2p/engine';
import { validateGenesisEntry } from '@cp2p/protocol';
import type { AuditReport, Genesis, P2PSession, SessionAuditInput } from '@cp2p/protocol';
import { MemoryEscrowLifecycleStore, createTerminalAuditFixture } from '@cp2p/protocol/testing';
import { expect, test } from 'vitest';
import { createSessionAuditJob } from './audit-worker-client.js';
import { performAuditRequest } from './audit-worker-job.js';
import type { AuditWorkerRequest } from './audit-worker-job.js';
import { OnlineWorkerClient } from './online-worker-client.js';
import type { OnlineProtocolWorkerPort } from './online-worker-client.js';
import type { OnlineWorkerEvent, OnlineWorkerRequest } from './online-worker-messages.js';
import { OnlineWorkerRuntime } from './online-worker-runtime.js';
import { OnlineWorkerSession } from './online-worker-session.js';

/** Executes the real audit request handler across the production job RPC boundary. */
class InProcessAuditPort {
  private readonly listeners = new Set<EventListener>();
  private stopped = false;

  postMessage(message: unknown, transfer?: Transferable[]): void {
    const request = structuredClone(message, transfer ? { transfer } : {});
    const id = typeof request === 'object' && request !== null ? Reflect.get(request, 'id') : 0;
    queueMicrotask(() => {
      if (this.stopped) return;
      try {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The production handler validates this request before using its contents.
        const report = performAuditRequest(request as AuditWorkerRequest);
        this.emit({ id, report });
      } catch {
        this.emit({ id, error: 'Audit worker failed' });
      }
    });
  }

  addEventListener(type: string, listener: EventListener): void {
    if (type === 'message') this.listeners.add(listener);
  }
  removeEventListener(type: string, listener: EventListener): void {
    if (type === 'message') this.listeners.delete(listener);
  }
  terminate(): void {
    this.stopped = true;
    this.listeners.clear();
  }
  private emit(data: unknown): void {
    for (const listener of this.listeners) listener(new MessageEvent('message', { data }));
  }
}

class InProcessProtocolPort implements OnlineProtocolWorkerPort {
  readonly runtime: OnlineWorkerRuntime;
  private readonly listeners = new Set<unknown>();
  private stopped = false;

  constructor() {
    const store = Object.assign(new MemoryEscrowLifecycleStore(), { close: async () => undefined });
    this.runtime = new OnlineWorkerRuntime({ store, emit: (event) => this.emit(event) });
  }

  postMessage(request: OnlineWorkerRequest, transfer: Transferable[]): void {
    const delivered = structuredClone(request, { transfer });
    void this.runtime.handle(delivered).then((reply) => this.emit(reply));
  }
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  addEventListener(type: string, listener: unknown): void {
    if (type === 'message') this.listeners.add(listener);
  }
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: unknown): void {
    if (type === 'message') this.listeners.delete(listener);
  }
  terminate(): void {
    this.stopped = true;
    void this.runtime.close();
  }
  emit(value: unknown): void {
    if (this.stopped) return;
    const event = new MessageEvent('message', { data: structuredClone(value) });
    for (const listener of this.listeners)
      if (typeof listener === 'function') Reflect.apply(listener, undefined, [event]);
  }
}

async function settle(sessions: readonly P2PSession[], clock: { advanceBy(ms: number): void }) {
  await Promise.all(sessions.map((session) => session.flush()));
  clock.advanceBy(0);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('online worker projects one real certified terminal game and completes the audit job', async () => {
  const port = new InProcessProtocolPort();
  const client = new OnlineWorkerClient({ worker: port, generation: 'terminal-worker-test' });
  const events: OnlineWorkerEvent[] = [];
  const observed: { display: OnlineWorkerSession | null } = { display: null };
  const data: { genesis: Genesis | null; report: AuditReport | null; verifiedMoves: number } = {
    genesis: null,
    report: null,
    verifiedMoves: 0,
  };
  let auditRequests = 0;
  const records = new Map<Seat, Map<string, Uint8Array>>();
  const bot = new RandomBot();
  const rng = createBotRng(new Uint8Array(32).fill(59));
  client.subscribe((event) => {
    events.push(event);
    if (event.kind !== 'session') return;
    if (observed.display) observed.display.accept(event.snapshot);
    else observed.display = new OnlineWorkerSession(client, event.snapshot, () => undefined);
  });
  try {
    // The fixture owns real genesis, certified consensus and legal play. This adapter
    // attaches its actual session before any moves so the worker sees the whole history.
    expect((await client.request({ kind: 'retryStart' })).ok).toBe(false);
    const fixture = await createTerminalAuditFixture({
      yieldTask: () => new Promise<void>((resolve) => setImmediate(resolve)),
      chooseCommand(host, pending) {
        const priv = host.getPrivate(pending.seat);
        if (!priv) throw new Error('Bot lacks its owned private view');
        return bot.decide({ state: host.getState(), priv, seat: pending.seat }, pending, rng);
      },
      sessionOptions(options) {
        const checked = validateGenesisEntry(
          options.genesisEntry,
          options.engine,
          options.policy.genesis,
        );
        if (!checked.ok) throw new Error(`Invalid verified genesis: ${checked.error.code}`);
        data.genesis = checked.value.genesis;
        const saved = new Map<string, Uint8Array>();
        records.set(options.seat, saved);
        return {
          ...options,
          masterReveal: {
            store: {
              async load(id) {
                return saved.get(id)?.slice() ?? null;
              },
              async putIfAbsent(id, bytes) {
                if (saved.has(id)) return false;
                saved.set(id, bytes.slice());
                return true;
              },
            },
            async loadOwnedMaster(seat) {
              return seat === options.seat || options.botKeys?.has(seat)
                ? scalarToBytes(BigInt(17 + seat))
                : null;
            },
          },
          auditRunner(input: SessionAuditInput) {
            auditRequests += 1;
            return createSessionAuditJob(input, () => new InProcessAuditPort());
          },
        };
      },
      async onSessionsReady(sessions) {
        const first = sessions[0];
        if (!first || !data.genesis) throw new Error('Missing certified session or genesis');
        const signedGenesis = data.genesis;
        Reflect.set(port.runtime, 'startup', {
          snapshot: () => ({
            phase: 'playing',
            awaitingSeats: [],
            locallyConsented: true,
            error: null,
            gameId: signedGenesis.gameId,
          }),
          game: () => ({
            gameId: signedGenesis.gameId,
            genesis: signedGenesis,
            seat: 0,
            session: first,
          }),
          close: async () => undefined,
        });
        const publish: unknown = Reflect.get(port.runtime, 'publishStartup');
        if (typeof publish !== 'function') throw new Error('Missing worker publication method');
        Reflect.apply(publish, port.runtime, []);
      },
      async onTerminal(sessions, clock) {
        for (let attempt = 0; attempt < 12; attempt += 1) {
          clock.advanceBy(2_000);
          // oxlint-disable-next-line no-await-in-loop -- Each pulse can deliver another signed reveal or audit result.
          await settle(sessions, clock);
          if (sessions.every((session) => session.getAudit().kind === 'complete')) break;
        }
        expect(sessions.map((session) => session.getAudit().kind)).toEqual([
          'complete',
          'complete',
        ]);
        const latest = observed.display;
        if (!latest) throw new Error('Worker emitted no session snapshot');
        expect(latest.getState().result).not.toBeNull();
        expect(latest.getAudit().kind).toBe('complete');
        const snapshots = events.filter((event) => event.kind === 'session');
        expect(snapshots.length).toBeGreaterThan(10);
        for (const event of snapshots)
          expect(event.snapshot.update.fairness?.head).toEqual(event.snapshot.committedHead);
        const certified = sessions[0]?.exportSave().entries ?? [];
        expect(certified.some((item) => item.entry.payload.kind === 'crypto')).toBe(true);
        const fairness = latest.getFairness();
        expect(fairness?.verifiedMoves).toBeGreaterThan(0);
        expect(fairness?.verifiedMoves).toBeLessThan(certified.length);
        expect(fairness).toEqual(sessions[0]?.getFairness());
        expect(fairness?.findings).toEqual([]);
        const audit = sessions[0]?.getAudit();
        if (!audit || audit.kind !== 'complete' || !fairness)
          throw new Error('Certified terminal audit or fairness is missing');
        data.report = audit.report;
        data.verifiedMoves = fairness.verifiedMoves;
        expect(events.some((event) => event.kind === 'gameReady')).toBe(true);
        expect(auditRequests).toBe(2);
        expect(records.size).toBe(2);
        const exported = await client.request({ kind: 'exportSave' });
        expect(exported.ok).toBe(true);
      },
    });
    try {
      const artifact = process.env.CP2P_WORKER_TERMINAL_ARTIFACT;
      if (artifact) {
        if (!data.report) throw new Error('Missing complete terminal report');
        await writeFile(
          artifact,
          canonicalEncode({
            genesisEntry: fixture.genesisEntry,
            entries: fixture.entries,
            masters: fixture.masters,
            report: data.report,
            submittedCommands: data.verifiedMoves,
          }),
        );
      }
    } finally {
      for (const item of fixture.masters) item.master.fill(0);
    }
  } finally {
    observed.display?.dispose();
    await client.shutdown();
  }
}, 120_000);
