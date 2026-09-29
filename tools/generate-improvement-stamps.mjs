// Run from the repo root: node tools/generate-improvement-stamps.mjs
// The "level complete" stamps for the city improvement banners (ck-improve-<track>.svg): one per
// track and level, drawn in the Cities & Knights style (track palette, dark ink outlines, the
// hand-drawn wobble baked into the geometry) and sized to cover one printed level cell exactly.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { optimize } from 'svgo';

const OUT = 'packages/renderer/src/assets/redesign';

/** The track colours of the printed banners. */
const TRACKS = { trade: '#e0b340', politics: '#4f7fbf', science: '#5f9a4c' };
const CREAM = '#fbf4e4';
const GOLD = '#e8b640';
const SHADOW = '#3b2a2e';

// A printed cell is 40 by 54 units with a corner of 8; the stamp adds a margin of 2 on every side
// so it also covers the printed outline and its wobble.
const MARGIN = 2;
const CELL_W = 40;
const CELL_H = 54;

// ---- The helpers of the art generator, trimmed to what a stamp draws ------------------------
const f = (n) => Math.round(n * 10) / 10;
const h2r = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const r2h = (a) =>
  '#' +
  a
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
const DARK = [52, 36, 44];
const LIGHT = [255, 249, 238];
/** Mix a colour towards the ink (negative) or the paper (positive). */
const sh = (h, a) => {
  const t = a < 0 ? DARK : LIGHT;
  const k = Math.abs(a);
  return r2h(h2r(h).map((v, i) => v + (t[i] - v) * k));
};
/** An ink outline in a darker shade of the fill. */
const OL = (c, w = 1) => `stroke="${sh(c, -0.45)}" stroke-width="${w}" stroke-linejoin="round"`;
const pts = (a) => a.map((p) => `${f(p[0])},${f(p[1])}`).join(' ');
const poly = (a, fill, ex = '') => `<polygon points="${pts(a)}" fill="${fill}" ${ex}/>`;
const polyline = (a, ex) => `<polyline points="${pts(a)}" fill="none" ${ex}/>`;

// Wobble: every outline is resampled and nudged by a smooth noise, the same as the other art.
const WOBBLE = 0.55;
const noise = (x, y) =>
  Math.sin(x * 0.37 + y * 0.21) * 0.5 +
  Math.sin(x * 0.13 - y * 0.41 + 1.7) * 0.35 +
  Math.sin(x * 0.71 + y * 0.53 + 3.1) * 0.15;
const jitter = ([x, y], k) => [
  x + WOBBLE * k * noise(x, y),
  y + WOBBLE * k * noise(y + 31.3, x - 17.7),
];
function densify(points, closed, step = 4) {
  const out = [];
  const last = closed ? points.length : points.length - 1;
  for (let i = 0; i < last; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let j = 0; j < n; j++)
      out.push([a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n]);
  }
  if (!closed) out.push(points[points.length - 1]);
  return out;
}
const wobble = (points, closed, k) => densify(points, closed).map((p) => jitter(p, k));
const strength = (size) => Math.min(1, Math.max(0.35, size / 6));

function ellipsePoints(cx, cy, rx, ry) {
  const n = Math.max(12, Math.round((rx + ry) * 1.4));
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
  });
}
function roundRectPoints(x, y, w, h, r) {
  const corners = [
    [x + w - r, y + r, -90],
    [x + w - r, y + h - r, 0],
    [x + r, y + h - r, 90],
    [x + r, y + r, 180],
  ];
  return corners.flatMap(([cx, cy, a]) =>
    Array.from({ length: 5 }, (_, i) => {
      const t = ((a + i * 22.5) * Math.PI) / 180;
      return [cx + r * Math.cos(t), cy + r * Math.sin(t)];
    }),
  );
}
const circle = (x, y, r, fill, ex = '') =>
  poly(wobble(ellipsePoints(x, y, r, r), true, strength(r)), fill, ex);
const roundRect = (x, y, w, h, r, fill, ex = '') =>
  poly(wobble(roundRectPoints(x, y, w, h, r), true, strength(Math.min(w, h))), fill, ex);
const star = (x, y, n, outer, inner, a0 = -Math.PI / 2) =>
  Array.from({ length: n * 2 }, (_, i) => {
    const r = i % 2 ? inner : outer;
    const a = a0 + (i * Math.PI) / n;
    return [x + r * Math.cos(a), y + r * Math.sin(a)];
  });

