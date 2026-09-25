import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { baseModule, type BaseOptions } from '@cp2p/engine';
import { standardFixedBoard } from '@cp2p/maps';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import * as v from 'valibot';
import { useSaveGame } from '../../queries/hooks';
import type { GamePresentation } from '../../queries/repositories/saved-games';
import { LocalSession } from '../../session';
import { PlayerMarker } from '../../features/game/PlayerMarker.js';

export const newGameSearchSchema = v.object({
  map: v.optional(v.picklist(['balanced-random', 'random', 'standard-fixed'])),
});

export const Route = createFileRoute('/local/new')({
  validateSearch: newGameSearchSchema,
  component: NewLocalGame,
});

const COLORS = ['blue', 'orange', 'green', 'magenta'] as const;
type PlayerColor = (typeof COLORS)[number];
type PlayerShape = 'circle' | 'triangle' | 'square' | 'diamond';

function isPlayerColor(value: string): value is PlayerColor {
  return value === 'blue' || value === 'orange' || value === 'green' || value === 'magenta';
}
const PLAYER_PRESETS = [
  { seat: 0, color: 'blue', shape: 'circle' },
  { seat: 1, color: 'orange', shape: 'triangle' },
  { seat: 2, color: 'green', shape: 'square' },
  { seat: 3, color: 'magenta', shape: 'diamond' },
] as const;
const TIMER_FIELDS = [
  { key: 'preRollSec', label: 'lobby:preRollSeconds' },
  { key: 'mainSec', label: 'lobby:mainSeconds' },
  { key: 'discardSec', label: 'lobby:discardSeconds' },
  { key: 'robberSec', label: 'lobby:robberSeconds' },
] as const;

interface PlayerDraft {
  seat: 0 | 1 | 2 | 3;
  name: string;
  role: 'human' | 'bot';
  color: PlayerColor;
  shape: PlayerShape;
}

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

