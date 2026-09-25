import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Identity } from '@cp2p/crypto';
import type { CommandShape, Engine, Seat } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import type { BoardGraph } from '@cp2p/engine/geometry';
import { MemoryProtocolJournal, P2PSession } from '@cp2p/protocol';
import type { SessionUpdate } from '@cp2p/protocol';
import { createMemnet, createSimulationGenesis, SimulationDriver } from '@cp2p/protocol/testing';
import type { Memnet } from '@cp2p/protocol/testing';
import type { BoardAppearance, BoardHighlights, BoardHit } from '@cp2p/renderer';
import { BoardView } from '../board/BoardView.js';
import { toRenderModel } from '../board/toRenderModel.js';
import './network-simulation.css';

const simulationPolicy = {
  genesis: { allowStub: true },
  entry: { allowStub: true },
};

interface PeerGame {
  engine: Engine;
  network: Memnet;
  sessions: ReadonlyMap<Seat, P2PSession>;
  identities: ReadonlyMap<Seat, Identity>;
  genesis: ReturnType<typeof createSimulationGenesis>['genesis'];
}

interface PeerSnapshot {
  seat: Seat;
  update: SessionUpdate;
  privateHand: ReturnType<P2PSession['getPrivate']>;
  connectedPeers: number;
}

function readString(command: CommandShape, key: string): string | null {
  const value: unknown = command[key];
  return typeof value === 'string' ? value : null;
}

function targetForCommand(command: CommandShape, graph: BoardGraph | null): BoardHit | null {
  if (!graph) return null;
  if (command.type === 'PLACE_SETTLEMENT' || command.type === 'BUILD_CITY') {
    const id = readString(command, 'vertex');
    const vertex = graph.vertexIds.find((candidate) => candidate === id);
    return vertex ? { kind: 'vertex', id: vertex } : null;
  }
  if (command.type === 'PLACE_ROAD' || command.type === 'PLACE_FREE_ROAD') {
    const id = readString(command, 'edge');
    const edge = graph.edgeIds.find((candidate) => candidate === id);
    return edge ? { kind: 'edge', id: edge } : null;
  }
  if (command.type === 'MOVE_ROBBER') {
    const id = readString(command, 'hex');
    const hex = graph.hexIds.find((candidate) => candidate === id);
    return hex ? { kind: 'hex', id: hex } : null;
  }
  return null;
}

function commandForHit(
  commands: readonly CommandShape[],
  hit: BoardHit,
  graph: BoardGraph | null,
): CommandShape | undefined {
  return commands.find((command) => {
    const target = targetForCommand(command, graph);
    return target?.kind === hit.kind && target.id === hit.id;
  });
}

function highlightsFor(
  commands: readonly CommandShape[],
  graph: BoardGraph | null,
): BoardHighlights {
  const targets = commands
    .map((command) => targetForCommand(command, graph))
    .filter((target): target is BoardHit => target !== null);
  const vertices = targets.filter((target) => target.kind === 'vertex').map((target) => target.id);
  const edges = targets.filter((target) => target.kind === 'edge').map((target) => target.id);
  const hexes = targets.filter((target) => target.kind === 'hex').map((target) => target.id);
  return {
    vertices,
    edges,
    hexes,
    mode:
      vertices.length && !edges.length && !hexes.length
        ? 'vertex'
        : edges.length && !vertices.length && !hexes.length
          ? 'edge'
          : hexes.length && !vertices.length && !edges.length
            ? 'hex'
            : 'any',
    style: {
      pulse: true,
      ...(commands.some((command) => command.type === 'BUILD_CITY')
        ? { vertexTarget: 'upgrade' as const }
        : commands.some((command) => command.type === 'PLACE_SETTLEMENT')
          ? { vertexTarget: 'site' as const }
          : {}),
    },
  };
}

async function pumpNetwork(
  network: Memnet,
  sessions: ReadonlyMap<Seat, P2PSession>,
): Promise<void> {
  await Promise.all([...sessions.values()].map((session) => session.flush()));
  network.clock.advanceBy(1);
  await Promise.all([...sessions.values()].map((session) => session.flush()));
}

