import { RandomBot, createBotRng } from '@cp2p/bots';
import { hashValue, toHex } from '@cp2p/codec';
import type { GameState, Pending, Result, Seat } from '@cp2p/engine';
import { MemoryProtocolJournal, P2PSession, entryHash } from '@cp2p/protocol';
import type { SessionUpdate } from '@cp2p/protocol';
import { SimulationDriver, createMemnet, createSimulationGenesis } from '@cp2p/protocol/testing';
import { deriveSeed } from './random-source.js';

export interface NetworkGameOptions {
  seed: number;
  gameIndex: number;
  scenario: number;
  maxSteps?: number;
}

export interface NetworkGameResult {
  seed: number;
  gameIndex: number;
  scenario: number;
  turns: number;
  inputs: number;
  virtualMilliseconds: number;
  elapsedMilliseconds: number;
  finalStateHash: string;
  finalLogHash: string;
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** Full games through the real peer sessions, signatures, wire encoding and journals. */
export async function runNetworkGame(options: NetworkGameOptions): Promise<NetworkGameResult> {
  if (options.scenario !== 1 && options.scenario !== 2)
    throw new Error('Only clean and delayed/duplicate network scenarios are implemented');
  const started = performance.now();
  const game = createSimulationGenesis({ seed: options.seed, gameIndex: options.gameIndex });
  const keys = [...game.identities.values()];
  const network = createMemnet({
    peers: keys.map((identity) => identity.peerId),
    seed: options.seed + options.gameIndex,
    defaultLink:
      options.scenario === 2
        ? { latencyMs: 50, jitterMs: 350, duplicateProbability: 0.1 }
        : { latencyMs: 1 },
  });
  const sessions = new Map<Seat, P2PSession>();
  const updates = new Map<Seat, SessionUpdate>();
  const bots = new Map(
    game.genesis.config.seats.map((seat) => [
      seat,
      {
        bot: new RandomBot(game.engine),
        rng: createBotRng(deriveSeed(options.seed, options.gameIndex, 'net-bot', seat)),
      },
    ]),
  );
  const failures: string[] = [];
  let submission: { seat: Seat; result: Result<void> | null } | null = null;

  function observe(seat: Seat, update: SessionUpdate): void {
    const prior = updates.get(seat);
    if (prior && update.revision < prior.revision)
      failures.push(`Peer ${seat} rolled back a commit`);
    if (update.status.kind === 'error') failures.push(`Peer ${seat}: ${update.status.message}`);
    updates.set(seat, update);
  }

  async function flush(): Promise<void> {
    await Promise.all([...sessions.values()].map((session) => session.flush()));
  }

  try {
    const opened = await Promise.all(
      game.genesis.config.seats.map(async (seat) => {
        const identity = game.identities.get(seat);
        if (!identity) throw new Error('Missing simulation key');
        const session = unwrap(
          await P2PSession.create({
            genesisEntry: game.entry,
            engine: game.engine,
            policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
            seat,
            secretKey: identity.secretKey,
            transport: network.transport(identity.peerId),
            clock: network.clock,
            journal: new MemoryProtocolJournal(),
            createDriver: (engine, genesis, clock) => new SimulationDriver(engine, genesis, clock),
          }),
        );
        session.subscribe((update) => observe(seat, update));
        return [seat, session] as const;
      }),
    );
    for (const [seat, session] of opened) sessions.set(seat, session);
    const maxSteps = options.maxSteps ?? 1_000_000;
    for (let step = 0; step < maxSteps; step++) {
      // oxlint-disable-next-line no-await-in-loop -- Virtual network delivery and peer queues alternate causally.
      await flush();
      if (failures.length) throw new Error(failures[0]);
      const latest = [...updates.values()].toSorted((a, b) => b.revision - a.revision)[0];
      if (!latest) throw new Error('No peer state available');
      if (
        [...updates.values()].every(
          (update) => update.state.result && update.revision === latest.revision,
        )
      ) {
        const hashes = new Set(
          [...updates.values()].map((update) => toHex(hashValue(update.state))),
        );
        if (hashes.size !== 1) throw new Error('Final public state diverged');
        const histories = [...sessions.values()].map((session) =>
          session.exportSave().entries.map(({ entry }) => entryHash(entry)),
        );
        const first = histories[0];
        if (
          !first ||
          histories.some(
            (history) =>
              history.length !== first.length ||
              history.some((hash, index) => hash !== first[index]),
          )
        )
          throw new Error('Committed log values diverged');
        const finalLogHash = first.at(-1);
        if (!finalLogHash) throw new Error('Completed game has no certified history');
        return {
          ...options,
          turns: latest.state.turn.number,
          inputs: latest.revision,
          virtualMilliseconds: network.clock.now(),
          elapsedMilliseconds: performance.now() - started,
          finalStateHash: toHex(hashValue(latest.state)),
          finalLogHash,
        };
      }
      if (submission?.result) {
        if (
          !submission.result.ok &&
          !['renewed-intent', 'command-pending'].includes(submission.result.error.code)
        )
          throw new Error(`Submission rejected: ${submission.result.error.code}`);
        submission = null;
      }
      if (!submission && !latest.state.result) {
        const pending = choosePending(latest.state, game.engine.getPending(latest.state));
        const session = pending ? sessions.get(pending.seat) : undefined;
        const owned = pending ? updates.get(pending.seat) : undefined;
        if (pending && session && owned?.revision === latest.revision) {
          const actor = bots.get(pending.seat);
          const privateState = session.getPrivate(pending.seat);
          if (!actor || !privateState) throw new Error('Simulation actor is missing its own hand');
          const chosen = actor.bot.decide(
            { state: latest.state, seat: pending.seat, priv: privateState },
            pending,
            actor.rng,
          );
          const waiting = { seat: pending.seat, result: null as Result<void> | null };
          submission = waiting;
          void session
            .submit(pending.seat, chosen, { expectedRevision: latest.revision })
            .then((result) => {
              waiting.result = result;
              return undefined;
            });
          // oxlint-disable-next-line no-await-in-loop -- Submission must enter the queue before virtual time advances.
          await flush();
        }
      }
      if (!network.clock.runNext())
        throw new Error('Live peer game has no queued network/timer work');
      if (network.clock.now() > 7_200_000) throw new Error('Peer game exceeded two virtual hours');
    }
    throw new Error(`Peer game exceeded ${maxSteps} network steps`);
  } finally {
    for (const session of sessions.values()) session.dispose();
    network.dispose();
  }
}

function choosePending(state: GameState, pending: readonly Pending[]) {
  const players = pending.filter(
    (item): item is Extract<Pending, { kind: 'player' }> =>
      item.kind === 'player' && item.allowed.some((type) => type !== 'CLAIM_VICTORY'),
  );
  return (
    players.find((item) => item.allowed.includes('DISCARD')) ??
    players.find(
      (item) => item.seat !== state.turn.activeSeat && item.allowed.includes('RESPOND_TRADE'),
    ) ??
    players.find((item) => item.seat === state.turn.activeSeat)
  );
}
