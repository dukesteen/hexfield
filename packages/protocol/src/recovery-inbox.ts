import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { parsePeerId, verifyObject } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { resolveArtifactSigner } from './authority.js';
import { entryHash, genesisDigest } from './genesis.js';
import type { LogContext } from './log-types.js';
import type { SignedRecoveryCheck } from './recovery-check.js';
import {
  RECOVERY_CHECK_DOMAIN,
  recoveryActivationStatementSchema,
  recoveryChangeSchema,
  recoveryCheckDigest,
} from './recovery-membership.js';
import { recoveryReleaseSchema, verifyRecoveryRelease } from './recovery-release.js';
import type { RecoveryRelease } from './recovery-release.js';
import type { RecoveryActivation, RecoveryActivationStatement } from './recovery-types.js';
import { seatSchema, signature64Schema } from './schema-values.js';
import { parseCanonical } from './validation.js';

const MAX_RELEASES = 6 * 5 * 6;
export const signedRecoveryCheckSchema = v.strictObject({
  statement: recoveryActivationStatementSchema,
  check: v.strictObject({ seat: seatSchema, sig: signature64Schema }),
});

function sameRef(
  left: { seq: number; hash: string },
  right: { seq: number; hash: string },
): boolean {
  return left.seq === right.seq && left.hash === right.hash;
}

function releaseSlot(release: RecoveryRelease): string {
  const { dealerSeat, holderSeat, recipientSeat } = release.body;
  return `${dealerSeat}/${holderSeat}/${recipientSeat}`;
}

function copyCanonical<T>(value: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Certified context fields are already validated protocol values.
  return canonicalDecode(canonicalEncode(value)) as T;
}

function detachContext(context: LogContext): LogContext {
  return {
    ...context,
    genesis: copyCanonical(context.genesis),
    head: copyCanonical(context.head),
    state: copyCanonical(context.state),
    lastNonces: new Map(context.lastNonces),
    crypto: copyCanonical(context.crypto),
    ...(context.authority ? { authority: copyCanonical(context.authority) } : {}),
    ...(context.recovery ? { recovery: copyCanonical(context.recovery) } : {}),
  };
}

/** Public ciphertext and signatures only. Every remembered item is checked at a certified parent. */
export class RecoveryInbox {
  private context: LogContext | null = null;
  private releaseScope: string | null = null;
  private checkScope: string | null = null;
  private statement: RecoveryActivationStatement | null = null;
  private recoverers: readonly { seat: Seat; publicKey: string }[] = [];
  private releases = new Map<string, RecoveryRelease>();
  private checks = new Map<Seat, SignedRecoveryCheck['check']>();

  refresh(context: LogContext): Result<void> {
    const recovery = context.recovery;
    if (!recovery?.pending) {
      this.clear();
      return success(undefined);
    }
    const authorization = recovery.authorizations.at(-1);
    const authority = context.authority;
    const crypto = context.crypto;
    if (
      context.genesis.security !== 'verified' ||
      !authorization ||
      !sameRef(recovery.pending, authorization.entry) ||
      !authority ||
      !crypto ||
      authority.epoch !== crypto.epoch ||
      authorization.statement.nextEpoch !== crypto.epoch ||
      !Number.isSafeInteger(crypto.epoch + 1)
    ) {
      this.clear();
      return failure('recovery-inbox-context', 'Certified pending recovery is inconsistent');
    }
    const recoverers = authority.controllers
      .filter((item) => item.kind === 'human' && item.status === 'active')
      .map(({ seat, publicKey }) => ({ seat, publicKey }));
    if (
      recoverers.length === 0 ||
      recoverers.length !== authorization.statement.recoverers.length ||
      recoverers.some((item, index) => {
        const expected = authorization.statement.recoverers[index];
        const signer = resolveArtifactSigner(authority, context.genesis, crypto.epoch, item.seat);
        return (
          item.seat !== expected?.seat ||
          item.publicKey !== expected.publicKey ||
          !signer.ok ||
          signer.value.publicKey !== item.publicKey
        );
      })
    ) {
      this.clear();
      return failure(
        'recovery-inbox-recoverers',
        'Current controllers differ from certified recoverers',
      );
    }

    const parent = { seq: context.head.seq, hash: entryHash(context.head) };
    const digest = genesisDigest(context.genesis);
    const statement: RecoveryActivationStatement = {
      genesisDigest: digest,
      parent,
      nextEpoch: crypto.epoch + 1,
      authorization: authorization.entry,
      checkDigest: recoveryCheckDigest(context, authorization.entry),
    };
    const releaseScope = `${digest}/${authorization.entry.seq}/${authorization.entry.hash}/${crypto.epoch}`;
    const checkScope = `${releaseScope}/${parent.seq}/${parent.hash}/${statement.checkDigest}`;
    if (releaseScope !== this.releaseScope) this.releases.clear();
    if (checkScope !== this.checkScope) this.checks.clear();
    this.context = detachContext(context);
    this.releaseScope = releaseScope;
    this.checkScope = checkScope;
    this.statement = statement;
    this.recoverers = recoverers;
    return success(undefined);
  }

