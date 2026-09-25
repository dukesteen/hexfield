import { describe, expect, test } from 'vitest';
import { createBaseEngine } from '@cp2p/engine';
import type { CommandShape, LegalCommandSet, Pending } from '@cp2p/engine';
import { deriveActionAvailability } from './availability.js';

const engine = createBaseEngine();
const genesis = engine.createGame(
  {
    modules: [{ id: 'base', version: '1.0.0' }],
    seats: [0, 1, 2],
    options: { base: { mapLayout: 'random' } },
  },
  new Uint8Array(32).fill(4),
);

describe('action availability', () => {
  test('setup highlights are exactly the engine-offered settlement and road commands', () => {
    const started = engine.apply(genesis, { kind: 'system', type: 'START_SEAT', seat: 0 });
    if (!started.ok) throw new Error(started.error.message);
    const legal = engine.getLegalCommands(started.value.state, 0);
    const availability = deriveActionAvailability(legal, engine.getPending(started.value.state), 0);
    expect(availability.placements.settlement.map((choice) => choice.id)).toEqual(
      legal.commands.map((command) => command.vertex),
    );
    expect(availability.placements.settlement.map((choice) => choice.command)).toEqual(
      legal.commands,
    );
    expect(availability.placements.road).toEqual([]);
    const first = availability.placements.settlement[0]?.command;
    if (!first) throw new Error('No legal settlement');
    const settled = engine.apply(started.value.state, { kind: 'command', seat: 0, command: first });
    if (!settled.ok) throw new Error(settled.error.message);
    const roads = engine.getLegalCommands(settled.value.state, 0);
    const roadActions = deriveActionAvailability(roads, engine.getPending(settled.value.state), 0);
    expect(roadActions.placements.road.map((choice) => choice.id)).toEqual(
      roads.commands.map((command) => command.edge),
    );
    for (const choice of roadActions.placements.road)
      expect(roads.commands).toContain(choice.command);
  });

  test('constrained board targets, card slots and form templates retain exact source commands', () => {
    const allowedRoad: CommandShape = { type: 'BUILD_ROAD', edge: 'e:allowed' };
    const forbiddenRoad: CommandShape = { type: 'BUILD_ROAD', edge: 'e:forbidden' };
    const robber: CommandShape = { type: 'MOVE_ROBBER', hex: 'h:only' };
    const legal: LegalCommandSet = {
      commands: [
        allowedRoad,
        forbiddenRoad,
        robber,
        { type: 'PLAY_DEV_CARD', slotId: 'slot-1', card: 'monopoly', params: { resource: 'ore' } },
        { type: 'END_TURN' },
      ],
      templates: [
        { type: 'DISCARD', count: 2 },
        { type: 'OFFER_TRADE', give: 'resources', want: 'resources' },
        { type: 'MARITIME_TRADE', give: 'rate multiples', get: 'resources' },
        {
          type: 'PLAY_DEV_CARD',
          slotId: 'slot-2',
          card: 'yearOfPlenty',
          params: { resources: 'choose two' },
        },
      ],
    };
    const pending: Pending[] = [
      {
        kind: 'player',
        seat: 1,
        allowed: [
          'BUILD_ROAD',
          'MOVE_ROBBER',
          'PLAY_DEV_CARD',
          'DISCARD',
          'OFFER_TRADE',
          'MARITIME_TRADE',
        ],
      },
    ];
    const actions = deriveActionAvailability(legal, pending, 1);
    expect(actions.placements.road.map((choice) => choice.id)).toEqual([
      'e:allowed',
      'e:forbidden',
    ]);
    expect(actions.placements.road[0]?.command).toBe(allowedRoad);
    expect(actions.placements.robber.map((choice) => choice.id)).toEqual(['h:only']);
    expect(actions.primary.map((group) => group.type)).toEqual([
      'DISCARD',
      'OFFER_TRADE',
      'MARITIME_TRADE',
    ]);
    expect(actions.templates.map((group) => group.type)).toEqual([
      'DISCARD',
      'OFFER_TRADE',
      'MARITIME_TRADE',
      'PLAY_DEV_CARD',
    ]);
    expect(actions.cardPlays.map((group) => [group.slotId, group.card])).toEqual([
      ['slot-1', 'monopoly'],
      ['slot-2', 'yearOfPlenty'],
    ]);
    expect(actions.availableTypes).not.toContain('END_TURN');
    expect(actions.placements.city).toEqual([]);
    expect(actions.placements.settlement).toEqual([]);
    expect(actions.placements.freeRoad).toEqual([]);
  });

  test('another seat or a system-only pending cannot create action availability', () => {
    const legal: LegalCommandSet = {
      commands: [{ type: 'END_TURN' }],
      templates: [{ type: 'DISCARD', count: 1 }],
    };
    const pending: Pending[] = [
      { kind: 'player', seat: 0, allowed: ['END_TURN', 'DISCARD'] },
      { kind: 'random', systemType: 'DICE_RESULT', request: { type: 'dice' } },
    ];
    const actions = deriveActionAvailability(legal, pending, 1);
    expect(actions.allowedTypes).toEqual([]);
    expect(actions.availableTypes).toEqual([]);
    expect(actions.primary).toEqual([]);
    expect(actions.templates).toEqual([]);
  });
});
