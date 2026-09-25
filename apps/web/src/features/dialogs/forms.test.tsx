// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { createBaseEngine, exactResourceBounds, failure, success } from '@cp2p/engine';
import type { CommandShape, LegalCommandSet, PrivateState, ResourceCounts } from '@cp2p/engine';
import rules from '../../i18n/locales/en/rules.json';
import { DiscardDialog } from './DiscardDialog.js';
import { MonopolyDialog } from './MonopolyDialog.js';
import { StealDialog } from './StealDialog.js';
import { YearOfPlentyDialog } from './YearOfPlentyDialog.js';
import type { CommandFormProps } from './types.js';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { rules } }, initImmediate: false });
});
afterEach(cleanup);
const engine = createBaseEngine();
const state = engine.createGame(
  {
    modules: [{ id: 'base', version: '1.0.0' }],
    seats: [0, 1, 2],
    options: { base: { mapLayout: 'random' } },
  },
  new Uint8Array(32).fill(6),
);
const hand: ResourceCounts = { brick: 2, lumber: 0, wool: 0, grain: 0, ore: 1 };
const privateState: PrivateState = { ...engine.createPrivateState(0), hand };

function mount(element: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>);
}

function props(
  legal: LegalCommandSet,
  onSubmit = vi.fn<(command: CommandShape) => void>(),
): CommandFormProps {
  return {
    legal,
    privateState,
    state,
    seat: 0,
    playerLabel: (seat) => (seat === 2 ? 'Nia' : `Player ${seat + 1}`),
    validate: () => success(undefined),
    onSubmit,
  };
}

describe('rule-backed dialogs', () => {
  test('discard cannot submit until exactly the template count is selected', () => {
    const onSubmit = vi.fn<(command: CommandShape) => void>();
    mount(
      <DiscardDialog
        {...props({ commands: [], templates: [{ type: 'DISCARD', count: 2 }] }, onSubmit)}
      />,
    );
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    const brick = screen.getByRole('button', { name: 'Add Brick to Cards to discard' });
    const ore = screen.getByRole('button', { name: 'Add Ore to Cards to discard' });
    fireEvent.click(brick);
    expect(confirm.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Selected 1 of 2')).toBeTruthy();
    fireEvent.click(ore);
    expect(confirm.hasAttribute('disabled')).toBe(false);
    expect(screen.getByText('Selected 2 of 2')).toBeTruthy();
    fireEvent.click(brick);
    expect(confirm.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Selected 3 of 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Brick from Cards to discard' }));
    expect(confirm.hasAttribute('disabled')).toBe(false);
    fireEvent.click(confirm);
    expect(onSubmit).toHaveBeenCalledWith({
      type: 'DISCARD',
      cards: { brick: 1, lumber: 0, wool: 0, grain: 0, ore: 1 },
    });
    fireEvent.click(ore);
    expect(screen.getByText('Selected 2 of 2')).toBeTruthy();
    expect(ore.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Clear Cards to discard' }));
    expect(screen.getByText('Selected 0 of 2')).toBeTruthy();
    expect(confirm.hasAttribute('disabled')).toBe(true);
  });

  test('Year of Plenty requests exactly two cards even when the bank is short', () => {
    const onSubmit = vi.fn<(command: CommandShape) => void>();
    const legal = {
      commands: [],
      templates: [{ type: 'PLAY_DEV_CARD', slotId: 'slot-2', card: 'yearOfPlenty' }],
    };
    mount(
      <YearOfPlentyDialog
        {...props(legal, onSubmit)}
        state={{ ...state, bank: { ...state.bank, brick: 0 } }}
      />,
    );
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    const brick = screen.getByRole('button', { name: 'Add Brick to Resources to take' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(brick);
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(brick);
    expect(confirm.hasAttribute('disabled')).toBe(false);
    expect(screen.getByText(/Bank stock for these choices: 0 and 0/)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Add Grain to Resources to take' }));
    expect(screen.getByText('Selected 3 of 2')).toBeTruthy();
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Grain from Resources to take' }));
    expect(screen.getByText('Selected 2 of 2')).toBeTruthy();
    fireEvent.click(confirm);
    expect(onSubmit).toHaveBeenCalledWith({
      type: 'PLAY_DEV_CARD',
      slotId: 'slot-2',
      card: 'yearOfPlenty',
      params: { resources: { brick: 2, lumber: 0, wool: 0, grain: 0, ore: 0 } },
    });
  });

  test('Year of Plenty explains a disabled choice with localized copy', () => {
    mount(
      <YearOfPlentyDialog
        {...props({
          commands: [],
          templates: [{ type: 'PLAY_DEV_CARD', slotId: 'slot-2', card: 'yearOfPlenty' }],
        })}
        state={{
          ...state,
          config: {
            ...state.config,
            options: { ...state.config.options, base: { hideBankCounts: true } },
          },
        }}
        validate={() => failure('stale-phase', 'Internal engine English')}
      />,
    );
    expect(screen.getByText(/Bank counts are hidden/)).toBeTruthy();
    expect(screen.queryByText(/Bank stock for these choices/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add Brick to Resources to take' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Ore to Resources to take' }));
    expect(screen.getByRole('button', { name: 'Confirm' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('alert').textContent).toBe(
      'These resource choices cannot be played right now.',
    );
  });

  test('monopoly and steal show only supplied concrete choices and use exact commands', () => {
    const monopoly = {
      type: 'PLAY_DEV_CARD',
      slotId: 'slot-1',
      card: 'monopoly',
      params: { resource: 'ore' },
    };
    const onMonopoly = vi.fn<(command: CommandShape) => void>();
    const view = mount(
      <MonopolyDialog {...props({ commands: [monopoly], templates: [] }, onMonopoly)} />,
    );
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    const brick = screen.getByRole('button', { name: 'Add Brick to Resource to collect' });
    expect(brick.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(brick);
    expect(onMonopoly).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Add Ore to Resource to collect' }));
    expect(confirm.hasAttribute('disabled')).toBe(false);
    expect(onMonopoly).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    expect(onMonopoly).toHaveBeenCalledWith(monopoly);
    view.unmount();

    const steal = { type: 'STEAL', victim: 2 };
    const onSteal = vi.fn<(command: CommandShape) => void>();
    const bounds = exactResourceBounds({ brick: 3, lumber: 0, wool: 0, grain: 0, ore: 0 });
    if (!bounds.ok) throw new Error(bounds.error.message);
    const stealProps = props({ commands: [steal], templates: [] }, onSteal);
    mount(
      <StealDialog
        {...stealProps}
        state={{
          ...state,
          seats: state.seats.map((seat) =>
            seat.seat === 2 ? { ...seat, resources: bounds.value } : seat,
          ),
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Nia — 3 cards' }));
    expect(onSteal).toHaveBeenCalledWith(steal);
    expect(screen.queryByRole('button', { name: 'Player 2' })).toBeNull();
  });
});
