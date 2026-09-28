// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { canonicalDecode, canonicalEncode, toBase64Url } from '@cp2p/codec';
import { baseModule, success } from '@cp2p/engine';
import type { GameConfig, Result } from '@cp2p/engine';
import type { GenesisSeedMode, TakeoverPolicy } from '@cp2p/protocol';
import { standardFixedBoard } from '@cp2p/maps';
import { genesisSchema } from '@cp2p/protocol';
import { afterEach, expect, test, vi } from 'vitest';
import * as v from 'valibot';
import { OnlineConfiguration } from './OnlineConfiguration';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const config: GameConfig = {
  modules: [{ id: 'base', version: baseModule().version }],
  seats: [0, 1, 2, 3],
  options: { base: { vpTarget: 10, mapLayout: 'balanced-random' } },
};
const takeover: TakeoverPolicy = { mode: 'vote', afterSeconds: 120 };

test('the host can save every schema rule, timer and a fixed seed without losing other settings', () => {
  vi.useFakeTimers();
  const save = vi.fn<(config: GameConfig, seed: GenesisSeedMode) => Result<void>>(() =>
    success(undefined),
  );
  const page = render(
    <OnlineConfiguration
      takeover={takeover}
      humanCount={4}
      config={config}
      seedMode={{ kind: 'joint' }}
      editable
      onSave={save}
    />,
  );
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(page.getByLabelText('lobby:vpTarget'), { target: { value: '12' } });
  fireEvent.change(page.getByLabelText('lobby:discardLimit'), { target: { value: '9' } });
  fireEvent.change(page.getByLabelText('lobby:mapLayout'), { target: { value: 'random' } });
  fireEvent.change(page.getByLabelText('lobby:diceMode'), { target: { value: 'balanced' } });
  fireEvent.click(page.getByLabelText('lobby:friendlyRobber'));
  fireEvent.click(page.getByLabelText('lobby:strictBalance'));
  fireEvent.click(page.getByLabelText('lobby:playerTrades'));
  fireEvent.click(page.getByLabelText('lobby:hideBankCounts'));
  fireEvent.click(page.getByLabelText('lobby:turnTimer'));
  fireEvent.change(page.getByLabelText('lobby:mainSeconds'), { target: { value: '90' } });
  fireEvent.change(page.getByLabelText('lobby:onlineBoardSeed'), { target: { value: 'fixed' } });
  fireEvent.change(page.getByLabelText('lobby:onlineSeedValue'), {
    target: { value: 'aB'.repeat(32) },
  });
  void act(() => vi.advanceTimersByTime(399));
  expect(save).not.toHaveBeenCalled();
  void act(() => vi.advanceTimersByTime(1));
  expect(save).toHaveBeenCalledExactlyOnceWith(
    {
      ...config,
      options: {
        base: {
          vpTarget: 12,
          discardLimit: 9,
          mapLayout: 'random',
          diceMode: 'balanced',
          friendlyRobber: true,
          strictBalance: true,
          playerTrades: false,
          hideBankCounts: true,
          turnTimer: { preRollSec: 60, mainSec: 90, discardSec: 60, robberSec: 60 },
        },
      },
    },
    { kind: 'fixed', seed: toBase64Url(new Uint8Array(32).fill(171)) },
    takeover,
  );
});

test('guests can read the signed rules and timers but cannot change or submit them', () => {
  const save = vi.fn<(config: GameConfig, seed: GenesisSeedMode) => Result<void>>(() =>
    success(undefined),
  );
  const page = render(
    <OnlineConfiguration
      takeover={takeover}
      humanCount={4}
      config={{
        ...config,
        options: {
          base: { turnTimer: { preRollSec: 15, mainSec: 45, discardSec: 20, robberSec: 25 } },
        },
      }}
      seedMode={{ kind: 'fixed', seed: toBase64Url(new Uint8Array(32).fill(10)) }}
      editable={false}
      onSave={save}
    />,
  );
  expect(page.getByLabelText('lobby:mainSeconds')).toHaveProperty('value', '45');
  expect(page.getByLabelText('lobby:onlineSeedValue')).toHaveProperty('value', '0a'.repeat(32));
  expect(page.getByRole('group', { name: 'lobby:boardAndRules' })).toHaveProperty('disabled', true);
  expect(page.queryByRole('button', { name: 'lobby:onlineSaveSettings' })).toBeNull();
  const form = page.container.querySelector('form');
  if (!form) throw new Error('Missing configuration form');
  fireEvent.submit(form);
  expect(save).not.toHaveBeenCalled();
});

