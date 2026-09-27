import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invitationQr } from './qr-code';
import { scanInvitationQr } from './qr-scanner';
import './invitation-code.css';

export function InvitationCode({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation('lobby');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const qrTitleId = useId();
  const qrDialog = useRef<HTMLDialogElement>(null);
  const qrTrigger = useRef<HTMLButtonElement>(null);
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
  useEffect(() => {
    const dialog = qrDialog.current;
    if (!dialog) return undefined;
    if (qrOpen && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.open = true;
    } else if (!qrOpen && dialog.open) {
      dialog.close?.();
    }
    return () => {
      if (dialog.open) dialog.close?.();
    };
  }, [qrOpen]);

  const qrImage = (className: string) =>
    qr && (
      <svg
        className={className}
        viewBox={`0 0 ${qr.size} ${qr.size}`}
        role="img"
        aria-label={t('lobby:invitationQrLabel', { label })}
        shapeRendering="crispEdges"
      >
        <rect width={qr.size} height={qr.size} fill="#fff" />
        <path d={qr.path} fill="#000" />
      </svg>
    );

  return (
    <div className="invitation-code">
      {qr && (
        <button
          ref={qrTrigger}
          className="invitation-qr-trigger"
          type="button"
          aria-label={t('lobby:invitationQrEnlarge', { label })}
          aria-haspopup="dialog"
          onClick={() => setQrOpen(true)}
        >
          {qrImage('invitation-qr')}
        </button>
      )}
      <div className="invitation-code-text">
        <label>
          {label}
          <textarea
            aria-label={label}
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
      {qr && (
        <dialog
          ref={qrDialog}
          className="app-dialog invitation-qr-dialog"
          aria-labelledby={qrTitleId}
          onCancel={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setQrOpen(false);
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) setQrOpen(false);
          }}
          onClose={(event) => {
            event.stopPropagation();
            setQrOpen(false);
            qrTrigger.current?.focus();
          }}
        >
          <header className="section-heading">
            <h2 id={qrTitleId}>{t('lobby:invitationQrEnlarged', { label })}</h2>
            <button
              className="button button-quiet"
              type="button"
              aria-label={t('lobby:invitationQrClose')}
              onClick={() => setQrOpen(false)}
            >
              {t('lobby:invitationQrClose')}
            </button>
          </header>
          {qrImage('invitation-qr-large')}
        </dialog>
      )}
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
