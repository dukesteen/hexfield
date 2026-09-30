// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import type { GamePresentation } from '../../queries/repositories/saved-games.js';
import type { LoadedReplay, ReplayExport } from './replay-load.js';
import { ReplaySession } from './replay-session.js';
import { goldenTranscript } from './replay-golden.test-helper.js';
import { ReplayViewer } from './ReplayViewer.js';

vi.mock('../board/BoardView.js', () => ({
  BoardView: () => <div role="group" aria-label="replay board canvas" />,
}));
vi.mock('../game/use-appearance.js', () => ({
  useBoardAppearance: () => ({ appearance: { theme: 'light', players: [] }, reducedMotion: true }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values && 'name' in values ? `${key}:${String(values.name)}` : key,
  }),
}));

const NAMES = ['Aster', 'Birch', 'Cedar', 'Dune'];
let loaded: LoadedReplay;

beforeAll(() => {
  const transcript = goldenTranscript('knights/knights-4p.replay.json');
  const session = ReplaySession.create<ReplayExport>({
    ...transcript,
    document: {
      fileName: 'x.replay.json',
      json: {},
      document: { format: 'hexfield-replay', v: 1, kind: 'online', archive: '' },
    },
  });
  if (!session.ok) throw new Error(session.error.message);
  const presentation: GamePresentation = {
    players: transcript.config.seats.map((seat, index) => ({
      seat: seat === 0 || seat === 1 || seat === 2 || seat === 3 ? seat : 0,
      name: NAMES[index] ?? 'P',
      color: (['blue', 'orange', 'green', 'red'] as const)[index] ?? 'blue',
      shape: 'circle',
    })),
    botDelayMs: 0,
  };
  loaded = { session: session.value, presentation, source: 'local' };
});

afterEach(() => cleanup());

function renderViewer() {
  const root = createRootRoute({
    component: () => <ReplayViewer loaded={loaded} title="Replay of a knights game" />,
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

test('steps, seeks by keyboard and never shows a hand in the public view', async () => {
  loaded.session.seek(100);
  renderViewer();
  expect(await screen.findByRole('heading', { name: 'Replay of a knights game' })).toBeTruthy();
  const slider = screen.getByRole('slider');
  expect(Reflect.get(slider, 'value')).toBe('100');
  expect(document.querySelectorAll('.replay-hand')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'game:replay.stepForward' }));
  expect(loaded.session.position).toBe(101);
  fireEvent.keyDown(window, { key: 'ArrowLeft' });
  expect(loaded.session.position).toBe(100);
  fireEvent.keyDown(window, { key: 'End' });
  expect(loaded.session.position).toBe(loaded.session.length);
  fireEvent.keyDown(window, { key: 'Home' });
  expect(loaded.session.position).toBe(0);
  loaded.session.seek(loaded.session.length);
});

test('switches between all hands and one seat', async () => {
  renderViewer();
  const select = await screen.findByLabelText('game:replay.perspective');
  fireEvent.change(select, { target: { value: 'omniscient' } });
  expect(document.querySelectorAll('.replay-hand')).toHaveLength(4);
  fireEvent.change(select, { target: { value: 'seat-2' } });
  const hands = document.querySelectorAll('.replay-hand');
  expect(hands).toHaveLength(1);
  expect(
    within(screen.getByRole('region', { name: 'Cedar' })).getByLabelText('game:replay.handCards'),
  ).toBeTruthy();
  fireEvent.change(select, { target: { value: 'public' } });
  expect(document.querySelectorAll('.replay-hand')).toHaveLength(0);
});

test('opens the statistics with labelled charts and tables', async () => {
  renderViewer();
  fireEvent.click(await screen.findByText('game:replay.showStats'));
  const details = document.querySelector<HTMLDetailsElement>('.replay-stats-toggle');
  if (!details) throw new Error('No statistics toggle');
  details.open = true;
  fireEvent(details, new Event('toggle'));
  expect(await screen.findByText('game:replay.gainsTitle')).toBeTruthy();
  expect(screen.getByText('game:replay.diceTitle')).toBeTruthy();
  expect(screen.getByText('game:replay.robberTitle')).toBeTruthy();
  expect(screen.getByText('game:replay.tradesTitle')).toBeTruthy();
  // Every seat is named beside its line, not by colour alone.
  for (const name of NAMES) expect(screen.getAllByText(name).length).toBeGreaterThan(1);
});
