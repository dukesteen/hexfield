import { isBotLevel } from '@cp2p/bots';
import type { BotLevel } from '@cp2p/bots';
import { LocalGame, engineForConfig, moduleSelection } from '@cp2p/engine';
import { scenarioById, scenarioConfig } from '@cp2p/maps';
import type { GameConfig, Pending, Seat } from '@cp2p/engine';
import { inlineBotRunner, workerBotRunner } from '../session/bot-runner.js';
import { browserEntropy, createBrowserRandomSource, randomSeed } from '../session/random.js';

/**
 * Diagnostic: four bots of one level play a base game (or `?scenario=<id>`), each decision made in
 * the real bot worker with the given time budget. Reports how long the worker spent per decision kind. Used with CPU
 * throttling as a mid-range phone proxy (docs/verification/stage16).
 */
const button = document.querySelector<HTMLButtonElement>('#run');
const output = document.querySelector<HTMLPreElement>('#result');
if (!button || !output) throw new Error('Missing timing controls');

type PlayerPending = Extract<Pending, { kind: 'player' }>;

function kindOf(pending: PlayerPending): string {
  if (pending.allowed.includes('PLACE_SETTLEMENT')) return 'setup-settlement';
  if (pending.allowed.includes('MOVE_ROBBER')) return 'robber';
  if (pending.allowed.includes('END_TURN')) return 'main';
  return 'other';
}

function stats(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { n: sorted.length, medianMs: at(0.5), p95Ms: at(0.95), maxMs: sorted.at(-1) ?? 0 };
}

async function play(level: BotLevel, budgetMs: number, inline: boolean, scenario: string | null) {
  const chosen = scenario ? scenarioById(scenario) : undefined;
  if (scenario && !chosen) throw new Error(`Unknown scenario ${scenario}`);
  const config: GameConfig = chosen
    ? scenarioConfig(chosen, 4)
    : {
        modules: moduleSelection(['base']),
        seats: [0, 1, 2, 3],
        options: { base: { vpTarget: 10 } },
      };
  const engine = engineForConfig(config);
  const created = LocalGame.create(
    engine,
    config,
    randomSeed(browserEntropy),
    createBrowserRandomSource(),
  );
  if (!created.ok) throw new Error(created.error.message);
  const game = created.value;
  // Inline runs the same host on this thread, where DevTools CPU throttling certainly applies.
  const runner = inline ? inlineBotRunner(engine) : workerBotRunner();
  const seeds = new Map<Seat, Uint8Array>(
    config.seats.map((seat) => [seat, randomSeed(browserEntropy)]),
  );
  const times: Record<string, number[]> = {};
  const wall: number[] = [];
  try {
    for (let step = 0; step < 3000 && !game.state.result; step++) {
      const pending = game
        .getPending()
        .find(
          (item): item is PlayerPending =>
            item.kind === 'player' && item.allowed.some((type) => type !== 'CLAIM_VICTORY'),
        );
      if (!pending) throw new Error('No player pending');
      const priv = game.privateView(pending.seat);
      const seed = seeds.get(pending.seat);
      if (!priv || !seed) throw new Error('Missing seat');
      const started = performance.now();
      // oxlint-disable-next-line no-await-in-loop -- Decisions are sequential by nature.
      const decision = await runner.decide({
        bot: `seat-${pending.seat}`,
        level,
        seed,
        state: game.state,
        priv,
        seat: pending.seat,
        pending,
        hosted: true,
        timeBudgetMs: budgetMs,
      });
      wall.push(performance.now() - started);
      (times[kindOf(pending)] ??= []).push(decision.elapsedMs);
      const next = game.submit({ kind: 'command', seat: pending.seat, command: decision.command });
      if (!next.ok) throw new Error(next.error.message);
    }
  } finally {
    runner.dispose();
  }
  return {
    level,
    budgetMs,
    scenario: scenario ?? 'base',
    runner: inline ? 'inline' : 'worker',
    finished: game.state.result !== null,
    turns: game.state.turn.number,
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    workerMs: Object.fromEntries(
      Object.entries(times).map(([kind, values]) => [kind, stats(values)]),
    ),
    roundTripMs: stats(wall),
  };
}

button.addEventListener('click', () => {
  const params = new URLSearchParams(location.search);
  const level = params.get('level') ?? 'hard';
  const budget = Number(params.get('budget') ?? '150');
  if (!isBotLevel(level) || !Number.isFinite(budget)) {
    output.textContent = 'Bad level or budget';
    return;
  }
  button.disabled = true;
  output.textContent = 'Playing…';
  play(level, budget, params.get('inline') === '1', params.get('scenario'))
    .then((result) => {
      output.textContent = JSON.stringify(result, null, 2);
      output.dataset.done = 'true';
      return undefined;
    })
    .catch((error: unknown) => {
      output.textContent = `Failed: ${String(error)}`;
      output.dataset.done = 'true';
    })
    .finally(() => {
      button.disabled = false;
    });
});
