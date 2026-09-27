import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { identityFromSecret, signObject } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Engine, Result, Seat } from '@cp2p/engine';
import { entryHash, genesisDigest } from './genesis.js';
import type { JournalRecord, ProtocolJournal } from './journal.js';
import { reconstructPrivateSeats } from './private-replay.js';
import type { ReconstructedPrivateSeats } from './private-replay.js';
import { RECOVERY_CHECK_DOMAIN, recoveryCheckDigest } from './recovery-membership.js';
import { persistRecoveryPrivate } from './recovery-private.js';
import type { RecoveryPrivateStore } from './recovery-private.js';
import type { RecoveryActivationStatement } from './recovery-types.js';
import { replayCertifiedPrefix } from './replay.js';
import type { ReplayPolicy } from './replay.js';
import type { SeatSignature } from './types.js';
import { recoverAuthorizedMaster, recoveryReleaseSchema } from './recovery-release.js';
import * as v from 'valibot';

/** Stores both recovered private secrets and public checks with owned byte copies. */
export type RecoveryCheckStore = RecoveryPrivateStore;

export interface SignedRecoveryCheck {
  readonly statement: RecoveryActivationStatement;
  readonly check: SeatSignature;
}

export interface ProducedRecoveryCheck {
  readonly signed: SignedRecoveryCheck;
  /** Keep this verified private state only while its certified parent is current. */
  readonly reconstructed: ReconstructedPrivateSeats;
}

export interface RecoveryCheckInput {
  readonly journal: ProtocolJournal;
  readonly store: RecoveryCheckStore;
  readonly engine: Engine;
  readonly policy: ReplayPolicy;
  readonly localSeat: Seat;
  readonly signingKey: Uint8Array;
  readonly secrets: readonly { readonly seat: Seat; readonly master: Uint8Array }[];
}

/** Open only certified shares, then retain and verify every affected private hand before ACK. */
export async function produceRecoveryCheckFromShares(
  input: Omit<RecoveryCheckInput, 'secrets'> & {
    readonly releases: readonly unknown[];
    readonly recipientEncryptionSecret: bigint;
  },
): Promise<Result<ProducedRecoveryCheck>> {
  const { journal, engine, policy, store, localSeat, recipientEncryptionSecret } = input;
  const secrets: { seat: Seat; master: Uint8Array }[] = [];
  let signingKey: Uint8Array | undefined;
  try {
    if (!Array.isArray(input.releases) || input.releases.length < 1 || input.releases.length > 30)
      return failure('recovery-check-shares', 'Recovery requires a bounded set of original shares');
    const releases = input.releases.map((release) =>
      v.parse(recoveryReleaseSchema, canonicalDecode(canonicalEncode(release))),
    );
    signingKey = input.signingKey.slice();
    const record = await journal.load();
    if (!record || !journalParent(record))
      return failure('recovery-check-journal', 'Certified journal or safety height is missing');
    const replayed = replayCertifiedPrefix(record.genesis, record.entries, engine, policy);
    if (!replayed.ok) return replayed;
    const context = replayed.value.context.log;
    const authorization = context.recovery?.authorizations.at(-1);
    if (
      !authorization ||
      !context.recovery?.pending ||
      !sameRef(authorization.entry, context.recovery.pending)
    )
      return failure(
        'recovery-check-pending',
        'Latest certified recovery authorization is unavailable',
      );
    const affected = authorization.statement.replacements.map(({ seat }) => seat);
    if (releases.some(({ body }) => !affected.includes(body.dealerSeat)))
      return failure('recovery-check-shares', 'A release belongs to an unaffected seat');
    for (const seat of affected) {
      const recovered = recoverAuthorizedMaster(
        releases.filter(({ body }) => body.dealerSeat === seat),
        context,
        seat,
        localSeat,
        recipientEncryptionSecret,
      );
      if (!recovered.ok) return recovered;
      secrets.push({ seat, master: recovered.value });
    }
    return await produceRecoveryCheck({
      journal,
      engine,
      policy,
      store,
      localSeat,
      signingKey,
      secrets,
    });
  } catch {
    return failure('recovery-check-shares', 'Could not recover the authorized shares');
  } finally {
    signingKey?.fill(0);
    for (const { master } of secrets) master.fill(0);
  }
}

function journalParent(record: JournalRecord): { seq: number; hash: string } | null {
  const head = record.entries.at(-1)?.entry ?? record.genesis;
  if (
    record.genesis.seq !== 0 ||
    record.height !== head.seq + 1 ||
    record.entries.length !== head.seq ||
    !record.safety ||
    !Number.isSafeInteger(record.safety.revision) ||
    record.safety.revision < 0 ||
    !(record.safety.bytes instanceof Uint8Array)
  )
    return null;
  return { seq: head.seq, hash: entryHash(head) };
}

