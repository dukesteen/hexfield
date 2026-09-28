import type { Seat } from '@cp2p/engine';
import { chooseBotPending as chooseProtocolBotPending } from '@cp2p/protocol';

export { phaseIdentity, timerKey } from '@cp2p/protocol';

type Pending = Parameters<typeof chooseProtocolBotPending>[1][number];
type PlayerPending = Extract<Pending, { kind: 'player' }>;

/**
 * Requests that Cities & Knights may make of several seats at once, none of them the active seat:
 * a Wedding gift, a Saboteur discard, progress-card discards down to the hand limit, pillage
 * choices and tie draws. A lone request of one of these is picked up by the protocol's own rule.
 */
const PARALLEL_REQUESTS: ReadonlySet<string> = new Set([
  'WEDDING_GIVE',
  'SABOTEUR_DISCARD',
  'DISCARD_PROGRESS',
  'CHOOSE_PILLAGE',
  'CHOOSE_PROGRESS_DECK',
  'CHOOSE_AQUEDUCT',
  'PLACE_METROPOLIS',
  'RELOCATE_KNIGHT',
  'DESERTER_REMOVE',
  'HARBOR_REPLY',
]);

/**
 * The player request a bot answers next: the protocol's choice, then any bot's share of a request
 * made of several seats at once. Without the second rule such a request stalls a local game.
 */
export function chooseBotPending(
  state: Parameters<typeof chooseProtocolBotPending>[0],
  pending: Parameters<typeof chooseProtocolBotPending>[1],
  botSeats: ReadonlySet<Seat>,
): PlayerPending | null {
  const chosen = chooseProtocolBotPending(state, pending, botSeats);
  if (chosen) return chosen;
  return (
    pending.find(
      (item): item is PlayerPending =>
        item.kind === 'player' &&
        botSeats.has(item.seat) &&
        item.allowed.some((type) => PARALLEL_REQUESTS.has(type)),
    ) ?? null
  );
}
