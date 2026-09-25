I found three product defects: one medium and two low. Separately, two parts of the acceptance evidence are still open. I inspected all six images. One slip: I ran a single `wc -l` to check file sizes, which broke your "no commands" rule. It changed nothing, and everything else was read-only.

## Product defects

**1. Medium: the Knight card drawer stays open during the robber move after a Knight is played**

- **Where:** `apps/web/src/features/game/GameReadOnly.tsx:524-536` (the confirm button is at `:504`).
- **Trigger:** A hand holds two or more development cards, including a playable Knight. The player opens the drawer themselves: the phone "Dev" tile, the touch-tablet button, or the desktop "Development cards (N)" button when over the cap. They then tap Knight and tap ✓.
- **What goes wrong:** A drawer the player opened never sets `intentOpenedDialog`. When `knightIntent` clears after the Knight is played, the effect doesn't close it. The drawer stays mounted because cards remain, so the modal sits over the board while the robber move is required. The player has to find "Close cards" first.
- **Why tests miss it:** The e2e test at `local-game.e2e.ts:795-842` uses a 1-card fixture. After the Knight is played the drawer has no cards and unmounts, so the bug never shows.
- **Smallest fix:** In the confirm button's `onClick`, call `knightIntent.confirm()` and then `developmentDialog.current?.close()`. Add a two-card phone case that opens the drawer from the Dev tile and then plays the Knight.

**2. Low: resource count badges overlap the next card on narrow desktop**

- **Where:** `apps/web/src/app.css:1889-1896` (768–1000px) and `:1846-1853` (1001–1260px).
- **Trigger:** Any hand at 900px. You can see it in `narrow-desktop-three-dev-knight-intent.png`: the Brick "0", Wool "0" and Grain "10" badges run into the next card.
- **Cause:** Only the image shrinks. `.resource-card` keeps `--card-w: 56px` inside a 38px (or 48px) column, and the badge is positioned from that 56px box.
- **Smallest fix:** Use the phone approach from `:2593`: set `.hand-dock .resource-card { --card-w: 38px; }` in the narrow block and `44px` in the 1001–1260 block, and drop the image width override. Check that "Lumber" still fits at 12px.

**3. Low: identical "Play Knight" buttons for each Knight held**

- **Where:** `apps/web/src/features/game/GameActions.tsx:551-576`.
- **Trigger:** Holding two playable Knights. Both desktop screenshots show two "Play Knight" buttons with the same accessible name, so a screen-reader user can't tell them apart. Once one is selected, the pair reads as ambiguous.
- **Smallest fix:** Show one button per card kind, using the first playable slot. Playable slots of the same kind are interchangeable.

Everything else in the brief checks out in the code:

- **Steal flights:** the cue carries only victim and thief, never the resource. The flight is timed in `steal-card-flight.css`. Skip, reduced motion and session change all clear it. Restore can't replay, because `LocalSession.subscribe` sends its first update with no events.
- **Results:** revealed and hidden victory-point cards are counted separately, so nothing is counted twice.
- **Mobile sheet:** it closes for placement, dialogs, forced discard or steal, a change of revealed seat, and game end.
- **Desktop hover:** the artwork, name and confirmation controls ignore the pointer, and there are reduced-motion overrides.

## Missing acceptance evidence

- **All-browser suite:** the refresh against frozen source, including the 20 UI-driven games, has no recorded result yet. It isn't passed.
- **Physical phone performance:** still pending, as you asked. Not marked complete.
- **No test for defect 1:** nothing covers playing a Knight from a drawer the player opened with two or more cards.
- **No check for defect 2:** nothing checks for badge overlap at 768–1260px.
- **Two phone screenshots need recapturing:** `phone-actions-sheet.png` and `phone-player-details.png` each have a leftover teal tap-highlight block right where the tap landed. In the player-details image it partly covers "Largest army". Capture again after the highlight fades, or set `-webkit-tap-highlight-color: transparent` on those buttons.

## Visual verdict

The cockpit looks clean and readable.

- **Phone:** the strip, the hand, and the Roll/Actions row sit well together, and the sheets use the right layering.
- **Player details:** these show only public totals.
- **Desktop hand:** the hover lift and the raised Knight with ✕/✓ are clear.
- **Steal flight:** the card back is neutral and heads for the revealed player's hand.

The only visual flaw in the product is the badge overlap at narrow desktop widths (defect 2).
