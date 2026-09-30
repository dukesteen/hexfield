import { isBaseResource } from '@cp2p/engine';
import type { GameState, PrivateState, Seat } from '@cp2p/engine';
import { getCommodityIconUrl, getGameArtUrl, getResourceIconUrl } from '@cp2p/renderer';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { GamePresentation } from '../../queries/repositories/saved-games.js';
import { resourceLabel } from '../dialogs/resources.js';
import { PlayerMarker } from '../game/PlayerMarker.js';
import { CARD_INFO } from '../knights/catalogue.js';

function iconOf(kind: string): string | null {
  if (isBaseResource(kind)) return getResourceIconUrl(kind);
  if (kind === 'paper' || kind === 'cloth' || kind === 'coin') return getCommodityIconUrl(kind);
  return null;
}

function cardLabel(t: TFunction, card: string): string {
  // Progress cards (knights) have their own names; the rest are development cards.
  return CARD_INFO[card] ? t(`knights:cards.${card}.name`) : t(`game:dev${card}`);
}

function knightsPlayed(state: GameState, seat: Seat): number {
  const base: unknown = state.ext.base;
  if (typeof base !== 'object' || base === null) return 0;
  const counts: unknown = Reflect.get(base, 'knightsPlayed');
  return Array.isArray(counts) && typeof counts[seat] === 'number' ? counts[seat] : 0;
}

/** Hidden victory cards in a shown hand, which a public view cannot count. */
function hiddenVictoryPoints(state: GameState, seat: Seat, hand: PrivateState): number {
  const slots = state.seats.find((item) => item.seat === seat)?.cardSlots ?? [];
  return slots.filter((slot) => !slot.revealed && hand.slots[slot.slotId] === 'victoryPoint')
    .length;
}

function Hand({ state, hand }: { state: GameState; hand: PrivateState }) {
  const { t } = useTranslation(['game', 'rules', 'knights']);
  const kinds = Object.entries(hand.hand).filter(([, count]) => count > 0);
  const slots = state.seats.find((item) => item.seat === hand.seat)?.cardSlots ?? [];
  const cards = slots.flatMap((slot) => {
    const card = slot.revealed ?? hand.slots[slot.slotId];
    return !slot.revealed && typeof card === 'string' ? [card] : [];
  });
  return (
    <div className="replay-hand">
      <ul aria-label={t('game:replay.handCards')}>
        {kinds.length === 0 && <li className="muted">{t('game:replay.emptyHand')}</li>}
        {kinds.map(([kind, count]) => {
          const icon = iconOf(kind);
          return (
            <li key={kind}>
              {icon && <img src={icon} alt="" aria-hidden="true" />}
              <span>
                {count} {resourceLabel(t, kind)}
              </span>
            </li>
          );
        })}
      </ul>
      {cards.length > 0 && (
        <ul className="replay-hand-cards" aria-label={t('game:replay.handDevelopment')}>
          {cards.map((card, index) => (
            <li key={`${card}-${index}`}>{cardLabel(t, card)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The game's player panels, with each hand the perspective shows. */
export function ReplayPlayers({
  state,
  presentation,
  hand,
}: {
  state: GameState;
  presentation: GamePresentation;
  hand: (seat: Seat) => PrivateState | null;
}) {
  const { t } = useTranslation('game');
  const active = state.turn.activeSeat;
  return (
    <section className="player-rail replay-players" aria-label={t('game:players')}>
      <div className="player-list">
        {state.seats.map((seat) => {
          const identity = presentation.players.find((player) => player.seat === seat.seat);
          const name = identity?.name ?? t('game:playerFallback', { number: seat.seat + 1 });
          const shown = hand(seat.seat);
          const hidden = shown ? hiddenVictoryPoints(state, seat.seat, shown) : 0;
          const awards = Object.entries(state.awards).flatMap(([award, holder]) =>
            holder === seat.seat ? [award] : [],
          );
          const devCards = seat.cardSlots.filter((slot) => !slot.revealed).length;
          return (
            <section
              key={seat.seat}
              className={`player-panel ${active === seat.seat ? 'is-active' : ''}`}
              aria-label={name}
              aria-current={active === seat.seat ? 'step' : undefined}
              data-seat-panel={seat.seat}
            >
              {active === seat.seat && (
                <img
                  className="player-turn-marker"
                  src={getGameArtUrl('turnMarker')}
                  alt=""
                  aria-hidden="true"
                />
              )}
              <div className="player-panel-heading">
                <PlayerMarker
                  shape={identity?.shape ?? 'circle'}
                  color={identity?.color ?? 'blue'}
                />
                <strong>{name}</strong>
                <span
                  className="player-vp"
                  aria-label={
                    hidden > 0
                      ? t('game:replay.victoryPointsWithHidden', {
                          count: seat.publicVp + hidden,
                          hidden,
                        })
                      : t('game:publicVictoryPoints', { count: seat.publicVp })
                  }
                >
                  {seat.publicVp + hidden} <small>{t('game:vpShort')}</small>
                </span>
              </div>
              <dl className="player-panel-stats">
                <div>
                  <dt>{t('game:statCards')}</dt>
                  <dd>{seat.resources.total}</dd>
                </div>
                <div>
                  <dt>{t('game:statDev')}</dt>
                  <dd>{devCards}</dd>
                </div>
                <div>
                  <dt>{t('game:statKnights')}</dt>
                  <dd>{knightsPlayed(state, seat.seat)}</dd>
                </div>
              </dl>
              {awards.length > 0 && (
                <p className="replay-awards">
                  {awards
                    .map((award) =>
                      award === 'longestRoad'
                        ? t('game:longestRoad')
                        : award === 'largestArmy'
                          ? t('game:largestArmy')
                          : award,
                    )
                    .join(' · ')}
                </p>
              )}
              {shown && <Hand state={state} hand={shown} />}
            </section>
          );
        })}
      </div>
    </section>
  );
}
