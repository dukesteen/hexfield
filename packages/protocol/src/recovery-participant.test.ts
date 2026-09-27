import { canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { scalarToBytes } from '@cp2p/crypto';
import type { Result, Seat } from '@cp2p/engine';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { MemoryGenesisConsentStore } from './genesis-outbox.js';
import { MemoryProtocolJournal } from './journal.js';
import type { ProtocolJournal } from './journal.js';
import type { RecoveryCheckStore } from './recovery-check.js';
import { validateCertifiedEntry } from './proposal.js';
import type { CertifiedEntry, ProposalContext } from './proposal.js';
import { RecoveryParticipant } from './recovery-participant.js';
import type { RecoveryParticipantOptions } from './recovery-participant.js';
import { createStealSecretSource } from './steal-source.js';
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
import type { RecoveryFixture } from './testing/recovery-fixture.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing participant fixture');
  return item;
}

function encryptionSecret(fixture: RecoveryFixture, seat: Seat): bigint {
  const original = required(fixture.genesis.seats.find((item) => item.seat === seat));
  const source = createStealSecretSource(
    scalarToBytes(BigInt(17 + seat)),
    fixture.genesis.ceremonyNonce,
    seat,
    original.publicKey,
  );
  try {
    return source.encryptionSecret();
  } finally {
    source.dispose();
  }
}

