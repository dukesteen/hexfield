# Game Actions dock: read-only design consultation

Review the current Hexfield local-game Actions dock and propose a concrete, original UI treatment. Do not edit repository files. The user likes the clean resource-card selection UI but says the bottom Actions area needs clearer artwork. Preserve the game's modern, readable character; no medieval ornament, parchment, faux wood, gradients for decoration, or giant icon-only controls.

Inspect these sources and screenshots:

- `apps/web/src/features/game/GameActions.tsx`, especially the `dock` JSX.
- `apps/web/src/app.css`, especially `.action-dock`, `.action-row`, `.game-bottom`, and mobile media rules.
- `apps/web/src/features/actions/availability.ts` for exact legal-action data.
- Existing vector assets in `packages/renderer/src/assets/pieces/`, `assets/cards/`, and `assets/resources/`.
- `reports/stage05/desktop-wide-cockpit.png` and `reports/stage05/phone-cockpit.png`.
- `docs/design/style-guide.md` and `docs/05-local-ui.md` for established direction and viewport constraints.

The screenshot reference is an older plain-text dock; current controls are similar. The dock shows legal board choices such as road edge/city site, turn actions such as Roll dice or End turn, bank/player trade, and occasionally development-card plays. A board choice enters placement mode and highlights exact legal targets; it does not itself submit a build. Disabled or unavailable actions must remain unmistakable, but the controller generally omits illegal actions. Keep text labels, 44 px minimum touch targets, visible keyboard focus, high contrast in light/dark modes, and the one-viewport cockpit. At 390×844 portrait and 844×390 landscape, Actions shares scarce space with the hand and board. Avoid tall card stacks or nested framed panels. The board, hand, player strip, and next action must remain visible. Screen reader action names must be direct.

Please give:

1. A short diagnosis of current hierarchy and where artwork materially clarifies the action.
2. A concrete recommendation for button families, size, grouping, typography, hover/selected/disabled/focus states, and desktop/phone/short-landscape layout. Distinguish primary turn progression (Roll/End turn) from build and trade choices without making every button loud.
3. Specific JSX/CSS changes that fit the existing GameActions controller and app.css; keep all validation and visible-control submission behavior unchanged. Explain whether costs should appear only if supplied by authoritative engine data; do not invent a second rule table.
4. A small original SVG icon set matching the existing simple vector art: suggested motifs, viewBox, stroke/fill palette and state coloring. Draft SVG markup for the core actions (road, settlement, city, dice, end turn, bank trade, player trade), or explain which existing asset should be reused. Keep icons subordinate to labels and avoid decorative clutter.
5. Acceptance checks: four viewport sizes (1728×944, 1280×720, 390×844, 844×390), keyboard and screen-reader semantics, no document overflow, legal placement mode visibly selected, and no regression to the 20-game visible-controls test.

Prefer one coherent recommendation, not a menu of redesign directions. Flag any source detail that makes the proposed design unsafe or impractical. The output is advice for our review; do not modify source.
