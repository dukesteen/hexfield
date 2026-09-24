import type { GameModule } from '../../modules/types.js';
import type { GameConfig, GameState, PrivateState } from '../../state/types.js';
import { failure, success } from '../../types/index.js';
import type { Seat } from '../../types/index.js';

interface CounterExt {
  value: number;
  started: boolean;
}

function counter(state: GameState): CounterExt {
  const value = state.ext['test-counter'];
  if (
    typeof value !== 'object' ||
    value === null ||
    !('value' in value) ||
    !('started' in value) ||
    typeof value.value !== 'number' ||
    typeof value.started !== 'boolean'
  )
    throw new Error('Invalid counter state');
  return { value: value.value, started: value.started };
}

function options(state: GameState): { goal: number; auto: boolean } {
  const value = state.config.options['test-counter'];
  if (
    typeof value !== 'object' ||
    value === null ||
    !('goal' in value) ||
    !('auto' in value) ||
    typeof value.goal !== 'number' ||
    typeof value.auto !== 'boolean'
  )
    throw new Error('Invalid counter options');
  return { goal: value.goal, auto: value.auto };
}

function observed(priv: PrivateState): number {
  const value = priv.ext['test-counter'];
  if (
    typeof value !== 'object' ||
    value === null ||
    !('observed' in value) ||
    typeof value.observed !== 'number'
  )
    throw new Error('Invalid private counter state');
  return value.observed;
}

function nextSeat(state: GameState): Seat {
  const index = (state.turn.activeSeat + 1) % state.seats.length;
  const seat = state.config.seats.find((candidate) => candidate === index);
  if (seat === undefined) throw new Error('Missing next seat');
  return seat;
}

function inputSeat(state: GameState, value: unknown): Seat {
  const seat = state.config.seats.find((candidate) => candidate === value);
  if (seat === undefined) throw new Error('Invalid input seat');
  return seat;
}

function withValue(state: GameState, value: number, events: { type: string }[] = []) {
  const goal = options(state).goal;
  return {
    state: {
      ...state,
      ext: { ...state.ext, 'test-counter': { ...counter(state), value } },
      ...(value >= goal
        ? {
            result: { winner: state.turn.activeSeat, reason: 'counter', atTurn: state.turn.number },
          }
        : {}),
    },
    events,
  };
}

