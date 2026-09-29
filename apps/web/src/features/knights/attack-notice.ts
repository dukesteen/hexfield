import type { TFunction } from 'i18next';
import { KNIGHTS_ID } from '@cp2p/engine';
import type { AttackReport, GameState, Seat } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import { knightsState } from './state';

/**
 * One line of an attack's announcement; `you` marks a line about the viewer, `minor` one that
 * only shows under the details.
 */
export interface AttackLine {
  readonly text: string;
  readonly you?: boolean;
  readonly minor?: boolean;
}

/** What the announcement of the last barbarian attack says, for one viewer. */
export interface AttackNotice {
  /** Identifies the attack, so a dismissed one stays dismissed. */
  readonly key: string;
  readonly outcome: AttackReport['outcome'];
  readonly strength: number;
  readonly defense: number;
  readonly headline: string;
  readonly lines: readonly AttackLine[];
  /** Each seat's active knight levels, in seat order. */
  readonly contributions: readonly { seat: Seat; name: string; level: number }[];
  /** The cities lost so far, to point at on the board. */
  readonly lost: readonly { seat: Seat; vertex: string }[];
}

/** The attack's identity: at most one attack happens per turn. */
export function attackKey(attack: AttackReport): string {
  return `attack:${attack.turn}`;
}

/** The land tiles around a vertex, such as "fields 6, mountains 8". */
export function placeOf(state: Readonly<GameState>, vertex: string, t: TFunction): string {
  const graph = buildBoardGraph(state.board.hexes);
  const index = graph.vertexIndex[vertex];
  const ids: readonly string[] = index === undefined ? [] : (graph.vertexHexes[index] ?? []);
  return ids
    .flatMap((id) => {
      const hex = state.board.hexes.find((candidate) => candidate.id === id);
      return hex && hex.terrain !== 'sea' && hex.terrain !== 'fog' ? [hex] : [];
    })
    .map((hex) =>
      hex.token === null
        ? t(`game:terrain.${hex.terrain}`)
        : t('game:tileWithToken', { terrain: t(`game:terrain.${hex.terrain}`), token: hex.token }),
    )
    .join(', ');
}

/** Seats still choosing which city to lose, while the pillage choice holds the roll back. */
export function choosingSeats(state: Readonly<GameState>): Seat[] {
  const frame = state.turn.phase.at(-1);
  if (frame?.module !== KNIGHTS_ID || frame.id !== 'pillage') return [];
  const data: unknown = frame.data;
  const remaining =
    typeof data === 'object' && data !== null ? Reflect.get(data, 'remaining') : undefined;
  return Array.isArray(remaining)
    ? state.config.seats.filter((seat) => remaining.includes(seat))
    : [];
}

/** Cities a seat could still lose: its cities without a metropolis. */
function citiesAtRisk(state: Readonly<GameState>, seat: Seat): number {
  const ext = knightsState(state);
  const metropolises = new Set(
    Object.values(ext?.metropolises ?? {}).flatMap((holder) => (holder ? [holder.vertex] : [])),
  );
  return state.board.buildings.filter(
    (piece) => piece.seat === seat && piece.kind === 'city' && !metropolises.has(piece.vertex),
  ).length;
}

/**
 * The announcement of the last barbarian attack as `viewer` should read it: the two sides, who
 * held or who lost which city, and a line for the viewer's own part. Null before any attack.
 */
export function attackNotice(
  state: Readonly<GameState>,
  viewer: Seat | null,
  name: (seat: Seat) => string,
  t: TFunction,
  robberFreed = false,
): AttackNotice | null {
  const attack = knightsState(state)?.lastAttack;
  if (!attack) return null;
  const { strength, defense } = attack;
  const level = (seat: Seat) => attack.contributions[seat] ?? 0;
  const lines: AttackLine[] = [];
  const list = (seats: readonly Seat[]) => seats.map(name).join(', ');
  if (attack.outcome === 'defended') {
    if (attack.defender !== null)
      lines.push(
        attack.defender === viewer
          ? { text: t('knights:attack.defenderYou'), you: true }
          : { text: t('knights:attack.defender', { player: name(attack.defender) }) },
      );
    else if (attack.tied.length > 1) {
      lines.push({ text: t('knights:attack.tied', { players: list(attack.tied) }) });
      if (viewer !== null && attack.tied.includes(viewer))
        lines.push({ text: t('knights:attack.tiedYou'), you: true });
    } else lines.push({ text: t('knights:attack.noLeader'), minor: true });
  } else {
    const choosing = choosingSeats(state);
    const losers = new Set([...attack.pillaged.map((piece) => piece.seat), ...choosing]);
    const lowest = losers.size > 0 ? Math.min(...[...losers].map(level)) : 0;
    for (const piece of attack.pillaged) {
      const place = placeOf(state, piece.vertex, t);
      if (piece.seat !== viewer) {
        lines.push({ text: t('knights:attack.lost', { player: name(piece.seat), place }) });
        continue;
      }
      lines.push({
        text: t('knights:attack.lostYou', { place, mine: level(viewer), strength, defense }),
        you: true,
      });
      // With no city left to lose, the city that fell was the only one: it went without asking.
      if (citiesAtRisk(state, viewer) === 0)
        lines.push({ text: t('knights:attack.onlyCity'), you: true });
    }
    for (const seat of choosing)
      lines.push(
        seat === viewer
          ? { text: t('knights:attack.choosingYou', { mine: level(seat) }), you: true }
          : { text: t('knights:attack.choosing', { player: name(seat) }) },
      );
    if (losers.size === 0) lines.push({ text: t('knights:attack.nothingToLose') });
    else if (viewer === null || !losers.has(viewer))
      lines.push({ text: t('knights:attack.lowest', { count: lowest }), minor: true });
  }
  lines.push({ text: t('knights:attack.knightsRest'), minor: true });
  if (robberFreed) lines.push({ text: t('knights:attack.robberFreed') });
  return {
    key: attackKey(attack),
    outcome: attack.outcome,
    strength,
    defense,
    headline: attack.outcome === 'defended' ? t('knights:attack.held') : t('knights:attack.fell'),
    lines,
    contributions: state.config.seats.map((seat) => ({
      seat,
      name: name(seat),
      level: level(seat),
    })),
    lost: attack.pillaged.map(({ seat, vertex }) => ({ seat, vertex })),
  };
}
