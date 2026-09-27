import { hashValue, toHex } from '@cp2p/codec';
import { parsePeerId, verifyObject } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { GameState, Input, Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { validateSeatAuthorities } from './authority.js';
import type { CarriedOperation, SeatAuthorities } from './authority-types.js';
import { beaconOperationId } from './beacon.js';
import { beaconExtensionOperationId } from './beacon-extension.js';
import { getBeaconExtensionOperation, getBeaconOperation } from './beacon-state.js';
import type { EntryRef } from './beacon-state.js';
import { countOperationId } from './count-reveal.js';
import type { CryptoContext } from './crypto-context.js';
import { deckDrawOperationId } from './deck-draw.js';
import { decksReady } from './deck-ledger.js';
import { deriveEscrowRosters } from './escrow-roster.js';
import { entryHash, genesisDigest } from './genesis.js';
import type { LogContext } from './log-types.js';
import { validateOfflineMarkers } from './recovery-presence.js';
import type {
  AuthorizedRecovery,
  RecoveryActivationStatement,
  RecoveryChange,
  RecoveryReadiness,
  RecoveryState,
  RecoveryVoid,
} from './recovery-types.js';
import {
  hashSchema,
  key32Schema,
  nonnegativeIntegerSchema,
  seatSchema,
  signature64Schema,
} from './schema-values.js';
import { stealOperationId } from './steal-delivery.js';
import type { LogEntry, SeatSignature } from './types.js';
import { parseCanonical } from './validation.js';
import { quorumSize } from './votes.js';

export const RECOVERY_READINESS_DOMAIN = 'recovery-readiness';
export const RECOVERY_CHECK_DOMAIN = 'recovery-check';
export const RECOVERY_VOID_DOMAIN = 'recovery-void-check';
const refSchema = v.strictObject({ seq: nonnegativeIntegerSchema, hash: hashSchema });
const membersSchema = v.pipe(
  v.array(v.strictObject({ seat: seatSchema, publicKey: key32Schema })),
  v.minLength(1),
  v.maxLength(6),
);
const signaturesSchema = v.pipe(
  v.array(v.strictObject({ seat: seatSchema, sig: signature64Schema })),
  v.minLength(1),
  v.maxLength(6),
);
export const recoveryReadinessSchema = v.strictObject({
  genesisDigest: key32Schema,
  parent: refSchema,
  nextEpoch: nonnegativeIntegerSchema,
  departedSeat: seatSchema,
  hostSeat: seatSchema,
  botLevel: v.picklist(['easy', 'medium', 'hard']),
  replacements: membersSchema,
  recoverers: membersSchema,
  previous: v.nullable(refSchema),
});
export const recoveryActivationStatementSchema = v.strictObject({
  genesisDigest: key32Schema,
  parent: refSchema,
  nextEpoch: nonnegativeIntegerSchema,
  authorization: refSchema,
  checkDigest: hashSchema,
});
export const recoveryVoidStatementSchema = v.strictObject({
  genesisDigest: key32Schema,
  parent: refSchema,
  authorization: refSchema,
  dealerSeat: seatSchema,
  reason: v.picklist([
    'master-encryption-key',
    'master-beacon-tip',
    'master-shuffle-key',
    'master-lock-key',
  ]),
});
export const recoveryChangeSchema = v.variant('kind', [
  v.strictObject({
    kind: v.literal('recovery-authorize'),
    statement: recoveryReadinessSchema,
    hostSig: signature64Schema,
    keySigs: signaturesSchema,
  }),
  v.strictObject({
    kind: v.literal('recovery-activate'),
    statement: recoveryActivationStatementSchema,
    checks: signaturesSchema,
  }),
  v.strictObject({
    kind: v.literal('recovery-void'),
    statement: recoveryVoidStatementSchema,
    checks: signaturesSchema,
  }),
]);

function same(left: unknown, right: unknown): boolean {
  return toHex(hashValue(left)) === toHex(hashValue(right));
}
function ref(entry: LogEntry): EntryRef {
  return { seq: entry.seq, hash: entryHash(entry) };
}
function signed(domain: string, statement: unknown, signature: string, key: string): boolean {
  try {
    return verifyObject(domain, statement, signature, parsePeerId(key));
  } catch {
    return false;
  }
}
function signedByAll(
  domain: string,
  statement: unknown,
  signatures: readonly SeatSignature[],
  members: readonly { seat: Seat; publicKey: string }[],
): boolean {
  return (
    signatures.length === members.length &&
    members.every((member, index) => {
      const signature = signatures[index];
      return (
        signature?.seat === member.seat &&
        signed(domain, statement, signature.sig, member.publicKey)
      );
    })
  );
}

/** Derive carry records from the certified parent, never from a membership message. */
export function carriedOperations(crypto: CryptoContext): Result<readonly CarriedOperation[]> {
  const carried: CarriedOperation[] = [];
  if (crypto.decks.active)
    carried.push({
      kind: 'deck',
      id: deckDrawOperationId(crypto.decks.active),
      epoch: crypto.decks.active.epoch,
      anchor: crypto.decks.active.anchor,
    });
  if (crypto.counts)
    carried.push({
      kind: 'count',
      id: countOperationId(crypto.counts.operation),
      epoch: crypto.counts.operation.epoch,
      anchor: crypto.counts.operation.anchor,
    });
  if (crypto.steal)
    carried.push({
      kind: 'steal',
      id: stealOperationId(crypto.steal.operation),
      epoch: crypto.steal.operation.epoch,
      anchor: crypto.steal.operation.anchor,
    });
  if (crypto.beacon.active) {
    const exhausted = crypto.beacon.active.participants.some((item) => item.index === item.length);
    const operation = exhausted
      ? getBeaconExtensionOperation(crypto.beacon)
      : getBeaconOperation(crypto.beacon);
    if (!operation.ok) return operation;
    carried.push({
      kind: 'beacon',
      id: exhausted
        ? beaconExtensionOperationId(operation.value)
        : beaconOperationId(operation.value),
      epoch: operation.value.epoch,
      anchor: operation.value.anchor,
    });
  }
  return success(carried);
}

/** A certified extension can change the ID of a carried beacon without changing its epoch. */
export function advanceCarriedOperations(
  authority: SeatAuthorities,
  crypto: CryptoContext,
): Result<SeatAuthorities> {
  if (authority.epoch !== crypto.epoch)
    return failure('recovery-epoch', 'Controller and crypto epochs must advance together');
  if (authority.carriedOperations.length === 0) return success(authority);
  const operations = carriedOperations(crypto);
  if (!operations.ok) return operations;
  const retained = operations.value.filter((operation) => operation.epoch < authority.epoch);
  return success(
    same(retained, authority.carriedOperations)
      ? authority
      : { ...authority, carriedOperations: retained },
  );
}

/** Binds private verification ACKs to exactly the public activation parent. */
export function recoveryCheckDigest(context: LogContext, authorization: EntryRef): string {
  return toHex(
    hashValue({
      domain: 'cp2p/v1/recovery-check',
      genesisDigest: genesisDigest(context.genesis),
      parent: ref(context.head),
      authorization,
      state: context.state,
      crypto: context.crypto,
      authority: context.authority ?? null,
    }),
  );
}

export interface RecoveryTransition {
  readonly authority: SeatAuthorities;
  readonly recovery: RecoveryState;
  readonly crypto: CryptoContext;
  readonly state: GameState;
  readonly input: Input | null;
}

/** Proposal derivation only. The parent's quorum certificate is required before installation. */
export function validateRecoveryTransition(
  change: unknown,
  entry: LogEntry,
  context: LogContext,
  crypto: CryptoContext | null,
): Result<RecoveryTransition> {
  if (
    context.genesis.security !== 'verified' ||
    !crypto ||
    !context.authority ||
    !decksReady(crypto.decks)
  )
    return failure(
      'recovery-context',
      'Recovery requires verified authority and completed genesis decks',
    );
  if (context.state.result !== null)
    return failure('recovery-finished', 'A finished game cannot change controllers');
  if (context.recovery?.void)
    return failure('recovery-void', 'A certified void ends recovery and gameplay');
  if (context.transfer?.pending)
    return failure('recovery-transfer-pending', 'Cancel the certified transfer before recovery');
  const parsed = parseCanonical(change, recoveryChangeSchema);
  if (!parsed.ok) return parsed;
  const checked = validateSeatAuthorities(
    context.authority,
    genesisDigest(context.genesis),
    crypto.epoch,
    context.genesis.config.seats,
  );
  if (!checked.ok) return checked;
  const current = checked.value;
  const body = parsed.value.statement;
  if (
    body.genesisDigest !== current.genesisDigest ||
    !same(body.parent, ref(context.head)) ||
    (parsed.value.kind !== 'recovery-void' &&
      (parsed.value.statement.nextEpoch !== current.epoch + 1 ||
        !Number.isSafeInteger(current.epoch + 1)))
  )
    return failure(
      'recovery-parent',
      'Recovery statement differs from its certified parent or next epoch',
    );
  const history = context.recovery;
  if (!history) return failure('recovery-history', 'Certified recovery history is unavailable');
  const offline = validateOfflineMarkers(history, context);
  if (!offline.ok) return offline;
  const pending = history.pending
    ? history.authorizations.find((item) => same(item.entry, history.pending))
    : undefined;
  if (history.pending && !pending)
    return failure('recovery-history', 'Pending authorization is missing from replayed history');
  if (parsed.value.kind === 'recovery-authorize' && history.authorizations.length >= 256)
    return failure('recovery-history-limit', 'Recovery authorization history is full');
  const prepared = { ...context, crypto };
  if (parsed.value.kind === 'recovery-void')
    return certifyVoid(parsed.value, entry, prepared, current, history, pending);
  const carried = carriedOperations(crypto);
  if (!carried.ok) return carried;
  return parsed.value.kind === 'recovery-authorize'
    ? authorize(parsed.value, entry, prepared, current, history, pending, carried.value)
    : activate(parsed.value, entry, prepared, current, history, pending, carried.value);
}

function certifyVoid(
  change: RecoveryVoid,
  entry: LogEntry,
  context: LogContext & { crypto: CryptoContext },
  current: SeatAuthorities,
  history: RecoveryState,
  pending: AuthorizedRecovery | undefined,
): Result<RecoveryTransition> {
  const statement = change.statement;
  if (
    !pending ||
    !same(statement.authorization, pending.entry) ||
    !pending.statement.replacements.some(({ seat }) => seat === statement.dealerSeat)
  )
    return failure('recovery-void-authorization', 'Void must name a pending affected dealer');
  const recoverers = current.controllers
    .filter((item) => item.kind === 'human' && item.status === 'active')
    .map(({ seat, publicKey }) => ({ seat, publicKey }));
  if (
    !same(recoverers, pending.statement.recoverers) ||
    !signedByAll(RECOVERY_VOID_DOMAIN, statement, change.checks, recoverers)
  )
    return failure('recovery-void-check', 'Every named current recoverer must attest to the void');
  if (
    entry.stateHash !== context.head.stateHash ||
    toHex(hashValue(context.state)) !== context.head.stateHash
  )
    return failure('recovery-void-state', 'Void must preserve the certified engine state');
  return success({
    authority: current,
    recovery: {
      ...history,
      pending: null,
      void: {
        entry: ref(entry),
        authorization: pending.entry,
        dealerSeat: statement.dealerSeat,
        reason: statement.reason,
      },
    },
    crypto: context.crypto,
    state: context.state,
    input: null,
  });
}

function authorize(
  change: Extract<RecoveryChange, { kind: 'recovery-authorize' }>,
  entry: LogEntry,
  context: LogContext & { crypto: CryptoContext },
  current: SeatAuthorities,
  history: RecoveryState,
  pending: AuthorizedRecovery | undefined,
  carried: readonly CarriedOperation[],
): Result<RecoveryTransition> {
  const statement: RecoveryReadiness = change.statement;
  if (context.genesis.takeover.afterSeconds === 'never')
    return failure('recovery-policy', 'Signed game policy disables takeover');
  if (!history.offline.some((marker) => marker.seat === statement.departedSeat))
    return failure('recovery-presence', 'Departed human has no certified offline marker');
  const voters = current.controllers.filter(
    (item) => item.kind === 'human' && item.status === 'active',
  );
  let affected: readonly Seat[];
  let remaining = voters;
  if (pending) {
    if (
      !statement.previous ||
      !same(statement.previous, pending.entry) ||
      statement.departedSeat !== pending.statement.departedSeat
    )
      return failure('recovery-amendment', 'Amendment must name the current pending authorization');
    affected = pending.statement.replacements.map((item) => item.seat);
    if (
      affected.some(
        (seat) =>
          current.controllers.find((item) => item.seat === seat)?.status !== 'pending-recovery',
      )
    )
      return failure('recovery-amendment', 'Amended seats must remain frozen');
  } else {
    if (statement.previous !== null || !voters.some((item) => item.seat === statement.departedSeat))
      return failure('recovery-departure', 'Authorization must remove one current human voter');
    remaining = voters.filter((item) => item.seat !== statement.departedSeat);
    if (remaining.length < quorumSize(voters.length))
      return failure('recovery-quorum', 'Remaining humans cannot meet the old voter quorum');
    affected = current.controllers
      .filter(
        (item) => item.seat === statement.departedSeat || item.hostSeat === statement.departedSeat,
      )
      .map((item) => item.seat);
    if (
      affected.some(
        (seat) => current.controllers.find((item) => item.seat === seat)?.status !== 'active',
      )
    )
      return failure('recovery-departure', 'Departure cannot replace already frozen seats');
  }
  const expectedRecoverers = remaining.map(({ seat, publicKey }) => ({ seat, publicKey }));
  const host = remaining.find((item) => item.seat === statement.hostSeat);
  if (
    !host ||
    !same(statement.recoverers, expectedRecoverers) ||
    !same(
      statement.replacements.map((item) => item.seat),
      affected,
    )
  )
    return failure(
      'recovery-roster',
      'Host, recoverers or replacement seats differ from certified membership',
    );
  const rosters = deriveEscrowRosters(context.genesis);
  if (!rosters.ok) return rosters;
  if (affected.some((seat) => !rosters.value.find((item) => item.dealer.seat === seat)?.eligible))
    return failure(
      'recovery-escrow',
      'Original genesis did not authorize escrow for every affected seat',
    );
  const keys = statement.replacements.map((item) => item.publicKey);
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) => current.usedPublicKeys.includes(key))
  )
    return failure(
      'recovery-key-reuse',
      'Replacement keys must be fresh and distinct for every seat',
    );
  if (
    !signed(RECOVERY_READINESS_DOMAIN, statement, change.hostSig, host.publicKey) ||
    !signedByAll(RECOVERY_READINESS_DOMAIN, statement, change.keySigs, statement.replacements)
  )
    return failure(
      'recovery-readiness',
      'Host and each replacement key must sign the exact readiness statement',
    );
  const authority = validateSeatAuthorities(
    {
      ...current,
      epoch: statement.nextEpoch,
      carriedOperations: carried,
      usedPublicKeys: [...current.usedPublicKeys, ...keys],
      controllers: current.controllers.map((item) =>
        affected.includes(item.seat)
          ? { ...item, hostSeat: host.seat, kind: 'bot', status: 'pending-recovery' }
          : item,
      ),
    },
    current.genesisDigest,
    statement.nextEpoch,
    context.genesis.config.seats,
  );
  if (!authority.ok) return authority;
  if (
    entry.stateHash !== context.head.stateHash ||
    toHex(hashValue(context.state)) !== context.head.stateHash
  )
    return failure('recovery-state', 'Authorization must preserve the certified engine state');
  const authorization = { entry: ref(entry), statement };
  return success({
    authority: authority.value,
    recovery: {
      ...history,
      authorizations: [...history.authorizations, authorization],
      pending: authorization.entry,
    },
    crypto: { ...context.crypto, epoch: statement.nextEpoch },
    state: context.state,
    input: null,
  });
}

