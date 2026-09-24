import { describe, expect, test } from 'vitest';
import { LocalGame } from '../../core/pipeline/index.js';
import type { LocalRandomSource } from '../../core/pipeline/index.js';
import type { GameConfig } from '../../core/state/index.js';
import { createBaseEngine } from './index.js';

const engine = createBaseEngine();
const config: GameConfig = {
  modules: [{ id: 'base', version: '1.0.0' }],
  seats: [0, 1, 2, 3],
  options: { base: { mapLayout: 'random' } },
};

function source(): LocalRandomSource {
  return {
    resolve: (pending) => {
      if (pending.systemType === 'START_SEAT')
        return { input: { kind: 'system', type: 'START_SEAT', seat: 0 } };
      if (pending.systemType === 'DICE_RESULT')
        return { input: { kind: 'system', type: 'DICE_RESULT', dice: [1, 1] } };
      throw new Error(`Unexpected request ${pending.systemType}`);
    },
  };
}

describe('base game setup and turn flow', () => {
  test('snake setup pays second settlements and reaches a live main phase', () => {
    const created = LocalGame.create(engine, config, new Uint8Array(32), source());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const game = created.value;
    for (let index = 0; index < 8; index++) {
      const settlement = game
        .getPending()
        .find(
          (pending) => pending.kind === 'player' && pending.allowed.includes('PLACE_SETTLEMENT'),
        );
      if (settlement?.kind !== 'player') throw new Error('Missing setup settlement');
      const choice = engine
        .getLegalCommands(game.snapshot(), settlement.seat)
        .commands.find((command) => command.type === 'PLACE_SETTLEMENT');
      if (!choice || typeof choice.vertex !== 'string')
        throw new Error('No legal setup settlement');
      expect(game.submit({ kind: 'command', seat: settlement.seat, command: choice }).ok).toBe(
        true,
      );
      const road = game
        .getPending()
        .find((pending) => pending.kind === 'player' && pending.allowed.includes('PLACE_ROAD'));
      if (road?.kind !== 'player') throw new Error('Missing setup road');
      const roadChoice = engine
        .getLegalCommands(game.snapshot(), road.seat)
        .commands.find((command) => command.type === 'PLACE_ROAD');
      if (!roadChoice || typeof roadChoice.edge !== 'string')
        throw new Error('No legal setup road');
      expect(game.submit({ kind: 'command', seat: road.seat, command: roadChoice }).ok).toBe(true);
      expect(engine.checkInvariants(game.snapshot())).toEqual([]);
    }
    expect(game.state.turn.activeSeat).toBe(0);
    expect(game.state.turn.phase.at(-1)?.id).toBe('preRoll');
    expect(game.state.board.buildings).toHaveLength(8);
    expect(game.state.board.roads).toHaveLength(8);
    expect(game.state.seats.every((seat) => seat.resources.total >= 0)).toBe(true);
    expect(game.submit({ kind: 'command', seat: 0, command: { type: 'ROLL_DICE' } }).ok).toBe(true);
    expect(game.state.turn.phase.at(-1)?.id).toBe('main');
    expect(engine.checkInvariants(game.snapshot())).toEqual([]);
  });

  test('base genesis refuses five or six seats', () => {
    expect(() =>
      engine.createGame({ ...config, seats: [0, 1, 2, 3, 4] }, new Uint8Array(32)),
    ).toThrow(/two to four/);
  });
});
