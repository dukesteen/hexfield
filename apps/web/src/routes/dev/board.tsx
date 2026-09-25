import { createFileRoute, notFound } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { standardFixedBoard } from '@cp2p/maps';
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

const model: RenderModel = {
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

declare global {
  interface Window {
    __cp2pBoard?: { readonly renderer: BoardRenderer; readonly model: RenderModel };
  }
}

export const Route = createFileRoute('/dev/board')({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: import.meta.env.DEV ? BoardDevelopmentPage : () => null,
});

function BoardDevelopmentPage() {
  const { t } = useTranslation('common');
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
