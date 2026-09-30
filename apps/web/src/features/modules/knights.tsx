import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BARBARIAN_FIXTURE, BARBARIAN_STEPS, VICTORY_CARDS } from '@cp2p/engine';
import {
  getBarbarianShipUrl,
  getDefenderIconUrl,
  getKnightIconUrl,
  getMerchantIconUrl,
  getMetropolisIconUrl,
  getTrackIconUrl,
} from '@cp2p/renderer';
import { DialogFrame } from '../dialogs/DialogFrame';
import { BarbarianAttackNotice } from '../knights/AttackNotice';
import { MiniTracks } from '../knights/ImprovementsBoard';
import {
  barbarianOdds,
  knightSummary,
  knightsState,
  metropolisesOf,
  progressHeld,
  shownVictoryCards,
  stepsToLanding,
} from '../knights/state';
import type { ModuleDialogProps, ModuleHudProps, ModulePanelProps, UiModule } from './registry';
import { registerUiModule } from './registry';
import '../knights/knights.css';

function nameOf(presentation: ModuleHudProps['presentation'], seat: number): string {
  return presentation.players.find((player) => player.seat === seat)?.name ?? `#${seat + 1}`;
}

/**
 * How many ship faces are left before the barbarians land. It only shows while the printed track
 * is scrolled or zoomed out of view; tapping it opens the track's dialog.
 */
export function BarbarianCountdown({ state, renderer, openFixture }: ModuleHudProps) {
  const { t } = useTranslation('knights');
  const [inView, setInView] = useState(true);
  useEffect(() => {
    if (!renderer) return undefined;
    return renderer.subscribeViewChange(() =>
      setInView(renderer.isFixtureInView(BARBARIAN_FIXTURE)),
    );
  }, [renderer]);
  const ext = knightsState(state);
  if (!ext || !renderer || inView) return null;
  const count = stepsToLanding(ext);
  return (
    <button
      className="barbarian-countdown"
      type="button"
      data-testid="barbarian-countdown"
      data-urgent={count <= 2}
      onClick={() => openFixture(BARBARIAN_FIXTURE)}
    >
      <img src={getBarbarianShipUrl()} alt="" aria-hidden="true" />
      <span>{t('knights:countdown', { count })}</span>
    </button>
  );
}

