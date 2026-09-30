// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { success } from '@cp2p/engine';
import type { GameConfig, Result } from '@cp2p/engine';
import { isCustomConfig, mapBoard, mapConfig, mapFromScenario, scenarioById } from '@cp2p/maps';
import type { MapDef } from '@cp2p/maps';
import type { GenesisSeedMode, TakeoverPolicy } from '@cp2p/protocol';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { OnlineConfiguration } from './OnlineConfiguration';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock('../../queries/maps', () => ({ useSavedMaps: () => ({ data: [] }) }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const takeover: TakeoverPolicy = { mode: 'vote', afterSeconds: 120 };

function islandMap(): MapDef {
  const scenario = scenarioById('standard-fixed');
  const map = scenario && mapFromScenario(scenario, 'Island');
  if (!map) throw new Error('missing');
  return { ...map, seats: { min: 3, max: 6 } };
}

function customConfig(seats: number): GameConfig {
  const config = mapConfig(islandMap(), seats);
  if (!config.ok) throw new Error(config.error.message);
  return config.value;
}

test('a custom map stays chosen and follows the seat count into five-six', () => {
  vi.useFakeTimers();
  const save = vi.fn<(config: GameConfig, seed: GenesisSeedMode) => Result<void>>(() =>
    success(undefined),
  );
  const page = render(
    <OnlineConfiguration
      takeover={takeover}
      humanCount={4}
      config={customConfig(4)}
      seedMode={{ kind: 'joint' }}
      editable
      onSave={save}
    />,
  );
  expect(page.getByLabelText('lobby:scenario')).toHaveProperty('value', 'custom');
  expect(page.queryByLabelText('lobby:mapLayout')).toBeNull();
  fireEvent.change(page.getByLabelText('lobby:playerCount'), { target: { value: '5' } });
  void act(() => vi.advanceTimersByTime(400));
  const saved = save.mock.calls[0]?.[0];
  expect(saved && isCustomConfig(saved)).toBe(true);
  expect(saved?.modules.map((module) => module.id)).toEqual(['base', 'five-six']);
  expect(saved?.board).toEqual(mapBoard(islandMap()));
});

test('guests see that the host chose a custom map', () => {
  const page = render(
    <OnlineConfiguration
      takeover={takeover}
      humanCount={2}
      config={customConfig(3)}
      seedMode={{ kind: 'joint' }}
      editable={false}
      onSave={() => success(undefined)}
    />,
  );
  expect(page.getByTestId('online-custom-map').textContent).toBe('lobby:customMapInLobby');
});
