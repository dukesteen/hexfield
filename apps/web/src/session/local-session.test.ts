import { describe, expect, test } from 'vitest';
import type { GameConfig, Seat } from '@cp2p/engine';
import { standardFixedBoard } from '@cp2p/maps';
import { LocalSession } from './local-session.js';
import type { Entropy } from './random.js';
import type { SessionScheduler, SessionUpdate } from './types.js';

function entropy(seed = 17): Entropy {
  let value = seed;
  return {
    randomBytes(target) {
      for (let index = 0; index < target.length; index++) {
        value ^= value << 13;
        value ^= value >>> 17;
        value ^= value << 5;
        target[index] = value & 255;
      }
    },
  };
}

class Clock implements SessionScheduler {
  time = 1_700_000_000_000;
  private nextId = 0;
  private jobs = new Map<number, { at: number; callback: () => void }>();
  now(): number {
    return this.time;
  }
  setTimeout(callback: () => void, delay: number): unknown {
    const id = ++this.nextId;
    this.jobs.set(id, { at: this.time + delay, callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.jobs.delete(handle);
  }
  tick(): boolean {
    const next = [...this.jobs].toSorted((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
    if (!next) return false;
    this.jobs.delete(next[0]);
    this.time = next[1].at;
    next[1].callback();
    return true;
  }
  advance(ms: number): void {
    const end = this.time + ms;
    for (let step = 0; step < 1000; step++) {
      const first = [...this.jobs].toSorted((a, b) => a[1].at - b[1].at)[0];
      if (!first || first[1].at > end) break;
      this.tick();
    }
    this.time = end;
  }
  get size(): number {
    return this.jobs.size;
  }
}

const seats: Seat[] = [0, 1, 2];
function config(options: Record<string, unknown> = {}): GameConfig {
  return {
    modules: [{ id: 'base', version: '1.0.0' }],
    seats,
    options: { base: { mapLayout: 'standard-fixed', vpTarget: 3, ...options } },
    board: standardFixedBoard(),
  };
}

function create(
  humans: Seat[],
  bots: Seat[],
  runtime: { scheduler?: Clock; entropy?: Entropy } = {},
) {
  const made = LocalSession.create({
    config: config(),
    humanSeats: humans,
    botSeats: bots,
    genesisSeed: new Uint8Array(32).fill(9),
    botDelayMs: 0,
    ...runtime,
  });
  if (!made.ok) throw new Error(`${made.error.code}: ${made.error.message}`);
  return made.value;
}

async function reachTimedTurn(session: LocalSession): Promise<void> {
  for (let step = 0; step < 30 && !session.getTimers().length; step++) {
    const pending = session.getPending().find((item) => item.kind === 'player');
    if (pending?.kind !== 'player') throw new Error('Setup has no player choice');
    const command = session.getLegalCommands(pending.seat).commands[0];
    if (!command) throw new Error('Setup has no legal choice');
    // Setup decisions are sequential: each one determines the next pending seat.
    // eslint-disable-next-line no-await-in-loop
    const applied = await session.submit(pending.seat, command);
    if (!applied.ok) throw new Error(applied.error.message);
  }
  if (!session.getTimers().length) throw new Error('No timed turn after setup');
}

describe('LocalSession', () => {
  test('restores a genesis-only save and a final system-bearing batch', async () => {
    const session = create(seats, [], { entropy: entropy(31) });
    const original = session.exportSave();
    const genesisOnly = LocalSession.restore(original, { entropy: entropy(32) });
    if (!genesisOnly.ok) throw new Error(genesisOnly.error.message);
    expect(genesisOnly.value.exportSave()).toEqual(original);
    genesisOnly.value.dispose();
    for (let step = 0; step < 30 && session.getState().turn.phase.at(-1)?.id === 'setup'; step++) {
      const pending = session.getPending().find((item) => item.kind === 'player');
      if (pending?.kind !== 'player') throw new Error('Setup has no player choice');
      const command = session.getLegalCommands(pending.seat).commands[0];
      if (!command) throw new Error('Setup has no legal choice');
      // Setup decisions are sequential.
      // eslint-disable-next-line no-await-in-loop
      const applied = await session.submit(pending.seat, command);
      if (!applied.ok) throw new Error(applied.error.message);
    }
    const active = session.getState().turn.activeSeat;
    const rolled = await session.submit(active, { type: 'ROLL_DICE' });
    if (!rolled.ok) throw new Error(rolled.error.message);
    const save = session.exportSave();
    expect(
      save.batches
        .at(-1)
        ?.generated.some((input) => input.kind === 'system' && input.type === 'DICE_RESULT'),
    ).toBe(true);
    const restored = LocalSession.restore(save, { entropy: entropy(33) });
    if (!restored.ok) throw new Error(restored.error.message);
    expect(restored.value.exportSave()).toEqual(save);
    restored.value.dispose();
    session.dispose();
  });

  test('submits a human command, records its batch, and restores an identical authority', async () => {
    const session = create(seats, [], { entropy: entropy() });
    const pending = session.getPending().find((item) => item.kind === 'player');
    if (!pending || pending.kind !== 'player') throw new Error('Missing setup player');
    const command = session.getLegalCommands(pending.seat).commands[0];
    if (!command) throw new Error('Missing setup choice');
    const oldRevision = session.exportSave().genesis.length;
    expect(
      (await session.submit(pending.seat, command, { expectedRevision: oldRevision })).ok,
    ).toBe(true);
    const save = session.exportSave();
    expect(save.batches).toHaveLength(1);
    expect(save.batches[0]?.submitted).toEqual({ kind: 'command', seat: pending.seat, command });
    const restored = LocalSession.restore(save, { entropy: entropy(21) });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.getState()).toEqual(session.getState());
    expect(restored.value.exportSave()).toEqual(save);
    const tampered = structuredClone(save);
    if (!tampered.batches[0]) throw new Error('Missing saved batch');
    tampered.batches[0].submitted = {
      kind: 'command',
      seat: pending.seat,
      command: { type: 'END_TURN' },
    };
    expect(LocalSession.restore(tampered).ok).toBe(false);
    const extraRole = { ...save, roles: { humanSeats: seats, botSeats: [], secret: 'bad' } };
    expect(LocalSession.restore(extraRole).ok).toBe(false);
    const extraBatch = { ...save, batches: [{ ...save.batches[0], secret: true }] };
    expect(LocalSession.restore(extraBatch).ok).toBe(false);
    const unusedOutcome = structuredClone(save);
    unusedOutcome.genesis.push({ kind: 'system', type: 'START_SEAT', seat: 0 });
    expect(LocalSession.restore(unusedOutcome).ok).toBe(false);
    const badHash = { ...save, finalHash: '0'.repeat(64) };
    expect(LocalSession.restore(badHash).ok).toBe(false);
    session.dispose();
    restored.value.dispose();
  });

  test('rejects stale and nonhuman submissions without changing the log', async () => {
    const session = create([0, 1], [2], { entropy: entropy() });
    const revision = session.getState().counters.inputSeq;
    expect((await session.submit(2, { type: 'END_TURN' })).ok).toBe(false);
    expect(
      (await session.submit(0, { type: 'END_TURN' }, { expectedRevision: revision - 1 })).ok,
    ).toBe(false);
    expect(session.exportSave().batches).toHaveLength(0);
    session.dispose();
  });

  test('pauses, resumes, and disposes timers without an old callback changing the game', async () => {
    const clock = new Clock();
    const made = LocalSession.create({
      config: config({ turnTimer: { preRollSec: 2, mainSec: 3, discardSec: 4, robberSec: 5 } }),
      humanSeats: seats,
      botSeats: [],
      entropy: entropy(),
      scheduler: clock,
      genesisSeed: new Uint8Array(32).fill(9),
    });
    if (!made.ok) throw new Error(made.error.message);
    const session = made.value;
    await reachTimedTurn(session);
    expect(session.getTimers()).toHaveLength(1);
    const before = session.getTimers()[0]?.remainingMs;
    const command = session.getLegalCommands(session.getState().turn.activeSeat).commands[0];
    if (!command) throw new Error('Active choice missing');
    session.setPaused(true);
    expect(session.validate(session.getState().turn.activeSeat, command)).toMatchObject({
      ok: false,
      error: { code: 'session-paused' },
    });
    expect(await session.submit(session.getState().turn.activeSeat, command)).toMatchObject({
      ok: false,
      error: { code: 'session-paused' },
    });
    expect(session.getTimers()[0]?.expiresAt).toBeNull();
    clock.advance(10_000);
    expect(session.getTimers()[0]?.remainingMs).toBe(before);
    session.setPaused(false);
    expect(session.getTimers()[0]?.expiresAt).not.toBeNull();
    const revision = session.getState().counters.inputSeq;
    session.dispose();
    expect(clock.size).toBe(0);
    clock.advance(10_000);
    expect(session.getState().counters.inputSeq).toBe(revision);
  });

  test('an expired phase budget submits and records TIMEOUT', async () => {
    const clock = new Clock();
    const made = LocalSession.create({
      config: config({ turnTimer: { preRollSec: 2, mainSec: 3, discardSec: 4, robberSec: 5 } }),
      humanSeats: seats,
      botSeats: [],
      entropy: entropy(),
      scheduler: clock,
      genesisSeed: new Uint8Array(32).fill(9),
    });
    if (!made.ok) throw new Error(made.error.message);
    const session = made.value;
    await reachTimedTurn(session);
    const current = session.getTimers()[0];
    if (!current) throw new Error('Missing timer');
    clock.advance(current.remainingMs);
    const last = session.exportSave().batches.at(-1)?.submitted;
    expect(last).toMatchObject({ kind: 'system', type: 'TIMEOUT', seat: current.seat });
    session.dispose();
  });

  test('delivers nested revisions in order and stops bot ticks after disposal', async () => {
    const clock = new Clock();
    const session = create(seats, [], { entropy: entropy(), scheduler: clock });
    const seen: number[] = [];
    session.subscribe((update: SessionUpdate) => {
      seen.push(update.revision);
      if (seen.length === 2) {
        const pending = session.getPending().find((item) => item.kind === 'player');
        if (pending?.kind === 'player') {
          const command = session.getLegalCommands(pending.seat).commands[0];
          if (command) void session.submit(pending.seat, command);
        }
      }
    });
    const first = session.getPending().find((item) => item.kind === 'player');
    if (first?.kind !== 'player') throw new Error('Missing setup input');
    const command = session.getLegalCommands(first.seat).commands[0];
    if (!command) throw new Error('Missing command');
    await session.submit(first.seat, command);
    expect(seen).toHaveLength(3);
    expect(seen[0]).toBeLessThan(seen[1] ?? 0);
    expect(seen[1]).toBeLessThan(seen[2] ?? 0);
    session.dispose();
  });

  test('three local bots complete a game using only their own private views', () => {
    const clock = new Clock();
    const session = create([], seats, { entropy: entropy(41), scheduler: clock });
    let ticks = 0;
    while (!session.getState().result && ticks++ < 10_000 && clock.tick()) {}
    expect(session.getState().result).not.toBeNull();
    expect(ticks).toBeLessThan(10_000);
    expect(session.exportSave().batches.length).toBeGreaterThan(20);
    const botSecret = session.getPrivate(0);
    if (!botSecret) throw new Error('Local authority lost a bot private state');
    botSecret.hand.brick = 99;
    expect(session.getPrivate(0)?.hand.brick).not.toBe(99);
    const saved = session.exportSave();
    const restored = LocalSession.restore(saved, { entropy: entropy(56), scheduler: new Clock() });
    if (!restored.ok) throw new Error(restored.error.message);
    expect(restored.value.getState()).toEqual(session.getState());
    restored.value.dispose();
    session.dispose();
  });
});
