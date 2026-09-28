import { createFileRoute, notFound } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { scenarioById, scenarioConfig, standardFixedBoard } from '@cp2p/maps';
import { FIVE_SIX_BOARD, engineForConfig, moduleSelection } from '@cp2p/engine';
import type { BoardState } from '@cp2p/engine';
import * as v from 'valibot';
import { toRenderModel } from '../../features/board/toRenderModel.js';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import { BoardView } from '../../features/board/BoardView.js';
import type { BoardEffect, BoardHit, BoardRenderer, RenderModel } from '@cp2p/renderer';

type BoardEffectInput = BoardEffect extends infer Effect
  ? Effect extends BoardEffect
    ? Omit<Effect, 'id'>
    : never
  : never;

const board = standardFixedBoard();
const graph = buildBoardGraph(board.hexes);
function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Invalid preview ${label}`);
  return value;
}

const standardModel: RenderModel = {
  hexes: board.hexes.map((hex) => ({
    ...hex,
    id: required(
      graph.hexIds.find((id) => id === hex.id),
      `hex ${hex.id}`,
    ),
  })),
  harbors: board.harbors.map((harbor) => ({
    edge: required(
      graph.edgeIds.find((id) => id === harbor.edge),
      `edge ${harbor.edge}`,
    ),
    kind: harbor.kind,
  })),
  roads: graph.edgeIds.slice(2, 7).map((edge, index) => ({ edge, seat: index % 2 === 0 ? 0 : 1 })),
  buildings: graph.vertexIds.slice(0, 4).map((vertex, index) => ({
    vertex,
    seat: index % 2 === 0 ? 0 : 1,
    kind: index === 3 ? 'city' : 'settlement',
  })),
  robberHex:
    board.robberHex === null
      ? null
      : required(
          graph.hexIds.find((id) => id === board.robberHex),
          `robber hex ${board.robberHex}`,
        ),
};

/** A generated 30-hex board with a sample two-hex fixture in the shape's fixture slot. */
function fiveSixModel(): RenderModel {
  const config = {
    modules: moduleSelection(['base', 'five-six']),
    seats: [0, 1, 2, 3, 4, 5] as const,
    options: {},
  };
  const state = engineForConfig(config).createGame(
    { ...config, seats: [...config.seats] },
    new Uint8Array(32).fill(7),
  );
  const slot = required(FIVE_SIX_BOARD.fixtureSlots[0], 'five-six fixture slot');
  return {
    ...toRenderModel(state, 'spectator'),
    fixtures: [
      {
        id: 'preview-track',
        module: 'preview',
        footprint: [slot.anchor, slot.outer],
        orientation: 2,
        art: 'barbarian-track',
      },
    ],
  };
}

const SEAFARING_LAYOUTS = [
  'new-horizons',
  'four-isles',
  'desert-crossing',
  'fogbound',
  'open-sea',
] as const;

/** The pieces-free model of a board, without starting a game on it. */
function boardModel(layout: BoardState): RenderModel {
  const boardGraph = buildBoardGraph(layout.hexes);
  return {
    hexes: layout.hexes.map((hex) => ({
      ...hex,
      id: required(
        boardGraph.hexIds.find((id) => id === hex.id),
        `hex ${hex.id}`,
      ),
    })),
    harbors: layout.harbors.map((harbor) => ({
      edge: required(
        boardGraph.edgeIds.find((id) => id === harbor.edge),
        `edge ${harbor.edge}`,
      ),
      kind: harbor.kind,
    })),
    roads: [],
    buildings: [],
    ships: [],
    pirateHex: null,
    robberHex: null,
  };
}

/**
 * A seafaring scenario at genesis, with a few sample ships and bonus chits so the art and
 * the fit can be checked without playing a game.
 */
function seafaringModel(id: string): RenderModel {
  const scenario = required(scenarioById(id), `scenario ${id}`);
  // Fixed scenarios preview straight from their board, so a scenario the engine cannot start
  // yet (fog reveals) can still be looked at.
  const state =
    scenario.board.kind === 'fixed'
      ? null
      : engineForConfig(scenarioConfig(scenario, 4)).createGame(
          scenarioConfig(scenario, 4),
          new Uint8Array(32).fill(7),
        );
  const base =
    scenario.board.kind === 'fixed'
      ? boardModel(scenario.board.board())
      : toRenderModel(required(state ?? undefined, 'game'), 'spectator');
  const byId = new Map(base.hexes.map((hex) => [hex.id, hex]));
  const seaGraph = buildBoardGraph(base.hexes.map(({ q, r }) => ({ q, r })));
  const seaEdges = seaGraph.edgeIds.filter((_, index) => {
    const terrains = (seaGraph.edgeHexes[index] ?? []).map((hex) => byId.get(hex)?.terrain);
    return terrains.length === 2 && terrains.every((terrain) => terrain === 'sea');
  });
  const stride = Math.max(1, Math.floor(seaEdges.length / 12));
  const land = base.hexes.find((hex) => hex.terrain !== 'sea');
  const landVertex = land
    ? seaGraph.vertexIds.find((_, index) => seaGraph.vertexHexes[index]?.includes(land.id))
    : undefined;
  return {
    ...base,
    ships: seaEdges
      .filter((_, index) => index % stride === 0)
      .slice(0, 12)
      .map((edge, index) => ({ edge, seat: index % 2 === 0 ? 0 : 1 })),
    ...(landVertex
      ? {
          buildings: [{ vertex: landVertex, seat: 0, kind: 'settlement' as const }],
          islandBonuses: [{ vertex: landVertex, seat: 0, vp: 2 }],
        }
      : {}),
  };
}

declare global {
  interface Window {
    __cp2pBoard?: { readonly renderer: BoardRenderer; readonly model: RenderModel };
  }
}

export const Route = createFileRoute('/dev/board')({
  validateSearch: v.object({
    layout: v.optional(v.picklist(['standard', 'five-six', ...SEAFARING_LAYOUTS])),
  }),
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: import.meta.env.DEV ? BoardDevelopmentPage : () => null,
});

function BoardDevelopmentPage() {
  const { t } = useTranslation('common');
  const layout = Route.useSearch().layout ?? 'standard';
  const [model] = useState<RenderModel>(() =>
    layout === 'five-six'
      ? fiveSixModel()
      : layout === 'standard'
        ? standardModel
        : seafaringModel(layout),
  );
  const [rendererError, setRendererError] = useState<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [diagnostics, setDiagnostics] = useState({
    renderedFrames: 0,
    rebuiltLayers: 0,
    activeEffects: 0,
    queuedDisposals: 0,
  });
  const effectSequence = useRef(0);
  const onRendererReady = (renderer: BoardRenderer) => {
    Reflect.set(window, '__cp2pBoard', { renderer, model });
  };
  useEffect(() => {
    const timer = window.setInterval(() => {
      const preview = window['__cp2pBoard'];
      if (preview) {
        const next = preview.renderer.getDiagnostics();
        setDiagnostics((current) =>
          current.renderedFrames === next.renderedFrames &&
          current.rebuiltLayers === next.rebuiltLayers &&
          current.activeEffects === next.activeEffects &&
          current.queuedDisposals === next.queuedDisposals
            ? current
            : next,
        );
      }
    }, 50);
    return () => {
      window.clearInterval(timer);
      Reflect.deleteProperty(window, '__cp2pBoard');
    };
  }, []);

  const playEffect = (effect: BoardEffectInput): void => {
    effectSequence.current += 1;
    window['__cp2pBoard']?.renderer.playEffects([
      { ...effect, id: `preview-${effectSequence.current}` },
    ]);
  };
  const playRobberMove = (): void => {
    const startHex = model.robberHex ?? model.hexes[0]?.id;
    const targetHex = model.hexes.find((hex) => hex.id !== startHex)?.id;
    if (!startHex || !targetHex) return;
    playEffect({ kind: 'robber-move', fromHex: startHex, toHex: targetHex });
  };
  const firstVertex = model.buildings[0]?.vertex;
  const firstEdge = model.roads[0]?.edge;

  return (
    <main className="board-dev-page">
      <header className="board-dev-header">
        <div>
          <h1>{t('common:boardPreviewTitle')}</h1>
          <p>{t('common:boardPreviewDescription')}</p>
        </div>
        <span>{t('common:boardPreviewStatus')}</span>
      </header>
      <div className="board-dev-layout">
        <BoardView
          model={model}
          label={t('common:boardPreviewAriaLabel')}
          reducedMotion={reducedMotion}
          onSelect={selectBoardTarget}
          onRendererReady={onRendererReady}
          onRendererError={(error) => {
            setRendererError(
              error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            );
          }}
          className="board-dev-board"
        />
        {rendererError && <pre role="alert">{rendererError}</pre>}
        <aside className="board-dev-help">
          <h2>{t('common:boardPreviewControlsTitle')}</h2>
          <p>{t('common:boardPreviewControls')}</p>
          <p>{t('common:boardPreviewHitTesting')}</p>
          <ul>
            <li>{t('common:boardPreviewLegendForest')}</li>
            <li>{t('common:boardPreviewLegendToken')}</li>
            <li>{t('common:boardPreviewLegendPieces')}</li>
          </ul>
          <h2>{t('common:boardEffectsTitle')}</h2>
          <div className="board-dev-effects">
            <button type="button" onClick={() => playEffect({ kind: 'dice-roll', dice: [3, 5] })}>
              {t('common:boardEffectDice')}
            </button>
            <button
              type="button"
              disabled={!firstVertex}
              onClick={() =>
                firstVertex &&
                playEffect({
                  kind: 'piece-pop',
                  piece: 'settlement',
                  seat: 0,
                  at: { kind: 'vertex', id: firstVertex },
                })
              }
            >
              {t('common:boardEffectBuilding')}
            </button>
            <button
              type="button"
              disabled={!firstEdge}
              onClick={() =>
                firstEdge &&
                playEffect({
                  kind: 'piece-pop',
                  piece: 'road',
                  seat: 0,
                  at: { kind: 'edge', id: firstEdge },
                })
              }
            >
              {t('common:boardEffectRoad')}
            </button>
            <button type="button" onClick={playRobberMove}>
              {t('common:boardEffectRobber')}
            </button>
            <button type="button" onClick={() => window['__cp2pBoard']?.renderer.skipAnimations()}>
              {t('common:boardEffectSkip')}
            </button>
            <label>
              <input
                type="checkbox"
                checked={reducedMotion}
                onChange={(event) => setReducedMotion(event.currentTarget.checked)}
              />
              {t('common:boardEffectReducedMotion')}
            </label>
          </div>
          <output
            data-testid="renderer-diagnostics"
            aria-label={t('common:boardEffectDiagnostics')}
          >
            {JSON.stringify(diagnostics)}
          </output>
        </aside>
      </div>
    </main>
  );
}

function selectBoardTarget(hit: BoardHit): void {
  document.dispatchEvent(new CustomEvent('cp2p-board-select', { detail: hit }));
}