function NewLocalGame() {
  const { t } = useTranslation('lobby');
  const search = Route.useSearch();
  const navigate = useNavigate();
  const save = useSaveGame();
  const [playerCount, setPlayerCount] = useState(4);
  const [players, setPlayers] = useState<PlayerDraft[]>(() =>
    PLAYER_PRESETS.map((preset) => ({
      ...preset,
      name: t('lobby:defaultPlayerName', { number: preset.seat + 1 }),
      role: preset.seat === 0 ? 'human' : 'bot',
    })),
  );
  const [options, setOptions] = useState<BaseOptions>(() => ({
    ...DEFAULT_OPTIONS,
    mapLayout: search.map ?? DEFAULT_OPTIONS.mapLayout,
  }));
  const [botDelayMs, setBotDelayMs] = useState(450);
  const [error, setError] = useState(false);
  const [invalidNames, setInvalidNames] = useState<number[]>([]);

  const patchPlayer = (seat: number, patch: Partial<PlayerDraft>) => {
    setPlayers((current) =>
      current.map((player) => (player.seat === seat ? { ...player, ...patch } : player)),
    );
  };
  const changeColor = (seat: number, color: PlayerColor) => {
    setPlayers((current) => {
      const previous = current.find((player) => player.seat === seat)?.color;
      if (!previous) return current;
      return current.map((player) => {
        if (player.seat === seat) return { ...player, color };
        if (player.color === color) return { ...player, color: previous };
        return player;
      });
    });
  };
  const patchOptions = (patch: Partial<BaseOptions>) =>
    setOptions((current) => ({ ...current, ...patch }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(false);
    const selected = players.slice(0, playerCount);
    const emptyNames = selected.filter((player) => player.name.trim().length === 0);
    if (emptyNames.length) {
      setInvalidNames(emptyNames.map((player) => player.seat));
      return;
    }
    const seats = selected.map((player) => player.seat);
    const config = {
      modules: [{ id: 'base', version: baseModule().version }],
      seats,
      options: { base: options },
      ...(options.mapLayout === 'standard-fixed' ? { board: standardFixedBoard() } : {}),
    };
    const created = LocalSession.create({
      config,
      humanSeats: selected.filter((player) => player.role === 'human').map((player) => player.seat),
      botSeats: selected.filter((player) => player.role === 'bot').map((player) => player.seat),
      botDelayMs,
    });
    if (!created.ok) {
      setError(true);
      return;
    }
    const session = created.value;
    session.setPaused(true);
    const localSave = session.exportSave();
    const revision =
      localSave.genesis.length +
      localSave.batches.reduce((count, batch) => count + 1 + batch.generated.length, 0);
    const presentation: GamePresentation = {
      players: selected.map(({ seat, name, color, shape }) => ({
        seat,
        name: name.trim(),
        color,
        shape,
      })),
      botDelayMs,
    };
    const id = crypto.randomUUID();
    try {
      await save.mutateAsync({ id, revision, presentation, save: localSave });
      session.dispose();
      await navigate({ to: '/local/$gameId', params: { gameId: id } });
    } catch {
      session.dispose();
      setError(true);
    }
  };

  return (
    <main className="app-page form-page">
      <header className="app-header">
        <Link to="/" className="text-link">
          {t('lobby:backHome')}
        </Link>
        <span className="app-brand">{t('lobby:setupTitle')}</span>
      </header>
      <div className="form-page-content setup-content">
        <h1>{t('lobby:setupTitle')}</h1>
        <p className="muted">{t('lobby:setupDescription')}</p>
        <form onSubmit={(event) => void submit(event)} className="setup-form">
          <fieldset>
            <legend>{t('lobby:players')}</legend>
            <label htmlFor="player-count">{t('lobby:playerCount')}</label>
            <select
              id="player-count"
              value={playerCount}
              onChange={(event) => setPlayerCount(Number(event.target.value))}
            >
              {[2, 3, 4].map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
            <div className="player-form-list">
              {players.slice(0, playerCount).map((player, index) => (
                <div className="player-form-row" key={player.seat}>
                  <PlayerMarker shape={player.shape} color={player.color} />
                  <label>
                    {t('lobby:playerName', { number: index + 1 })}
                    <input
                      value={player.name}
                      required
                      maxLength={40}
                      aria-invalid={invalidNames.includes(player.seat)}
                      onChange={(event) => {
                        patchPlayer(player.seat, { name: event.target.value });
                        setInvalidNames((current) =>
                          current.filter((seat) => seat !== player.seat),
                        );
                      }}
                    />
                    {invalidNames.includes(player.seat) && (
                      <small role="alert">{t('lobby:nameRequired')}</small>
                    )}
                  </label>
                  <label>
                    {t('lobby:playerRole', { number: index + 1 })}
                    <select
                      value={player.role}
                      onChange={(event) => {
                        const role = event.target.value;
                        if (role === 'human' || role === 'bot') patchPlayer(player.seat, { role });
                      }}
                    >
                      <option value="human">{t('lobby:human')}</option>
                      <option value="bot">{t('lobby:bot')}</option>
                    </select>
                  </label>
                  <label>
                    {t('lobby:playerColor', { number: index + 1 })}
                    <select
                      value={player.color}
                      onChange={(event) => {
                        const color = event.target.value;
                        if (isPlayerColor(color)) changeColor(player.seat, color);
                      }}
                    >
                      {COLORS.map((color) => (
                        <option key={color} value={color}>
                          {t(`lobby:${color}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend>{t('lobby:boardAndRules')}</legend>
            <div className="form-grid">
              <label>
                {t('lobby:mapLayout')}
                <select
                  value={options.mapLayout}
                  onChange={(event) => {
                    const layout = event.target.value;
                    if (
                      layout === 'balanced-random' ||
                      layout === 'random' ||
                      layout === 'standard-fixed'
                    ) {
                      patchOptions({ mapLayout: layout });
                    }
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
                  value={options.vpTarget}
                  onChange={(event) => patchOptions({ vpTarget: Number(event.target.value) })}
                />
              </label>
            </div>
          </fieldset>

          <details className="advanced-options">
            <summary>{t('lobby:advancedRules')}</summary>
            <div className="advanced-options-content">
              <div className="form-grid">
                <label>
                  {t('lobby:discardLimit')}
                  <input
                    type="number"
                    min={0}
                    value={options.discardLimit}
                    onChange={(event) => patchOptions({ discardLimit: Number(event.target.value) })}
                  />
                </label>
                <label>
                  {t('lobby:diceMode')}
                  <select
                    value={options.diceMode}
                    onChange={(event) => {
                      const mode = event.target.value;
                      if (mode === 'random' || mode === 'balanced')
                        patchOptions({ diceMode: mode });
                    }}
                  >
                    <option value="random">{t('lobby:diceRandom')}</option>
                    <option value="balanced">{t('lobby:diceBalanced')}</option>
                  </select>
                </label>
                <label>
                  {t('lobby:botDelay')}
                  <input
                    type="number"
                    min={0}
                    max={60_000}
                    value={botDelayMs}
                    onChange={(event) => setBotDelayMs(Number(event.target.value))}
                  />
                </label>
              </div>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={options.strictBalance}
                  disabled={options.mapLayout === 'standard-fixed'}
                  onChange={(event) => patchOptions({ strictBalance: event.target.checked })}
                />
                <span>{t('lobby:strictBalance')}</span>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={options.friendlyRobber}
                  onChange={(event) => patchOptions({ friendlyRobber: event.target.checked })}
                />
                <span>{t('lobby:friendlyRobber')}</span>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={options.playerTrades}
                  onChange={(event) => patchOptions({ playerTrades: event.target.checked })}
                />
                <span>{t('lobby:playerTrades')}</span>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={options.hideBankCounts}
                  onChange={(event) => patchOptions({ hideBankCounts: event.target.checked })}
                />
                <span>{t('lobby:hideBankCounts')}</span>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={options.turnTimer !== null}
                  onChange={(event) =>
                    patchOptions({
                      turnTimer: event.target.checked
                        ? { preRollSec: 60, mainSec: 180, discardSec: 60, robberSec: 60 }
                        : null,
                    })
                  }
                />
                <span>{t('lobby:turnTimer')}</span>
              </label>
              {options.turnTimer && (
                <div className="form-grid">
                  {TIMER_FIELDS.map((field) => (
                    <label key={field.key}>
                      {t(field.label)}
                      <input
                        type="number"
                        min={1}
                        value={options.turnTimer?.[field.key] ?? 60}
                        onChange={(event) =>
                          patchOptions({
                            turnTimer: options.turnTimer
                              ? { ...options.turnTimer, [field.key]: Number(event.target.value) }
                              : null,
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>
          </details>
          {error && <p role="alert">{t('lobby:creationFailed')}</p>}
          <button className="button button-primary" type="submit" disabled={save.isPending}>
            {save.isPending ? t('lobby:creatingGame') : t('lobby:createGame')}
          </button>
        </form>
      </div>
    </main>
  );
}
