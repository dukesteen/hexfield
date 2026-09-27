import { hashValue, toHex } from '@cp2p/codec';
import { decodePoint, encodePoint, parsePeerId, verifyObject } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { GameState, Input, Result, Seat } from '@cp2p/engine';
import { validateSeatAuthorities } from './authority.js';
import type { CarriedOperation, ControllerRecord, SeatAuthorities } from './authority-types.js';
import type { CryptoContext } from './crypto-context.js';
import { decksReady } from './deck-ledger.js';
import { genesisDigest } from './genesis.js';
import { validateGenesisMasters } from './genesis-masters.js';
import type { LogContext } from './log-types.js';
import { carriedOperations, recoveryChangeSchema } from './recovery-membership.js';
import type { RecoveryChange, RecoveryState } from './recovery-types.js';
import {
  TRANSFER_BOT_CHECK_DOMAIN,
  TRANSFER_BOT_KEY_DOMAIN,
  TRANSFER_DESTINATION_CHECK_DOMAIN,
  TRANSFER_DEVICE_DOMAIN,
  TRANSFER_GAME_KEY_DOMAIN,
  TRANSFER_HUMAN_APPROVAL_DOMAIN,
  TRANSFER_OWNER_DEVICE_DOMAIN,
  TRANSFER_OWNER_GAME_DOMAIN,
  TRANSFER_RETURN_INTENT_DOMAIN,
  transferChangeSchema,
  transferCheckDigest,
  transferEntryRef,
} from './transfer-readiness.js';
import type {
  AuthorizedTransfer,
  SeatTransferAuthorization,
  SeatTransferActivation,
  SeatTransferCancel,
  TransferState,
} from './transfer-types.js';
import { PROTOCOL_VERSION } from './types.js';
import type { LogEntry, SeatSignature } from './types.js';
import { parseCanonical } from './validation.js';

const MAX_TRANSFERS = 256;

function same(left: unknown, right: unknown): boolean {
  return toHex(hashValue(left)) === toHex(hashValue(right));
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
  participants: readonly { seat: Seat; publicKey: string }[],
): boolean {
  return (
    signatures.length === participants.length &&
    participants.every((member, index) => {
      const signature = signatures[index];
      return (
        signature?.seat === member.seat &&
        signed(domain, statement, signature.sig, member.publicKey)
      );
    })
  );
}

function checkedTransferState(context: LogContext): Result<TransferState> {
  const state = context.transfer;
  if (!state || state.genesisDigest !== genesisDigest(context.genesis))
    return failure('transfer-history', 'Certified transfer routes are unavailable');
  if (
    state.routes.length !== context.genesis.seats.length ||
    state.routes.some((item, index) => item.seat !== context.genesis.seats[index]?.seat) ||
    state.recentHeads.length > 65 ||
    state.authorizations.length > MAX_TRANSFERS ||
    state.completed.length > MAX_TRANSFERS ||
    state.returnRoots.length > MAX_TRANSFERS ||
    state.intentBarrier.seq > context.head.seq ||
    !same(state.recentHeads.at(-1), transferEntryRef(context.head))
  )
    return failure('transfer-history', 'Replayed transfer state differs from the certified head');
  return success(state);
}

function members(authority: SeatAuthorities) {
  return authority.controllers.filter((item) => item.kind === 'human' && item.status === 'active');
}

function route(state: TransferState, seat: Seat): string | null {
  return state.routes.find((item) => item.seat === seat)?.devicePeer ?? null;
}

