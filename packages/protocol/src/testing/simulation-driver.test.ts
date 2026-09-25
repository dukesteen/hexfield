import { describe, expect, test } from 'vitest';
import { exactResourceBounds, RESOURCES } from '@cp2p/engine';
import type { Engine, GameState, Input, Pending, ResourceCounts, Seat } from '@cp2p/engine';
import type { LogContext } from '../log.js';
import { protocolFixture } from './fixtures.js';
import { SimulationDriver } from './simulation-driver.js';

const zero: ResourceCounts = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };

function resourceHand(patch: Partial<ResourceCounts> = {}): ResourceCounts {
  return { ...zero, ...patch };
}

function engineWithHands(base: Engine, hands: ReadonlyMap<Seat, ResourceCounts>): Engine {
  return {
    ...base,
    createPrivateState(seat) {
      return { ...base.createPrivateState(seat), hand: resourceHand(hands.get(seat)) };
    },
  };
}

function stateWithHands(
  state: GameState,
  hands: ReadonlyMap<Seat, ResourceCounts>,
  phase: { id: string; data: unknown },
): GameState {
  const totals = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
  for (const hand of hands.values())
    for (const resource of RESOURCES) totals[resource] += hand[resource];
  const seats = state.seats.map((seat) => {
    const counts = hands.get(seat.seat) ?? zero;
    const bounds = exactResourceBounds(counts);
    if (!bounds.ok) throw new Error(`Invalid hand: ${bounds.error.code}`);
    return { ...seat, resources: bounds.value };
  });
  const bank = { ...state.bank };
  for (const resource of RESOURCES) bank[resource] = (bank[resource] ?? 0) - totals[resource];
  return {
    ...state,
    seats,
    bank,
    turn: { number: 3, activeSeat: 0, phase: [{ id: phase.id, module: 'base', data: phase.data }] },
  };
}

function contextFor(
  genesis: ReturnType<typeof protocolFixture>['genesis'],
  engine: Engine,
  head: ReturnType<typeof protocolFixture>['entry'],
  state: GameState,
): LogContext {
  return { genesis, engine, head, state, lastNonces: new Map() };
}

function phaseData(
  engine: Engine,
  state: GameState,
  kind: string,
): Extract<Pending, { kind: 'random' | 'reveal' }> {
  const pending = engine.getPending(state).find((item) => item.kind !== 'player');
  if (!pending || pending.systemType !== kind) throw new Error(`Expected pending ${kind}`);
  return pending;
}

