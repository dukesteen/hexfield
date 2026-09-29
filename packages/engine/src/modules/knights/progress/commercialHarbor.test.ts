import { describe, expect, test } from 'vitest';
import type { Seat } from '../../../core/types/index.js';
import type { Input } from '../../../core/pipeline/index.js';
import type { GameState } from '../../../core/state/index.js';
import { handOf, rejection, submit, top, withHand } from '../support.js';
import { knightsExt } from '../types.js';
import {
  engine,
  held,
  play,
  privateOf,
  refusal,
  scene,
  system,
  systemRefusal,
  withBounds,
  withCards,
} from './testing.js';

function position(cards: string[] = ['commercialHarbor']) {
  const { state } = scene();
  let next = withHand(state, 0, { wool: 2, ore: 1 });
  next = withHand(next, 1, { cloth: 2, brick: 1 });
  next = withHand(next, 2, { coin: 1, lumber: 1 });
  return withCards(next, 0, ...cards);
}

const offer = (state: GameState, to: number, resource: string) =>
  submit(engine, state, 0, { type: 'HARBOR_OFFER', to, resource });
const reply = (state: GameState, seat: Seat, commodity: string) =>
  submit(engine, state, seat, { type: 'HARBOR_REPLY', commodity });

describe('Commercial Harbor', () => {
  test('opens a window for the turn: an offer is answered by a commodity and the cards swap', () => {
    const harbor = play(position(), 0, 'commercialHarbor');
    expect(knightsExt(harbor).harbor).toEqual({ seat: 0, cards: 1, offered: [] });
    expect(held(harbor, 0)).toEqual([]);
    const offered = offer(harbor, 1, 'wool');
    expect(top(offered)).toMatchObject({
      id: 'harborReply',
      data: { actor: 0, seat: 1, offered: 'wool' },
    });
    const swapped = reply(offered, 1, 'cloth');
    expect(handOf(swapped, 0)).toMatchObject({ wool: 1, cloth: 1, ore: 1 });
    expect(handOf(swapped, 1)).toMatchObject({ wool: 1, cloth: 1, brick: 1 });
    expect(top(swapped)?.id).toBe('main');
    expect(knightsExt(swapped).harbor?.offered).toEqual([1]);
  });

  test('each seat is offered at most once per harbor, but every seat may be offered', () => {
    const harbor = play(position(), 0, 'commercialHarbor');
    const done = reply(offer(harbor, 1, 'wool'), 1, 'cloth');
    expect(rejection(engine, done, 0, { type: 'HARBOR_OFFER', to: 1, resource: 'wool' })).toBe(
      'no-offer',
    );
    const other = reply(offer(done, 2, 'ore'), 2, 'coin');
    expect(handOf(other, 0)).toMatchObject({ wool: 1, ore: 0, cloth: 1, coin: 1 });
  });

  test('a second harbor in the turn allows a second offer to the same seat', () => {
    const harbor = play(position(['commercialHarbor', 'commercialHarbor']), 0, 'commercialHarbor');
    const done = reply(offer(harbor, 1, 'wool'), 1, 'cloth');
    const again = play(done, 0, 'commercialHarbor');
    expect(knightsExt(again).harbor).toMatchObject({ cards: 2, offered: [1] });
    const twice = reply(offer(again, 1, 'wool'), 1, 'cloth');
    expect(handOf(twice, 1).cloth).toBe(0);
    expect(rejection(engine, twice, 0, { type: 'HARBOR_OFFER', to: 1, resource: 'ore' })).toBe(
      'no-offer',
    );
  });

  test('a seat that has no commodity returns the offer, showing that it holds none', () => {
    const state = withBounds(position(), 1, 2, { cloth: 2, coin: 2, paper: 2, brick: 2 });
    const harbor = play(state, 0, 'commercialHarbor');
    const offered = offer(harbor, 1, 'wool');
    const result = engine.apply(offered, {
      kind: 'command',
      seat: 1,
      command: { type: 'HARBOR_REPLY', commodity: 'none' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.effects).toEqual([
      { type: 'resource-count-revealed', seat: 1, resource: 'cloth', count: 0 },
      { type: 'resource-count-revealed', seat: 1, resource: 'coin', count: 0 },
      { type: 'resource-count-revealed', seat: 1, resource: 'paper', count: 0 },
    ]);
    expect(handOf(result.value.state, 0).wool).toBe(2);
    expect(top(result.value.state)?.id).toBe('main');
    // The seat that lies about holding no commodity is caught by its own hand.
    const liar = privateOf(engine, offered, 1, { cloth: 1, brick: 1 });
    expect(
      engine.applyPrivate(liar, offered, {
        kind: 'command',
        seat: 1,
        command: { type: 'HARBOR_REPLY', commodity: 'none' },
      }).ok,
    ).toBe(false);
  });

  test('a seat that publicly holds a commodity may not decline, and one that publicly holds none is not offered', () => {
    const harbor = play(position(), 0, 'commercialHarbor');
    const offered = offer(harbor, 1, 'wool');
    expect(rejection(engine, offered, 1, { type: 'HARBOR_REPLY', commodity: 'none' })).toBe(
      'has-commodity',
    );
    expect(rejection(engine, offered, 1, { type: 'HARBOR_REPLY', commodity: 'coin' })).toBe(
      'insufficient-resources',
    );
    expect(rejection(engine, offered, 1, { type: 'HARBOR_REPLY', commodity: 'ore' })).toBe(
      'invalid-commodity',
    );
    const none = withHand(position(), 1, { brick: 1 });
    const open = play(none, 0, 'commercialHarbor');
    expect(rejection(engine, open, 0, { type: 'HARBOR_OFFER', to: 1, resource: 'wool' })).toBe(
      'no-offer',
    );
  });

  test('only a resource the player holds may be offered, never a commodity', () => {
    const harbor = play(position(), 0, 'commercialHarbor');
    expect(rejection(engine, harbor, 0, { type: 'HARBOR_OFFER', to: 1, resource: 'brick' })).toBe(
      'insufficient-resources',
    );
    expect(rejection(engine, harbor, 0, { type: 'HARBOR_OFFER', to: 1, resource: 'cloth' })).toBe(
      'invalid-resource',
    );
    expect(rejection(engine, harbor, 0, { type: 'HARBOR_OFFER', to: 0, resource: 'wool' })).toBe(
      'no-offer',
    );
    // With no resource card at all the card itself is refused.
    const broke = withHand(position(), 0, {});
    expect(refusal(broke, 0, 'commercialHarbor')).toBe('no-trade');
  });

  test('the card is refused when nobody could take part, and the window ends with the turn', () => {
    const nobody = withHand(withHand(position(), 1, { brick: 1 }), 2, { lumber: 1 });
    expect(refusal(nobody, 0, 'commercialHarbor')).toBe('no-trade');
    const harbor = play(position(), 0, 'commercialHarbor');
    const ended = submit(engine, harbor, 0, { type: 'END_TURN' });
    expect(knightsExt(ended).harbor).toBeNull();
  });

  test('the two cards may stay hidden: only the swap is public', () => {
    const harbor = play(position(), 0, 'commercialHarbor');
    const offered = submit(engine, harbor, 0, { type: 'HARBOR_OFFER', to: 1, resource: 'hidden' });
    expect(top(offered)).toMatchObject({ data: { offered: 'hidden' } });
    const answer: Input = {
      kind: 'command',
      seat: 1,
      command: { type: 'HARBOR_REPLY', commodity: 'hidden' },
    };
    const result = engine.apply(offered, answer);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.effects).toEqual([
      { type: 'hidden-resource-transfer', from: 0, to: 1, count: 1 },
      { type: 'hidden-resource-transfer', from: 1, to: 0, count: 1 },
    ]);
    const actor = privateOf(engine, offered, 0, { wool: 2, ore: 1 });
    const seat = privateOf(engine, offered, 1, { cloth: 2, brick: 1 });
    const data = { offered: 'wool', returned: 'cloth' };
    const one = engine.applyPrivate(actor, offered, answer, data);
    const two = engine.applyPrivate(seat, offered, answer, data);
    expect(one.ok && one.value.hand).toMatchObject({ wool: 1, cloth: 1 });
    expect(two.ok && two.value.hand).toMatchObject({ wool: 1, cloth: 1 });
    expect(engine.applyPrivate(actor, offered, answer).ok).toBe(false);
  });

  test('a hidden offer needs the private resource, and a timeout answers from a known hand', () => {
    const harbor = play(position(), 0, 'commercialHarbor');
    const offered = submit(engine, harbor, 0, { type: 'HARBOR_OFFER', to: 1, resource: 'hidden' });
    const empty = privateOf(engine, harbor, 0, { ore: 1 });
    expect(
      engine.applyPrivate(
        empty,
        harbor,
        { kind: 'command', seat: 0, command: { type: 'HARBOR_OFFER', to: 1, resource: 'hidden' } },
        { offered: 'wool' },
      ).ok,
    ).toBe(false);
    const timed = system(offered, {
      kind: 'system',
      type: 'TIMEOUT',
      seat: 1,
      phase: 'harborReply',
    });
    expect(top(timed)?.id).toBe('main');
    const vague = play(withBounds(position(), 1, 3, { cloth: 3, brick: 3 }), 0, 'commercialHarbor');
    const asked = offer(vague, 1, 'wool');
    expect(
      systemRefusal(asked, { kind: 'system', type: 'TIMEOUT', seat: 1, phase: 'harborReply' }),
    ).toBe('unsupported-timeout');
  });
});
