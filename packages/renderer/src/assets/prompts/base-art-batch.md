Create a coordinated batch of original SVG game art for Hexfield. The first forest tile below has been approved on the actual board at desktop and phone widths. Match its clean, flat, friendly natural forms and restrained outlines. The interface must remain readable and modern. No medieval ornament or decorative type.

Output ONLY one valid JSON object with a "files" array. Each item has "path" (exact relative path below) and "svg" (complete SVG markup as a JSON string). Do not use tools, edit files, wrap in Markdown, or explain the output. The coordinator will validate and save the output, then run SVGO. Produce exactly these 17 files:

TERRAIN: same pointy-top viewBox="0 0 200 231", corners 100,0 200,57.75 200,173.25 100,231 0,173.25 0,57.75. Fill the whole hex; keep every form inside it; preserve a quiet center circle radius32 around100,115.5 for a separate number token. Terrain should remain recognizable around that circle. Roughly3unit outlines, 2–3 complementary shades plus base, subtle upper-left highlights, no fine texture. Recognizable at48px as well as256px. Do not add a number or token. Do not bake a thick white tile boundary into SVG; renderer handles seams.

- packages/renderer/src/assets/tiles/hills.svg: base #cb9176, two broad rounded clay ridges with a few exposed angular stone planes, clear identity distinct from mountains.
- packages/renderer/src/assets/tiles/pasture.svg: base #b7d197, open grass and two small simple grazing sheep silhouettes around the central token area. No faces or tiny details.
- packages/renderer/src/assets/tiles/fields.svg: base #e8cb78, broad cropped rows and a few grain heads around the token area, distinct from desert.
- packages/renderer/src/assets/tiles/mountains.svg: base #94a8b1, two or three angular peaks with pale upper-left facets and darker facets, preserve token space.
- packages/renderer/src/assets/tiles/desert.svg: base #ddcda7, broad dune curves and sparse simple stone forms. Calm but identifiable.
- packages/renderer/src/assets/tiles/sea.svg: base #d1e7e9, a few low-contrast wave strokes. No boats or animals.

BOARD OBJECTS:

- packages/renderer/src/assets/tokens/number.svg: viewBox="0 0 80 80". Neutral circular face #fcfdfc with restrained #49665b outline, subtle upper-left highlight. Empty inside for a bold number and pip dots rendered separately. Fill most of viewBox, small3unit safe margin, no text.
- packages/renderer/src/assets/harbors/marker.svg: viewBox="0 0 64 64". Compact neutral harbor badge with a simple dock/anchor hint at the top edge, empty central area for a resource icon or3:1 ratio supplied by renderer. #fcfdfc face, #49665b outline, high-contrast, no text.
- packages/renderer/src/assets/pieces/road.svg: viewBox="0 0 96 24". Horizontal solid rounded road bar, white interior and near-black outline; renderer tints white to player identity color. Light inset/shaded lower edge may use neutral grays; no colored pixels or baked-in player marker. It must be visible over every terrain. Avoid a dashed modern highway.
- packages/renderer/src/assets/pieces/settlement.svg: viewBox="0 0 64 64". Simple compact pitched-roof building silhouette, white interior and near-black outline with restrained neutral gray lower/right facet for tinting. Original minimal geometry, not a castle or medieval cottage, no text, no player color. Keep a clean central area for a small player shape overlay.
- packages/renderer/src/assets/pieces/city.svg: viewBox="0 0 64 64". Larger pair of connected simple rooftops or block forms, unmistakably distinct from settlement at24px. Same white/gray tintable fill and dark outline, no castle/towers/ornament. Keep central area for player shape overlay.
- packages/renderer/src/assets/pieces/robber.svg: viewBox="0 0 64 64". Abstract charcoal pawn with round head and solid tapered base, light inset edge, recognizable at24px. No face, weapons, cloak detail or medieval styling.

RESOURCE ICONS: viewBox="0 0 64 64" each; transparent background, about6unit safe margin, outlines about2.5units, 2–3 harmonious shades, must read at24px. Match terrain palette and forest style. No text/badges.

- packages/renderer/src/assets/resources/lumber.svg: two clean cut log shapes, green/brown palette.
- packages/renderer/src/assets/resources/brick.svg: two clay brick blocks, warm hill palette.
- packages/renderer/src/assets/resources/wool.svg: simple cream fleece tuft/cloud with a green hint, distinct from grain and ore.
- packages/renderer/src/assets/resources/grain.svg: one or two broad golden grain heads with a short stalk, no fine whiskers.
- packages/renderer/src/assets/resources/ore.svg: angular blue-gray mineral chunks with light/shaded facets.

