import { expect, test } from 'vitest';
import { standardFixedBoard } from '@cp2p/maps';
import { LocalSession } from '../../session/local-session';
import { assignCardFlights, type CardTransfer, type HandView } from './card-flights';
import { deriveVisualEffects } from './visual-effects';

const empty = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };

function hand(counts: Partial<typeof empty>) {
  return { ...empty, ...counts };
}

const steal: CardTransfer = { id: '7:0:steal', from: 1, to: 0, cards: null, count: 1 };

test('a thief sees the stolen card fly face up into its slot', () => {
  const viewer: HandView = { seat: 0, before: hand({ ore: 1 }), after: hand({ ore: 2 }) };
  expect(assignCardFlights([steal], viewer, {}, 7)).toEqual([
    { id: '7:0:steal:ore', from: 1, to: 0, face: 'ore', count: 1, private: true },
  ]);
});

test('a victim sees its own lost card leave its slot for the thief', () => {
  const viewer: HandView = {
    seat: 1,
    before: hand({ wool: 2, ore: 1 }),
    after: hand({ wool: 1, ore: 1 }),
  };
  expect(assignCardFlights([steal], viewer, {}, 7)).toEqual([
    { id: '7:0:steal:wool', from: 1, to: 0, face: 'wool', count: 1, private: true },
  ]);
});

test('anyone else sees only a card back, with no kind anywhere in the cue', () => {
  const observer: HandView = { seat: 2, before: hand({ ore: 3 }), after: hand({ ore: 3 }) };
  for (const viewer of [observer, null]) {
    const flights = assignCardFlights([steal], viewer, {}, 7);
    expect(flights).toEqual([
      { id: '7:0:steal', from: 1, to: 0, face: null, count: 1, private: false },
    ]);
    expect(JSON.stringify(flights)).not.toMatch(/brick|lumber|wool|grain|ore/);
  }
});

test('takes of several cards split by kind for the parties and stay backs for others', () => {
  const take: CardTransfer = { id: '9:0:take', from: 2, to: 0, cards: null, count: 2 };
  const target: HandView = {
    seat: 2,
    before: hand({ brick: 1, grain: 2 }),
    after: hand({ grain: 1 }),
  };
  expect(assignCardFlights([take], target, {}, 9)).toEqual([
    { id: '9:0:take:brick', from: 2, to: 0, face: 'brick', count: 1, private: true },
    { id: '9:0:take:grain', from: 2, to: 0, face: 'grain', count: 1, private: true },
  ]);
  expect(assignCardFlights([take], null, {}, 9)).toEqual([
    { id: '9:0:take', from: 2, to: 0, face: null, count: 2, private: false },
  ]);
});

test('a change no event explains flies to or from the bank, after production claims its share', () => {
  const bankTrade: HandView = { seat: 0, before: hand({ wool: 4 }), after: hand({ ore: 1 }) };
  expect(assignCardFlights([], bankTrade, {}, 3)).toEqual([
    { id: '3:bank:in:ore', from: 'bank', to: 0, face: 'ore', count: 1, private: true },
    { id: '3:bank:out:wool', from: 0, to: 'bank', face: 'wool', count: 4, private: true },
  ]);
  const produced: HandView = { seat: 0, before: hand({}), after: hand({ grain: 3 }) };
  expect(assignCardFlights([], produced, { grain: 3 }, 4)).toEqual([]);
  expect(assignCardFlights([], produced, { grain: 2 }, 4)).toEqual([
    { id: '4:bank:in:grain', from: 'bank', to: 0, face: 'grain', count: 1, private: true },
  ]);
});

test('public kinds (player trades, monopolies) fly face up for everyone', () => {
  const trade: CardTransfer[] = [
    { id: '5:0:trade:1:give', from: 0, to: 1, cards: { brick: 2 }, count: 2 },
    { id: '5:0:trade:1:want', from: 1, to: 0, cards: { ore: 1 }, count: 1 },
  ];
  const party: HandView = {
    seat: 0,
    before: hand({ brick: 3 }),
    after: hand({ brick: 1, ore: 1 }),
  };
  const flights = [
    { id: '5:0:trade:1:give:brick', from: 0, to: 1, face: 'brick', count: 2, private: false },
    { id: '5:0:trade:1:want:ore', from: 1, to: 0, face: 'ore', count: 1, private: false },
  ];
  expect(assignCardFlights(trade, party, {}, 5)).toEqual(flights);
  expect(assignCardFlights(trade, null, {}, 5)).toEqual(flights);
});

test('knights and robber take events become transfers with the viewer’s own kinds', () => {
  const made = LocalSession.create({
    config: {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1, 2],
      options: { base: { mapLayout: 'standard-fixed' } },
      board: standardFixedBoard(),
    },
    humanSeats: [0, 1, 2],
    botSeats: [],
    genesisSeed: new Uint8Array(32).fill(8),
  });
  if (!made.ok) throw new Error(made.error.message);
  try {
    const state = made.value.getState();
    const events = [
      { type: 'resourceStolen', thief: 0, victim: 1, known: false },
      { type: 'cardsTaken', seat: 0, from: 2, count: 2 },
      { type: 'weddingGift', seat: 1, to: 0, count: 1 },
      { type: 'monopolyCollected', seat: 2, from: 1, resource: 'grain', count: 2 },
      { type: 'resourcesDiscarded', seat: 2, count: 4 },
    ];
    const observer = deriveVisualEffects(state, state, events, 12).cardFlights;
    expect(observer.map(({ from, to, face, count }) => [from, to, face, count])).toEqual([
      [1, 0, null, 1],
      [2, 0, null, 2],
      [1, 0, null, 1],
      [1, 2, 'grain', 2],
      [2, 'bank', null, 4],
    ]);
    const thief: HandView = {
      seat: 0,
      before: hand({}),
      after: hand({ ore: 1, wool: 2, lumber: 1 }),
    };
    const seen = deriveVisualEffects(state, state, events, 12, thief).cardFlights;
    expect(
      seen.filter((flight) => flight.to === 0).map(({ from, face, count }) => [from, face, count]),
    ).toEqual([
      [1, 'lumber', 1],
      [2, 'wool', 2],
      [1, 'ore', 1],
    ]);
  } finally {
    made.value.dispose();
  }
});
