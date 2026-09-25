import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hashValue, toHex } from '@cp2p/codec';
import type { CommandShape, Seat } from '@cp2p/engine';
import type { BoardRenderer } from '@cp2p/renderer';
import { LocalSession } from '../../session/local-session.js';
import type { GameSession, SessionUpdate } from '../../session/types.js';
import type { ActionAvailability } from '../actions/availability.js';

export interface DevDrawerProps {
  session: GameSession;
  renderer?: BoardRenderer | null;
  actions?: ActionAvailability | null;
  onImportSave: (raw: unknown) => Promise<void>;
  onExportSave: (save: unknown) => Promise<void>;
  onExportReplay: (save: unknown) => Promise<void>;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Diagnostic controls. The exported save is the authoritative log, not a public-state dump. */
export function DevDrawer({
  session,
  actions,
  onImportSave,
  onExportSave,
  onExportReplay,
}: DevDrawerProps) {
  const { t } = useTranslation('editor');
  const [update, setUpdate] = useState<SessionUpdate | null>(null);
  const [seat, setSeat] = useState<Seat>(session.controllableSeats()[0] ?? 0);
  const [rawCommand, setRawCommand] = useState('{}');
  const [rawSave, setRawSave] = useState('');
  const [die1, setDie1] = useState(1);
  const [die2, setDie2] = useState(1);
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => session.subscribe(setUpdate), [session]);
  if (!import.meta.env.DEV) return null;
  const state = update?.state ?? session.getState();
  const seats = session.controllableSeats();
  const legal =
    open && seats.includes(seat) ? session.getLegalCommands(seat) : { commands: [], templates: [] };
  const run = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
      setMessage(t('editor:done'));
    } catch (error) {
      setMessage(`${t('editor:failed')}: ${String(error)}`);
    }
  };
  const submitRaw = async (): Promise<void> => {
    await run(async () => {
      const parsed: unknown = JSON.parse(rawCommand);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new Error(t('editor:invalidCommand'));
      const type: unknown = Reflect.get(parsed, 'type');
      if (typeof type !== 'string') throw new Error(t('editor:invalidCommand'));
      const command: CommandShape = { ...parsed, type };
      const valid = session.validate(seat, command);
      if (!valid.ok) throw new Error(`${valid.error.code}: ${valid.error.message}`);
      const submitted = await session.submit(
        seat,
        command,
        update === null ? {} : { expectedRevision: update.revision },
      );
      if (!submitted.ok) throw new Error(`${submitted.error.code}: ${submitted.error.message}`);
    });
  };
  const forceDice = (): void => {
    if (!(session instanceof LocalSession)) return;
    const result = session.forceDice([die1, die2]);
    setMessage(result.ok ? t('editor:diceReady') : `${result.error.code}: ${result.error.message}`);
  };
  return (
    <details
      className="dev-drawer"
      data-testid="dev-drawer"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{t('editor:title')}</summary>
      {open && (
        <div className="dev-drawer-content">
          <p>{t('editor:hash', { hash: toHex(hashValue(state)) })}</p>
          <p>{t('editor:revision', { revision: update?.revision ?? 0 })}</p>
          <details>
            <summary>{t('editor:public')}</summary>
            <pre>{json(state)}</pre>
          </details>
          <details>
            <summary>{t('editor:private')}</summary>
            {state.config.seats.map((player) => (
              <details key={player}>
                <summary>{t('editor:seat', { seat: player + 1 })}</summary>
                <pre>{json(session.getPrivate(player))}</pre>
              </details>
            ))}
          </details>
          <details>
            <summary>{t('editor:pending')}</summary>
            <pre>{json(session.getPending())}</pre>
          </details>
          <details>
            <summary>{t('editor:legal')}</summary>
            <pre>{json(legal)}</pre>
          </details>
          <details>
            <summary>{t('editor:actions')}</summary>
            <pre>{json(actions ?? null)}</pre>
          </details>
          <label>
            {t('editor:commandSeat')}
            <select
              value={seat}
              onChange={(event) => {
                const next = seats.find(
                  (candidate) => candidate === Number(event.currentTarget.value),
                );
                if (next !== undefined) setSeat(next);
              }}
            >
              {seats.map((player) => (
                <option key={player} value={player}>
                  {t('editor:seat', { seat: player + 1 })}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('editor:rawCommand')}
            <textarea
              value={rawCommand}
              onChange={(event) => setRawCommand(event.currentTarget.value)}
            />
          </label>
          <button type="button" disabled={seats.length === 0} onClick={() => void submitRaw()}>
            {t('editor:applyCommand')}
          </button>
          {session instanceof LocalSession && (
            <div>
              <label>
                {t('editor:dieOne')}
                <select
                  value={die1}
                  onChange={(event) => setDie1(Number(event.currentTarget.value))}
                >
                  {[1, 2, 3, 4, 5, 6].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('editor:dieTwo')}
                <select
                  value={die2}
                  onChange={(event) => setDie2(Number(event.currentTarget.value))}
                >
                  {[1, 2, 3, 4, 5, 6].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={forceDice}>
                {t('editor:forceDice')}
              </button>
            </div>
          )}
          <div>
            <button
              type="button"
              onClick={() => void run(() => onExportSave(session.exportSave()))}
            >
              {t('editor:exportSave')}
            </button>
            <button
              type="button"
              onClick={() => void run(() => onExportReplay(session.exportSave()))}
            >
              {t('editor:exportReplay')}
            </button>
          </div>
          <label>
            {t('editor:importSave')}
            <textarea value={rawSave} onChange={(event) => setRawSave(event.currentTarget.value)} />
          </label>
          <button type="button" onClick={() => void run(() => onImportSave(JSON.parse(rawSave)))}>
            {t('editor:loadSave')}
          </button>
          {message && <p role="status">{message}</p>}
        </div>
      )}
    </details>
  );
}
