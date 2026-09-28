import type { KnightsTrack } from '../types.js';
import { artUrl, normalizeArtColor } from './terrainTextures.js';

export type CommodityName = 'paper' | 'cloth' | 'coin';
export type EventDieFace = 'ship' | KnightsTrack;

/** A commodity as a small icon for counts and buttons. */
export function getCommodityIconUrl(commodity: CommodityName): string {
  return artUrl(`ck-icon-${commodity}`);
}

/** A commodity card face, drawn like the resource cards. */
export function getCommodityCardUrl(commodity: CommodityName): string {
  return artUrl(`ck-card-${commodity}`);
}

/** The improvement track's emblem: a market, a tower or an open book. */
export function getTrackIconUrl(track: KnightsTrack): string {
  return artUrl(`ck-icon-${track}`);
}

/** The five-cell banner printed for a track, with the cost dots and the ability stars. */
export function getImprovementBannerUrl(track: KnightsTrack): string {
  return artUrl(`ck-improve-${track}`);
}

/** The back of a progress card of a deck. */
export function getProgressBackUrl(track: KnightsTrack): string {
  return artUrl(`ck-progress-back-${track}`);
}

/** A face of the event die: a ship or the gate of a track. */
export function getEventDieUrl(face: EventDieFace): string {
  return artUrl(`ck-event-die-${face}`);
}

/** A face of the red production die. */
export function getRedDieUrl(face: number): string {
  return artUrl(`ck-red-die-${Math.min(6, Math.max(1, Math.trunc(face) || 1))}`);
}

/** A knight of a colour, for lists and buttons. */
export function getKnightIconUrl(color: string, level: number, active = true): string {
  const clamped = Math.min(3, Math.max(1, Math.trunc(level) || 1));
  return artUrl(
    `ck-knight-${normalizeArtColor(color)}-${clamped}-${active ? 'active' : 'inactive'}`,
  );
}

export function getWallIconUrl(color: string): string {
  return artUrl(`ck-wall-${normalizeArtColor(color)}`);
}

export function getWalledCityIconUrl(color: string): string {
  return artUrl(`ck-city-walled-${normalizeArtColor(color)}`);
}

/** A metropolis of a track, in a player colour or the shared neutral piece when `color` is omitted. */
export function getMetropolisIconUrl(track: KnightsTrack, color?: string): string {
  return artUrl(
    color === undefined
      ? `ck-metropolis-${track}`
      : `ck-metropolis-${track}-${normalizeArtColor(color)}`,
  );
}

export function getMerchantIconUrl(color: string): string {
  return artUrl(`ck-merchant-${normalizeArtColor(color)}`);
}

/** The barbarian ship, small, for the countdown and the log. */
export function getBarbarianShipUrl(): string {
  return artUrl('ck-barbarian-ship');
}

export function getDefenderIconUrl(): string {
  return artUrl('ck-icon-defender');
}

export function getDefenderCardUrl(): string {
  return artUrl('ck-card-defender');
}

export type GlyphName =
  | 'knight'
  | 'roads'
  | 'monopoly'
  | 'plenty'
  | 'longest'
  | 'victory'
  | 'bankTrade'
  | 'playerTrade';

const GLYPHS: Readonly<Record<GlyphName, string>> = {
  knight: 'icon-knight',
  roads: 'icon-roads',
  monopoly: 'icon-monopoly',
  plenty: 'icon-plenty',
  longest: 'icon-longest',
  victory: 'icon-victory',
  bankTrade: 'icon-bank-trade',
  playerTrade: 'icon-player-trade',
};

/** A base-game emblem (a helmet, a road, a crown, a coin exchange) reused on progress cards. */
export function getGlyphUrl(glyph: GlyphName): string {
  return artUrl(GLYPHS[glyph]);
}
