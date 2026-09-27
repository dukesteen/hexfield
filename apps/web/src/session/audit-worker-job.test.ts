import { beforeAll, describe, expect, test } from 'vitest';
import { createTerminalAuditFixture } from '@cp2p/protocol/testing';
import { baseAuditPolicy } from './audit-worker-job.js';
import type { AuditWorkerRequest } from './audit-worker-job.js';
import { performAuditRequest } from './audit-worker-job.js';

type Fixture = Awaited<ReturnType<typeof createTerminalAuditFixture>>;
let fixture: Fixture;

beforeAll(async () => {
  fixture = await createTerminalAuditFixture({
    yieldTask: () => new Promise<void>((resolve) => setImmediate(resolve)),
  });
}, 120_000);

describe('base audit worker policy', () => {
  test('does not authorize callback-only system evidence', () => {
    expect(baseAuditPolicy.entry.verifySystem).toBeUndefined();
  });

  test('audits a real certified terminal history using built-in proof verification', () => {
    const request: AuditWorkerRequest = {
      id: 1,
      genesisEntry: fixture.genesisEntry,
      entries: fixture.entries,
      masters: fixture.masters,
    };

    const report = performAuditRequest(request);

    expect(report).toMatchObject({
      ok: true,
      complete: true,
      missingSeats: [],
      violations: [],
      inputErrors: [],
      historyError: null,
    });
    expect(report.terminal).not.toBeNull();
  }, 30_000);
});
