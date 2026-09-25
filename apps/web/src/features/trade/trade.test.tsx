// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { createBaseEngine, failure, success } from '@cp2p/engine';
import type {
  CommandShape,
  LegalCommandSet,
  PrivateState,
  ResourceCounts,
  Result,
} from '@cp2p/engine';
import rules from '../../i18n/locales/en/rules.json';
import type { CommandFormProps } from '../dialogs/types.js';
import { BankTradePicker } from './BankTradePicker.js';
import { IncomingOffers } from './IncomingOffers.js';
import { TradeComposer } from './TradeComposer.js';

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
  new Uint8Array(32).fill(7),
);
const hand: ResourceCounts = { brick: 4, lumber: 3, wool: 0, grain: 0, ore: 0 };
const privateState: PrivateState = { ...engine.createPrivateState(0), hand };

function mount(element: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>);
}

function props(
  legal: LegalCommandSet,
  validate: (command: CommandShape) => Result<void>,
  onSubmit = vi.fn<(command: CommandShape) => void>(),
): CommandFormProps {
  return {
    legal,
    privateState,
    state,
    seat: 0,
    playerLabel: (seat) => (seat === 2 ? 'Bea' : seat === 1 ? 'Ari' : 'You'),
    validate,
    onSubmit,
  };
}

function validateOffer(command: CommandShape): Result<void> {
  return command.type === 'OFFER_TRADE' &&
    typeof command.give === 'object' &&
    command.give !== null &&
    Reflect.get(command.give, 'brick') === 1 &&
    typeof command.want === 'object' &&
    command.want !== null &&
    Reflect.get(command.want, 'ore') === 1 &&
    Array.isArray(command.to) &&
    command.to.length === 1 &&
    command.to[0] === 1
    ? success(undefined)
    : failure('terms', 'Invalid trade terms');
}

function validateBank(command: CommandShape): Result<void> {
  if (
    command.type !== 'MARITIME_TRADE' ||
    typeof command.give !== 'object' ||
    command.give === null ||
    typeof command.get !== 'object' ||
    command.get === null
  )
    return failure('terms', 'Invalid bank trade');
  const give = command.give;
  const get = command.get;
  return (Reflect.get(give, 'brick') === 4 &&
    Reflect.get(get, 'ore') === 1 &&
    Reflect.get(give, 'lumber') === 0 &&
    Reflect.get(get, 'grain') === 0) ||
    (Reflect.get(give, 'brick') === 4 &&
      Reflect.get(give, 'lumber') === 3 &&
      Reflect.get(get, 'ore') === 2 &&
      Reflect.get(get, 'grain') === 1)
    ? success(undefined)
    : failure('terms', 'Invalid bank trade');
}

describe('controlled trade forms', () => {
  test('offer composer submits selected give/want and recipients only after validation', () => {
    const onSubmit = vi.fn<(command: CommandShape) => void>();
    mount(
      <TradeComposer
        {...props({ commands: [], templates: [{ type: 'OFFER_TRADE' }] }, validateOffer, onSubmit)}
      />,
    );
    const send = screen.getByRole('button', { name: 'Send offer' });
    expect(send.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('These trade terms cannot be offered');
    fireEvent.change(screen.getByRole('spinbutton', { name: 'You give: Brick' }), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'You receive: Ore' }), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bea' }));
    expect(send.hasAttribute('disabled')).toBe(false);
    fireEvent.click(send);
    expect(onSubmit).toHaveBeenCalledWith({
      type: 'OFFER_TRADE',
      give: { brick: 1, lumber: 0, wool: 0, grain: 0, ore: 0 },
      want: { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 1 },
      to: [1],
    });
  });

  test('bank picker shows validated best rate and composes multiple resources and outputs', () => {
    const onSubmit = vi.fn<(command: CommandShape) => void>();
    mount(
      <BankTradePicker
        {...props(
          { commands: [], templates: [{ type: 'MARITIME_TRADE' }] },
          validateBank,
          onSubmit,
        )}
      />,
    );
    expect(screen.getByText('Brick: 4 for 1')).toBeTruthy();
    expect(screen.getByText('Ore: 4 for 1')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('This bank trade cannot be made');
    expect(screen.getByRole('button', { name: 'Give 4 Brick for 1 Ore' })).toBeTruthy();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'You give: Brick' }), {
      target: { value: '4' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'You give: Lumber' }), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Bank gives: Ore' }), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Bank gives: Grain' }), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onSubmit).toHaveBeenCalledWith({
      type: 'MARITIME_TRADE',
      give: { brick: 4, lumber: 3, wool: 0, grain: 0, ore: 0 },
      get: { brick: 0, lumber: 0, wool: 0, grain: 1, ore: 2 },
    });
  });

  test('offer cards expose only concrete response choices, disabling rejected acceptance', () => {
    const accept = { type: 'RESPOND_TRADE', offerId: 7, accept: true };
    const decline = { type: 'RESPOND_TRADE', offerId: 7, accept: false };
    const onSubmit = vi.fn<(command: CommandShape) => void>();
    const offerState = {
      ...state,
      ext: {
        ...state.ext,
        base: {
          offers: [
            {
              id: 7,
              proposer: 1,
              give: { brick: 1 },
              want: { ore: 1 },
              to: [0],
              acceptedBy: [],
              declinedBy: [],
              valid: true,
            },
          ],
        },
      },
    };
    const validate = (command: CommandShape): Result<void> =>
      command === decline ? success(undefined) : failure('cannot-pay', 'Cannot accept');
    mount(
      <IncomingOffers
        {...props({ commands: [accept, decline], templates: [] }, validate, onSubmit)}
        state={offerState}
      />,
    );
    expect(screen.getByRole('button', { name: 'Accept' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(onSubmit).toHaveBeenCalledWith(decline);
  });

  test('names each accepted counterparty and shows every response before confirmation', () => {
    const first = { type: 'CONFIRM_TRADE', offerId: 9, withSeat: 1 };
    const second = { type: 'CONFIRM_TRADE', offerId: 9, withSeat: 2 };
    const onSubmit = vi.fn<(command: CommandShape) => void>();
    const offerState = {
      ...state,
      ext: {
        ...state.ext,
        base: {
          offers: [
            {
              id: 9,
              proposer: 0,
              give: { brick: 1 },
              want: { ore: 1 },
              to: [1, 2],
              acceptedBy: [1, 2],
              declinedBy: [],
              valid: true,
            },
          ],
        },
      },
    };
    mount(
      <IncomingOffers
        {...props({ commands: [first, second], templates: [] }, () => success(undefined), onSubmit)}
        state={offerState}
      />,
    );
    expect(screen.getByRole('list', { name: 'Player responses' }).textContent).toContain(
      'Ari: accepted',
    );
    expect(screen.getByRole('list', { name: 'Player responses' }).textContent).toContain(
      'Bea: accepted',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Trade with Bea' }));
    expect(onSubmit).toHaveBeenCalledWith(second);
    expect(onSubmit.mock.calls[0]?.[0]).toBe(second);
  });
});
