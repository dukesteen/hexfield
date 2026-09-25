import { createFileRoute, notFound } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { standardFixedBoard } from '@cp2p/maps';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import { BoardView } from '../../features/board/BoardView.js';
import type { BoardHit, BoardRenderer, RenderModel } from '@cp2p/renderer';

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
  component: BoardDevelopmentPage,
});

function BoardDevelopmentPage() {
  const { t } = useTranslation('common');
  const [rendererError, setRendererError] = useState<string | null>(null);
  const onRendererReady = (renderer: BoardRenderer) => {
    Reflect.set(window, '__cp2pBoard', { renderer, model });
  };

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
        </aside>
      </div>
    </main>
  );
}

function selectBoardTarget(hit: BoardHit): void {
  document.dispatchEvent(new CustomEvent('cp2p-board-select', { detail: hit }));
}
