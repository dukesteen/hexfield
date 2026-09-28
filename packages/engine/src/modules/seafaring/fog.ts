import { isFogTerrain, isTokenlessTerrain } from '../../core/board/index.js';
import type { DeckSpec, PhaseHandler, SystemInputHandler } from '../../core/modules/index.js';
import type { Pending, SystemInput } from '../../core/pipeline/index.js';
import type { EngineEffect } from '../../core/effects/index.js';
import type { GameConfig, GameState, PhaseFrame } from '../../core/state/index.js';
import { RESOURCES, failure, success } from '../../core/types/index.js';
import type { ResourceCounts, Seat } from '../../core/types/index.js';
import { boardGraph, edgeEndpoints, hexesForVertex } from '../base/board/index.js';
import { TERRAIN_RESOURCE, oneResource } from '../base/constants.js';
import { claimCommands } from '../base/legal.js';
import { exchangeBank, popPhase, privateExchange, pushPhase, withClaim } from '../base/shared.js';
import type { FogOption } from './config.js';
import { SEAFARING_ID } from './config.js';
import { goldFrame } from './gold.js';
import type { FogReveal } from './types.js';
import { seafaringExt, updateSeafaring } from './types.js';

/** Hidden public decks: the terrain tiles and the number tokens behind the fog. */
export const FOG_TERRAIN_DECK = 'fog-terrain';
export const FOG_TOKEN_DECK = 'fog-token';
/** The module system input that answers a fog draw. */
export const FOG_REVEALED = 'FOG_REVEALED';

/** The fog option of a raw or normalized config, or null when there is none. */
export function fogOptionOf(config: Pick<GameConfig, 'options'>): FogOption | null {
  const options: unknown = config.options[SEAFARING_ID];
  const fog: unknown =
    typeof options === 'object' && options !== null ? Reflect.get(options, 'fog') : null;
  if (typeof fog !== 'object' || fog === null) return null;
  // Genesis validates the shape against the option schema.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return fog as FogOption;
}

function positive(counts: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0));
}

/** The `decks` hook: two public decks, from the scenario's fog counts. */
export function fogDecks(
  config: GameConfig,
  acc: Readonly<Record<string, DeckSpec>>,
): Record<string, DeckSpec> {
  const fog = fogOptionOf(config);
  return fog
    ? {
        ...acc,
        [FOG_TERRAIN_DECK]: { cards: positive(fog.terrains), reveal: 'public' },
        [FOG_TOKEN_DECK]: { cards: positive(fog.tokens), reveal: 'public' },
      }
    : { ...acc };
}

const TILE_TERRAINS = new Set(['sea', 'desert', 'gold', ...Object.keys(TERRAIN_RESOURCE)]);
const TOKENS = new Set(['2', '3', '4', '5', '6', '8', '9', '10', '11', '12']);

