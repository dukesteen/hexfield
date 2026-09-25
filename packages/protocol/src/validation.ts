import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import * as v from 'valibot';

export const MAX_MESSAGE_BYTES = 256 * 1024;

/** Copy and validate untrusted data before retaining any of its references. */
export function parseCanonical<T>(value: unknown, schema: v.GenericSchema<unknown, T>): Result<T> {
  try {
    const bytes = canonicalEncode(value);
    if (bytes.byteLength > MAX_MESSAGE_BYTES)
      return failure('message-too-large', 'Protocol value exceeds 256 KiB');
    const parsed = v.safeParse(schema, canonicalDecode(bytes));
    return parsed.success
      ? success(parsed.output)
      : failure('invalid-envelope', 'Protocol value does not match its schema');
  } catch {
    return failure('invalid-encoding', 'Protocol value is not canonical data');
  }
}
