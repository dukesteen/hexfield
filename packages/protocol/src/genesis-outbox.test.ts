import { canonicalEncode, toBase64Url } from '@cp2p/codec';
import { signObject } from '@cp2p/crypto';
import type { Result } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { deckCeremonyId } from './deck-genesis.js';
import { MemoryGenesisConsentStore, prepareGenesisConsent } from './genesis-outbox.js';
import type { GenesisConsentStore } from './genesis-outbox.js';
import { genesisBody, genesisDigest, signVerifiedGenesis } from './genesis.js';
import { createGenesisDeckFixture } from './testing/deck-fixture.js';
import { createSimulationGenesis } from './testing/simulation-genesis.js';
import type { GenesisBody } from './types.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

let cached: ReturnType<typeof buildFixture> | null = null;
function fixture() {
  cached ??= buildFixture();
  return cached;
}

function buildFixture() {
  const simulation = createSimulationGenesis({
    seed: 101,
    humanCount: 2,
    config: {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1],
      options: { base: { mapLayout: 'random' } },
    },
  });
  const body: GenesisBody = {
    ...genesisBody(simulation.genesis),
    security: 'verified',
    commitments: {},
  };
  const ceremony = createGenesisDeckFixture(body, simulation.identities);
  const first = simulation.identities.get(0);
  const second = simulation.identities.get(1);
  if (!first || !second) throw new Error('Missing two fixture identities');
  return { body: ceremony.body, transcripts: ceremony.transcripts, first, second };
}

class RecordingStore implements GenesisConsentStore {
  readonly records = new Map<string, Uint8Array>();
  writes = 0;
  failRead = false;
  failWrite = false;

  async load(id: string): Promise<Uint8Array | null> {
    if (this.failRead) throw new Error('read failed');
    return this.records.get(id)?.slice() ?? null;
  }

  async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    this.writes += 1;
    if (this.failWrite) throw new Error('write failed');
    if (this.records.has(id)) return false;
    this.records.set(id, bytes.slice());
    return true;
  }
}

describe('durable verified genesis consent', () => {
  test('persists consent before returning and retries exact bytes after restart', async () => {
    const { body, transcripts, first } = fixture();
    const store = new RecordingStore();
    const original = value(
      await prepareGenesisConsent(body, transcripts, 0, first.secretKey, store),
    );
    const id = `genesis-consent/${deckCeremonyId(body)}/0`;
    expect(store.records.has(id)).toBe(true);
    expect(store.writes).toBe(1);
    const restarted = value(
      await prepareGenesisConsent(body, transcripts, 0, first.secretKey, store),
    );
    expect(restarted).toEqual(original);
    expect(store.writes).toBe(1);
    expect(original).toEqual(value(signVerifiedGenesis(body, transcripts, 0, first.secretKey)));
    const memory = new MemoryGenesisConsentStore();
    expect(
      value(await prepareGenesisConsent(body, transcripts, 0, first.secretKey, memory)),
    ).toEqual(original);
  }, 30_000);

  test('same ceremony cannot sign a changed final genesis, even with valid transcripts', async () => {
    const { body, transcripts, first } = fixture();
    const store = new RecordingStore();
    value(await prepareGenesisConsent(body, transcripts, 0, first.secretKey, store));
    const changed: GenesisBody = {
      ...body,
      genesisSeed: toBase64Url(new Uint8Array(32).fill(93)),
      createdAt: body.createdAt + 1,
    };
    expect(deckCeremonyId(changed)).toBe(deckCeremonyId(body));
    expect(genesisDigest(changed)).not.toBe(genesisDigest(body));
    expect(signVerifiedGenesis(changed, transcripts, 0, first.secretKey).ok).toBe(true);
    const refused = await prepareGenesisConsent(changed, transcripts, 0, first.secretKey, store);
    expect(refused).toMatchObject({ ok: false, error: { code: 'genesis-outbox-conflict' } });
    expect(store.writes).toBe(1);
  }, 30_000);

  test('concurrent competing drafts have one immutable winner', async () => {
    const { body, transcripts, first } = fixture();
    const alternate = { ...body, createdAt: body.createdAt + 2 };
    const store = new RecordingStore();
    const outcomes = await Promise.all([
      prepareGenesisConsent(body, transcripts, 0, first.secretKey, store),
      prepareGenesisConsent(alternate, transcripts, 0, first.secretKey, store),
    ]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toMatchObject([
      { error: { code: 'genesis-outbox-conflict' } },
    ]);
    expect(store.records.size).toBe(1);
  }, 30_000);

  test('storage failures return no consent; corrupt records and wrong signers fail closed', async () => {
    const { body, transcripts, first, second } = fixture();
    const store = new RecordingStore();
    store.failWrite = true;
    expect(await prepareGenesisConsent(body, transcripts, 0, first.secretKey, store)).toMatchObject(
      { ok: false, error: { code: 'genesis-outbox-write' } },
    );
    expect(store.records.size).toBe(0);
    store.failWrite = false;
    value(await prepareGenesisConsent(body, transcripts, 0, first.secretKey, store));
    const id = `genesis-consent/${deckCeremonyId(body)}/0`;
    store.records.set(
      id,
      canonicalEncode({
        genesisDigest: genesisDigest(body),
        signature: {
          seat: 0,
          sig: signObject('other', { genesisDigest: genesisDigest(body) }, first.secretKey),
        },
      }),
    );
    expect(await prepareGenesisConsent(body, transcripts, 0, first.secretKey, store)).toMatchObject(
      { ok: false, error: { code: 'genesis-outbox-conflict' } },
    );
    store.records.set(id, Uint8Array.of(0xff));
    expect(await prepareGenesisConsent(body, transcripts, 0, first.secretKey, store)).toMatchObject(
      { ok: false, error: { code: 'genesis-outbox-record' } },
    );
    const untouched = new RecordingStore();
    expect(
      await prepareGenesisConsent(body, transcripts, 0, second.secretKey, untouched),
    ).toMatchObject({ ok: false, error: { code: 'genesis-signer' } });
    expect(untouched.writes).toBe(0);
    untouched.failRead = true;
    expect(
      await prepareGenesisConsent(body, transcripts, 0, first.secretKey, untouched),
    ).toMatchObject({ ok: false, error: { code: 'genesis-outbox-read' } });
  }, 30_000);
});
