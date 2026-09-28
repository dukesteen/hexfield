// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { SCENARIOS, scenarioConfig, type Scenario } from '@cp2p/maps';
import { engineForConfig } from '@cp2p/engine';
import lobby from '../../i18n/locales/en/lobby.json';
import { ScenarioPicker, isSeafaringScenario } from './ScenarioPicker';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { lobby } }, initImmediate: false });
});
afterEach(cleanup);

function mount(props: { seatCount?: number; scenarioId?: string; classicOnly?: boolean }) {
  const onScenario = vi.fn<(scenario: Scenario) => void>();
  render(
    <I18nextProvider i18n={i18n}>
      <ScenarioPicker
        seatCount={props.seatCount ?? 4}
        scenarioId={props.scenarioId ?? 'standard'}
        onScenario={onScenario}
        onSeatCount={vi.fn<(count: number) => void>()}
        {...(props.classicOnly ? { classicOnly: true } : {})}
      />
    </I18nextProvider>,
  );
  return onScenario;
}

const optionNames = (group: HTMLElement) =>
  within(group)
    .getAllByRole('option')
    .map((option) => option.textContent);

test('seafaring scenarios are their own group and start the scenario they name', () => {
  const onScenario = mount({});
  const seafaring = screen.getByRole('group', { name: 'Seafaring' });
  expect(optionNames(seafaring)).toEqual([
    'New Horizons',
    'Four Isles',
    'Fogbound',
    'Desert Crossing',
    'Open Sea',
  ]);
  expect(optionNames(screen.getByRole('group', { name: 'Classic' }))).toEqual([
    'Standard island',
    'Fixed island',
  ]);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'new-horizons' } });
  expect(onScenario).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-horizons' }));
});

test('a five to six player game is offered the large seafaring variants only', () => {
  mount({ seatCount: 5, scenarioId: 'five-six' });
  expect(optionNames(screen.getByRole('group', { name: 'Seafaring' }))).toEqual([
    'New Horizons (5–6 players)',
    'Four Isles (5–6 players)',
    'Open Sea (5–6 players)',
  ]);
});

test('the seafaring switch is an indicator: it is never a way to add the bare module', () => {
  const onScenario = mount({ scenarioId: 'new-horizons' });
  const seafaring = screen.getByRole('checkbox', { name: /Seafaring/ });
  expect(seafaring).toHaveProperty('checked', true);
  expect(seafaring).toHaveProperty('disabled', true);
  cleanup();
  mount({ scenarioId: 'standard' });
  const off = screen.getByRole('checkbox', { name: /Seafaring/ });
  expect(off).toHaveProperty('checked', false);
  expect(off).toHaveProperty('disabled', true);
  expect(screen.getByText(/choose a seafaring scenario above/)).toBeTruthy();
  fireEvent.click(off);
  expect(onScenario).not.toHaveBeenCalled();
});

test('screens that cannot carry a seafaring board offer the classic scenarios only', () => {
  mount({ classicOnly: true });
  expect(screen.queryByRole('group', { name: 'Seafaring' })).toBeNull();
  expect(
    within(screen.getByRole('combobox'))
      .getAllByRole('option')
      .map((option) => option.textContent),
  ).toEqual(['Standard island', 'Fixed island']);
  const row = screen.getByRole('checkbox', { name: /Seafaring/ }).closest('label');
  expect(row?.textContent).toContain('not available yet');
});

test('every offered seafaring scenario starts with its own victory target', () => {
  const started = SCENARIOS.filter(isSeafaringScenario)
    .filter((scenario) => scenario.board.kind === 'fixed' && !scenario.id.includes('fogbound'))
    .map((scenario) => {
      const config = scenarioConfig(scenario, scenario.seats.min);
      const state = engineForConfig(config).createGame(config, new Uint8Array(32).fill(3));
      return [scenario.id, state.config.options.base];
    });
  expect(started.length).toBeGreaterThan(0);
  for (const [id, base] of started) {
    const scenario = SCENARIOS.find((candidate) => candidate.id === id);
    expect(base).toMatchObject({ vpTarget: scenario?.vpTarget });
  }
});
