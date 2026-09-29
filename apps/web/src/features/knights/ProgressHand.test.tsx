// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { knightsConfig, knightsEngine } from '@cp2p/engine';
import type { GameState, PrivateState } from '@cp2p/engine';
import knights from '../../i18n/locales/en/knights.json';
import type { KnightsController } from './controller';
import { ProgressHand } from './ProgressHand';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en',
    defaultNS: 'knights',
    resources: { en: { knights } },
    initImmediate: false,
  });
});
afterEach(cleanup);

const genesis = engineGenesis();

function engineGenesis(): GameState {
  return knightsEngine().createGame(knightsConfig({ seats: 3 }), new Uint8Array(32).fill(6));
}

/** A seat holding these progress cards (by name), the way the engine keeps them. */
function holding(cards: readonly string[]): { state: GameState; priv: PrivateState } {
  const slots = cards.map((_, index) => ({
    slotId: `progress:${index}`,
    deck: 'progress-science',
    acquiredTurn: 1,
  }));
  const state: GameState = {
    ...genesis,
    seats: genesis.seats.map((seat) => (seat.seat === 0 ? { ...seat, cardSlots: slots } : seat)),
  };
  const priv: PrivateState = {
    seat: 0,
    hand: {},
    slots: Object.fromEntries(cards.map((card, index) => [`progress:${index}`, card])),
    ext: {},
  };
  return { state, priv };
}

function controller(playable: readonly string[]): KnightsController & {
  playCard: Mock<(slotId: string, card: string) => void>;
  openDiscard: Mock<() => void>;
} {
  return {
    improvable: [],
    improve: vi.fn<() => void>(),
    playCard: vi.fn<(slotId: string, card: string) => void>(),
    playable: (slotId) => playable.includes(slotId),
    openDiscard: vi.fn<() => void>(),
    openImprovements: vi.fn<() => void>(),
    openHarbor: vi.fn<() => void>(),
    disabled: false,
    harborOpen: false,
  };
}

function show(
  cards: readonly string[],
  control: KnightsController | null,
  turn: Partial<GameState['turn']> = {},
) {
  const held = holding(cards);
  const state: GameState = { ...held.state, turn: { ...held.state.turn, ...turn } };
  const priv = held.priv;
  return render(
    <I18nextProvider i18n={i18n}>
      <ProgressHand state={state} seat={0} priv={priv} controller={control} />
    </I18nextProvider>,
  );
}

test('a seat with no progress cards shows no hand', () => {
  const page = show([], controller([]));
  expect(page.container.textContent).toBe('');
});

test('a playable card opens its play; any other card opens its view with the reason', () => {
  const control = controller(['progress:0']);
  show(['irrigation', 'mining'], control, {
    activeSeat: 0,
    phase: [{ module: 'base', id: 'main', data: null }],
  });
  const irrigation = screen.getByTestId('progress-card-irrigation');
  const mining = screen.getByTestId('progress-card-mining');
  expect(irrigation.getAttribute('data-playable')).toBe('true');
  expect(mining.getAttribute('data-playable')).toBe('false');
  // A card that cannot be played is still a button: tapping it shows it, never plays it.
  expect(mining.hasAttribute('disabled')).toBe(false);
  fireEvent.click(irrigation);
  expect(control.playCard).toHaveBeenCalledWith('progress:0', 'irrigation');
  fireEvent.click(mining);
  expect(control.playCard).toHaveBeenCalledOnce();
  const view = screen.getByRole('dialog');
  expect(view.textContent).toContain(knights.cards.mining.text);
  expect(screen.getByRole('status').textContent).toBe(knights.card.reason.noTarget);
  expect(screen.queryByRole('button', { name: knights.card.play })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: knights.close }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

test("on another seat's turn every card opens read-only and says it is not your turn", () => {
  const control = controller([]);
  show(['irrigation'], control, {
    activeSeat: 1,
    phase: [{ module: 'base', id: 'main', data: null }],
  });
  fireEvent.click(screen.getByTestId('progress-card-irrigation'));
  expect(screen.getByRole('status').textContent).toBe(knights.card.reason.notYourTurn);
  expect(control.playCard).not.toHaveBeenCalled();
});

test('without a controller (a watcher) a card still opens its view', () => {
  show(['mining'], null, { activeSeat: 0, phase: [{ module: 'base', id: 'preRoll', data: null }] });
  fireEvent.click(screen.getByTestId('progress-card-mining'));
  expect(screen.getByRole('status').textContent).toBe(knights.card.reason.afterRoll);
});

test('a hand over the limit offers the discard', () => {
  const control = controller([]);
  show(['irrigation', 'mining', 'irrigation', 'mining', 'irrigation'], control);
  fireEvent.click(screen.getByRole('button', { name: /discard/i }));
  expect(control.openDiscard).toHaveBeenCalledOnce();
});
