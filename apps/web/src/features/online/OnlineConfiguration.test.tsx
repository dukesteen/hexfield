// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { toBase64Url } from '@cp2p/codec';
import { baseModule, success } from '@cp2p/engine';
import type { GameConfig, Result } from '@cp2p/engine';
import type { GenesisSeedMode } from '@cp2p/protocol';
import { standardFixedBoard } from '@cp2p/maps';
import { afterEach, expect, test, vi } from 'vitest';
import { OnlineConfiguration } from './OnlineConfiguration';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

const config: GameConfig = {
  modules: [{ id: 'base', version: baseModule().version }],
  seats: [0, 1, 2, 3],
  options: { base: { vpTarget: 10, mapLayout: 'balanced-random' } },
};

test('the host can save every schema rule, timer and a fixed seed without losing other settings', () => {
  const save = vi.fn<(config: GameConfig, seed: GenesisSeedMode) => Result<void>>(() =>
    success(undefined),
  );
  const page = render(
    <OnlineConfiguration config={config} seedMode={{ kind: 'joint' }} editable onSave={save} />,
  );
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
  fireEvent.click(page.getByRole('button', { name: 'lobby:onlineSaveSettings' }));
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
  );
});

test('guests can read the signed rules and timers but cannot change or submit them', () => {
  const save = vi.fn<(config: GameConfig, seed: GenesisSeedMode) => Result<void>>(() =>
    success(undefined),
  );
  const page = render(
    <OnlineConfiguration
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
  expect(page.getByRole('group')).toHaveProperty('disabled', true);
  expect(page.queryByRole('button', { name: 'lobby:onlineSaveSettings' })).toBeNull();
  const form = page.container.querySelector('form');
  if (!form) throw new Error('Missing configuration form');
  fireEvent.submit(form);
  expect(save).not.toHaveBeenCalled();
});

test('fixed islands retain their board, random maps remove it, and malformed seeds are not submitted', () => {
  const board = standardFixedBoard();
  const save = vi.fn<(config: GameConfig, seed: GenesisSeedMode) => Result<void>>(() =>
    success(undefined),
  );
  const page = render(
    <OnlineConfiguration
      config={{ ...config, board, options: { base: { mapLayout: 'standard-fixed' } } }}
      seedMode={{ kind: 'joint' }}
      editable
      onSave={save}
    />,
  );
  fireEvent.click(page.getByRole('button', { name: 'lobby:onlineSaveSettings' }));
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ board }), { kind: 'joint' });
  fireEvent.change(page.getByLabelText('lobby:mapLayout'), {
    target: { value: 'balanced-random' },
  });
  fireEvent.click(page.getByRole('button', { name: 'lobby:onlineSaveSettings' }));
  expect(save.mock.lastCall?.[0]).not.toHaveProperty('board');
  fireEvent.change(page.getByLabelText('lobby:onlineBoardSeed'), { target: { value: 'fixed' } });
  fireEvent.change(page.getByLabelText('lobby:onlineSeedValue'), { target: { value: 'invalid' } });
  const form = page.container.querySelector('form');
  if (!form) throw new Error('Missing configuration form');
  fireEvent.submit(form);
  expect(save).toHaveBeenCalledTimes(2);
  expect(page.getByRole('alert')).toBeTruthy();
});
