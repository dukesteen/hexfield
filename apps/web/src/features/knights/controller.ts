import type { Track } from './state';

/** What the rest of the screen can ask of a knights game: buy a level, play a card, discard. */
export interface KnightsController {
  /** The tracks the seat can buy a level on right now. */
  readonly improvable: readonly Track[];
  /** Buy the next level of a track. */
  improve(track: Track): void;
  /** Start playing a progress card: a dialog, or taps on the board for a card aimed at it. */
  playCard(slotId: string, card: string): void;
  /** True when the engine offers a play for this card slot right now. */
  playable(slotId: string): boolean;
  /** Open the discard dialog for progress cards over the limit. */
  openDiscard(): void;
  /** Open the improvements dialog (phones). */
  openImprovements(): void;
  /** Open the Commercial Harbor offers again after closing them. */
  openHarbor(): void;
  /** True while a move is being sent, or the game stopped. */
  readonly disabled: boolean;
  /** A Commercial Harbor the seat played is still open for offers. */
  readonly harborOpen: boolean;
}
