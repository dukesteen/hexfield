import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Engine, Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { resolveArtifactSigner } from './authority.js';
import { validateGenesisEscrow } from './genesis-escrow.js';
import { entryHash, genesisDigest } from './genesis.js';
import type { JournalRecord, ProtocolJournal } from './journal.js';
import type { LogContext } from './log-types.js';
import { produceRecoveryCheckFromShares } from './recovery-check.js';
import type { RecoveryCheckStore, SignedRecoveryCheck } from './recovery-check.js';
import { RecoveryInbox, signedRecoveryCheckSchema } from './recovery-inbox.js';
import { loadRecoveryPrivate } from './recovery-private.js';
import { prepareRecoveryRelease, recoveryReleaseSchema } from './recovery-release.js';
import type { RecoveryRelease } from './recovery-release.js';
import type { RecoveryActivation } from './recovery-types.js';
import { replayCertifiedPrefix } from './replay.js';
import type { ReplayPolicy } from './replay.js';
import { MAX_MESSAGE_BYTES } from './validation.js';

export interface RecoveryParticipantOptions {
  readonly journal: ProtocolJournal;
  readonly engine: Engine;
  readonly policy: ReplayPolicy;
  readonly localSeat: Seat;
  readonly signingKey: Uint8Array;
  readonly encryptionSecret: () => bigint;
  /** Return a fresh owned buffer. The participant copies it, then wipes the supplied bytes. */
  readonly privateEntropy: () => Uint8Array;
  readonly store: RecoveryCheckStore;
}

export interface PreparedRecoveryPackets {
  readonly releases: readonly RecoveryRelease[];
  readonly check: SignedRecoveryCheck | null;
}

interface Scope {
  readonly gameId: string;
  readonly digest: string;
  readonly authorization: { seq: number; hash: string };
  readonly authorizationHash: string;
  readonly authorityHash: string;
  readonly epoch: number;
  readonly parent: { seq: number; hash: string };
  readonly affected: readonly Seat[];
  readonly recoverers: readonly Seat[];
}

function copyRelease(release: RecoveryRelease): RecoveryRelease {
  return v.parse(recoveryReleaseSchema, canonicalDecode(canonicalEncode(release)));
}

