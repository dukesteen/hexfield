// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { createBaseEngine } from '@cp2p/engine';
import type { GameState } from '@cp2p/engine';
import game from '../../i18n/locales/en/game.json';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import { GameOverPanel } from './GameOverPanel';

vi.mock('./FairnessStatus.js', () => ({ CheatFlag: () => null, FairnessFindings: () => null }));

const i18n = createInstance();
const presentation: GamePresentation = {
  players: [
    { seat: 0, name: 'Alice', color: 'red', shape: 'circle' },
    { seat: 1, name: 'Bob', color: 'blue', shape: 'square' },
  ],
  botDelayMs: 0,
};
const genesis = createBaseEngine().createGame(
  {
    modules: [{ id: 'base', version: '1.0.0' }],
    seats: [0, 1],
    options: { base: { mapLayout: 'random' } },
  },
  new Uint8Array(32).fill(3),
);
const finished: GameState = { ...genesis, result: { winner: 0, reason: 'vp', atTurn: 30 } };

beforeAll(async () => {
  await i18n.init({
    lng: 'en',
    resources: { en: { game } },
    interpolation: { escapeValue: false },
  });
});
afterEach(cleanup);

function show(onHome?: () => void) {
  return render(
    <I18nextProvider i18n={i18n}>
      <GameOverPanel
        state={finished}
        events={[]}
        presentation={presentation}
        onViewBoard={() => undefined}
        {...(onHome ? { onHome } : {})}
        onExportReplay={() => Promise.resolve()}
      />
    </I18nextProvider>,
  );
}

test('the results offer a way back to the home screen', () => {
  const onHome = vi.fn<() => void>();
  show(onHome);
  fireEvent.click(screen.getByRole('button', { name: 'Home', hidden: true }));
  expect(onHome).toHaveBeenCalledOnce();
});

test('without a home action the results show no Home button', () => {
  show();
  expect(screen.queryByRole('button', { name: 'Home', hidden: true })).toBeNull();
});