function total(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

/** Genesis check: the stacks cover the fog hexes and the tokens cover the tiles that take one. */
export function fogProblem(fog: FogOption, fogHexes: number): string | null {
  if (Object.keys(fog.terrains).some((terrain) => !TILE_TERRAINS.has(terrain)))
    return 'Unknown fog terrain';
  if (Object.keys(fog.tokens).some((token) => !TOKENS.has(token))) return 'Unknown fog token';
  if (total(fog.terrains) !== fogHexes) return 'Fog tiles must match the fog hexes';
  const takers = total(
    Object.fromEntries(
      Object.entries(fog.terrains).filter(([terrain]) => !isTokenlessTerrain(terrain)),
    ),
  );
  return total(fog.tokens) === takers ? null : 'Fog tokens must match the fog tiles that take one';
}

/** The frame that owns the draws of a placement's fog hexes. Its state is `ext.seafaring.fog`. */
export const FOG_FRAME = 'fogReveal';

function isFogFrame(frame: PhaseFrame): boolean {
  return frame.module === SEAFARING_ID && frame.id === FOG_FRAME;
}

/**
 * The `afterBuild` hook for roads and ships: queue every fog hex touching either end of the edge,
 * in ascending hex id order. Queueing changes no phase, because the placing command is not done
 * with the phase stack yet. The `afterInput` hook opens the frame once it is.
 */
export function queueFogReveals(
  state: GameState,
  seat: Seat,
  type: string,
  edge: string,
): GameState {
  const ext = seafaringExt(state);
  if ((type !== 'road' && type !== 'ship') || ext.fog === undefined) return state;
  const ends = edgeEndpoints(boardGraph(state), edge);
  if (!ends) return state;
  const queued = new Set(ext.fog?.hexes ?? []);
  const fogHexes = new Set(
    state.board.hexes.filter((hex) => isFogTerrain(hex.terrain)).map((hex) => hex.id),
  );
  const found = [...new Set(ends.flatMap((vertex) => hexesForVertex(state, vertex)))].filter(
    (hex) => fogHexes.has(hex) && !queued.has(hex),
  );
  if (found.length === 0) return state;
  const reveal: FogReveal = {
    seat: ext.fog?.seat ?? seat,
    hexes: [...(ext.fog?.hexes ?? []), ...found.toSorted()],
    terrain: ext.fog?.terrain ?? null,
  };
  return updateSeafaring(state, (old) => ({ ...old, fog: reveal }));
}

function pendingDraw(state: GameState, reveal: FogReveal): Pending {
  const deck = reveal.terrain === null ? FOG_TERRAIN_DECK : FOG_TOKEN_DECK;
  const stack = state.decks[deck];
  if (!stack) throw new Error('Fog deck is missing');
  return {
    kind: 'random',
    request: {
      type: 'draw',
      deck,
      public: true,
      seat: reveal.seat,
      slotId: `${deck}:${stack.drawn.length}`,
      remaining: stack.remaining,
      hex: reveal.hexes[0] ?? '',
    },
    systemType: FOG_REVEALED,
  };
}

/**
 * The `afterInput` hook: open the fog frame above whatever phase the placement left, when hexes
 * are queued. The interrupted phase, setup step or Road Building card resumes when it closes.
 */
export function openFogReveal(state: GameState): GameState {
  const reveal = seafaringExt(state).fog;
  if (!reveal || reveal.hexes.length === 0 || state.turn.phase.some(isFogFrame)) return state;
  return pushPhase(state, { id: FOG_FRAME, module: SEAFARING_ID, data: null });
}

function frameOpen(state: GameState): boolean {
  const top = state.turn.phase.at(-1);
  return top !== undefined && isFogFrame(top);
}

export const fogRevealPhase: PhaseHandler = {
  pending: (state) => {
    const reveal = seafaringExt(state).fog;
    if (!reveal || reveal.hexes.length === 0) throw new Error('Fog frame without a reveal');
    return withClaim(state, [pendingDraw(state, reveal)]);
  },
  legalCommands: (state, _frame, seat, priv, ctx) => claimCommands(state, seat, priv, ctx),
};

/** What a finished reveal pays: a resource card, a gold choice, or nothing. */
type Reward = { kind: 'cards'; counts: ResourceCounts } | { kind: 'gold' } | { kind: 'none' };

function reward(state: GameState, terrain: string): Reward {
  if (terrain === 'gold')
    return RESOURCES.some((kind) => (state.bank[kind] ?? 0) > 0)
      ? { kind: 'gold' }
      : { kind: 'none' };
  const resource = TERRAIN_RESOURCE[terrain];
  return resource && (state.bank[resource] ?? 0) > 0
    ? { kind: 'cards', counts: oneResource(resource, 1) }
    : { kind: 'none' };
}

function activeReveal(state: GameState): FogReveal {
  const reveal = seafaringExt(state).fog;
  if (!reveal || reveal.hexes.length === 0) throw new Error('No fog reveal is pending');
  return reveal;
}

function cardIn(counts: Readonly<Record<string, number>>, card: unknown): card is string {
  return typeof card === 'string' && Object.hasOwn(counts, card) && (counts[card] ?? 0) > 0;
}

/** The terrain of the hex this draw completes, or null when the draw only stores the terrain. */
function completedTerrain(state: GameState, input: SystemInput): string | null {
  const reveal = activeReveal(state);
  if (input.deck === FOG_TOKEN_DECK) return reveal.terrain;
  return typeof input.card === 'string' && isTokenlessTerrain(input.card) ? input.card : null;
}

export const fogRevealed: SystemInputHandler = {
  keys: { allowed: ['deck', 'seat', 'slotId', 'remaining', 'hex', 'card'] },
  validate: (state, input) => {
    const reveal = seafaringExt(state).fog;
    if (!reveal || !frameOpen(state)) return failure('no-fog-draw', 'No fog draw is pending');
    const expected = pendingDraw(state, reveal);
    if (expected.kind !== 'random') throw new Error('Fog draw is not random');
    const request = expected.request;
    if (
      input.deck !== request.deck ||
      input.seat !== request.seat ||
      input.slotId !== request.slotId ||
      input.remaining !== request.remaining ||
      input.hex !== request.hex
    )
      return failure('fog-mismatch', 'Reveal does not match the pending fog draw');
    const fog = fogOptionOf(state.config);
    const cards = input.deck === FOG_TERRAIN_DECK ? fog?.terrains : fog?.tokens;
    return cards && cardIn(cards, input.card)
      ? success(undefined)
      : failure('fog-card', 'Unknown card for this fog deck');
  },
  apply: (state, input) => {
    const reveal = activeReveal(state);
    const deck = input.deck === FOG_TOKEN_DECK ? FOG_TOKEN_DECK : FOG_TERRAIN_DECK;
    const stack = state.decks[deck];
    const card = String(input.card);
    const slotId = String(input.slotId);
    const hex = reveal.hexes[0];
    if (!stack || stack.remaining < 1 || hex === undefined)
      throw new Error('Validated fog draw missing');
    let next: GameState = {
      ...state,
      decks: {
        ...state.decks,
        [deck]: {
          remaining: stack.remaining - 1,
          drawn: [...stack.drawn, { slotId, seat: reveal.seat }],
        },
      },
    };
    const shown = { type: 'deck-card-shown' as const, seat: reveal.seat, deck, slotId, card };
    const terrain = completedTerrain(state, input);
    if (terrain === null) {
      // The tile takes a token: the hex stays hidden until the token is drawn as well.
      next = updateSeafaring(next, (old) => ({ ...old, fog: { ...reveal, terrain: card } }));
      return { state: next, events: [], effects: [shown] };
    }
    const token = deck === FOG_TOKEN_DECK ? Number(card) : null;
    const rest = reveal.hexes.slice(1);
    next = {
      ...next,
      board: {
        ...next.board,
        hexes: next.board.hexes.map((item) =>
          item.id === hex ? { ...item, terrain, token } : item,
        ),
      },
    };
    next = updateSeafaring(next, (old) => ({
      ...old,
      fog: rest.length ? { seat: reveal.seat, hexes: rest, terrain: null } : null,
    }));
    // The last hex closes the frame, so a gold choice sits directly above the interrupted phase.
    if (rest.length === 0) next = popPhase(next);
    const paid = reward(next, terrain);
    const effects: EngineEffect[] = [shown];
    if (paid.kind === 'cards') {
      const exchanged = exchangeBank(next, reveal.seat, paid.counts, true);
      next = exchanged.state;
      effects.push(...exchanged.effects);
    } else if (paid.kind === 'gold') {
      next = pushPhase(next, goldFrame([{ seat: reveal.seat, claim: 1 }]));
    }
    return {
      state: next,
      events: [{ type: 'fogRevealed', seat: reveal.seat, hex, terrain, token }],
      effects,
    };
  },
  applyPrivate: (priv, before, input) => {
    const reveal = seafaringExt(before).fog;
    if (!reveal || priv.seat !== reveal.seat) return success(priv);
    const terrain = completedTerrain(before, input);
    const paid = terrain === null ? null : reward(before, terrain);
    return paid?.kind === 'cards' ? privateExchange(priv, paid.counts, true) : success(priv);
  },
};
