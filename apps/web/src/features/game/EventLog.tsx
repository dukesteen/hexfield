import { useTranslation } from 'react-i18next';
import type { GameEvent } from '@cp2p/engine';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import { formatGameEvent } from './event-format';

export function EventLog({
  events,
  presentation,
}: {
  events: readonly GameEvent[];
  presentation: GamePresentation;
}) {
  const { t } = useTranslation(['game', 'log']);
  const playerName = (seat: number) =>
    presentation.players.find((player) => player.seat === seat)?.name ??
    t('game:playerFallback', { number: seat + 1 });
  return (
    <details className="event-log">
      <summary>{t('game:eventLog')}</summary>
      {events.length === 0 ? (
        <p className="muted">{t('game:noEvents')}</p>
      ) : (
        <ol>
          {events.map((event, index) => (
            <li key={index}>{formatGameEvent(event, t, playerName)}</li>
          ))}
        </ol>
      )}
    </details>
  );
}