// ---- The stamp ----------------------------------------------------------------------------------

/** Where the printed banner puts the cost pips: three to a row, as on ck-improve-<track>.svg. */
const pipAt = (index) => [12 + (index % 3) * 8, 17 + Math.floor(index / 3) * 9];

/** The seal at the foot of a stamp: a check, the ability rosette, or the metropolis medal. */
function seal(level, tc) {
  const x = CELL_W / 2;
  const y = 41;
  const ink = sh(tc, -0.5);
  if (level < 3)
    return (
      circle(x, y, 7.2, CREAM, OL(tc, 1.1)) +
      polyline(
        wobble(
          [
            [x - 3.6, y + 0.2],
            [x - 0.9, y + 3],
            [x + 3.9, y - 3],
          ],
          false,
          0.5,
        ),
        `stroke="${ink}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"`,
      )
    );
  // Level 3 unlocks the track's ability; 4 and 5 can hold its metropolis.
  const medal = level === 3 ? '#f7d77a' : GOLD;
  let s = '';
  if (level >= 4) {
    const ribbon = sh(tc, -0.2);
    s +=
      poly(
        [
          [x - 5.5, y + 3],
          [x - 8, y + 11.5],
          [x - 5, y + 9.8],
          [x - 3.2, y + 12.4],
          [x - 1.2, y + 4.5],
        ],
        ribbon,
        OL(ribbon, 0.7),
      ) +
      poly(
        [
          [x + 5.5, y + 3],
          [x + 8, y + 11.5],
          [x + 5, y + 9.8],
          [x + 3.2, y + 12.4],
          [x + 1.2, y + 4.5],
        ],
        ribbon,
        OL(ribbon, 0.7),
      );
  }
  s +=
    poly(star(x, y, 12, 8.6, 7, 0), medal, OL(GOLD, 0.9)) +
    circle(x, y, 5.4, 'none', `stroke="${sh(GOLD, -0.2)}" stroke-width=".7"`) +
    poly(star(x, y + 0.3, 5, 4.3, 1.8), level === 3 ? sh(tc, 0.05) : '#fff3c4', OL(GOLD, 0.5));
  if (level === 5)
    s += circle(
      x,
      y,
      10.6,
      'none',
      `stroke="${GOLD}" stroke-width=".8" stroke-dasharray="1.6 1.4"`,
    );
  return s;
}

/** The complete stamp for a level of a track, in cell units with the margin around it. */
function stamp(track, level) {
  const base = TRACKS[track];
  // The trade yellow is deepened (the UI's trade colour) so the cream pips on it stay clear.
  const tc = track === 'trade' ? '#d9a531' : base;
  let s =
    roundRect(0.8, 1.6, CELL_W, CELL_H, 8, SHADOW, 'opacity=".22"') +
    roundRect(0, 0, CELL_W, CELL_H, 8, tc, OL(tc, 1.6)) +
    roundRect(3, 3, CELL_W - 6, CELL_H - 6, 6, sh(tc, 0.12)) +
    roundRect(
      3,
      3,
      CELL_W - 6,
      CELL_H - 6,
      6,
      'none',
      `stroke="${sh(tc, 0.5)}" stroke-width=".8" stroke-dasharray="2 1.8"`,
    ) +
    polyline(
      wobble(
        [
          [7, 9],
          [9, 6.5],
          [14, 5.8],
        ],
        false,
        0.4,
      ),
      `stroke="${sh(tc, 0.55)}" stroke-width="1.4" stroke-linecap="round"`,
    );
  for (let pip = 0; pip < level; pip++) {
    const [x, y] = pipAt(pip);
    s += circle(x, y, 3.1, CREAM, OL(tc, 0.8));
  }
  s += seal(level, tc);
  const viewBox = `${-MARGIN} ${-MARGIN} ${CELL_W + MARGIN * 2} ${CELL_H + MARGIN * 2}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${s}</svg>`;
}

for (const track of Object.keys(TRACKS))
  for (let level = 1; level <= 5; level++) {
    const name = `ck-improve-done-${track}-${level}.svg`;
    const { data } = optimize(stamp(track, level), {
      multipass: true,
      plugins: ['preset-default'],
    });
    writeFileSync(join(OUT, name), `${data}\n`);
    console.log(`${name}: ${data.length} bytes`);
  }
