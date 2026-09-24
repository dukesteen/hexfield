import { describe, expect, test } from 'vitest';
import type { GameState, PrivateState } from '../../../core/state/index.js';
import { exactResourceBounds } from '../../../core/resources/index.js';
import type { ResourceCounts, Seat } from '../../../core/types/index.js';
import { createBaseEngine } from '../../../index.js';
import { legalRoadEdges, legalSettlementVertices } from '../placement/index.js';
import { frame } from '../shared.js';
import { baseExt } from '../types.js';

const engine = createBaseEngine();
const seed = new Uint8Array(32).fill(8);
const seats: Seat[] = [0, 1, 2, 3];
const empty: ResourceCounts = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
const full: ResourceCounts = { brick: 4, lumber: 4, wool: 4, grain: 4, ore: 4 };

function genesis(options: Record<string, unknown> = {}): GameState {
  return engine.createGame(
    {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats,
      options: { base: { mapLayout: 'random', ...options } },
    },
    seed,
  );
}

function inPhase(state: GameState, id: string, data: unknown = null): GameState {
  return { ...state, turn: { ...state.turn, activeSeat: 0, phase: [frame(id, data)] } };
}

function withHand(state: GameState, seat: Seat, counts: ResourceCounts): GameState {
  const bounds = exactResourceBounds(counts);
  if (!bounds.ok) throw new Error(bounds.error.message);
  return {
    ...state,
    seats: state.seats.map((item) =>
      item.seat === seat ? { ...item, resources: bounds.value } : item,
    ),
  };
}

function privateHand(seat: Seat, hand: ResourceCounts): PrivateState {
  return { ...engine.createPrivateState(seat), hand };
}

function apply(state: GameState, input: Parameters<typeof engine.apply>[1]): GameState {
  const result = engine.apply(state, input);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value.state;
}

function connectedBoard(state: GameState): GameState {
  const vertex = legalSettlementVertices(state, 0, { setup: true })[0];
  if (!vertex) throw new Error('No land vertex');
  const withSettlement = {
    ...state,
    board: {
      ...state.board,
      buildings: [{ vertex, seat: 0 as const, kind: 'settlement' as const }],
    },
  };
  const edge = legalRoadEdges(withSettlement, 0)[0];
  if (!edge) throw new Error('No edge touches vertex');
  return {
    ...withSettlement,
    board: {
      ...withSettlement.board,
      roads: [{ edge, seat: 0 as const }],
    },
    seats: state.seats.map((item) =>
      item.seat === 0
        ? {
            ...item,
            piecesLeft: {
              ...item.piecesLeft,
              settlement: (item.piecesLeft.settlement ?? 0) - 1,
              road: (item.piecesLeft.road ?? 0) - 1,
            },
          }
        : item,
    ),
  };
}

