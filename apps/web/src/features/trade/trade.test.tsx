// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { createBaseEngine, failure, success } from '@cp2p/engine';
import type {
  CommandShape,
  GameEvent,
  GameState,
  LegalCommandSet,
  PrivateState,
  ResourceCounts,
  Result,
  Seat,
} from '@cp2p/engine';
import rules from '../../i18n/locales/en/rules.json';
import type { CommandFormProps } from '../dialogs/types.js';
import { BankTradePicker } from './BankTradePicker.js';
import { IncomingOffers } from './IncomingOffers.js';
import { TradeComposer } from './TradeComposer.js';
import { TradeNotice } from './TradeNotice.js';

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
const hand: ResourceCounts = { brick: 4, lumber: 4, wool: 0, grain: 0, ore: 0 };
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
    playerLabel: label,
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
      Reflect.get(give, 'lumber') === 4 &&
      Reflect.get(get, 'ore') === 1 &&
      Reflect.get(get, 'grain') === 1)
    ? success(undefined)
    : failure('terms', 'Invalid bank trade');
}

/** The base state with one open offer; unspecified terms are one brick for one ore. */
function withOffer(offer: Record<string, unknown>, activeSeat: Seat = 0): GameState {
  return {
    ...state,
    turn: { ...state.turn, activeSeat },
    ext: {
      ...state.ext,
      base: {
        offers: [
          { id: 5, give: { brick: 1 }, want: { ore: 1 }, declinedBy: [], valid: true, ...offer },
        ],
      },
    },
  };
}

const label = (seat: Seat) => (seat === 2 ? 'Bea' : seat === 1 ? 'Ari' : 'You');

function noticeView(current: GameState, log: GameEvent[]) {
  return (
    <I18nextProvider i18n={i18n}>
      <TradeNotice state={current} events={log} seat={0} playerLabel={label} />
    </I18nextProvider>
  );
}

/** The status line an offer shows the viewer (seat 0). */
function hintFor(offer: Record<string, unknown>, commands: CommandShape[], activeSeat: Seat = 0) {
  cleanup();
  mount(
    <IncomingOffers
      {...props({ commands, templates: [] }, () => success(undefined))}
      state={withOffer(offer, activeSeat)}
    />,
  );
  return screen.queryByRole('status')?.textContent ?? null;
}