function activate(
  change: Extract<RecoveryChange, { kind: 'recovery-activate' }>,
  entry: LogEntry,
  context: LogContext & { crypto: CryptoContext },
  current: SeatAuthorities,
  history: RecoveryState,
  pending: AuthorizedRecovery | undefined,
  carried: readonly CarriedOperation[],
): Result<RecoveryTransition> {
  const statement: RecoveryActivationStatement = change.statement;
  if (!pending || !same(statement.authorization, pending.entry))
    return failure(
      'recovery-authorization',
      'Activation must name the current pending authorization',
    );
  const recoverers = current.controllers
    .filter((item) => item.kind === 'human' && item.status === 'active')
    .map(({ seat, publicKey }) => ({ seat, publicKey }));
  if (
    !same(recoverers, pending.statement.recoverers) ||
    statement.checkDigest !== recoveryCheckDigest(context, pending.entry) ||
    !signedByAll(RECOVERY_CHECK_DOMAIN, statement, change.checks, recoverers)
  )
    return failure(
      'recovery-check',
      'Every remaining human must attest to reconstruction at this exact parent',
    );
  const replacements = pending.statement.replacements;
  if (
    replacements.some(
      (replacement) =>
        current.controllers.find((item) => item.seat === replacement.seat)?.status !==
        'pending-recovery',
    )
  )
    return failure('recovery-activation', 'Only frozen seats can activate replacement keys');
  const authority = validateSeatAuthorities(
    {
      ...current,
      epoch: statement.nextEpoch,
      carriedOperations: carried,
      controllers: current.controllers.map((item) => {
        const replacement = replacements.find((candidate) => candidate.seat === item.seat);
        return replacement
          ? {
              ...item,
              publicKey: replacement.publicKey,
              hostSeat: pending.statement.hostSeat,
              status: 'active',
              kind: 'bot',
              activatedAt: ref(entry),
            }
          : item;
      }),
    },
    current.genesisDigest,
    statement.nextEpoch,
    context.genesis.config.seats,
  );
  if (!authority.ok) return authority;
  const input = {
    kind: 'system',
    type: 'SEAT_STATUS',
    seat: pending.statement.departedSeat,
    status: 'bot',
  } as const;
  const applied = context.engine.apply(context.state, input);
  if (!applied.ok) return applied;
  if (
    context.engine.checkInvariants(applied.value.state).length ||
    entry.stateHash !== toHex(hashValue(applied.value.state))
  )
    return failure(
      'recovery-state',
      'Activation state differs from the deterministic bot takeover',
    );
  return success({
    authority: authority.value,
    recovery: {
      ...history,
      pending: null,
      offline: history.offline.filter((marker) => marker.seat !== pending.statement.departedSeat),
      completed: [
        ...history.completed,
        {
          authorization: pending.entry,
          activation: ref(entry),
          checkDigest: statement.checkDigest,
        },
      ],
    },
    crypto: { ...context.crypto, epoch: statement.nextEpoch },
    state: applied.value.state,
    input,
  });
}
