import { SCALAR_ORDER, scalarToBytes } from '@cp2p/crypto';
import { RandomBot, createBotRng } from '../../bots/src/index.js';
import type { Engine } from '@cp2p/engine';
import { beforeAll, describe, expect, test } from 'vitest';
import { auditCertifiedGame } from './audit.js';
import { createTerminalAuditFixture } from './testing/audit-fixture.js';

type Fixture = Awaited<ReturnType<typeof createTerminalAuditFixture>>;
let fixture: Fixture;
const setupVertices = [
  'v:-1,-1,N',
  'v:-1,-1,S',
  'v:-1,0,S',
  'v:-1,1,S',
  'v:0,-1,S',
  'v:0,0,S',
  'v:0,2,N',
  'v:1,1,N',
];

beforeAll(async () => {
  const bot = new RandomBot();
  const rng = createBotRng(new Uint8Array(32).fill(59));
  let setupIndex = 0;
  fixture = await createTerminalAuditFixture({
    boardSeed: new Uint8Array(32).fill(50),
    ceremonyNonce: new Uint8Array(32).fill(2),
    yieldTask: () => new Promise<void>((resolve) => setImmediate(resolve)),
    chooseCommand(host, pending) {
      const commands = host.getLegalCommands(pending.seat).commands;
      if (host.getState().turn.phase.at(-1)?.id === 'setup') {
        const settlement = commands.find((command) => command.type === 'PLACE_SETTLEMENT');
        if (settlement) {
          const vertex = setupVertices[setupIndex];
          setupIndex += 1;
          const selected = commands.find(
            (command) => command.type === 'PLACE_SETTLEMENT' && command.vertex === vertex,
          );
          if (!selected) throw new Error(`Audit setup vertex ${vertex} is not legal`);
          return selected;
        }
        const road = commands.find((command) => command.type === 'PLACE_ROAD');
        if (road) return road;
      }
      const endTurn = commands.find((command) => command.type === 'END_TURN');
      if (endTurn) return endTurn;
      const priv = host.getPrivate(pending.seat);
      if (!priv) throw new Error('Audit bot lacks its private seat');
      return bot.decide({ state: host.getState(), priv, seat: pending.seat }, pending, rng);
    },
  });
}, 120_000);

describe('certified end-game audit', () => {
  test('passes a complete certified victory and identifies the first result', () => {
    expect(
      fixture.entries.some(
        ({ entry }) => entry.payload.kind === 'system' && entry.payload.input.type === 'CARD_DEALT',
      ),
    ).toBe(true);
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
    expect(
      Object.keys(report.finalHiddenVictoryPoints ?? {})
        .map(Number)
        .toSorted((left, right) => left - right),
    ).toEqual([0, 1, 2, 3]);
    expect(Object.values(report.finalHiddenVictoryPoints ?? {}).every(Number.isSafeInteger)).toBe(
      true,
    );
    expect(fixture.entries[(report.terminal?.seq ?? 0) - 1]?.entry.payload.kind).toBe('command');
  }, 30_000);

  test('requires a certified terminal result', () => {
    const report = auditCertifiedGame({ ...fixture, entries: fixture.entries.slice(0, -1) });
    expect(report.ok).toBe(false);
    expect(report.complete).toBe(false);
    expect(report.terminal).toBeNull();
    expect(report.finalHiddenVictoryPoints).toBeNull();
  });

  test('keeps missing and bad supplied masters out of owner violations', () => {
    const missing = auditCertifiedGame({ ...fixture, masters: fixture.masters.slice(1) });
    expect(missing).toMatchObject({
      ok: false,
      complete: false,
      missingSeats: [0],
      violations: [],
      finalHiddenVictoryPoints: null,
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
    const draw = fixture.entries.find(
      ({ entry }) => entry.payload.kind === 'system' && entry.payload.input.type === 'CARD_DEALT',
    );
    expect(draw).toBeDefined();
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
    expect(report.finalHiddenVictoryPoints).toBeNull();
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
    expect(draw).toBeDefined();
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
