// oxlint-disable typescript/no-unsafe-type-assertion -- Tests inspect known canonical fixture shapes and detached round-trips.
import { canonicalDecode, canonicalEncode, hashValue, toBase64Url } from '@cp2p/codec';
import { expect, test } from 'vitest';
import { canonicalText } from '@cp2p/codec/internal';
import {
  genesisBody,
  genesisDigest,
  genesisContextText,
  ownImmutableGenesis,
} from './genesis-identity.js';
import { fixtureAt, protocolFixture } from './testing/fixtures.js';

function baseline(body: Parameters<typeof genesisDigest>[0]): string {
  return toBase64Url(hashValue({ domain: 'cp2p/v1/genesis-body', body: genesisBody(body) }));
}

test('owned genesis keeps canonical identity and isolates all nested mutable fields', () => {
  const input = protocolFixture().genesis;
  input.commitments = { nested: { values: [1, 2] } };
  const owned = ownImmutableGenesis(input);
  const digest = baseline(input);
  const text = canonicalText(input);
  expect(genesisContextText(owned)).toBe(text);
  expect(canonicalEncode(owned)).toEqual(canonicalEncode(input));
  expect(genesisDigest(owned)).toBe(digest);
  for (const mutate of [
    () => {
      owned.config.seats[0] = 3;
    },
    () => {
      (owned.commitments.nested as { values: number[] }).values[0] = 9;
    },
    () => {
      fixtureAt(owned.seats, 0).name = 'changed';
    },
    () => {
      fixtureAt(owned.signatures, 0).sig = 'changed';
    },
  ])
    expect(mutate).toThrow(TypeError);
  fixtureAt(input.seats, 0).name = 'caller changed';
  expect(genesisDigest(input)).not.toBe(digest);
  expect(genesisDigest(owned)).toBe(digest);
  expect(genesisContextText(owned)).toBe(text);
  const detached = canonicalDecode(canonicalEncode(owned)) as typeof owned;
  fixtureAt(detached.seats, 0).name = 'export changed';
  expect(genesisDigest(detached)).not.toBe(digest);
});

test('mutable and shallow-frozen inputs always reflect nested changes', () => {
  for (const freeze of [false, true]) {
    const input = protocolFixture().genesis;
    if (freeze) Object.freeze(input);
    const before = genesisDigest(input);
    fixtureAt(input.seats, 0).name = 'changed';
    expect(genesisDigest(input)).toBe(baseline(input));
    expect(genesisDigest(input)).not.toBe(before);
  }
});

test('canonical bytes use an uncached detached fallback without partial freezing', () => {
  const input = protocolFixture().genesis;
  input.commitments = { before: { value: 1 }, bytes: new Uint8Array([1, 2]) };
  const owned = ownImmutableGenesis(input);
  const before = genesisDigest(owned);
  const beforeText = genesisContextText(owned);
  expect(Object.isFrozen(owned)).toBe(false);
  expect(Object.isFrozen(owned.config)).toBe(false);
  expect(Object.isFrozen(owned.commitments.before)).toBe(false);
  (owned.commitments.bytes as Uint8Array)[0] = 9;
  expect(genesisDigest(owned)).not.toBe(before);
  expect(genesisContextText(owned)).not.toBe(beforeText);
  expect(genesisContextText(owned)).toBe(canonicalText(owned));
  expect(genesisDigest(owned)).toBe(baseline(owned));
  expect((input.commitments.bytes as Uint8Array)[0]).toBe(1);
});

test('ownership rejects noncanonical shapes before caching', () => {
  const input = protocolFixture().genesis;
  Object.defineProperty(input.commitments, 'getter', { enumerable: true, get: () => 1 });
  expect(() => ownImmutableGenesis(input)).toThrow(
    'Canonical objects must contain enumerable data properties.',
  );
  input.commitments = { map: new Map() };
  expect(() => ownImmutableGenesis(input)).toThrow('Canonical objects must be plain records.');
});

test('signed initial context owns immutable genesis while public validation stays mutable', async () => {
  const { initialProposalContext } = await import('./replay.js');
  const { validateGenesis } = await import('./genesis.js');
  const fixture = protocolFixture();
  const result = initialProposalContext(fixture.entry, fixture.engine, {
    genesis: { allowStub: true },
    entry: { allowStub: true },
  });
  if (!result.ok) throw new Error(result.error.message);
  expect(Object.isFrozen(result.value.log.genesis.config.options)).toBe(true);
  expect(genesisDigest(result.value.log.genesis)).toBe(baseline(fixture.genesis));
  const checked = validateGenesis(fixture.genesis, fixture.engine, { allowStub: true });
  if (!checked.ok) throw new Error(checked.error.message);
  expect(Object.isFrozen(checked.value.genesis)).toBe(false);
  fixtureAt(checked.value.genesis.seats, 0).name = 'mutable validation result';
  expect(genesisDigest(checked.value.genesis)).not.toBe(genesisDigest(result.value.log.genesis));
});

test('bounded repeated genesis digest benchmark', () => {
  if (process.env.CP2P_GENESIS_DIGEST_BENCH !== '1') return;
  const input = protocolFixture().genesis;
  const owned = ownImmutableGenesis(input);
  const rounds = 10000;
  const measurements: { baselineMs: number; ownedMs: number }[] = [];
  for (let batch = 0; batch < 5; batch += 1) {
    const measure = (body: typeof input): number => {
      const started = performance.now();
      for (let index = 0; index < rounds; index += 1) genesisDigest(body);
      return performance.now() - started;
    };
    measurements.push(
      batch % 2 === 0
        ? { baselineMs: measure(input), ownedMs: measure(owned) }
        : { ownedMs: measure(owned), baselineMs: measure(input) },
    );
  }
  expect(genesisDigest(owned)).toBe(baseline(input));
  // oxlint-disable-next-line no-console -- Opt-in bounded benchmark emits its measured evidence.
  console.log(JSON.stringify({ rounds, bytes: canonicalEncode(input).byteLength, measurements }));
});

test('full genesis text binds gameId and signatures while mutable inputs never gain a cached identity', () => {
  const input = protocolFixture().genesis;
  const digest = genesisDigest(input);
  const first = genesisContextText(input);
  input.gameId += 'x';
  expect(genesisDigest(input)).toBe(digest);
  expect(genesisContextText(input)).not.toBe(first);
  const second = genesisContextText(input);
  fixtureAt(input.signatures, 0).sig += 'x';
  expect(genesisDigest(input)).toBe(digest);
  expect(genesisContextText(input)).not.toBe(second);
  expect(genesisContextText(input)).toBe(canonicalText(input));
});
