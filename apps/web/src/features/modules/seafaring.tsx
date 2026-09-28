import { useTranslation } from 'react-i18next';
import { getIslandChitUrl } from '@cp2p/renderer';
import { islandBonusOf, islandBonusPoints } from '../game/seafaring';
import type { ModulePanelProps, UiModule } from './registry';
import { registerUiModule } from './registry';
import './seafaring.css';

/** The new-island bonus a seat has earned, as a badge in its player panel. */
export function IslandBonusBadge({ state, seat }: ModulePanelProps) {
  const { t } = useTranslation('game');
  const { count, points } = islandBonusOf(state, seat);
  if (count === 0) return null;
  const label = t('game:islandBonusBadge', { count, points });
  return (
    <span className="award-chip island-chip" title={t('game:islandBonus')} aria-label={label}>
      <img src={getIslandChitUrl(islandBonusPoints(state))} alt="" aria-hidden="true" />
      <span aria-hidden="true">{label}</span>
    </span>
  );
}

export const seafaringUi: UiModule = {
  PlayerPanelExtras: IslandBonusBadge,
};

registerUiModule('seafaring', seafaringUi);