describe('recovery participant', () => {
  let fixture: RecoveryFixture;
  let authorization: CertifiedEntry;
  let authorized: ProposalContext;

  beforeAll(() => {
    fixture = createRecoveryFixture({ masterBackedBeacon: true, chainLength: 1 });
    const replacement = recoveryFixtureReplacement(93);
    const change = signRecoveryFixtureAuthorization(
      fixture,
      recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId),
      replacement.secretKey,
    );
    const entry = signRecoveryFixtureEntry(
      fixture,
      fixture.ready,
      { kind: 'membership', change },
      fixture.ready.log.head.stateHash,
    );
    authorization = certifyRecoveryFixtureEntry(fixture, fixture.ready, entry, [1, 2, 3]);
    authorized = advanceRecoveryFixture(fixture.ready, authorization);
    replacement.secretKey.fill(0);
  }, 30_000);

  async function journal(): Promise<MemoryProtocolJournal> {
    const result = new MemoryProtocolJournal();
    expect(await result.initialize(fixture.genesisEntry, new Uint8Array([1]))).toBe(true);
    for (const certified of [...fixture.deckEntries, authorization]) {
      // A certified entry must follow its durable parent.
      // oxlint-disable-next-line eslint/no-await-in-loop
      expect(await result.commit(certified.entry.seq, 0, certified, new Uint8Array([1]))).toBe(
        true,
      );
    }
    return result;
  }

  function options(
    localJournal: ProtocolJournal,
    seat: Seat,
    store: RecoveryCheckStore = new MemoryGenesisConsentStore(),
  ): RecoveryParticipantOptions {
    return {
      journal: localJournal,
      engine: fixture.source.engine,
      policy: fixture.policy,
      localSeat: seat,
      signingKey: recoveryFixtureKey(fixture, seat).slice(),
      encryptionSecret: () => encryptionSecret(fixture, seat),
      privateEntropy: () => new Uint8Array(32).fill(80 + seat),
      store,
    };
  }

  test('withholds checks until all original shares arrive, then forms a certified activation', async () => {
    const localJournal = await journal();
    const seats = [1, 2, 3] as const;
    const stores = seats.map(() => new MemoryGenesisConsentStore());
    const participants = seats.map(
      (seat, index) =>
        new RecoveryParticipant(options(localJournal, seat, required(stores[index]))),
    );
    try {
      const first = await Promise.all(participants.map((item) => item.prepare(authorized.log)));
      const packets = first.map(value);
      expect(packets.map(({ releases, check }) => [releases.length, check])).toEqual([
        [3, null],
        [3, null],
        [3, null],
      ]);
      expect(value(required(participants[0]).candidate(authorized.log))).toBeNull();

      const forSeatOne = packets.flatMap(({ releases }) =>
        releases.filter(({ body }) => body.recipientSeat === 1 && body.holderSeat !== 1),
      );
      value(required(participants[0]).rememberRelease(authorized.log, required(forSeatOne[0])));
      expect(value(await required(participants[0]).prepare(authorized.log)).check).toBeNull();
      value(required(participants[0]).rememberRelease(authorized.log, required(forSeatOne[1])));
      for (const [index, seat] of seats.entries()) {
        for (const packet of packets) {
          for (const release of packet.releases) {
            if (release.body.recipientSeat !== seat) continue;
            // Retransmission of the first share is idempotent.
            value(required(participants[index]).rememberRelease(authorized.log, release));
          }
        }
      }

      const ready = (
        await Promise.all(participants.map((item) => item.prepare(authorized.log)))
      ).map(value);
      const signed = ready.map(({ check }) => required(check));
      expect(signed.map(({ check }) => check.seat)).toEqual(seats);
      for (const participant of participants)
        for (const check of signed) value(participant.rememberCheck(authorized.log, check));
      const candidate = required(value(required(participants[0]).candidate(authorized.log)));
      expect(candidate.checks.map(({ seat }) => seat)).toEqual(seats);

      const takeover = value(
        fixture.source.engine.apply(authorized.log.state, {
          kind: 'system',
          type: 'SEAT_STATUS',
          seat: 0,
          status: 'bot',
        }),
      );
      const entry = signRecoveryFixtureEntry(
        fixture,
        authorized,
        { kind: 'membership', change: candidate },
        toHex(hashValue(takeover.state)),
      );
      const certified = certifyRecoveryFixtureEntry(fixture, authorized, entry, seats);
      expect(validateCertifiedEntry(certified, authorized).ok).toBe(true);

      const restarted = new RecoveryParticipant(options(localJournal, 1, required(stores[0])));
      try {
        const replayed = value(await restarted.prepare(authorized.log));
        expect(canonicalEncode(replayed)).toEqual(canonicalEncode(required(ready[0])));
        Object.assign(required(replayed.releases[0]).body, { dealerSeat: 5 });
        Object.assign(required(replayed.check).statement, { checkDigest: 'a'.repeat(64) });
        expect(canonicalEncode(value(await restarted.prepare(authorized.log)))).toEqual(
          canonicalEncode(required(ready[0])),
        );
      } finally {
        restarted.dispose();
      }
      for (const privateBytes of [null, new Uint8Array([1])]) {
        const backing = required(stores[0]);
        const brokenStore: RecoveryCheckStore = {
          load: (id) =>
            id.startsWith('recovery-private/') ? Promise.resolve(privateBytes) : backing.load(id),
          putIfAbsent: (id, bytes) => backing.putIfAbsent(id, bytes),
        };
        const broken = new RecoveryParticipant(options(localJournal, 1, brokenStore));
        try {
          // Each restart has its own participant and private-record failure.
          // oxlint-disable-next-line eslint/no-await-in-loop
          expect(await broken.prepare(authorized.log)).toMatchObject({
            ok: false,
            error: { code: 'recovery-private-storage' },
          });
        } finally {
          broken.dispose();
        }
      }
    } finally {
      for (const participant of participants) participant.dispose();
    }
  }, 30_000);

  test('copies caller keys and context before awaiting the journal', async () => {
    const base = await journal();
    const callerContext = {
      ...authorized.log,
      genesis: { ...authorized.log.genesis },
      recovery: { ...required(authorized.log.recovery) },
    };
    let changed = false;
    const localJournal: ProtocolJournal = {
      async load() {
        if (!changed) {
          changed = true;
          callerContext.genesis.gameId = 'mutated-after-call';
          callerContext.recovery = { ...callerContext.recovery, pending: null };
        }
        return base.load();
      },
      initialize: (genesis, safety) => base.initialize(genesis, safety),
      loadSafety: (height) => base.loadSafety(height),
      saveSafety: (height, revision, bytes) => base.saveSafety(height, revision, bytes),
      commit: (height, revision, certified, bytes) =>
        base.commit(height, revision, certified, bytes),
    };
    const entropyBuffers: Uint8Array[] = [];
    const input = {
      ...options(localJournal, 1),
      privateEntropy: () => {
        const buffer = new Uint8Array(32).fill(91);
        entropyBuffers.push(buffer);
        return buffer;
      },
    };
    const participant = new RecoveryParticipant(input);
    input.signingKey.fill(0);
    try {
      const prepared = value(await participant.prepare(callerContext));
      expect(prepared.releases).toHaveLength(3);
      expect(prepared.check).toBeNull();
      expect(entropyBuffers).toHaveLength(3);
      expect(entropyBuffers.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
    } finally {
      participant.dispose();
    }
  }, 20_000);

  test('rejects an authorization statement that differs from certified replay at the same head', async () => {
    const localJournal = await journal();
    const stored = new MemoryGenesisConsentStore();
    const write = vi.spyOn(stored, 'putIfAbsent');
    const original = required(authorized.log.recovery?.authorizations.at(-1));
    const altered = {
      ...authorized.log,
      recovery: {
        ...required(authorized.log.recovery),
        authorizations: [
          {
            ...original,
            statement: { ...original.statement, botLevel: 'hard' as const },
          },
        ],
      },
    };
    const participant = new RecoveryParticipant(options(localJournal, 1, stored));
    try {
      expect(await participant.prepare(altered)).toMatchObject({
        ok: false,
        error: { code: 'recovery-participant-history' },
      });
      expect(write).not.toHaveBeenCalled();
    } finally {
      participant.dispose();
    }
  }, 20_000);

  test('suppresses all outgoing packets if the durable parent advances during preparation', async () => {
    const base = await journal();
    const replacement = recoveryFixtureReplacement(94);
    const change = signRecoveryFixtureAuthorization(
      fixture,
      recoveryFixtureReadiness(
        fixture,
        authorized,
        replacement.peerId,
        authorized.log.recovery?.pending ?? null,
      ),
      replacement.secretKey,
    );
    const entry = signRecoveryFixtureEntry(
      fixture,
      authorized,
      { kind: 'membership', change },
      authorized.log.head.stateHash,
    );
    const amendment = certifyRecoveryFixtureEntry(fixture, authorized, entry, [1, 2, 3]);
    replacement.secretKey.fill(0);
    const backing = new MemoryGenesisConsentStore();
    let advanced = false;
    const store = {
      load: async (id: string) => {
        if (!advanced && id.startsWith('recovery-check/')) {
          advanced = true;
          if (!(await base.commit(entry.seq, 0, amendment, new Uint8Array([1]))))
            throw new Error('Could not advance the certified parent');
        }
        return backing.load(id);
      },
      putIfAbsent: (id: string, bytes: Uint8Array) => backing.putIfAbsent(id, bytes),
    };
    const participant = new RecoveryParticipant(options(base, 1, store));
    try {
      expect(await participant.prepare(authorized.log)).toMatchObject({
        ok: false,
        error: { code: 'recovery-participant-stale' },
      });
      expect(advanced).toBe(true);
    } finally {
      participant.dispose();
    }
  }, 20_000);

  test('dispose during journal I/O prevents a packet from escaping', async () => {
    const base = await journal();
    let signal: (() => void) | undefined;
    let resume: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const localJournal: ProtocolJournal = {
      async load() {
        signal?.();
        await blocked;
        return base.load();
      },
      initialize: (genesis, safety) => base.initialize(genesis, safety),
      loadSafety: (height) => base.loadSafety(height),
      saveSafety: (height, revision, bytes) => base.saveSafety(height, revision, bytes),
      commit: (height, revision, certified, bytes) =>
        base.commit(height, revision, certified, bytes),
    };
    const store = new MemoryGenesisConsentStore();
    const write = vi.spyOn(store, 'putIfAbsent');
    const participant = new RecoveryParticipant(options(localJournal, 1, store));
    const preparing = participant.prepare(authorized.log);
    await entered;
    participant.dispose();
    resume?.();
    expect(await preparing).toMatchObject({
      ok: false,
      error: { code: 'recovery-participant-disposed' },
    });
    expect(write).not.toHaveBeenCalled();
    expect(participant.rememberRelease(authorized.log, {})).toMatchObject({
      ok: false,
      error: { code: 'recovery-participant-disposed' },
    });
  }, 20_000);
});
