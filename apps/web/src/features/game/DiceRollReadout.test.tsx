// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { afterEach, beforeAll, expect, test } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import type { GameEvent } from '@cp2p/engine';
import game from '../../i18n/locales/en/game.json';
import { DiceRollReadout, latestDiceRoll } from './DiceRollReadout.js';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { game } }, initImmediate: false });
});
afterEach(cleanup);

test('readout uses the latest public dice event and announces the total', () => {
  const events: GameEvent[] = [
    { type: 'diceRolled', dice: [2, 3], roll: 5 },
    { type: 'resourcesProduced', bySeat: {} },
    { type: 'diceRolled', dice: [6, 1], roll: 7 },
  ];
  const lastRoll = latestDiceRoll(events);
  expect(lastRoll).toEqual({ faces: [6, 1], total: 7 });
  if (!lastRoll) throw new Error('Expected a public dice roll');

  render(
    <I18nextProvider i18n={i18n}>
      <DiceRollReadout dice={lastRoll} />
    </I18nextProvider>,
  );

  expect(screen.getByRole('img', { name: 'Last roll: 6 and 1, total 7' })).toBeTruthy();
  expect(screen.getByText('Last roll')).toBeTruthy();
  expect(screen.getByText('7')).toBeTruthy();
});

test('readout stays absent until a valid public roll exists', () => {
  expect(latestDiceRoll([{ type: 'phaseChanged', phase: 'main' }])).toBeNull();
  expect(
    latestDiceRoll([
      { type: 'diceRolled', dice: [2, 3], roll: 5 },
      { type: 'diceRolled', dice: [2, 8], roll: 10 },
    ]),
  ).toEqual({ faces: [2, 3], total: 5 });

  render(
    <I18nextProvider i18n={i18n}>
      <DiceRollReadout dice={null} />
    </I18nextProvider>,
  );
  expect(screen.queryByRole('img')).toBeNull();
});
