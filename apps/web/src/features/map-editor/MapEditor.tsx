import { Link } from '@tanstack/react-router';
import {
  autoTokens,
  emptyMap,
  mapFromScenario,
  randomiseMap,
  scenarioById,
  validateMap,
} from '@cp2p/maps';
import type { HarborKind, MapDef, MapTerrain } from '@cp2p/maps';
import { createMapEditorLayer } from '@cp2p/renderer';
import type { BoardHit, BoardHighlights, BoardRenderer } from '@cp2p/renderer';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BoardView } from '../board/BoardView';
import { useBoardAppearance } from '../game/use-appearance';
import { newMapId, useSaveMap } from '../../queries/maps';
import type { SavedMap } from '../../queries/maps';
import { centredBounds, coordOf, fitBounds, perform, redo, startHistory, undo } from './document';
import type { EditorAction, History } from './document';
import { EditorPalette } from './EditorPalette';
import { MapSettings } from './MapSettings';
import { SavedMapsPanel } from './SavedMapsPanel';
import { SharePanel } from './SharePanel';
import { ValidationPanel } from './ValidationPanel';
import { paletteTerrains, toolAvailable } from './tools';
import type { Tool } from './tools';
import { editorRenderModel, harborEdges } from './view';
import './map-editor.css';

/** Starting points: a blank sea, the classic island, and the fixed Seafarers maps. */
const TEMPLATES = [
  'blank',
  'standard-fixed',
  'new-horizons',
  'four-isles',
  'fogbound',
  'desert-crossing',
];

const LAYERS = [createMapEditorLayer()];
const NO_PLAYERS = { players: [], botDelayMs: 0 };

/** A fresh seed for the randomiser and the number solver. */
const seed = (): number => crypto.getRandomValues(new Uint32Array(1))[0] ?? 1;

