# Resource cards and board trade overlay

The user wants a clean, readable local Catan-style game cockpit. They have now asked for actual original SVG resource cards instead of text-led resource tiles, so cards can also be shown trading between players. Player trades should be composed by selecting cards they have and selecting cards they want. Incoming trade offers belong in the BOTTOM-RIGHT of the BOARD VIEWPORT as an overlay, not in the actions panel. This is only UI placement, not a change to engine state or game rules.

Use Read/Grep/Glob only. Do not edit files. Give concrete JSX/CSS/interaction guidance under 1500 words. No new dependencies, no engine changes, no copied branded art.

Inspect apps/web/src/features/trade/{TradeComposer,BankTradePicker,IncomingOffers}.tsx, features/dialogs/resources.tsx, features/game/{GameReadOnly,GameActions,use-visual-effects}.tsx or .ts, apps/web/src/app.css, and packages/renderer/src/assets/manifest.ts if present. Files are being implemented concurrently, so recommend bounded refinements rather than full rewrites.

Implementation boundaries already agreed: one agent authors five original SVG card assets and getResourceCardUrl(resource); another implements trade components + a shared card display/picker; layout agent moves the existing incoming offers UI into an absolute bottom-right board slot and uses the shared cards for the hand. This consultation is for cohesive design, interaction and potential problems.

Requirements:

- Actual consistent clean SVG card faces ~80x112 viewBox, no baked text, central resource illustration from the existing flat original icons/terrain palette. Render resource names and counts in HTML with accessible names. Five different palettes and shapes, not color alone. Readable at about48x68 or64x88 CSS px.
- Hand remains all five resources visible in bounded bottom HUD. Show grouped stacks/counts, do not render an unbounded fan of every card. Keep hidden hand removed from DOM during privacy cover.
- Player trade composer: tap/click a resource card to increment offered/requested quantity, obvious selected count and a separate accessible minus button to remove. Offered counts capped by actual visible private hand. No resource number-input form as primary UI. Want side can ask any valid resource count, engine validates final terms. Recipients remain explicit. Sending creates offer only, does not transfer cards.
- Bank composer should use same vocabulary and card selection, show each engine-derived harbor rate and distinguish input card count from output units. Avoid giant list of every possible shortcut.
- Bottom-right offers overlay: compact, card groups with a direction arrow, named proposer/recipient context that makes who gives/receives unambiguous, response controls, accepted recipient choice/withdraw. Multiple offers must not cover the whole board; consider tabs/counter/collapse with a clear pending badge. Do not bury response actions or show stale offers as actionable.
- On mobile390x844, incoming offer affordance stays bottom-right of board; expanding can use a bounded overlay or sheet. Composer can be full-screen native dialog. All buttons touch44px, no horizontal/document overflow. Portrait/short landscape working.
- Coexist with top-left44px hamburger overlay, keyboard target chooser, and on-board piece confirm/cancel popup. Do not block placement targets with full-board pointer interception. Details/long lists can scroll internally, core actions remain reachable.
- Existing use-visual-effects handles resource flights. Recommend how accepted public trades can show card graphics between player panels, only after committed event and with skip/reduced-motion support. Do not expose private stolen-card resource types or fabricate transfers on offer/accept.
- All visible strings use i18n. Reuse theme variables and existing fonts. Short motion only for selected card lift/committed exchange, no continuous flourish.

Give the interaction and layout contract with key CSS, and identify any serious ambiguous perspective or privacy risk in current code. The appended style guide is a reference; newest user layout request overrides older header/gutter/stepper guidance.

# Hexfield visual guide

## Direction

A local board game for casual players, with a clean, modern interface and predictable controls. The board carries the character; labels and controls explain the next decision. Avoid medieval ornament, parchment, decorative type, artificial wear, and imitation of published board-game artwork.

This is a new game interface replacing the foundation placeholder. The frontend design skill applies to the home screen where relevant; its marketing layouts do not govern the game controls. The interface uses native accessible React controls and a Pixi board, with an original visual system rather than claiming to implement a named commercial design system.

- `DESIGN_VARIANCE: 3`: stable positions for turn, hand, actions, and players.
- `MOTION_INTENSITY: 4`: short feedback and transitions that explain game events.
- `VISUAL_DENSITY: 5`: enough information to play without opening several panels, with secondary detail collapsible.

## Interface tokens

| Purpose            | Light     | Dark      |
| ------------------ | --------- | --------- |
| Page               | `#f4f7f6` | `#15231f` |
| Surface            | `#fcfdfc` | `#1d3029` |
| Raised surface     | `#eaf0ed` | `#294137` |
| Main text          | `#18332b` | `#edf5f0` |
| Secondary text     | `#49665b` | `#adc5b8` |
| Border             | `#b9ccc3` | `#49685b` |
| Control boundary   | `#738d81` | `#6b9984` |
| Accent             | `#086b52` | `#80d9b4` |
| Accent button text | `#fcfdfc` | `#153226` |
| Error text         | `#ae3329` | `#ffaaa0` |

Use one accent for navigation and primary actions. Terrain, resources, player identity, warnings, and errors have semantic colors and are not decorative accents. Respect system theme by default and allow a saved light/dark/system setting. Every screen uses the selected theme throughout.

The quiet border is for grouping panels. Inputs and controls that need a visible boundary use the stronger control-boundary token. Against their surface, body text has contrast ratios of 13.31:1 in light mode and 12.55:1 in dark mode; secondary text has 6.18:1 and 7.60:1. Accent-button text has 6.37:1 and 8.25:1. Control boundaries have 3.52:1 and 4.32:1. Recheck rendered combinations if tokens change.

