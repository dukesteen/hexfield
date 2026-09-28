// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { createBaseEngine, failure, success } from '@cp2p/engine';
import type { CommandShape, GameState, PrivateState } from '@cp2p/engine';
import rules from '../../i18n/locales/en/rules.json';
import { goldRequest } from '../game/seafaring';
import { GoldDialog } from './GoldDialog.js';
import type { CommandFormProps } from './types.js';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { rules } }, initImmediate: false });
});
afterEach(cleanup);
const engine = createBaseEngine();
const genesis = engine.createGame(
  {
    modules: [{ id: 'base', version: '1.0.0' }],
    seats: [0, 1, 2],
    options: { base: { mapLayout: 'random' } },
  },
  new Uint8Array(32).fill(6),
);
const privateState: PrivateState = engine.createPrivateState(0);

/** The base state with a gold choice on top: the head seat claims two cards. */
function goldState(bank: Record<string, number> = {}, claim = 2): GameState {
  return {
    ...genesis,
    bank: { ...genesis.bank, ...bank },
    turn: {
      ...genesis.turn,
      phase: [
        ...genesis.turn.phase,
        {
          id: 'goldChoice',
          module: 'seafaring',
          data: {
            queue: [
              { seat: 0, claim },
              { seat: 2, claim: 1 },
            ],
          },
        },
      ],
    },
  };
}

function mount(state: GameState, onSubmit = vi.fn<(command: CommandShape) => void>()) {
  const props: CommandFormProps = {
    legal: { commands: [], templates: [] },
    privateState,
    state,
    seat: 0,
    playerLabel: (seat) => (seat === 2 ? 'Nia' : `Player ${seat + 1}`),
    validate: () => success(undefined),
    onSubmit,
  };
  render(
    <I18nextProvider i18n={i18n}>
      <GoldDialog {...props} />
    </I18nextProvider>,
  );
  return onSubmit;
}

describe('gold choice', () => {
  test('the claim is the number of cards, capped at what the bank holds', () => {
    expect(goldRequest(goldState(), 0)).toEqual({ count: 2, claim: 2, waiting: [2] });
    const nearlyEmpty = goldState({ brick: 1, lumber: 0, wool: 0, grain: 0, ore: 0 }, 3);
    expect(goldRequest(nearlyEmpty, 0)).toEqual({ count: 1, claim: 3, waiting: [2] });
    // Only the head of the queue chooses.
    expect(goldRequest(goldState(), 2)).toBeNull();
    expect(goldRequest(genesis, 0)).toBeNull();
  });

  test('confirm waits for exactly the claimed cards and submits them', () => {
    const onSubmit = mount(goldState());
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add Ore to Cards to take' }));
    expect(screen.getByText('Selected 1 of 2')).toBeTruthy();
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add Ore to Cards to take' }));
    expect(screen.getByText('Selected 2 of 2')).toBeTruthy();
    // A third card is refused rather than selected.
    fireEvent.click(screen.getByRole('button', { name: 'Add Grain to Cards to take' }));
    expect(screen.getByText('Selected 2 of 2')).toBeTruthy();
    expect(confirm.hasAttribute('disabled')).toBe(false);
    fireEvent.click(confirm);
    expect(onSubmit).toHaveBeenCalledWith({
      type: 'CHOOSE_GOLD',
      resources: { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 2 },
    });
  });

  test('a kind the bank cannot pay cannot be chosen', () => {
    mount(goldState({ brick: 1, lumber: 0, wool: 5, grain: 0, ore: 0 }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Brick to Cards to take' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Brick to Cards to take' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Lumber to Cards to take' }));
    expect(screen.getByText('Selected 1 of 2')).toBeTruthy();
  });

  test('a short bank lowers the count and says why', () => {
    mount(goldState({ brick: 0, lumber: 0, wool: 0, grain: 1, ore: 0 }, 3));
    expect(screen.getByText('Selected 0 of 1')).toBeTruthy();
    expect(screen.getByText(/bank cannot pay 3 cards/)).toBeTruthy();
  });

  test('the seats still to choose are named', () => {
    mount(goldState());
    expect(screen.getByText('Then: Nia')).toBeTruthy();
  });

  test('a rejected choice is explained instead of submitted', () => {
    const props: CommandFormProps = {
      legal: { commands: [], templates: [] },
      privateState,
      state: goldState(),
      seat: 0,
      playerLabel: (seat) => `Player ${seat + 1}`,
      validate: () => failure('invalid-gold', 'no'),
      onSubmit: vi.fn<(command: CommandShape) => void>(),
    };
    render(
      <I18nextProvider i18n={i18n}>
        <GoldDialog {...props} />
      </I18nextProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add Ore to Cards to take' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Ore to Cards to take' }));
    expect(screen.getByRole('button', { name: 'Confirm' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('cannot be taken right now');
  });
});
