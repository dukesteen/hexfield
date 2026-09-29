import { describe, expect, test } from 'vitest';
import { createBaseEngine } from '@cp2p/engine';
import type { GameState, PrivateState, Seat } from '@cp2p/engine';
import { createBotRng } from '../random-bot.js';
import { BotClient, inProcessPort } from './client.js';
import { BotHost } from './host.js';
import { parseBotRequest } from './messages.js';
import type { PlayerPending } from './messages.js';
import { decisionImportance, humanlikeDelay } from './pace.js';

const engine = createBaseEngine();
const SEED = new Uint8Array(32).fill(4);

function setup(): { state: GameState; priv: PrivateState; pending: PlayerPending } {
  const created = engine.createGame(
    {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1, 2],
      options: { base: { mapLayout: 'random' } },
    },
    new Uint8Array(32),
  );
  const started = engine.apply(created, { kind: 'system', type: 'START_SEAT', seat: 0 });
  if (!started.ok) throw new Error(started.error.message);
  const pending = engine
    .getPending(started.value.state)
    .find((item): item is PlayerPending => item.kind === 'player' && item.seat === 0);
  if (!pending) throw new Error('No setup pending');
  return { state: started.value.state, priv: engine.createPrivateState(0), pending };
}

describe('bot worker protocol', () => {
  test('a client gets a legal decision from a host across a cloning boundary', async () => {
    const { state, priv, pending } = setup();
    const client = new BotClient(inProcessPort(new BotHost(engine)));
    for (const level of ['random', 'easy', 'normal', 'hard'] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one client, one bot at a time.
      const decision = await client.decide({
        bot: `seat-0-${level}`,
        level,
        seed: SEED,
        state,
        priv,
        seat: 0,
        pending,
      });
      expect(decision.command.type).toBe('PLACE_SETTLEMENT');
      expect(
        engine.validate(state, { kind: 'command', seat: 0, command: decision.command }).ok,
      ).toBe(true);
      expect(decision.warnings).toEqual([]);
    }
    client.close();
  });

  test('the same seed replays the same moves', async () => {
    const { state, priv, pending } = setup();
    const play = async (): Promise<unknown[]> => {
      const client = new BotClient(inProcessPort(new BotHost(engine)));
      const moves = [];
      for (let n = 0; n < 5; n++) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the moves consume one RNG stream in order.
        const decision = await client.decide({
          bot: 'b',
          level: 'random',
          seed: SEED,
          state,
          priv,
          seat: 0,
          pending,
        });
        moves.push(decision.command);
      }
      return moves;
    };
    expect(await play()).toEqual(await play());
  });

  test('one host multiplexes bots, each with its own RNG stream', async () => {
    const host = new BotHost(engine);
    const { state, priv, pending } = setup();
    const request = (bot: string, id: number) => ({
      kind: 'decide',
      id,
      bot,
      level: 'random',
      seed: SEED,
      view: { state, priv, seat: 0 },
      pending,
    });
    const first = host.handle(request('a', 1));
    const second = host.handle(request('b', 2));
    expect(first).toMatchObject({ kind: 'decision', id: 1 });
    // Same seed, separate bots: the second bot starts its own stream, so it repeats the first move.
    expect(second.kind === 'decision' && first.kind === 'decision' && second.command).toEqual(
      first.kind === 'decision' && first.command,
    );
  });

  test('answers a trade offer on the bot level’s merits', async () => {
    const { state, priv } = setup();
    const client = new BotClient(inProcessPort(new BotHost(engine)));
    const offer = {
      id: 1,
      proposer: 1 as const,
      give: { ore: 1 },
      want: { wool: 5 },
      to: [0 as const],
      acceptedBy: [],
      declinedBy: [],
      valid: true,
    };
    expect(
      await client.respondTrade({
        bot: 'n',
        level: 'normal',
        seed: SEED,
        state,
        priv,
        seat: 0,
        offer,
      }),
    ).toBe(false);
  });

  test('refuses anything but an exact bot view', () => {
    const { state, priv, pending } = setup();
    const base = { kind: 'decide', id: 1, bot: 'x', level: 'easy', seed: SEED, pending };
    expect(() => parseBotRequest({ ...base, view: { state, priv, seat: 0 } })).not.toThrow();
    const other = engine.createPrivateState(1);
    expect(() =>
      parseBotRequest({ ...base, view: { state, priv, seat: 0, privates: [other] } }),
    ).toThrow(/envelope/);
    expect(() => parseBotRequest({ ...base, view: { state, priv: other, seat: 0 } })).toThrow(
      /own seat/,
    );
    expect(() =>
      parseBotRequest({ ...base, view: { state: { ...state, hands: {} }, priv, seat: 0 } }),
    ).toThrow(/state/);
    expect(() =>
      parseBotRequest({ ...base, view: { state, priv: { ...priv, others: {} }, seat: 0 } }),
    ).toThrow(/private/);
    expect(() => parseBotRequest({ ...base, secrets: 1, view: { state, priv, seat: 0 } })).toThrow(
      /unexpected/,
    );
    expect(() =>
      parseBotRequest({ ...base, level: 'grandmaster', view: { state, priv, seat: 0 } }),
    ).toThrow(/level/);
    const host = new BotHost(engine);
    expect(host.handle({ ...base, view: { state, priv: other, seat: 0 } })).toMatchObject({
      kind: 'error',
      id: 1,
    });
  });
});

function asking(allowed: string[], seat: Seat = 0): PlayerPending {
  return { kind: 'player', seat, allowed };
}

describe('humanlike pace', () => {
  test('important decisions take longer than routine ones', () => {
    expect(decisionImportance(asking(['PLACE_SETTLEMENT']))).toBeGreaterThan(
      decisionImportance(asking(['ROLL_DICE'])),
    );
    expect(decisionImportance(asking(['MOVE_ROBBER']))).toBeGreaterThan(
      decisionImportance(asking(['END_TURN', 'BUILD_ROAD'])),
    );
  });

  test('trade replies come within one to three seconds; zero pace stays instant', () => {
    const rng = createBotRng(SEED);
    for (let n = 0; n < 50; n++) {
      const delay = humanlikeDelay(1000, asking(['RESPOND_TRADE'], 1), 0, rng);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(3000);
      const roll = humanlikeDelay(1000, asking(['ROLL_DICE']), 0, rng);
      expect(roll).toBeGreaterThanOrEqual(525);
      expect(roll).toBeLessThanOrEqual(875);
    }
    expect(humanlikeDelay(0, asking(['RESPOND_TRADE'], 1), 0, rng)).toBe(0);
  });
});