Global constraints: original artwork only; no trademarked names, logos or imitation of official game artwork. Flat SVG with no external references, raster images, scripts, fonts/text, gradients, filters, foreignObject, CSS, masks, clipping paths, or animation. Use only svg,g,path,polygon,polyline,circle,ellipse,rect,line elements and ordinary geometry/fill/stroke attributes. Keep every SVG under8KB; aim for1–3KB. Root SVG must include xmlns and exact viewBox. No unnecessary metadata. Do not copy the forest into output or add extra files. All assets should work on light/dark UI backgrounds.

Complete visual guide:

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

| Terrain   | Base      | Recognizable forms                            |
| --------- | --------- | --------------------------------------------- |
| Forest    | `#80b09a` | Two or three simple tree crowns and trunks    |
| Hills     | `#cb9176` | Rounded ridges and exposed stone planes       |
| Pasture   | `#b7d197` | Open grass with small, simple grazing shapes  |
| Fields    | `#e8cb78` | Broad crop rows and a few clear grain heads   |
| Mountains | `#94a8b1` | Angular peaks with light and shaded facets    |
| Desert    | `#ddcda7` | Two broad dune curves and sparse stone shapes |
| Sea       | `#d1e7e9` | Sparse low-contrast wave strokes              |

Each terrain uses its base plus two or three harmonious values. The shapes provide identification independently of color. No walls, castles, scrolls, banners, or decorative crests.

Tokens, harbors, pieces, robber, and resource icons use the same outline weight and simple geometry. Resource icons must remain legible at 24 px with adjacent text available on hover/focus. Tokens have a neutral face with a strong number; renderer text and pip dots sit on the original SVG token base. Numbers 6 and 8 use red plus their pip count. Player piece SVGs may be neutral masks tinted by the renderer; never encode one player's color into a shared asset.

Generate the first forest tile with `claude -p`, save its complete prompt under `packages/renderer/src/assets/prompts/`, optimize with SVGO, and inspect it on the actual dev board before generating the remaining batch. Pass that approved SVG and this guide as references for the batch. Keep each optimized tile below 8 KB, with no external references or scripts. Record significant art batches in `DECISIONS.md`.

## Motion

- Dice briefly turn or tumble, then settle on the actual result.
- Produced resources travel from their producing hex toward the receiving player panel, making the distribution visible.
- A placed piece makes one small scale transition to confirm placement.
- The robber moves between its old and new hex so the changed restriction is clear.
- Legal targets may pulse gently only while an active choice needs attention.
- Sheets and dialogs use a short opacity/translation transition. No perpetual decorative motion or scroll effects.

Normal transitions last about 140-240 ms; production and robber motion may take 300-450 ms. Provide an animation-speed/skip setting. Under `prefers-reduced-motion`, all movement becomes immediate and the same final information remains visible. Timers and engine progression never depend on an animation completing. Continuous pointer/camera motion stays outside React state and repaints only affected renderer layers.

Approved forest SVG reference:

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 231"><path fill="#80b09a" d="m100 0 100 57.75v115.5L100 231 0 173.25V57.75z"/><g fill="#6d9d87"><ellipse cx="54" cy="105" rx="19" ry="5"/><ellipse cx="100" cy="75" rx="15" ry="4"/><ellipse cx="146" cy="178" rx="30" ry="5.5"/></g><g stroke="#28503f" stroke-linecap="round" stroke-linejoin="round" stroke-width="3"><rect width="8" height="15" x="96" y="60" fill="#7a5a43" rx="2"/><path fill="#3f7d5d" d="m100 18 17 24h-7l13 22H77l13-22h-7Z"/><rect width="8" height="21" x="48" y="84" fill="#7a5a43" rx="2"/><rect width="8" height="17" x="146" y="160" fill="#7a5a43" rx="2"/><path fill="#3f7d5d" d="m150 110 19 27h-8l16 26h-54l16-26h-8Z"/></g><path fill="#5d9a76" d="M100 25 88 41h7Zm-9 22-9 13h8ZM150 117l-14 18h8Zm-9 25-11 17h9Z"/><g fill="#28503f"><circle cx="40" cy="76" r="16.5"/><circle cx="54" cy="60" r="18.5"/><circle cx="66" cy="76" r="15.5"/><circle cx="52" cy="84" r="15.5"/><circle cx="112" cy="174" r="11.5"/><circle cx="124" cy="176" r="9.5"/></g><g fill="#5a9a72"><circle cx="40" cy="76" r="15"/><circle cx="54" cy="60" r="17"/><circle cx="66" cy="76" r="14"/><circle cx="52" cy="84" r="14"/><circle cx="112" cy="174" r="10"/><circle cx="124" cy="176" r="8"/></g><g fill="#8cc49c"><circle cx="47" cy="54" r="6"/><circle cx="34" cy="71" r="4.5"/><circle cx="108" cy="169" r="3.5"/></g></svg>