export function testCounter(): GameModule {
  return {
    id: 'test-counter',
    version: '1.0.0',
    dependsOn: [],
    conflictsWith: [],
    optionsSchema: [
      { key: 'goal', type: 'integer', default: 3, min: 1, max: 10 },
      { key: 'auto', type: 'boolean', default: false },
    ],
    initState: () => ({ value: 0, started: false }),
    initializeState: (_ctx, state) => ({
      ...state,
      bank: { tokens: 7 },
      seats: state.seats.map((seat) => ({ ...seat, piecesLeft: { counters: 3 } })),
    }),
    initPrivate: () => ({ observed: 0 }),
    initialPhase: () => ({ id: 'turn', module: 'test-counter', data: null }),
    autoInput: (state) =>
      options(state).auto && counter(state).started && counter(state).value === 0
        ? { kind: 'command', seat: state.turn.activeSeat, command: { type: 'INC', amount: 1 } }
        : null,
    phases: {
      turn: {
        pending: (state) =>
          !counter(state).started
            ? [
                {
                  kind: 'random',
                  request: { type: 'startSeat', max: state.seats.length },
                  systemType: 'START_SEAT',
                },
              ]
            : [{ kind: 'player', seat: state.turn.activeSeat, allowed: ['INC', 'END'] }],
        legalCommands: (state, _frame, seat) =>
          seat === state.turn.activeSeat && counter(state).started
            ? { commands: [{ type: 'INC', amount: 1 }, { type: 'END' }], templates: [] }
            : { commands: [], templates: [] },
      },
      bonus: {
        pending: () => [
          { kind: 'random', request: { type: 'bonus', max: 2 }, systemType: 'BONUS_RESULT' },
        ],
      },
      reveal: {
        pending: (state) => [
          {
            kind: 'reveal',
            seat: state.turn.activeSeat,
            request: { type: 'counter' },
            systemType: 'REVEAL_RESULT',
          },
        ],
      },
    },
    commands: {
      INC: {
        validate: (_state, input) =>
          input.command.amount === 1
            ? success(undefined)
            : failure('invalid-increment', 'Increment amount must be one'),
        apply: (state) => {
          const value = counter(state).value + 1;
          const next = withValue(state, value, [{ type: 'counterChanged' }]);
          if (value !== 1 || next.state.result) return next;
          return {
            ...next,
            state: {
              ...next.state,
              turn: {
                ...next.state.turn,
                phase: [
                  ...next.state.turn.phase,
                  { id: 'bonus', module: 'test-counter', data: null },
                ],
              },
            },
          };
        },
        applyPrivate: (priv, _before, input) =>
          success(
            priv.seat === input.seat
              ? {
                  ...priv,
                  ext: {
                    ...priv.ext,
                    'test-counter': {
                      observed: observed(priv) + 1,
                    },
                  },
                }
              : priv,
          ),
      },
      END: {
        validate: () => success(undefined),
        apply: (state) => {
          const next = nextSeat(state);
          return {
            state: {
              ...state,
              turn: { ...state.turn, activeSeat: next, number: state.turn.number + 1 },
            },
            events: [],
          };
        },
      },
    },
    systemInputs: {
      START_SEAT: {
        validate: (state, input) =>
          state.config.seats.some((seat) => seat === input.seat)
            ? success(undefined)
            : failure('invalid-start-seat', 'Start seat is not in the game'),
        apply: (state, input) => ({
          state: {
            ...state,
            ext: { ...state.ext, 'test-counter': { ...counter(state), started: true } },
            turn: { ...state.turn, activeSeat: inputSeat(state, input.seat) },
          },
          events: [],
        }),
      },
      BONUS_RESULT: {
        accepts: (pending, input) => pending.kind === 'random' && input.amount === 1,
        validate: (_state, input) =>
          input.amount === 1 ? success(undefined) : failure('invalid-bonus', 'Bonus must be one'),
        apply: (state) => {
          const next = withValue(state, counter(state).value + 1);
          return {
            ...next,
            state: {
              ...next.state,
              turn: {
                ...next.state.turn,
                phase: [
                  ...next.state.turn.phase.slice(0, -1),
                  { id: 'reveal', module: 'test-counter', data: null },
                ],
              },
            },
          };
        },
      },
      REVEAL_RESULT: {
        validate: (state, input) =>
          input.seat === state.turn.activeSeat && input.count === 1
            ? success(undefined)
            : failure('invalid-reveal', 'Reveal must match the active seat and count'),
        apply: (state) => {
          const next = withValue(state, counter(state).value + 1);
          return {
            ...next,
            state: {
              ...next.state,
              turn: { ...next.state.turn, phase: next.state.turn.phase.slice(0, -1) },
            },
          };
        },
      },
      TIMEOUT: {
        validate: () => success(undefined),
        apply: (state) => {
          const next = nextSeat(state);
          return { state: { ...state, turn: { ...state.turn, activeSeat: next } }, events: [] };
        },
      },
    },
    victoryPoints: (state) => [{ source: 'counter', points: counter(state).value, public: true }],
    invariants: (state) => (counter(state).value < 0 ? ['counter must be non-negative'] : []),
  };
}

export const seed = new Uint8Array(32);
export const config: GameConfig = {
  modules: [{ id: 'test-counter', version: '1.0.0' }],
  seats: [0, 1],
  options: {},
};

export function privateObserved(priv: PrivateState): number {
  return observed(priv);
}
