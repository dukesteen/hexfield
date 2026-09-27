import { SCALAR_ORDER, scalarToBytes } from '@cp2p/crypto';
import type { Engine } from '@cp2p/engine';
import { beforeAll, describe, expect, test } from 'vitest';
import { auditCertifiedGame } from './audit.js';
import { createTerminalAuditFixture } from './testing/audit-fixture.js';

type Fixture = Awaited<ReturnType<typeof createTerminalAuditFixture>>;
let fixture: Fixture;

beforeAll(async () => {
  fixture = await createTerminalAuditFixture({
    yieldTask: () => new Promise<void>((resolve) => setImmediate(resolve)),
  });
}, 120_000);

describe('certified end-game audit', () => {
  test('passes a complete certified victory and identifies the first result', () => {
    const report = auditCertifiedGame(fixture);
    expect(report).toMatchObject({
      ok: true,
      complete: true,
      missingSeats: [],
      violations: [],
      inputErrors: [],
      historyError: null,
      auditError: null,
    });
    expect(report.terminal?.seq).toBeGreaterThan(0);
    expect(report.finalHead?.seq).toBeGreaterThanOrEqual(report.terminal?.seq ?? 0);
    expect(fixture.entries[(report.terminal?.seq ?? 0) - 1]?.entry.payload.kind).toBe('command');
  }, 30_000);

  test('requires a certified terminal result', () => {
    const report = auditCertifiedGame({ ...fixture, entries: fixture.entries.slice(0, -1) });
    expect(report.ok).toBe(false);
    expect(report.complete).toBe(false);
    expect(report.terminal).toBeNull();
  });

  test('keeps missing and bad supplied masters out of owner violations', () => {
    const missing = auditCertifiedGame({ ...fixture, masters: fixture.masters.slice(1) });
    expect(missing).toMatchObject({
      ok: false,
      complete: false,
      missingSeats: [0],
      violations: [],
    });

    const wrong = auditCertifiedGame({
      ...fixture,
      masters: fixture.masters.map((row) =>
        row.seat === 0 ? { seat: row.seat, master: scalarToBytes(99n) } : row,
      ),
    });
    expect(wrong.ok).toBe(false);
    expect(wrong.violations).toEqual([]);
    expect(wrong.inputErrors).toContainEqual({ seat: 0, kind: 'master-public-key' });
  });

  test('detects a false private draw at the certified victory claim', () => {
    const original = fixture.engine;
    const altered: Engine = {
      ...original,
      applyAllPrivates(privates, before, input, privateData) {
        if (
          input.kind === 'system' &&
          input.type === 'CARD_DEALT' &&
          typeof input.seat === 'number'
        ) {
          return original.applyAllPrivates(privates, before, input, {
            ...privateData,
            [input.seat]: { card: 'knight' },
          });
        }
        return original.applyAllPrivates(privates, before, input, privateData);
      },
    };
    const report = auditCertifiedGame({ ...fixture, engine: altered });
    expect(report.ok).toBe(false);
    expect(report.complete).toBe(true);
    expect(report.violations).toContainEqual({
      seq: report.terminal?.seq,
      seat: null,
      kind: 'private-victory-mismatch',
      detail: 'private-victory-mismatch',
    });
  }, 30_000);

  test('reports a private engine exception without accusing the drawing player', () => {
    const original = fixture.engine;
    const altered: Engine = {
      ...original,
      applyAllPrivates(privates, before, input, data) {
        if (input.kind === 'system' && input.type === 'CARD_DEALT')
          throw new Error('Local engine failed');
        return original.applyAllPrivates(privates, before, input, data);
      },
    };
    const report = auditCertifiedGame({ ...fixture, engine: altered });
    const draw = fixture.entries.find(
      ({ entry }) => entry.payload.kind === 'system' && entry.payload.input.type === 'CARD_DEALT',
    );
    expect(report).toMatchObject({
      ok: false,
      complete: false,
      violations: [],
      auditError: { seq: draw?.entry.seq, code: 'driver-error' },
    });
  }, 30_000);

  test('rejects an alternate encoding of the same scalar as bad reveal input', () => {
    let scalar = SCALAR_ORDER + 17n;
    const noncanonical = Uint8Array.from({ length: 32 }, () => {
      const byte = Number(scalar & 255n);
      scalar >>= 8n;
      return byte;
    });
    const report = auditCertifiedGame({
      ...fixture,
      masters: fixture.masters.map((row) =>
        row.seat === 0 ? { seat: row.seat, master: noncanonical } : row,
      ),
    });
    expect(report.violations).toEqual([]);
    expect(report.inputErrors).toContainEqual({ seat: 0, kind: 'master-scalar' });
    expect(report.complete).toBe(false);
  });

  test('rejects a corrupt certificate before evaluating any supplied secrets', () => {
    const entries = fixture.entries.map((item, index) =>
      index === 0 ? { ...item, certificate: [] } : item,
    );
    const report = auditCertifiedGame({ ...fixture, entries, masters: [] });
    expect(report.ok).toBe(false);
    expect(report.historyError).not.toBeNull();
    expect(report.inputErrors).toEqual([]);
    expect(report.violations).toEqual([]);
  });
});
