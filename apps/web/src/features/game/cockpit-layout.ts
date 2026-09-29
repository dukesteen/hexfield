/** Development cards the wide desktop hand row shows before the rest move to the drawer. */
const WIDE_INLINE_DEVELOPMENT_CARDS = 5;

/**
 * How many development cards sit in the desktop hand row. A narrow desktop's row only fits the
 * five resource cards, so every development card opens from the drawer there.
 */
export function inlineDevelopmentCardLimit(narrowDesktop: boolean): number {
  return narrowDesktop ? 0 : WIDE_INLINE_DEVELOPMENT_CARDS;
}

/**
 * Where focus lands when an action form closes on a phone: the sheet tab that handed off to the
 * form while it is still on screen, else the Build tab.
 */
export function formReturnFocus<T extends Element>(
  handOff: T | null,
  buildTab: T | null,
): T | null {
  return handOff?.isConnected ? handOff : buildTab;
}
