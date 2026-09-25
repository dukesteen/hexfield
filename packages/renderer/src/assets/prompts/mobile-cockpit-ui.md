# Compact mobile game cockpit

The user explicitly requested Claude's help redesigning the mobile UI and supplied this screenshot:
/var/folders/gd/b0yk1bp93z398wwsgy13q29w0000gn/T/codex-clipboard-Kw7Lse.png

Read that image and these relevant files only. This is a read-only design consultation; do not edit files or run commands.

- docs/design/style-guide.md
- apps/web/src/features/game/GameReadOnly.tsx
- apps/web/src/features/game/GameActions.tsx
- apps/web/src/features/board/BoardView.tsx
- apps/web/src/features/board/PlacementConfirmation.tsx
- apps/web/src/app.css
- apps/web/src/style.css
- apps/web/src/features/dialogs/DialogFrame.tsx
- apps/web/src/i18n/locales/en/game.json
- apps/web/src/store/session-store.ts

User request: the mobile hand/actions dock consumes too much height. They suggest keeping the hand at the bottom by default and a floating button to open Actions, or another more compact design. They also explicitly want tapping each mobile player tile to show all that player's public information, including knights played and the other stats.

Give one concrete, implementable design and React/CSS integration plan, not a menu of options. Preserve the desktop cockpit and the clean modern visual language. No medieval ornament, new UI libraries, decorative clutter or animations unrelated to a state change.

Constraints and important flows:

- Reclaim substantial board height on portrait phones (390x844 and narrower), keeping a compact hand pinned at the bottom. The current separate Hand and Actions blocks total roughly 310-330px, with a player strip above them.
- A clearly labeled floating Actions control may open a bottom sheet; preserve 44px touch targets. Explain what happens for Roll, End turn, Build, trade forms and development cards. The next required decision must remain discoverable even while the sheet is closed.
- Setup, road/settlement/city previews, free-road choices and robber movement happen on the board with explicit on-board confirmation. Selecting a build action must reveal the board. Do not cover these controls with a modal sheet. Discard/steal/resource pickers and privacy handoff dialogs remain mandatory when appropriate.
- Knight confirmation is on the bottom of the Knight card, with cross/check controls; compact hands already have a Development cards dialog. Avoid trapping it underneath another modal.
- Keep one source of action availability and submission logic. Avoid rendering duplicate active action controllers or duplicate player panels. Native dialogs already provide focus containment. Consider top-layer ordering when an action sheet opens a nested trade/card/cost dialog.
- Each player tile opens a mobile detail sheet showing only existing public info: name, color+shape, public VP, resource-card total, unrevealed development-card total, knights played, longest road length, remaining roads/settlements/cities, awards, status/timer, and recent public production gains. Never reveal resource identities or development-card identities from an opponent's private state.
- Keep eight-second public production receipts visible in the compact player strip and in open details. Preserve stable player-panel anchors for card-flight animations.
- Keep Bank/Event log accessible. Preserve hamburger, last dice roll, incoming trade overlay and existing keyboard board chooser.
- No document scrolling. Sheets can scroll internally, with a visible Close/back control and safe-area padding. Escape and dismissal restore focus. Phone landscape 844x390 must remain usable; suggest a compact landscape variant instead of stacking tall regions.
- All strings through i18next; both themes; respect reduced motion. Use existing card/piece graphics.

Return a compact spec with exact layout measurements, sheet/trigger behavior, state ownership and DOM placement. Identify real risks in the current component structure and show representative code for the recommended integration. The user has authorized this work; do not ask for further confirmation.
