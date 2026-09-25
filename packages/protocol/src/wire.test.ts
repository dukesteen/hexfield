import { describe, expect, test } from 'vitest';
import * as v from 'valibot';
import { decodeMessage, encodeMessage } from './wire.js';
import { MAX_MESSAGE_BYTES } from './validation.js';

const messageSchema = v.strictObject({
  t: v.literal('PAYLOAD'),
  sequence: v.pipe(v.number(), v.integer()),
  payload: v.custom<Uint8Array>((value) => value instanceof Uint8Array),
  nested: v.strictObject({ note: v.string() }),
});

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function valueOf<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error('Expected a successful result');
  return result.value;
}

describe('protocol wire codec', () => {
  test('round-trips strict typed envelopes and nested byte tags as detached values', () => {
    const payload = Uint8Array.of(0, 1, 127, 128, 255);
    const value = {
      t: 'PAYLOAD' as const,
      sequence: 4,
      payload,
      nested: { note: 'snowman ☃' },
    };
    const encoded = encodeMessage(value, messageSchema);
    expect(encoded.ok).toBe(true);
    const encodedBytes = valueOf(encoded);
    payload.fill(9);

    const decoded = decodeMessage(encodedBytes, messageSchema);
    expect(decoded).toEqual({
      ok: true,
      value: {
        t: 'PAYLOAD',
        sequence: 4,
        payload: Uint8Array.of(0, 1, 127, 128, 255),
        nested: { note: 'snowman ☃' },
      },
    });
    valueOf(decoded).payload.fill(8);
    const decodedAgain = decodeMessage(encodedBytes, messageSchema);
    expect(decodedAgain.ok && decodedAgain.value.payload).toEqual(
      Uint8Array.of(0, 1, 127, 128, 255),
    );
  });

  test('applies the strict caller schema on both directions', () => {
    const extra = encodeMessage(
      {
        t: 'PAYLOAD',
        sequence: 1,
        payload: new Uint8Array(),
        nested: { note: '' },
        extra: true,
      },
      messageSchema,
    );
    expect(extra).toMatchObject({ ok: false, error: { code: 'invalid-envelope' } });

    const canonicalExtra = utf8(
      '{"extra":true,"nested":{"note":""},"payload":{"$b":""},"sequence":1,"t":"PAYLOAD"}',
    );
    expect(decodeMessage(canonicalExtra, messageSchema)).toMatchObject({
      ok: false,
      error: { code: 'invalid-envelope' },
    });
  });

  test('accepts a message exactly at the byte limit and rejects larger bytes before parsing', () => {
    const stringSchema = v.string();
    const maximumValue = 'x'.repeat(MAX_MESSAGE_BYTES - 2);
    const exactlyAtLimit = encodeMessage(maximumValue, stringSchema);
    expect(exactlyAtLimit.ok).toBe(true);
    const exactBytes = valueOf(exactlyAtLimit);
    expect(exactBytes.byteLength).toBe(MAX_MESSAGE_BYTES);
    expect(decodeMessage(exactBytes, stringSchema)).toEqual({
      ok: true,
      value: maximumValue,
    });
    expect(encodeMessage('x'.repeat(MAX_MESSAGE_BYTES - 1), stringSchema)).toMatchObject({
      ok: false,
      error: { code: 'message-too-large' },
    });
    expect(decodeMessage(new Uint8Array(MAX_MESSAGE_BYTES + 1), stringSchema)).toMatchObject({
      ok: false,
      error: { code: 'message-too-large' },
    });
  });

  test('rejects malformed UTF-8, duplicate or unsorted keys, whitespace, and alternate integers', () => {
    const inputs = [
      new Uint8Array([0xff]),
      utf8('{"sequence":1,"sequence":1,"t":"PAYLOAD","payload":{"$b":""},"nested":{"note":""}}'),
      utf8('{"t":"PAYLOAD","sequence":1,"payload":{"$b":""},"nested":{"note":""}}'),
      utf8('{"nested":{"note":""}, "payload":{"$b":""},"sequence":1,"t":"PAYLOAD"}'),
      utf8('{"nested":{"note":""},"payload":{"$b":""},"sequence":1.0,"t":"PAYLOAD"}'),
      utf8('{"nested":{"note":""},"payload":{"$b":""},"sequence":-0,"t":"PAYLOAD"}'),
    ];
    for (const input of inputs) {
      expect(decodeMessage(input, messageSchema).ok).toBe(false);
    }
  });

  test('rejects malformed byte tags and too-deep nesting without throwing', () => {
    const malformedTags = [
      utf8('{"nested":{"note":""},"payload":{"$b":1},"sequence":1,"t":"PAYLOAD"}'),
      utf8('{"nested":{"note":""},"payload":{"$b":"AA=="},"sequence":1,"t":"PAYLOAD"}'),
      utf8('{"nested":{"note":""},"payload":{"$b":"AB"},"sequence":1,"t":"PAYLOAD"}'),
    ];
    for (const input of malformedTags) {
      expect(decodeMessage(input, messageSchema).ok).toBe(false);
    }

    const deep = utf8(`${'['.repeat(20_000)}null${']'.repeat(20_000)}`);
    let deepRejected = false;
    expect(() => {
      deepRejected = !decodeMessage(deep, v.unknown()).ok;
    }).not.toThrow();
    expect(deepRejected).toBe(true);
  });

  test('leaves integer precision policy to the caller schema', () => {
    const outsideSafeRange = Number.MAX_SAFE_INTEGER + 1;
    const permissive = encodeMessage(outsideSafeRange, v.number());
    expect(permissive.ok).toBe(true);
    expect(decodeMessage(valueOf(permissive), v.number())).toEqual({
      ok: true,
      value: outsideSafeRange,
    });

    const safeInteger = v.pipe(
      v.number(),
      v.integer(),
      v.check((number) => Number.isSafeInteger(number)),
    );
    expect(encodeMessage(outsideSafeRange, safeInteger)).toMatchObject({
      ok: false,
      error: { code: 'invalid-envelope' },
    });
  });

  test('converts canonical encoder and schema exceptions into typed failures', () => {
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => 'unsafe',
    });
    expect(encodeMessage(accessor, v.unknown())).toMatchObject({
      ok: false,
      error: { code: 'invalid-encoding' },
    });
    const throwingSchema = v.custom<unknown>(() => {
      throw new Error('validator failed');
    });
    expect(encodeMessage('value', throwingSchema)).toMatchObject({
      ok: false,
      error: { code: 'invalid-envelope' },
    });
    expect(decodeMessage(utf8('null'), throwingSchema)).toMatchObject({
      ok: false,
      error: { code: 'invalid-envelope' },
    });
  });
});
