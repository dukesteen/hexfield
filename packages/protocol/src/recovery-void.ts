import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { identityFromSecret, signObject } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Engine, Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { entryHash, genesisDigest } from './genesis.js';
import { verifyRevealedMaster } from './genesis-secrets.js';
import type { JournalRecord, ProtocolJournal } from './journal.js';
import { reconstructPrivateSeats } from './private-replay.js';
import { RECOVERY_VOID_DOMAIN, recoveryVoidStatementSchema } from './recovery-membership.js';
import type { RecoveryVoidReason, RecoveryVoidStatement } from './recovery-types.js';
import { recoverAuthorizedMaster, recoveryReleaseSchema } from './recovery-release.js';
import type { RecoveryCheckStore } from './recovery-check.js';
import { replayCertifiedPrefix } from './replay.js';
import type { ReplayPolicy } from './replay.js';
import { seatSchema, signature64Schema } from './schema-values.js';
import type { SeatSignature } from './types.js';
import { MAX_MESSAGE_BYTES } from './validation.js';

function isVoidReason(code: string): code is RecoveryVoidReason {
  return (
    code === 'master-encryption-key' ||
    code === 'master-beacon-tip' ||
    code === 'master-shuffle-key' ||
    code === 'master-lock-key'
  );
}

export interface SignedRecoveryVoidCheck {
  readonly statement: RecoveryVoidStatement;
  readonly check: SeatSignature;
}

export const signedRecoveryVoidCheckSchema = v.strictObject({
  statement: recoveryVoidStatementSchema,
  check: v.strictObject({ seat: seatSchema, sig: signature64Schema }),
});

export interface RecoveryVoidCheckInput {
  readonly journal: ProtocolJournal;
  readonly engine: Engine;
  readonly policy: ReplayPolicy;
  readonly store: RecoveryCheckStore;
  readonly localSeat: Seat;
  readonly signingKey: Uint8Array;
  readonly recipientEncryptionSecret: bigint;
  readonly releases: readonly unknown[];
}

function sameRef(
  left: { seq: number; hash: string },
  right: { seq: number; hash: string },
): boolean {
  return left.seq === right.seq && left.hash === right.hash;
}

function journalHead(record: JournalRecord): { seq: number; hash: string } | null {
  const head = record.entries.at(-1)?.entry ?? record.genesis;
  return record.genesis.seq === 0 &&
    record.entries.length === head.seq &&
    record.height === head.seq + 1 &&
    record.safety &&
    Number.isSafeInteger(record.safety.revision) &&
    record.safety.revision >= 0 &&
    record.safety.bytes instanceof Uint8Array
    ? { seq: head.seq, hash: entryHash(head) }
    : null;
}

