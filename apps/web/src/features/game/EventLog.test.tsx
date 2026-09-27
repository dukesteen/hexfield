// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, render, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { GameEvent } from '@cp2p/engine';
import { getDieUrl, getFactionUrl, getGameArtUrl, getPieceIconUrl } from '@cp2p/renderer';
import game from '../../i18n/locales/en/game.json';
import log from '../../i18n/locales/en/log.json';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import { EventLog } from './EventLog';

vi.mock('./FairnessStatus.js', () => ({ FairnessFindings: () => null }));

const i18n = createInstance();
const presentation: GamePresentation = {
  players: [
    { seat: 0, name: 'Alice', color: 'red', shape: 'circle' },
    { seat: 1, name: 'Bob', color: 'blue', shape: 'square' },
  ],
  botDelayMs: 0,
};

beforeAll(async () => {
  await i18n.init({
    lng: 'en',
    resources: { en: { game, log } },
    interpolation: { escapeValue: false },
  });
});
afterEach(cleanup);

function show(events: readonly GameEvent[]) {
  return render(
    <I18nextProvider i18n={i18n}>
      <EventLog events={events} presentation={presentation} initiallyOpen />
    </I18nextProvider>,
  );
}

test('shows newest events first with dice and player-colored action art', () => {
  const view = show([
    { type: 'roadBuilt', seat: 0, edge: 'e:0,0,W' },
    { type: 'tradeConfirmed', offerId: 1 },
    { type: 'diceRolled', dice: [2, 5], roll: 7 },
  ]);
  const rows = within(view.container).getAllByRole('listitem');
  expect(rows).toHaveLength(3);
  expect(rows[0]?.textContent).toContain('7');
  expect(rows[0]?.querySelectorAll('.event-log-action')).toHaveLength(2);
  expect(rows[0]?.querySelectorAll('.event-log-faction')).toHaveLength(0);
  expect(rows[0]?.querySelectorAll('.event-log-action')[0]?.getAttribute('src')).toBe(getDieUrl(2));
  expect(rows[0]?.querySelectorAll('.event-log-action')[1]?.getAttribute('src')).toBe(getDieUrl(5));
  expect(rows[1]?.querySelectorAll('.event-log-faction')).toHaveLength(0);
  expect(rows[2]?.querySelector('.event-log-faction')?.getAttribute('src')).toBe(
    getFactionUrl('red'),
  );
  expect(rows[2]?.querySelector('.event-log-action')?.getAttribute('src')).toBe(
    getPieceIconUrl('road', 'red'),
  );
  expect(view.container.querySelector('ol')?.getAttribute('role')).toBe('list');
});

test('production shows its public recipients while system and private-card events stay anonymous', () => {
  const view = show([
    { type: 'resourcesProduced', bySeat: { '0': { grain: 1 }, '1': { brick: 2 } } },
    { type: 'resourceStolen', thief: 1, victim: 0, resource: 'ore' },
    { type: 'devCardDealt', seat: 0, card: 'monopoly', slotId: 'private:1' },
    { type: 'phaseChanged', phase: 'main', seat: 0 },
  ]);
  const rows = within(view.container).getAllByRole('listitem');
  expect(rows[0]?.querySelectorAll('.event-log-faction')).toHaveLength(0);
  expect(rows[1]?.querySelector('.event-log-faction')?.getAttribute('src')).toBe(
    getFactionUrl('red'),
  );
  expect(rows[1]?.querySelector('.event-log-action')?.getAttribute('src')).toBe(
    getGameArtUrl('cardBack'),
  );
  expect(rows[2]?.querySelector('.event-log-faction')?.getAttribute('src')).toBe(
    getFactionUrl('blue'),
  );
  expect(rows[2]?.querySelector('.event-log-action')?.getAttribute('src')).toBe(
    getGameArtUrl('cardBack'),
  );
  expect(rows[3]?.querySelectorAll('.event-log-faction')).toHaveLength(2);
  expect(rows[3]?.querySelectorAll('.event-log-action').length).toBeGreaterThan(0);
  expect(view.container.textContent).not.toContain('monopoly');
  expect(view.container.textContent).not.toContain('private:1');
  expect(view.container.textContent).not.toContain('Ore');
});

test('a roll without recorded faces uses a neutral die icon', () => {
  const view = show([{ type: 'diceRolled', roll: 8 }]);
  const row = within(view.container).getByRole('listitem');
  expect(row.querySelector('.event-log-action')?.getAttribute('src')).toMatch(
    /^data:image\/svg\+xml,/,
  );
  expect(row.querySelector('.event-log-faction')).toBeNull();
});
