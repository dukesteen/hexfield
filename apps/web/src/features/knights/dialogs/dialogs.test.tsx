// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { failure } from '@cp2p/engine';
import type { CommandShape, GameState, Pending } from '@cp2p/engine';
import { deriveActionAvailability } from '../../actions/availability';
import {
  AqueductDialog,
  DeckChoiceDialog,
  HarborOfferDialog,
  HarborReplyDialog,
} from './ChoiceDialogs';
import { DiscardProgressDialog } from './DiscardProgressDialog';
import { GiveCardsDialog } from './GiveCardsDialog';
import { ImprovementsDialog } from './ImprovementsDialog';
import { PlayCardDialog } from './PlayCardDialog';
import {
  formProps,
  genesis,
  handOf,
  presentation,
  testI18n,
  withFrame,
  withI18n,
} from '../test-support';

let i18n: Awaited<ReturnType<typeof testI18n>>;
beforeAll(async () => {
  i18n = await testI18n();
});
afterEach(cleanup);

const commands = (list: CommandShape[]) => ({ commands: list, templates: [] });

describe('the Aqueduct', () => {
  test('offers each resource the bank can pay and submits the one tapped', () => {
    const props = formProps(
      genesis,
      commands(
        ['brick', 'lumber', 'ore'].map((resource) => ({ type: 'CHOOSE_AQUEDUCT', resource })),
      ),
    );
    withI18n(i18n, <AqueductDialog {...props} />);
    expect(screen.getByRole('dialog').textContent).toContain('The roll gave you nothing');
    expect(screen.getAllByRole('button')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Ore' }));
    expect(props.onSubmit).toHaveBeenCalledWith({ type: 'CHOOSE_AQUEDUCT', resource: 'ore' });
  });

  test('shows the hand the dialog covers on phones, commodities included', () => {
    const props = formProps(
      genesis,
      commands([{ type: 'CHOOSE_AQUEDUCT', resource: 'ore' }]),
      handOf({ grain: 2, cloth: 1 }),
    );
    withI18n(i18n, <AqueductDialog {...props} />);
    const hand = screen.getByRole('group', { name: 'Your hand' });
    expect(hand.textContent).toContain('Grain');
    expect(hand.textContent).toContain('Cloth');
    expect(hand.textContent).not.toContain('Ore');
  });

  test('shows nothing when the engine offers no choice', () => {
    const { container } = withI18n(i18n, <AqueductDialog {...formProps(genesis, commands([]))} />);
    expect(container.textContent).toBe('');
  });
});

describe('the deck after a tie', () => {
  test('names each deck the engine offers and submits the pick', () => {
    const props = formProps(
      genesis,
      commands(['trade', 'science'].map((deck) => ({ type: 'CHOOSE_PROGRESS_DECK', deck }))),
    );
    withI18n(i18n, <DeckChoiceDialog {...props} />);
    expect(screen.queryByRole('button', { name: 'Politics' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Science' }));
    expect(props.onSubmit).toHaveBeenCalledWith({ type: 'CHOOSE_PROGRESS_DECK', deck: 'science' });
  });
});

/** A hand of two of each kind, with a gift or a discard asked for. */
function giving(id: 'wedding' | 'saboteur', count: number, overrides = {}) {
  const type = id === 'wedding' ? 'WEDDING_GIVE' : 'SABOTEUR_DISCARD';
  const state = withFrame(genesis, id, { actor: 1, remaining: [0] });
  return formProps(
    state,
    { commands: [], templates: [{ type, count }] },
    handOf({ brick: 2, ore: 2, coin: 1 }),
    overrides,
  );
}

describe('a wedding gift and a sabotage discard', () => {
  test('the wedding names the receiver and waits for exactly the count', () => {
    const props = giving('wedding', 2);
    withI18n(i18n, <GiveCardsDialog kind="WEDDING_GIVE" {...props} />);
    expect(screen.getByText('A wedding for Bo. Give 2 cards.')).toBeTruthy();
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    // The reason it is disabled is on screen, not left to be guessed.
    expect(screen.getByText('Selected 0 of 2')).toBeTruthy();
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add Brick to Cards to give' }));
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Add Coin to Cards to give' }));
    expect(screen.getByText('Selected 2 of 2')).toBeTruthy();
    expect(confirm.hasAttribute('disabled')).toBe(false);
    fireEvent.click(confirm);
    expect(props.onSubmit).toHaveBeenCalledWith({
      type: 'WEDDING_GIVE',
      cards: expect.objectContaining({ brick: 1, coin: 1, ore: 0 }),
    });
  });

  test('a card the hand does not hold cannot be added, nor one past the hand of that kind', () => {
    withI18n(i18n, <GiveCardsDialog kind="WEDDING_GIVE" {...giving('wedding', 4)} />);
    const cloth = screen.getByRole('button', { name: 'Add Cloth to Cards to give' });
    fireEvent.click(cloth);
    expect(screen.getByText('Selected 0 of 4')).toBeTruthy();
    const coin = screen.getByRole('button', { name: 'Add Coin to Cards to give' });
    fireEvent.click(coin);
    fireEvent.click(coin);
    expect(screen.getByText('Selected 1 of 4')).toBeTruthy();
  });

  test('the saboteur asks for its own count and submits a discard', () => {
    const props = giving('saboteur', 2);
    withI18n(i18n, <GiveCardsDialog kind="SABOTEUR_DISCARD" {...props} />);
    expect(screen.getByText('A Saboteur strikes. Discard 2 cards to the bank.')).toBeTruthy();
    const ore = screen.getByRole('button', { name: 'Add Ore to Cards to discard' });
    fireEvent.click(ore);
    fireEvent.click(ore);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(props.onSubmit).toHaveBeenCalledWith({
      type: 'SABOTEUR_DISCARD',
      cards: expect.objectContaining({ ore: 2 }),
    });
  });

  test('a selection the engine rejects cannot be confirmed', () => {
    const props = giving('saboteur', 1, { validate: () => failure('nope', 'no') });
    withI18n(i18n, <GiveCardsDialog kind="SABOTEUR_DISCARD" {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Ore to Cards to discard' }));
    expect(screen.getByRole('button', { name: 'Confirm' }).hasAttribute('disabled')).toBe(true);
  });

  test('without a template from the engine there is no dialog', () => {
    const state = withFrame(genesis, 'wedding', { actor: 1, remaining: [0] });
    const { container } = withI18n(
      i18n,
      <GiveCardsDialog kind="WEDDING_GIVE" {...formProps(state, commands([]))} />,
    );
    expect(container.textContent).toBe('');
  });
});

/** A harbor offer from seat 1 waits for the human's answer. */
const reply = (list: CommandShape[]) =>
  formProps(
    withFrame(genesis, 'harborReply', { actor: 1, seat: 0, offered: 'ore' }),
    commands(list),
  );

describe('the Commercial Harbor', () => {
  test('an offer is answered with a commodity, and the offering player is named', () => {
    const props = reply([
      { type: 'HARBOR_REPLY', commodity: 'cloth' },
      { type: 'HARBOR_REPLY', commodity: 'coin' },
    ]);
    withI18n(i18n, <HarborReplyDialog {...props} />);
    expect(screen.getByText('Bo offers you a card face down. Give back a commodity.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Give 1 Coin' }));
    expect(props.onSubmit).toHaveBeenCalledWith({ type: 'HARBOR_REPLY', commodity: 'coin' });
  });

  test('a seat with no commodity may only return the offer', () => {
    const props = reply([{ type: 'HARBOR_REPLY', commodity: 'none' }]);
    withI18n(i18n, <HarborReplyDialog {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /Return the offer/ }));
    expect(props.onSubmit).toHaveBeenCalledWith({ type: 'HARBOR_REPLY', commodity: 'none' });
  });

  test('offers go to each rival in turn, and Done closes the dialog', () => {
    const onCancel = vi.fn<() => void>();
    const props = formProps(
      genesis,
      commands([
        { type: 'HARBOR_OFFER', to: 1, resource: 'ore' },
        { type: 'HARBOR_OFFER', to: 1, resource: 'wool' },
        { type: 'HARBOR_OFFER', to: 2, resource: 'ore' },
      ]),
      handOf({}),
      { onCancel },
    );
    withI18n(i18n, <HarborOfferDialog {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Offer Wool to Bo' }));
    expect(props.onSubmit).toHaveBeenCalledWith({ type: 'HARBOR_OFFER', to: 1, resource: 'wool' });
    expect(screen.getByRole('group', { name: 'Cy' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  test('with nobody left to offer to, the dialog says so', () => {
    withI18n(i18n, <HarborOfferDialog {...formProps(genesis, commands([]))} />);
    expect(screen.getByText('No rival can take an offer now.')).toBeTruthy();
  });
});

/** Five progress cards held in the open (their identities public), one over the limit. */
function overLimit(): GameState {
  const cards = ['irrigation', 'mining', 'crane', 'engineer', 'smith'];
  return {
    ...genesis,
    seats: genesis.seats.map((seat) =>
      seat.seat === 0
        ? {
            ...seat,
            cardSlots: cards.map((known, index) => ({
              slotId: `progress:${index}`,
              deck: 'progress-science',
              acquiredTurn: 1,
              known,
            })),
          }
        : seat,
    ),
  };
}

describe('discarding progress cards', () => {
  const legal = commands([
    { type: 'DISCARD_PROGRESS', cards: [{ slotId: 'progress:1' }] },
    { type: 'DISCARD_PROGRESS', cards: [{ slotId: 'progress:2' }] },
  ]);

  test('picks the surplus and submits exactly the command the engine listed', () => {
    const onCancel = vi.fn<() => void>();
    const props = formProps(overLimit(), legal, handOf({}), { onCancel });
    withI18n(i18n, <DiscardProgressDialog forced={false} {...props} />);
    expect(screen.getByText('You may hold four progress cards. Choose 1 to discard.')).toBeTruthy();
    const discard = screen.getByRole('button', { name: 'Discard' });
    expect(discard.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Crane' }));
    // A second pick is refused: only the surplus can be chosen.
    fireEvent.click(screen.getByRole('button', { name: 'Mining' }));
    expect(screen.getByText('Selected 1 of 1')).toBeTruthy();
    fireEvent.click(discard);
    expect(props.onSubmit).toHaveBeenCalledWith(legal.commands[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  test('a forced discard has no way out', () => {
    const props = formProps(overLimit(), legal, handOf({}), { onCancel: vi.fn<() => void>() });
    withI18n(i18n, <DiscardProgressDialog forced {...props} />);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  test('a card the engine does not list as a discard cannot be confirmed', () => {
    const props = formProps(overLimit(), legal);
    withI18n(i18n, <DiscardProgressDialog forced {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Smith' }));
    expect(screen.getByRole('button', { name: 'Discard' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('the improvements dialog', () => {
  test('buys a level through the legal command, and closes', () => {
    const onCancel = vi.fn<() => void>();
    const buy: CommandShape = { type: 'BUILD_IMPROVEMENT', track: 'trade' };
    const props = formProps(genesis, commands([buy]), handOf({}), { onCancel });
    withI18n(
      i18n,
      <ImprovementsDialog presentation={presentation} onCancel={onCancel} {...props} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Buy Trade level 1 for 1 Cloth' }));
    expect(props.onSubmit).toHaveBeenCalledWith(buy);
    // The other tracks show why they cannot be bought.
    expect(
      screen.getByRole('button', { name: 'Science level 1 is not available now' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

/** Seat 0 holds this card, and the engine offers these plays of it. */
function play(card: string, plays: CommandShape[]) {
  const state: GameState = {
    ...genesis,
    seats: genesis.seats.map((seat) =>
      seat.seat === 0
        ? {
            ...seat,
            cardSlots: [
              { slotId: 'progress:9', deck: 'progress-politics', acquiredTurn: 1, known: card },
            ],
          }
        : seat,
    ),
  };
  const legal = commands(plays.map((item) => ({ ...item, slotId: 'progress:9', card })));
  const pending: Pending[] = [{ kind: 'player', seat: 0, allowed: ['PLAY_PROGRESS_CARD'] }];
  const availability = deriveActionAvailability(legal, pending, 0);
  const onCancel = vi.fn<() => void>();
  const props = formProps(state, legal, handOf({}), { onCancel });
  withI18n(
    i18n,
    <PlayCardDialog
      availability={availability}
      slotId="progress:9"
      {...props}
      onCancel={onCancel}
    />,
  );
  return { props, onCancel };
}

describe('playing a progress card', () => {
  test('a card with no choices is confirmed with one button', () => {
    const { props } = play('wedding', [{ type: 'PLAY_PROGRESS_CARD' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Play card' }));
    expect(props.onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'PLAY_PROGRESS_CARD', card: 'wedding' }),
    );
  });

  test('the Deserter asks for a rival, then plays against that one', () => {
    const { props } = play('deserter', [
      { type: 'PLAY_PROGRESS_CARD', params: { target: 1 } },
      { type: 'PLAY_PROGRESS_CARD', params: { target: 2 } },
    ]);
    expect(screen.getByText('Choose a player')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Play card' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Play card' }));
    expect(props.onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ card: 'deserter', params: { target: 2 } }),
    );
  });

  test('the Alchemist picks both dice and plays the matching command', () => {
    const plays = Array.from({ length: 36 }, (_, index) => ({
      type: 'PLAY_PROGRESS_CARD',
      params: { dice: [Math.floor(index / 6) + 1, (index % 6) + 1] },
    }));
    const { props } = play('alchemist', plays);
    // The default pair is on screen and playable at once.
    expect(screen.getByText('Total: 7')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Red die 6' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yellow die 1' }));
    expect(screen.getByText('Total: 7')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yellow die 2' }));
    expect(screen.getByText('Total: 8')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Play card' }));
    expect(props.onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ params: { dice: [6, 2] } }),
    );
  });

  test('a monopoly names a kind, and only then can it be played', () => {
    const { props } = play('resourceMonopoly', [
      { type: 'PLAY_PROGRESS_CARD', params: { kind: 'ore' } },
      { type: 'PLAY_PROGRESS_CARD', params: { kind: 'wool' } },
    ]);
    expect(screen.queryByRole('button', { name: 'Play card' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Wool' }));
    fireEvent.click(screen.getByRole('button', { name: 'Play card' }));
    expect(props.onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ params: { kind: 'wool' } }),
    );
  });

  test('the Crane offers the tracks it can buy on', () => {
    const { props } = play('crane', [
      { type: 'PLAY_PROGRESS_CARD', params: { track: 'trade' } },
      { type: 'PLAY_PROGRESS_CARD', params: { track: 'science' } },
    ]);
    expect(screen.queryByRole('button', { name: 'Politics' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Science/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Play card' }));
    expect(props.onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ params: { track: 'science' } }),
    );
  });

  test('Cancel leaves the card unplayed', () => {
    const { props, onCancel } = play('wedding', [{ type: 'PLAY_PROGRESS_CARD' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });
});