test('fixed islands retain their board, random maps remove it, and malformed seeds are not submitted', () => {
  vi.useFakeTimers();
  const board = standardFixedBoard();
  const save = vi.fn<(config: GameConfig, seed: GenesisSeedMode) => Result<void>>(() =>
    success(undefined),
  );
  const page = render(
    <OnlineConfiguration
      takeover={takeover}
      humanCount={4}
      config={{ ...config, board, options: { base: { mapLayout: 'standard-fixed' } } }}
      seedMode={{ kind: 'joint' }}
      editable
      onSave={save}
    />,
  );
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(page.getByLabelText('lobby:vpTarget'), { target: { value: '11' } });
  void act(() => vi.advanceTimersByTime(400));
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({ board }),
    { kind: 'joint' },
    takeover,
  );
  expect(page.queryByLabelText('lobby:mapLayout')).toBeNull();
  fireEvent.change(page.getByLabelText('lobby:scenario'), { target: { value: 'standard' } });
  void act(() => vi.advanceTimersByTime(400));
  expect(save.mock.lastCall?.[0]).not.toHaveProperty('board');
  expect(save.mock.lastCall?.[0].options.base).toMatchObject({ mapLayout: 'balanced-random' });
  fireEvent.change(page.getByLabelText('lobby:onlineBoardSeed'), { target: { value: 'fixed' } });
  fireEvent.change(page.getByLabelText('lobby:onlineSeedValue'), { target: { value: 'invalid' } });
  void act(() => vi.advanceTimersByTime(400));
  expect(save).toHaveBeenCalledTimes(2);
  expect(page.getByRole('alert')).toBeTruthy();
});

test('a pending edit is cancelled when the lobby freezes or the editor unmounts', () => {
  vi.useFakeTimers();
  const save = vi.fn<(config: GameConfig, seed: GenesisSeedMode) => Result<void>>(() =>
    success(undefined),
  );
  const page = render(
    <OnlineConfiguration
      takeover={takeover}
      humanCount={4}
      config={config}
      seedMode={{ kind: 'joint' }}
      editable
      onSave={save}
    />,
  );
  fireEvent.change(page.getByLabelText('lobby:vpTarget'), { target: { value: '12' } });
  page.rerender(
    <OnlineConfiguration
      takeover={takeover}
      humanCount={4}
      config={config}
      seedMode={{ kind: 'joint' }}
      editable={false}
      onSave={save}
    />,
  );
  void act(() => vi.advanceTimersByTime(500));
  expect(save).not.toHaveBeenCalled();
  page.unmount();
});

test('reverting a configuration edit before the debounce does not save or reset readiness', () => {
  vi.useFakeTimers();
  const save = vi.fn<(config: GameConfig, seed: GenesisSeedMode) => Result<void>>(() =>
    success(undefined),
  );
  const pending = vi.fn<(value: boolean) => void>();
  const page = render(
    <OnlineConfiguration
      takeover={takeover}
      humanCount={4}
      config={config}
      seedMode={{ kind: 'joint' }}
      editable
      onSave={save}
      onPendingChange={pending}
    />,
  );
  const vpTarget = page.getByLabelText('lobby:vpTarget');
  fireEvent.change(vpTarget, { target: { value: '12' } });
  fireEvent.change(vpTarget, { target: { value: '10' } });
  void act(() => vi.advanceTimersByTime(500));
  expect(save).not.toHaveBeenCalled();
  expect(pending).toHaveBeenLastCalledWith(false);
});

test('a parsed lobby acknowledgement clears saving despite reordered configuration keys', () => {
  vi.useFakeTimers();
  const save = vi.fn<(config: GameConfig, seed: GenesisSeedMode) => Result<void>>(() =>
    success(undefined),
  );
  const pending = vi.fn<(value: boolean) => void>();
  const page = render(
    <OnlineConfiguration
      takeover={takeover}
      humanCount={4}
      config={config}
      seedMode={{ kind: 'joint' }}
      editable
      onSave={save}
      onPendingChange={pending}
    />,
  );
  fireEvent.change(page.getByLabelText('lobby:vpTarget'), { target: { value: '12' } });
  void act(() => vi.advanceTimersByTime(400));
  const sent = save.mock.lastCall?.[0];
  if (!sent) throw new Error('Expected a configuration write');
  const parsed = v.parse(v.pick(genesisSchema, ['config']), {
    config: canonicalDecode(canonicalEncode(sent)),
  }).config;
  expect(JSON.stringify(parsed)).not.toBe(JSON.stringify(sent));
  page.rerender(
    <OnlineConfiguration
      takeover={takeover}
      humanCount={4}
      config={parsed}
      seedMode={{ kind: 'joint' }}
      editable
      onSave={save}
      onPendingChange={pending}
    />,
  );
  expect(pending).toHaveBeenLastCalledWith(false);
  expect(page.queryByRole('status')).toBeNull();
  void act(() => vi.advanceTimersByTime(400));
  expect(save).toHaveBeenCalledTimes(1);
});

