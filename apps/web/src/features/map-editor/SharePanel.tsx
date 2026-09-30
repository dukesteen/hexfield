import { Link } from '@tanstack/react-router';
import { MAP_LIMITS, encodeMap, importMap, mapJson, validateMap } from '@cp2p/maps';
import type { MapDef, MapProblem } from '@cp2p/maps';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { problemText } from './labels';

/** Links longer than this may be cut off by chat apps; the string still works. */
const LONG_LINK = 2_000;

export function editorLink(text: string): string {
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}#/editor?map=${text}`;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function download(name: string, json: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${name.replaceAll(/[^A-Za-z0-9 _-]/g, '').trim() || 'map'}.hexmap.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

interface SharePanelProps {
  readonly map: MapDef;
  readonly blocked: boolean;
  readonly onImport: (map: MapDef) => void;
}

/** Export as a string, a file or a link (valid maps only), and import by paste or file. */
export function SharePanel({ map, blocked, onImport }: SharePanelProps) {
  const { t } = useTranslation(['editor', 'game', 'common', 'lobby']);
  const key = mapJson(map);
  const [shared, setShared] = useState<{ key: string; text: string } | null>(null);
  const [refused, setRefused] = useState<readonly MapProblem[]>([]);
  const [status, setStatus] = useState('');
  const [pasted, setPasted] = useState('');
  const [importError, setImportError] = useState('');
  const current = shared?.key === key ? shared.text : null;

  useEffect(() => {
    setRefused([]);
    setStatus('');
  }, [key]);

  const exportMap = async () => {
    // The genesis dry run catches what only the engine can see (a fixture with no room, say).
    const report = validateMap(map, { engine: true });
    setRefused(report.errors);
    if (report.errors.length > 0) return;
    setShared({ key, text: await encodeMap(map) });
  };
  const readImport = async (text: string) => {
    setImportError('');
    const result = await importMap(text);
    if (!result.ok) {
      setImportError(
        result.error.code === 'MAP_TOO_LARGE'
          ? t('editor:mapImportTooLarge')
          : t('editor:mapImportInvalid'),
      );
      return;
    }
    setPasted('');
    onImport(result.value);
    setStatus(t('editor:mapImported', { name: result.value.name }));
  };

  return (
    <section className="map-share" aria-labelledby="map-share-title">
      <h2 id="map-share-title">{t('editor:mapShareTitle')}</h2>
      {blocked ? (
        <p className="muted">{t('editor:mapShareBlocked')}</p>
      ) : (
        <button type="button" className="button button-primary" onClick={() => void exportMap()}>
          {t('editor:mapExport')}
        </button>
      )}
      {refused.length > 0 && (
        <ul className="map-problems" role="alert">
          {refused.map((problem) => (
            <li key={problem.code} className="is-error">
              {problemText(t, problem)}
            </li>
          ))}
        </ul>
      )}
      {current && !blocked && (
        <div className="map-share-result">
          <label>
            {t('editor:mapShareString')}
            <textarea
              readOnly
              rows={3}
              value={current}
              data-testid="map-share-string"
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <div className="map-share-actions">
            <button
              type="button"
              className="button button-quiet"
              onClick={() =>
                void copy(current).then((ok) =>
                  setStatus(ok ? t('editor:mapCopied') : t('editor:mapCopyFailed')),
                )
              }
            >
              {t('editor:mapCopyString')}
            </button>
            <button
              type="button"
              className="button button-quiet"
              onClick={() =>
                void copy(editorLink(current)).then((ok) =>
                  setStatus(ok ? t('editor:mapCopied') : t('editor:mapCopyFailed')),
                )
              }
            >
              {t('editor:mapCopyLink')}
            </button>
            <button
              type="button"
              className="button button-quiet"
              onClick={() => download(map.name, key)}
            >
              {t('editor:mapDownload')}
            </button>
            <Link
              to="/local/new"
              search={{ custom: current }}
              className="button button-primary"
              data-testid="map-play"
            >
              {t('editor:mapPlay')}
            </Link>
          </div>
          {editorLink(current).length > LONG_LINK && (
            <small className="muted">{t('editor:mapLongLink')}</small>
          )}
        </div>
      )}
      {status && (
        <p className="muted" role="status">
          {status}
        </p>
      )}
      <details className="map-import">
        <summary>{t('editor:mapImportTitle')}</summary>
        <label>
          {t('editor:mapImportPaste')}
          <textarea
            rows={3}
            value={pasted}
            maxLength={MAP_LIMITS.jsonBytes}
            spellCheck={false}
            placeholder="HXMAP1.…"
            onChange={(event) => setPasted(event.target.value)}
          />
        </label>
        <div className="map-share-actions">
          <button
            type="button"
            className="button button-quiet"
            disabled={pasted.trim() === ''}
            onClick={() => void readImport(pasted)}
          >
            {t('editor:mapImport')}
          </button>
          <label className="button button-quiet map-file-button">
            {t('editor:mapImportFile')}
            <input
              type="file"
              accept=".json,.txt,application/json,text/plain"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                if (file.size > MAP_LIMITS.jsonBytes) {
                  setImportError(t('editor:mapImportTooLarge'));
                  return;
                }
                void file.text().then(readImport);
              }}
            />
          </label>
        </div>
        {importError && <p role="alert">{importError}</p>}
      </details>
    </section>
  );
}
