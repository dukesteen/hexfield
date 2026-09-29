// Run from the repo root: node tools/generate-barbarian-track.mjs
// The barbarian track as separate parts, so the board can lay the track along any fixture
// direction and keep every marker upright:
//   ck-barbarian-track-tile-<0|60|120>.svg  the joined two-hex sea tile for each grid axis, lit
//                                           from the top left like every tile
//   ck-barbarian-step-<n>.svg               the numbered step tokens
//   ck-barbarian-start.svg                  the dark start space with its small longship
//   ck-barbarian-landing.svg                the island with its city where the barbarians land
// The tile and token drawing follows the Cities & Knights art generator (the same palette,
// offsets, sea scene and hand-drawn wobble). The island is cut from the original track art,
// fixture-barbarian-track.svg, so it stays exactly as drawn.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { optimize } from 'svgo';

const OUT = 'packages/renderer/src/assets/redesign';
const SOURCE = join(OUT, 'fixture-barbarian-track.svg');
/** Numbered tokens to ship: the engine uses six (seven steps), a few spare for other tracks. */
const STEP_TOKENS = 9;

// ---- The helpers of the art generator, trimmed to what the track draws ------------------------
const R = 80;
const W3 = R * Math.sqrt(3);
const D2R = Math.PI / 180;
const f = (n) => Math.round(n * 10) / 10;
const pp = (a) => a.map((p) => `${f(p[0])},${f(p[1])}`).join(' ');
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
const OL = (c, w = 1) => `stroke="${sh(c, -0.45)}" stroke-width="${w}" stroke-linejoin="round"`;
const poly = (a, fill, ex = '') => `<polygon points="${pp(a)}" fill="${fill}" ${ex}/>`;
const circ = (x, y, r, fill, ex = '') =>
  `<circle cx="${f(x)}" cy="${f(y)}" r="${f(Math.max(r, 0.1))}" fill="${fill}" ${ex}/>`;
const ell = (x, y, rx, ry, fill, ex = '') =>
  `<ellipse cx="${f(x)}" cy="${f(y)}" rx="${f(rx)}" ry="${f(ry)}" fill="${fill}" ${ex}/>`;
const path = (d, fill, ex = '') => `<path d="${d}" fill="${fill}" ${ex}/>`;
const line = (x1, y1, x2, y2, c, w, ex = '') =>
  `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${c}" stroke-width="${w}" stroke-linecap="round" ${ex}/>`;
const wave = (x, y, s = 1) =>
  `<path d="M${f(x - 6 * s)},${f(y)} q${f(3 * s)},${f(-3 * s)} ${f(6 * s)},0 t${f(6 * s)},0" fill="none" stroke="#e9f7f8" stroke-width="${f(1.6 * s)}" stroke-linecap="round" opacity=".7"/>`;

// Wobble: every outline is resampled and nudged by a smooth noise, the same as the other art.
const WOBBLE = 0.55;
const noise = (x, y) =>
  Math.sin(x * 0.37 + y * 0.21) * 0.5 +
  Math.sin(x * 0.13 - y * 0.41 + 1.7) * 0.35 +
  Math.sin(x * 0.71 + y * 0.53 + 3.1) * 0.15;
