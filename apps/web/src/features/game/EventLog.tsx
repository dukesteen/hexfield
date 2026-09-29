import { useTranslation } from 'react-i18next';
import { RESOURCES, type GameEvent } from '@cp2p/engine';
import {
  getDieUrl,
  getFactionUrl,
  getGameArtUrl,
  getPieceIconUrl,
  getResourceIconUrl,
  getSeafaringIconUrl,
  getShipIconUrl,
} from '@cp2p/renderer';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import { KNIGHTS_ACTOR_EVENTS, knightsEventArt } from '../knights/log';
import { FOG_TERRAIN_RESOURCE, formatGameEvent } from './event-format';
import { FairnessFindings } from './FairnessStatus.js';

const actorEvents = new Set([
  'roadBuilt',
  'settlementBuilt',
  'cityBuilt',
  'shipBuilt',
  'shipMoved',
  'pirateMoved',
  'goldChosen',
  'fogRevealed',
  'resourcesDiscarded',
  'devCardBought',
  'devCardDealt',
  'devCardPlayed',
  'robberMoved',
  'turnStarted',
  'tradeProposed',
  'tradeResponded',
  'tradeCancelled',
  'tradeResponsesTimedOut',
  'maritimeTrade',
  'monopolyCollected',
]);
const tradeEvents = new Set([
  'tradeOffered',
  'tradeProposed',
  'tradeResponded',
  'tradeConfirmed',
  'tradeCancelled',
  'tradeResponsesTimedOut',
]);
const neutralDiceUrl = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><g fill="none" stroke="#766657" stroke-width="2"><rect x="2" y="8" width="19" height="19" rx="3"/><rect x="11" y="3" width="19" height="19" rx="3"/></g></svg>')}`;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function eventSeats(event: GameEvent): number[] {
  if (event.type === 'resourceStolen' && typeof event.thief === 'number') return [event.thief];
  if (event.type === 'gameEnded' && typeof event.winner === 'number') return [event.winner];
  return (actorEvents.has(event.type) || KNIGHTS_ACTOR_EVENTS.has(event.type)) &&
    'seat' in event &&
    typeof event.seat === 'number'
    ? [event.seat]
    : [];
}

function eventArt(event: GameEvent, color?: string): string[] {
  const knights = knightsEventArt(event, color);
  if (knights) return knights;
  if (event.type === 'roadBuilt') return [getPieceIconUrl('road', color)];
  if (event.type === 'settlementBuilt') return [getPieceIconUrl('settlement', color)];
  if (event.type === 'cityBuilt') return [getPieceIconUrl('city', color)];
  if (event.type === 'shipBuilt' || event.type === 'shipMoved') return [getShipIconUrl(color)];
  if (event.type === 'pirateMoved') return [getSeafaringIconUrl('pirate')];
  if (event.type === 'goldChosen') return [getSeafaringIconUrl('gold')];
  if (event.type === 'fogRevealed') {
    const resource =
      typeof event.terrain === 'string' ? FOG_TERRAIN_RESOURCE[event.terrain] : undefined;
    if (resource) return [getResourceIconUrl(resource)];
    return [getSeafaringIconUrl(event.terrain === 'gold' ? 'gold' : 'fog')];
  }
  if (event.type === 'diceRolled') {
    const dice = event.dice;
    return Array.isArray(dice) &&
      dice.length === 2 &&
      dice.every((face) => Number.isInteger(face) && face >= 1 && face <= 6)
      ? dice.map((face: number) => getDieUrl(face))
      : [neutralDiceUrl];
  }
  // Production shows no seats or kinds, matching its log line.
  if (event.type === 'resourcesProduced') return [getGameArtUrl('cardBack')];
  if (event.type === 'maritimeTrade') return [getGameArtUrl('bankTrade')];
  if (tradeEvents.has(event.type)) return [getGameArtUrl('playerTrade')];
  if (
    event.type === 'devCardBought' ||
    event.type === 'devCardDealt' ||
    event.type === 'devCardPlayed' ||
    event.type === 'resourcesDiscarded' ||
    event.type === 'resourceStolen' ||
    event.type === 'monopolyCollected'
  )
    return [getGameArtUrl('cardBack')];
  return [getGameArtUrl('turnMarker')];
}

export function EventLog({
  events,
  presentation,
  initiallyOpen = false,
  derived = [],
}: {
  events: readonly GameEvent[];
  presentation: GamePresentation;
  initiallyOpen?: boolean;
  /** Lines derived from state changes (the barbarian ship), placed among the events. */
  derived?: readonly { readonly at: number; readonly event: GameEvent }[];
}) {
  const { t } = useTranslation(['game', 'log']);
  const playerName = (seat: number) =>
    presentation.players.find((player) => player.seat === seat)?.name ??
    t('game:playerFallback', { number: seat + 1 });
  return (
    <details className="event-log" open={initiallyOpen}>
      <summary>{t('game:eventLog')}</summary>
      <FairnessFindings presentation={presentation} />
      {events.length === 0 ? (
        <p className="muted">{t('game:noEvents')}</p>
      ) : (
        <ol role="list">
          {[
            ...events.flatMap((event, index) => [
              ...derived
                .filter((item) => item.at === index)
                .map((item, position) => ({ event: item.event, index: `d${index}:${position}` })),
              { event, index },
            ]),
            ...derived
              .filter((item) => item.at >= events.length)
              .map((item, position) => ({ event: item.event, index: `t${position}` })),
          ]
            .toReversed()
            .map(({ event, index }) => {
              const actors = eventSeats(event)
                .map((seat) => presentation.players.find((player) => player.seat === seat))
                .filter((player) => player !== undefined);
              const icons = eventArt(event, actors[0]?.color);
              return (
                <li className="event-log-entry" key={index}>
                  <span className="event-log-icons" aria-hidden="true">
                    {actors.map((player) => (
                      <img
                        className="event-log-faction"
                        src={getFactionUrl(player.color)}
                        alt=""
                        key={player.seat}
                      />
                    ))}
                    {icons.map((url, iconIndex) => (
                      <img
                        className="event-log-action"
                        src={url}
                        alt=""
                        key={`${url}:${iconIndex}`}
                      />
                    ))}
                  </span>
                  <span className="event-log-message">{formatGameEvent(event, t, playerName)}</span>
                </li>
              );
            })}
        </ol>
      )}
    </details>
  );
}
