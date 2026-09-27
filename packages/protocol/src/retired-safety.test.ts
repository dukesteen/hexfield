import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import type { Result } from '@cp2p/engine';
import { beforeAll, expect, test } from 'vitest';
import { createConsensusState, restoreConsensusState } from './consensus.js';
import { MemoryProtocolJournal } from './journal.js';
import type { CertifiedEntry, ProposalContext } from './proposal.js';
import { createRetiredSafety, restoreRetiredSafety } from './retired-safety.js';
import {
  advanceRecoveryFixture,
  certifyRecoveryFixtureEntry,
  createRecoveryFixture,
  recoveryFixtureReadiness,
  recoveryFixtureReplacement,
  signRecoveryFixtureAuthorization,
  signRecoveryFixtureEntry,
} from './testing/recovery-fixture.js';
import type { RecoveryFixture } from './testing/recovery-fixture.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

let data: RecoveryFixture;
let removal: CertifiedEntry;
let removed: ProposalContext;
beforeAll(() => {
  data = createRecoveryFixture();
  const replacement = recoveryFixtureReplacement(86);
  const change = signRecoveryFixtureAuthorization(
    data,
    recoveryFixtureReadiness(data, data.ready, replacement.peerId),
    replacement.secretKey,
  );
  const entry = signRecoveryFixtureEntry(
    data,
    data.ready,
    { kind: 'membership', change },
    data.ready.log.head.stateHash,
  );
  removal = certifyRecoveryFixtureEntry(data, data.ready, entry, [1, 2, 3]);
  removed = advanceRecoveryFixture(data.ready, removal);
  replacement.secretKey.fill(0);
}, 30_000);

test('removal saves a terminal signing marker atomically with the certificate', async () => {
  const prior = value(createConsensusState(data.ready, 0));
  const marker = value(createRetiredSafety(data.ready, removal, 0, prior));
  const journal = new MemoryProtocolJournal();
  expect(await journal.initialize(data.genesisEntry, canonicalEncode(prior))).toBe(true);
  for (const certified of data.deckEntries) {
    // oxlint-disable-next-line no-await-in-loop -- Journal commits require the preceding durable height.
    expect(await journal.commit(certified.entry.seq, 0, certified, canonicalEncode(prior))).toBe(
      true,
    );
  }
  expect(await journal.commit(removal.entry.seq, 1, removal, canonicalEncode(marker))).toBe(false);
  expect((await journal.load())?.entries).toHaveLength(data.deckEntries.length);
  expect(await journal.commit(removal.entry.seq, 0, removal, canonicalEncode(marker))).toBe(true);
  const durable = await journal.load();
  if (!durable) throw new Error('Missing durable retirement');
  const restored = canonicalDecode(durable.safety.bytes);
  expect(restoreRetiredSafety(restored, removed, 0, prior.localPublicKey)).toEqual({
    ok: true,
    value: marker,
  });
  expect(restoreConsensusState(restored, removed, 0).ok).toBe(false);
  expect(createConsensusState(removed, 0).ok).toBe(false);
  expect(await journal.saveSafety(removal.entry.seq, 0, canonicalEncode(prior))).toBe(false);
});

test('uncertified removal and active voters cannot produce a retirement record', () => {
  const prior = value(createConsensusState(data.ready, 0));
  expect(
    createRetiredSafety(
      data.ready,
      { ...removal, certificate: removal.certificate.slice(0, 2) },
      0,
      prior,
    ).ok,
  ).toBe(false);
  const remaining = value(createConsensusState(data.ready, 1));
  expect(createRetiredSafety(data.ready, removal, 1, remaining)).toMatchObject({
    ok: false,
    error: { code: 'replica-retirement' },
  });
  expect(createRetiredSafety(data.ready, removal, 0, { ...prior, epoch: 1 }).ok).toBe(false);
});

test('a copied or stale terminal record cannot match another game, head, seat or key', () => {
  const prior = value(createConsensusState(data.ready, 0));
  const marker = value(createRetiredSafety(data.ready, removal, 0, prior));
  for (const tampered of [
    { ...marker, genesisDigest: 'A'.repeat(43) },
    { ...marker, parentHash: 'a'.repeat(64) },
    { ...marker, height: marker.height + 1 },
    { ...marker, epoch: marker.epoch + 1 },
    { ...marker, localSeat: 1 },
    { ...marker, localPublicKey: data.genesis.seats[1]?.publicKey },
  ])
    expect(restoreRetiredSafety(tampered, removed, 0, prior.localPublicKey).ok).toBe(false);
  expect(restoreRetiredSafety(marker, data.ready, 0, prior.localPublicKey).ok).toBe(false);
});
