import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import * as v from 'valibot';
import { MAX_MESSAGE_BYTES } from './validation.js';

/** Canonically encode a value only when it matches the caller's wire schema. */
export function encodeMessage<T>(
  value: unknown,
  schema: v.GenericSchema<unknown, T>,
): Result<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = canonicalEncode(value);
  } catch {
    return failure('invalid-encoding', 'Protocol value is not canonical data');
  }
  if (bytes.byteLength > MAX_MESSAGE_BYTES)
    return failure('message-too-large', 'Protocol message exceeds 256 KiB');

  try {
    const parsed = v.safeParse(schema, value);
    return parsed.success
      ? success(bytes)
      : failure('invalid-envelope', 'Protocol value does not match its schema');
  } catch {
    return failure('invalid-envelope', 'Protocol value does not match its schema');
  }
}

/** Decode canonical wire bytes, apply the caller's schema, and return detached data. */
export function decodeMessage<T>(
  bytes: Uint8Array,
  schema: v.GenericSchema<unknown, T>,
): Result<T> {
  if (!(bytes instanceof Uint8Array))
    return failure('invalid-encoding', 'Protocol message must be a Uint8Array');
  if (bytes.byteLength > MAX_MESSAGE_BYTES)
    return failure('message-too-large', 'Protocol message exceeds 256 KiB');

  let value: unknown;
  try {
    value = canonicalDecode(bytes);
  } catch {
    return failure('invalid-encoding', 'Protocol message is not canonical UTF-8 JSON');
  }

  try {
    const parsed = v.safeParse(schema, value);
    return parsed.success
      ? success(parsed.output)
      : failure('invalid-envelope', 'Protocol message does not match its schema');
  } catch {
    return failure('invalid-envelope', 'Protocol message does not match its schema');
  }
}