function sameRef(
  left: { seq: number; hash: string },
  right: { seq: number; hash: string },
): boolean {
  return left.seq === right.seq && left.hash === right.hash;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Signs only after certified replay and every affected master pass private reconstruction. */
export async function produceRecoveryCheck(
  input: RecoveryCheckInput,
): Promise<Result<ProducedRecoveryCheck>> {
  if (!(input.signingKey instanceof Uint8Array) || input.signingKey.length !== 32)
    return failure('recovery-check-key', 'Current controller signing key is missing');
  if (
    !Array.isArray(input.secrets) ||
    input.secrets.some(({ master }) => !(master instanceof Uint8Array) || master.length !== 32)
  )
    return failure('recovery-check-secrets', 'Affected master secrets are malformed');

  // Caller-owned buffers may change while the journal and store await I/O.
  const { journal, store, engine, policy, localSeat } = input;
  const signingKey = input.signingKey.slice();
  const secrets = input.secrets.map(({ seat, master }) => ({ seat, master: master.slice() }));
  let reconstructed: ReconstructedPrivateSeats | undefined;
  let retained = false;
  try {
    const record = await journal.load();
    const parent = record && journalParent(record);
    if (!record || !parent)
      return failure('recovery-check-journal', 'Certified journal or safety height is missing');
    const genesisHash = entryHash(record.genesis);
    const replayed = replayCertifiedPrefix(record.genesis, record.entries, engine, policy);
    if (!replayed.ok) return replayed;
    const context = replayed.value.context.log;
    if (!sameRef(parent, { seq: context.head.seq, hash: entryHash(context.head) }))
      return failure('recovery-check-journal', 'Certified replay differs from the durable journal');

    const history = context.recovery;
    const authorization = history?.authorizations.at(-1);
    const authority = context.authority;
    if (
      !history?.pending ||
      !authorization ||
      !sameRef(history.pending, authorization.entry) ||
      !authority ||
      !context.crypto ||
      authority.epoch !== context.crypto.epoch ||
      authorization.statement.nextEpoch !== authority.epoch ||
      !Number.isSafeInteger(authority.epoch + 1)
    )
      return failure(
        'recovery-check-pending',
        'Latest certified recovery authorization is unavailable',
      );

    const recoverers = authority.controllers
      .filter((item) => item.kind === 'human' && item.status === 'active')
      .map(({ seat, publicKey }) => ({ seat, publicKey }));
    const expected = authorization.statement.recoverers;
    const local = recoverers.find(({ seat }) => seat === localSeat);
    if (
      !local ||
      recoverers.length !== expected.length ||
      recoverers.some(
        (item, index) =>
          item.seat !== expected[index]?.seat || item.publicKey !== expected[index].publicKey,
      )
    )
      return failure(
        'recovery-check-recoverer',
        'Local controller is not an exact active recoverer',
      );

    const affected = authorization.statement.replacements.map(({ seat }) => seat);
    if (
      secrets.length !== affected.length ||
      new Set(secrets.map(({ seat }) => seat)).size !== affected.length ||
      secrets.some(({ seat }) => !affected.includes(seat))
    )
      return failure('recovery-check-secrets', 'Supply every affected master exactly once');

    const identity = identityFromSecret(signingKey);
    try {
      if (identity.peerId !== local.publicKey)
        return failure('recovery-check-key', 'Signing key is not the current local controller');
    } finally {
      identity.secretKey.fill(0);
    }

    const rebuilt = reconstructPrivateSeats({
      genesisEntry: record.genesis,
      entries: record.entries,
      engine,
      policy,
      secrets,
    });
    if (!rebuilt.ok) return rebuilt;
    reconstructed = rebuilt.value;
    if (
      !sameRef(parent, {
        seq: reconstructed.context.log.head.seq,
        hash: entryHash(reconstructed.context.log.head),
      })
    )
      return failure(
        'recovery-check-replay',
        'Private reconstruction used a different certified parent',
      );

    const retainedSecrets = await persistRecoveryPrivate(
      context,
      authorization.entry,
      localSeat,
      secrets.toSorted((a, b) => a.seat - b.seat),
      store,
    );
    if (!retainedSecrets.ok) return retainedSecrets;

    const statement: RecoveryActivationStatement = {
      genesisDigest: genesisDigest(context.genesis),
      parent,
      nextEpoch: authority.epoch + 1,
      authorization: authorization.entry,
      checkDigest: recoveryCheckDigest(context, authorization.entry),
    };
    const signed: SignedRecoveryCheck = {
      statement,
      check: {
        seat: localSeat,
        sig: signObject(RECOVERY_CHECK_DOMAIN, statement, signingKey),
      },
    };
    const bytes = canonicalEncode(signed);
    const key = `recovery-check/${context.genesis.gameId}/${authorization.entry.seq}-${authorization.entry.hash}/${parent.seq}-${parent.hash}/${localSeat}`;
    if (!(await store.putIfAbsent(key, bytes))) {
      const existing = await store.load(key);
      if (!existing || !sameBytes(existing, bytes))
        return failure(
          'recovery-check-conflict',
          'A different check already occupies this immutable slot',
        );
    }

    const latest = await journal.load();
    const latestParent = latest && journalParent(latest);
    if (
      !latest ||
      !latestParent ||
      !sameRef(parent, latestParent) ||
      latest.height !== record.height ||
      entryHash(latest.genesis) !== genesisHash
    )
      return failure(
        'recovery-check-stale',
        'Certified parent advanced during private verification',
      );
    retained = true;
    return success({ signed, reconstructed });
  } catch {
    return failure('recovery-check-unavailable', 'Could not verify or persist the recovery check');
  } finally {
    signingKey.fill(0);
    for (const { master } of secrets) master.fill(0);
    if (!retained) reconstructed?.dispose();
  }
}
