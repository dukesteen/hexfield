import { canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { scalarToBytes, verifyObject } from '@cp2p/crypto';
import type { Result, Seat } from '@cp2p/engine';
import { beforeAll, describe, expect, test } from 'vitest';
import { MemoryProtocolJournal } from './journal.js';
import type { JournalRecord, ProtocolJournal } from './journal.js';
import { advanceContext, validateCertifiedEntry } from './proposal.js';
import { produceRecoveryCheck } from './recovery-check.js';
import type { RecoveryCheckInput, RecoveryCheckStore } from './recovery-check.js';
import { RECOVERY_CHECK_DOMAIN } from './recovery-membership.js';
import { loadRecoveryPrivate } from './recovery-private.js';
import { replayCertifiedPrefix } from './replay.js';
import {
  advanceRecoveryFixture,
  certifyRecoveryFixtureEntry,
  createRecoveryFixture,
  recoveryFixtureKey,
  recoveryFixtureReadiness,
  recoveryFixtureReplacement,
  signRecoveryFixtureAuthorization,
  signRecoveryFixtureEntry,
} from './testing/recovery-fixture.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing recovery check fixture');
  return item;
}

function byteStore(): RecoveryCheckStore & { records: Map<string, Uint8Array> } {
  const records = new Map<string, Uint8Array>();
  return {
    records,
    async load(id) {
      return records.get(id)?.slice() ?? null;
    },
    async putIfAbsent(id, bytes) {
      if (records.has(id)) return false;
      records.set(id, bytes.slice());
      return true;
    },
  };
}

function journalWithLoad(
  journal: ProtocolJournal,
  load: () => Promise<JournalRecord | null>,
): ProtocolJournal {
  return {
    load,
    initialize: journal.initialize.bind(journal),
    loadSafety: journal.loadSafety.bind(journal),
    saveSafety: journal.saveSafety.bind(journal),
    commit: journal.commit.bind(journal),
  };
}

async function fixture() {
  const source = createRecoveryFixture({ masterBackedBeacon: true, chainLength: 1 });
  const journal = new MemoryProtocolJournal();
  if (!(await journal.initialize(source.genesisEntry, new Uint8Array())))
    throw new Error('Journal init failed');
  for (const certified of source.deckEntries) {
    // Each durable entry must commit after its certified parent.
    // oxlint-disable-next-line eslint/no-await-in-loop
    if (!(await journal.commit(certified.entry.seq, 0, certified, new Uint8Array())))
      throw new Error('Journal commit failed');
  }
  const replacement = recoveryFixtureReplacement(78);
  const readiness = recoveryFixtureReadiness(source, source.ready, replacement.peerId);
  const change = signRecoveryFixtureAuthorization(source, readiness, replacement.secretKey);
  const entry = signRecoveryFixtureEntry(
    source,
    source.ready,
    { kind: 'membership', change },
    source.ready.log.head.stateHash,
  );
  const certified = certifyRecoveryFixtureEntry(source, source.ready, entry, [0, 1, 2, 3]);
  advanceRecoveryFixture(source.ready, certified);
  if (!(await journal.commit(entry.seq, 0, certified, new Uint8Array())))
    throw new Error('Authorization commit failed');
  return { ...source, journal, replacement };
}