function expectedReplacements(
  change: SeatTransferAuthorization,
  authority: SeatAuthorities,
  transfer: TransferState,
): Result<readonly ControllerRecord[]> {
  const statement = change.statement;
  const controller = authority.controllers.find((item) => item.seat === statement.seat);
  if (
    !controller ||
    controller.status !== 'active' ||
    !same(statement.currentController, {
      publicKey: controller.publicKey,
      kind: controller.kind,
      activatedAt: controller.activatedAt,
      hostSeat: controller.hostSeat,
    })
  )
    return failure('transfer-controller', 'Seat controller differs from certified authority');
  if (statement.mode === 'live') {
    if (
      controller.kind !== 'human' ||
      statement.recovery !== null ||
      !change.ownerIntent ||
      change.returnIntent ||
      change.humanApprovals
    )
      return failure('transfer-live', 'Live transfer requires exact active-human owner intent');
    return success([
      controller,
      ...authority.controllers.filter(
        (item) =>
          item.kind === 'bot' && item.status === 'active' && item.hostSeat === controller.seat,
      ),
    ]);
  }
  if (
    controller.kind !== 'bot' ||
    statement.recovery === null ||
    change.ownerIntent ||
    Boolean(change.returnIntent) === Boolean(change.humanApprovals)
  )
    return failure('transfer-return', 'Recovered return needs one valid identity path');
  // A prior recovery root is permanently stale once this seat is recovered
  // again. Roots are appended only from certified recovery transitions, so
  // the last root for this seat is the current return lineage.
  const root = transfer.returnRoots
    .toReversed()
    .find((item) => item.departedSeat === statement.seat);
  if (
    !root ||
    root.activation === null ||
    !same(root.finalAuthorization, statement.recovery?.authorization) ||
    !same(root.activation, statement.recovery?.activation)
  )
    return failure('transfer-return-history', 'Certified recovery ancestry is unavailable');
  const eligible = root.affectedSeats.flatMap((seat) => {
    const item = authority.controllers.find((candidate) => candidate.seat === seat);
    return item?.kind === 'bot' && item.status === 'active' && item.hostSeat === controller.hostSeat
      ? [item]
      : [];
  });
  if (eligible[0]?.seat !== statement.seat)
    return failure(
      'transfer-return-roster',
      'Returned seat is not the first eligible recovered seat',
    );
  if (change.returnIntent) {
    if (
      !signed(
        TRANSFER_RETURN_INTENT_DOMAIN,
        statement,
        change.returnIntent.sig,
        root.lastHumanGameKey,
      )
    )
      return failure('transfer-return-intent', 'Last certified human key did not authorize return');
  } else if (
    !signedByAll(
      TRANSFER_HUMAN_APPROVAL_DOMAIN,
      statement,
      change.humanApprovals ?? [],
      members(authority),
    )
  )
    return failure('transfer-return-approval', 'Every current human must approve key-loss return');
  return success(eligible);
}

function validateFreshKeys(
  change: SeatTransferAuthorization,
  context: LogContext,
  authority: SeatAuthorities,
  transfer: TransferState,
): Result<void> {
  const statement = change.statement;
  const device = statement.destination.devicePeer;
  const game = statement.destination.gamePeer;
  const replacements = statement.replacements;
  try {
    parsePeerId(device);
    parsePeerId(game);
    for (const item of replacements) parsePeerId(item.newPublicKey);
    if (
      encodePoint(
        decodePoint(statement.destination.transferEncryptionKey, { nonIdentity: true }),
      ) !== statement.destination.transferEncryptionKey
    )
      throw new Error('Noncanonical encryption point');
  } catch {
    return failure('transfer-key', 'Destination key or encryption point is malformed');
  }
  const destinationRoute = route(transfer, statement.seat);
  if (
    authority.usedPublicKeys.includes(device) ||
    transfer.routes.some((item) => item.seat !== statement.seat && item.devicePeer === device) ||
    (statement.mode === 'live' && !destinationRoute)
  )
    return failure('transfer-device', 'Destination device conflicts with certified routes or keys');
  const reserved = new Set([
    ...authority.usedPublicKeys,
    ...transfer.knownDevicePeers,
    ...transfer.routes.flatMap((item) => (item.devicePeer ? [item.devicePeer] : [])),
    ...transfer.authorizations.map((item) => item.statement.destination.transferEncryptionKey),
    device,
    ...context.genesis.seats.map((item) => item.encryptionKey),
  ]);
  const masters = validateGenesisMasters(context.genesis);
  if (!masters.ok) return masters;
  for (const item of masters.value) reserved.add(item.masterPub);
  const proposed = [game, ...replacements.slice(1).map((item) => item.newPublicKey)];
  if (
    replacements[0]?.newPublicKey !== game ||
    new Set(proposed).size !== proposed.length ||
    proposed.some((key) => reserved.has(key)) ||
    reserved.has(statement.destination.transferEncryptionKey) ||
    proposed.includes(statement.destination.transferEncryptionKey)
  )
    return failure('transfer-key-reuse', 'Destination voting and encryption keys must be fresh');
  return success(undefined);
}

