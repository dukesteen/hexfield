export const PACKAGE_NAME = '@cp2p/renderer';

export { PixiBoardRenderer, createBoardRenderer } from './BoardRenderer.js';
export { DICE_ROLL_DURATION_MS, PRODUCTION_TOKEN_PULSE_MS } from './effectMotion.js';
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
