import { describe, expect, test } from 'vitest';
import { seafaringConfig, seafaringEngine } from '@cp2p/engine';
import type { CommandShape, LegalCommandSet, Pending } from '@cp2p/engine';
import { deriveActionAvailability } from './availability.js';

const player = (allowed: string[]): Pending[] => [{ kind: 'player', seat: 0, allowed }];

describe('seafaring action availability', () => {
  test('ships, free ships and the pirate become board placements of their own', () => {
    const build: CommandShape = { type: 'BUILD_SHIP', edge: 'e:1,1,W' };
    const free: CommandShape = { type: 'PLACE_FREE_SHIP', edge: 'e:2,1,NE' };
    const pirate: CommandShape = { type: 'MOVE_PIRATE', hex: 'h:3,0' };
    const legal: LegalCommandSet = {
      commands: [build, free, pirate, { type: 'MOVE_ROBBER', hex: 'h:0,0' }],
      templates: [],
    };
    const availability = deriveActionAvailability(
      legal,
      player(['BUILD_SHIP', 'PLACE_FREE_SHIP', 'MOVE_PIRATE', 'MOVE_ROBBER']),
      0,
    );
    expect(availability.placements.ship).toEqual([
      { id: 'e:1,1,W', type: 'BUILD_SHIP', command: build },
    ]);
    expect(availability.placements.freeShip.map((choice) => choice.id)).toEqual(['e:2,1,NE']);
    expect(availability.placements.pirate.map((choice) => choice.id)).toEqual(['h:3,0']);
    expect(availability.placements.robber.map((choice) => choice.id)).toEqual(['h:0,0']);
    // Board placements never show up as action-bar buttons.
    expect(availability.primary).toEqual([]);
  });

  test('a ship move keeps its origin, so the ship can be chosen before its destination', () => {
    const one: CommandShape = { type: 'MOVE_SHIP', from: 'e:0,0,W', to: 'e:5,5,W' };
    const two: CommandShape = { type: 'MOVE_SHIP', from: 'e:0,0,W', to: 'e:6,5,W' };
    const other: CommandShape = { type: 'MOVE_SHIP', from: 'e:1,0,W', to: 'e:5,5,W' };
    const availability = deriveActionAvailability(
      { commands: [one, two, other], templates: [] },
      player(['MOVE_SHIP']),
      0,
    );
    expect(availability.placements.moveShip).toEqual([
      { id: 'e:5,5,W', from: 'e:0,0,W', type: 'MOVE_SHIP', command: one },
      { id: 'e:6,5,W', from: 'e:0,0,W', type: 'MOVE_SHIP', command: two },
      { id: 'e:5,5,W', from: 'e:1,0,W', type: 'MOVE_SHIP', command: other },
    ]);
  });

  test('commands outside the seat pending request are not offered', () => {
    const availability = deriveActionAvailability(
      { commands: [{ type: 'MOVE_SHIP', from: 'e:0,0,W', to: 'e:5,5,W' }], templates: [] },
      player(['END_TURN']),
      0,
    );
    expect(availability.placements.moveShip).toEqual([]);
  });

  test('a coastal setup settlement offers both a road and a setup ship, exactly as the engine lists them', () => {
    const engine = seafaringEngine();
    const genesis = engine.createGame(seafaringConfig({ seats: 2 }), new Uint8Array(32).fill(5));
    const started = engine.apply(genesis, { kind: 'system', type: 'START_SEAT', seat: 0 });
    if (!started.ok) throw new Error(started.error.message);
    const sites = engine
      .getLegalCommands(started.value.state, 0)
      .commands.filter((command) => command.type === 'PLACE_SETTLEMENT');
    const coastal = sites.find((site) => {
      const placed = engine.apply(started.value.state, { kind: 'command', seat: 0, command: site });
      return (
        placed.ok &&
        engine
          .getLegalCommands(placed.value.state, 0)
          .commands.some((command) => command.type === 'PLACE_SETUP_SHIP')
      );
    });
    if (!coastal) throw new Error('No coastal setup site');
    const placed = engine.apply(started.value.state, {
      kind: 'command',
      seat: 0,
      command: coastal,
    });
    if (!placed.ok) throw new Error(placed.error.message);
    const legal = engine.getLegalCommands(placed.value.state, 0);
    const availability = deriveActionAvailability(legal, engine.getPending(placed.value.state), 0);
    expect(availability.placements.ship.map((choice) => choice.command)).toEqual(
      legal.commands.filter((command) => command.type === 'PLACE_SETUP_SHIP'),
    );
    expect(availability.placements.road.map((choice) => choice.command)).toEqual(
      legal.commands.filter((command) => command.type === 'PLACE_ROAD'),
    );
    expect(availability.placements.ship.length).toBeGreaterThan(0);
    expect(availability.placements.road.length).toBeGreaterThan(0);
  });
});
