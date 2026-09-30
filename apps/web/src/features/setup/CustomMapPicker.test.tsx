// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { encodeMap, mapFromScenario, scenarioById } from '@cp2p/maps';
import type { MapDef } from '@cp2p/maps';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { CustomMapPicker, customMapProblem } from './CustomMapPicker';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock('../../queries/maps', () => ({ useSavedMaps: () => ({ data: [] }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(cleanup);

function classic(): MapDef {
  const scenario = scenarioById('standard-fixed');
  const map = scenario && mapFromScenario(scenario, 'Classic');
  if (!map) throw new Error('missing');
  return map;
}

test('only maps valid for the seat count can start', () => {
  const map = { ...classic(), seats: { min: 3, max: 4 } };
  expect(customMapProblem(map, 4)).toBeNull();
  expect(customMapProblem(map, 5)).toBe('seats');
  expect(customMapProblem({ ...map, robber: null }, 4)).toBe('invalid');
  expect(customMapProblem({ ...map, harbors: [{ edge: 'e:0,0,NE', kind: 'generic' }] }, 4)).toBe(
    'invalid',
  );
});

test('a pasted string picks the map; a bad one is refused', async () => {
  const onMap = vi.fn<(map: MapDef) => void>();
  render(<CustomMapPicker seatCount={4} map={null} problem={null} onMap={onMap} />);
  const field = screen.getByRole('textbox');
  fireEvent.change(field, { target: { value: 'HXMAP1.nonsense' } });
  fireEvent.click(screen.getByRole('button', { name: 'lobby:customMapUse' }));
  await screen.findByText('lobby:customMapInvalidString');
  fireEvent.change(field, { target: { value: await encodeMap(classic()) } });
  fireEvent.click(screen.getByRole('button', { name: 'lobby:customMapUse' }));
  await waitFor(() => expect(onMap).toHaveBeenCalledTimes(1));
  expect(onMap.mock.calls[0]?.[0].name).toBe('Classic');
});

test('the summary explains a seat count the map is not drawn for', () => {
  render(<CustomMapPicker seatCount={6} map={classic()} problem="seats" onMap={() => {}} />);
  expect(screen.getByRole('alert').textContent).toBe('lobby:customMapWrongSeats');
});
