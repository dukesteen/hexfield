import * as v from 'valibot';

export const DEFAULT_TAKEOVER_POLICY = { mode: 'vote', afterSeconds: 120 } as const;

/** `never` has one canonical encoding, independent of any local UI preference. */
export const takeoverPolicySchema = v.union([
  v.strictObject({
    mode: v.picklist(['vote', 'auto'] as const),
    afterSeconds: v.pipe(v.number(), v.integer(), v.minValue(15), v.maxValue(86_400)),
  }),
  v.strictObject({ mode: v.literal('vote'), afterSeconds: v.literal('never') }),
]);

export type TakeoverPolicy = v.InferOutput<typeof takeoverPolicySchema>;
