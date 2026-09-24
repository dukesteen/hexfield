import { describe, expect, test } from 'vitest';
import { baseModule, createBaseEngine } from '../../modules/base/index.js';
import { frame } from '../../modules/base/shared.js';
import { createRegistry } from '../modules/registry.js';
import { testCounter, config, seed } from './__tests__/testCounter.js';
import { createEngine } from './engine.js';

const base = createBaseEngine();
const genesis = base.createGame(
  {
    modules: [{ id: 'base', version: '1.0.0' }],
    seats: [0, 1, 2],
    options: { base: { mapLayout: 'random' } },
  },
  new Uint8Array(32),
);

describe('declared input fields', () => {
  test('rejects extra envelope and payload keys before pending checks', () => {
    const extraStart = JSON.parse('{"kind":"system","type":"START_SEAT","seat":0,"__proto__":1}');
    expect(base.validate(genesis, extraStart)).toMatchObject({
      ok: false,
      error: { code: 'unknown-field' },
    });
    const started = base.apply(genesis, { kind: 'system', type: 'START_SEAT', seat: 0 });
    if (!started.ok) throw new Error(started.error.message);
    const choice = base.getLegalCommands(started.value.state, 0).commands[0];
    if (!choice) throw new Error('No setup command');
    const extraEnvelope = { kind: 'command' as const, seat: 0 as const, command: choice, extra: 1 };
    expect(base.validate(started.value.state, extraEnvelope)).toMatchObject({
      ok: false,
      error: { code: 'unknown-field' },
    });
    expect(
      base.validate(started.value.state, {
        kind: 'command',
        seat: 0,
        command: { ...choice, constructor: 1 },
      }),
    ).toMatchObject({ ok: false, error: { code: 'unknown-field' } });
    expect(
      base.validate(
        started.value.state,
        JSON.parse(
          '{"kind":"command","seat":0,"command":{"type":"PLACE_SETTLEMENT","vertex":"x","toString":1}}',
        ),
      ),
    ).toMatchObject({ ok: false, error: { code: 'unknown-field' } });
    expect(
      base.validate(started.value.state, {
        kind: 'system',
        type: 'DICE_RESULT',
        dice: [1, 1],
        unexpected: true,
      }),
    ).toMatchObject({ ok: false, error: { code: 'unknown-field' } });
    expect(
      base.validate(started.value.state, {
        kind: 'system',
        type: 'SEAT_STATUS',
        seat: 0,
        status: 'bot',
        surprise: true,
      }),
    ).toMatchObject({ ok: false, error: { code: 'unknown-field' } });
  });

  test('checks card params and random dice mode without rejecting allowed omissions', () => {
    const state = {
      ...genesis,
      turn: { ...genesis.turn, number: 3, activeSeat: 0 as const, phase: [frame('main')] },
      seats: genesis.seats.map((holder) =>
        holder.seat === 0
          ? { ...holder, cardSlots: [{ slotId: 'dev:0', deck: 'dev', acquiredTurn: 2 }] }
          : holder,
      ),
    };
    const play = (card: string, params?: unknown) =>
      base.validate(state, {
        kind: 'command',
        seat: 0,
        command: {
          type: 'PLAY_DEV_CARD',
          slotId: 'dev:0',
          card,
          ...(params === undefined ? {} : { params }),
        },
      });
    expect(play('knight').ok).toBe(true);
    expect(play('knight', {})).toMatchObject({ ok: false, error: { code: 'unknown-field' } });
    expect(play('roadBuilding', { extra: 1 })).toMatchObject({
      ok: false,
      error: { code: 'unknown-field' },
    });
    expect(play('yearOfPlenty', { resources: { brick: 2 }, extra: 1 })).toMatchObject({
      ok: false,
      error: { code: 'unknown-field' },
    });
    expect(play('monopoly', { resource: 'brick', extra: 1 })).toMatchObject({
      ok: false,
      error: { code: 'unknown-field' },
    });
    expect(play('monopoly', { resource: 'brick' }).ok).toBe(true);
    const dice = { ...genesis, turn: { ...genesis.turn, phase: [frame('dice')] } };
    expect(
      base.validate(dice, { kind: 'system', type: 'DICE_RESULT', dice: [1, 1], index: 0 }),
    ).toMatchObject({ ok: false, error: { code: 'unknown-field' } });
    expect(base.validate(dice, { kind: 'system', type: 'DICE_RESULT', dice: [1, 1] }).ok).toBe(
      true,
    );
  });

  test('snapshots handler declarations and keeps undeclared extension handlers open', () => {
    const custom = testCounter();
    const allowed = ['amount'];
    const optional = ['amount'];
    const handler = custom.commands.INC;
    if (!handler) throw new Error('Missing counter handler');
    handler.keys = { allowed, optional };
    const registry = createRegistry([custom]);
    allowed.push('extra');
    optional.push('extra');
    expect(registry.commands.get('INC')?.handler.keys).toEqual({
      allowed: ['amount'],
      optional: ['amount'],
    });
    expect(Object.isFrozen(registry.commands.get('INC')?.handler.keys?.allowed)).toBe(true);
    const open = createEngine([testCounter()]);
    const before = open.createGame(config, seed);
    const started = open.apply(before, { kind: 'system', type: 'START_SEAT', seat: 0 });
    if (!started.ok) throw new Error(started.error.message);
    expect(
      open.validate(started.value.state, {
        kind: 'command',
        seat: 0,
        command: { type: 'INC', amount: 1, extra: 'allowed for extensions' },
      }).ok,
    ).toBe(true);
  });

  test('declares every base command and system payload', () => {
    const module = baseModule();
    expect(Object.values(module.commands).every((handler) => handler.keys !== undefined)).toBe(
      true,
    );
    expect(Object.values(module.systemInputs).every((handler) => handler.keys !== undefined)).toBe(
      true,
    );
  });

  test('rejects duplicate, reserved, and non-subset declarations at registration', () => {
    const duplicate = testCounter();
    const inc = duplicate.commands.INC;
    if (!inc) throw new Error('Missing counter command');
    inc.keys = { allowed: ['amount', 'amount'] };
    expect(() => createRegistry([duplicate])).toThrow(/duplicate or reserved/);
    inc.keys = { allowed: ['type'] };
    expect(() => createRegistry([duplicate])).toThrow(/duplicate or reserved/);
    inc.keys = { allowed: ['amount'], optional: ['other'] };
    expect(() => createRegistry([duplicate])).toThrow(/Optional input keys/);
    const system = testCounter();
    const start = system.systemInputs.START_SEAT;
    if (!start) throw new Error('Missing counter system handler');
    start.keys = { allowed: ['kind'] };
    expect(() => createRegistry([system])).toThrow(/duplicate or reserved/);
    const timeout = testCounter();
    timeout.systemInputs.TIMEOUT = {
      keys: { allowed: ['seat'] },
      validate: () => ({ ok: true, value: undefined }),
      apply: (state) => ({ state, events: [] }),
    };
    expect(() => createRegistry([timeout])).toThrow(/seat and phase/);
  });
});
