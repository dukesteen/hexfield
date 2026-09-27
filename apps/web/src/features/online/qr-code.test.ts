import { expect, test } from 'vitest';
import jsQR from 'jsqr';
import { invitationQr } from './qr-code';

function renderPixels(qr: ReturnType<typeof invitationQr>): {
  pixels: Uint8ClampedArray;
  size: number;
} {
  const size = qr.size * 3;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  for (const match of qr.path.matchAll(/M(\d+),(\d+)h1v1h-1z/g)) {
    const x = Number(match[1]) * 3;
    const y = Number(match[2]) * 3;
    for (let row = y; row < y + 3; row += 1) {
      for (let column = x; column < x + 3; column += 1) {
        const offset = (row * size + column) * 4;
        pixels[offset] = 0;
        pixels[offset + 1] = 0;
        pixels[offset + 2] = 0;
      }
    }
  }
  return { pixels, size };
}

test.each([935, 2048])(
  'the rendered %i-character manual QR decodes with the camera fallback',
  (length) => {
    const alphabet = 'abcdefghijklmNOPQRSTUVWXYZ0123456789-_';
    const text =
      'HX1.' +
      Array.from(
        { length: length - 4 },
        (_, index) => alphabet[(index * 17) % alphabet.length],
      ).join('');
    const qr = invitationQr(text);
    const { pixels, size } = renderPixels(qr);
    expect(jsQR(pixels, size, size)?.data).toBe(text);
    expect(qr.version).toBeLessThanOrEqual(length === 935 ? 25 : 40);
  },
);

test('refuses an empty or oversized invitation before QR rendering', () => {
  expect(() => invitationQr('')).toThrow('too large');
  expect(() => invitationQr('a'.repeat(4097))).toThrow('too large');
});