const jitter = (x, y, k = 1) => [
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
const wobble = (points, closed, k) => densify(points, closed).map((p) => jitter(p[0], p[1], k));
const parsePoints = (s) =>
  s
    .trim()
    .split(/\s+/)
    .map((q) => q.split(',').map(Number));
function ellipsePoints(cx, cy, rx, ry) {
  const n = Math.max(12, Math.round((rx + ry) * 1.4));
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * 6.2832;
    return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
  });
}
/** Bake the wobble into every outline, as the art generator does before it writes a file. */
/** How strongly a round shape of radius `a` wobbles. */
const roundWobble = (a) => Math.min(1, Math.max(0.35, a / 6));
function bake(s) {
  return s
    .replace(
      /<polygon points="([^"]+)"/g,
      (_m, p) => `<polygon points="${pp(wobble(parsePoints(p), true, 1))}"`,
    )
    .replace(
      /<circle cx="([-\d.]+)" cy="([-\d.]+)" r="([\d.]+)"/g,
      (_m, x, y, r) =>
        `<polygon points="${pp(wobble(ellipsePoints(+x, +y, +r, +r), true, roundWobble(+r)))}"`,
    )
    .replace(
      /<ellipse cx="([-\d.]+)" cy="([-\d.]+)" rx="([\d.]+)" ry="([\d.]+)"/g,
      (_m, x, y, rx, ry) =>
        `<polygon points="${pp(wobble(ellipsePoints(+x, +y, +rx, +ry), true, roundWobble(Math.min(+rx, +ry))))}"`,
    )
    .replace(
      /<line x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"/g,
      (_m, a, b, c, d) =>
        `<polyline fill="none" points="${pp(
          wobble(
            [
              [+a, +b],
              [+c, +d],
            ],
            false,
            0.8,
          ),
        )}"`,
    )
    .replace(/<path d="([^"]+)"/g, (m, d) => {
      if (/[a-zA-BD-KN-PR-Z]/.test(d.replace(/[MLCQZ]/g, ''))) return m;
      const out = d.replace(/-?[\d.]+\s*,\s*-?[\d.]+|-?[\d.]+\s+-?[\d.]+/g, (pair) => {
        const [x, y] = pair.split(/[\s,]+/).map(Number);
        const q = jitter(x, y, 0.8);
        return `${f(q[0])},${f(q[1])}`;
      });
      return `<path d="${out}"`;
    });
}
const rng = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const hexCorners = (c, r) =>
  [0, 1, 2, 3, 4, 5].map((i) => [
    c[0] + r * Math.cos((-90 + i * 60) * D2R),
    c[1] + r * Math.sin((-90 + i * 60) * D2R),
  ]);
const hexInside = (a, b, r) => Math.abs(a) <= r * 0.866 && Math.abs(b) <= r - Math.abs(a) * 0.577;
/** The light comes from the top left. */
const LIGHT_ANGLE = -135 * D2R;
const SEA = '#6db6cc';

