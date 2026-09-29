import type { ReactElement } from 'react';
import { createInstance } from 'i18next';
import type { i18n as I18n } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { knightsConfig, knightsEngine } from '@cp2p/engine';
import type { CommandShape, GameState, LegalCommandSet, PrivateState, Seat } from '@cp2p/engine';
import { success } from '@cp2p/engine';
import { vi } from 'vitest';
import type { Mock } from 'vitest';
import common from '../../i18n/locales/en/common.json';
import game from '../../i18n/locales/en/game.json';
import knights from '../../i18n/locales/en/knights.json';
import log from '../../i18n/locales/en/log.json';
import rules from '../../i18n/locales/en/rules.json';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import type { CommandFormProps } from '../dialogs/types';

/** An i18next instance holding every namespace the knights screens read. */
export async function testI18n(): Promise<I18n> {
  const i18n = createInstance();
  await i18n.init({
    lng: 'en',
    defaultNS: 'knights',
    resources: { en: { common, game, knights, log, rules } },
    initImmediate: false,
  });
  return i18n;
}

export const engine = knightsEngine();

/** A fresh three-seat knights game, the same one for every test. */
export const genesis: GameState = engine.createGame(
  knightsConfig({ seats: 3 }),
  new Uint8Array(32).fill(5),
);

export const presentation: GamePresentation = {
  players: [
    { seat: 0, name: 'Ada', color: 'blue', shape: 'circle' },
    { seat: 1, name: 'Bo', color: 'red', shape: 'triangle' },
    { seat: 2, name: 'Cy', color: 'green', shape: 'square' },
  ],
  botDelayMs: 0,
};

/** The state with a knights frame on top of the turn's phase stack. */
export function withFrame(state: GameState, id: string, data: unknown): GameState {
  return {
    ...state,
    turn: { ...state.turn, phase: [...state.turn.phase, { module: 'knights', id, data }] },
  };
}

/** A seat's exact hand, over every card kind of a knights game. */
export function handOf(counts: Record<string, number>): PrivateState {
  return {
    seat: 0,
    hand: {
      brick: 0,
      lumber: 0,
      wool: 0,
      grain: 0,
      ore: 0,
      cloth: 0,
      coin: 0,
      paper: 0,
      ...counts,
    },
    slots: {},
    ext: {},
  };
}

/** Props for a command dialog: the legal commands given, every command valid. */
export function formProps(
  state: GameState,
  legal: LegalCommandSet,
  hand: PrivateState = handOf({}),
  overrides: Partial<CommandFormProps> = {},
): CommandFormProps & { onSubmit: Mock<(command: CommandShape) => void> } {
  return {
    legal,
    privateState: hand,
    state,
    seat: 0,
    playerLabel: (seat: Seat) => presentation.players.find((p) => p.seat === seat)?.name ?? '?',
    validate: () => success(undefined),
    ...overrides,
    onSubmit: vi.fn<(command: CommandShape) => void>(),
  };
}

export function withI18n(i18n: I18n, ui: ReactElement): RenderResult {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}
