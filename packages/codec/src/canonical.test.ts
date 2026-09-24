import { describe, expect, test } from 'vitest';
import {
  canonicalDecode,
  canonicalEncode,
  fromBase64Url,
  hashValue,
  sha256,
  toBase64Url,
  toHex,
} from './index.js';

function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function mustThrow(action: () => unknown): void {
  expect(action).toThrow(/./);
}

describe('canonical codec', () => {
  test('sorts keys by UTF-16 code units and ignores insertion order', () => {
    const first = { z: 1, a: { y: 2, x: 3 }, '😀': 4, ä: 5 };
    const second = { ä: 5, '😀': 4, a: { x: 3, y: 2 }, z: 1 };
    expect(canonicalEncode(first)).toEqual(canonicalEncode(second));
    expect(utf8(canonicalEncode(first))).toBe('{"a":{"x":3,"y":2},"z":1,"ä":5,"😀":4}');
  });

  test('round-trips JSON-like values and nested byte arrays', () => {
    const value = {
      empty: new Uint8Array(),
      nested: [null, true, -3, 'snowman ☃', new Uint8Array([0, 1, 127, 128, 255])],
      object: { $b: 'ordinary because this has another key', value: 7 },
    };
    expect(canonicalDecode(canonicalEncode(value))).toEqual(value);
    const specialKeyValue: Record<string, unknown> = {};
    Object.defineProperty(specialKeyValue, '__proto__', {
      value: 1,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(canonicalDecode(canonicalEncode(specialKeyValue))).toEqual(specialKeyValue);
    expect(utf8(canonicalEncode(new Uint8Array([0, 1, 2, 253, 254, 255])))).toBe(
      '{"$b":"AAEC_f7_"}',
    );
  });

  test('rejects reserved one-key byte-tag objects on encode', () => {
    mustThrow(() => canonicalEncode({ $b: 'AA' }));
    mustThrow(() => canonicalEncode({ $b: 1 }));
    expect(canonicalDecode(canonicalEncode({ $b: 'ordinary', extra: 1 }))).toEqual({
      $b: 'ordinary',
      extra: 1,
    });
  });

  test('rejects floats, undefined, holes, unsupported objects and cycles', () => {
    expect(() => canonicalEncode(1.25)).toThrow(/./);
    mustThrow(() => canonicalEncode(Number.NaN));
    mustThrow(() => canonicalEncode(Number.POSITIVE_INFINITY));
    mustThrow(() => canonicalEncode({ missing: undefined }));
    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = 1;
    mustThrow(() => canonicalEncode(sparse));
    mustThrow(() => canonicalEncode(new Date(0)));
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    mustThrow(() => canonicalEncode(cyclic));
  });

  test('encodes repeated object references like duplicated values', () => {
    const shared = { count: 0 };
    expect(canonicalEncode([shared, shared])).toEqual(
      canonicalEncode([{ count: 0 }, { count: 0 }]),
    );
  });

  test('decodes only canonical JSON and canonical byte tags', () => {
    mustThrow(() => canonicalDecode(new TextEncoder().encode('{ "a":1}')));
    mustThrow(() => canonicalDecode(new TextEncoder().encode('{"b":1,"a":2}')));
    mustThrow(() => canonicalDecode(new TextEncoder().encode('{"a":1,"a":1}')));
    mustThrow(() => canonicalDecode(new TextEncoder().encode('{"$b":1}')));
    mustThrow(() => canonicalDecode(new TextEncoder().encode('{"$b":"AA=="}')));
    mustThrow(() => canonicalDecode(new TextEncoder().encode('{"$b":"AB"}')));
    mustThrow(() => canonicalDecode(new Uint8Array([0xff])));
    expect(canonicalDecode(new TextEncoder().encode('{"$b":"AA"}'))).toEqual(new Uint8Array([0]));
  });

  test('base64url helpers use canonical unpadded encoding', () => {
    for (const bytes of [
      new Uint8Array(),
      new Uint8Array([0]),
      new Uint8Array([255]),
      new Uint8Array([1, 2, 3, 4]),
    ]) {
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    }
    expect(toBase64Url(new Uint8Array([0, 0, 0]))).toBe('AAAA');
    mustThrow(() => fromBase64Url('A'));
    mustThrow(() => fromBase64Url('AA=='));
    mustThrow(() => fromBase64Url('AB'));
  });

  test('pins SHA-256 and canonical value hashes to known answers', () => {
    const bytes = new TextEncoder().encode('{"a":1,"b":2}');
    expect(toHex(sha256(bytes))).toBe(
      '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
    );
    expect(toHex(hashValue({ b: 2, a: 1 }))).toBe(
      '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
    );
  });
});
