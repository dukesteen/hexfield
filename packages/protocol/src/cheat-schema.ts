import * as v from 'valibot';
import {
  hashSchema,
  nonnegativeIntegerSchema,
  seatSchema,
  signature64Schema,
} from './schema-values.js';

const refSchema = v.strictObject({ seq: nonnegativeIntegerSchema, hash: hashSchema });
const signedSchema = v.strictObject({ body: v.unknown(), sig: signature64Schema });
const base = { at: refSchema, artifact: signedSchema };

export const cheatClaimSchema = v.strictObject({
  seat: seatSchema,
  evidence: v.variant('kind', [
    v.strictObject({ kind: v.literal('command-proof'), ...base }),
    v.strictObject({ kind: v.literal('beacon-reveal'), ...base }),
    v.strictObject({ kind: v.literal('deck-pass'), ...base }),
    v.strictObject({
      kind: v.literal('deck-unlock'),
      ...base,
      prefix: v.pipe(v.array(v.unknown()), v.maxLength(6)),
    }),
    v.strictObject({ kind: v.literal('count-proof'), ...base }),
    v.strictObject({ kind: v.literal('steal-contribution'), ...base }),
    v.strictObject({ kind: v.literal('bad-steal-delivery'), ...base }),
    v.strictObject({ kind: v.literal('false-steal-dispute'), ...base }),
  ]),
});
