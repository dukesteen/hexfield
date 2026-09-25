import assert from 'node:assert/strict';
import test from 'node:test';
import { createNetworkMatrix } from './network-matrix.mjs';

await test('push and pull request use five deterministic games for each scenario', () => {
  for (const eventName of ['push', 'pull_request']) {
    const matrix = createNetworkMatrix({ eventName });
    assert.equal(matrix.include.length, 9);
    assert.deepEqual(matrix.include[0], { scenario: 1, startIndex: 0, seeds: 5 });
    assert.deepEqual(matrix.include.at(-1), { scenario: 9, startIndex: 0, seeds: 5 });
  }
});

await test('nightly ranges rotate by UTC date and remain disjoint for twenty games', () => {
  const first = createNetworkMatrix({
    eventName: 'schedule',
    now: new Date('2026-09-25T23:59:00.000Z'),
  });
  const second = createNetworkMatrix({
    eventName: 'schedule',
    now: new Date('2026-09-26T00:01:00.000Z'),
  });
  assert.equal(first.include.length, 9);
  assert.equal(first.include[0]?.seeds, 20);
  assert.equal(second.include[0]?.startIndex, (first.include[0]?.startIndex ?? 0) + 20);
});

await test('manual acceptance shards larger counts into forty-game disjoint ranges', () => {
  const matrix = createNetworkMatrix({
    eventName: 'workflow_dispatch',
    inputs: { network_seeds: '1000', network_start_index: '700' },
  });
  assert.equal(matrix.include.length, 225);
  for (let scenario = 1; scenario <= 9; scenario++) {
    const shards = matrix.include.filter((part) => part.scenario === scenario);
    assert.equal(shards.length, 25);
    assert.deepEqual(shards[0], { scenario, startIndex: 700, seeds: 40 });
    assert.deepEqual(shards.at(-1), { scenario, startIndex: 1660, seeds: 40 });
  }
});

await test('manual controls default to the same small run and permit a final partial shard', () => {
  const defaultMatrix = createNetworkMatrix({
    eventName: 'workflow_dispatch',
    inputs: { network_seeds: '20', network_start_index: '0' },
  });
  assert.equal(defaultMatrix.include.length, 9);

  const partial = createNetworkMatrix({
    eventName: 'workflow_dispatch',
    inputs: { network_seeds: '41', network_start_index: '3' },
  });
  assert.deepEqual(partial.include.slice(0, 2), [
    { scenario: 1, startIndex: 3, seeds: 40 },
    { scenario: 1, startIndex: 43, seeds: 1 },
  ]);
});

await test('manual seed counts and ranges reject invalid or unsafe values', () => {
  for (const network_seeds of ['0', '1001', '1.5', '-1', '']) {
    assert.throws(() =>
      createNetworkMatrix({
        eventName: 'workflow_dispatch',
        inputs: { network_seeds, network_start_index: '0' },
      }),
    );
  }
  for (const network_start_index of ['-1', '1.2', '9007199254740991']) {
    assert.throws(() =>
      createNetworkMatrix({
        eventName: 'workflow_dispatch',
        inputs: { network_seeds: '20', network_start_index },
      }),
    );
  }
});