const winding = (P) => {
  let area = 0;
  for (let i = 0; i < P.length; i++) {
    const a = P[i];
    const b = P[(i + 1) % P.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area > 0 ? 1 : -1;
};
/** The polygon moved `d` inwards along every edge. */
function offsetPolygon(P, d) {
  const n = P.length;
  const sign = winding(P);
  const lines = P.map((a, i) => {
    const b = P[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy);
    return [a[0] - (dy / l) * sign * d, a[1] + (dx / l) * sign * d, dx, dy];
  });
  return P.map((_, i) => {
    const l1 = lines[(i - 1 + n) % n];
    const l2 = lines[i];
    const cross = l1[2] * l2[3] - l1[3] * l2[2];
    if (Math.abs(cross) < 1e-9) return [l2[0], l2[1]];
    const t = ((l2[0] - l1[0]) * l2[3] - (l2[1] - l1[1]) * l2[2]) / cross;
    return [l1[0] + l1[2] * t, l1[1] + l1[3] * t];
  });
}
function scatter(random, n, minD, margin, region) {
  const out = [];
  for (let tries = 0; out.length < n && tries < 8000; tries++) {
    const a = (random() * 2 - 1) * region.W;
    const b = (random() * 2 - 1) * region.H;
    if (!region.inside(a, b, margin) || !region.inside(a, b, Math.max(2.5, margin * 0.5))) continue;
    if (out.some((p) => Math.hypot(p[0] - a, p[1] - b) < minD)) continue;
    out.push([a, b]);
  }
  return out;
}

// ---- The joined tile ----------------------------------------------------------------------------

/**
 * Two sea hexes joined across an edge, the second one `angle` degrees round from the first
 * (0 is east, 60 south-east, 120 south-west), centred on the midpoint of their centres.
 */
function trackTile(angle) {
  const k = angle / 60;
  const ux = Math.cos(angle * D2R);
  const uy = Math.sin(angle * D2R);
  const c1 = [(-W3 / 2) * ux, (-W3 / 2) * uy];
  const c2 = [(W3 / 2) * ux, (W3 / 2) * uy];
  const A = hexCorners(c1, R);
  const B = hexCorners(c2, R);
  const at = (hex, i) => hex[(i + k) % 6];
  const U = [
    at(A, 0),
    at(A, 1),
    at(B, 0),
    at(B, 1),
    at(B, 2),
    at(B, 3),
    at(A, 2),
    at(A, 3),
    at(A, 4),
    at(A, 5),
  ];
  const sign = winding(U);
  const gradient = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff8ec" stop-opacity=".16"/><stop offset=".55" stop-color="#fff8ec" stop-opacity="0"/><stop offset="1" stop-color="#2e2028" stop-opacity=".14"/></linearGradient></defs>`;
  const bevel = offsetPolygon(U, 1.2);
  const inner = offsetPolygon(U, 5.6);
  let s = poly(U, sh(SEA, -0.5));
  for (let i = 0; i < U.length; i++) {
    const j = (i + 1) % U.length;
    const dx = U[j][0] - U[i][0];
    const dy = U[j][1] - U[i][1];
    const lit = Math.cos(Math.atan2(-dx * sign, dy * sign) - LIGHT_ANGLE);
    const color = sh(SEA, lit > 0 ? 0.3 * lit : 0.34 * lit);
    s += poly(
      [bevel[i], bevel[j], inner[j], inner[i]],
      color,
      `stroke="${color}" stroke-width=".5" stroke-linejoin="round"`,
    );
  }
  s += poly(inner, SEA) + `<clipPath id="c"><polygon points="${pp(inner)}"/></clipPath>`;
  // The sea scene of the art generator: soft patches and a scatter of small waves.
  const random = rng(4242 + angle);
  const hr = R * 0.93;
  const region = {
    W: W3 / 2 + hr,
    H: W3 / 2 + hr,
    inside: (a, b, m) =>
      hexInside(a - c1[0], b - c1[1], hr - m * 1.15) ||
      hexInside(a - c2[0], b - c2[1], hr - m * 1.15),
  };
  s += '<g clip-path="url(#c)">';
  for (let i = 0; i < 6; i++) {
    // Patches fall along the tile, so each hex gets its share.
    const t = random() * 2 - 1;
    const a = t * (W3 / 2) * ux + (random() * 2 - 1) * hr * 0.6;
    const b = t * (W3 / 2) * uy + (random() * 2 - 1) * hr * 0.6;
    const w = 14 + random() * 22;
    s += ell(a, b, w, w * (0.6 + random() * 0.4), sh(SEA, i % 2 ? 0.06 : -0.05));
  }
  for (const [a, b] of scatter(random, 12, 12, 5, region)) s += wave(a, b, 0.8);
  s += '</g>';
  s +=
    poly(inner, 'url(#g)') +
    poly(
      offsetPolygon(U, 9.2),
      'none',
      `stroke="${sh(SEA, 0.4)}" stroke-width="1.1" stroke-dasharray="3 2.4" opacity=".9"`,
    ) +
    poly(inner, 'none', `stroke="${sh(SEA, -0.3)}" stroke-width="1.4" opacity=".5"`);
  const halfW = Math.ceil(Math.max(...U.map((p) => Math.abs(p[0]))) + 3);
  const halfH = Math.ceil(Math.max(...U.map((p) => Math.abs(p[1]))) + 3);
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-halfW} ${-halfH} ${halfW * 2} ${halfH * 2}">${gradient}${bake(s)}</svg>`,
    width: halfW * 2,
    height: halfH * 2,
  };
}

// ---- Tokens -------------------------------------------------------------------------------------

