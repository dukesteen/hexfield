import { baseModule, type BaseOptions, type GameConfig } from '@cp2p/engine';
import { standardFixedBoard } from '@cp2p/maps';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { useSettings } from '../../queries/hooks';
import { beginOnlineRoomOpen, closeOnlineRoom } from './room-registry.js';
import './online.css';

const seats = [0, 1, 2, 3] as const;
const DEFAULT_OPTIONS: BaseOptions = {
  vpTarget: 10,
  discardLimit: 7,
  friendlyRobber: false,
  mapLayout: 'balanced-random',
  strictBalance: false,
  playerTrades: true,
  diceMode: 'random',
  turnTimer: null,
  hideBankCounts: false,
};

export function OnlineCreate() {
  const { t } = useTranslation('lobby');
  const navigate = useNavigate();
  const settings = useSettings();
  const openingRef = useRef<ReturnType<typeof beginOnlineRoomOpen> | null>(null);
  const liveRef = useRef(true);
  const [name, setName] = useState('');
  const [hostName, setHostName] = useState('');
  const [serverInput, setServerInput] = useState<string | null>(null);
  const serverUrl = serverInput ?? settings.data?.network.signalingUrl ?? '';
  const [connection, setConnection] = useState<'manual' | 'server'>('manual');
  const [seatCount, setSeatCount] = useState(4);
  const [mapLayout, setMapLayout] = useState<BaseOptions['mapLayout']>('balanced-random');
  const [vpTarget, setVpTarget] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
      openingRef.current?.cancel();
    };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(false);
    const options: BaseOptions = { ...DEFAULT_OPTIONS, mapLayout, vpTarget };
    const config: GameConfig = {
      modules: [{ id: 'base', version: baseModule().version }],
      seats: seats.slice(0, seatCount),
      options: { base: options },
      ...(mapLayout === 'standard-fixed' ? { board: standardFixedBoard() } : {}),
    };
    const opening = beginOnlineRoomOpen(`host:${crypto.randomUUID()}`, {
      kind: 'host',
      serverUrl: connection === 'manual' ? '' : serverUrl,
      name: name.trim(),
      hostName: hostName.trim(),
      config,
    });
    openingRef.current = opening;
    let openedRoomId: string | null = null;
    try {
      const room = await opening.promise;
      openedRoomId = room.invite.roomId;
      opening.keep();
      await navigate({ to: '/lobby/$lobbyId', params: { lobbyId: room.invite.roomId } });
    } catch {
      opening.cancel();
      if (openedRoomId) await closeOnlineRoom(openedRoomId).catch(() => undefined);
      if (liveRef.current) setError(true);
    } finally {
      if (openingRef.current === opening) openingRef.current = null;
      if (liveRef.current) setBusy(false);
    }
  };

  return (
    <main className="app-page form-page online-page">
      <header className="app-header">
        <Link to="/" className="text-link">
          {t('lobby:backHome')}
        </Link>
        <span className="app-brand">{t('lobby:onlineCreateTitle')}</span>
      </header>
      <div className="form-page-content setup-content">
        <h1>{t('lobby:onlineCreateTitle')}</h1>
        <p className="muted">{t('lobby:onlineCreateDescription')}</p>
        <form onSubmit={(event) => void submit(event)} className="setup-form online-form">
          <fieldset>
            <legend>{t('lobby:onlineConnection')}</legend>
            <label>
              {t('lobby:onlineRoomName')}
              <input
                autoComplete="off"
                maxLength={40}
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              {t('lobby:onlineHostName')}
              <input
                autoComplete="nickname"
                maxLength={40}
                required
                value={hostName}
                onChange={(event) => setHostName(event.target.value)}
              />
            </label>
            <label>
              {t('lobby:manualConnectionMethod')}
              <select
                value={connection}
                onChange={(event) =>
                  setConnection(event.target.value === 'server' ? 'server' : 'manual')
                }
              >
                <option value="manual">{t('lobby:manualConnectionCodes')}</option>
                <option value="server">{t('lobby:manualConnectionServer')}</option>
              </select>
            </label>
            {connection === 'server' && (
              <label>
                {t('lobby:onlineServerOrigin')}
                <input
                  autoComplete="url"
                  required
                  value={serverUrl}
                  onChange={(event) => setServerInput(event.target.value)}
                />
              </label>
            )}
            <p className="muted">
              {t(connection === 'server' ? 'lobby:onlineServerHint' : 'lobby:manualConnectionHint')}
            </p>
          </fieldset>
          <fieldset>
            <legend>{t('lobby:onlineGameSetup')}</legend>
            <label>
              {t('lobby:playerCount')}
              <select
                value={seatCount}
                onChange={(event) => setSeatCount(Number(event.target.value))}
              >
                {[2, 3, 4].map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('lobby:mapLayout')}
              <select
                value={mapLayout}
                onChange={(event) => {
                  const value = event.target.value;
                  setMapLayout(
                    value === 'random' || value === 'standard-fixed' || value === 'balanced-random'
                      ? value
                      : 'balanced-random',
                  );
                }}
              >
                <option value="balanced-random">{t('lobby:mapBalanced')}</option>
                <option value="random">{t('lobby:mapRandom')}</option>
                <option value="standard-fixed">{t('lobby:mapFixed')}</option>
              </select>
            </label>
            <label>
              {t('lobby:vpTarget')}
              <input
                type="number"
                min={3}
                max={20}
                required
                value={vpTarget}
                onChange={(event) => setVpTarget(Number(event.target.value))}
              />
            </label>
          </fieldset>
          {error && <p role="alert">{t('lobby:onlineOpenFailed')}</p>}
          <button className="button button-primary" type="submit" disabled={busy}>
            {busy ? t('lobby:onlineOpening') : t('lobby:onlineCreateAction')}
          </button>
        </form>
        <p className="online-secondary-link">
          {t('lobby:onlineAlreadyInvited')} <Link to="/join">{t('lobby:onlineJoinLink')}</Link>
        </p>
      </div>
    </main>
  );
}
