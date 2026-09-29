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

function show(cards: readonly string[], control: KnightsController | null) {
  const { state, priv } = holding(cards);
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

test('each card is a face, and only a card the engine lets it play can be played', () => {
  const control = controller(['progress:0']);
  show(['irrigation', 'mining'], control);
  const irrigation = screen.getByTestId('progress-card-irrigation');
  const mining = screen.getByTestId('progress-card-mining');
  expect(irrigation.hasAttribute('disabled')).toBe(false);
  expect(mining.hasAttribute('disabled')).toBe(true);
  fireEvent.click(irrigation);
  expect(control.playCard).toHaveBeenCalledWith('progress:0', 'irrigation');
});

test('a hand over the limit offers the discard', () => {
  const control = controller([]);
  show(['irrigation', 'mining', 'irrigation', 'mining', 'irrigation'], control);
  fireEvent.click(screen.getByRole('button', { name: /discard/i }));
  expect(control.openDiscard).toHaveBeenCalledOnce();
});