export interface TransferTransition {
  readonly authority: SeatAuthorities;
  readonly transfer: TransferState;
  readonly crypto: CryptoContext;
  readonly state: GameState;
  readonly input: Input | null;
}

/** Pure proposal derivation; the old voter-set certificate is checked by proposal.ts. */
export function validateTransferTransition(
  value: unknown,
  entry: LogEntry,
  context: LogContext,
  crypto: CryptoContext | null,
): Result<TransferTransition> {
  if (
    context.genesis.protocolVersion !== PROTOCOL_VERSION ||
    context.genesis.security !== 'verified' ||
    !crypto ||
    !context.authority ||
    !decksReady(crypto.decks)
  )
    return failure(
      'transfer-context',
      'Transfer requires verified active authority and completed decks',
    );
  if (context.state.result !== null || context.recovery?.pending)
    return failure('transfer-unavailable', 'Finished games and pending recovery cannot transfer');
  const transfer = checkedTransferState(context);
  if (!transfer.ok) return transfer;
  const parsed = parseCanonical(value, transferChangeSchema);
  if (!parsed.ok) return parsed;
  const current = validateSeatAuthorities(
    context.authority,
    genesisDigest(context.genesis),
    crypto.epoch,
    context.genesis.config.seats,
  );
  if (!current.ok) return current;
  if (context.head.stateHash !== toHex(hashValue(context.state)))
    return failure('transfer-state', 'Transfer parent public state is inconsistent');
  const carried = carriedOperations(crypto);
  if (!carried.ok) return carried;
  if (parsed.value.kind === 'transfer-authorize')
    return authorize(parsed.value, entry, context, crypto, current.value, transfer.value);
  if (parsed.value.kind === 'transfer-cancel')
    return cancel(parsed.value, entry, context, crypto, current.value, transfer.value);
  return activate(
    parsed.value,
    entry,
    context,
    crypto,
    current.value,
    transfer.value,
    carried.value,
  );
}

