Create five original SVG development-card faces for Hexfield. Output ONLY one valid JSON object with a "files" array; each item has exact "path" and complete "svg" markup as a JSON string. Do not use tools, edit files, include Markdown, or explain.

Create exactly:

- packages/renderer/src/assets/cards/development/knight.svg
- packages/renderer/src/assets/cards/development/roadBuilding.svg
- packages/renderer/src/assets/cards/development/yearOfPlenty.svg
- packages/renderer/src/assets/cards/development/monopoly.svg
- packages/renderer/src/assets/cards/development/victoryPoint.svg

Each uses viewBox="0 0 80 112", matching the resource-card face frame: rounded off-white face (#fcfdfc), dark green outline (#49665b) about 2.5–3 units, quiet inner rule/accent, ample central illustration with strong silhouette, no baked text or numbers. Match existing cards at packages/renderer/src/assets/cards/*.svg and the style guide docs/design/style-guide.md. Clean modern flat vectors, semantic palettes from the guide, crisp upper-left highlights. Avoid parchment, decorative type, medieval ornament, scrolls, branded motifs, copied commercial game art, gradients, filters, shadows, external references, embedded raster, and scripts. Art must read at 48x68 and 64x88. Keep under 4 KB after optimization.

Use distinct central images, no words:

- knight: a friendly, calm, original simplified helmeted civic defender in blue/steel colors, no face details, weapon, cloak, castle, heraldic crest, or ornate medieval equipment. Keep form abstract and compact.
- roadBuilding: two clear road pieces crossing/meeting with a small upright settlement-like marker, warm timber and neutral road colors.
- yearOfPlenty: paired harvest ears and stone/resource forms, clearly showing two complementary resource bundles offered together; warm gold, green, and blue-gray.
- monopoly: one central collection basket/crate drawing a few differently colored simple resource shapes inward; clearly one grouped collection, no money or corporate imagery.
- victoryPoint: a bold simple rising star/sun over a low hill or a clean geometric award mark, celebratory without a trophy, laurel, ribbon, seal, or crest. Use restrained blue/gold.
  Use a consistent illustration scale and card-frame language but distinct palettes/shapes. Do not add a shared back or extra files.
