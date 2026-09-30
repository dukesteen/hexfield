import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CHAT_LENGTH_LIMIT, encodeReplayString, tooLongForChat } from './replay-document.js';
import type { ReplayExport as Exported } from './replay-load.js';

function download(fileName: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Download the replay file, or copy it as one `HXREPLAY1.` string. */
export function ReplayExport({ exported }: { exported: () => Exported }) {
  const { t } = useTranslation('game');
  const [text, setText] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'busy' | 'copied' | 'shown' | 'failed'>('idle');
  const copy = async () => {
    setStatus('busy');
    try {
      const value = text ?? (await encodeReplayString(exported().document));
      setText(value);
      try {
        await navigator.clipboard.writeText(value);
        setStatus('copied');
      } catch {
        // The string stays below for copying by hand.
        setStatus('shown');
      }
    } catch {
      setStatus('failed');
    }
  };
  return (
    <section className="replay-export" aria-label={t('game:replay.export')}>
      <div className="replay-export-actions">
        <button
          type="button"
          className="button button-quiet"
          onClick={() => {
            const value = exported();
            download(value.fileName, value.json);
          }}
        >
          {t('game:replay.downloadJson')}
        </button>
        <button
          type="button"
          className="button button-quiet"
          disabled={status === 'busy'}
          onClick={() => void copy()}
        >
          {t('game:replay.copyString')}
        </button>
      </div>
      {status === 'copied' && <p role="status">{t('game:replay.copied')}</p>}
      {status === 'shown' && <p role="status">{t('game:replay.copyByHand')}</p>}
      {status === 'failed' && <p role="alert">{t('game:replay.copyFailed')}</p>}
      {text !== null && (
        <>
          {tooLongForChat(text) && (
            <p className="replay-warning" role="note">
              {t('game:replay.tooLongForChat', {
                count: text.length,
                limit: CHAT_LENGTH_LIMIT,
              })}
            </p>
          )}
          <label className="replay-string">
            <span>{t('game:replay.string')}</span>
            <textarea
              readOnly
              rows={3}
              value={text}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
        </>
      )}
    </section>
  );
}
