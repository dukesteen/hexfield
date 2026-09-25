import { RESOURCES, CITY_COST, DEV_COST, ROAD_COST, SETTLEMENT_COST } from '@cp2p/engine';
import { getResourceIconUrl } from '@cp2p/renderer';
import { useTranslation } from 'react-i18next';
import { DialogFrame } from '../dialogs/DialogFrame.js';
import './build-costs-dialog.css';

/** Shows the base module's canonical public prices, regardless of the current hand. */
export function BuildCostsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('game');
  const rows = [
    { id: 'road', label: t('game:buildCosts.road'), cost: ROAD_COST },
    { id: 'settlement', label: t('game:buildCosts.settlement'), cost: SETTLEMENT_COST },
    { id: 'city', label: t('game:buildCosts.city'), cost: CITY_COST },
    {
      id: 'developmentCard',
      label: t('game:buildCosts.developmentCard'),
      cost: DEV_COST,
    },
  ] as const;
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
      <section className="build-costs-panel">
        <p className="build-costs-note">{t('game:buildCostsNote')}</p>
        <dl className="build-costs-list">
          {rows.map((row) => (
            <div className="build-cost-row" key={row.id}>
              <dt>{row.label}</dt>
              <dd>
                {RESOURCES.filter((resource) => row.cost[resource] > 0).map((resource) => {
                  const count = row.cost[resource];
                  const label = t('game:buildCostResource', {
                    count,
                    resource: t(`game:${resource}`),
                  });
                  return (
                    <span
                      className="build-cost-resource"
                      role="img"
                      aria-label={label}
                      key={resource}
                    >
                      <img src={getResourceIconUrl(resource)} alt="" />
                      <span aria-hidden="true">{count}</span>
                    </span>
                  );
                })}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </DialogFrame>
  );
}
