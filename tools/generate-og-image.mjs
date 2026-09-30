// Regenerate the share image and icons: node tools/generate-og-image.mjs
// Composes the redesign art into SVG, renders it with Playwright's Chromium and, when the
// pngquant binary is on PATH, quantises the PNGs so they stay small for link previews.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const root = new URL('../', import.meta.url);
const art = new URL('packages/renderer/src/assets/redesign/', root);
const fonts = new URL('apps/web/src/assets/fonts/', root);
const out = new URL('apps/web/public/', root);
mkdirSync(out, { recursive: true });

// The dark theme of apps/web/src/redesign.css.
const palette = {
  page: '#29252a',
  surface: '#332c32',
  text: '#f5ebd9',
  muted: '#cfbfac',
  accent: '#eea184',
  brand: '#a6362a',
};
const round = (value) => Number(value.toFixed(2));
const SQRT3 = Math.sqrt(3);

/** Collects each art file once as a <symbol> with namespaced IDs, like generate-board-preview. */
function spriteSheet() {
  const symbols = new Map();
  const use = (name, x, y, width, height, anchorX = 0.5, anchorY = 0.5) => {
    if (!symbols.has(name)) {
      const source = readFileSync(new URL(`${name}.svg`, art), 'utf8');
      const viewBox = /viewBox="([^"]+)"/.exec(source)?.[1];
      assert(viewBox, `${name} needs a viewBox`);
      const body = source
        .slice(source.indexOf('>') + 1, source.lastIndexOf('</svg>'))
        .replace(/<metadata[\s\S]*?<\/metadata>/g, '')
        .replace(/\bid="([^"]+)"/g, `id="${name}-$1"`)
        .replace(/url\(#([^)]+)\)/g, `url(#${name}-$1)`)
        .replace(/href="#([^"]+)"/g, `href="#${name}-$1"`);
      symbols.set(name, `<symbol id="${name}" viewBox="${viewBox}">${body}</symbol>`);
    }
    return `<use href="#${name}" x="${round(x - width * anchorX)}" y="${round(y - height * anchorY)}" width="${round(width)}" height="${round(height)}"/>`;
  };
  return { use, defs: () => [...symbols.values()].join('\n') };
}

/** Pointy-top axial layout (the engine's hexToPixel), offset to `origin`. */
function layout(size, origin) {
  const center = (q, r) => ({
    x: origin.x + SQRT3 * size * (q + r / 2),
    y: origin.y + 1.5 * size * r,
  });
  const angles = { N: -90, NE: -30, SE: 30, S: 90, SW: 150, NW: -150 };
  const corner = (q, r, name) => {
    const c = center(q, r);
    const angle = (angles[name] * Math.PI) / 180;
    return { x: c.x + size * Math.cos(angle), y: c.y + size * Math.sin(angle) };
  };
  return { center, corner };
}

// A slice of a seafaring board: a small island with a knight guarding its coast and a ship
// sailing past. Everything else within reach of the frame is sea.
const LAND = [
  { q: 0, r: -2, tile: 'tile-fields-1', token: 9 },
  { q: 1, r: -2, tile: 'tile-mountains-2', token: 5 },
  { q: -1, r: -1, tile: 'tile-pasture-2', token: 10 },
  { q: 0, r: -1, tile: 'tile-forest-1', token: 6 },
  { q: 1, r: -1, tile: 'tile-hills-1', token: 8 },
  { q: -1, r: 0, tile: 'tile-pasture-1', token: 4 },
  { q: 0, r: 0, tile: 'tile-fields-2', token: 11 },
  { q: -2, r: 1, tile: 'tile-forest-3', token: 3 },
];

