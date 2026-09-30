import { fromBase64Url } from '@cp2p/codec';
import { Link, useNavigate } from '@tanstack/react-router';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { importPublicReplay } from '../../session/online-public-archive-client.js';
import { MAX_ONLINE_PUBLIC_ARCHIVE_BYTES } from '../../session/online-public-archive-format.js';
import { replayFailureMessage } from '../online/replay-failure.js';
import {
  archiveBytes,
  decodeReplayString,
  parseReplayDocument,
  REPLAY_STRING_PREFIX,
} from './replay-document.js';
import { loadLocalReplay } from './replay-load.js';
import type { LoadedReplay } from './replay-load.js';
import { ReplayViewer } from './ReplayViewer.js';
import './replay-viewer.css';

const ARCHIVE_MAGIC = [0x48, 0x58, 0x41, 0x52, 0x31]; // HXAR1

function isArchive(bytes: Uint8Array): boolean {
  return ARCHIVE_MAGIC.every((byte, index) => bytes[index] === byte);
}

/** Opens a pasted `HXREPLAY1.` string or a replay file; every kind is verified before viewing. */
export function ReplayImport() {
  const { t } = useTranslation(['game', 'lobby']);
  const navigate = useNavigate();
  const textId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loaded, setLoaded] = useState<LoadedReplay | null>(null);
  const playerName = (seat: number) => t('lobby:defaultPlayerName', { number: seat + 1 });

  const openArchive = async (
    bytes: Uint8Array,
    masters?: { seat: number; master: Uint8Array }[],
  ) => {
    const id = await importPublicReplay(bytes, undefined, masters);
    await navigate({ to: '/replay/$archiveId', params: { archiveId: id } });
  };

  const openValue = async (value: unknown) => {
    const parsed = parseReplayDocument(value);
    if (parsed.kind === 'online') {
      await openArchive(
        archiveBytes(parsed.document),
        parsed.document.masters?.map((item) => ({
          seat: item.seat,
          master: fromBase64Url(item.master),
        })),
      );
      return;
    }
    // Let the "verifying" status paint before the whole game is replayed.
    await new Promise((resolve) => setTimeout(resolve, 16));
    setLoaded(
      parsed.kind === 'local'
        ? loadLocalReplay({ document: parsed.document }, playerName)
        : loadLocalReplay({ file: parsed.replay }, playerName),
    );
  };

  const run = async (task: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (failed) {
      setError(failed ?? new Error('Replay import failed'));
    } finally {
      setBusy(false);
    }
  };

  const openText = (value: string) =>
    run(async () => {
      const trimmed = value.trim();
      await openValue(
        trimmed.startsWith(REPLAY_STRING_PREFIX)
          ? await decodeReplayString(trimmed)
          : (JSON.parse(trimmed) as unknown),
      );
    });

  const openFile = (file: File | undefined) => {
    if (!file) return;
    void run(async () => {
      try {
        // Check the size before reading so a huge file never enters memory.
        if (file.size < 1 || file.size > MAX_ONLINE_PUBLIC_ARCHIVE_BYTES * 2)
          throw new Error('Replay file size is invalid');
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (isArchive(bytes)) await openArchive(bytes);
        else {
          const content = new TextDecoder().decode(bytes).trim();
          await openValue(
            content.startsWith(REPLAY_STRING_PREFIX)
              ? await decodeReplayString(content)
              : (JSON.parse(content) as unknown),
          );
        }
      } finally {
        if (input.current) input.current.value = '';
      }
    });
  };

  if (loaded)
    return (
      <ReplayViewer
        loaded={loaded}
        title={t('game:replay.title', {
          players: loaded.presentation.players.map((player) => player.name).join(' · '),
        })}
        back={
          <button type="button" className="text-link" onClick={() => setLoaded(null)}>
            {t('game:replay.importAnother')}
          </button>
        }
      />
    );

  return (
    <main className="app-page replay-page">
      <div className="replay-import">
        <Link to="/" className="text-link">
          {t('lobby:backHome')}
        </Link>
        <h1>{t('game:replay.importTitle')}</h1>
        <p className="muted">{t('game:replay.importIntro')}</p>
        <label htmlFor={textId}>{t('game:replay.pasteLabel')}</label>
        <textarea
          id={textId}
          value={text}
          spellCheck={false}
          placeholder={`${REPLAY_STRING_PREFIX}…`}
          onChange={(event) => setText(event.currentTarget.value)}
        />
        <div className="replay-import-actions">
          <button
            type="button"
            className="button button-primary"
            disabled={busy || text.trim() === ''}
            onClick={() => void openText(text)}
          >
            {t('game:replay.open')}
          </button>
          <input
            ref={input}
            hidden
            type="file"
            accept=".json,.hxar,application/json,application/octet-stream,text/plain"
            aria-label={t('game:replay.chooseFile')}
            onChange={(event) => openFile(event.currentTarget.files?.[0])}
          />
          <button
            type="button"
            className="button button-quiet"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            {t('game:replay.chooseFile')}
          </button>
        </div>
        {busy && <p role="status">{t('lobby:publicReplayVerifying')}</p>}
        {error !== null && (
          <p role="alert">
            {error instanceof Error && error.name === 'PublicReplayVersionError'
              ? replayFailureMessage(error, t)
              : t('game:replay.importFailed')}
          </p>
        )}
      </div>
    </main>
  );
}
