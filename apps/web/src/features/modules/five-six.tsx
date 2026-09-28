import { useTranslation } from 'react-i18next';
import type { ModuleHudProps, UiModule } from './registry';
import { registerUiModule } from './registry';

function playerName(presentation: ModuleHudProps['presentation'], seat: number): string {
  return presentation.players.find((player) => player.seat === seat)?.name ?? `#${seat + 1}`;
}

/** Banner shown while a seat builds between turns. */
export function SpecialBuildBanner({ hints, presentation }: ModuleHudProps) {
  const { t } = useTranslation('game');
  const hint = hints.find((item) => item.module === 'five-six' && item.kind === 'special-build');
  if (!hint || typeof hint.seat !== 'number') return null;
  return (
    <div className="module-banner special-build-banner" role="status" aria-live="polite">
      <strong>{t('game:specialBuild', { name: playerName(presentation, hint.seat) })}</strong>
      <span>{t('game:specialBuildHint')}</span>
    </div>
  );
}

export const fiveSixUi: UiModule = {
  HudWidgets: [SpecialBuildBanner],
};

registerUiModule('five-six', fiveSixUi);
