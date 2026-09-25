Create five original SVG resource-card faces for Hexfield, matching the existing resource icons and visual guide. Output ONLY one valid JSON object with a "files" array; each item must have exact "path" and complete "svg" markup as a JSON string. Do not use tools, edit files, include Markdown, or explain.

Create exactly these files:

- packages/renderer/src/assets/cards/brick.svg
- packages/renderer/src/assets/cards/lumber.svg
- packages/renderer/src/assets/cards/wool.svg
- packages/renderer/src/assets/cards/grain.svg
- packages/renderer/src/assets/cards/ore.svg

Each uses viewBox="0 0 80 112" (portrait card ratio close to 48x68). Design a clean modern poker-ish frame: rounded off-white face (#fcfdfc), quiet dark green outline (#49665b), restrained resource-colored border/top accent or inner rule. No medieval ornament, parchment, decorative type, numbers, letters, symbols that imply quantity, gradients, filters, shadows, external resources, scripts, or baked labels. Use flat fills, simple geometry, crisp contrast, and generous margins. Cards must read clearly at 48x68 and 64x88. The central resource illustration should fill about 48x48 units and be the visual focus. Keep the frame consistent across all five while each card has a distinct semantic color and image.

Use these existing palette cues:

- brick: warm clay #c47d60, light #e0ae94, shaded #9c5b45, dark outline #6b3a2b; depict a compact stack of three simple bricks.
- lumber: bark brown #7a5a43, endgrain tan #d9b27f, green sprout #5a9a72, outline #4a3527; depict two crossed short logs with clear cut ends.
- wool: fleece cream #f6f0dc and #e4d9bb, dark olive outline #7b6f55, small pasture green #80b09a; depict a simple fluffy wool bundle, no face.
- grain: golden #e2b448, pale #f5dc94, green #8fb86e, outline #7a5a1f; depict three broad wheat heads with simple stalks.
- ore: rock blue-gray #8aa0aa, highlight #d3e0e5, shade #5d7480, outline #33474f; depict two angular ore chunks with clean facets.

The existing 64x64 resource icon SVGs under packages/renderer/src/assets/resources/ show the established icon language. Match their roughly 2.5–3 unit outlines and upper-left highlights, adapting detail to a card's larger central art. A tiny resource-color cue near the lower inside edge is okay if shape-only; the five illustrations themselves should carry identity. Ensure all drawing is visible inside the rounded card frame. Use valid SVG2 with no XML comments.