Use a native sans-serif stack: `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`. Default body 16 px, compact game labels 14 px, secondary metadata no smaller than 12 px. Headings use weight and spacing rather than ornament. Use tabular numerals for counts and timers. No externally hosted fonts.

Spacing follows 4, 8, 12, 16, 24, and 32 px. Controls have 8 px corners, panels 12 px, and sheets/dialogs 16 px. Round tokens and circular semantic markers are separate game objects. Prefer spacing and a quiet border to shadows; use a shadow only for floating dialogs and sheets. All interactive targets are at least 44 CSS px on touch. Focus rings remain visible in both themes. Validate text, controls, placeholders, and focus contrast before acceptance.

The z-index scale is board controls 10, sticky mobile controls 20, sheets 30, dialogs 40, and privacy cover 50. Developer tools remain outside ordinary game flows.

## Layout and interaction

- Desktop: restrained header, central board, player rail on the right, resource hand and primary actions along the bottom. The event log is collapsible.
- Portrait below 768 px: compact header and player strip, board above the hand/action sheet. Trades occupy a full-screen sheet. Avoid hiding the next required action below a fixed panel.
- The home screen provides a direct new-game action and real saved games. Any board preview uses the actual renderer and game data, not an invented screenshot or stock photograph.
- The new-game form groups players, board/rule choices, and timers. Keep advanced options in a labeled disclosure without omitting them.
- During a turn, emphasize the current instruction and next action. Setup and build modes share one selection pattern. Show legal targets and a clear cancel action.
- Privacy covers remove private hand content from view and keyboard access until the next player explicitly reveals it.
- Pair player color with a distinct shape/pattern and a name. Keyboard users get named, focusable target choices alongside canvas selection.
- Copy is functional and short. All visible text, labels, errors, tooltips, resource names, and event text use translation keys.

## Player identity

Default identity colors are blue `#0072b2`, orange `#d55e00`, green `#009e73`, and magenta `#b35b93`. Pair these consistently with circle, triangle, square, and diamond markers. Pieces need a light inset and dark outline so identity remains visible over any terrain. Do not rely on red/green differences alone. Custom color choices must retain a distinct marker.

## Board art

Use original, flat vector art with simplified natural forms and a restrained upper-left highlight. No raster images, external references, fonts, filters, gradients, branded motifs, or copied official maps/artwork. Avoid fine noise and excessive decoration. Tiles must read at 48 px while retaining clean shapes at 256 px.

Pointy-top terrain SVGs use `viewBox="0 0 200 231"`, with hex corners `(100,0)`, `(200,57.75)`, `(200,173.25)`, `(100,231)`, `(0,173.25)`, `(0,57.75)`. Keep all artwork inside the hex. Use roughly 3 px strokes at this viewBox, rounded joins where natural, and a quiet perimeter. The central number token occupies a radius of about 32 units around `(100,115.5)`; terrain landmarks should remain identifiable around it.

| Terrain   | Base      | Recognizable forms                                          |
| --------- | --------- | ----------------------------------------------------------- |
| Forest    | `#80b09a` | Two or three simple tree crowns and trunks                  |
| Hills     | `#cb9176` | Rounded ridges and exposed stone planes                     |
| Pasture   | `#b7d197` | Open grass with small, simple grazing shapes                |
| Fields    | `#e8cb78` | Broad crop rows and a few clear grain heads                 |
| Mountains | `#94a8b1` | Angular peaks with light and shaded facets                  |
| Desert    | `#ddcda7` | Two broad dune curves and sparse stone shapes               |
| Sea       | `#a8d6e8` | Blue wave strokes `#629eb8` and subtle highlights `#e2f3f9` |

Each terrain uses its base plus two or three harmonious values. The shapes provide identification independently of color. No walls, castles, scrolls, banners, or decorative crests.

Tokens, harbors, pieces, robber, and resource icons use the same outline weight and simple geometry. Resource icons must remain legible at 24 px with adjacent text available on hover/focus. Tokens have a neutral face with a strong number; renderer text and pip dots sit on the original SVG token base. Numbers 6 and 8 use red plus their pip count. Player piece SVGs may be neutral masks tinted by the renderer; never encode one player's color into a shared asset.

Board objects share the camera scale. A token's face, numeral and pips keep their proportions, as do a port's connecting arms, badge, resource symbol and ratio. Port labels stay upright. Fit the island and port badges with a small margin; decorative water may extend beyond the viewport. Canvas labels naturally become smaller when zooming out. The interface text minimum does not justify enlarging labels independently of their board objects. Phone players can zoom for detail, and keyboard location descriptions include port access.

Generate the first forest tile with `claude -p`, save its complete prompt under `packages/renderer/src/assets/prompts/`, optimize with SVGO, and inspect it on the actual dev board before generating the remaining batch. Pass that approved SVG and this guide as references for the batch. Keep each optimized tile below 8 KB, with no external references or scripts. Record significant art batches in `DECISIONS.md`.

## Motion

- Dice briefly turn or tumble, then settle on the actual result.
- The rolling pair stays centered over the visible board, with 64 px dice on desktop and 56 px dice on phone layouts. Its size is independent of board zoom.
- Produced resources travel from their producing hex toward the receiving player panel, making the distribution visible.
- A placed piece makes one small scale transition to confirm placement.
- The robber moves between its old and new hex so the changed restriction is clear.
- Legal targets may pulse gently only while an active choice needs attention.
- Sheets and dialogs use a short opacity/translation transition. No perpetual decorative motion or scroll effects.

Normal transitions last about 140-240 ms; production and robber motion may take 300-450 ms. Provide an animation-speed/skip setting. Under `prefers-reduced-motion`, all movement becomes immediate and the same final information remains visible. Timers and engine progression never depend on an animation completing. Continuous pointer/camera motion stays outside React state and repaints only affected renderer layers.
