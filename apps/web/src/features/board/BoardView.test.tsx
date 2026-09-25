// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  rendererForTest = undefined;
});

const graph = buildBoardGraph(standardFixedBoard().hexes);
const model: RenderModel = {
  hexes: [],
  harbors: [],
  roads: [],
  buildings: [],
  robberHex: null,
};

let rendererForTest: BoardRenderer | undefined;
let focusCalls: Parameters<BoardRenderer['setFocusTarget']>[] = [];

function mount(element: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>);
}

function prepareRenderer(): void {
  focusCalls = [];
  const setFocusTarget = vi.fn<BoardRenderer['setFocusTarget']>((...args) => {
    focusCalls.push(args);
  });
  const renderer: BoardRenderer = {
    render: vi.fn<BoardRenderer['render']>(),
    setHighlights: vi.fn<BoardRenderer['setHighlights']>(),
    setFocusTarget,
    setAppearance: vi.fn<BoardRenderer['setAppearance']>(),
    setReducedMotion: vi.fn<BoardRenderer['setReducedMotion']>(),
    playEffects: vi.fn<BoardRenderer['playEffects']>(),
    skipAnimations: vi.fn<BoardRenderer['skipAnimations']>(),
    getDiagnostics: vi.fn<BoardRenderer['getDiagnostics']>(() => ({
      renderedFrames: 0,
      rebuiltLayers: 0,
      activeEffects: 0,
      queuedDisposals: 0,
    })),
    setHarborLabelFormatter: vi.fn<BoardRenderer['setHarborLabelFormatter']>(),
    hitTest: vi.fn<BoardRenderer['hitTest']>(() => null),
    subscribeViewChange: vi.fn<BoardRenderer['subscribeViewChange']>((listener) => {
      listener();
      return () => undefined;
    }),
    getPixelPosition: vi.fn<BoardRenderer['getPixelPosition']>(() => ({ x: 0, y: 0 })),
    boardToScreen: vi.fn<BoardRenderer['boardToScreen']>((point) => point),
    screenToBoard: vi.fn<BoardRenderer['screenToBoard']>((point) => point),
    fitToBoard: vi.fn<BoardRenderer['fitToBoard']>(),
    destroy: vi.fn<BoardRenderer['destroy']>(),
  };
  rendererForTest = renderer;
  createRendererMock.mockResolvedValue(renderer);
}

function expectLastFocusCall(...args: Parameters<BoardRenderer['setFocusTarget']>): void {
  expect(focusCalls.at(-1)).toEqual(args);
}

describe('BoardView keyboard locations', () => {
  test('cycles legal locations and selects one without a visible target panel', async () => {
    prepareRenderer();
    const onSelect = vi.fn<(hit: BoardHit) => void>();
    const onTargetPreview = vi.fn<(hit: BoardHit | null) => void>();
    const targets = graph.vertexIds.slice(0, 2);
    const firstTarget = targets[0];
    if (!firstTarget) throw new Error('Expected a first board target');
    mount(
      <BoardView
        model={model}
        highlights={{ vertices: targets, mode: 'vertex' }}
        targetLabel={(hit) => (hit.kind === 'vertex' ? `Intersection ${hit.id}` : hit.id)}
        onSelect={onSelect}
        onTargetPreview={onTargetPreview}
      />,
    );

    const board = screen.getByRole('group', { name: 'Game board' });
    await waitFor(() => expect(board.getAttribute('tabindex')).toBe('0'));
    expect(screen.queryByText('Keyboard targets (2)')).toBeNull();
    board.focus();
    fireEvent.keyDown(board, { key: 'Home' });
    expect(onTargetPreview).toHaveBeenLastCalledWith({ kind: 'vertex', id: targets[0] });
    await waitFor(() =>
      expectLastFocusCall({
        kind: 'vertex',
        id: firstTarget,
      }),
    );

    const chosenTarget = targets[1];
    if (!chosenTarget) throw new Error('Expected a second board target');
    fireEvent.keyDown(board, { key: 'ArrowRight' });
    expect(onTargetPreview).toHaveBeenLastCalledWith({ kind: 'vertex', id: chosenTarget });
    expect(screen.getByText(`Intersection ${chosenTarget}, 2 of 2`)).toBeDefined();
    fireEvent.keyDown(board, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith({ kind: 'vertex', id: chosenTarget });
    fireEvent.keyDown(board, { key: 'Escape' });
    expect(onTargetPreview).toHaveBeenLastCalledWith(null);
    await waitFor(() => expectLastFocusCall(null));
  });

  test('keeps a selected road preview above keyboard location browsing', async () => {
    prepareRenderer();
    expect(rendererForTest).toBeDefined();
    const edges = graph.edgeIds.slice(0, 2);
    const edge = edges[0];
    const otherEdge = edges[1];
    if (!edge || !otherEdge) throw new Error('Expected two board edges');
    const focusTarget = { kind: 'edge', id: edge } as const;
    mount(
      <BoardView
        model={model}
        highlights={{ edges, mode: 'edge' }}
        focusTarget={focusTarget}
        focusPreview={{ piece: 'road', color: 0xd55e00 }}
      />,
    );

    await waitFor(() => expectLastFocusCall(focusTarget, { piece: 'road', color: 0xd55e00 }));
    const board = screen.getByRole('group', { name: 'Game board' });
    board.focus();
    fireEvent.keyDown(board, { key: 'End' });
    expect(screen.getByText(`Edge ${otherEdge}, 2 of 2`)).toBeDefined();
    await waitFor(() => expectLastFocusCall(focusTarget, { piece: 'road', color: 0xd55e00 }));
    fireEvent.keyDown(board, { key: 'Escape' });
    await waitFor(() => expectLastFocusCall(focusTarget, { piece: 'road', color: 0xd55e00 }));
  });

  test('passes a selected city preview to its focused vertex', async () => {
    prepareRenderer();
    const vertex = graph.vertexIds[0];
    if (!vertex) throw new Error('Expected a board vertex');
    const focusTarget = { kind: 'vertex', id: vertex } as const;
    mount(
      <BoardView
        model={model}
        highlights={{ vertices: [vertex], mode: 'vertex' }}
        focusTarget={focusTarget}
        focusPreview={{ piece: 'city', color: 0x0072b2 }}
      />,
    );
    await waitFor(() => expectLastFocusCall(focusTarget, { piece: 'city', color: 0x0072b2 }));
    expect(focusCalls).toContainEqual([focusTarget, { piece: 'city', color: 0x0072b2 }]);
  });
});
