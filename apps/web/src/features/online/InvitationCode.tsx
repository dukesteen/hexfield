import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invitationQr } from './qr-code';
import { scanInvitationQr } from './qr-scanner';
import './invitation-code.css';

export function InvitationCode({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation('lobby');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const qr = useMemo(() => {
    try {
      return invitationQr(value);
    } catch {
      return null;
    }
  }, [value]);
  useEffect(() => {
    setCopied(false);
    setCopyError(false);
  }, [value]);

  return (
    <div className="invitation-code">
      {qr && (
        <svg
          className="invitation-qr"
          viewBox={`0 0 ${qr.size} ${qr.size}`}
          role="img"
          aria-label={t('lobby:invitationQrLabel', { label })}
          shapeRendering="crispEdges"
        >
          <rect width={qr.size} height={qr.size} fill="#fff" />
          <path d={qr.path} fill="#000" />
        </svg>
      )}
      <div className="invitation-code-text">
        <label>
          {label}
          <textarea
            value={value}
            readOnly
            rows={3}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
        <div className="invitation-code-actions">
          <button
            className="button button-quiet"
            type="button"
            onClick={() => {
              if (!navigator.clipboard) {
                setCopyError(true);
                return;
              }
              void navigator.clipboard.writeText(value).then(
                () => {
                  setCopied(true);
                  setCopyError(false);
                  return undefined;
                },
                () => setCopyError(true),
              );
            }}
          >
            {t(copied ? 'lobby:onlineInviteCopied' : 'lobby:invitationCopyCode')}
          </button>
          {typeof navigator.share === 'function' && (
            <button
              className="button button-quiet"
              type="button"
              onClick={() => {
                void navigator.share({ text: value }).catch(() => undefined);
              }}
            >
              {t('lobby:invitationShare')}
            </button>
          )}
        </div>
        {copyError && <p role="alert">{t('lobby:onlineCopyFailed')}</p>}
        {(!qr || qr.version > 25) && <p className="muted">{t('lobby:invitationDenseQr')}</p>}
      </div>
    </div>
  );
}

export function ScanInvitation({ onRead }: { onRead: (value: string) => void }) {
  const { t } = useTranslation('lobby');
  const [active, setActive] = useState(false);
  const [failed, setFailed] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const read = useRef(onRead);
  useEffect(() => {
    read.current = onRead;
  }, [onRead]);
  useEffect(() => {
    if (!active || !video.current) return undefined;
    const abort = new AbortController();
    void scanInvitationQr(video.current, abort.signal).then(
      (value) => {
        if (abort.signal.aborted) return undefined;
        setActive(false);
        read.current(value);
        return undefined;
      },
      () => {
        if (abort.signal.aborted) return undefined;
        setActive(false);
        setFailed(true);
        return undefined;
      },
    );
    return () => abort.abort();
  }, [active]);
  return (
    <div className="invitation-scanner">
      {active && (
        <video ref={video} muted playsInline aria-label={t('lobby:invitationCameraPreview')} />
      )}
      <button
        className="button button-quiet"
        type="button"
        onClick={() => {
          setFailed(false);
          setActive(!active);
        }}
      >
        {t(active ? 'lobby:invitationStopCamera' : 'lobby:invitationScan')}
      </button>
      {failed && <p role="alert">{t('lobby:invitationCameraFailed')}</p>}
    </div>
  );
}
