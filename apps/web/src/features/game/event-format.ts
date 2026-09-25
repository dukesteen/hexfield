import type { TFunction } from 'i18next';
import { RESOURCES, type GameEvent } from '@cp2p/engine';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Format only public event fields; card identities and stolen resources stay private. */
export function formatGameEvent(
  event: GameEvent,
  t: TFunction,
  playerLabel: (seat: number) => string,
): string {
  const actor = 'seat' in event && typeof event.seat === 'number' ? playerLabel(event.seat) : null;
  if (event.type === 'roadBuilt' && actor) return t('log:roadBuilt', { player: actor });
  if (event.type === 'settlementBuilt' && actor) return t('log:settlementBuilt', { player: actor });
  if (event.type === 'cityBuilt' && actor) return t('log:cityBuilt', { player: actor });
  if (event.type === 'diceRolled' && typeof event.roll === 'number')
    return t('log:diceRolled', { count: event.roll });
  if (event.type === 'resourcesProduced' && record(event.bySeat)) {
    const gains = Object.entries(event.bySeat).flatMap(([seat, counts]) => {
      if (!record(counts)) return [];
      const cards = RESOURCES.flatMap((resource) => {
        const count = counts[resource];
        return typeof count === 'number' && count > 0
          ? [t('log:resourceGain', { count, resource: t(`game:${resource}`) })]
          : [];
      });
      return cards.length ? [`${playerLabel(Number(seat))}: ${cards.join(', ')}`] : [];
    });
    if (gains.length) return t('log:resourcesProducedDetailed', { details: gains.join('; ') });
    return t('log:resourcesProduced');
  }
  if (event.type === 'resourcesDiscarded' && actor && typeof event.count === 'number')
    return t('log:resourcesDiscarded', { player: actor, count: event.count });
  if (event.type === 'devCardBought' && actor) return t('log:devCardBought', { player: actor });
  if (event.type === 'devCardDealt' && actor) return t('log:devCardDealt', { player: actor });
  if (event.type === 'devCardPlayed' && actor && typeof event.card === 'string')
    return t('log:devCardPlayed', { player: actor, card: t(`game:dev${event.card}`) });
  if (event.type === 'robberMoved' && actor) return t('log:robberMoved', { player: actor });
  if (
    event.type === 'resourceStolen' &&
    typeof event.thief === 'number' &&
    typeof event.victim === 'number'
  )
    return t('log:resourceStolen', {
      thief: playerLabel(event.thief),
      victim: playerLabel(event.victim),
    });
  if (event.type === 'turnStarted' && actor) return t('log:turnStarted', { player: actor });
  if (event.type === 'tradeOffered' || event.type === 'tradeProposed') return t('log:tradeOffered');
  if (event.type === 'tradeResponded' && actor)
    return t(event.accept === true ? 'log:tradeAccepted' : 'log:tradeDeclined', { player: actor });
  if (event.type === 'tradeConfirmed' || event.type === 'maritimeTrade')
    return t('log:tradeCompleted');
  if (event.type === 'tradeCancelled') return t('log:tradeCancelled');
  if (event.type === 'tradeResponsesTimedOut' && actor)
    return t('log:tradeResponsesTimedOut', { player: actor });
  if (event.type === 'monopolyCollected' && actor && typeof event.count === 'number')
    return t('log:monopolyCollected', { player: actor, count: event.count });
  if (event.type === 'phaseChanged') return t('log:phaseChanged');
  if (event.type === 'gameEnded' && typeof event.winner === 'number')
    return t('log:gameEnded', { player: playerLabel(event.winner) });
  return t('log:gameUpdated');
}
