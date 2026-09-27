import * as v from 'valibot';
import { describe, expect, test } from 'vitest';
import { DEFAULT_TAKEOVER_POLICY, takeoverPolicySchema } from './takeover-policy.js';

describe('signed takeover policy', () => {
  test('defaults to vote mode and accepts only bounded whole-second thresholds', () => {
    expect(v.parse(takeoverPolicySchema, DEFAULT_TAKEOVER_POLICY)).toEqual({
      mode: 'vote',
      afterSeconds: 120,
    });
    for (const mode of ['vote', 'auto'] as const) {
      expect(v.safeParse(takeoverPolicySchema, { mode, afterSeconds: 15 }).success).toBe(true);
      expect(v.safeParse(takeoverPolicySchema, { mode, afterSeconds: 86_400 }).success).toBe(true);
      for (const afterSeconds of [14, 86_401, 30.5, -1, Infinity])
        expect(v.safeParse(takeoverPolicySchema, { mode, afterSeconds }).success).toBe(false);
    }
  });

  test('has exactly one never encoding and rejects extra signed fields', () => {
    expect(v.safeParse(takeoverPolicySchema, { mode: 'vote', afterSeconds: 'never' }).success).toBe(
      true,
    );
    expect(v.safeParse(takeoverPolicySchema, { mode: 'auto', afterSeconds: 'never' }).success).toBe(
      false,
    );
    expect(
      v.safeParse(takeoverPolicySchema, {
        mode: 'vote',
        afterSeconds: 120,
        localOverride: true,
      }).success,
    ).toBe(false);
  });
});
