// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, expect, test } from 'vitest';
import type { SessionFairness } from '@cp2p/protocol';
import game from '../../i18n/locales/en/game.json';
import { useSessionStore } from '../../store/session-store.js';
import { CheatFlag, FairnessFindings, FairnessStatus } from './FairnessStatus.js';

const i18n = createInstance();
const presentation = {
  players: [{ seat: 0 as const, name: 'Blue', color: 'blue' as const, shape: 'circle' as const }],
  botDelayMs: 800,
};
const fairness: SessionFairness = {
  head: { seq: 31, hash: 'a'.repeat(64) },
  verifiedMoves: 12,
  findings: [],
};

beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { game } }, initImmediate: false });
});
afterEach(() => {
  cleanup();
  useSessionStore.setState({ fairness: null, status: null });
});

test('does not imply verified cryptography for a local or unsupported session', () => {
  useSessionStore.setState({ fairness: null });
  render(
    <I18nextProvider i18n={i18n}>
      <FairnessStatus presentation={presentation} />
      <CheatFlag seat={0} />
      <FairnessFindings presentation={presentation} />
    </I18nextProvider>,
  );
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('region')).toBeNull();
});

test('shows accepted game moves, explains audit limits and restores focus on close', () => {
  useSessionStore.setState({ fairness, status: { kind: 'running' } });
  render(
    <I18nextProvider i18n={i18n}>
      <FairnessStatus presentation={presentation} />
    </I18nextProvider>,
  );
  const button = screen.getByRole('button', { name: 'Game fairness: 12 moves verified' });
  fireEvent.click(button);
  const dialog = screen.getByRole('dialog', { name: 'Game fairness' });
  expect(dialog.textContent).toContain('This live status is separate from the final audit.');
  expect(dialog.textContent).toContain('No proof failures recorded in the agreed history.');
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(button);
});

test('keeps certified failures visible in history and per-seat results, without showing raw evidence', () => {
  useSessionStore.setState({
    fairness: {
      ...fairness,
      findings: [
        {
          seat: 0,
          kind: 'beacon-reveal',
          at: { seq: 28, hash: 'b'.repeat(64) },
          evidenceId: 'c'.repeat(64),
        },
      ],
    },
    status: { kind: 'error', message: 'raw internal detail' },
  });
  render(
    <I18nextProvider i18n={i18n}>
      <FairnessStatus presentation={presentation} />
      <CheatFlag seat={0} />
      <CheatFlag seat={1} />
    </I18nextProvider>,
  );
  expect(screen.getAllByText('Cheating detected')).toHaveLength(1);
  expect(screen.getByRole('status').textContent).toBe('1 proof failure');
  fireEvent.click(screen.getByRole('button', { name: 'Game fairness: 1 proof failure' }));
  const dialog = screen.getByRole('dialog');
  expect(dialog.textContent).toContain('Blue sent an invalid randomness proof.');
  expect(dialog.textContent).toContain('Evidence at record 28');
  expect(dialog.textContent).toContain('Verification stopped.');
  expect(dialog.textContent).not.toContain('raw internal detail');
  expect(dialog.textContent).not.toContain('c'.repeat(64));
});
