import { hashValue, toHex } from '@cp2p/codec';
import { describe, expect, test } from 'vitest';
import { CHECKPOINT_INTERVAL, ReplaySession } from './replay-session.js';
import type { ReplayTranscript } from './replay-session.js';
import { goldenTranscript } from './replay-golden.test-helper.js';

function created(transcript: ReplayTranscript<null>): ReplaySession<null> {
  const session = ReplaySession.create(transcript);
  if (!session.ok) throw new Error(session.error.message);
  return session.value;
}

describe('ReplaySession', () => {
  test('rebuilds the golden checkpoints at any seek order', () => {
    const transcript = goldenTranscript('normal-game-01.replay.json');
    const session = created(transcript);
    session.setPerspective({ kind: 'omniscient' });
    expect(session.length).toBe(transcript.inputs.length);
    expect(session.position).toBe(session.length);
    const expected = transcript.raw.checkpoints.filter((item) => item.index <= session.length);
    for (const checkpoint of expected.toReversed()) {
      session.seek(checkpoint.index);
      expect(toHex(hashValue(session.getState()))).toBe(checkpoint.stateHash);
    }
    session.seek(0);
    session.step(1);
    expect(session.position).toBe(1);
    expect(session.getState().result).toBeNull();
    session.seek(session.length);
    expect(session.getState().result).not.toBeNull();
  });

  test('is read-only', async () => {
    const session = created(goldenTranscript('normal-game-01.replay.json'));
    expect(session.mode).toBe('replay');
    expect(session.controllableSeats()).toEqual([]);
    expect((await session.submit()).ok).toBe(false);
    expect(session.getLegalCommands(0).commands).toEqual([]);
  });

  test('rejects a tampered input', () => {
    const transcript = goldenTranscript('normal-game-01.replay.json');
    const inputs = transcript.inputs.slice();
    const index = inputs.findIndex(
      (input) => input.kind === 'command' && input.command.type === 'PLACE_SETTLEMENT',
    );
    const original = inputs[index];
    if (original?.kind !== 'command') throw new Error('Golden has no settlement');
    inputs[index] = { ...original, command: { ...original.command, vertex: 'v:99,99,N' } };
    const session = ReplaySession.create({ ...transcript, inputs });
    expect(session.ok).toBe(false);
  });

  test('never shows a hand or narrowed bounds in the public perspective', () => {
    const session = created(goldenTranscript('knights/knights-4p.replay.json'));
    expect(session.perspective.kind).toBe('public');
    for (let position = 0; position <= session.length; position += 7) {
      session.seek(position);
      const state = session.getState();
      for (const seat of state.seats) {
        expect(session.getPrivate(seat.seat)).toBeNull();
        for (const kind of Object.keys(seat.resources.max)) {
          expect(Reflect.get(seat.resources.min, kind)).toBe(0);
          expect(Reflect.get(seat.resources.max, kind)).toBe(seat.resources.total);
        }
      }
    }
  });

  test('a seat perspective shows only that seat', () => {
    const session = created(goldenTranscript('normal-game-01.replay.json'));
    expect(session.setPerspective({ kind: 'seat', seat: 1 }).ok).toBe(true);
    session.seek(Math.floor(session.length / 2));
    expect(session.getPrivate(1)).not.toBeNull();
    expect(session.getPrivate(0)).toBeNull();
    expect(session.getPrivate(2)).toBeNull();
  });

  test('without private data only the public perspective is allowed', () => {
    const session = created({
      ...goldenTranscript('normal-game-01.replay.json'),
      privateData: null,
    });
    expect(session.fullInformation).toBe(false);
    expect(session.setPerspective({ kind: 'omniscient' }).ok).toBe(false);
    expect(session.setPerspective({ kind: 'seat', seat: 0 }).ok).toBe(false);
  });

  test.each([
    'knights/knights-4p-progress.replay.json',
    'seafaring/desert-crossing-56.replay.json',
    'seafarers-knights/desert-crossing-knights-56.replay.json',
  ])(
    'seeks anywhere in %s in under 200 ms',
    (file) => {
      const transcript = goldenTranscript(file);
      const built = performance.now();
      const session = created(transcript);
      // Precomputing is one full replay (about 0.2 to 2 s for these games).
      expect(performance.now() - built).toBeLessThan(30_000);
      expect(session.length).toBeGreaterThan(20 * CHECKPOINT_INTERVAL);
      session.setPerspective({ kind: 'omniscient' });
      // The worst case replays a full interval minus one input, backwards and forwards.
      const targets = [
        CHECKPOINT_INTERVAL - 1,
        session.length - 1,
        Math.floor(session.length / 2) + CHECKPOINT_INTERVAL - 1,
        1,
        session.length,
        Math.floor(session.length / 3) + CHECKPOINT_INTERVAL - 1,
      ];
      let worst = 0;
      for (const target of targets) {
        const started = performance.now();
        session.seek(target);
        session.getState();
        worst = Math.max(worst, performance.now() - started);
      }
      expect(worst).toBeLessThan(200);
    },
    60_000,
  );
});
