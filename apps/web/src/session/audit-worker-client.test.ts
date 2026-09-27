// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';
import type { AuditReport, SessionAuditInput } from '@cp2p/protocol';
import { createSimulationGenesis } from '@cp2p/protocol/testing';
import { createSessionAuditJob } from './audit-worker-client.js';

interface PostedAuditRequest {
  id: number;
  masters: { master: Uint8Array }[];
}

function isPostedAuditRequest(value: unknown): value is PostedAuditRequest {
  if (typeof value !== 'object' || value === null) return false;
  const id = Reflect.get(value, 'id');
  const masters = Reflect.get(value, 'masters');
  return (
    typeof id === 'number' &&
    Array.isArray(masters) &&
    masters.every(
      (item: unknown) =>
        typeof item === 'object' &&
        item !== null &&
        Reflect.get(item, 'master') instanceof Uint8Array,
    )
  );
}

class FakeWorker {
  terminated = false;
  posted: unknown;
  transfer: Transferable[] = [];
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.posted = message;
    this.transfer = transfer ?? [];
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  message(data: unknown): void {
    this.emit('message', new MessageEvent('message', { data }));
  }

  get messageListeners(): number {
    return this.listeners.get('message')?.size ?? 0;
  }
}

function input(master = new Uint8Array([3, 5, 8])): SessionAuditInput {
  return {
    genesisEntry: createSimulationGenesis({ seed: 1 }).entry,
    entries: [],
    masters: [{ seat: 0, master }],
  };
}

const report: AuditReport = {
  ok: false,
  complete: false,
  missingSeats: [0],
  violations: [],
  inputErrors: [],
  cheatFindings: [],
  terminal: null,
  finalHead: null,
  historyError: { code: 'audit-invalid-history' },
};

function postedRequest(worker: FakeWorker): PostedAuditRequest {
  if (!isPostedAuditRequest(worker.posted))
    throw new Error('Worker did not receive an audit request');
  return worker.posted;
}

describe('session audit worker adapter', () => {
  test('correlates the response and transfers an owned master copy', async () => {
    const worker = new FakeWorker();
    const callerMaster = new Uint8Array([3, 5, 8]);
    const job = createSessionAuditJob(input(callerMaster), () => worker);
    const request = postedRequest(worker);
    const transferredMaster = request.masters[0]?.master;

    expect(transferredMaster).not.toBe(callerMaster);
    expect(worker.transfer).toEqual([transferredMaster?.buffer]);
    expect(callerMaster).toEqual(new Uint8Array([0, 0, 0]));

    let settled = false;
    void job.result.then(() => {
      settled = true;
      return undefined;
    });
    worker.message({ id: request.id + 1, report });
    worker.message({ id: request.id, report: { ...report, terminal: undefined } });
    await Promise.resolve();
    expect(settled).toBe(false);

    worker.message({ id: request.id, report });
    await expect(job.result).resolves.toEqual(report);
    expect(worker.terminated).toBe(true);
    expect(worker.messageListeners).toBe(0);
    expect(transferredMaster).toEqual(new Uint8Array([0, 0, 0]));
  });

  test('cancellation rejects, terminates, and erases the transferred copy', async () => {
    const worker = new FakeWorker();
    const job = createSessionAuditJob(input(), () => worker);
    const request = postedRequest(worker);
    const transferredMaster = request.masters[0]?.master;

    job.cancel();
    await expect(job.result).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminated).toBe(true);
    expect(transferredMaster).toEqual(new Uint8Array([0, 0, 0]));

    worker.message({ id: request.id, report });
    expect(worker.messageListeners).toBe(0);
  });

  test('worker errors reject and release the job', async () => {
    const worker = new FakeWorker();
    const job = createSessionAuditJob(input(), () => worker);
    worker.emit('error', new ErrorEvent('error', { message: 'worker crashed' }));

    await expect(job.result).rejects.toThrow('worker crashed');
    expect(worker.terminated).toBe(true);
  });

  test('a failed postMessage rejects and erases copied secrets', async () => {
    const worker = new FakeWorker();
    const copiedMasters: Uint8Array[] = [];
    worker.postMessage = function (message: unknown, transfer?: Transferable[]) {
      this.posted = message;
      this.transfer = transfer ?? [];
      if (!isPostedAuditRequest(message)) throw new Error('Unexpected worker request');
      copiedMasters.push(...message.masters.map(({ master }) => master));
      throw new Error('structured clone failed');
    };
    const callerMaster = new Uint8Array([3, 5, 8]);
    const job = createSessionAuditJob(input(callerMaster), () => worker);

    await expect(job.result).rejects.toThrow('structured clone failed');
    expect(worker.terminated).toBe(true);
    expect(copiedMasters[0]).toEqual(new Uint8Array([0, 0, 0]));
    expect(callerMaster).toEqual(new Uint8Array([0, 0, 0]));
  });

  test('a failed master copy wipes all owned input buffers and prior copies', async () => {
    const firstMaster = new Uint8Array([3, 5, 8]);
    const detachedMaster = new Uint8Array([13, 21]);
    structuredClone(detachedMaster, { transfer: [detachedMaster.buffer] });
    const job = createSessionAuditJob(
      {
        ...input(firstMaster),
        masters: [
          { seat: 0, master: firstMaster },
          { seat: 1, master: detachedMaster },
        ],
      },
      () => {
        throw new Error('Worker should not be constructed after copy failure');
      },
    );

    expect(firstMaster).toEqual(new Uint8Array([0, 0, 0]));
    expect(detachedMaster.byteLength).toBe(0);
    await expect(job.result).rejects.toThrow('detached ArrayBuffer');
  });
});
