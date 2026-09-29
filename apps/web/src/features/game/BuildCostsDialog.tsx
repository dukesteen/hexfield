import {
  isBaseResource,
  RESOURCES,
  CITY_COST,
  DEV_COST,
  MAX_LEVEL,
  ROAD_COST,
  SETTLEMENT_COST,
  TRACKS,
  TRACK_COMMODITY,
} from '@cp2p/engine';
import type { CardCounts } from '@cp2p/engine';
import { getCommodityIconUrl, getResourceIconUrl, getTrackIconUrl } from '@cp2p/renderer';
import { useTranslation } from 'react-i18next';
import { DialogFrame } from '../dialogs/DialogFrame.js';
import { KNIGHT_COST_TABLE } from '../knights/costs.js';
import { isCommodity } from '../knights/state.js';
import './build-costs-dialog.css';

/** Every card kind a price can name: the five resources, then the commodities. */
const PRICE_KINDS = [...RESOURCES, 'cloth', 'coin', 'paper'] as const;

function kindIcon(kind: string): string {
  if (isCommodity(kind)) return getCommodityIconUrl(kind);
  return getResourceIconUrl(isBaseResource(kind) ? kind : 'brick');
}

/** The card kind's name: resources live in `game`, commodities in `knights`. */
function useKindName() {
  const { t } = useTranslation(['game', 'knights']);
  return (kind: string): string =>
    isCommodity(kind) ? t(`knights:commodity.${kind}`) : t(`game:${kind}`);
}

function CostChips({ cost }: { cost: CardCounts }) {
  const { t } = useTranslation('game');
  const name = useKindName();
  return (
    <>
      {PRICE_KINDS.filter((kind) => (cost[kind] ?? 0) > 0).map((kind) => {
        const count = cost[kind] ?? 0;
        const label = t('game:buildCostResource', { count, resource: name(kind) });
        return (
          <span className="build-cost-resource" role="img" aria-label={label} key={kind}>
            <img src={kindIcon(kind)} alt="" />
            <span aria-hidden="true">{count}</span>
          </span>
        );
      })}
    </>
  );
}

/**
 * Shows the game's canonical public prices, regardless of the current hand. A Cities and Knights
 * game swaps the development card for its knights, walls and city improvements.
 */
export function BuildCostsDialog({
  onClose,
  knights = false,
}: {
  onClose: () => void;
  knights?: boolean;
}) {
  const { t } = useTranslation(['game', 'knights']);
  const rows = [
    { id: 'road', label: t('game:buildCosts.road'), cost: ROAD_COST },
    { id: 'settlement', label: t('game:buildCosts.settlement'), cost: SETTLEMENT_COST },
    { id: 'city', label: t('game:buildCosts.city'), cost: CITY_COST },
    ...(knights
      ? []
      : [
          {
            id: 'developmentCard',
            label: t('game:buildCosts.developmentCard'),
            cost: DEV_COST,
          },
        ]),
  ];
  const knightRows = [
    { id: 'knight', label: t('knights:build.knight'), cost: KNIGHT_COST_TABLE.knight },
    { id: 'promote', label: t('knights:build.promote'), cost: KNIGHT_COST_TABLE.promote },
    { id: 'activate', label: t('knights:build.activate'), cost: KNIGHT_COST_TABLE.activate },
    { id: 'wall', label: t('knights:build.wall'), cost: KNIGHT_COST_TABLE.cityWall },
  ];
  return (
    <DialogFrame
      title={t('game:buildCostsTitle')}
      onCancel={onClose}
      footer={
        <div className="build-costs-footer">
          <button className="button button-primary" type="button" onClick={onClose}>
            {t('game:buildCostsClose')}
          </button>
        </div>
      }
    >
      <section className="build-costs-panel" data-knights={knights}>
        <p className="build-costs-note">{t('game:buildCostsNote')}</p>
        <dl className="build-costs-list">
          {rows.map((row) => (
            <div className="build-cost-row" key={row.id}>
              <dt>{row.label}</dt>
              <dd>
                <CostChips cost={row.cost} />
              </dd>
            </div>
          ))}
        </dl>
        {knights && (
          <>
            <h3 className="build-costs-heading">{t('knights:costs.knightsHeading')}</h3>
            <dl className="build-costs-list" data-testid="knight-costs">
              {knightRows.map((row) => (
                <div className="build-cost-row" key={row.id} data-cost={row.id}>
                  <dt>{row.label}</dt>
                  <dd>
                    <CostChips cost={row.cost} />
                  </dd>
                </div>
              ))}
            </dl>
            <h3 className="build-costs-heading">{t('knights:costs.improvementsHeading')}</h3>
            <p className="build-costs-note">{t('knights:costs.improvementsNote')}</p>
            <dl className="build-costs-list" data-testid="improvement-costs">
              {TRACKS.map((track) => {
                const commodity = TRACK_COMMODITY[track];
                return (
                  <div className="build-cost-row" key={track} data-cost={track}>
                    <dt className="build-cost-track">
                      <img src={getTrackIconUrl(track)} alt="" aria-hidden="true" />
                      {t(`knights:track.${track}`)}
                    </dt>
                    <dd className="build-cost-levels">
                      {Array.from({ length: MAX_LEVEL }, (_, index) => {
                        const level = index + 1;
                        return (
                          <span
                            className="build-cost-level"
                            role="img"
                            key={level}
                            aria-label={t('knights:costs.levelCost', {
                              level,
                              cost: t('game:buildCostResource', {
                                count: level,
                                resource: t(`knights:commodity.${commodity}`),
                              }),
                            })}
                          >
                            <img src={kindIcon(commodity)} alt="" aria-hidden="true" />
                            <b aria-hidden="true">{level}</b>
                          </span>
                        );
                      })}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </>
        )}
      </section>
    </DialogFrame>
  );
}
