import { fileURLToPath } from 'node:url';
import { createBaseEngine } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { verifyResourceAccounting } from '../../../packages/protocol/src/resource-accounting.js';
import { readReplay, verifyReplay } from './replay.js';

describe('resource effects in retained golden histories', () => {
  test.each(['all-development-card-types', 'hidden-vp-win'])(
    '%s matches declared accounting on every existing input',
    (name) => {
      const path = fileURLToPath(
        new URL(`../../../packages/engine/test/golden/${name}.replay.json`, import.meta.url),
      );
      const replay = readReplay(path);
      const engine = createBaseEngine();
      let checked = 0;
      const final = verifyReplay(
        {
          ...engine,
          apply(before, input) {
            const result = engine.apply(before, input);
            if (!result.ok) return result;
            const accounting = verifyResourceAccounting(
              before,
              result.value.state,
              result.value.effects,
            );
            if (!accounting.ok)
              throw new Error(
                `Input ${checked}, ${input.kind === 'command' ? input.command.type : input.type}: ${accounting.error.message}`,
              );
            checked += 1;
            return result;
          },
        },
        replay,
      );
      expect(checked).toBe(replay.inputs.length);
      expect(final.result).not.toBeNull();
    },
  );
});
