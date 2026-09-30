import { SCALAR_ORDER, scalarToBytes } from '@cp2p/crypto';
import { RandomBot, createBotRng } from '../../bots/src/index.js';
import { fromBase64Url, hashValue, toHex } from '@cp2p/codec';
import { success } from '@cp2p/engine';
import type { Engine, Input, PrivateInputData, PrivateState, Seat } from '@cp2p/engine';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { auditCertifiedGame } from './audit.js';
import * as proposal from './proposal.js';
import { VerifiedSessionDriver } from './verified-session-driver.js';
import { auditCertifiedGameReference } from './testing/audit-reference.js';
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
    // Protocol v6 nonce 7 deals a victory card first; no unrelated draws are needed.
    ceremonyNonce: new Uint8Array(32).fill(7),
    maxElapsedMs: 90_000,
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
    expect(report).toEqual(auditCertifiedGameReference(fixture));
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

  test('hands a replay viewer every certified input with its reconstructed private data', () => {
    const observed: { input: Input; data: Partial<Record<Seat, PrivateInputData>> }[] = [];
    const report = auditCertifiedGame({
      ...fixture,
      onPrivateInput: (input, data) => observed.push({ input, data }),
    });
    expect(report.ok).toBe(true);
    expect(observed.length).toBeGreaterThan(0);
    const payload = fixture.genesisEntry.payload;
    if (payload.kind !== 'genesis') throw new Error('Fixture genesis is missing');
    const { config, genesisSeed } = payload.genesis;
    const { engine } = fixture;
    let state = engine.createGame(config, fromBase64Url(genesisSeed));
    let privates: ReadonlyMap<Seat, PrivateState> = new Map(
      config.seats.map((seat) => [seat, engine.createPrivateState(seat, config)]),
    );
    for (const { input, data } of observed) {
      const applied = engine.apply(state, input);
      const next = engine.applyAllPrivates(privates, state, input, data);
      if (!applied.ok || !next.ok) throw new Error('Observed transcript does not replay');
      state = applied.value.state;
      privates = next.value;
    }
    expect(toHex(hashValue(state))).toBe(toHex(hashValue(fixture.finalState)));
    expect(engine.checkPrivateInvariants(state, privates)).toEqual([]);
    expect(
      observed.some(
        ({ input, data }) =>
          input.kind === 'system' && input.type === 'CARD_DEALT' && Object.keys(data).length > 0,
      ),
    ).toBe(true);
  }, 30_000);

  test('validates each certified entry twice while matching the four-pass reference', () => {
    const validated = vi.spyOn(proposal, 'validateCertifiedEntry');
    try {
      const report = auditCertifiedGame(fixture);
      expect(report.ok).toBe(true);
      expect(validated).toHaveBeenCalledTimes(fixture.entries.length * 2);
      validated.mockClear();
      expect(auditCertifiedGameReference(fixture)).toEqual(report);
      expect(validated).toHaveBeenCalledTimes(fixture.entries.length * 4);
    } finally {
      validated.mockRestore();
    }
  }, 30_000);

  test('reports throwing disposal without escaping the audit or changing supplied masters', () => {
    const snapshots = fixture.masters.map(({ master }) => new Uint8Array(master));
    const relinquish = vi
      .spyOn(VerifiedSessionDriver.prototype, 'relinquishSeats')
      .mockImplementation(() => {
        throw new Error('Bounded disposal failure probe');
      });
    try {
      const report = auditCertifiedGame(fixture);
      expect(report).toEqual(auditCertifiedGameReference(fixture));
      expect(report.auditError).toEqual({
        seq: fixture.entries.at(-1)?.entry.seq,
        code: 'audit-internal-failure',
      });
      fixture.masters.forEach(({ master }, index) => expect(master).toEqual(snapshots[index]));
    } finally {
      relinquish.mockRestore();
    }
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

  test('catches a transient private-state disagreement even when final private states match', () => {
    const original = fixture.engine;
    let added = false;
    let removed = false;
    let present = false;
    const altered: Engine = {
      ...original,
      applyAllPrivates(privates, before, input, data) {
        const applied = original.applyAllPrivates(privates, before, input, data);
        if (!applied.ok) return applied;
        const owner = applied.value.get(0);
        if (!owner) throw new Error('Missing audit fixture owner');
        const ext = { ...owner.ext };
        if (input.kind === 'system' && input.type === 'START_SEAT') {
          ext.transientAuditProbe = { value: 1 };
          added = true;
        } else if (Object.hasOwn(ext, 'transientAuditProbe')) {
          delete ext.transientAuditProbe;
          removed = true;
        }
        present = Object.hasOwn(ext, 'transientAuditProbe');
        return success(new Map(applied.value).set(0, { ...owner, ext }));
      },
    };
    const firstInput = fixture.entries.find(
      ({ entry }) => entry.payload.kind === 'system' && entry.payload.input.type === 'START_SEAT',
    );
    expect(firstInput).toBeDefined();
    const report = auditCertifiedGame({ ...fixture, engine: altered });
    expect(added).toBe(true);
    expect(removed).toBe(true);
    expect(present).toBe(false);
    expect(report).toMatchObject({
      ok: false,
      complete: false,
      violations: [],
      auditError: { seq: firstInput?.entry.seq, code: 'audit-private-state' },
      finalHiddenVictoryPoints: null,
    });
  }, 30_000);

  test('retains later omniscient failure precedence over an earlier private disagreement', () => {
    const makeEngine = (failDraw = true): Engine => {
      const original = fixture.engine;
      return {
        ...original,
        applyAllPrivates(privates, before, input, data) {
          if (failDraw && input.kind === 'system' && input.type === 'CARD_DEALT')
            throw new Error('Bounded omniscient failure probe');
          const applied = original.applyAllPrivates(privates, before, input, data);
          if (!applied.ok || input.kind !== 'system' || input.type !== 'START_SEAT') return applied;
          const owner = applied.value.get(0);
          if (!owner) throw new Error('Missing audit fixture owner');
          return success(
            new Map(applied.value).set(0, {
              ...owner,
              ext: { ...owner.ext, deferredAuditProbe: true },
            }),
          );
        },
      };
    };
    const draw = fixture.entries.find(
      ({ entry }) => entry.payload.kind === 'system' && entry.payload.input.type === 'CARD_DEALT',
    );
    expect(draw).toBeDefined();
    const first = fixture.entries.find(
      ({ entry }) => entry.payload.kind === 'system' && entry.payload.input.type === 'START_SEAT',
    );
    expect(first).toBeDefined();
    const control = auditCertifiedGame({ ...fixture, engine: makeEngine(false) });
    expect(control.auditError).toEqual({ seq: first?.entry.seq, code: 'audit-private-state' });
    expect(control).toEqual(auditCertifiedGameReference({ ...fixture, engine: makeEngine(false) }));
    const report = auditCertifiedGame({ ...fixture, engine: makeEngine() });
    expect(report).toEqual(auditCertifiedGameReference({ ...fixture, engine: makeEngine() }));
    expect(report.auditError).toEqual({ seq: draw?.entry.seq, code: 'driver-error' });
    expect(report.violations).toEqual([]);
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