test('changing only fixed-seed hex casing clears pending without a no-op save', () => {
  vi.useFakeTimers();
  const save = vi.fn<(config: GameConfig, seed: GenesisSeedMode) => Result<void>>(() =>
    success(undefined),
  );
  const pending = vi.fn<(value: boolean) => void>();
  const page = render(
    <OnlineConfiguration
      takeover={takeover}
      humanCount={4}
      config={config}
      seedMode={{ kind: 'fixed', seed: toBase64Url(new Uint8Array(32).fill(171)) }}
      editable
      onSave={save}
      onPendingChange={pending}
    />,
  );
  fireEvent.change(page.getByLabelText('lobby:onlineSeedValue'), {
    target: { value: 'AB'.repeat(32) },
  });
  void act(() => vi.advanceTimersByTime(400));
  expect(save).not.toHaveBeenCalled();
  expect(pending).toHaveBeenLastCalledWith(false);
  expect(page.queryByRole('status')).toBeNull();
});

test('host policy changes are saved with the same signed lobby configuration', () => {
  vi.useFakeTimers();
  const save = vi.fn<
    (config: GameConfig, seed: GenesisSeedMode, policy: TakeoverPolicy) => Result<void>
  >(() => success(undefined));
  const page = render(
    <OnlineConfiguration
      config={config}
      seedMode={{ kind: 'joint' }}
      takeover={takeover}
      humanCount={4}
      editable
      onSave={save}
    />,
  );
  fireEvent.change(page.getByLabelText('lobby:onlineTakeoverMode'), {
    target: { value: 'auto' },
  });
  fireEvent.change(page.getByLabelText('lobby:onlineTakeoverDelay'), {
    target: { value: '30' },
  });
  void act(() => vi.advanceTimersByTime(400));
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({ seats: config.seats }),
    { kind: 'joint' },
    {
      mode: 'auto',
      afterSeconds: 30,
    },
  );
  page.rerender(
    <OnlineConfiguration
      config={config}
      seedMode={{ kind: 'joint' }}
      takeover={{ mode: 'auto', afterSeconds: 30 }}
      humanCount={4}
      editable
      onSave={save}
    />,
  );
  fireEvent.change(page.getByLabelText('lobby:onlineTakeoverDelay'), {
    target: { value: 'never' },
  });
  void act(() => vi.advanceTimersByTime(400));
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({ seats: config.seats }),
    { kind: 'joint' },
    {
      mode: 'vote',
      afterSeconds: 'never',
    },
  );
});

test('five or six seats select the five-six module and drop a fixed island', () => {
  vi.useFakeTimers();
  const save = vi.fn<(config: GameConfig, seed: GenesisSeedMode) => Result<void>>(() =>
    success(undefined),
  );
  const page = render(
    <OnlineConfiguration
      takeover={takeover}
      humanCount={2}
      config={{
        ...config,
        board: standardFixedBoard(),
        options: { base: { mapLayout: 'standard-fixed' } },
      }}
      seedMode={{ kind: 'joint' }}
      editable
      onSave={save}
    />,
  );
  fireEvent.change(page.getByLabelText('lobby:playerCount'), { target: { value: '6' } });
  void act(() => vi.advanceTimersByTime(400));
  const saved = save.mock.lastCall?.[0];
  expect(saved?.seats).toEqual([0, 1, 2, 3, 4, 5]);
  expect(saved?.modules.map((module) => module.id)).toEqual(['base', 'five-six']);
  expect(saved).not.toHaveProperty('board');
  expect(saved?.options.base).toMatchObject({ mapLayout: 'balanced-random' });
  expect(page.getByLabelText('lobby:scenario')).toHaveProperty('value', 'five-six');
  expect(
    page.container.querySelector<HTMLInputElement>('[data-expansion="five-six"] input')?.checked,
  ).toBe(true);
  expect(
    page.container.querySelector<HTMLInputElement>('[data-expansion="knights"] input')?.disabled,
  ).toBe(true);
  fireEvent.click(
    page.container.querySelector('[data-expansion="five-six"] input') ?? page.container,
  );
  void act(() => vi.advanceTimersByTime(400));
  expect(save.mock.lastCall?.[0].seats).toEqual([0, 1, 2, 3]);
  expect(save.mock.lastCall?.[0].modules.map((module) => module.id)).toEqual(['base']);
});
