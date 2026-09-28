import type { GameState } from '@cp2p/engine';
import { getAwardCardUrl } from '@cp2p/renderer';
import { useTranslation } from 'react-i18next';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import { isSeafaring } from './seafaring';

export function AwardsPanel({
  state,
  presentation,
}: {
  state: GameState;
  presentation: GamePresentation;
}) {
  const { t } = useTranslation('game');
  const seafaring = isSeafaring(state);
  return (
    <section className="awards-panel" aria-label={t('game:cockpit.awards')}>
      <h2>{t('game:cockpit.awards')}</h2>
      <div className="award-list">
        {(['longestRoad', 'largestArmy'] as const).map((award) => {
          const holder = presentation.players.find((player) => player.seat === state.awards[award]);
          return (
            <div className="award-item" key={award} data-claimed={Boolean(holder)}>
              <img src={getAwardCardUrl(award)} alt="" aria-hidden="true" />
              <div>
                <span>
                  {award === 'longestRoad' && seafaring
                    ? t('game:longestTradeRoute')
                    : t(`game:${award}`)}
                </span>
                <strong className={holder ? `color-${holder.color}` : undefined}>
                  {holder?.name ?? t('game:awardUnclaimed')}
                </strong>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
