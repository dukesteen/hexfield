import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { beforeAll, describe, expect, test } from 'vitest';
import { entryHash } from './genesis.js';
import { loadPreparedRecoveryReadiness, prepareRecoveryReadiness } from './recovery-readiness.js';
import { loadActivatedRecoveryKeys } from './recovery-readiness.js';
import type { RecoveryReadinessStore } from './recovery-readiness.js';
import type { ProposalContext } from './proposal.js';
import type { RecoveryAuthorization, RecoveryReadiness } from './recovery-types.js';
import {
  advanceRecoveryFixture,
  certifyRecoveryFixtureEntry,
  createRecoveryFixture,
  recoveryFixtureKey,
  recoveryFixtureReadiness,
  recoveryFixtureReplacement,
  signRecoveryFixtureActivation,
  signRecoveryFixtureAuthorization,
  signRecoveryFixtureEntry,
} from './testing/recovery-fixture.js';
import type { RecoveryFixture } from './testing/recovery-fixture.js';

class MemoryStore implements RecoveryReadinessStore {
  readonly records = new Map<string, Uint8Array>();
  beforePut: ((key: string, bytes: Uint8Array) => void) | undefined;
  afterPut: (() => void) | undefined;
  throwAfterPut = false;

  async load(key: string): Promise<Uint8Array | null> {
    return this.records.get(key)?.slice() ?? null;
  }

  async putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean> {
    this.beforePut?.(key, bytes);
    if (this.records.has(key)) return false;
    this.records.set(key, bytes.slice());
    this.afterPut?.();
    if (this.throwAfterPut) throw new Error('simulated lost write reply');
    return true;
  }
}

function onlyRecord(store: MemoryStore): Uint8Array {
  const [record] = store.records.values();
  if (!record) throw new Error('Expected one readiness record');
  return record;
}

