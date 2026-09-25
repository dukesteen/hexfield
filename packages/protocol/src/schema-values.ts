import { fromBase64Url } from '@cp2p/codec';
import * as v from 'valibot';

export const seatSchema = v.picklist([0, 1, 2, 3, 4, 5]);
export const nonnegativeIntegerSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);
export const positiveIntegerSchema = v.pipe(nonnegativeIntegerSchema, v.minValue(1));
export const hashSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));

function encodedBytes(length: number) {
  return v.pipe(
    v.string(),
    v.length(Math.ceil((length * 8) / 6)),
    v.regex(/^[A-Za-z0-9_-]+$/),
    v.check((value) => {
      try {
        return fromBase64Url(value).length === length;
      } catch {
        return false;
      }
    }),
  );
}

export const key32Schema = encodedBytes(32);
export const signature64Schema = encodedBytes(64);