describe('controlled trade forms', () => {
  test('online offer checks show pending feedback and disable submission until the current verdict', async () => {
    const finishes: ((result: Result<void>) => void)[] = [];
    const validate = vi.fn<() => Promise<Result<void>>>(
      () =>
        new Promise((resolve) => {
          finishes.push(resolve);
        }),
    );
    const onSubmit = vi.fn<(command: CommandShape) => void>();
    mount(
      <TradeComposer
        {...props({ commands: [], templates: [{ type: 'OFFER_TRADE' }] }, validateOffer, onSubmit)}
        validate={validate}
        validationKey="head-1:seat-0"
        validationSession={{ mode: 'p2p' }}
      />,
    );
    const send = screen.getByRole('button', { name: 'Send offer' });
    expect(send.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add Brick to You give' }));
    expect(screen.getByText('Checking this move…')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => expect(validate).toHaveBeenCalledTimes(2));
    await act(async () => finishes[1]?.(success(undefined)));
    expect(send.hasAttribute('disabled')).toBe(false);
    fireEvent.click(send);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('offer composer submits selected give/want and recipients only after validation', () => {
    const onSubmit = vi.fn<(command: CommandShape) => void>();
    mount(
      <TradeComposer
        {...props({ commands: [], templates: [{ type: 'OFFER_TRADE' }] }, validateOffer, onSubmit)}
      />,
    );
    const send = screen.getByRole('button', { name: 'Send offer' });
    const dialog = screen.getByRole('dialog', { name: 'Player trade' });
    expect(dialog.querySelector('.trade-dialog-body')?.contains(send)).toBe(false);
    expect(dialog.querySelector('.trade-dialog-footer')?.contains(send)).toBe(true);
    expect(send.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.touchStart(screen.getByRole('button', { name: 'Add Brick to You give' }));
    fireEvent.touchEnd(screen.getByRole('button', { name: 'Add Brick to You give' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Brick to You give' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Ore to You get' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bea' }));
    expect(send.hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('group', { name: 'You give' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'You get' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Offer preview' })).toBeNull();
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
    expect(screen.getAllByText('4 for 1').length).toBeGreaterThan(0);
    const handAdd = screen.getByRole('button', { name: 'Add Brick to You give' });
    const stockDescription = handAdd.getAttribute('aria-describedby');
    expect(stockDescription).toBeTruthy();
    expect(
      stockDescription
        ?.split(' ')
        .some((id) => document.getElementById(id)?.textContent === '4 in hand'),
    ).toBe(true);
    const bankCards = screen.getByRole('group', { name: 'Bank gives' });
    expect(within(bankCards).getByText('in bank')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add Brick to You give' }));
    const addBrick = screen.getByRole('button', { name: 'Add Brick to You give' });
    expect(addBrick.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(addBrick);
    expect(screen.getByText('Selected: 4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Brick from You give' }));
    expect(addBrick.getAttribute('aria-disabled')).toBe('false');
    fireEvent.click(addBrick);
    fireEvent.click(screen.getByRole('button', { name: 'Add Lumber to You give' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Ore to Bank gives' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Grain to Bank gives' }));
    expect(screen.getByText('Give 8 cards for 2 from the bank')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onSubmit).toHaveBeenCalledWith({
      type: 'MARITIME_TRADE',
      give: { brick: 4, lumber: 4, wool: 0, grain: 0, ore: 0 },
      get: { brick: 0, lumber: 0, wool: 0, grain: 1, ore: 1 },
    });
  });

  test('bank picker conceals exact bank stock when the rule option hides it', () => {
    const hiddenState = {
      ...state,
      config: {
        ...state.config,
        options: {
          ...state.config.options,
          base: { mapLayout: 'random', hideBankCounts: true },
        },
      },
    };
    mount(
      <BankTradePicker
        {...props({ commands: [], templates: [{ type: 'MARITIME_TRADE' }] }, validateBank)}
        state={hiddenState}
      />,
    );
    const bankCards = screen.getByRole('group', { name: 'Bank gives' });
    expect(within(bankCards).queryAllByText(/in bank/)).toHaveLength(0);
    expect(bankCards.querySelectorAll('.resource-card-stock')).toHaveLength(0);
    expect(within(bankCards).getByRole('button', { name: 'Add Ore to Bank gives' })).toBeTruthy();
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
              give: { wool: 2 },
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
    const receive = screen.getByRole('group', { name: 'You get' });
    const give = screen.getByRole('group', { name: 'You give' });
    expect(within(receive).getByText('Wool')).toBeTruthy();
    expect(within(give).getByText('Ore')).toBeTruthy();
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
      'Ariaccepted',
    );
    expect(screen.getByRole('list', { name: 'Player responses' }).textContent).toContain(
      'Beaaccepted',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Trade with Bea' }));
    expect(onSubmit).toHaveBeenCalledWith(second);
    expect(onSubmit.mock.calls[0]?.[0]).toBe(second);
  });

  test('shows public offers without inventing response actions and collapses for placement', () => {
    const offerState = {
      ...state,
      ext: {
        ...state.ext,
        base: {
          offers: [
            {
              id: 4,
              proposer: 1,
              give: { brick: 2 },
              want: { ore: 1 },
              to: [2],
              acceptedBy: [],
              declinedBy: [],
              valid: true,
            },
          ],
        },
      },
    };
    const { rerender } = mount(
      <IncomingOffers
        {...props({ commands: [], templates: [] }, () => success(undefined))}
        state={offerState}
      />,
    );
    const details = screen.getByText('Offer from Ari').closest<HTMLDetailsElement>('details');
    expect(details?.open).toBe(false);
    fireEvent.click(screen.getByText('Offer from Ari'));
    expect(details?.open).toBe(true);
    expect(screen.getByText('Ari gives')).toBeTruthy();
    expect(screen.getByText('Ari wants')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    rerender(
      <I18nextProvider i18n={i18n}>
        <IncomingOffers
          {...props({ commands: [], templates: [] }, () => success(undefined))}
          state={offerState}
          collapsedWhilePlacing
        />
      </I18nextProvider>,
    );
    expect(details?.open).toBe(false);
  });

  test('says what an answered offer waits for, on both sides of the trade', () => {
    const cancel = { type: 'CANCEL_TRADE', offerId: 5 };
    const confirm = { type: 'CONFIRM_TRADE', offerId: 5, withSeat: 2 };
    // A bot's offer the viewer accepted: the viewer waits for the bot to confirm.
    expect(hintFor({ proposer: 1, to: [0, 2], acceptedBy: [0] }, [cancel], 1)).toBe(
      'You accepted. Waiting for Ari to confirm.',
    );
    // The viewer's own offer, before, after and without acceptance.
    expect(hintFor({ proposer: 0, to: [1, 2], acceptedBy: [] }, [cancel])).toBe(
      'Waiting for replies…',
    );
    expect(hintFor({ proposer: 0, to: [1, 2], acceptedBy: [2] }, [cancel, confirm])).toBe(
      'Bea accepted. Trade to complete it.',
    );
    expect(hintFor({ proposer: 0, to: [1, 2], acceptedBy: [], declinedBy: [1, 2] }, [cancel])).toBe(
      'Everyone declined. Withdraw the offer or send a new one.',
    );
    // A counter-offer the viewer made to the active player.
    expect(hintFor({ proposer: 0, to: [1], acceptedBy: [] }, [cancel], 1)).toBe(
      'Waiting for Ari to answer your offer.',
    );
  });

  test('announces how the viewer’s open trade ended instead of letting it vanish', () => {
    vi.useFakeTimers();
    try {
      const open = (offer: Record<string, unknown>) => withOffer({ id: 3, ...offer });
      const closed: GameState = { ...state, ext: { ...state.ext, base: { offers: [] } } };
      const outcome = (before: GameState, events: GameEvent[]) => {
        cleanup();
        const { rerender } = render(noticeView(before, []));
        rerender(noticeView(closed, events));
        return screen.queryByRole('status')?.textContent ?? null;
      };
      const botOffer = open({ proposer: 1, to: [0, 2], acceptedBy: [0] });
      expect(outcome(botOffer, [{ type: 'tradeConfirmed', offerId: 3, withSeat: 0 }])).toBe(
        'Trade with Ari completed.',
      );
      expect(outcome(botOffer, [{ type: 'tradeConfirmed', offerId: 3, withSeat: 2 }])).toBe(
        'Ari traded with Bea instead.',
      );
      expect(outcome(botOffer, [{ type: 'tradeCancelled', offerId: 3, seat: 1 }])).toBe(
        'Ari withdrew the offer.',
      );
      expect(outcome(botOffer, [{ type: 'turnEnded' }])).toBe(
        'The offer expired when the turn ended.',
      );
      const counter = open({ proposer: 0, to: [1], acceptedBy: [] });
      expect(outcome(counter, [{ type: 'tradeCancelled', offerId: 3, seat: 1 }])).toBe(
        'Ari turned down your offer.',
      );
      // The viewer's own withdrawal needs no word.
      expect(outcome(counter, [{ type: 'tradeCancelled', offerId: 3, seat: 0 }])).toBeNull();
      // The notice clears itself.
      expect(outcome(botOffer, [{ type: 'tradeCancelled', offerId: 3, seat: 1 }])).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(6_000);
      });
      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