async function storeReadiness(
  fixture: RecoveryFixture,
  statement: RecoveryReadiness,
  secretKey: Uint8Array,
  store: MemoryStore,
): Promise<RecoveryAuthorization> {
  const result = await prepareRecoveryReadiness(
    statement,
    fixture.ready.log,
    recoveryFixtureKey(fixture, 1),
    [{ seat: 0, secretKey }],
    store,
  );
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function activatedContext(
  fixture: RecoveryFixture,
  statement: RecoveryReadiness,
  authorization: RecoveryAuthorization,
): ProposalContext {
  const parent = fixture.ready;
  const authEntry = signRecoveryFixtureEntry(
    fixture,
    parent,
    { kind: 'membership', change: authorization },
    parent.log.head.stateHash,
  );
  const authorized = advanceRecoveryFixture(
    parent,
    certifyRecoveryFixtureEntry(fixture, parent, authEntry, [1, 2, 3]),
  );
  const activation = signRecoveryFixtureActivation(fixture, authorized, authEntry);
  const applied = fixture.source.engine.apply(authorized.log.state, {
    kind: 'system',
    type: 'SEAT_STATUS',
    seat: statement.departedSeat,
    status: 'bot',
  });
  if (!applied.ok) throw new Error('Could not prepare the deterministic takeover state');
  const activationEntry = signRecoveryFixtureEntry(
    fixture,
    authorized,
    { kind: 'membership', change: activation },
    toHex(hashValue(applied.value.state)),
  );
  return advanceRecoveryFixture(
    authorized,
    certifyRecoveryFixtureEntry(fixture, authorized, activationEntry, [1, 2, 3]),
  );
}

describe('durable recovery readiness', () => {
  let fixture: RecoveryFixture;

  beforeAll(() => {
    fixture = createRecoveryFixture();
  }, 30_000);

  test('persists the signed authorization and replacement key before returning', async () => {
    const replacement = recoveryFixtureReplacement(201);
    const statement = recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId);
    const store = new MemoryStore();
    let persistedAtReturn = false;
    store.afterPut = () => {
      persistedAtReturn = store.records.size === 1;
    };

    const result = await prepareRecoveryReadiness(
      statement,
      fixture.ready.log,
      recoveryFixtureKey(fixture, 1),
      [{ seat: 0, secretKey: replacement.secretKey }],
      store,
    );

    expect(result.ok).toBe(true);
    expect(persistedAtReturn).toBe(true);
    const record = canonicalDecode(onlyRecord(store));
    expect(record).toMatchObject({
      statement,
      authorization: result.ok ? result.value : undefined,
      replacements: [{ seat: 0, secretKey: replacement.secretKey }],
    });
    expect(result.ok && 'secretKey' in result.value).toBe(false);
  });

  test('restores only the exact parent-bound reserved authorization without exposing keys', async () => {
    const replacement = recoveryFixtureReplacement(212);
    const statement = recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId);
    const store = new MemoryStore();
    const original = await storeReadiness(fixture, statement, replacement.secretKey, store);
    const restored = await loadPreparedRecoveryReadiness(
      fixture.ready.log,
      1,
      0,
      recoveryFixtureKey(fixture, 1),
      store,
    );
    expect(restored).toEqual({ ok: true, value: original });
    expect(restored.ok && restored.value && 'secretKey' in restored.value).toBe(false);
    expect(
      await loadPreparedRecoveryReadiness(
        fixture.beforeSetup.log,
        1,
        0,
        recoveryFixtureKey(fixture, 1),
        store,
      ),
    ).toEqual({ ok: true, value: null });
    const wrongHost = await loadPreparedRecoveryReadiness(
      fixture.ready.log,
      1,
      0,
      recoveryFixtureKey(fixture, 2),
      store,
    );
    expect(wrongHost).toMatchObject({ ok: false, error: { code: 'recovery-readiness-host' } });
    const [slot, bytes] = [...store.records.entries()][0] ?? [];
    if (!slot || !bytes) throw new Error('Missing stored readiness');
    const corrupted = bytes.slice();
    corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] ?? 0) ^ 1;
    store.records.set(slot, corrupted);
    expect(
      await loadPreparedRecoveryReadiness(
        fixture.ready.log,
        1,
        0,
        recoveryFixtureKey(fixture, 1),
        store,
      ),
    ).toMatchObject({ ok: false, error: { code: 'recovery-readiness-store' } });
  });

  test('recovers an exact authorization after a lost write reply and on retry', async () => {
    const replacement = recoveryFixtureReplacement(202);
    const statement = recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId);
    const store = new MemoryStore();
    store.throwAfterPut = true;

    const first = await prepareRecoveryReadiness(
      statement,
      fixture.ready.log,
      recoveryFixtureKey(fixture, 1),
      [{ seat: 0, secretKey: replacement.secretKey }],
      store,
    );
    const second = await prepareRecoveryReadiness(
      statement,
      fixture.ready.log,
      recoveryFixtureKey(fixture, 1),
      [{ seat: 0, secretKey: replacement.secretKey }],
      store,
    );

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(store.records.size).toBe(1);
  });

  test('uses inputs copied before awaiting storage', async () => {
    const replacement = recoveryFixtureReplacement(203);
    const statement = recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId);
    const originalParentHash = statement.parent.hash;
    const hostKey = recoveryFixtureKey(fixture, 1).slice();
    const originalSecret = replacement.secretKey.slice();
    const context = { ...fixture.ready.log, head: { ...fixture.ready.log.head } };
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const store = new MemoryStore();
    store.load = async () => {
      await loadGate;
      return null;
    };

    const pending = prepareRecoveryReadiness(
      statement,
      context,
      hostKey,
      [{ seat: 0, secretKey: replacement.secretKey }],
      store,
    );
    Object.assign(statement.parent, { hash: 'mutated' });
    hostKey.fill(0);
    replacement.secretKey.fill(0);
    context.head.stateHash = 'mutated';
    releaseLoad();
    const result = await pending;

    expect(result.ok).toBe(true);
    const record = canonicalDecode(onlyRecord(store));
    expect(record).toMatchObject({
      statement: {
        parent: { seq: fixture.ready.log.head.seq, hash: originalParentHash },
      },
      replacements: [{ secretKey: originalSecret }],
    });
    expect(originalParentHash).toBe(entryHash(fixture.ready.log.head));
  });

  test('only one competing readiness can claim a parent slot', async () => {
    const firstKey = recoveryFixtureReplacement(204);
    const secondKey = recoveryFixtureReplacement(205);
    const firstStatement = recoveryFixtureReadiness(fixture, fixture.ready, firstKey.peerId);
    const secondStatement = recoveryFixtureReadiness(fixture, fixture.ready, secondKey.peerId);
    const store = new MemoryStore();
    const args = (statement: typeof firstStatement, secretKey: Uint8Array) =>
      [
        statement,
        fixture.ready.log,
        recoveryFixtureKey(fixture, 1),
        [{ seat: 0 as const, secretKey }],
        store,
      ] as const;

    const [first, second] = await Promise.all([
      prepareRecoveryReadiness(...args(firstStatement, firstKey.secretKey)),
      prepareRecoveryReadiness(...args(secondStatement, secondKey.secretKey)),
    ]);

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    const failure = first.ok ? second : first;
    expect(failure).toMatchObject({
      ok: false,
      error: { code: 'recovery-readiness-conflict' },
    });
  });

  test('refuses a corrupt occupied slot without replacing it', async () => {
    const replacement = recoveryFixtureReplacement(206);
    const statement = recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId);
    const store = new MemoryStore();
    const slot = [
      'recovery-readiness',
      statement.genesisDigest,
      statement.parent.seq,
      statement.parent.hash,
      statement.nextEpoch,
      statement.departedSeat,
      statement.hostSeat,
    ].join('/');
    const corrupt = canonicalEncode({ version: 1, slot, statement });
    store.records.set(slot, corrupt);

    const result = await prepareRecoveryReadiness(
      statement,
      fixture.ready.log,
      recoveryFixtureKey(fixture, 1),
      [{ seat: 0, secretKey: replacement.secretKey }],
      store,
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'recovery-readiness-store' } });
    expect(store.records.get(slot)).toEqual(corrupt);
  });

  test('restores only an activated hosted key and zeroes owned copies on dispose', async () => {
    const replacement = recoveryFixtureReplacement(207);
    const statement = recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId);
    const store = new MemoryStore();
    const authorization = await storeReadiness(fixture, statement, replacement.secretKey, store);
    const active = activatedContext(fixture, statement, authorization);

    const restored = await loadActivatedRecoveryKeys(active.log, 1, store);

    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.keys).toHaveLength(1);
    expect(restored.value.keys[0]).toMatchObject({ seat: 0, secretKey: replacement.secretKey });
    const ownedKey = restored.value.keys[0]?.secretKey;
    if (!ownedKey) throw new Error('Missing restored key');
    restored.value.dispose();
    expect(ownedKey).toEqual(new Uint8Array(32));
  });

  test('does not expose keys while the certified authorization is still pending', async () => {
    const replacement = recoveryFixtureReplacement(208);
    const statement = recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId);
    const store = new MemoryStore();
    const authorization = await storeReadiness(fixture, statement, replacement.secretKey, store);
    const authEntry = signRecoveryFixtureEntry(
      fixture,
      fixture.ready,
      { kind: 'membership', change: authorization },
      fixture.ready.log.head.stateHash,
    );
    const pending = advanceRecoveryFixture(
      fixture.ready,
      certifyRecoveryFixtureEntry(fixture, fixture.ready, authEntry, [1, 2, 3]),
    );

    const restored = await loadActivatedRecoveryKeys(pending.log, 1, store);

    expect(restored).toMatchObject({
      ok: false,
      error: { code: 'recovery-readiness-unavailable' },
    });
  });

  test('rejects a stored statement that differs from the certified completed authorization', async () => {
    const replacement = recoveryFixtureReplacement(209);
    const storedStatement = recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId);
    const store = new MemoryStore();
    await storeReadiness(fixture, storedStatement, replacement.secretKey, store);
    const certifiedStatement = { ...storedStatement, botLevel: 'hard' as const };
    const certifiedAuthorization = signRecoveryFixtureAuthorization(
      fixture,
      certifiedStatement,
      replacement.secretKey,
    );
    const active = activatedContext(fixture, certifiedStatement, certifiedAuthorization);

    const restored = await loadActivatedRecoveryKeys(active.log, 1, store);

    expect(restored).toMatchObject({
      ok: false,
      error: { code: 'recovery-readiness-store' },
    });
  });

  test('rejects corrupt persisted keys after certified activation', async () => {
    const replacement = recoveryFixtureReplacement(211);
    const statement = recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId);
    const store = new MemoryStore();
    const authorization = await storeReadiness(fixture, statement, replacement.secretKey, store);
    const active = activatedContext(fixture, statement, authorization);
    const slot = [
      'recovery-readiness',
      statement.genesisDigest,
      statement.parent.seq,
      statement.parent.hash,
      statement.nextEpoch,
      statement.departedSeat,
      statement.hostSeat,
    ].join('/');
    store.records.get(slot)?.fill(0);
    store.records.set(slot, new Uint8Array([0xff, 0x00]));

    const restored = await loadActivatedRecoveryKeys(active.log, 1, store);

    expect(restored).toMatchObject({
      ok: false,
      error: { code: 'recovery-readiness-store' },
    });
  });

  test('snapshots certified activation data before store I/O and zeroes keys on dispose', async () => {
    const replacement = recoveryFixtureReplacement(210);
    const statement = recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId);
    const store = new MemoryStore();
    const authorization = await storeReadiness(fixture, statement, replacement.secretKey, store);
    const active = activatedContext(fixture, statement, authorization);
    const context = { ...active.log };
    let releaseLoad!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    store.load = async (key) => {
      await gate;
      return store.records.get(key)?.slice() ?? null;
    };

    const pending = loadActivatedRecoveryKeys(context, 1, store);
    delete context.authority;
    delete context.recovery;
    releaseLoad();
    const restored = await pending;

    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    const ownedKey = restored.value.keys[0]?.secretKey;
    if (!ownedKey) throw new Error('Missing restored key');
    expect(ownedKey).toEqual(replacement.secretKey);
    restored.value.dispose();
    expect(ownedKey).toEqual(new Uint8Array(32));
  });
});
