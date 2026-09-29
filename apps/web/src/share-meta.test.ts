import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const web = new URL('../', import.meta.url);
const html = readFileSync(new URL('index.html', web), 'utf8');
const origin = 'https://playhexfield.com';

/** The `content` of the <meta> whose name or property is `key`. */
function meta(key: string): string | undefined {
  const tag = html.match(new RegExp(`<meta\\s+(?:name|property)="${key}"\\s+content="([^"]*)"`));
  return tag?.[1];
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: URL): { width: number; height: number } {
  const bytes = readFileSync(file);
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const images = {
  'og.png': [1200, 630],
  'og-square.png': [1200, 1200],
  'favicon-32.png': [32, 32],
  'apple-touch-icon.png': [180, 180],
} as const;
const files = [...Object.keys(images), 'favicon.svg'];

describe('link previews', () => {
  test('index.html describes the site with absolute production URLs', () => {
    expect(meta('description')?.length).toBeGreaterThan(50);
    expect(meta('theme-color')).toBe('#29252a');
    expect(meta('og:type')).toBe('website');
    expect(meta('og:site_name')).toBe('Hexfield');
    expect(meta('og:title')).toBe('Hexfield');
    expect(meta('og:description')).toBeTruthy();
    expect(meta('og:url')).toBe(`${origin}/`);
    expect(meta('og:image')).toBe(`${origin}/og.png`);
    expect(meta('og:image:width')).toBe('1200');
    expect(meta('og:image:height')).toBe('630');
    expect(meta('og:image:alt')).toBeTruthy();
    expect(meta('twitter:card')).toBe('summary_large_image');
    expect(meta('twitter:title')).toBe('Hexfield');
    expect(meta('twitter:description')).toBeTruthy();
    expect(meta('twitter:image')).toBe(`${origin}/og.png`);
  });

  test('index.html links the favicons', () => {
    expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
    expect(html).toContain(
      '<link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32" />',
    );
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
  });

  test('the images are in public/ at their declared sizes and small enough to share', () => {
    for (const [file, [width, height]] of Object.entries(images)) {
      const url = new URL(`public/${file}`, web);
      expect({ file, ...pngSize(url) }).toEqual({ file, width, height });
      expect(readFileSync(url).byteLength).toBeLessThan(300 * 1024);
    }
    expect(readFileSync(new URL('public/favicon.svg', web), 'utf8')).toMatch(/^<svg /);
  });

  // Vite copies public/ into the build as is; this checks the last `pnpm build` output.
  test.skipIf(!existsSync(new URL('dist/index.html', web)))(
    'the build serves them from its root',
    () => {
      expect(files.filter((file) => !existsSync(new URL(`dist/${file}`, web)))).toEqual([]);
      const built = readFileSync(new URL('dist/index.html', web), 'utf8');
      expect(built).toContain(`content="${origin}/og.png"`);
    },
  );
});
