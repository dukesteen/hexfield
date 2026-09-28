import { enumerateCommands, engineForConfig } from '@cp2p/engine';
import type { CommandShape, Pending } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import type { Bot, BotRng, BotView } from '@cp2p/bots';

const SHIP_BUILDS = new Set(['BUILD_SHIP', 'PLACE_FREE_SHIP']);

/** Axial distance between two `h:q,r` hex ids. */
function hexDistance(a: string, b: string): number {
  const [aq = 0, ar = 0] = a.slice(2).split(',').map(Number);
  const [bq = 0, br = 0] = b.slice(2).split(',').map(Number);
  return (Math.abs(aq - bq) + Math.abs(ar - br) + Math.abs(aq + ar - bq - br)) / 2;
}

/**
 * Test-only explorer: whenever a ship is legal, place the one nearest the fog, so a game reveals
 * fog tiles through the deck protocol. Everything else follows the delegate. Reads only public
 * state and the acting seat's hand.
 */
export function seafaringCommand(
  view: BotView,
  pending: Pending,
  rng: BotRng,
  delegate: Bot,
): CommandShape {
  if (pending.kind !== 'player' || pending.seat !== view.seat)
    throw new Error('Seafaring policy requires own pending');
  const fog = view.state.board.hexes.filter((hex) => hex.terrain === 'fog').map((hex) => hex.id);
  const wanted = pending.allowed.filter((type) => SHIP_BUILDS.has(type));
  if (fog.length === 0 || wanted.length === 0) return delegate.decide(view, pending, rng);
  const ships = enumerateCommands(
    engineForConfig(view.state.config),
    view.state,
    view.seat,
    view.priv,
    { candidateFilter: (command) => wanted.includes(command.type) },
  );
  const graph = buildBoardGraph(view.state.board.hexes);
  const distance = (command: CommandShape): number => {
    const hexes = graph.edgeHexes[graph.edgeIndex[String(command.edge)] ?? -1] ?? [];
    return Math.min(...hexes.flatMap((hex) => fog.map((target) => hexDistance(hex, target))));
  };
  const nearest = ships.toSorted((a, b) => distance(a) - distance(b))[0];
  return nearest ?? delegate.decide(view, pending, rng);
}