function networkSettled(game: PeerGame): boolean {
  const sessions = [...game.sessions.values()];
  const revisions = sessions.map((session) => session.exportSave().entries.at(-1)?.entry.seq ?? 0);
  if (!revisions.length || revisions.some((revision) => revision !== revisions[0])) return false;
  return sessions.every((session) =>
    game.engine
      .getPending(session.getState())
      .every((pending) => pending.kind !== 'random' && pending.kind !== 'reveal'),
  );
}

function commandLabel(command: CommandShape): string {
  const names: Record<string, string> = {
    PLACE_SETTLEMENT: 'Place settlement',
    PLACE_ROAD: 'Place road',
    PLACE_FREE_ROAD: 'Place free road',
    BUILD_CITY: 'Upgrade to city',
    MOVE_ROBBER: 'Move robber',
    STEAL: 'Choose steal target',
    ROLL_DICE: 'Roll dice',
    PLAY_DEV_CARD: 'Play development card',
    BUY_DEV_CARD: 'Buy development card',
    END_TURN: 'End turn',
    CLAIM_VICTORY: 'Claim victory',
    CANCEL_TRADE: 'Cancel trade',
    RESPOND_TRADE: 'Respond to trade',
  };
  return names[command.type] ?? command.type;
}

function useSimulationGame(): {
  game: PeerGame | null;
  snapshots: readonly PeerSnapshot[];
  error: string | null;
  busy: boolean;
  submit: (seat: Seat, command: CommandShape) => Promise<void>;
} {
  const gameRef = useRef<PeerGame | null>(null);
  const [game, setGame] = useState<PeerGame | null>(null);
  const [updates, setUpdates] = useState<ReadonlyMap<Seat, SessionUpdate>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pumping = useRef<Promise<void> | null>(null);
  const pump = useCallback(async (current: PeerGame): Promise<void> => {
    if (pumping.current) return pumping.current;
    const work = pumpNetwork(current.network, current.sessions);
    pumping.current = work;
    try {
      await work;
    } finally {
      pumping.current = null;
    }
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const current = gameRef.current;
      if (current) void pump(current);
    }, 4);
    return () => window.clearInterval(interval);
  }, [pump]);

  useEffect(() => {
    let cancelled = false;
    let network: Memnet | null = null;
    const opened = new Map<Seat, P2PSession>();
    const cleanups: Array<() => void> = [];
    const start = async (): Promise<void> => {
      try {
        const fixture = createSimulationGenesis({ seed: 42, humanCount: 4 });
        const identities = fixture.identities;
        const peerIds = [...identities.values()].map((identity) => identity.peerId);
        const mesh = createMemnet({ peers: peerIds, seed: 42, defaultLink: { latencyMs: 1 } });
        network = mesh;
        await Promise.all(
          fixture.genesis.config.seats.map(async (seat) => {
            const identity = identities.get(seat);
            if (!identity) throw new Error(`Missing simulation identity for seat ${seat}`);
            const created = await P2PSession.create({
              genesisEntry: fixture.entry,
              engine: fixture.engine,
              policy: simulationPolicy,
              seat,
              secretKey: identity.secretKey,
              transport: mesh.transport(identity.peerId),
              clock: mesh.clock,
              journal: new MemoryProtocolJournal(),
              createDriver: (engine, genesis, clock) =>
                new SimulationDriver(engine, genesis, clock),
            });
            if (!created.ok) throw new Error(`${created.error.code}: ${created.error.message}`);
            opened.set(seat, created.value);
          }),
        );
        if (cancelled) {
          for (const session of opened.values()) session.dispose();
          mesh.dispose();
          return;
        }
        const peerGame: PeerGame = {
          engine: fixture.engine,
          network: mesh,
          sessions: opened,
          identities,
          genesis: fixture.genesis,
        };
        gameRef.current = peerGame;
        setGame(peerGame);
        for (const [seat, session] of opened) {
          cleanups.push(
            session.subscribe((update) => {
              setUpdates((current) => new Map(current).set(seat, update));
            }),
          );
        }
        for (let pass = 0; pass < 400; pass++) {
          // oxlint-disable-next-line no-await-in-loop -- Each virtual-time step follows messages drained in this pass.
          await pump(peerGame);
          const revisions = [...opened.values()].map(
            (session) => session.exportSave().entries.at(-1)?.entry.seq ?? 0,
          );
          if (revisions.length === opened.size && revisions.every((revision) => revision >= 1))
            break;
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
        for (const session of opened.values()) session.dispose();
        network?.dispose();
      }
    };
    void start();
    return () => {
      cancelled = true;
      for (const cleanup of cleanups) cleanup();
      for (const session of opened.values()) session.dispose();
      network?.dispose();
      if (gameRef.current?.network === network) gameRef.current = null;
    };
  }, [pump]);

  const snapshots = useMemo(() => {
    if (!game) return [];
    return [...game.sessions]
      .toSorted(([a], [b]) => a - b)
      .flatMap(([seat, session]) => {
        const update = updates.get(seat);
        if (!update) return [];
        return [
          {
            seat,
            update,
            privateHand: session.getPrivate(seat),
            connectedPeers: game.network.transport(game.identities.get(seat)?.peerId ?? '').peers()
              .length,
          },
        ];
      });
  }, [game, updates]);

  const submit = useCallback(
    async (seat: Seat, command: CommandShape) => {
      const current = gameRef.current;
      const session = current?.sessions.get(seat);
      if (!current || !session) return;
      const revision = session.exportSave().entries.at(-1)?.entry.seq ?? 0;
      setBusy(true);
      setError(null);
      try {
        const submitPromise = session.submit(seat, command, { expectedRevision: revision });
        let result: Awaited<typeof submitPromise> | undefined;
        let submitError: unknown;
        void submitPromise.then(
          (value) => {
            result = value;
            return value;
          },
          (cause: unknown) => {
            submitError = cause;
            return undefined;
          },
        );
        for (let pass = 0; pass < 1_000; pass++) {
          // oxlint-disable-next-line no-await-in-loop -- Keep the virtual mesh advancing until quorum completes.
          await pump(current);
          // oxlint-disable-next-line no-await-in-loop -- Allow commit continuations to settle after queued delivery.
          await Promise.resolve();
          if (submitError !== undefined) throw submitError;
          if (result !== undefined) break;
        }
        if (!result) throw new Error('No quorum response; keep the simulation running and retry.');
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        for (let pass = 0; pass < 1_000; pass++) {
          // oxlint-disable-next-line no-await-in-loop -- Drain certified updates and automatic random/reveal entries.
          await pump(current);
          if (networkSettled(current)) return;
        }
        throw new Error('Peers did not converge after the committed input.');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [pump],
  );

  return { game, snapshots, error, busy, submit };
}

export default function NetworkSimulation() {
  const { game, snapshots, error, busy, submit } = useSimulationGame();
  const [selectedSeat, setSelectedSeat] = useState<Seat>(0);
  const appearance: BoardAppearance = useMemo(
    () => ({
      theme:
        document.documentElement.dataset.theme === 'dark' ||
        (document.documentElement.dataset.theme !== 'light' &&
          window.matchMedia('(prefers-color-scheme: dark)').matches)
          ? 'dark'
          : 'light',
      players: (game?.genesis.seats ?? []).map((player) => ({
        seat: player.seat,
        color: Number.parseInt(player.colour.slice(1), 16),
        marker: (['circle', 'triangle', 'square', 'diamond'] as const)[player.seat % 4] ?? 'circle',
      })),
    }),
    [game],
  );
  return (
    <main className="network-simulation-page">
      <header className="network-simulation-header">
        <div>
          <p className="network-simulation-kicker">Development tool · stub randomness</p>
          <h1>Four-peer network simulation</h1>
          <p>
            Four independent P2P sessions in one tab, connected through a deterministic in-memory
            mesh.
          </p>
        </div>
        <span className="network-simulation-badge">Simulation only · no production save</span>
      </header>
      {error && (
        <p className="network-simulation-error" role="alert">
          {error}
        </p>
      )}
      <section className="network-simulation-peers" aria-label="Independent peer game views">
        {snapshots.map((snapshot) => {
          const peerState = snapshot.update.state;
          const peerSession = game?.sessions.get(snapshot.seat);
          const peerCommands = peerSession?.getLegalCommands(snapshot.seat).commands ?? [];
          const graph = buildBoardGraph(peerState.board.hexes);
          const boardModel = toRenderModel(peerState, snapshot.seat);
          const highlights = highlightsFor(peerCommands, graph);
          const commandButtons = peerCommands.filter(
            (command) => targetForCommand(command, graph) === null,
          );
          const identity = game?.identities.get(snapshot.seat);
          const active = peerState.turn.activeSeat === snapshot.seat;
          const handlePeerHit = (hit: BoardHit): void => {
            const currentCommands = peerSession?.getLegalCommands(snapshot.seat).commands ?? [];
            const command = commandForHit(currentCommands, hit, graph);
            setSelectedSeat(snapshot.seat);
            if (command) void submit(snapshot.seat, command);
          };
          return (
            <article
              className={[
                'network-peer-game',
                snapshot.seat === selectedSeat ? 'is-selected' : '',
                active ? 'is-turn-active' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              data-peer-seat={snapshot.seat}
              data-testid="network-peer-view"
              key={snapshot.seat}
              aria-label={`Peer seat ${snapshot.seat + 1} game view`}
            >
              <header className="network-peer-heading">
                <div>
                  <h2>Peer {snapshot.seat + 1}</h2>
                  <span>{active ? 'Active turn' : 'Waiting'}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedSeat(snapshot.seat)}
                  aria-pressed={snapshot.seat === selectedSeat}
                >
                  Inspect peer
                </button>
              </header>
              <BoardView
                model={boardModel}
                label={`Peer ${snapshot.seat + 1} simulation board`}
                highlights={highlights}
                appearance={appearance}
                onSelect={handlePeerHit}
                targetLabel={(hit) => `${hit.kind} ${hit.id}`}
                className="network-peer-board"
              />
              <div className="network-peer-status">
                <span>Connection: {snapshot.connectedPeers} peers</span>
                <span data-testid={`network-peer-revision-${snapshot.seat}`}>
                  Revision {snapshot.update.revision}
                </span>
                <span>Status: {snapshot.update.status.kind}</span>
                <span>Peer id: {identity?.peerId.slice(0, 12)}…</span>
              </div>
              <div
                className="network-peer-hand"
                aria-label={`Peer ${snapshot.seat + 1} private hand`}
              >
                <strong>Own hand</strong>
                {snapshot.privateHand ? (
                  Object.entries(snapshot.privateHand.hand).map(([resource, count]) => (
                    <span key={resource}>
                      {resource}: {count}
                    </span>
                  ))
                ) : (
                  <span>Unavailable</span>
                )}
                {snapshot.privateHand && Object.keys(snapshot.privateHand.slots).length > 0 && (
                  <span>
                    Development cards: {Object.values(snapshot.privateHand.slots).join(', ')}
                  </span>
                )}
              </div>
              {commandButtons.length > 0 && (
                <div
                  className="network-peer-actions"
                  aria-label={`Peer ${snapshot.seat + 1} legal actions`}
                >
                  {commandButtons.map((command, index) => (
                    <button
                      type="button"
                      disabled={busy}
                      key={`${command.type}-${index}`}
                      onClick={() => {
                        setSelectedSeat(snapshot.seat);
                        void submit(snapshot.seat, command);
                      }}
                    >
                      {commandLabel(command)}
                    </button>
                  ))}
                </div>
              )}
            </article>
          );
        })}
      </section>
      <p className="network-simulation-hint">
        Each view reads only its owning session's private hand. Targetless commands appear on that
        peer's view; board commands use its highlighted legal locations.
      </p>
    </main>
  );
}