/** Development builds expose the canvas renderer so browser tests can tap hexes and edges. */
function exposeRenderer(renderer: BoardRenderer): void {
  if (import.meta.env.DEV) Reflect.set(window, '__cp2pMapEditor', { renderer });
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

export interface MapEditorProps {
  /** The map to open (from `?map=` or a saved map); the classic island when absent. */
  readonly initial: MapDef;
  /** A problem reading `?map=`, shown once. */
  readonly loadError?: string;
}

/** The map editor: board, tools, live validation, settings, sharing and saved maps. */
export function MapEditor({ initial, loadError }: MapEditorProps) {
  const { t } = useTranslation(['editor', 'game', 'common', 'lobby']);
  const [history, setHistory] = useState<History>(() =>
    startHistory({ map: initial, bounds: fitBounds(initial) }),
  );
  const [tool, setTool] = useState<Tool>('terrain');
  const [terrain, setTerrain] = useState<MapTerrain>('forest');
  const [harborKind, setHarborKind] = useState<HarborKind>('generic');
  const [savedId, setSavedId] = useState<string | null>(null);
  const [notice, setNotice] = useState(loadError ?? '');
  const [panel, setPanel] = useState<'check' | 'map' | 'share' | 'saved'>('check');
  const shift = useRef(false);
  const save = useSaveMap();
  const doc = history.present;
  const { map } = doc;
  const report = useMemo(() => validateMap(map), [map]);
  const model = useMemo(() => editorRenderModel(doc, report, { showSetup: true }), [doc, report]);
  const { appearance, reducedMotion } = useBoardAppearance(NO_PLAYERS);

  const dispatch = useCallback(
    (action: EditorAction) => setHistory((current) => perform(current, action)),
    [],
  );
  const replace = useCallback(
    (next: MapDef, bounds = fitBounds(next)) => dispatch({ type: 'replace', map: next, bounds }),
    [dispatch],
  );

  // A tool the modules no longer allow falls back to the brush.
  const activeTool = toolAvailable(tool, map.modules) ? tool : 'terrain';
  const activeTerrain = paletteTerrains(map.modules).includes(terrain) ? terrain : 'forest';

  const highlights = useMemo<BoardHighlights>(
    () =>
      activeTool === 'harbor'
        ? { mode: 'edge', edges: harborEdges(doc), style: { edgeTarget: 'lane', pulse: false } }
        : { mode: 'hex' },
    [activeTool, doc],
  );

  const onSelect = (hit: BoardHit) => {
    if (hit.kind === 'edge') {
      if (activeTool === 'harbor') dispatch({ type: 'harbor', edge: hit.id, kind: harborKind });
      return;
    }
    if (hit.kind !== 'hex') return;
    const at = coordOf(hit.id);
    if (!at) return;
    switch (activeTool) {
      case 'terrain':
        dispatch({ type: 'paint', at, terrain: activeTerrain });
        break;
      case 'token':
        dispatch({ type: 'cycle-token', at, step: shift.current ? -1 : 1 });
        break;
      case 'erase':
        dispatch({ type: 'erase', at });
        break;
      case 'robber':
        dispatch({ type: 'robber', at });
        break;
      case 'pirate':
        dispatch({ type: 'pirate', at });
        break;
      case 'setup':
        dispatch({ type: 'toggle-setup', at });
        break;
      case 'harbor':
        break;
    }
  };

  useEffect(() => () => void Reflect.deleteProperty(window, '__cp2pMapEditor'), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      shift.current = event.shiftKey;
      if (event.type !== 'keydown' || isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === 'z') {
        event.preventDefault();
        setHistory((current) => (event.shiftKey ? redo(current) : undo(current)));
        return;
      }
      if ((event.metaKey || event.ctrlKey) && key === 'y') {
        event.preventDefault();
        setHistory(redo);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const tools: Record<string, Tool> = {
        b: 'terrain',
        n: 'token',
        h: 'harbor',
        e: 'erase',
        r: 'robber',
        p: 'pirate',
        s: 'setup',
      };
      const next = tools[key];
      if (next) {
        setTool(next);
        return;
      }
      const index = Number(key) - 1;
      const terrains = paletteTerrains(map.modules);
      const picked = Number.isInteger(index) ? terrains[index] : undefined;
      if (picked) {
        setTerrain(picked);
        setTool('terrain');
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, [map.modules]);

  const runGenerator = (result: ReturnType<typeof autoTokens>) => {
    if (result.ok) replace(result.value, doc.bounds);
    else setNotice(t('editor:mapTokensUnsolved'));
  };
  const openTemplate = (id: string) => {
    const scenario = scenarioById(id);
    const next =
      id === 'blank' || !scenario
        ? emptyMap(t('editor:mapUntitled'))
        : mapFromScenario(scenario, t(`lobby:${scenario.titleKey}`));
    if (!next) return;
    setSavedId(null);
    replace(next, id === 'blank' ? centredBounds(9, 7) : fitBounds(next));
  };
  const openSaved = (saved: SavedMap) => {
    setSavedId(saved.id);
    replace(saved.map);
    setNotice(t('editor:mapOpened', { name: saved.name }));
  };
  const saveMap = () => {
    const id = savedId ?? newMapId();
    save.mutate(
      { id, map },
      {
        onSuccess: () => {
          setSavedId(id);
          setNotice(t('editor:mapSaved', { name: map.name }));
        },
        onError: () => setNotice(t('editor:mapSaveFailed')),
      },
    );
  };

  const panels = [
    { id: 'check', label: t('editor:mapPanelCheck'), count: report.errors.length },
    { id: 'map', label: t('editor:mapPanelMap'), count: 0 },
    { id: 'share', label: t('editor:mapPanelShare'), count: 0 },
    { id: 'saved', label: t('editor:mapPanelSaved'), count: 0 },
  ] as const;

  return (
    <main className="app-page map-editor-page">
      <header className="app-header map-editor-header">
        <Link to="/" className="text-link">
          {t('lobby:backHome')}
        </Link>
        <span className="app-brand">{t('editor:mapEditorTitle')}</span>
        <label className="map-name">
          <span className="sr-only">{t('editor:mapName')}</span>
          <input
            value={map.name}
            maxLength={60}
            aria-label={t('editor:mapName')}
            onChange={(event) => dispatch({ type: 'name', name: event.target.value })}
          />
        </label>
        <div className="map-header-actions">
          <button
            type="button"
            className="button button-quiet map-icon-button"
            disabled={history.past.length === 0}
            onClick={() => setHistory(undo)}
            title={t('editor:mapUndoShortcut')}
          >
            {t('editor:mapUndo')}
          </button>
          <button
            type="button"
            className="button button-quiet map-icon-button"
            disabled={history.future.length === 0}
            onClick={() => setHistory(redo)}
            title={t('editor:mapRedoShortcut')}
          >
            {t('editor:mapRedo')}
          </button>
          <select
            className="map-template"
            aria-label={t('editor:mapNewFrom')}
            value=""
            onChange={(event) => openTemplate(event.target.value)}
          >
            <option value="" disabled>
              {t('editor:mapNewFrom')}
            </option>
            {TEMPLATES.map((id) => {
              const scenario = scenarioById(id);
              return (
                <option key={id} value={id}>
                  {id === 'blank' || !scenario
                    ? t('editor:mapTemplateBlank')
                    : t(`lobby:${scenario.titleKey}`)}
                </option>
              );
            })}
          </select>
          <button
            type="button"
            className="button button-primary"
            disabled={save.isPending}
            onClick={saveMap}
          >
            {t('editor:mapSave')}
          </button>
        </div>
      </header>
      {notice && (
        <p className="map-notice" role="status">
          {notice}
          <button
            type="button"
            className="text-link"
            aria-label={t('editor:mapDismiss')}
            onClick={() => setNotice('')}
          >
            ×
          </button>
        </p>
      )}
      <div className="map-editor-layout" data-tool={activeTool}>
        <aside className="map-editor-palette" aria-label={t('editor:mapTools')}>
          <EditorPalette
            modules={map.modules}
            tool={activeTool}
            terrain={activeTerrain}
            harborKind={harborKind}
            onTool={setTool}
            onTerrain={setTerrain}
            onHarborKind={setHarborKind}
            onAutoTokens={() => runGenerator(autoTokens(map, seed()))}
            onRandomise={() => runGenerator(randomiseMap(map, seed()))}
          />
        </aside>
        <section className="map-editor-board" aria-label={t('editor:mapBoard')}>
          <BoardView
            model={model}
            highlights={highlights}
            appearance={appearance}
            reducedMotion={reducedMotion}
            onSelect={onSelect}
            layers={LAYERS}
            label={t('editor:mapBoard')}
            onRendererReady={exposeRenderer}
          />
          <div className="map-board-status" aria-hidden="true">
            <span data-state={report.errors.length > 0 ? 'error' : 'ok'}>
              {report.errors.length > 0
                ? t('editor:mapCheckErrors', { count: report.errors.length })
                : t('editor:mapCheckPlayable')}
            </span>
          </div>
        </section>
        <aside className="map-editor-side">
          <div className="map-tabs" role="tablist" aria-label={t('editor:mapPanels')}>
            {panels.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`map-tab-${item.id}`}
                aria-selected={panel === item.id}
                aria-controls={`map-panel-${item.id}`}
                onClick={() => setPanel(item.id)}
              >
                {item.label}
                {item.count > 0 && <span className="map-tab-count">{item.count}</span>}
              </button>
            ))}
          </div>
          <div
            className="map-panel"
            role="tabpanel"
            id={`map-panel-${panel}`}
            aria-labelledby={`map-tab-${panel}`}
          >
            {panel === 'check' && <ValidationPanel report={report} />}
            {panel === 'map' && <MapSettings map={map} bounds={doc.bounds} dispatch={dispatch} />}
            {panel === 'share' && (
              <SharePanel
                map={map}
                blocked={report.errors.length > 0}
                onImport={(next) => {
                  setSavedId(null);
                  replace(next);
                }}
              />
            )}
            {panel === 'saved' && <SavedMapsPanel currentId={savedId} onOpen={openSaved} />}
          </div>
        </aside>
      </div>
    </main>
  );
}
