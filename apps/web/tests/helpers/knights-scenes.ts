/* eslint-disable no-await-in-loop -- Each scene step depends on the game the last one left. */
import type { Page } from '@playwright/test';
import type { CommandShape, GameState, KnightPiece, PrivateState, Seat } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import type { VertexId } from '@cp2p/engine/geometry';
import { deckOfTrack, knightsExt, trackOfCard } from '@cp2p/engine';
import { SEAT } from './knights-play.js';

/**
 * Hand-built positions for the Cities and Knights UI: read the game out of the page, change it
 * here as plain data, and put it back through the development-only `devReplace` of the local
 * session. Scenes then run real commands (`devApply`) so every dialog is reached by the engine.
 */
export interface Snapshot {
  state: GameState;
  privates: Record<string, PrivateState>;
}

type Counts = Record<string, number>;

export function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const session = window['__cp2p']?.session;
    if (!session) throw new Error('No dev hook');
    const state = structuredClone(session.getState());
    const privates: Record<string, PrivateState> = {};
    for (const seat of state.config.seats) {
      const value = session.getPrivate(seat);
      if (value) privates[String(seat)] = structuredClone(value);
    }
    return { state, privates };
  });
}

export async function replace(page: Page, snap: Snapshot): Promise<void> {
  const outcome = await page.evaluate((next) => {
    const session = window['__cp2p']?.session;
    if (!session || !('devReplace' in session) || typeof session.devReplace !== 'function')
      return 'This session cannot be replaced';
    const done: { ok: boolean; error?: { message: string } } = Reflect.apply(
      session.devReplace,
      session,
      [next.state, next.privates],
    );
    return done.ok ? 'ok' : (done.error?.message ?? 'failed');
  }, snap);
  if (outcome !== 'ok') throw new Error(outcome);
}

function isVertexId(value: string): value is VertexId {
  return /^v:-?\d+,-?\d+,(N|S)$/.test(value);
}

/** Where a vertex is on screen right now, relative to the board canvas; null when it is not drawn. */
export async function vertexPoint(
  page: Page,
  vertex: string,
): Promise<{ x: number; y: number } | null> {
  if (!isVertexId(vertex)) throw new Error(`Not a vertex id: ${vertex}`);
  return page.evaluate(
    (id) => window['__cp2p']?.pixelPosition({ kind: 'vertex', id }) ?? null,
    vertex,
  );
}

/** Run a command as any seat (a bot's too) through the engine. Returns "ok" or the rejection. */
export function apply(page: Page, seat: Seat, command: CommandShape): Promise<string> {
  return page.evaluate(
    ({ who, what }) => {
      const session = window['__cp2p']?.session;
      if (!session || !('devApply' in session) || typeof session.devApply !== 'function')
        return 'No devApply';
      const done: { ok: boolean; error?: { code: string; message: string } } = Reflect.apply(
        session.devApply,
        session,
        [who, what],
      );
      return done.ok ? 'ok' : `${done.error?.code}: ${done.error?.message}`;
    },
    { who: seat, what: command },
  );
}

/** Every command a seat could play right now, bots included. */
export function legalOf(page: Page, seat: Seat): Promise<CommandShape[]> {
  return page.evaluate((who) => {
    const session = window['__cp2p']?.session;
    if (!session || !('devLegal' in session) || typeof session.devLegal !== 'function') return [];
    const set: { commands: CommandShape[] } = Reflect.apply(session.devLegal, session, [who]);
    return structuredClone(set.commands);
  }, seat);
}

function seatOf(state: GameState, seat: Seat) {
  const found = state.seats.find((item) => item.seat === seat);
  if (!found) throw new Error(`No seat ${seat}`);
  return found;
}

/**
 * Roads for a seat along a path of empty vertices that starts at one of its own buildings, so a
 * knight has somewhere to walk. Returns the vertices of the path, the building first.
 */
