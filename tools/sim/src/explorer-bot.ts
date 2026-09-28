import { RandomBot } from '@cp2p/bots';
import type { Bot, BotRng, BotView } from '@cp2p/bots';
import { enumerateCommands } from '@cp2p/engine';
import type { CommandShape, Engine, Pending } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';

const SHIP_BUILDS = new Set(['BUILD_SHIP', 'PLACE_FREE_SHIP']);

/** Axial distance between two `h:q,r` hex ids. */
function hexDistance(a: string, b: string): number {
  const [aq = 0, ar = 0] = a.slice(2).split(',').map(Number);
  const [bq = 0, br = 0] = b.slice(2).split(',').map(Number);
  return (Math.abs(aq - bq) + Math.abs(ar - br) + Math.abs(aq + ar - bq - br)) / 2;
}

/**
 * A random bot that, whenever a ship is legal and fog remains, places the ship nearest the fog.
 * Chaos runs on a fog scenario use it so their games reveal tiles through the deck protocol.
 */
export class ExplorerBot implements Bot {
  readonly id = 'explorer';
  private readonly random: RandomBot;

  constructor(private readonly engine: Engine) {
    this.random = new RandomBot(engine);
  }

  decide(view: BotView, pending: Pending, rng: BotRng): CommandShape {
    if (pending.kind !== 'player') return this.random.decide(view, pending, rng);
    const fog = view.state.board.hexes.filter((hex) => hex.terrain === 'fog').map((hex) => hex.id);
    const wanted = pending.allowed.filter((type) => SHIP_BUILDS.has(type));
    if (fog.length === 0 || wanted.length === 0) return this.random.decide(view, pending, rng);
    const ships = enumerateCommands(this.engine, view.state, view.seat, view.priv, {
      candidateFilter: (command) => wanted.includes(command.type),
    });
    const graph = buildBoardGraph(view.state.board.hexes);
    const distance = (command: CommandShape): number => {
      const hexes = graph.edgeHexes[graph.edgeIndex[String(command.edge)] ?? -1] ?? [];
      return Math.min(...hexes.flatMap((hex) => fog.map((target) => hexDistance(hex, target))));
    };
    const nearest = ships.toSorted((a, b) => distance(a) - distance(b))[0];
    return nearest ?? this.random.decide(view, pending, rng);
  }

  respondToTrade(
    view: BotView,
    offer: Parameters<NonNullable<Bot['respondToTrade']>>[1],
    rng: BotRng,
  ): boolean {
    return this.random.respondToTrade?.(view, offer, rng) ?? false;
  }
}