  rememberRelease(value: unknown): Result<boolean> {
    if (!this.context || !this.releaseScope)
      return failure('recovery-inbox-pending', 'No certified recovery is pending');
    const verified = verifyRecoveryRelease(value, this.context);
    if (!verified.ok) return verified;
    const release = verified.value.release;
    const slot = releaseSlot(release);
    const previous = this.releases.get(slot);
    if (previous)
      return previous.sig === release.sig
        ? success(false)
        : failure(
            'recovery-inbox-conflict',
            'A different valid release already occupies this share slot',
          );
    if (this.releases.size >= MAX_RELEASES)
      return failure('recovery-inbox-full', 'Recovery release inbox is full');
    this.releases.set(
      slot,
      v.parse(recoveryReleaseSchema, canonicalDecode(canonicalEncode(release))),
    );
    return success(true);
  }

  rememberCheck(value: unknown): Result<boolean> {
    if (!this.context || !this.statement || !this.checkScope)
      return failure('recovery-inbox-pending', 'No certified activation parent is pending');
    const parsed = parseCanonical(value, signedRecoveryCheckSchema);
    if (!parsed.ok) return parsed;
    const signed = parsed.value;
    const expected = this.statement;
    const statement = signed.statement;
    if (
      statement.genesisDigest !== expected.genesisDigest ||
      !sameRef(statement.parent, expected.parent) ||
      statement.nextEpoch !== expected.nextEpoch ||
      !sameRef(statement.authorization, expected.authorization) ||
      statement.checkDigest !== expected.checkDigest
    )
      return failure(
        'recovery-inbox-binding',
        'Check differs from the current certified activation parent',
      );
    const recoverer = this.recoverers.find(({ seat }) => seat === signed.check.seat);
    if (!recoverer)
      return failure('recovery-inbox-signer', 'Check signer is not a current recoverer');
    try {
      if (
        !verifyObject(
          RECOVERY_CHECK_DOMAIN,
          statement,
          signed.check.sig,
          parsePeerId(recoverer.publicKey),
        )
      )
        return failure('recovery-inbox-signature', 'Check signature is invalid');
    } catch {
      return failure('recovery-inbox-signature', 'Check signature is malformed');
    }
    const previous = this.checks.get(signed.check.seat);
    if (previous)
      return previous.sig === signed.check.sig
        ? success(false)
        : failure(
            'recovery-inbox-conflict',
            'A different valid check already occupies this recoverer slot',
          );
    this.checks.set(signed.check.seat, { ...signed.check });
    return success(true);
  }

  candidate(context: LogContext): Result<RecoveryActivation | null> {
    const refreshed = this.refresh(context);
    if (!refreshed.ok) return refreshed;
    if (!this.statement || this.checks.size !== this.recoverers.length) return success(null);
    const checks = this.recoverers.map(({ seat }) => this.checks.get(seat));
    if (checks.some((item) => item === undefined)) return success(null);
    const candidate = {
      kind: 'recovery-activate' as const,
      statement: this.statement,
      checks: checks.filter((item) => item !== undefined),
    };
    const detached = v.parse(recoveryChangeSchema, canonicalDecode(canonicalEncode(candidate)));
    return detached.kind === 'recovery-activate'
      ? success(detached)
      : failure('recovery-inbox-candidate', 'Activation candidate is malformed');
  }

  listReleases(recipientSeat: Seat): readonly RecoveryRelease[] {
    return [...this.releases.values()]
      .filter((release) => release.body.recipientSeat === recipientSeat)
      .toSorted((a, b) => releaseSlot(a).localeCompare(releaseSlot(b)))
      .map((release) => v.parse(recoveryReleaseSchema, canonicalDecode(canonicalEncode(release))));
  }

  takeReleases(recipientSeat: Seat): readonly RecoveryRelease[] {
    const releases = this.listReleases(recipientSeat);
    for (const release of releases) this.releases.delete(releaseSlot(release));
    return releases;
  }

  private clear(): void {
    this.context = null;
    this.releaseScope = null;
    this.checkScope = null;
    this.statement = null;
    this.recoverers = [];
    this.releases.clear();
    this.checks.clear();
  }
}