/** The small longship on the start space (the art generator's second longship). */
function longship(x, y, s) {
  const X = (v) => f(x + v * s);
  const Y = (v) => f(y + v * s);
  const H = '#4a3a3a';
  const Hd = sh(H, -0.3);
  const Hl = sh(H, 0.25);
  let b = ell(
    x,
    y + 1.5 * s,
    20 * s,
    3.6 * s,
    'none',
    'stroke="#e9f7f8" stroke-width=".9" opacity=".6"',
  );
  for (let i = 0; i < 4; i++) {
    const ox = x + (-9 + i * 6) * s;
    b += line(ox, y - 3 * s, ox - 4 * s, y + 3 * s, '#8a6445', 1 * s);
  }
  b += path(
    `M${X(-15)},${Y(-7)} C${X(-19)},${Y(-9)} ${X(-21)},${Y(-15)} ${X(-18)},${Y(-18)} C${X(-16)},${Y(-20)} ${X(-13)},${Y(-18)} ${X(-15)},${Y(-15)}`,
    'none',
    `stroke="${H}" stroke-width="${f(2.4 * s)}" stroke-linecap="round"`,
  );
  b += path(
    `M${X(14)},${Y(-6)} C${X(19)},${Y(-10)} ${X(18)},${Y(-17)} ${X(21)},${Y(-21)}`,
    'none',
    `stroke="${H}" stroke-width="${f(2.6 * s)}" stroke-linecap="round"`,
  );
  b +=
    path(
      `M${X(19.5)},${Y(-23)} L${X(25)},${Y(-21.5)} L${X(24)},${Y(-19.6)} L${X(20.5)},${Y(-19.4)} Z`,
      H,
      OL(H, 0.6),
    ) +
    poly(
      [
        [x + 19.8 * s, y - 23 * s],
        [x + 19 * s, y - 26 * s],
        [x + 21.6 * s, y - 23.6 * s],
      ],
      H,
    ) +
    circ(x + 21.6 * s, y - 21.8 * s, 0.7 * s, '#e8b640');
  const hull = `M${X(-16)},${Y(-8)} L${X(15)},${Y(-8)} C${X(13)},${Y(-1)} ${X(8)},${Y(2.5)} ${X(0)},${Y(2.5)} C${X(-8)},${Y(2.5)} ${X(-13)},${Y(-1)} ${X(-16)},${Y(-8)} Z`;
  b +=
    path(hull, H, OL(H, 1)) +
    path(
      `M${X(-14.2)},${Y(-3.6)} L${X(13.4)},${Y(-3.6)} C${X(10)},${Y(1)} ${X(6)},${Y(2.5)} ${X(0)},${Y(2.5)} C${X(-6)},${Y(2.5)} ${X(-11)},${Y(1)} ${X(-14.2)},${Y(-3.6)} Z`,
      Hd,
    ) +
    line(x - 15 * s, y - 7.2 * s, x + 14.4 * s, y - 7.2 * s, Hl, 0.8 * s);
  for (let i = 0; i < 6; i++) {
    const cx = x + (-12.5 + i * 5) * s;
    const cy = y - 5.6 * s;
    b +=
      circ(cx, cy, 2.4 * s, ['#c2493a', '#e8b640', '#efe4cc'][i % 3], OL('#3d2f35', 0.4)) +
      circ(cx, cy, 0.8 * s, '#3d2f35');
  }
  b += line(x, y - 8 * s, x, y - 33 * s, '#3d2f35', 1.3 * s);
  const sail = `M${X(-11)},${Y(-30)} L${X(11)},${Y(-30)} L${X(12)},${Y(-13)} Q${X(0)},${Y(-10.5)} ${X(-12)},${Y(-13)} Z`;
  b += path(sail, '#efe4cc');
  for (const [a, c, a2, c2] of [
    [-11, -6.6, -12, -7.2],
    [-2.2, 2.2, -2.4, 2.4],
    [6.6, 11, 7.2, 12],
  ])
    b += path(
      `M${X(a)},${Y(-30)} L${X(c)},${Y(-30)} L${X(c2)},${Y(-12.4)} L${X(a2)},${Y(-12.2)} Z`,
      '#c2493a',
    );
  b +=
    path(sail, 'none', OL('#d8cbb0', 0.8)) +
    line(x - 12.4 * s, y - 30 * s, x + 12.4 * s, y - 30 * s, '#6e4a33', 1.1 * s) +
    path(`M${X(0)},${Y(-33)} L${X(6)},${Y(-31.6)} L${X(0)},${Y(-30.2)} Z`, '#c2493a');
  return b;
}

