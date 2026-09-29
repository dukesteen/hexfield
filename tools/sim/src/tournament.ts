import type { BotLevel } from '@cp2p/bots';
import type { GameConfig, Seat } from '@cp2p/engine';
import { runGame, SimulationFailure } from './run-game.js';

export interface TournamentOptions {
  /** The bot level at each seat before rotation; its length is the player count. */
  bots: readonly BotLevel[];
  games: number;
  seed: number;
  /** Shift the seating by one seat every game, so each level plays every seat equally often. */
  rotation: boolean;
  /** Search iterations per Hard decision (reproducible); see `DecideContext.iterationBudget`. */
  iterationBudget?: number;
  /** Scenario or module config replacing the base game for `bots.length` players. */
  config?: GameConfig;
  maxTurns?: number;
  /** Keep the per-input invariant checks on (slower). */
  verify?: boolean;
  startIndex?: number;
  stride?: number;
}

export interface TournamentGame {
  gameIndex: number;
  /** Level at each seat, in seat order. */
  seating: BotLevel[];
  winner: Seat | null;
  turns: number;
  vp: number[];
  failure?: string;
  /** Distinct fallback warnings raised in this game, with counts. */
  warnings: Record<string, number>;
}

/** The seating for one game: the listed levels shifted by the game index when rotating. */
export function seatingFor(
  bots: readonly BotLevel[],
  gameIndex: number,
  rotation: boolean,
): BotLevel[] {
  if (!rotation) return [...bots];
  const shift = gameIndex % bots.length;
  return bots.map((_, seat) => bots[(seat - shift + bots.length) % bots.length] ?? 'random');
}

/** Play a strided part of a tournament; every game's seed depends only on its index. */
export function playTournamentGames(options: TournamentOptions): TournamentGame[] {
  const games: TournamentGame[] = [];
  const stride = options.stride ?? 1;
  for (let gameIndex = options.startIndex ?? 0; gameIndex < options.games; gameIndex += stride) {
    const seating = seatingFor(options.bots, gameIndex, options.rotation);
    const warnings: Record<string, number> = {};
    try {
      const result = runGame({
        seed: options.seed,
        gameIndex,
        players: seating.length,
        bots: seating,
        verify: options.verify !== false,
        onBotWarning: (seat, message) => {
          const key = `${seating[seat] ?? '?'}: ${message}`;
          warnings[key] = (warnings[key] ?? 0) + 1;
        },
        ...(options.config ? { config: options.config } : {}),
        ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
        ...(options.iterationBudget === undefined
          ? {}
          : { iterationBudget: options.iterationBudget }),
      });
      games.push({
        gameIndex,
        seating,
        winner: result.stats.winner,
        turns: result.stats.turns,
        vp: result.stats.vp,
        warnings,
      });
    } catch (error) {
      if (!(error instanceof SimulationFailure)) throw error;
      games.push({
        gameIndex,
        seating,
        winner: null,
        turns: 0,
        vp: [],
        failure: `${error.category}: ${error.message}`,
        warnings,
      });
    }
  }
  return games;
}

export interface LevelResult {
  level: BotLevel;
  /** Seats this level filled, over all games. */
  seats: number;
  /** Games this level took part in. */
  games: number;
  wins: number;
  /** Wins per game played: the share of the table's wins this level took. */
  winShare: number;
  /** Wins per seat filled: comparable to 1/players for an even field. */
  winRatePerSeat: number;
  averageVp: number;
  /** Bradley–Terry strength on the Elo scale, random at 1000 when present. */
  elo: number;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Fit Bradley–Terry strengths by minorisation–maximisation: each finished game counts as its
 * winner's level beating every other seat's level (seats of the winner's own level are skipped).
 */
export function fitElo(
  games: readonly TournamentGame[],
  levels: readonly BotLevel[],
): Record<string, number> {
  const wins = new Map<string, number>();
  const pairs = new Map<string, number>();
  for (const game of games) {
    if (game.winner === null) continue;
    const winner = game.seating[game.winner];
    if (!winner) continue;
    for (const [seat, level] of game.seating.entries()) {
      if (seat === game.winner || level === winner) continue;
      wins.set(winner, (wins.get(winner) ?? 0) + 1);
      pairs.set(pairKey(winner, level), (pairs.get(pairKey(winner, level)) ?? 0) + 1);
    }
  }
  const strength = new Map(levels.map((level) => [level, 1]));
  for (let iteration = 0; iteration < 500; iteration++) {
    for (const level of levels) {
      let denominator = 0;
      for (const other of levels) {
        if (other === level) continue;
        const played = pairs.get(pairKey(level, other)) ?? 0;
        if (played)
          denominator += played / ((strength.get(level) ?? 1) + (strength.get(other) ?? 1));
      }
      // A level that never won keeps a small positive strength instead of collapsing to zero.
      const won = Math.max(wins.get(level) ?? 0, 0.5);
      if (denominator > 0) strength.set(level, won / denominator);
    }
    const anchor =
      strength.get(levels.includes('random') ? 'random' : (levels[0] ?? 'random')) ?? 1;
    for (const level of levels) strength.set(level, (strength.get(level) ?? 1) / anchor);
  }
  return Object.fromEntries(
    levels.map((level) => [level, Math.round(1000 + 400 * Math.log10(strength.get(level) ?? 1))]),
  );
}

export function summarizeTournament(games: readonly TournamentGame[], bots: readonly BotLevel[]) {
  const levels = [...new Set(bots)];
  const finished = games.filter((game) => game.winner !== null);
  const elo = fitElo(finished, levels);
  const results: LevelResult[] = levels.map((level) => {
    let seats = 0;
    let played = 0;
    let wins = 0;
    let vp = 0;
    for (const game of finished) {
      const mine = game.seating.flatMap((item, seat) => (item === level ? [seat] : []));
      if (!mine.length) continue;
      played++;
      seats += mine.length;
      for (const seat of mine) vp += game.vp[seat] ?? 0;
      if (game.winner !== null && game.seating[game.winner] === level) wins++;
    }
    return {
      level,
      seats,
      games: played,
      wins,
      winShare: played ? wins / played : 0,
      winRatePerSeat: seats ? wins / seats : 0,
      averageVp: seats ? vp / seats : 0,
      elo: elo[level] ?? 1000,
    };
  });
  const warnings: Record<string, number> = {};
  for (const game of games)
    for (const [message, count] of Object.entries(game.warnings))
      warnings[message] = (warnings[message] ?? 0) + count;
  return {
    games: games.length,
    finishedGames: finished.length,
    failedGames: games.length - finished.length,
    averageTurns: finished.length
      ? finished.reduce((sum, game) => sum + game.turns, 0) / finished.length
      : null,
    results,
    fallbackWarnings: warnings,
    failures: games
      .filter((game) => game.failure)
      .map((game) => ({ gameIndex: game.gameIndex, failure: game.failure })),
  };
}