function authorize(
  change: SeatTransferAuthorization,
  entry: LogEntry,
  context: LogContext,
  crypto: CryptoContext,
  current: SeatAuthorities,
  transfer: TransferState,
): Result<TransferTransition> {
  if (
    transfer.pending ||
    transfer.authorizations.length >= MAX_TRANSFERS ||
    (transfer.knownDevicePeers.length >= MAX_TRANSFERS &&
      !transfer.knownDevicePeers.includes(change.statement.destination.devicePeer))
  )
    return failure('transfer-pending', 'Only one bounded transfer authorization may be pending');
  if (entry.stateHash !== context.head.stateHash)
    return failure('transfer-state', 'Authorization must preserve the certified public state');
  const statement = change.statement;
  const anchor = transfer.recentHeads.find((item) => same(item, statement.anchor));
  if (
    statement.genesisDigest !== current.genesisDigest ||
    !anchor ||
    statement.anchor.seq < transfer.intentBarrier.seq ||
    statement.anchor.seq > context.head.seq ||
    statement.validUntilSeq < entry.seq ||
    statement.validUntilSeq > statement.anchor.seq + 64 ||
    statement.nextEpoch !== current.epoch + 1 ||
    !Number.isSafeInteger(statement.nextEpoch)
  )
    return failure('transfer-anchor', 'Authorization anchor, expiry or epoch is stale');
  const affected = expectedReplacements(change, current, transfer);
  if (!affected.ok) return affected;
  const expected = affected.value.map((item) => ({
    seat: item.seat,
    oldPublicKey: item.publicKey,
    newPublicKey: statement.replacements.find((replacement) => replacement.seat === item.seat)
      ?.newPublicKey,
    newHostSeat: statement.seat,
  }));
  if (
    expected.some((item) => !item.newPublicKey) ||
    !same(
      statement.replacements.map(({ seat, oldPublicKey, newHostSeat }) => ({
        seat,
        oldPublicKey,
        newHostSeat,
      })),
      expected.map(({ seat, oldPublicKey, newHostSeat }) => ({ seat, oldPublicKey, newHostSeat })),
    )
  )
    return failure('transfer-roster', 'Transfer must replace the complete certified hosted set');
  const keys = validateFreshKeys(change, context, current, transfer);
  if (!keys.ok) return keys;
  if (statement.mode === 'live') {
    const owner = change.ownerIntent;
    const signer =
      owner?.signer === 'current-device'
        ? route(transfer, statement.seat)
        : statement.currentController.publicKey;
    if (
      !owner ||
      !signer ||
      !signed(
        owner.signer === 'current-device'
          ? TRANSFER_OWNER_DEVICE_DOMAIN
          : TRANSFER_OWNER_GAME_DOMAIN,
        statement,
        owner.sig,
        signer,
      )
    )
      return failure('transfer-owner-intent', 'Current owner did not authorize the exact transfer');
  }
  if (
    !signed(
      TRANSFER_DEVICE_DOMAIN,
      statement,
      change.destinationDeviceSig,
      statement.destination.devicePeer,
    ) ||
    !signed(
      TRANSFER_GAME_KEY_DOMAIN,
      statement,
      change.destinationGameSig,
      statement.destination.gamePeer,
    ) ||
    !signedByAll(
      TRANSFER_BOT_KEY_DOMAIN,
      statement,
      change.replacementKeySigs,
      statement.replacements
        .slice(1)
        .map(({ seat, newPublicKey }) => ({ seat, publicKey: newPublicKey })),
    )
  )
    return failure('transfer-possession', 'Destination and each replacement key must sign');
  const reserved = statement.replacements.map((item) => item.newPublicKey);
  const authority = validateSeatAuthorities(
    { ...current, usedPublicKeys: [...current.usedPublicKeys, ...reserved] },
    current.genesisDigest,
    current.epoch,
    context.genesis.config.seats,
  );
  if (!authority.ok) return authority;
  const authorization: AuthorizedTransfer = { entry: transferEntryRef(entry), statement };
  return success({
    authority: authority.value,
    transfer: {
      ...transfer,
      pending: authorization.entry,
      authorizations: [...transfer.authorizations, authorization],
      knownDevicePeers: transfer.knownDevicePeers.includes(statement.destination.devicePeer)
        ? transfer.knownDevicePeers
        : [...transfer.knownDevicePeers, statement.destination.devicePeer],
    },
    crypto,
    state: context.state,
    input: null,
  });
}

function pendingAuthorization(transfer: TransferState): Result<AuthorizedTransfer> {
  const pending =
    transfer.pending && transfer.authorizations.find((item) => same(item.entry, transfer.pending));
  return pending
    ? success(pending)
    : failure('transfer-authorization', 'Exact pending transfer authorization is unavailable');
}

