import type { MapReport } from '@cp2p/maps';
import { useTranslation } from 'react-i18next';
import { problemText } from './labels';

/** Live findings: errors block export and play, warnings are advice. */
export function ValidationPanel({ report }: { report: MapReport }) {
  const { t } = useTranslation(['editor', 'game', 'common', 'lobby']);
  const clean = report.errors.length === 0 && report.warnings.length === 0;
  return (
    <section
      className="map-check"
      aria-labelledby="map-check-title"
      data-state={
        report.errors.length > 0 ? 'error' : report.warnings.length > 0 ? 'warning' : 'ok'
      }
    >
      <h2 id="map-check-title">
        {report.errors.length > 0
          ? t('editor:mapCheckErrors', { count: report.errors.length })
          : t('editor:mapCheckPlayable')}
      </h2>
      {clean && <p className="muted">{t('editor:mapCheckClean')}</p>}
      <ul className="map-problems" aria-live="polite">
        {report.errors.map((problem) => (
          <li key={`e-${problem.code}`} className="is-error" data-code={problem.code}>
            <span className="map-problem-badge">{t('editor:mapError')}</span>
            {problemText(t, problem)}
          </li>
        ))}
        {report.warnings.map((problem) => (
          <li
            key={`w-${problem.code}-${String(problem.values?.terrain ?? '')}`}
            className="is-warning"
            data-code={problem.code}
          >
            <span className="map-problem-badge">{t('editor:mapWarning')}</span>
            {problemText(t, problem)}
          </li>
        ))}
      </ul>
    </section>
  );
}