export function withRoadPath(
  snap: Snapshot,
  seat: Seat,
  length: number,
): { snap: Snapshot; path: string[] } {
  const graph = buildBoardGraph(snap.state.board.hexes);
  const taken = new Set(snap.state.board.buildings.map((item) => item.vertex));
  const roaded = new Set(snap.state.board.roads.map((item) => item.edge));
  const edgeBetween = (a: string, b: string): string | undefined =>
    graph.edgeIds.find((edge) => {
      const ends = graph.edgeVertices[graph.edgeIndex[edge] ?? -1];
      const joins = (vertex: string) => ends !== undefined && ends.some((end) => end === vertex);
      return joins(a) && joins(b) && !roaded.has(edge);
    });
  const extend = (path: string[]): string[] | null => {
    if (path.length === length + 1) return path;
    const last = path.at(-1) ?? '';
    for (const next of graph.vertexNeighbors[graph.vertexIndex[last] ?? -1] ?? []) {
      if (taken.has(next) || path.includes(next) || edgeBetween(last, next) === undefined) continue;
      const done = extend([...path, next]);
      if (done) return done;
    }
    return null;
  };
  for (const start of snap.state.board.buildings.filter((item) => item.seat === seat)) {
    const path = extend([start.vertex]);
    if (!path) continue;
    const edges = path.flatMap((vertex, index) => {
      const next = path[index + 1];
      const edge = next === undefined ? undefined : edgeBetween(vertex, next);
      return edge === undefined ? [] : [edge];
    });
    return {
      path,
      snap: {
        ...snap,
        state: {
          ...snap.state,
          board: {
            ...snap.state.board,
            roads: [...snap.state.board.roads, ...edges.map((edge) => ({ edge, seat }))],
          },
          seats: snap.state.seats.map((item) =>
            item.seat === seat
              ? {
                  ...item,
                  piecesLeft: {
                    ...item.piecesLeft,
                    road: (item.piecesLeft['road'] ?? 0) - edges.length,
                  },
                }
              : item,
          ),
        },
      },
    };
  }
  throw new Error(`Seat ${seat} has no room for a road of ${length}`);
}

/** A hand as the public bounds keep it: the five resources named, the commodities riding along. */
function exact(hand: Counts) {
  return {
    ...hand,
    brick: hand['brick'] ?? 0,
    lumber: hand['lumber'] ?? 0,
    wool: hand['wool'] ?? 0,
    grain: hand['grain'] ?? 0,
    ore: hand['ore'] ?? 0,
  };
}

/** Give a seat an exact hand; the bank takes or pays the difference. */
export function withHand(snap: Snapshot, seat: Seat, counts: Counts): Snapshot {
  const seatState = seatOf(snap.state, seat);
  const before: Counts = { ...seatState.resources.min };
  const kinds = Object.keys(snap.state.bank);
  const hand: Counts = Object.fromEntries(kinds.map((kind) => [kind, counts[kind] ?? 0]));
  const total = Object.values(hand).reduce((a, b) => a + b, 0);
  const bank = { ...snap.state.bank };
  for (const kind of kinds)
    bank[kind] = (bank[kind] ?? 0) + (before[kind] ?? 0) - (hand[kind] ?? 0);
  const held = snap.privates[String(seat)];
  if (!held) throw new Error(`No private state for ${seat}`);
  return {
    state: {
      ...snap.state,
      bank,
      seats: snap.state.seats.map((item) =>
        item.seat === seat
          ? { ...item, resources: { total, min: exact(hand), max: exact(hand) } }
          : item,
      ),
    },
    privates: { ...snap.privates, [String(seat)]: { ...held, hand } },
  };
}

/** Add buildings without paying. `city` replaces a settlement of that seat on the vertex. */
export function withBuildings(
  snap: Snapshot,
  pieces: readonly { vertex: string; seat: Seat; kind: 'settlement' | 'city' }[],
): Snapshot {
  let buildings = [...snap.state.board.buildings];
  const seats = snap.state.seats.map((item) => ({
    ...item,
    piecesLeft: { ...item.piecesLeft },
  }));
  for (const piece of pieces) {
    const owner = seats.find((item) => item.seat === piece.seat);
    if (!owner) throw new Error(`No seat ${piece.seat}`);
    const existing = buildings.find((item) => item.vertex === piece.vertex);
    if (existing) {
      if (existing.kind === piece.kind) continue;
      buildings = buildings.filter((item) => item.vertex !== piece.vertex);
      owner.piecesLeft['settlement'] = (owner.piecesLeft['settlement'] ?? 0) + 1;
    }
    buildings.push({ vertex: piece.vertex, seat: piece.seat, kind: piece.kind });
    const slot = piece.kind === 'city' ? 'city' : 'settlement';
    owner.piecesLeft[slot] = (owner.piecesLeft[slot] ?? 0) - 1;
  }
  return { ...snap, state: { ...snap.state, board: { ...snap.state.board, buildings }, seats } };
}

function withKnightsExt(
  snap: Snapshot,
  change: (old: ReturnType<typeof knightsExt>) => ReturnType<typeof knightsExt>,
): Snapshot {
  const old = knightsExt(snap.state);
  const key = Object.keys(snap.state.ext).find((id) => snap.state.ext[id] === old);
  if (!key) throw new Error('No knights state');
  return {
    ...snap,
    state: { ...snap.state, ext: { ...snap.state.ext, [key]: change(old) } },
  };
}

/** Set a seat's improvement levels. */
export function withLevels(snap: Snapshot, seat: Seat, levels: Counts): Snapshot {
  return withKnightsExt(snap, (old) => ({
    ...old,
    improvements: old.improvements.map((item, index) =>
      index === seat ? { ...item, ...levels } : item,
    ),
  }));
}

