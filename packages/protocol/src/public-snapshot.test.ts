import { expect, test, vi } from 'vitest';
import { protocolFixture } from './testing/fixtures.js';
import { initialProposalContext } from './replay.js';
import { cacheCommittedPublicSnapshot } from './public-snapshot.js';

function at(seq: number) {
  const fixture = protocolFixture();
  const initial = initialProposalContext(fixture.entry, fixture.engine, {
    genesis: { allowStub: true },
    entry: { allowStub: true },
  });
  if (!initial.ok) throw new Error(initial.error.message);
  return {
    ...initial.value,
    log: { ...initial.value.log, head: { ...initial.value.log.head, seq } },
  };
}

test('only every hundredth committed public context is offered as detached cache data', () => {
  const save = vi.fn<(snapshot: unknown) => Promise<void>>(async () => undefined);
  for (const seq of [0, 1, 99, 100, 101, 200]) cacheCommittedPublicSnapshot(at(seq), save);
  expect(save).toHaveBeenCalledTimes(2);
  expect(save.mock.calls.map(([snapshot]) => snapshot)).toMatchObject([{ seq: 100 }, { seq: 200 }]);
});

test('synchronous and asynchronous cache failures cannot escape the commit callback', async () => {
  expect(() =>
    cacheCommittedPublicSnapshot(at(100), () => {
      throw new Error('storage failed');
    }),
  ).not.toThrow();
  expect(() =>
    cacheCommittedPublicSnapshot(at(200), async () => {
      throw new Error('storage failed later');
    }),
  ).not.toThrow();
  await Promise.resolve();
});