describe('honest recovery activation check', () => {
  let data: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    data = await fixture();
  }, 60_000);

  const input = () => ({
    journal: data.journal,
    store: byteStore(),
    engine: data.source.engine,
    policy: data.policy,
    localSeat: 1 as Seat,
    signingKey: recoveryFixtureKey(data, 1),
    secrets: [{ seat: 0 as const, master: scalarToBytes(17n) }],
  });

  test('persists the exact check after reconstructing every affected seat', async () => {
    const options = input();
    const produced = value(await produceRecoveryCheck(options));
    try {
      expect(produced.reconstructed.driver.privateState(0)).not.toBeNull();
      expect(produced.signed.check.seat).toBe(1);
      expect(produced.signed.statement.nextEpoch).toBe(2);
      expect(produced.signed.statement.checkDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(
        verifyObject(
          RECOVERY_CHECK_DOMAIN,
          produced.signed.statement,
          produced.signed.check.sig,
          required(data.source.identities.get(1)).publicKey,
        ),
      ).toBe(true);
      expect(options.store.records.size).toBe(2);
      const ackId = required(
        [...options.store.records.keys()].find((key) => key.startsWith('recovery-check/')),
      );
      expect(options.store.records.get(ackId)).toEqual(canonicalEncode(produced.signed));
    } finally {
      produced.reconstructed.dispose();
    }
  });

  test('produced checks certify an activation at the next epoch', async () => {
    const record = required(await data.journal.load());
    const journal = new MemoryProtocolJournal();
    if (!(await journal.initialize(record.genesis, new Uint8Array())))
      throw new Error('Isolated journal init failed');
    for (const certified of record.entries) {
      // Journal commits must follow their certified parents.
      // oxlint-disable-next-line eslint/no-await-in-loop
      if (!(await journal.commit(certified.entry.seq, 0, certified, new Uint8Array())))
        throw new Error('Isolated journal commit failed');
    }
    const recovererSeats = [1, 2, 3] as const;
    const stores = recovererSeats.map(() => byteStore());
    const produced = await Promise.all(
      recovererSeats.map((seat, index) =>
        produceRecoveryCheck({
          ...input(),
          journal,
          store: required(stores[index]),
          localSeat: seat,
          signingKey: recoveryFixtureKey(data, seat),
        }),
      ),
    );
    const checks = produced.map((result) => value(result));
    try {
      const statement = required(checks[0]).signed.statement;
      expect(
        checks.every(
          (item) => toHex(hashValue(item.signed.statement)) === toHex(hashValue(statement)),
        ),
      ).toBe(true);
      const context = value(
        replayCertifiedPrefix(record.genesis, record.entries, data.source.engine, data.policy),
      ).context;
      const takeover = value(
        data.source.engine.apply(context.log.state, {
          kind: 'system',
          type: 'SEAT_STATUS',
          seat: 0,
          status: 'bot',
        }),
      );
      const entry = signRecoveryFixtureEntry(
        data,
        context,
        {
          kind: 'membership',
          change: {
            kind: 'recovery-activate',
            statement,
            checks: checks.map((item) => item.signed.check),
          },
        },
        toHex(hashValue(takeover.state)),
      );
      const certified = certifyRecoveryFixtureEntry(data, context, entry, recovererSeats);
      const validated = value(validateCertifiedEntry(certified, context));
      const activated = value(advanceContext(context, validated));
      expect(activated.membership.epoch).toBe(2);
      expect(activated.log.recovery?.pending).toBeNull();
      const restored = value(
        await loadRecoveryPrivate(activated.log, statement.authorization, 1, required(stores[0])),
      );
      expect(restored.secrets).toEqual([{ seat: 0, master: scalarToBytes(17n) }]);
      const retainedBuffer = required(restored.secrets[0]).master;
      restored.dispose();
      expect(retainedBuffer.every((byte) => byte === 0)).toBe(true);
    } finally {
      for (const item of checks) item.reconstructed.dispose();
    }
  });

  test('wrong master, incomplete roster and stale controller never sign', async () => {
    const options = input();
    const failures: RecoveryCheckInput[] = [
      { ...options, secrets: [{ seat: 0, master: scalarToBytes(18n) }] },
      { ...options, secrets: [] },
      { ...options, signingKey: data.replacement.secretKey },
    ];
    const results = await Promise.all(failures.map(produceRecoveryCheck));
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(options.store.records.size).toBe(0);
  });

  test('refuses a changed durable parent after storing and disposes reconstruction', async () => {
    const options = input();
    let reads = 0;
    const journal = journalWithLoad(options.journal, async () => {
      const record = await options.journal.load();
      reads++;
      return reads === 2 && record ? { ...record, height: record.height + 1 } : record;
    });
    expect(await produceRecoveryCheck({ ...options, journal })).toMatchObject({
      ok: false,
      error: { code: 'recovery-check-stale' },
    });
    expect(options.store.records.size).toBe(2);
  });

  test('corrupt or incomplete certified history never yields a signature', async () => {
    const options = input();
    const corrupt = journalWithLoad(options.journal, async () => {
      const record = required(await options.journal.load());
      return {
        ...record,
        entries: record.entries.map((certified, index) =>
          index === 0 ? { ...certified, certificate: [] } : certified,
        ),
      };
    });
    expect((await produceRecoveryCheck({ ...options, journal: corrupt })).ok).toBe(false);
    expect(options.store.records.size).toBe(0);
    const incomplete = journalWithLoad(options.journal, async () => {
      const record = required(await options.journal.load());
      return { ...record, entries: [], height: 1 };
    });
    expect(await produceRecoveryCheck({ ...options, journal: incomplete })).toMatchObject({
      ok: false,
      error: { code: 'recovery-check-pending' },
    });
    expect(options.store.records.size).toBe(0);
  });

  test('refuses a different immutable check at the same parent', async () => {
    const options = input();
    const first = value(await produceRecoveryCheck(options));
    first.reconstructed.dispose();
    const key = required(
      [...options.store.records.keys()].find((id) => id.startsWith('recovery-check/')),
    );
    options.store.records.set(key, new Uint8Array([1, 2, 3]));
    expect(await produceRecoveryCheck(options)).toMatchObject({
      ok: false,
      error: { code: 'recovery-check-conflict' },
    });
  });

  test('private persistence failure prevents publishing an activation check', async () => {
    const options = input();
    const writes: string[] = [];
    const store: RecoveryCheckStore = {
      load: (id) => options.store.load(id),
      async putIfAbsent(id, bytes) {
        writes.push(id);
        if (id.startsWith('recovery-private/')) throw new Error('disk unavailable');
        return options.store.putIfAbsent(id, bytes);
      },
    };
    expect(await produceRecoveryCheck({ ...options, store })).toMatchObject({
      ok: false,
      error: { code: 'recovery-private-storage' },
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^recovery-private\//);
    expect(options.store.records.size).toBe(0);
  });

  test('recovered secret reads reject corrupt records and uncertified recipients', async () => {
    const options = input();
    const produced = value(await produceRecoveryCheck(options));
    const context = produced.reconstructed.context.log;
    const authorization = produced.signed.statement.authorization;
    produced.reconstructed.dispose();
    expect((await loadRecoveryPrivate(context, authorization, 0, options.store)).ok).toBe(false);
    const key = required(
      [...options.store.records.keys()].find((id) => id.startsWith('recovery-private/')),
    );
    options.store.records.set(key, new Uint8Array([1]));
    expect((await loadRecoveryPrivate(context, authorization, 1, options.store)).ok).toBe(false);
    expect(await produceRecoveryCheck(options)).toMatchObject({
      ok: false,
      error: { code: 'recovery-private-conflict' },
    });
  });
});
