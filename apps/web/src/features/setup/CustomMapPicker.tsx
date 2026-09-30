import { Link } from '@tanstack/react-router';
import { importMap, mapSeatCounts, validateMap } from '@cp2p/maps';
import type { MapDef } from '@cp2p/maps';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSavedMaps } from '../../queries/maps';
import './custom-map.css';

/**
 * Why a custom map cannot start at a seat count, or null when it can: the map must be valid
 * (including the genesis dry run) and drawn for that many players.
 */
export function customMapProblem(map: MapDef, seatCount: number): 'invalid' | 'seats' | null {
  if (!mapSeatCounts(map).includes(seatCount)) return 'seats';
  return validateMap(map, { engine: true }).errors.length > 0 ? 'invalid' : null;
}

/** `customMapProblem`, remembered per map and seat count (the dry run takes a moment). */
export function useCustomMapProblem(
  map: MapDef | null,
  seatCount: number,
): 'invalid' | 'seats' | null {
  return useMemo(() => (map ? customMapProblem(map, seatCount) : null), [map, seatCount]);
}

interface CustomMapPickerProps {
  readonly seatCount: number;
  readonly map: MapDef | null;
  /** From `useCustomMapProblem`, so the screen and the picker share one check. */
  readonly problem: 'invalid' | 'seats' | null;
  readonly onMap: (map: MapDef) => void;
  readonly disabled?: boolean;
}

/** Choose a custom map for a new game: paste a string or pick a saved map. */
export function CustomMapPicker({
  seatCount,
  map,
  problem,
  onMap,
  disabled = false,
}: CustomMapPickerProps) {
  const { t } = useTranslation('lobby');
  const saved = useSavedMaps();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const paste = async () => {
    setError('');
    const result = await importMap(text);
    if (!result.ok) {
      setError(t('lobby:customMapInvalidString'));
      return;
    }
    setText('');
    onMap(result.value);
  };
  return (
    <div className="custom-map-picker" data-testid="custom-map-picker">
      {saved.data && saved.data.length > 0 && (
        <label>
          {t('lobby:customMapSaved')}
          <select
            value=""
            disabled={disabled}
            onChange={(event) => {
              const chosen = saved.data?.find((item) => item.id === event.target.value);
              if (chosen) onMap(chosen.map);
            }}
          >
            <option value="" disabled>
              {t('lobby:customMapChoose')}
            </option>
            {saved.data.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        {t('lobby:customMapPaste')}
        <textarea
          rows={2}
          value={text}
          disabled={disabled}
          spellCheck={false}
          placeholder="HXMAP1.…"
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <div className="custom-map-actions">
        <button
          type="button"
          className="button button-quiet"
          disabled={disabled || text.trim() === ''}
          onClick={() => void paste()}
        >
          {t('lobby:customMapUse')}
        </button>
        <Link to="/editor" className="text-link">
          {t('lobby:customMapOpenEditor')}
        </Link>
      </div>
      {error && <p role="alert">{error}</p>}
      {map ? (
        <div className="custom-map-summary" data-state={problem ?? 'ok'}>
          <strong>{map.name}</strong>
          <span className="muted">
            {t('lobby:customMapSummary', {
              hexes: map.hexes.filter((hex) => hex.terrain !== 'sea').length,
              min: map.seats.min,
              max: map.seats.max,
              target: map.vpTarget,
            })}
          </span>
          {problem === 'invalid' && <p role="alert">{t('lobby:customMapNotValid')}</p>}
          {problem === 'seats' && (
            <p role="alert">
              {t('lobby:customMapWrongSeats', {
                count: seatCount,
                seats: mapSeatCounts(map).join(', ') || '—',
              })}
            </p>
          )}
        </div>
      ) : (
        <p className="muted">{t('lobby:customMapNone')}</p>
      )}
    </div>
  );
}