function cancel(
  change: SeatTransferCancel,
  entry: LogEntry,
  context: LogContext,
  crypto: CryptoContext,
  current: SeatAuthorities,
  transfer: TransferState,
): Result<TransferTransition> {
  const pending = pendingAuthorization(transfer);
  if (!pending.ok) return pending;
  if (
    entry.stateHash !== context.head.stateHash ||
    transfer.completed.length >= MAX_TRANSFERS ||
    change.genesisDigest !== current.genesisDigest ||
    !same(change.authorization, pending.value.entry) ||
    !same(change.parent, transferEntryRef(context.head))
  )
    return failure('transfer-cancel', 'Cancellation differs from pending authorization or parent');
  return success({
    authority: current,
    transfer: {
      ...transfer,
      pending: null,
      completed: [
        ...transfer.completed,
        {
          authorization: pending.value.entry,
          outcome: 'cancelled',
          entry: transferEntryRef(entry),
        },
      ],
    },
    crypto,
    state: context.state,
    input: null,
  });
}

function activate(
  change: SeatTransferActivation,
  entry: LogEntry,
  context: LogContext,
  crypto: CryptoContext,
  current: SeatAuthorities,
  transfer: TransferState,
  carried: readonly CarriedOperation[],
): Result<TransferTransition> {
  const pending = pendingAuthorization(transfer);
  if (!pending.ok) return pending;
  const statement = change.statement;
  const approved = pending.value.statement;
  if (
    transfer.completed.length >= MAX_TRANSFERS ||
    (transfer.knownDevicePeers.length >= MAX_TRANSFERS &&
      !transfer.knownDevicePeers.includes(approved.destination.devicePeer)) ||
    statement.genesisDigest !== current.genesisDigest ||
    !same(statement.authorization, pending.value.entry) ||
    !same(statement.parent, transferEntryRef(context.head)) ||
    statement.nextEpoch !== current.epoch + 1 ||
    statement.nextEpoch !== approved.nextEpoch ||
    statement.destinationDevice !== approved.destination.devicePeer ||
    statement.destinationGame !== approved.destination.gamePeer ||
    !same(statement.replacements, approved.replacements) ||
    statement.checkDigest !== transferCheckDigest(context, pending.value.entry)
  )
    return failure('transfer-check', 'Activation differs from exact authorization or parent');
  if (
    !signed(
      TRANSFER_DESTINATION_CHECK_DOMAIN,
      statement,
      change.destinationCheck,
      approved.destination.gamePeer,
    ) ||
    !signedByAll(
      TRANSFER_BOT_CHECK_DOMAIN,
      statement,
      change.replacementChecks,
      approved.replacements
        .slice(1)
        .map(({ seat, newPublicKey }) => ({ seat, publicKey: newPublicKey })),
    )
  )
    return failure('transfer-check', 'Destination has not attested to exact-parent import');
  if (
    approved.replacements.some(
      (replacement) =>
        current.controllers.find((item) => item.seat === replacement.seat)?.publicKey !==
        replacement.oldPublicKey,
    )
  )
    return failure('transfer-controller', 'Affected controller changed before activation');
  const authority = validateSeatAuthorities(
    {
      ...current,
      epoch: statement.nextEpoch,
      carriedOperations: carried,
      controllers: current.controllers.map((item) => {
        const replacement = approved.replacements.find((part) => part.seat === item.seat);
        if (!replacement) return item;
        return {
          ...item,
          publicKey: replacement.newPublicKey,
          hostSeat: replacement.newHostSeat,
          kind: item.seat === approved.seat ? ('human' as const) : ('bot' as const),
          activatedAt: transferEntryRef(entry),
        };
      }),
    },
    current.genesisDigest,
    statement.nextEpoch,
    context.genesis.config.seats,
  );
  if (!authority.ok) return authority;
  const input =
    approved.mode === 'return'
      ? ({ kind: 'system', type: 'SEAT_STATUS', seat: approved.seat, status: 'active' } as const)
      : null;
  const applied = input
    ? context.engine.apply(context.state, input)
    : success({ state: context.state });
  if (!applied.ok) return applied;
  if (
    context.engine.checkInvariants(applied.value.state).length !== 0 ||
    entry.stateHash !== toHex(hashValue(applied.value.state))
  )
    return failure('transfer-state', 'Activation state differs from deterministic return');
  return success({
    authority: authority.value,
    transfer: {
      ...transfer,
      pending: null,
      routes: transfer.routes.map((item) =>
        item.seat === approved.seat
          ? { ...item, devicePeer: approved.destination.devicePeer }
          : item,
      ),
      knownDevicePeers: transfer.knownDevicePeers.includes(approved.destination.devicePeer)
        ? transfer.knownDevicePeers
        : [...transfer.knownDevicePeers, approved.destination.devicePeer],
      completed: [
        ...transfer.completed,
        {
          authorization: pending.value.entry,
          outcome: 'activated',
          entry: transferEntryRef(entry),
        },
      ],
    },
    crypto: { ...crypto, epoch: statement.nextEpoch },
    state: applied.value.state,
    input,
  });
}

