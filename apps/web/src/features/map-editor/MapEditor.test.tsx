// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { decodeMap, emptyMap, mapFromScenario, mapJson, scenarioById } from '@cp2p/maps';
import type { MapDef } from '@cp2p/maps';
import type { BoardHit, RenderModel } from '@cp2p/renderer';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { MapEditor } from './MapEditor';

const saved = vi.hoisted(() => new Map<string, { id: string; name: string; json: string }>());

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
}));
vi.mock('../game/use-appearance', () => ({
  useBoardAppearance: () => ({ appearance: { theme: 'light', players: [] }, reducedMotion: true }),
}));
vi.mock('../board/BoardView', () => ({
  // A stand-in canvas: one button per hex and a harbor button, reporting hits like the renderer.
  BoardView: ({ model, onSelect }: { model: RenderModel; onSelect: (hit: BoardHit) => void }) => (
    <div role="group" aria-label="canvas" data-hexes={model.hexes.length}>
      <span data-testid="robber">{model.robberHex ?? 'none'}</span>
      <button type="button" onClick={() => onSelect({ kind: 'hex', id: 'h:0,0' })}>
        hex 0,0
      </button>
      <button type="button" onClick={() => onSelect({ kind: 'hex', id: 'h:1,0' })}>
        hex 1,0
      </button>
    </div>
  ),
}));
vi.mock('../../queries/maps', () => ({
  newMapId: () => 'map1',
  useSavedMaps: () => ({
    data: [...saved.values()].map((item) => ({
      ...item,
      updatedAt: 1,
      map: { ...emptyMap(item.name) },
    })),
  }),
  useSaveMap: () => ({
    isPending: false,
    mutate: (input: { id: string; map: MapDef }, options: { onSuccess: () => void }) => {
      saved.set(input.id, { id: input.id, name: input.map.name, json: '' });
      options.onSuccess();
    },
  }),
  useDeleteMap: () => ({ mutate: (id: string) => saved.delete(id) }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values && 'count' in values ? `${key}:${String(values.count)}` : key,
  }),
}));

afterEach(() => {
  cleanup();
  saved.clear();
});

function renderEditor(map: MapDef) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MapEditor initial={map} />
    </QueryClientProvider>,
  );
}

test('paint, number, fix the errors, undo, redo and save', async () => {
  renderEditor(emptyMap('Tiny'));
  expect(screen.getByText('editor:mapProblemNoLand')).toBeTruthy();
  // Paint two hexes: they need numbers and a robber.
  fireEvent.click(screen.getByRole('button', { name: 'hex 0,0' }));
  fireEvent.click(screen.getByRole('radio', { name: /editor:mapTerrainHills/ }));
  fireEvent.click(screen.getByRole('button', { name: 'hex 1,0' }));
  expect(screen.getByText('editor:mapProblemMissingToken:2')).toBeTruthy();
  expect(screen.getByText('editor:mapProblemRobberMissing')).toBeTruthy();
  // Keyboard: N picks the number tool.
  fireEvent.keyDown(window, { key: 'n' });
  expect(
    screen.getByRole('button', { name: /editor:mapToolToken/ }).getAttribute('aria-pressed'),
  ).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'hex 0,0' }));
  expect(screen.getByText('editor:mapProblemMissingToken:1')).toBeTruthy();
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
  expect(screen.getByText('editor:mapProblemMissingToken:2')).toBeTruthy();
  fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
  expect(screen.getByText('editor:mapProblemMissingToken:1')).toBeTruthy();
  // Robber.
  fireEvent.click(screen.getByRole('button', { name: /editor:mapToolRobber/ }));
  fireEvent.click(screen.getByRole('button', { name: 'hex 0,0' }));
  expect(screen.getByTestId('robber').textContent).toBe('h:0,0');
  expect(screen.queryByText('editor:mapProblemRobberMissing')).toBeNull();
  // Save keeps drafts too.
  fireEvent.click(screen.getByRole('button', { name: 'editor:mapSave' }));
  expect(saved.get('map1')?.name).toBe('Tiny');
});

test('a valid map exports a string that decodes to the same map; errors block it', async () => {
  const scenario = scenarioById('standard-fixed');
  const map = scenario ? mapFromScenario(scenario, 'Classic') : null;
  if (!map) throw new Error('missing');
  renderEditor(map);
  fireEvent.click(screen.getByRole('tab', { name: 'editor:mapPanelShare' }));
  fireEvent.click(screen.getByRole('button', { name: 'editor:mapExport' }));
  const field = await screen.findByTestId('map-share-string', {}, { timeout: 5_000 });
  const decoded = await decodeMap(field instanceof HTMLTextAreaElement ? field.value : '');
  expect(decoded.ok && mapJson(decoded.value)).toBe(mapJson(map));
  // Stepping a number round to none leaves a land hex unnumbered; export is blocked until fixed.
  fireEvent.click(screen.getByRole('button', { name: /editor:mapToolToken/ }));
  for (let step = 0; step < 11 && !screen.queryByText('editor:mapShareBlocked'); step++)
    fireEvent.click(screen.getByRole('button', { name: 'hex 0,0' }));
  await waitFor(() => expect(screen.getByText('editor:mapShareBlocked')).toBeTruthy());
  expect(screen.queryByRole('button', { name: 'editor:mapExport' })).toBeNull();
  expect(screen.getByRole('tab', { name: /editor:mapPanelCheck/ }).textContent).toMatch(/\d/);
}, 20_000);
