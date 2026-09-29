import { describe, expect, test } from 'vitest';
import { knightsExt } from '@cp2p/engine';
import { scenarioById, scenarioConfig } from '@cp2p/maps';
import { LocalSession } from './local-session.js';
import type { Entropy } from './random.js';
import type { SessionScheduler, SessionStatus } from './types.js';

function entropy(seed: number): Entropy {
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

/** A manual clock: each tick runs the next scheduled bot decision. */
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
}

function botGame(scenarioId: string, seats: number, seed: number) {
  const scenario = scenarioById(scenarioId);
  if (!scenario) throw new Error(`Unknown scenario ${scenarioId}`);
  const config = scenarioConfig(scenario, seats);
  const clock = new Clock();
  const made = LocalSession.create({
    config,
    humanSeats: [],
    botSeats: config.seats,
    genesisSeed: new Uint8Array(32).fill(seed),
    botDelayMs: 0,
    scheduler: clock,
    entropy: entropy(seed * 7919),
  });
  if (!made.ok) throw new Error(`${made.error.code}: ${made.error.message}`);
  let status: SessionStatus = { kind: 'running' };
  made.value.subscribe((update) => {
    status = update.status;
  });
  return { session: made.value, clock, status: () => status };
}

/** Bots play a knights game through the browser's own random source, as the local screen does. */
describe('a local knights game with the browser random source', () => {
  test.each([
    { scenario: 'knights', seats: 3, seed: 2 },
    // Seeds that stalled a bot-only game on a request made of several seats at once.
    { scenario: 'knights', seats: 3, seed: 66 },
    { scenario: 'knights', seats: 4, seed: 73 },
    { scenario: 'knights', seats: 4, seed: 79 },
    { scenario: 'knights', seats: 4, seed: 3 },
    { scenario: 'knights', seats: 4, seed: 4 },
    { scenario: 'knights-56', seats: 5, seed: 5 },
    { scenario: 'knights-56', seats: 6, seed: 6 },
  ])(
    '$scenario with $seats seats (seed $seed) plays to a winner',
    ({ scenario, seats, seed }) => {
      const { session, clock, status } = botGame(scenario, seats, seed);
      let steps = 0;
      while (steps < 9000 && !session.getState().result && clock.tick()) steps += 1;
      const state = session.getState();
      expect(
        status(),
        `stopped after ${steps} steps: ${JSON.stringify(session.getPending())}`,
      ).toEqual({
        kind: 'complete',
      });
      expect(state.result?.winner).not.toBeUndefined();
      expect(knightsExt(state).improvements).toHaveLength(seats);
      session.dispose();
    },
    180_000,
  );

  test('a game in progress saves and restores to the same state', () => {
    const { session, clock } = botGame('knights', 3, 11);
    for (let steps = 0; steps < 900 && clock.tick(); steps += 1);
    const saved = session.exportSave();
    const restored = LocalSession.restore(saved, { entropy: entropy(99), scheduler: new Clock() });
    if (!restored.ok) throw new Error(`${restored.error.code}: ${restored.error.message}`);
    expect(restored.value.getState()).toEqual(session.getState());
    restored.value.dispose();
    session.dispose();
  }, 120_000);
});