/** Track the final amendment and old identity only from certified recovery transitions. */
export function advanceTransferRecovery(
  transfer: TransferState,
  context: LogContext,
  entry: LogEntry,
  supplied: unknown,
  recovery: RecoveryState,
): Result<TransferState> {
  const parsed = parseCanonical(supplied, recoveryChangeSchema);
  if (!parsed.ok) return parsed;
  const change: RecoveryChange = parsed.value;
  if (change.kind === 'recovery-authorize' && change.statement.previous === null) {
    if (transfer.returnRoots.length >= MAX_TRANSFERS)
      return failure('transfer-return-limit', 'Recovered human identity history is full');
    const controller = context.authority?.controllers.find(
      (item) => item.seat === change.statement.departedSeat,
    );
    const device = route(transfer, change.statement.departedSeat);
    if (!controller || controller.kind !== 'human' || !device)
      return failure('transfer-return-history', 'Last certified human identity is unavailable');
    return success({
      ...transfer,
      routes: transfer.routes.map((item) =>
        item.seat === controller.seat ? { ...item, devicePeer: null } : item,
      ),
      returnRoots: [
        ...transfer.returnRoots,
        {
          rootAuthorization: transferEntryRef(entry),
          finalAuthorization: transferEntryRef(entry),
          activation: null,
          departedSeat: controller.seat,
          lastHumanGameKey: controller.publicKey,
          lastHumanDevice: device,
          affectedSeats: [
            controller.seat,
            ...change.statement.replacements
              .map((item) => item.seat)
              .filter((seat) => seat !== controller.seat),
          ],
        },
      ],
    });
  }
  if (change.kind === 'recovery-authorize' && change.statement.previous) {
    const root = transfer.returnRoots.find((item) =>
      same(item.finalAuthorization, change.statement.previous),
    );
    if (!root) return failure('transfer-return-history', 'Recovery amendment root is unavailable');
    return success({
      ...transfer,
      returnRoots: transfer.returnRoots.map((item) =>
        item === root ? { ...item, finalAuthorization: transferEntryRef(entry) } : item,
      ),
    });
  }
  if (change.kind === 'recovery-activate') {
    const root = transfer.returnRoots.find((item) =>
      same(item.finalAuthorization, change.statement.authorization),
    );
    if (!root || !recovery.completed.some((item) => same(item.activation, transferEntryRef(entry))))
      return failure('transfer-return-history', 'Completed recovery ancestry is unavailable');
    return success({
      ...transfer,
      returnRoots: transfer.returnRoots.map((item) =>
        item === root ? { ...item, activation: transferEntryRef(entry) } : item,
      ),
    });
  }
  if (change.kind === 'recovery-void') return success(transfer);
  return failure('transfer-return-history', 'Recovery transition is malformed');
}
