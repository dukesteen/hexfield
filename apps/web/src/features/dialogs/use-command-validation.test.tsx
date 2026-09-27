// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { expect, test, vi } from 'vitest';
import { useCommandValidations } from './use-command-validation.js';

test('online advisory validation remains checking and ignores a stale head response', async () => {
  const resolutions: ((result: Result<void>) => void)[] = [];
  const validate = vi.fn<() => Promise<Result<void>>>(
    () =>
      new Promise<Result<void>>((resolve) => {
        resolutions.push(resolve);
      }),
  );
  const session = { mode: 'p2p' };
  const view = renderHook(
    ({ revision, amount }) =>
      useCommandValidations([{ type: 'DISCARD', cards: { brick: amount } }], {
        validate,
        validationKey: String(revision),
        validationSession: session,
      }),
    { initialProps: { revision: 1, amount: 1 } },
  );
  expect(view.result.current).toEqual(['checking']);
  await waitFor(() => expect(validate).toHaveBeenCalledTimes(1));
  view.rerender({ revision: 2, amount: 2 });
  expect(view.result.current).toEqual(['checking']);
  await act(async () => resolutions[0]?.(success(undefined)));
  expect(view.result.current).toEqual(['checking']);
  await act(async () => resolutions[1]?.(success(undefined)));
  expect(view.result.current).toEqual(['valid']);
});

test('a rejected worker validation settles invalid instead of leaving a checking form', async () => {
  const session = { mode: 'p2p' };
  const view = renderHook(() =>
    useCommandValidations([{ type: 'END_TURN' }], {
      validate: async () => {
        throw new Error('worker stopped');
      },
      validationSession: session,
    }),
  );
  await waitFor(() => expect(view.result.current).toEqual(['invalid']));
});
