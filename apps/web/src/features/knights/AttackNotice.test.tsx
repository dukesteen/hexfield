// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { knightsExt } from '@cp2p/engine';
import type { AttackReport, GameState } from '@cp2p/engine';
import type { BoardRenderer } from '@cp2p/renderer';
import { useSessionStore } from '../../store/session-store';
import { BarbarianAttackNotice } from './AttackNotice';
import { genesis, presentation, testI18n } from './test-support';

let i18n: Awaited<ReturnType<typeof testI18n>>;
beforeAll(async () => {
  i18n = await testI18n();
});
afterEach(() => {
  cleanup();
  useSessionStore.setState({ revealedSeat: null });
});

function withAttack(
  state: GameState,
  report: Partial<AttackReport> | null,
  robberLocked: boolean,
  turn = 9,
): GameState {
  const ext = knightsExt(state);
  return {
    ...state,
    turn: { ...state.turn, number: turn },
    ext: {
      ...state.ext,
      knights: {
        ...ext,
        robberLocked,
        lastAttack: report && {
          turn: 9,
          strength: 3,
          defense: 5,
          contributions: [2, 3, 0],
          outcome: 'defended',
          defender: 1,
          tied: [],
          pillaged: [],
          ...report,
        },
      },
    },
  };
}

function view(state: GameState) {
  return (
    <I18nextProvider i18n={i18n}>
      <BarbarianAttackNotice
        state={state}
        hints={[]}
        presentation={presentation}
        renderer={null}
        openFixture={() => undefined}
      />
    </I18nextProvider>
  );
}

test('an attack that happens while playing is announced until it is dismissed', () => {
  useSessionStore.setState({ revealedSeat: 1 });
  const before = withAttack(genesis, null, true, 9);
  const page = render(view(before));
  expect(screen.queryByTestId('barbarian-attack-notice')).toBeNull();

  page.rerender(view(withAttack(genesis, {}, false, 9)));
  const notice = screen.getByTestId('barbarian-attack-notice');
  expect(notice.textContent).toContain('Barbarians attack!');
  expect(notice.textContent).toContain('The knights held the line.');
  expect(notice.textContent).toContain('You led the defense');
  // The first attack frees the robber.
  expect(notice.textContent).toContain('The robber is now active.');

  fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
  expect(screen.queryByTestId('barbarian-attack-notice')).toBeNull();
});

test('it stays for a round, then leaves on its own', () => {
  const page = render(view(withAttack(genesis, null, false, 9)));
  page.rerender(view(withAttack(genesis, { outcome: 'pillaged' }, false, 9)));
  expect(screen.getByTestId('barbarian-attack-notice').dataset.outcome).toBe('pillaged');
  page.rerender(view(withAttack(genesis, { outcome: 'pillaged' }, false, 11)));
  expect(screen.getByTestId('barbarian-attack-notice').textContent).not.toContain('robber');
  page.rerender(view(withAttack(genesis, { outcome: 'pillaged' }, false, 12)));
  expect(screen.queryByTestId('barbarian-attack-notice')).toBeNull();
});

test('an attack already on record when the game opens is not announced again', () => {
  render(view(withAttack(genesis, {}, false, 9)));
  expect(screen.queryByTestId('barbarian-attack-notice')).toBeNull();
});

test('a ring marks each lost city on the board while the notice is up', () => {
  const renderer = {
    getPixelPosition: () => ({ x: 120, y: 80 }),
    subscribeViewChange: () => () => undefined,
    fitToBoard: () => undefined,
  };
  const lost: Partial<AttackReport> = {
    outcome: 'pillaged',
    pillaged: [{ seat: 0, vertex: 'v:0,0,N', sideways: false }],
  };
  const hud = (state: GameState) => (
    <I18nextProvider i18n={i18n}>
      <BarbarianAttackNotice
        state={state}
        hints={[]}
        presentation={presentation}
        // The notice reads only these members of the renderer.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        renderer={renderer as unknown as BoardRenderer}
        openFixture={() => undefined}
      />
    </I18nextProvider>
  );
  const page = render(hud(withAttack(genesis, null, false, 9)));
  page.rerender(hud(withAttack(genesis, lost, false, 9)));
  const marker = screen.getByTestId('barbarian-attack-marker');
  expect(marker.style.left).toBe('120px');
  expect(marker.textContent).toBe('Lost city');
  fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
  expect(screen.queryByTestId('barbarian-attack-marker')).toBeNull();
});