/** The barbarian track's dialog: where the ship is, the two sides of the fight and each seat's share. */
export function BarbarianDialog({ state, presentation, onClose }: ModuleDialogProps) {
  const { t } = useTranslation('knights');
  const ext = knightsState(state);
  if (!ext) return null;
  const odds = barbarianOdds(state);
  const step = ext.barbarians.step;
  const attack = ext.lastAttack;
  return (
    <DialogFrame
      title={t('knights:barbarians.title')}
      variant="trade"
      onCancel={onClose}
      footer={
        <div className="trade-dialog-footer">
          <div className="trade-dialog-buttons">
            <button className="button button-primary" type="button" onClick={onClose}>
              {t('knights:close')}
            </button>
          </div>
        </div>
      }
    >
      <div className="barbarian-dialog" data-testid="barbarian-dialog">
        <p>{t('knights:barbarians.steps', { count: stepsToLanding(ext) })}</p>
        <ol className="barbarian-steps" aria-label={t('knights:barbarians.track')}>
          {Array.from({ length: BARBARIAN_STEPS + 1 }, (_, index) => (
            <li
              key={index}
              data-here={index === step}
              data-passed={index < step}
              data-landing={index === BARBARIAN_STEPS}
              aria-current={index === step ? 'step' : undefined}
            >
              {index === step ? <img src={getBarbarianShipUrl()} alt="" /> : null}
              <span>{index === BARBARIAN_STEPS ? t('knights:barbarians.landing') : index}</span>
            </li>
          ))}
        </ol>
        <div className="barbarian-fight" data-holds={odds.holds}>
          <div>
            <strong>{odds.strength}</strong>
            <span>{t('knights:barbarians.strength')}</span>
          </div>
          <div>
            <strong>{odds.defense}</strong>
            <span>{t('knights:barbarians.defense')}</span>
          </div>
          <p role="status">
            {odds.holds ? t('knights:barbarians.holds') : t('knights:barbarians.falls')}
          </p>
        </div>
        <table className="barbarian-table">
          <caption>{t('knights:barbarians.contributions')}</caption>
          <tbody>
            {odds.bySeat.map(({ seat, level }) => {
              const summary = knightSummary(ext, seat);
              const color = presentation.players.find((player) => player.seat === seat)?.color;
              return (
                <tr key={seat}>
                  <th scope="row">
                    <img
                      src={getKnightIconUrl(color ?? 'blue', 2, true)}
                      alt=""
                      aria-hidden="true"
                    />
                    {nameOf(presentation, seat)}
                  </th>
                  <td>{t('knights:barbarians.activeLevels', { count: level })}</td>
                  <td>{t('knights:barbarians.knightsOnBoard', { count: summary.total })}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {attack && (
          <p className="muted" data-testid="barbarian-last">
            {t('knights:barbarians.last', {
              outcome: t(`knights:barbarians.outcome.${attack.outcome}`),
              strength: attack.strength,
              defense: attack.defense,
            })}
          </p>
        )}
      </div>
    </DialogFrame>
  );
}

/** A seat's Cities & Knights standing in its player panel: tracks, knights, metropolises, awards. */
export function KnightsPanelExtras({ state, seat, presentation }: ModulePanelProps) {
  const { t } = useTranslation('knights');
  const ext = knightsState(state);
  if (!ext) return null;
  const color = presentation.players.find((player) => player.seat === seat)?.color ?? 'blue';
  const knights = knightSummary(ext, seat);
  const defenders = ext.defenders[seat] ?? 0;
  const metropolises = metropolisesOf(ext, seat);
  const merchant = ext.merchant?.seat === seat;
  const shown = shownVictoryCards(state, seat);
  const cards = progressHeld(state, seat);
  return (
    <div className="knights-panel" data-testid="knights-panel">
      <MiniTracks state={state} seat={seat} />
      <div className="knights-chips">
        <span
          className="knights-chip"
          title={t('knights:panel.knights', {
            total: knights.total,
            active: knights.active,
            strength: knights.activeStrength,
          })}
          aria-label={t('knights:panel.knights', {
            total: knights.total,
            active: knights.active,
            strength: knights.activeStrength,
          })}
        >
          <img src={getKnightIconUrl(color, 2, knights.active > 0)} alt="" aria-hidden="true" />
          <b aria-hidden="true">
            {knights.active}/{knights.total}
          </b>
        </span>
        {cards > 0 && (
          <span
            className="knights-chip"
            title={t('knights:panel.progress', { count: cards })}
            aria-label={t('knights:panel.progress', { count: cards })}
          >
            <span className="knights-chip-card" aria-hidden="true" />
            <b aria-hidden="true">{cards}</b>
          </span>
        )}
        {defenders > 0 && (
          <span
            className="knights-chip is-award"
            title={t('knights:panel.defender', { count: defenders })}
            aria-label={t('knights:panel.defender', { count: defenders })}
            data-testid="defender-badge"
          >
            <img src={getDefenderIconUrl()} alt="" aria-hidden="true" />
            <b aria-hidden="true">{defenders}</b>
          </span>
        )}
        {metropolises.map((track) => (
          <span
            className="knights-chip"
            key={track}
            title={t('knights:panel.metropolis', { track: t(`knights:track.${track}`) })}
            aria-label={t('knights:panel.metropolis', { track: t(`knights:track.${track}`) })}
          >
            <img src={getMetropolisIconUrl(track, color)} alt="" aria-hidden="true" />
          </span>
        ))}
        {merchant && (
          <span
            className="knights-chip"
            title={t('knights:panel.merchant')}
            aria-label={t('knights:panel.merchant')}
          >
            <img src={getMerchantIconUrl(color)} alt="" aria-hidden="true" />
          </span>
        )}
        {shown.map((card) => (
          <span
            className="knights-chip is-award"
            key={card}
            title={t(`knights:cards.${card}.name`)}
          >
            {/* A shown Printer or Constitution: its deck's icon and the point it scores. */}
            {VICTORY_CARDS[card] && (
              <img src={getTrackIconUrl(VICTORY_CARDS[card])} alt="" aria-hidden="true" />
            )}
            <b aria-hidden="true">+1</b>
            <span className="trade-visually-hidden">{t(`knights:cards.${card}.name`)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export const knightsUi: UiModule = {
  PlayerPanelExtras: KnightsPanelExtras,
  HudWidgets: [BarbarianCountdown, BarbarianAttackNotice],
  Dialogs: { [BARBARIAN_FIXTURE]: BarbarianDialog },
};

registerUiModule('knights', knightsUi);
