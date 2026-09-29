export const PACKAGE_NAME = '@cp2p/renderer';

export { PixiBoardRenderer, createBoardRenderer } from './BoardRenderer.js';
export {
  DICE_ROLL_DURATION_MS,
  DICE_SETTLE_MS,
  PRODUCTION_TOKEN_PULSE_MS,
} from './effectMotion.js';
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
export {
  getBarbarianShipUrl,
  getCommodityCardUrl,
  getCommodityIconUrl,
  getDefenderCardUrl,
  getDefenderIconUrl,
  getEventDieUrl,
  getGlyphUrl,
  getImprovementBannerUrl,
  getImprovementStampUrl,
  getKnightIconUrl,
  getMerchantIconUrl,
  getMetropolisIconUrl,
  getProgressBackUrl,
  getRedDieUrl,
  getTrackIconUrl,
  getWallIconUrl,
  getWalledCityIconUrl,
} from './assets/knightsIcons.js';
export type { CommodityName, EventDieFace, GlyphName } from './assets/knightsIcons.js';
export { barbarianStepPoint, barbarianTrackLayout, sailPosition } from './knightsLayout.js';
export type { BarbarianTrackLayout, TrackPiece } from './knightsLayout.js';
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
  KnightsRender,
  KnightsTrack,
  RenderFixture,
  RenderLayerContext,
  RenderLayerPlugin,
  HitMode,
  RenderModel,
  ScreenPoint,
} from './types.js';
