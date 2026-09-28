export const PACKAGE_NAME = '@cp2p/renderer';

export { PixiBoardRenderer, createBoardRenderer } from './BoardRenderer.js';
export { DICE_ROLL_DURATION_MS, PRODUCTION_TOKEN_PULSE_MS } from './effectMotion.js';
export { hitTestBoard } from './input/hitTest.js';
export { drawDefaultFixture, fixtureBounds, fixtureCenters, hitTestFixture } from './fixtures.js';
export {
  getAwardCardUrl,
  getDevelopmentCardUrl,
  getDieUrl,
  getFactionUrl,
  getGameArtUrl,
  getIslandChitUrl,
  getPieceIconUrl,
  getResourceCardUrl,
  getResourceIconUrl,
  getSeafaringIconUrl,
  getShipIconUrl,
} from './assets/terrainTextures.js';
export { hexExtents, isLandTerrain, islandBoundarySegments, landIslands } from './boardShape.js';
export { shipVariantForEdge } from './shipVariant.js';
export type { ShipVariant } from './shipVariant.js';
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
  FixtureArt,
  RenderFixture,
  RenderLayerContext,
  RenderLayerPlugin,
  HitMode,
  RenderModel,
  ScreenPoint,
} from './types.js';