/** Road art by edge direction, as in renderer/roadVariant: 1 "\", 2 "|", 3 "/". */
function roadArt(color, from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const variant = Math.abs(dx) < 1 ? 2 : dx * dy > 0 ? 1 : 3;
  return { name: `road-${color}-${variant}`, x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
}

/**
 * The board slice as SVG content. `size` is the hex radius; `origin` the centre of hex 0,0;
 * `keep` filters which hexes are drawn (so the slice can leave room for the wordmark).
 */
function boardSlice({ size, origin, bounds, keep, pieceScale = 1.2 }) {
  const tokenUnit = (size / 80) * 1.2;
  const { use, defs } = spriteSheet();
  const { center, corner } = layout(size, origin);
  const tileW = (size * 150) / 80;
  const tileH = (size * 174) / 80;
  const land = new Map(LAND.map((hex) => [`${hex.q},${hex.r}`, hex]));
  const hexes = [];
  for (let r = -6; r <= 6; r += 1) {
    for (let q = -8; q <= 8; q += 1) {
      const c = center(q, r);
      if (c.x < bounds.x - tileW || c.x > bounds.x + bounds.width + tileW) continue;
      if (c.y < bounds.y - tileH || c.y > bounds.y + bounds.height + tileH) continue;
      if (!keep(c, q, r)) continue;
      const hex = land.get(`${q},${r}`) ?? {
        q,
        r,
        tile: `tile-sea-${1 + ((((q * 7 + r * 13) % 3) + 3) % 3)}`,
        token: null,
      };
      hexes.push({ ...hex, c });
    }
  }
  const unit = (size / 80) * pieceScale;
  const layers = [];
  // Back to front so each row's tile overlaps the thickness of the row above.
  for (const hex of hexes.toSorted((a, b) => a.r - b.r || a.q - b.q))
    layers.push(use(hex.tile, hex.c.x, hex.c.y, tileW, tileH));
  // The same outline, as one shadow shape under the whole slice.
  const outline = hexes
    .map(
      (hex) =>
        ['N', 'NE', 'SE', 'S', 'SW', 'NW']
          .map((name, index) => {
            const p = corner(hex.q, hex.r, name);
            return `${index ? 'L' : 'M'}${round(p.x)} ${round(p.y + size * 0.14)}`;
          })
          .join('') + 'Z',
    )
    .join('');
  for (const hex of hexes)
    if (hex.token)
      layers.push(use(`token-${hex.token}`, hex.c.x, hex.c.y, tokenUnit * 44, tokenUnit * 44));

  const roads = [
    ['blue', corner(0, -1, 'S'), corner(0, -1, 'SE')],
    ['blue', corner(0, -1, 'SE'), corner(0, -1, 'NE')],
    ['orange', corner(-1, 0, 'SW'), corner(-1, 0, 'S')],
    ['orange', corner(-1, 0, 'S'), corner(0, 0, 'SW')],
  ];
  for (const [color, from, to] of roads) {
    const road = roadArt(color, from, to);
    layers.push(use(road.name, road.x, road.y, unit * 51.2, unit * 51.2));
  }
  const city = corner(0, -1, 'SE');
  layers.push(use('city-blue', city.x, city.y, unit * 48, unit * 50, 23 / 48, 28 / 50));
  const settlement = corner(-1, 0, 'SW');
  layers.push(
    use('settlement-orange', settlement.x, settlement.y, unit * 40, unit * 40, 0.5, 22 / 40),
  );
  const settlement2 = corner(0, -2, 'SE');
  layers.push(
    use('settlement-blue', settlement2.x, settlement2.y, unit * 40, unit * 40, 0.5, 22 / 40),
  );
  // The knight on the coast, facing the sea; the ship on the open water beyond it.
  const knight = corner(0, 0, 'SE');
  layers.push(
    use('ck-knight-blue-2-active', knight.x, knight.y, unit * 44 * 1.4, unit * 34 * 1.4, 0.5, 0.6),
  );
  const shipFrom = corner(1, 0, 'S');
  const shipTo = corner(1, 0, 'SE');
  const ship = { x: (shipFrom.x + shipTo.x) / 2, y: (shipFrom.y + shipTo.y) / 2 };
  layers.push(
    use('sf-ship-orange-3', ship.x, ship.y, unit * 40 * 1.9, unit * 38 * 1.9, 0.475, 0.61),
  );
  return { defs: defs(), outline, body: layers.join('\n') };
}

const fontFace = (family, file) =>
  `@font-face{font-family:'${family}';src:url(data:font/ttf;base64,${readFileSync(new URL(file, fonts)).toString('base64')}) format('truetype');}`;

/** A pointy hexagon path centred on cx, cy with radius r. */
function hexPath(cx, cy, r) {
  return (
    [-90, -30, 30, 90, 150, 210]
      .map((deg, index) => {
        const a = (deg * Math.PI) / 180;
        return `${index ? 'L' : 'M'}${round(cx + r * Math.cos(a))} ${round(cy + r * Math.sin(a))}`;
      })
      .join('') + 'Z'
  );
}

/** The header's brand hexagon as a tile: a raised face over a darker edge. */
function brandHex(cx, cy, r) {
  return `<path d="${hexPath(cx, cy + r * 0.16, r)}" fill="#6f2219"/>
<path d="${hexPath(cx, cy, r)}" fill="${palette.brand}"/>
<path d="${hexPath(cx, cy, r * 0.62)}" fill="none" stroke="#f5ebd9" stroke-opacity="0.55" stroke-width="${round(r * 0.1)}"/>`;
}

const brandSvg = (size, background) => {
  const r = size * (background ? 0.36 : 0.44);
  const cy = size / 2 - r * 0.08;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${
    background ? `<rect width="${size}" height="${size}" fill="${palette.page}"/>` : ''
  }${brandHex(size / 2, cy, r)}</svg>`;
};

/** The faint hex grid behind everything, faded towards the corners. */
function hexPattern(width, height) {
  const r = 30;
  const w = SQRT3 * r;
  const h = 3 * r;
  const cell = `${hexPath(w / 2, r, r)}${hexPath(0, r + 1.5 * r, r)}${hexPath(w, r + 1.5 * r, r)}`;
  return `<defs>
<pattern id="grid" width="${round(w)}" height="${h}" patternUnits="userSpaceOnUse"><path d="${cell}" fill="none" stroke="${palette.text}" stroke-opacity="0.07" stroke-width="1.5"/></pattern>
<radialGradient id="glow" cx="0.72" cy="0.45" r="0.7"><stop offset="0" stop-color="#4a3c3f"/><stop offset="1" stop-color="${palette.page}"/></radialGradient>
<radialGradient id="fade" cx="0.35" cy="0.5" r="0.75"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0.15"/></radialGradient>
<mask id="gridMask"><rect width="${width}" height="${height}" fill="url(#fade)"/></mask>
<filter id="shadow" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="14"/></filter>
</defs>
<rect width="${width}" height="${height}" fill="url(#glow)"/>
<rect width="${width}" height="${height}" fill="url(#grid)" mask="url(#gridMask)"/>`;
}

function page({ width, height, board, text }) {
  const slice = boardSlice(board);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFace('Tienne', 'tienne-bold.ttf')}
${fontFace('DM Mono', 'dm-mono-regular.ttf')}
${fontFace('DM Mono Medium', 'dm-mono-medium.ttf')}
html,body{margin:0;background:${palette.page};}
.card{position:relative;width:${width}px;height:${height}px;overflow:hidden;color:${palette.text};}
.card>svg{position:absolute;inset:0;}
.text{position:absolute;${text.position}}
.brand{display:flex;align-items:center;gap:${text.gap}px;}
.brand svg{flex:none;}
h1{font:700 ${text.title}px/1 'Tienne';margin:0;letter-spacing:-0.01em;}
h2{font:700 ${text.headline}px/1.15 'Tienne';color:${palette.accent};margin:${text.headline * 0.9}px 0 0;}
p{font:400 ${text.body}px/1.45 'DM Mono';color:${palette.muted};margin:${text.body * 0.8}px 0 0;max-width:${text.bodyWidth}px;}
.url{display:inline-block;margin-top:${text.body * 1.4}px;font:400 ${text.url}px/1 'DM Mono Medium';color:${palette.text};
  padding:${text.url * 0.55}px ${text.url * 0.8}px;border-radius:12px;background:${palette.brand};box-shadow:0 4px 0 #6f2219;}
</style></head><body><div class="card">
<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
${hexPattern(width, height)}
<defs>${slice.defs}</defs>
<path d="${slice.outline}" fill="#000" fill-opacity="0.55" filter="url(#shadow)" transform="translate(0 10)"/>
${slice.body}
</svg>
<div class="text">
<div class="brand"><svg viewBox="0 0 100 100" width="${text.mark}" height="${text.mark}">${brandHex(50, 46, 44)}</svg><h1>Hexfield</h1></div>
<h2>${text.headlineHtml}</h2>
<p>${text.bodyHtml}</p>
<span class="url">playhexfield.com</span>
</div>
</div></body></html>`;
}

const tagline = 'Play the island trading game with friends — in your browser, peer to peer.';
const cards = {
  'og.png': {
    width: 1200,
    height: 630,
    board: {
      size: 92,
      origin: { x: 960, y: 330 },
      bounds: { x: 0, y: 0, width: 1200, height: 630 },
      keep: (c) => c.x > 700 || (c.x > 600 && c.y < 150),
      pieceScale: 1.45,
    },
    text: {
      position: 'left:72px;top:92px;',
      gap: 20,
      mark: 84,
      title: 104,
      headline: 44,
      headlineHtml: 'A table ready<br>when you are',
      body: 25,
      bodyHtml: 'Play the island trading game<br>with friends — in your browser,<br>peer to peer.',
      bodyWidth: 560,
      url: 24,
    },
  },
  'og-square.png': {
    width: 1200,
    height: 1200,
    // Fewer colours keep the larger card under the 300 KB that chat apps fetch comfortably.
    colors: 128,
    board: {
      size: 100,
      origin: { x: 690, y: 950 },
      bounds: { x: 0, y: 500, width: 1200, height: 700 },
      keep: (c) => c.y > 560,
      pieceScale: 1.45,
    },
    text: {
      position: 'left:96px;top:80px;',
      gap: 26,
      mark: 104,
      title: 128,
      headline: 54,
      headlineHtml: 'A table ready when you are',
      body: 30,
      bodyHtml: tagline,
      bodyWidth: 960,
      url: 28,
    },
  },
};

const pngquant = (() => {
  try {
    execFileSync('pngquant', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    console.warn('pngquant not found: writing unquantised PNGs.');
    return false;
  }
})();

function compress(file, colors = 256) {
  if (!pngquant) return;
  const path = new URL(file, out).pathname;
  execFileSync('pngquant', [
    '--force',
    '--strip',
    '--speed',
    '1',
    '--quality',
    '70-98',
    String(colors),
    '--output',
    `${path}.tmp`,
    path,
  ]);
  renameSync(`${path}.tmp`, path);
}

/** Screenshots one HTML page of `width`×`height` into public/ and compresses it. */
async function render(
  browser,
  file,
  html,
  width,
  height,
  { transparent = false, colors = 256 } = {},
) {
  const tab = await browser.newPage({ viewport: { width, height } });
  await tab.setContent(html, { waitUntil: 'load' });
  await tab.evaluate(() => document.fonts.ready);
  await tab.screenshot({
    path: new URL(file, out).pathname,
    omitBackground: transparent,
    clip: { x: 0, y: 0, width, height },
  });
  await tab.close();
  compress(file, colors);
}

const icon = (size, background) =>
  `<!doctype html><html><body style="margin:0;background:transparent">${brandSvg(size, background)}</body></html>`;

const browser = await chromium.launch();
try {
  await Promise.all([
    ...Object.entries(cards).map(([file, card]) =>
      render(browser, file, page(card), card.width, card.height, { colors: card.colors }),
    ),
    render(browser, 'favicon-32.png', icon(32, false), 32, 32, { transparent: true, colors: 64 }),
    render(browser, 'apple-touch-icon.png', icon(180, true), 180, 180, { colors: 64 }),
  ]);
} finally {
  await browser.close();
}
writeFileSync(new URL('favicon.svg', out), `${brandSvg(64, false)}\n`);
for (const file of [
  'og.png',
  'og-square.png',
  'favicon.svg',
  'favicon-32.png',
  'apple-touch-icon.png',
])
  console.log(`${file}: ${Math.round(statSync(new URL(file, out)).size / 1024)} KB`);
