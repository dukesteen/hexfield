export const PACKAGE_NAME = '@cp2p/renderer';

export { PixiBoardRenderer, createBoardRenderer } from './BoardRenderer.js';
export { hitTestBoard } from './input/hitTest.js';
export { getResourceIconUrl } from './assets/terrainTextures.js';
export type {
  BoardAppearance,
  BoardHighlights,
  BoardHit,
  BoardRenderer,
  BoardRendererOptions,
  HitMode,
  RenderModel,
  ScreenPoint,
} from './types.js';
