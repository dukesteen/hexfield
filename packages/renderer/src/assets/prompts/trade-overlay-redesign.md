# Redesign the actual trade offer UI

The user rejected the currently implemented trade overlay and explicitly said: "what is this, ask claude for a better ui". Their screenshot is `reports/stage05/trade-overlay-user-feedback.png`. Read that image first. It is inside the repo for your image reader. Read the actual current `apps/web/src/features/trade/{IncomingOffers,ResourceCard,TradeComposer,BankTradePicker}.tsx`, `features/trade/trade.css`, relevant `.board-offers` and button rules in `apps/web/src/app.css`, and `apps/web/src/style.css`.

Author a concrete replacement visual design in JSX/CSS snippets on stdout, using Read/Grep/Glob only. Do not edit files. This is implementation-ready UI authorship, not a general design contract. Keep explanation brief, focus on code matched to current components/classes. No dependency. Original clean flat game UI, not a generic dashboard or medieval design.

Current problems visible in the screenshot:

- Enormous verbose "Trade offers (1) · 1 action available" heading. Action availability is implementation jargon.
- A giant browser-default, double-outlined button labelled Offer from Player3 despite being the only offer.
- Give/get headings visually collide.
- Small card faces boxed again, huge count badges obscuring the illustrations.
- Three redundant bulleted "waiting" statuses for an incoming recipient.
- Native grey Accept/Decline buttons and inconsistent spacing.

User intent and required behavior:

- Offers remain a BOTTOM-RIGHT overlay inside the board viewport. Aim~300px wide, about230–300px high for a simple1:1incomingoffer. One offer visible at a time. A compact collapsible header with total count, then named proposer. When only one offer exists, no redundant tab button. Multiple offers get compact navigable chips or previous/next controls.
- Clear trade perspective: recipient sees "You get" and "You give" with a small directional/exchange arrow between resource card groups. Named proposer is in the header. Proposer sees "You give" and "You get", plus explicit per-accepted-player completion actions. Keep exact engine-provided response/confirm/withdraw commands and live validation.
- Resource cards must be the main visual, about44x62or48x68 each, with smallcountcornerbadge that doesnotobscurecentralart. Shortresourcecaptionbeneath. Avoid drawinganotherboxaroundeachcard. Multi-resourcegroupswrapinternally; maxoverlayheightbounded, coreactionssticky/reachable.
- Incoming recipients need Accept primary (accent) and Decline secondary (outlined),44px touch targets, fullwidthbalancedrow. Disabled Accept clearly disabled whileDecline remainsusable. Do not accidentallychangeenginechoicesforvisualreasons.
- Response status detail matters for proposer; compact namedchipswithaccepted/declined/waiting insteadofbullets. Forincomingrecipient, don'tburnspaceonothers'waitingresponses. Preserveavailableacceptedcounterpartychoiceforproposer.
- Theme uses current CSSvariables surface/text/muted/border/control/accent/accent-ink. Inspectexacttokensratherthaninventingundefinedvariables. Native buttonreset globally doesnotcoverallbuttons; explicitlyuseexisting`.button`/`.button-primary`/`.button-quiet`or scopedstyles.
- Highcontrastfocusringonlyonkeyboardfocus, notpermanentmultioutlineonselectedoffer.
- Collapsed summary~44px. Placementmodeforcescollapse, nofullboardpointer-eventsblock, confirmationstaysaboveoverlay. Escape collapses. Use section/details, NOT dialog forpersistentoffer (open dialog disablesboardkeyboardshortcuts).
- Phone390x844: boundedbottom-rightoffer withhand/actionsstillvisible. Composer separatefullscreenmodal. At844x390landscapeoverlaycaninternallyscroll. No documentscroll.
- Keepcardpickerconsistent: selectedcards,palette,countbadges, polishedbuttons. Ifitcurrentlyusesnativeunstyledelements, providecohesivescopedrulesforthoseaswell. Don't balloonthescopeintonewgamebehavior.
- Alltextthroughi18n. Proposernamesandresponsestatusaccessible. Hiddenhandcontentstaysabsentunderprivacycover. Exactcommands/statehandlingremainownedbyourimplementationagent.

Deliver specific replacementmarkupfortheofferheader/exchange/footer, corresponding completeCSSsectionand any sharedcardbadge/pickerbuttonadjustments. Explain majortradesin4sentencesmax. Do not add futureideasorchecklists. The complete visualguide follows. Neweruserrequestsaboveoverrideolderlayoutrecommendations.

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

- Desktop: a viewport-filling cockpit with the board on the left, player rail on the right, and resource hand and primary actions directly below the board. Panes meet at hairline borders without outer gutters. A top-left hamburger overlay replaces header rows. The event log is collapsible.
- Portrait below 768 px: compact player strip, board and bounded hand/action area in one viewport. Secondary details use a disclosure. Trade composition occupies a full-screen sheet; incoming offers stay accessible at the bottom-right of the board. Avoid hiding the next required action below a fixed panel.
- Resource hands and trade terms use original SVG cards with HTML names and quantities. Card selection adds a resource and a separate minus control removes it. Completed public exchanges can animate cards between player panels; offers alone do not trigger a transfer.
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
