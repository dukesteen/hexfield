import { failure, finishTurnFlowFrame, registerAdHocModule, success } from '@cp2p/engine';
import type {
  GameConfig,
  GameModule,
  GameState,
  PhaseFrame,
  PhaseHandler,
  Seat,
  SystemInputHandler,
} from '@cp2p/engine';

/** Test-only module: one public deck (`fog`) and one private non-dev deck (`loot`). */
export const SYNTHETIC_DECKS_ID = 'synthetic-decks';
export const SYNTHETIC_DECKS_VERSION = '1.0.0';
export const FOG_SYSTEM_TYPE = 'FOG_REVEALED';
/** Six distinct tiles, so two independent shuffles differ except by a 1/720 coincidence. */
export const FOG_CARDS = Object.freeze({ a: 1, b: 1, c: 1, d: 1, e: 1, f: 1 });
export const LOOT_CARDS = Object.freeze({ coin: 2, gem: 1 });

interface FogData {
  seat: Seat;
  slotId: string;
}

function fogData(frame: PhaseFrame | undefined): FogData {
  const data: unknown = frame?.data;
  if (typeof data !== 'object' || data === null) throw new Error('Missing fog draw data');
  const seat: unknown = Reflect.get(data, 'seat');
  const slotId: unknown = Reflect.get(data, 'slotId');
  if (typeof seat !== 'number' || typeof slotId !== 'string')
    throw new Error('Malformed fog draw data');
  // The turn-flow hook below builds this data.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { seat: seat as Seat, slotId };
}

const drawFogPhase: PhaseHandler = {
  pending: (state, frame) => {
    const data = fogData(frame);
    return [
      {
        kind: 'random',
        request: {
          type: 'draw',
          deck: 'fog',
          public: true,
          seat: data.seat,
          slotId: data.slotId,
          remaining: state.decks.fog?.remaining ?? 0,
          edge: 'north',
        },
        systemType: FOG_SYSTEM_TYPE,
      },
    ];
  },
};

const fogRevealed: SystemInputHandler = {
  keys: { allowed: ['deck', 'seat', 'slotId', 'remaining', 'edge', 'card'] },
  validate: (state, input) => {
    const data = fogData(state.turn.phase.at(-1));
    if (
      input.deck !== 'fog' ||
      input.seat !== data.seat ||
      input.slotId !== data.slotId ||
      input.edge !== 'north' ||
      typeof input.card !== 'string' ||
      !Object.hasOwn(FOG_CARDS, input.card)
    )
      return failure('fog-mismatch', 'Reveal does not match the pending fog draw');
    return success(undefined);
  },
  apply: (state, input, ctx) => {
    const data = fogData(state.turn.phase.at(-1));
    const fog = state.decks.fog;
    if (!fog || fog.remaining < 1) throw new Error('Validated fog deck is empty');
    const revealed = state.ext[SYNTHETIC_DECKS_ID];
    const previous: unknown =
      typeof revealed === 'object' && revealed !== null ? Reflect.get(revealed, 'revealed') : [];
    const tiles = Array.isArray(previous) ? previous : [];
    const next: GameState = {
      ...state,
      decks: {
        ...state.decks,
        fog: {
          remaining: fog.remaining - 1,
          drawn: [...fog.drawn, { slotId: data.slotId, seat: data.seat }],
        },
      },
      ext: { ...state.ext, [SYNTHETIC_DECKS_ID]: { revealed: [...tiles, input.card] } },
    };
    const left = finishTurnFlowFrame(next, ctx);
    return {
      state: left.state,
      events: [{ type: 'fogRevealed', seat: data.seat, card: input.card }, ...left.events],
      effects: [
        {
          type: 'deck-card-shown',
          seat: data.seat,
          deck: 'fog',
          slotId: data.slotId,
          card: String(input.card),
        },
        ...left.effects,
      ],
    };
  },
};

/** Cards revealed by public fog draws so far, in order. */
export function revealedFog(state: GameState): string[] {
  const ext = state.ext[SYNTHETIC_DECKS_ID];
  const value: unknown =
    typeof ext === 'object' && ext !== null ? Reflect.get(ext, 'revealed') : [];
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

export function syntheticDecksModule(): GameModule {
  return {
    id: SYNTHETIC_DECKS_ID,
    version: SYNTHETIC_DECKS_VERSION,
    dependsOn: ['base'],
    conflictsWith: [],
    optionsSchema: [],
    initState: () => ({ revealed: [] }),
    hooks: {
      decks: (_config, acc) => ({
        ...acc,
        fog: { cards: FOG_CARDS, reveal: 'public' },
        loot: { cards: LOOT_CARDS, reveal: 'private' },
      }),
      // After every turn: one public fog reveal, then one private loot deal, then the next turn.
      turnFlow: (state, acc) => {
        const seat = state.turn.activeSeat;
        const fog = state.decks.fog;
        const loot = state.decks.loot;
        return [
          ...acc,
          ...(fog && fog.remaining > 0
            ? [
                {
                  id: 'drawFog',
                  module: SYNTHETIC_DECKS_ID,
                  data: { seat, slotId: `fog:${fog.drawn.length}` },
                },
              ]
            : []),
          ...(loot && loot.remaining > 0
            ? [
                {
                  id: 'drawDev',
                  module: 'base',
                  data: { seat, slotId: `loot:${loot.drawn.length}`, deck: 'loot' },
                },
              ]
            : []),
        ];
      },
    },
    commands: {},
    systemInputs: { [FOG_SYSTEM_TYPE]: fogRevealed },
    phases: { drawFog: drawFogPhase },
  };
}

/** Make the synthetic module selectable by genesis config. Returns the disposer. */
export function registerSyntheticDecks(): () => void {
  return registerAdHocModule(SYNTHETIC_DECKS_ID, SYNTHETIC_DECKS_VERSION, syntheticDecksModule);
}

export function syntheticConfig(seats: readonly Seat[] = [0, 1, 2, 3]): GameConfig {
  return {
    modules: [
      { id: 'base', version: '1.0.0' },
      { id: SYNTHETIC_DECKS_ID, version: SYNTHETIC_DECKS_VERSION },
    ],
    seats: [...seats],
    options: { base: { mapLayout: 'random' } },
  };
}