/** Put knights on the board. */
export function withKnights(
  snap: Snapshot,
  pieces: readonly (Partial<KnightPiece> & { seat: Seat; vertex: string })[],
): Snapshot {
  return withKnightsExt(snap, (old) => ({
    ...old,
    knights: [
      ...old.knights,
      ...pieces.map((piece) => ({
        level: 1,
        active: false,
        ready: false,
        promotedTurn: null,
        ...piece,
      })),
    ].toSorted((a, b) => (a.vertex < b.vertex ? -1 : 1)),
  }));
}

export function withWalls(
  snap: Snapshot,
  walls: readonly { seat: Seat; vertex: string }[],
): Snapshot {
  return withKnightsExt(snap, (old) => ({ ...old, walls: [...old.walls, ...walls] }));
}

export function withMetropolis(
  snap: Snapshot,
  track: 'trade' | 'politics' | 'science',
  seat: Seat,
  vertex: string,
): Snapshot {
  return withKnightsExt(snap, (old) => ({
    ...old,
    metropolises: { ...old.metropolises, [track]: { seat, vertex } },
  }));
}

export function withMerchant(snap: Snapshot, seat: Seat, hex: string): Snapshot {
  return withKnightsExt(snap, (old) => ({ ...old, merchant: { seat, hex } }));
}

/** Unlock the robber and other first-attack rules, as after the barbarians have landed. */
export function withRobberFree(snap: Snapshot): Snapshot {
  return withKnightsExt(snap, (old) => ({ ...old, robberLocked: false }));
}

/** A progress card in a seat's hand, its identity public so no private state is needed. */
export function withProgress(snap: Snapshot, seat: Seat, card: string): Snapshot {
  const track = trackOfCard(card);
  if (track === null) throw new Error(`Unknown progress card ${card}`);
  const deck = deckOfTrack(track);
  const slotId = `progress:${snap.state.counters.nextSlotId}`;
  const before = snap.state.decks[deck];
  if (!before) throw new Error(`No deck ${deck}`);
  return {
    ...snap,
    state: {
      ...snap.state,
      counters: { ...snap.state.counters, nextSlotId: snap.state.counters.nextSlotId + 1 },
      decks: {
        ...snap.state.decks,
        [deck]: { remaining: before.remaining - 1, drawn: [...before.drawn, { slotId, seat }] },
      },
      seats: snap.state.seats.map((item) =>
        item.seat === seat
          ? {
              ...item,
              cardSlots: [
                ...item.cardSlots,
                { slotId, deck, acquiredTurn: snap.state.turn.number, known: card },
              ],
            }
          : item,
      ),
    },
  };
}

/** A settlement lying as a sideways city piece. */
export function withSideways(snap: Snapshot, seat: Seat, vertex: string): Snapshot {
  const marked = withKnightsExt(snap, (old) => ({
    ...old,
    sideways: [...old.sideways, { seat, vertex }],
  }));
  return {
    ...marked,
    state: {
      ...marked.state,
      seats: marked.state.seats.map((item) =>
        item.seat === seat
          ? {
              ...item,
              piecesLeft: { ...item.piecesLeft, sideways: (item.piecesLeft['sideways'] ?? 0) + 1 },
            }
          : item,
      ),
    },
  };
}

/** Put a frame of a module on top of the turn's phase stack. */
export function withFrame(snap: Snapshot, module: string, id: string, data: unknown): Snapshot {
  return {
    ...snap,
    state: {
      ...snap.state,
      turn: { ...snap.state.turn, phase: [...snap.state.turn.phase, { module, id, data }] },
    },
  };
}

/** How many ship faces the barbarians have sailed. */
export function withBarbarians(snap: Snapshot, step: number): Snapshot {
  return withKnightsExt(snap, (old) => ({ ...old, barbarians: { step } }));
}

/** A seat's public victory points, for the cards that compare them. */
export function withVp(snap: Snapshot, seat: Seat, publicVp: number): Snapshot {
  return {
    ...snap,
    state: {
      ...snap.state,
      seats: snap.state.seats.map((item) => (item.seat === seat ? { ...item, publicVp } : item)),
    },
  };
}

/** Jump to a seat's dice phase, ready to roll. */
export function inPreRoll(snap: Snapshot, active: Seat = SEAT, turn = 12): Snapshot {
  return {
    ...snap,
    state: {
      ...snap.state,
      turn: {
        number: turn,
        activeSeat: active,
        phase: [{ module: 'base', id: 'preRoll', data: null }],
      },
    },
  };
}

/** Jump to a seat's main phase mid-game. */
export function inMain(snap: Snapshot, active: Seat = SEAT, turn = 12): Snapshot {
  return {
    ...snap,
    state: {
      ...snap.state,
      turn: {
        number: turn,
        activeSeat: active,
        phase: [{ module: 'base', id: 'main', data: null }],
      },
    },
  };
}