describe('SimulationDriver', () => {
  test('same committed parent yields deterministic retries and identical peer answers', () => {
    const fixture = protocolFixture();
    const first = new SimulationDriver(fixture.engine, fixture.genesis);
    const second = new SimulationDriver(fixture.engine, fixture.genesis);
    const context = contextFor(fixture.genesis, fixture.engine, fixture.entry, fixture.state);
    const privateBefore = first.privateState(0);
    const answerA = first.next(context);
    const answerB = first.next(context);
    const answerPeer = second.next(context);

    expect(answerA).toEqual(answerB);
    expect(answerA).toEqual(answerPeer);
    expect(answerA?.input.type).toBe('START_SEAT');
    expect(first.privateState(0)).toEqual(privateBefore);
    const ownedCopy = first.privateState(0);
    if (!ownedCopy) throw new Error('Expected private state');
    ownedCopy.hand.ore = 999;
    expect(first.privateState(0)?.hand.ore).toBe(privateBefore?.hand.ore);
  });

  test('CARD_DEALT identity stays out of public input and private state changes only on commit', () => {
    const fixture = protocolFixture();
    const costs = resourceHand({ wool: 1, grain: 1, ore: 1 });
    const hands = new Map<Seat, ResourceCounts>([[0, costs]]);
    const engine = engineWithHands(fixture.engine, hands);
    const main = stateWithHands(fixture.state, hands, { id: 'main', data: null });
    const buyInput = {
      kind: 'command' as const,
      seat: 0 as const,
      command: { type: 'BUY_DEV_CARD' },
    };
    const bought = engine.apply(main, buyInput);
    if (!bought.ok) throw new Error(`Could not buy card: ${bought.error.code}`);
    const before = contextFor(fixture.genesis, engine, fixture.entry, main);
    const afterBuy = contextFor(fixture.genesis, engine, fixture.entry, bought.value.state);
    const first = new SimulationDriver(engine, fixture.genesis);
    const peer = new SimulationDriver(engine, fixture.genesis);

    expect(first.privateState(0)?.hand).toEqual(costs);
    expect(first.committed(before, buyInput, bought.value.state).ok).toBe(true);
    expect(peer.committed(before, buyInput, bought.value.state).ok).toBe(true);
    const held = first.privateState(0);
    if (!held) throw new Error('Expected private state');
    expect(held.hand).toEqual(zero);
    expect(held.slots).toEqual({});

    const answer = first.next(afterBuy);
    const peerAnswer = peer.next(afterBuy);
    expect(answer).toEqual(peerAnswer);
    expect(answer?.input).toMatchObject({
      kind: 'system',
      type: 'CARD_DEALT',
      deck: 'dev',
      seat: 0,
      slotId: 'dev:0',
    });
    expect(answer?.input).not.toHaveProperty('card');
    expect(first.privateState(0)?.slots).toEqual({});

    if (!answer) throw new Error('Expected deterministic card answer');
    const dealt = engine.apply(afterBuy.state, answer.input);
    if (!dealt.ok) throw new Error(`Could not apply card deal: ${dealt.error.code}`);
    expect(first.committed(afterBuy, answer.input, dealt.value.state).ok).toBe(true);
    if (!peerAnswer) throw new Error('Expected peer card answer');
    expect(peer.committed(afterBuy, peerAnswer.input, dealt.value.state).ok).toBe(true);

    const privateCard = first.privateState(0)?.slots['dev:0'];
    expect(privateCard).toBeDefined();
    expect(peer.privateState(0)?.slots['dev:0']).toBe(privateCard);
    expect(first.privateState(1)?.slots).toEqual({});
  });

  test('played development-card identity remains in deck history for a later draw and replay', () => {
    const fixture = protocolFixture();
    const hands = new Map<Seat, ResourceCounts>([[0, resourceHand({ wool: 6, grain: 6, ore: 6 })]]);
    const engine = engineWithHands(fixture.engine, hands);
    const driver = new SimulationDriver(engine, fixture.genesis);
    let state = stateWithHands(fixture.state, hands, { id: 'main', data: null });
    const history: { before: LogContext; input: Input; after: GameState }[] = [];
    const commit = (input: Parameters<Engine['apply']>[1]) => {
      const before = contextFor(fixture.genesis, engine, fixture.entry, state);
      const applied = engine.apply(state, input);
      if (!applied.ok) {
        const type = input.kind === 'command' ? input.command.type : input.type;
        throw new Error(`Engine rejected ${type}: ${applied.error.code}`);
      }
      expect(driver.committed(before, input, applied.value.state)).toMatchObject({ ok: true });
      history.push({ before, input, after: applied.value.state });
      state = applied.value.state;
    };
    const buy = { kind: 'command' as const, seat: 0 as const, command: { type: 'BUY_DEV_CARD' } };
    let playable: { slotId: string; card: string } | null = null;
    let draws = 0;
    while (!playable && draws < 5) {
      commit(buy);
      const answer = driver.next(contextFor(fixture.genesis, engine, fixture.entry, state));
      if (!answer || answer.input.type !== 'CARD_DEALT') throw new Error('Expected card draw');
      commit(answer.input);
      const slotId = `dev:${draws}`;
      const card = driver.privateState(0)?.slots[slotId];
      if (card && card !== 'victoryPoint') playable = { slotId, card };
      draws++;
    }
    if (!playable) throw new Error('Fixture did not draw a playable development card');

    // Advance the fixture turn so the engine permits play; identities still come from committed draws.
    state = { ...state, turn: { ...state.turn, number: state.turn.number + 1 } };
    const params =
      playable.card === 'yearOfPlenty'
        ? { resources: resourceHand({ brick: 2 }) }
        : playable.card === 'monopoly'
          ? { resource: 'brick' }
          : undefined;
    commit({
      kind: 'command',
      seat: 0,
      command: { type: 'PLAY_DEV_CARD', ...playable, ...(params ? { params } : {}) },
    });
    expect(driver.privateState(0)?.slots[playable.slotId]).toBeUndefined();
    expect(state.decks.dev?.drawn).toHaveLength(draws);

    while (state.turn.phase.at(-1)?.id !== 'main') {
      const privateState = driver.privateState(0);
      if (!privateState) throw new Error('Missing private fixture hand');
      const commands = engine.getLegalCommands(state, 0, privateState).commands;
      const command = commands.find((item) => item.type === 'SKIP' || item.type === 'MOVE_ROBBER');
      if (!command) throw new Error(`Cannot finish ${String(state.turn.phase.at(-1)?.id)}`);
      commit({ kind: 'command', seat: 0, command });
    }
    commit(buy);
    const nextContext = contextFor(fixture.genesis, engine, fixture.entry, state);
    const secondDraw = driver.next(nextContext);
    expect(secondDraw?.input).toMatchObject({ type: 'CARD_DEALT', slotId: `dev:${draws}` });
    const replay = new SimulationDriver(engine, fixture.genesis);
    for (const entry of history)
      expect(replay.committed(entry.before, entry.input, entry.after)).toMatchObject({ ok: true });
    expect(replay.next(nextContext)).toEqual(secondDraw);
    if (!secondDraw) throw new Error('Expected second draw');
    commit(secondDraw.input);
    const finalEntry = history.at(-1);
    if (!finalEntry) throw new Error('Missing replay entry');
    expect(replay.committed(finalEntry.before, finalEntry.input, finalEntry.after)).toMatchObject({
      ok: true,
    });
    expect(state.decks.dev?.drawn).toHaveLength(draws + 1);
    expect(state.decks.dev?.remaining).toBe(25 - draws - 1);
    expect(driver.privateState(0)?.slots[playable.slotId]).toBeUndefined();
    expect(driver.privateState(0)?.slots[`dev:${draws}`]).toBeDefined();
    expect(replay.privateState(0)).toEqual(driver.privateState(0));
  });

  test('hidden STEAL_RESULT reveals the resource only in thief and victim private states', () => {
    const fixture = protocolFixture();
    const hands = new Map<Seat, ResourceCounts>([[1, resourceHand({ ore: 1 })]]);
    const engine = engineWithHands(fixture.engine, hands);
    const beforeState = stateWithHands(fixture.state, hands, {
      id: 'stealResult',
      data: { thief: 0, victim: 1, returnTo: 'main' },
    });
    const before = contextFor(fixture.genesis, engine, fixture.entry, beforeState);
    const pending = phaseData(engine, beforeState, 'STEAL_RESULT');
    expect(pending.request).toMatchObject({ thief: 0, victim: 1 });

    const driver = new SimulationDriver(engine, fixture.genesis);
    const answer = driver.next(before);
    expect(answer?.input).toMatchObject({
      kind: 'system',
      type: 'STEAL_RESULT',
      thief: 0,
      victim: 1,
      resource: 'hidden',
    });
    expect(answer?.input).not.toHaveProperty('ore');
    expect(driver.privateState(0)?.hand).toEqual(zero);
    expect(driver.privateState(1)?.hand).toEqual(resourceHand({ ore: 1 }));

    if (!answer) throw new Error('Expected hidden steal answer');
    const after = engine.apply(beforeState, answer.input);
    if (!after.ok) throw new Error(`Could not apply hidden steal: ${after.error.code}`);
    expect(driver.committed(before, answer.input, after.value.state).ok).toBe(true);
    expect(driver.privateState(0)?.hand.ore).toBe(1);
    expect(driver.privateState(1)?.hand.ore).toBe(0);
    expect(driver.privateState(2)?.hand.ore).toBe(0);
  });

  test('refuses a verified genesis', () => {
    const fixture = protocolFixture();
    expect(
      () => new SimulationDriver(fixture.engine, { ...fixture.genesis, security: 'verified' }),
    ).toThrow('Simulation driver requires stub genesis');
  });
});
