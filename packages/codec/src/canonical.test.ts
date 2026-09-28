import { describe, expect, test } from 'vitest';
import * as publicCodec from './index.js';
import { canonicalClone, canonicalText } from './internal.js';
import * as fc from 'fast-check';
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

function capture(action: () => unknown) {
  try {
    action();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { constructor: error.constructor, message: error.message };
  }
  throw new Error('Rejected corpus was accepted');
}

function metadata(value: unknown) {
  return value !== null && typeof value === 'object'
    ? {
        descriptors: Object.getOwnPropertyDescriptors(value),
      }
    : undefined;
}

describe('canonical codec', () => {
  test('internal canonical text preserves Unicode distinctions without a wire change', () => {
    expect(Object.hasOwn(publicCodec, 'canonicalText')).toBe(false);
    for (const value of ['é', 'e\u0301', '🌲', '\ud800', '\ud801']) {
      expect(canonicalText({ text: value })).toBe(`{"text":${JSON.stringify(value)}}`);
      expect(new TextEncoder().encode(canonicalText({ text: value }))).toEqual(
        canonicalEncode({ text: value }),
      );
      expect(canonicalDecode(canonicalEncode({ text: value }))).toEqual({ text: value });
    }
    // UTF-8 encoders replace lone surrogates in raw strings. Canonical JSON
    // escapes them, so the guard must continue distinguishing the originals.
    expect(canonicalText('\ud800')).not.toBe(canonicalText('\ud801'));
    expect(canonicalText('é')).not.toBe(canonicalText('e\u0301'));
  });

  test('internal clone matches the complete roundtrip for bounded canonical values', () => {
    expect(Object.hasOwn(publicCodec, 'canonicalClone')).toBe(false);
    const scalar = fc.oneof(
      fc.integer(),
      fc.string({ maxLength: 32 }),
      fc.boolean(),
      fc.constant(null),
      fc.uint8Array({ maxLength: 12 }),
    );
    fc.assert(
      fc.property(
        fc.record({
          values: fc.array(scalar, { maxLength: 8 }),
          nested: fc.record({ leaf: scalar }),
        }),
        (input) => {
          const cloned = canonicalClone(input);
          const reference = canonicalDecode(canonicalEncode(input));
          expect(cloned).toEqual(reference);
          expect(canonicalEncode(cloned)).toEqual(canonicalEncode(reference));
        },
      ),
      { numRuns: 100, seed: 42 },
    );
    const special: Record<string, unknown> = {};
    Object.setPrototypeOf(special, null);
    Object.defineProperty(special, '__proto__', { value: { text: '\ud800🌲' }, enumerable: true });
    for (const input of [
      special,
      -0,
      1e21,
      'é',
      'e\u0301',
      '\ud801',
      new Uint8Array([1, 2, 3, 4]).subarray(1, 3),
      { $b: 'ordinary', other: 1 },
    ]) {
      const cloned = canonicalClone(input);
      const reference = canonicalDecode(canonicalEncode(input));
      expect(cloned).toEqual(reference);
      expect(Object.getPrototypeOf(Object(cloned))).toBe(Object.getPrototypeOf(Object(reference)));
      expect(metadata(cloned)).toEqual(metadata(reference));
    }
  });

  test('clone owns records and byte views and duplicates shared references', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const shared = Object.freeze({ count: 1 });
    const input = { bytes: bytes.subarray(1, 3), pair: [shared, shared] };
    const cloned = canonicalClone(input);
    if (
      !cloned ||
      typeof cloned !== 'object' ||
      !('bytes' in cloned) ||
      !(cloned.bytes instanceof Uint8Array) ||
      !('pair' in cloned) ||
      !Array.isArray(cloned.pair)
    )
      throw new Error('Clone shape differs');
    expect(cloned.bytes.buffer).not.toBe(bytes.buffer);
    expect(cloned.bytes.byteLength).toBe(2);
    cloned.bytes[0] = 99;
    expect(bytes[1]).toBe(2);
    expect(cloned.pair[0]).not.toBe(cloned.pair[1]);
    expect(Object.isFrozen(cloned.pair[0])).toBe(false);
    expect(cloned.pair[0]).not.toBe(shared);
  });

  test('clone preserves encoder rejections and error messages', () => {
    const sparse: unknown[] = [];
    sparse.length = 2;
    const extra = [1];
    Object.defineProperty(extra, 'extra', { value: 2 });
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => 1 });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    for (const input of [
      sparse,
      extra,
      accessor,
      cyclic,
      new Date(0),
      new Map(),
      { $b: 'AA' },
      NaN,
      Infinity,
      1.5,
      undefined,
      1n,
      () => 1,
    ]) {
      expect(capture(() => canonicalClone(input))).toEqual(
        capture(() => canonicalDecode(canonicalEncode(input))),
      );
    }
  });

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
