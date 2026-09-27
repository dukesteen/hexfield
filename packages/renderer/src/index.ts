export const PACKAGE_NAME = '@cp2p/renderer';

export { PixiBoardRenderer, createBoardRenderer } from './BoardRenderer.js';
export { hitTestBoard } from './input/hitTest.js';
export {
  getAwardCardUrl,
  getDevelopmentCardUrl,
  getDieUrl,
  getFactionUrl,
  getGameArtUrl,
  getPieceIconUrl,
  getResourceCardUrl,
  getResourceIconUrl,
} from './assets/terrainTextures.js';
export type {
  BoardAppearance,
  BoardEffect,
  BoardFocusPreview,
  BoardRendererDiagnostics,
  BoardHighlights,
  BoardHit,
  BoardRenderer,
  BoardRendererOptions,
  DevelopmentCard,
  HitMode,
  RenderModel,
  ScreenPoint,
} from './types.js';