describe('base legal commands', () => {
  test('setup lists only the active seat’s legal placement for each step', () => {
    let state = genesis();
    state = apply(state, { kind: 'system', type: 'START_SEAT', seat: 0 });
    const settlement = engine.getLegalCommands(state, 0);
    expect(settlement.commands.length).toBeGreaterThan(0);
    expect(settlement.commands.every((command) => command.type === 'PLACE_SETTLEMENT')).toBe(true);
    expect(engine.getLegalCommands(state, 1).commands).toEqual([]);
    const vertex = settlement.commands[0]?.vertex;
    if (typeof vertex !== 'string') throw new Error('Missing legal settlement vertex');
    state = apply(state, {
      kind: 'command',
      seat: 0,
      command: { type: 'PLACE_SETTLEMENT', vertex },
    });
    const roads = engine.getLegalCommands(state, 0);
    expect(roads.commands.length).toBeGreaterThan(0);
    expect(roads.commands.every((command) => command.type === 'PLACE_ROAD')).toBe(true);
  });

  test('pre-roll and dice expose no concrete commands to other seats', () => {
    const preRoll = inPhase(genesis(), 'preRoll');
    expect(engine.getLegalCommands(preRoll, 0).commands).toContainEqual({ type: 'ROLL_DICE' });
    expect(engine.getLegalCommands(preRoll, 1)).toEqual({ commands: [], templates: [] });
    const dice = engine.getLegalCommands(inPhase(preRoll, 'dice'), 0);
    expect(dice.commands).toEqual([]);
    expect(dice.templates.some((template) => template.type === 'CLAIM_VICTORY')).toBe(true);
  });

  test('main enumerates only validated affordable actions and respects private hand limits', () => {
    const state = withHand(inPhase(connectedBoard(genesis()), 'main'), 0, full);
    const publicChoices = engine.getLegalCommands(state, 0);
    expect(publicChoices.commands.some((command) => command.type === 'BUILD_ROAD')).toBe(true);
    expect(publicChoices.commands).toContainEqual({ type: 'BUY_DEV_CARD' });
    expect(publicChoices.commands).toContainEqual({ type: 'END_TURN' });
    expect(engine.getLegalCommands(state, 1).templates).toContainEqual({
      type: 'PROPOSE_TRADE',
      give: 'resources',
      want: 'resources',
    });

    const privateChoices = engine.getLegalCommands(state, 0, privateHand(0, empty));
    expect(privateChoices.commands.some((command) => command.type.startsWith('BUILD_'))).toBe(
      false,
    );
    expect(privateChoices.commands).not.toContainEqual({ type: 'BUY_DEV_CARD' });
    expect(
      privateChoices.commands.every(
        (command) => engine.validate(state, { kind: 'command', seat: 0, command }).ok,
      ),
    ).toBe(true);
  });

  test('development-card choices hide current-turn cards and honor the one-card limit', () => {
    let state = inPhase(genesis(), 'preRoll');
    state = {
      ...state,
      turn: { ...state.turn, number: 4 },
      seats: state.seats.map((holder) =>
        holder.seat === 0
          ? {
              ...holder,
              cardSlots: [
                { slotId: 'old', deck: 'dev', acquiredTurn: 3 },
                { slotId: 'new', deck: 'dev', acquiredTurn: 4 },
              ],
            }
          : holder,
      ),
    };
    const priv: PrivateState = {
      ...privateHand(0, empty),
      slots: { old: 'knight', new: 'roadBuilding' },
    };
    expect(engine.getLegalCommands(state, 0, priv).commands).toContainEqual({
      type: 'PLAY_DEV_CARD',
      slotId: 'old',
      card: 'knight',
    });
    expect(
      engine.getLegalCommands(state, 0, priv).commands.some((command) => command.slotId === 'new'),
    ).toBe(false);
    const alreadyPlayed = {
      ...state,
      ext: { ...state.ext, base: { ...baseExt(state.ext.base), devPlayedTurn: 4 } },
    };
    expect(engine.getLegalCommands(alreadyPlayed, 0, priv).commands).not.toContainEqual({
      type: 'PLAY_DEV_CARD',
      slotId: 'old',
      card: 'knight',
    });
  });

  test('victory claims appear as a template without private data and a command with it', () => {
    let state = inPhase(genesis(), 'preRoll');
    state = {
      ...state,
      seats: state.seats.map((holder) =>
        holder.seat === 0
          ? {
              ...holder,
              publicVp: 9,
              cardSlots: [{ slotId: 'vp', deck: 'dev', acquiredTurn: 1 }],
            }
          : holder,
      ),
    };
    expect(engine.getLegalCommands(state, 0).templates).toContainEqual({
      type: 'CLAIM_VICTORY',
      slotIds: 'owned VP slots',
    });
    const priv = { ...privateHand(0, empty), slots: { vp: 'victoryPoint' } };
    expect(engine.getLegalCommands(state, 0, priv).commands).toContainEqual({
      type: 'CLAIM_VICTORY',
      slotIds: ['vp'],
    });
    expect(engine.getLegalCommands(state, 1).commands).toEqual([]);
    for (const [phase, data] of [
      ['moveRobber', { returnTo: 'main' }],
      ['steal', { targets: [1], thief: 0, returnTo: 'main' }],
      ['roadBuilding', { remaining: 2 }],
      ['discard', { remaining: [0] }],
      ['dice', null],
      ['drawDev', { seat: 0, slotId: 'dev:0' }],
      ['monopoly', { seat: 0, resource: 'brick', remaining: [1] }],
      ['stealResult', { thief: 0, victim: 1, returnTo: 'main' }],
    ] as const) {
      const interrupt = inPhase(state, phase, data);
      expect(engine.getLegalCommands(interrupt, 0, priv).commands).toContainEqual({
        type: 'CLAIM_VICTORY',
        slotIds: ['vp'],
      });
    }
  });

  test('discard, robber, steal, and free-road phases enumerate phase-valid actions', () => {
    let state = withHand(inPhase(genesis(), 'discard', { remaining: [0] }), 0, full);
    expect(
      engine.getLegalCommands(state, 0).templates.some((item) => item.type === 'DISCARD'),
    ).toBe(true);
    expect(engine.getLegalCommands(state, 1).templates).toEqual([]);

    state = inPhase(state, 'moveRobber', { returnTo: 'main' });
    const moves = engine.getLegalCommands(state, 0).commands;
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((command) => command.type === 'MOVE_ROBBER')).toBe(true);
    state = inPhase(state, 'steal', { targets: [1], thief: 0, returnTo: 'main' });
    expect(engine.getLegalCommands(state, 0).commands).toContainEqual({ type: 'STEAL', victim: 1 });
    expect(engine.getLegalCommands(state, 1).commands).toEqual([]);

    const roadState = inPhase(connectedBoard(genesis()), 'roadBuilding', { remaining: 2 });
    const freeRoads = engine.getLegalCommands(roadState, 0).commands;
    expect(freeRoads).toContainEqual({ type: 'SKIP' });
    expect(freeRoads.some((command) => command.type === 'PLACE_FREE_ROAD')).toBe(true);
    expect(engine.getLegalCommands(roadState, 1).commands).toEqual([]);
  });

  test('trade choice lists allow response, accepted-offer withdrawal, and party cancellation', () => {
    const base = withHand(
      withHand(genesis(), 0, { brick: 1, lumber: 0, wool: 0, grain: 0, ore: 0 }),
      1,
      { brick: 0, lumber: 1, wool: 0, grain: 0, ore: 0 },
    );
    const state = {
      ...inPhase(base, 'main'),
      ext: {
        ...base.ext,
        base: {
          ...baseExt(base.ext.base),
          offers: [
            {
              id: 7,
              proposer: 0,
              give: { brick: 1, lumber: 0, wool: 0, grain: 0, ore: 0 },
              want: { brick: 0, lumber: 1, wool: 0, grain: 0, ore: 0 },
              to: [1, 2],
              acceptedBy: [1],
              declinedBy: [],
              valid: true,
            },
          ],
        },
      },
    };
    const active = engine.getLegalCommands(state, 0).commands;
    expect(active).toContainEqual({ type: 'CANCEL_TRADE', offerId: 7 });
    expect(active).toContainEqual({ type: 'CONFIRM_TRADE', offerId: 7, withSeat: 1 });
    const acceptedSeat = engine.getLegalCommands(state, 1).commands;
    expect(acceptedSeat).toContainEqual({ type: 'CANCEL_TRADE', offerId: 7 });
    const waitingSeat = engine.getLegalCommands(state, 2).commands;
    expect(waitingSeat).toContainEqual({ type: 'RESPOND_TRADE', offerId: 7, accept: true });
    expect(waitingSeat).toContainEqual({ type: 'RESPOND_TRADE', offerId: 7, accept: false });
    expect(waitingSeat).not.toContainEqual({ type: 'CANCEL_TRADE', offerId: 7 });
  });

  test('disabled player trades disappear from main commands and other-seat templates', () => {
    const state = inPhase(genesis({ playerTrades: false }), 'main');
    const active = engine.getLegalCommands(state, 0);
    expect(
      active.commands.some((command) =>
        ['OFFER_TRADE', 'CONFIRM_TRADE', 'CANCEL_TRADE'].includes(command.type),
      ),
    ).toBe(false);
    expect(active.templates.some((template) => template.type === 'OFFER_TRADE')).toBe(false);
    expect(engine.getLegalCommands(state, 1)).toEqual({ commands: [], templates: [] });
  });
});