function copyCheck(check: SignedRecoveryCheck): SignedRecoveryCheck {
  return v.parse(signedRecoveryCheckSchema, canonicalDecode(canonicalEncode(check)));
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

/**
 * The caller must invoke every method inside its serialized replica work and
 * browser writer lease, including the outbound send that follows prepare().
 * This object retains only public ciphertext and signatures in memory.
 */
export class RecoveryParticipant {
  private readonly journal: ProtocolJournal;
  private readonly engine: Engine;
  private readonly policy: ReplayPolicy;
  private readonly localSeat: Seat;
  private readonly signingKey: Uint8Array;
  private readonly encryptionSecret: () => bigint;
  private readonly privateEntropy: () => Uint8Array;
  private readonly store: RecoveryCheckStore;
  private readonly inbox = new RecoveryInbox();
  private scope: string | null = null;
  private checkScope: string | null = null;
  private verifiedHead: string | null = null;
  private verifiedContext: string | null = null;
  private genesisEntryHash: string | null = null;
  private readonly releases = new Map<string, RecoveryRelease>();
  private check: SignedRecoveryCheck | null = null;
  private disposed = false;

  constructor(options: RecoveryParticipantOptions) {
    this.journal = options.journal;
    this.engine = options.engine;
    this.policy = options.policy;
    this.localSeat = options.localSeat;
    this.signingKey = options.signingKey.slice();
    this.encryptionSecret = options.encryptionSecret;
    this.privateEntropy = options.privateEntropy;
    this.store = options.store;
  }

  rememberRelease(context: LogContext, value: unknown): Result<boolean> {
    if (this.disposed) return failure('recovery-participant-disposed', 'Participant is disposed');
    const refreshed = this.inbox.refresh(context);
    return refreshed.ok ? this.inbox.rememberRelease(value) : refreshed;
  }

  rememberCheck(context: LogContext, value: unknown): Result<boolean> {
    if (this.disposed) return failure('recovery-participant-disposed', 'Participant is disposed');
    const refreshed = this.inbox.refresh(context);
    return refreshed.ok ? this.inbox.rememberCheck(value) : refreshed;
  }

  candidate(context: LogContext): Result<RecoveryActivation | null> {
    if (this.disposed) return failure('recovery-participant-disposed', 'Participant is disposed');
    return this.inbox.candidate(context);
  }

  async prepare(context: LogContext): Promise<Result<PreparedRecoveryPackets>> {
    if (this.disposed) return failure('recovery-participant-disposed', 'Participant is disposed');
    const refreshed = this.inbox.refresh(context);
    if (!refreshed.ok) return refreshed;
    const scoped = this.currentScope(context);
    if (!scoped.ok) return scoped;
    const scope = scoped.value;
    if (scope === null) {
      this.clear();
      return success({ releases: [], check: null });
    }
    const releaseScope = `${scope.digest}/${scope.authorization.seq}/${scope.authorization.hash}/${scope.epoch}`;
    const parentScope = `${releaseScope}/${scope.parent.seq}/${scope.parent.hash}`;
    if (this.scope !== releaseScope) {
      this.releases.clear();
      this.scope = releaseScope;
    }
    if (this.checkScope !== parentScope) {
      this.check = null;
      this.checkScope = parentScope;
    }

    const escrow = validateGenesisEscrow(context.genesis);
    if (!escrow.ok) return escrow;
    const dealers = escrow.value.filter(({ dealerSeat }) => scope.affected.includes(dealerSeat));
    if (dealers.length !== scope.affected.length)
      return failure('recovery-participant-escrow', 'Affected original escrow is incomplete');
    const initial = await this.currentJournal(scope, true);
    if (this.disposed) return failure('recovery-participant-disposed', 'Participant is disposed');
    if (!initial.ok) return initial;

    for (const dealer of dealers) {
      if (!dealer.shares.some(({ envelope }) => envelope.body.holder.seat === this.localSeat))
        continue;
      for (const recipientSeat of scope.recoverers) {
        const slot = `${dealer.dealerSeat}/${this.localSeat}/${recipientSeat}`;
        let release = this.releases.get(slot);
        if (!release) {
          const entropy = this.privateEntropy();
          if (!(entropy instanceof Uint8Array) || entropy.length !== 32)
            return failure(
              'recovery-participant-entropy',
              'Private release entropy must be 32 bytes',
            );
          const copiedEntropy = entropy.slice();
          entropy.fill(0);
          const key = this.signingKey.slice();
          try {
            // Each immutable write is followed by its own certified-head check.
            // oxlint-disable-next-line eslint/no-await-in-loop
            const prepared = await prepareRecoveryRelease({
              journal: this.journal,
              engine: this.engine,
              policy: this.policy,
              genesisDigest: scope.digest,
              dealerSeat: dealer.dealerSeat,
              holderSeat: this.localSeat,
              recipientSeat,
              holderEncryptionSecret: this.encryptionSecret(),
              holderSigningKey: key,
              entropy: copiedEntropy,
              store: this.store,
            });
            if (this.disposed)
              return failure('recovery-participant-disposed', 'Participant is disposed');
            if (!prepared.ok) return prepared;
            release = copyRelease(prepared.value);
            this.releases.set(slot, release);
          } finally {
            key.fill(0);
            copiedEntropy.fill(0);
          }
        }
        if (recipientSeat === this.localSeat) {
          const remembered = this.inbox.rememberRelease(release);
          if (!remembered.ok) return remembered;
        }
      }
    }

    if (!this.check) {
      const key = `recovery-check/${scope.gameId}/${scope.authorization.seq}-${scope.authorization.hash}/${scope.parent.seq}-${scope.parent.hash}/${this.localSeat}`;
      let stored: Uint8Array | null;
      try {
        stored = await this.store.load(key);
      } catch {
        return failure('recovery-participant-store', 'Could not read the durable recovery check');
      }
      if (this.disposed) return failure('recovery-participant-disposed', 'Participant is disposed');
      if (stored) {
        if (stored.byteLength > MAX_MESSAGE_BYTES)
          return failure('recovery-participant-store', 'Durable recovery check exceeds its limit');
        try {
          const signed = v.parse(signedRecoveryCheckSchema, canonicalDecode(stored));
          const remembered = this.inbox.rememberCheck(signed);
          if (!remembered.ok) return remembered;
          const retained = await this.verifyStoredPrivate(scope);
          if (this.disposed)
            return failure('recovery-participant-disposed', 'Participant is disposed');
          if (!retained.ok) return retained;
          this.check = copyCheck(signed);
        } catch {
          return failure('recovery-participant-store', 'Durable recovery check is malformed');
        }
      } else {
        const localReleases = this.inbox.listReleases(this.localSeat);
        const complete = dealers.every((dealer) =>
          dealer.shares.every(({ envelope }) =>
            localReleases.some(
              ({ body }) =>
                body.dealerSeat === dealer.dealerSeat &&
                body.holderSeat === envelope.body.holder.seat,
            ),
          ),
        );
        if (complete) {
          const checkSigningKey = this.signingKey.slice();
          try {
            const produced = await produceRecoveryCheckFromShares({
              journal: this.journal,
              engine: this.engine,
              policy: this.policy,
              store: this.store,
              localSeat: this.localSeat,
              signingKey: checkSigningKey,
              recipientEncryptionSecret: this.encryptionSecret(),
              releases: localReleases,
            });
            if (this.disposed) {
              if (produced.ok) produced.value.reconstructed.dispose();
              return failure('recovery-participant-disposed', 'Participant is disposed');
            }
            if (!produced.ok) return produced;
            try {
              const remembered = this.inbox.rememberCheck(produced.value.signed);
              if (!remembered.ok) return remembered;
              this.check = copyCheck(produced.value.signed);
            } finally {
              produced.value.reconstructed.dispose();
            }
          } finally {
            checkSigningKey.fill(0);
          }
        }
      }
    }

    const latest = await this.currentJournal(scope, false);
    if (this.disposed) return failure('recovery-participant-disposed', 'Participant is disposed');
    if (!latest.ok || latest.value !== initial.value)
      return failure(
        'recovery-participant-stale',
        'Certified parent advanced before packets could be sent',
      );
    return success({
      releases: [...this.releases.values()].map(copyRelease),
      check: this.check ? copyCheck(this.check) : null,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.signingKey.fill(0);
    this.clear();
  }

  private async verifyStoredPrivate(scope: Scope): Promise<Result<void>> {
    try {
      const record = await this.journal.load();
      const head = record && journalHead(record);
      if (!record || !head || !sameRef(head, scope.parent))
        return failure('recovery-participant-stale', 'Journal differs from the certified parent');
      const replayed = replayCertifiedPrefix(
        record.genesis,
        record.entries,
        this.engine,
        this.policy,
      );
      if (!replayed.ok) return replayed;
      const restored = await loadRecoveryPrivate(
        replayed.value.context.log,
        scope.authorization,
        this.localSeat,
        this.store,
      );
      if (!restored.ok) return restored;
      restored.value.dispose();
      return success(undefined);
    } catch {
      return failure('recovery-participant-private', 'Could not verify durable recovery secrets');
    }
  }

  private currentScope(context: LogContext): Result<Scope | null> {
    const pending = context.recovery?.pending;
    if (!pending) return success(null);
    const authorization = context.recovery?.authorizations.at(-1);
    if (
      !authorization ||
      !sameRef(authorization.entry, pending) ||
      !context.authority ||
      !context.crypto
    )
      return failure('recovery-participant-context', 'Current recovery authorization is missing');
    const signer = resolveArtifactSigner(
      context.authority,
      context.genesis,
      context.crypto.epoch,
      this.localSeat,
    );
    const local = authorization.statement.recoverers.find(({ seat }) => seat === this.localSeat);
    if (!signer.ok || !local || signer.value.publicKey !== local.publicKey)
      return failure('recovery-participant-seat', 'Local signing seat is not an active recoverer');
    if (this.signingKey.length !== 32)
      return failure('recovery-participant-key', 'Current controller signing key is missing');
    try {
      const identity = identityFromSecret(this.signingKey);
      const matches = identity.peerId === local.publicKey;
      identity.secretKey.fill(0);
      if (!matches)
        return failure('recovery-participant-key', 'Signing key is not the current controller');
    } catch {
      return failure('recovery-participant-key', 'Current controller signing key is invalid');
    }
    return success({
      gameId: context.genesis.gameId,
      digest: genesisDigest(context.genesis),
      authorization: { ...authorization.entry },
      authorizationHash: toHex(hashValue(authorization.statement)),
      authorityHash: toHex(hashValue(context.authority)),
      epoch: context.crypto.epoch,
      parent: { seq: context.head.seq, hash: entryHash(context.head) },
      affected: authorization.statement.replacements.map(({ seat }) => seat),
      recoverers: authorization.statement.recoverers.map(({ seat }) => seat),
    });
  }

  private async currentJournal(scope: Scope, verify: boolean): Promise<Result<string>> {
    try {
      const record = await this.journal.load();
      const head = record && journalHead(record);
      if (
        !record ||
        !head ||
        !sameRef(head, scope.parent) ||
        record.genesis.payload.kind !== 'genesis' ||
        genesisDigest(record.genesis.payload.genesis) !== scope.digest ||
        (this.genesisEntryHash !== null && entryHash(record.genesis) !== this.genesisEntryHash)
      )
        return failure('recovery-participant-stale', 'Journal differs from the certified parent');
      const genesisHash = entryHash(record.genesis);
      const fingerprint = `${genesisHash}/${head.seq}/${head.hash}`;
      const contextFingerprint = `${scope.authorizationHash}/${scope.authorityHash}/${scope.epoch}`;
      if (
        verify &&
        (this.verifiedHead !== fingerprint || this.verifiedContext !== contextFingerprint)
      ) {
        const replayed = replayCertifiedPrefix(
          record.genesis,
          record.entries,
          this.engine,
          this.policy,
        );
        const replayLog = replayed.ok ? replayed.value.context.log : null;
        const authorization = replayLog?.recovery?.authorizations.at(-1);
        if (
          !replayed.ok ||
          !replayLog ||
          !sameRef({ seq: replayLog.head.seq, hash: entryHash(replayLog.head) }, scope.parent) ||
          !sameRef(replayLog.recovery?.pending ?? { seq: -1, hash: '' }, scope.authorization) ||
          !authorization ||
          toHex(hashValue(authorization.statement)) !== scope.authorizationHash ||
          !replayLog.authority ||
          toHex(hashValue(replayLog.authority)) !== scope.authorityHash ||
          replayLog.crypto?.epoch !== scope.epoch
        )
          return failure('recovery-participant-history', 'Certified journal replay failed');
        this.verifiedHead = fingerprint;
        this.verifiedContext = contextFingerprint;
        this.genesisEntryHash = genesisHash;
      }
      return success(fingerprint);
    } catch {
      return failure(
        'recovery-participant-journal',
        'Could not read the durable certified journal',
      );
    }
  }

  private clear(): void {
    this.scope = null;
    this.checkScope = null;
    this.releases.clear();
    this.check = null;
  }
}
