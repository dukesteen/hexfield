// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import type { MobileTab } from './MobileGameControls.js';
import { MobileGameControls } from './MobileGameControls.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

function renderControls(
  step: Parameters<typeof MobileGameControls>[0]['step'],
  options: {
    onReturnToBoard?: () => void;
    onResults?: () => void;
  } = {},
) {
  const onOpenTab = vi.fn<(tab: MobileTab, trigger: HTMLButtonElement) => void>();
  const onResults = options.onResults ?? vi.fn<() => void>();
  const view = render(
    <MobileGameControls
      step={step}
      hasOptional
      playerColor="orange"
      onOpenTab={onOpenTab}
      {...(options.onReturnToBoard ? { onReturnToBoard: options.onReturnToBoard } : {})}
      onResults={onResults}
      resultsButton={createRef<HTMLButtonElement>()}
      actionsButton={createRef<HTMLButtonElement>()}
    />,
  );
  return { ...view, onOpenTab, onResults };
}

test('runs the current command and opens a requested action panel', () => {
  const run = vi.fn<() => void>();
  const { onOpenTab } = renderControls({
    kind: 'command',
    label: 'Roll dice',
    rollDice: true,
    run,
  });

  fireEvent.click(screen.getByRole('button', { name: 'Roll dice' }));
  expect(run).toHaveBeenCalledOnce();

  const tradeTab = screen.getByRole('button', { name: 'game:tradePanel' });
  fireEvent.click(tradeTab);
  expect(onOpenTab).toHaveBeenCalledWith('trade', tradeTab);
});

test('announces board instructions and exposes a working cancel action', () => {
  const cancel = vi.fn<() => void>();
  renderControls({ kind: 'board', text: 'Choose a road', cancel });

  expect(screen.getByRole('status').textContent).toContain('Choose a road');
  fireEvent.click(screen.getByRole('button', { name: 'game:cancelAction' }));
  expect(cancel).toHaveBeenCalledOnce();
});

test('pending work disables build, trade, and the primary action', () => {
  renderControls({
    kind: 'pending',
    text: 'Submitting',
    turnAction: { label: 'Roll dice', rollDice: true },
  });

  expect(screen.getByRole('button', { name: 'game:buildPanel' }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(screen.getByRole('button', { name: 'game:tradePanel' }).hasAttribute('disabled')).toBe(
    true,
  );
  const turnButton = screen.getByRole('button', { name: 'Submitting' });
  expect(turnButton.textContent).toContain('Roll dice');
  expect(turnButton.hasAttribute('disabled')).toBe(true);
  expect(screen.queryByRole('status')).toBeNull();
});

test('finished games keep players, log, and results available but lock build and trade', () => {
  const onResults = vi.fn<() => void>();
  const { onOpenTab } = renderControls(null, { onResults });

  const buildTab = screen.getByRole('button', { name: 'game:buildPanel' });
  const tradeTab = screen.getByRole('button', { name: 'game:tradePanel' });
  expect(buildTab.hasAttribute('disabled')).toBe(true);
  expect(tradeTab.hasAttribute('disabled')).toBe(true);

  const playersTab = screen.getByRole('button', { name: 'game:players' });
  const logTab = screen.getByRole('button', { name: 'game:mobileLog' });
  fireEvent.click(playersTab);
  fireEvent.click(logTab);
  expect(onOpenTab).toHaveBeenNthCalledWith(1, 'players', playersTab);
  expect(onOpenTab).toHaveBeenNthCalledWith(2, 'log', logTab);

  fireEvent.click(screen.getByRole('button', { name: 'game:results' }));
  expect(onResults).toHaveBeenCalledOnce();
});

test('return-to-board takes priority over the normal turn command', () => {
  const run = vi.fn<() => void>();
  const onReturnToBoard = vi.fn<() => void>();
  renderControls({ kind: 'command', label: 'End turn', rollDice: false, run }, { onReturnToBoard });

  fireEvent.click(screen.getByRole('button', { name: 'game:returnToBoard' }));
  expect(onReturnToBoard).toHaveBeenCalledOnce();
  expect(run).not.toHaveBeenCalled();
});