/** Every authorized recoverer independently checks all shares before attesting to a mismatch. */
export async function produceRecoveryVoidCheckFromShares(
  input: RecoveryVoidCheckInput,
): Promise<Result<SignedRecoveryVoidCheck>> {
  const { journal, engine, policy, store, localSeat, recipientEncryptionSecret } = input;
  const secrets: { seat: Seat; master: Uint8Array }[] = [];
  let signingKey: Uint8Array | undefined;
  try {
    if (!Array.isArray(input.releases) || input.releases.length < 1 || input.releases.length > 30)
      return failure('recovery-void-shares', 'Void needs a bounded set of authorized shares');
    const releases = input.releases.map((release) =>
      v.parse(recoveryReleaseSchema, canonicalDecode(canonicalEncode(release))),
    );
    signingKey = new Uint8Array(input.signingKey);
    const record = await journal.load();
    const parent = record && journalHead(record);
    if (!record || !parent)
      return failure('recovery-void-journal', 'Certified journal or safety height is missing');
    const replayed = replayCertifiedPrefix(record.genesis, record.entries, engine, policy);
    if (!replayed.ok) return replayed;
    const context = replayed.value.context.log;
    const pending = context.recovery?.pending;
    const authorization = context.recovery?.authorizations.at(-1);
    if (
      !pending ||
      !authorization ||
      !sameRef(pending, authorization.entry) ||
      !context.authority ||
      !context.crypto ||
      context.recovery?.void
    )
      return failure('recovery-void-pending', 'Latest certified authorization is unavailable');
    const recoverers = context.authority.controllers
      .filter((item) => item.kind === 'human' && item.status === 'active')
      .map(({ seat, publicKey }) => ({ seat, publicKey }));
    const local = recoverers.find(({ seat }) => seat === localSeat);
    if (
      !local ||
      recoverers.length !== authorization.statement.recoverers.length ||
      recoverers.some((item, index) => {
        const expected = authorization.statement.recoverers[index];
        return item.seat !== expected?.seat || item.publicKey !== expected.publicKey;
      }) ||
      context.authority.epoch !== context.crypto.epoch
    )
      return failure('recovery-void-recoverer', 'Local controller is not an exact recoverer');
    const identity = identityFromSecret(signingKey);
    try {
      if (identity.peerId !== local.publicKey)
        return failure('recovery-void-key', 'Signing key is not the current recoverer');
    } finally {
      identity.secretKey.fill(0);
    }
    const affected = authorization.statement.replacements.map(({ seat }) => seat);
    if (releases.some(({ body }) => !affected.includes(body.dealerSeat)))
      return failure('recovery-void-shares', 'Release belongs to an unaffected dealer');
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
    const rebuilt = reconstructPrivateSeats({
      genesisEntry: record.genesis,
      entries: record.entries,
      engine,
      policy,
      secrets,
    });
    if (rebuilt.ok) {
      rebuilt.value.dispose();
      return failure('recovery-void-unproven', 'Private reconstruction did not find a mismatch');
    }
    if (!isVoidReason(rebuilt.error.code))
      return failure('recovery-void-unproven', 'Private reconstruction failed for another reason');
    let dealerSeat: Seat | null = null;
    for (const { seat, master } of secrets) {
      const checked = verifyRevealedMaster(context.genesis, context.crypto.decks, seat, master, {
        allowIncompleteSetup: true,
      });
      if (!checked.ok) {
        if (!isVoidReason(checked.error.code))
          return failure('recovery-void-unproven', 'Master verification failed for another reason');
        if (dealerSeat === null && checked.error.code === rebuilt.error.code) dealerSeat = seat;
      }
    }
    if (dealerSeat === null)
      return failure('recovery-void-unproven', 'No affected dealer has a derived-key mismatch');
    const statement: RecoveryVoidStatement = {
      genesisDigest: genesisDigest(context.genesis),
      parent,
      authorization: pending,
      dealerSeat,
      reason: rebuilt.error.code,
    };
    const signed: SignedRecoveryVoidCheck = {
      statement,
      check: { seat: localSeat, sig: signObject(RECOVERY_VOID_DOMAIN, statement, signingKey) },
    };
    const bytes = canonicalEncode(signed);
    // Activation and void share one immutable slot: concurrent callers cannot
    // sign contradictory outcomes for the same certified parent.
    const slot = `recovery-check/${context.genesis.gameId}/${pending.seq}-${pending.hash}/${parent.seq}-${parent.hash}/${localSeat}`;
    if (!(await store.putIfAbsent(slot, bytes))) {
      const previous = await store.load(slot);
      if (
        !previous ||
        previous.byteLength > MAX_MESSAGE_BYTES ||
        previous.byteLength !== bytes.byteLength ||
        !bytes.every((byte, index) => byte === previous[index])
      )
        return failure('recovery-void-conflict', 'A different check occupies this immutable slot');
    }
    const latest = await journal.load();
    const latestParent = latest && journalHead(latest);
    if (
      !latest ||
      !latestParent ||
      !sameRef(parent, latestParent) ||
      latest.height !== record.height ||
      entryHash(latest.genesis) !== entryHash(record.genesis)
    )
      return failure('recovery-void-stale', 'Certified head advanced during void verification');
    return success(signed);
  } catch {
    return failure('recovery-void-unavailable', 'Could not verify or persist the void check');
  } finally {
    signingKey?.fill(0);
    for (const { master } of secrets) master.fill(0);
  }
}
