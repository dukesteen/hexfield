import { beforeAll, expect, test } from 'vitest';
import { createInstance } from 'i18next';
import game from '../../i18n/locales/en/game.json';
import log from '../../i18n/locales/en/log.json';
import { formatGameEvent } from './event-format';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en',
    resources: { en: { game, log } },
    interpolation: { escapeValue: false },
  });
});
const label = (seat: number) => `Player ${seat + 1}`;

test('public production is readable and omits zero shortage gains', () => {
  const text = formatGameEvent(
    { type: 'resourcesProduced', bySeat: { '0': { grain: 2, ore: 0 }, '1': { brick: 1 } } },
    i18n.t,
    label,
  );
  expect(text).toContain('Player 1: +2 Grain');
  expect(text).toContain('Player 2: +1 Brick');
  expect(text).not.toContain('Ore');
});

test('steal and development deal messages never expose private identities', () => {
  const stolen = formatGameEvent(
    { type: 'resourceStolen', thief: 0, victim: 1, resource: 'ore' },
    i18n.t,
    label,
  );
  expect(stolen).toBe('Player 1 stole a card from Player 2.');
  expect(stolen).not.toContain('ore');
  const dealt = formatGameEvent(
    { type: 'devCardDealt', seat: 1, slotId: 'dev:3', card: 'monopoly' },
    i18n.t,
    label,
  );
  expect(dealt).toBe('Player 2 received a development card.');
});

test('trade response and completion use their actual public event names', () => {
  expect(formatGameEvent({ type: 'tradeResponded', seat: 1, accept: false }, i18n.t, label)).toBe(
    'Player 2 declined a trade offer.',
  );
  expect(formatGameEvent({ type: 'tradeConfirmed' }, i18n.t, label)).toBe('A trade was completed.');
});

test('seafaring events name the ship, the pirate and the gold taken', () => {
  expect(formatGameEvent({ type: 'shipBuilt', seat: 0, edge: 'e:1,1,W' }, i18n.t, label)).toBe(
    'Player 1 built a ship.',
  );
  expect(
    formatGameEvent({ type: 'shipMoved', seat: 1, from: 'e:1,1,W', to: 'e:2,1,W' }, i18n.t, label),
  ).toBe('Player 2 moved a ship.');
  expect(formatGameEvent({ type: 'pirateMoved', seat: 2, hex: 'h:3,0' }, i18n.t, label)).toBe(
    'Player 3 moved the pirate.',
  );
  expect(
    formatGameEvent(
      {
        type: 'goldChosen',
        seat: 0,
        resources: { brick: 0, lumber: 1, wool: 0, grain: 0, ore: 1 },
      },
      i18n.t,
      label,
    ),
  ).toBe('Player 1 took gold: +1 Lumber, +1 Ore.');
});
