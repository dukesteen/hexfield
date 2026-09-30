import { MAP_TOKENS, defaultFogStack } from '@cp2p/maps';
import type { MapDef, MapFog, MapModule } from '@cp2p/maps';
import { useTranslation } from 'react-i18next';
import { MAX_SIZE, MIN_SIZE, boundsSize } from './document';
import type { Bounds, EditorAction } from './document';
import { terrainLabel } from './labels';

const FOG_TERRAINS = ['forest', 'hills', 'pasture', 'fields', 'mountains', 'desert', 'gold', 'sea'];
const SEATS = [2, 3, 4, 5, 6];
const total = (counts: Readonly<Record<string, number>>) =>
  Object.values(counts).reduce((sum, value) => sum + value, 0);

interface MapSettingsProps {
  readonly map: MapDef;
  readonly bounds: Bounds;
  readonly dispatch: (action: EditorAction) => void;
}

/** Modules, players, target, canvas size, setup areas and the fog stack. */
export function MapSettings({ map, bounds, dispatch }: MapSettingsProps) {
  const { t } = useTranslation(['editor', 'game', 'common', 'lobby']);
  const size = boundsSize(bounds);
  const seafaring = map.modules.includes('seafaring');
  const toggle = (id: MapModule, on: boolean) =>
    dispatch({
      type: 'modules',
      modules: on ? [...map.modules, id] : map.modules.filter((item) => item !== id),
    });
  const fogHexes = map.hexes.filter((hex) => hex.terrain === 'fog').length;
  return (
    <div className="map-settings">
      <fieldset className="map-field-group">
        <legend>{t('editor:mapModules')}</legend>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={seafaring}
            onChange={(event) => toggle('seafaring', event.target.checked)}
          />
          <span>{t('lobby:expansion_seafaring')}</span>
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={map.modules.includes('knights')}
            onChange={(event) => toggle('knights', event.target.checked)}
          />
          <span>{t('lobby:expansion_knights')}</span>
        </label>
        <small className="muted">{t('editor:mapFiveSixNote')}</small>
      </fieldset>
      <div className="map-field-grid">
        <label>
          {t('editor:mapSeatsMin')}
          <select
            value={map.seats.min}
            onChange={(event) =>
              dispatch({ type: 'seats', min: Number(event.target.value), max: map.seats.max })
            }
          >
            {SEATS.map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('editor:mapSeatsMax')}
          <select
            value={map.seats.max}
            onChange={(event) =>
              dispatch({ type: 'seats', min: map.seats.min, max: Number(event.target.value) })
            }
          >
            {SEATS.map((count) => (
              <option key={count} value={count}>
                {count}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('lobby:vpTarget')}
          <input
            type="number"
            min={3}
            max={20}
            value={map.vpTarget}
            onChange={(event) => dispatch({ type: 'vp', vpTarget: Number(event.target.value) })}
          />
        </label>
        <label>
          {t('editor:mapColumns')}
          <input
            type="number"
            min={MIN_SIZE}
            max={MAX_SIZE}
            value={size.cols}
            onChange={(event) =>
              dispatch({ type: 'resize', cols: Number(event.target.value), rows: size.rows })
            }
          />
        </label>
        <label>
          {t('editor:mapRows')}
          <input
            type="number"
            min={MIN_SIZE}
            max={MAX_SIZE}
            value={size.rows}
            onChange={(event) =>
              dispatch({ type: 'resize', cols: size.cols, rows: Number(event.target.value) })
            }
          />
        </label>
      </div>
      {seafaring && (
        <fieldset className="map-field-group">
          <legend>{t('editor:mapSetupAreas')}</legend>
          <p className="muted">
            {map.setupAreas === null
              ? t('editor:mapSetupAll')
              : t('editor:mapSetupSome', { count: map.setupAreas.length })}
          </p>
          {map.setupAreas !== null && (
            <button
              type="button"
              className="button button-quiet"
              onClick={() => dispatch({ type: 'setup-all' })}
            >
              {t('editor:mapSetupReset')}
            </button>
          )}
        </fieldset>
      )}
      {seafaring && (fogHexes > 0 || map.fog !== null) && (
        <FogStack
          fog={map.fog}
          fogHexes={fogHexes}
          onChange={(fog) => dispatch({ type: 'fog', fog })}
        />
      )}
    </div>
  );
}

function FogStack({
  fog,
  fogHexes,
  onChange,
}: {
  fog: MapFog | null;
  fogHexes: number;
  onChange: (fog: MapFog | null) => void;
}) {
  const { t } = useTranslation(['editor', 'game', 'common', 'lobby']);
  const stack: { terrains: Record<string, number>; tokens: Record<string, number> } = {
    terrains: { ...fog?.terrains },
    tokens: { ...fog?.tokens },
  };
  const takers = Object.entries(stack.terrains)
    .filter(([terrain]) => terrain !== 'sea' && terrain !== 'desert')
    .reduce((sum, [, value]) => sum + value, 0);
  const set = (part: 'terrains' | 'tokens', key: string, value: number) =>
    onChange({
      ...stack,
      [part]: { ...stack[part], [key]: Math.max(0, Math.min(99, value || 0)) },
    });
  return (
    <fieldset className="map-field-group map-fog">
      <legend>{t('editor:mapFogStack')}</legend>
      <p className="muted">
        {t('editor:mapFogSummary', {
          tiles: total(stack.terrains),
          hexes: fogHexes,
          tokens: total(stack.tokens),
          needed: takers,
        })}
      </p>
      <button
        type="button"
        className="button button-quiet"
        onClick={() => onChange(defaultFogStack(fogHexes))}
      >
        {t('editor:mapFogFill')}
      </button>
      <div className="map-fog-grid" aria-label={t('editor:mapFogTiles')} role="group">
        {FOG_TERRAINS.map((terrain) => (
          <label key={terrain}>
            {terrainLabel(t, terrain)}
            <input
              type="number"
              min={0}
              max={99}
              value={stack.terrains[terrain] ?? 0}
              onChange={(event) => set('terrains', terrain, Number(event.target.value))}
            />
          </label>
        ))}
      </div>
      <div className="map-fog-grid is-tokens" aria-label={t('editor:mapFogTokens')} role="group">
        {MAP_TOKENS.map((token) => (
          <label key={token}>
            {token}
            <input
              type="number"
              min={0}
              max={99}
              value={stack.tokens[String(token)] ?? 0}
              onChange={(event) => set('tokens', String(token), Number(event.target.value))}
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}
