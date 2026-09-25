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
    const brick = screen.getByRole('spinbutton', { name: 'Cards to discard: Brick' });
    fireEvent.change(brick, { target: { value: '1' } });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.change(brick, { target: { value: '2' } });
    expect(confirm.hasAttribute('disabled')).toBe(false);
    fireEvent.click(confirm);
    expect(onSubmit).toHaveBeenCalledWith({
      type: 'DISCARD',
      cards: { brick: 2, lumber: 0, wool: 0, grain: 0, ore: 0 },
    });
    fireEvent.change(brick, { target: { value: '3' } });
    if (!(brick instanceof HTMLInputElement)) throw new Error('Brick field is not an input');
    expect(brick.value).toBe('2');
  });

  test('Year of Plenty requests two of one kind and shows short bank stock', () => {
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
    expect(screen.getByText(/Bank stock for these choices: 0 and 0/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
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
        validate={() => failure('stale-phase', 'Internal engine English')}
      />,
    );
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
    fireEvent.click(screen.getByRole('button', { name: 'Ore' }));
    expect(onMonopoly).toHaveBeenCalledWith(monopoly);
    expect(screen.queryByRole('button', { name: 'Brick' })).toBeNull();
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