/** Half the side of a token's square art box; the disc has radius 11 and a shadow below right. */
const TOKEN_HALF = 14;

/** A step space: cream with its number, or dark with the longship for the start. */
function token(index) {
  // Each token is drawn at its own place so the wobble differs from token to token.
  const x = 40 + index * 40;
  const y = 40;
  const start = index === 0;
  let s =
    circ(x + 1.2, y + 1.8, 11, 'rgba(46,70,82,.3)') +
    circ(x, y, 11, start ? '#3d4a52' : '#fbf4e4', OL('#3d6f82', 1)) +
    circ(
      x,
      y,
      8.4,
      'none',
      `stroke="${start ? '#8fb3c0' : '#c9b894'}" stroke-width=".9" stroke-dasharray="2 1.8"`,
    );
  s += start ? longship(x, y + 5, 0.32) : '';
  const label = start
    ? ''
    : `<text x="${f(x)}" y="${f(y + 4.2)}" text-anchor="middle" font-family="'Palatino Linotype','Book Antiqua',Palatino,serif" font-weight="700" font-size="12" fill="#3d6f82">${index}</text>`;
  const box = `${x - TOKEN_HALF} ${y - TOKEN_HALF} ${TOKEN_HALF * 2} ${TOKEN_HALF * 2}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}">${bake(s)}${label}</svg>`;
}

// ---- The island, cut from the original track art ------------------------------------------------

/** The landing island's box in the original art: its centre (240, 84) sits at (30, 30). */
const ISLAND_BOX = { x: 210, y: 54, width: 60, height: 54 };

function island() {
  const source = readFileSync(SOURCE, 'utf8').replace(/<metadata>.*?<\/metadata>/s, '');
  // The island follows the dotted route and ends before the start space's shadow.
  const route = source.match(/<polyline[^>]*stroke-dasharray="1 5"[^>]*>(<\/polyline>)?/);
  if (!route) throw new Error('The track art has no route line.');
  const from = source.indexOf(route[0]) + route[0].length;
  const disc = source.lastIndexOf('<polygon', source.indexOf('fill="#3d4a52"'));
  const shadow = source.lastIndexOf('<polygon', disc - 1);
  const body = source.slice(from, shadow);
  if (!body.includes('#e9d6a0') || !source.slice(shadow, disc).includes('rgba(46,70,82,.3)'))
    throw new Error('The island could not be cut from the track art.');
  const { x, y, width, height } = ISLAND_BOX;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${width} ${height}">${body}</svg>`;
}

// ---- Write --------------------------------------------------------------------------------------

function write(name, svg) {
  const { data } = optimize(svg, { multipass: true, plugins: ['preset-default'] });
  writeFileSync(join(OUT, name), `${data}\n`);
  console.log(`${name}: ${data.length} bytes`);
}

for (const angle of [0, 60, 120]) {
  const tile = trackTile(angle);
  write(`ck-barbarian-track-tile-${angle}.svg`, tile.svg);
  console.log(`  art size ${tile.width} x ${tile.height}`);
}
write('ck-barbarian-start.svg', token(0));
for (let n = 1; n <= STEP_TOKENS; n++) write(`ck-barbarian-step-${n}.svg`, token(n));
write('ck-barbarian-landing.svg', island());
