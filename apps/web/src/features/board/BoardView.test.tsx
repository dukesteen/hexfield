// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { standardFixedBoard } from '@cp2p/maps';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import type { BoardHit, BoardRenderer, BoardRendererOptions, RenderModel } from '@cp2p/renderer';
import common from '../../i18n/locales/en/common.json';
import { BoardView } from './BoardView.js';

const createRendererMock = vi.hoisted(() =>
  vi.fn<(host: HTMLElement, options?: BoardRendererOptions) => Promise<BoardRenderer>>(),
);
vi.mock('@cp2p/renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cp2p/renderer')>();
  return { ...actual, createBoardRenderer: createRendererMock };
});

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { common } }, initImmediate: false });
});
afterEach(() => {
  cleanup();
  createRendererMock.mockReset();
});

const graph = buildBoardGraph(standardFixedBoard().hexes);
const model: RenderModel = {
  hexes: [],
  harbors: [],
  roads: [],
  buildings: [],
  robberHex: null,
};

function mount(element: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>);
}

function prepareRenderer(): void {
  const renderer: BoardRenderer = {
    render: vi.fn<BoardRenderer['render']>(),
    setHighlights: vi.fn<BoardRenderer['setHighlights']>(),
    setAppearance: vi.fn<BoardRenderer['setAppearance']>(),
    setReducedMotion: vi.fn<BoardRenderer['setReducedMotion']>(),
    setHarborLabelFormatter: vi.fn<BoardRenderer['setHarborLabelFormatter']>(),
    hitTest: vi.fn<BoardRenderer['hitTest']>(() => null),
    getPixelPosition: vi.fn<BoardRenderer['getPixelPosition']>(() => ({ x: 0, y: 0 })),
    boardToScreen: vi.fn<BoardRenderer['boardToScreen']>((point) => point),
    screenToBoard: vi.fn<BoardRenderer['screenToBoard']>((point) => point),
    fitToBoard: vi.fn<BoardRenderer['fitToBoard']>(),
    destroy: vi.fn<BoardRenderer['destroy']>(),
  };
  createRendererMock.mockResolvedValue(renderer);
}

describe('BoardView keyboard target chooser', () => {
  test('keeps targets collapsed and sends the selected semantic target', async () => {
    prepareRenderer();
    const onSelect = vi.fn<(hit: BoardHit) => void>();
    const targets = graph.vertexIds.slice(0, 2);
    mount(
      <BoardView
        model={model}
        highlights={{ vertices: targets, mode: 'vertex' }}
        targetLabel={(hit) => (hit.kind === 'vertex' ? `Intersection ${hit.id}` : hit.id)}
        onSelect={onSelect}
      />,
    );

    const disclosure = screen.getByText('Keyboard targets (2)');
    expect(disclosure.parentElement?.hasAttribute('open')).toBe(false);
    fireEvent.click(disclosure);
    expect(disclosure.parentElement?.hasAttribute('open')).toBe(true);

    const select = screen.getByRole('combobox', { name: 'Board location' });
    const chosenTarget = targets[1];
    if (!chosenTarget) throw new Error('Expected a second board target');
    fireEvent.change(select, { target: { value: `vertex:${chosenTarget}` } });
    fireEvent.click(screen.getByRole('button', { name: 'Select location' }));

    expect(onSelect).toHaveBeenCalledWith({ kind: 'vertex', id: chosenTarget });
  });
});
