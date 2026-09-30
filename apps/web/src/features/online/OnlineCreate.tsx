import type { BaseOptions, GameConfig } from '@cp2p/engine';
import {
  defaultScenario,
  mapConfig,
  mapSeatCounts,
  scenarioAtSeats,
  scenarioConfig,
  type MapDef,
  type Scenario,
} from '@cp2p/maps';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { useSettings } from '../../queries/hooks';
import { DEFAULT_NETWORK_SETTINGS, effectiveNetworkSettings } from '../../queries/network-config';
import { beginOnlineRoomOpen, closeOnlineRoom } from './room-registry.js';
import { ScenarioPicker, isSeafaringScenario } from '../setup/ScenarioPicker';
import { CustomMapPicker, useCustomMapProblem } from '../setup/CustomMapPicker';
import { MAX_PLAYERS, MIN_PLAYERS } from '../players/identity';
import './online.css';

const PLAYER_COUNTS = Array.from(
  { length: MAX_PLAYERS - MIN_PLAYERS + 1 },
  (_, index) => MIN_PLAYERS + index,
);
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
  const serverUrl =
    serverInput ??
    (settings.data
      ? effectiveNetworkSettings(settings.data.network).signalingUrl
      : DEFAULT_NETWORK_SETTINGS.signalingUrl);
  const [connectionInput, setConnectionInput] = useState<'manual' | 'server' | null>(null);
  const connection = connectionInput ?? (serverUrl ? 'server' : 'manual');
  const [seatCount, setSeatCount] = useState(4);
  const [scenario, setScenario] = useState<Scenario>(() => defaultScenario(4));
  const [mapLayout, setMapLayout] = useState<BaseOptions['mapLayout']>('balanced-random');
  const [vpTarget, setVpTarget] = useState(10);
  const [useCustom, setUseCustom] = useState(false);
  const [customMap, setCustomMap] = useState<MapDef | null>(null);
  const customProblem = useCustomMapProblem(useCustom ? customMap : null, seatCount);
  /** A scenario brings its own victory target, so the field follows the choice. */
  const chooseScenario = (next: Scenario) => {
    setUseCustom(false);
    setScenario(next);
    setVpTarget(next.vpTarget);
  };
  /** A custom map brings its target, and the seat count moves into the map's range. */
  const chooseMap = (map: MapDef) => {
    setCustomMap(map);
    setVpTarget(map.vpTarget);
    const counts = mapSeatCounts(map);
    if (counts.length > 0 && !counts.includes(seatCount))
      setSeatCount(counts.find((item) => item >= seatCount) ?? counts.at(-1) ?? seatCount);
  };
  const changeSeatCount = (count: number) => {
    setSeatCount(count);
    if (useCustom) return;
    // An expansion map follows the seat count into its 3–4 or 5–6 player version.
    const next = scenarioAtSeats(scenario, count) ?? defaultScenario(count);
    if (next !== scenario) chooseScenario(next);
  };
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
    let config: GameConfig = scenarioConfig(scenario, seatCount, { base: { ...options } });
    if (useCustom) {
      const custom =
        customMap && customProblem === null
          ? mapConfig(customMap, seatCount, { base: { ...options } })
          : null;
      if (!custom?.ok) {
        setError(true);
        setBusy(false);
        return;
      }
      config = custom.value;
    }
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
            <p className="muted">
              {t(
                connection === 'server'
                  ? 'lobby:onlineInviteDescription'
                  : 'lobby:manualConnectionHint',
              )}
            </p>
            <details className="online-connection-options">
              <summary>{t('lobby:onlineAdvancedConnection')}</summary>
              <div className="online-connection-fields">
                <label>
                  {t('lobby:manualConnectionMethod')}
                  <select
                    value={connection}
                    onChange={(event) =>
                      setConnectionInput(event.target.value === 'server' ? 'server' : 'manual')
                    }
                  >
                    <option value="server">{t('lobby:manualConnectionServer')}</option>
                    <option value="manual">{t('lobby:manualConnectionCodes')}</option>
                  </select>
                </label>
                {connection === 'server' && (
                  <div>
                    <label>
                      {t('lobby:onlineServerOrigin')}
                      <input
                        type="url"
                        autoComplete="url"
                        aria-describedby="online-server-hint"
                        required
                        value={serverUrl}
                        onChange={(event) => setServerInput(event.target.value)}
                        onInvalid={(event) => {
                          const options = event.currentTarget.closest('details');
                          if (options) options.open = true;
                        }}
                      />
                    </label>
                    <p className="muted" id="online-server-hint">
                      {t('lobby:onlineServerHint')}
                    </p>
                  </div>
                )}
              </div>
            </details>
          </fieldset>
          <fieldset>
            <legend>{t('lobby:onlineGameSetup')}</legend>
            <label>
              {t('lobby:playerCount')}
              <select
                value={seatCount}
                onChange={(event) => changeSeatCount(Number(event.target.value))}
              >
                {PLAYER_COUNTS.map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </label>
            <ScenarioPicker
              online
              seatCount={seatCount}
              scenarioId={scenario.id}
              onScenario={chooseScenario}
              onSeatCount={changeSeatCount}
              custom={{
                selected: useCustom,
                modules: customMap?.modules ?? [],
                onSelect: () => setUseCustom(true),
              }}
            />
            {useCustom && (
              <CustomMapPicker
                seatCount={seatCount}
                map={customMap}
                problem={customProblem}
                onMap={chooseMap}
              />
            )}
            {!useCustom &&
              scenario.board.kind === 'generator' &&
              !isSeafaringScenario(scenario) && (
                <label>
                  {t('lobby:mapLayout')}
                  <select
                    value={mapLayout}
                    onChange={(event) =>
                      setMapLayout(event.target.value === 'random' ? 'random' : 'balanced-random')
                    }
                  >
                    <option value="balanced-random">{t('lobby:mapBalanced')}</option>
                    <option value="random">{t('lobby:mapRandom')}</option>
                  </select>
                </label>
              )}
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
          <button
            className="button button-primary"
            type="submit"
            disabled={
              busy || settings.isLoading || (useCustom && (!customMap || customProblem !== null))
            }
          >
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
