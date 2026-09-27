import { hashValue, toHex } from '@cp2p/codec';
import { parsePeerId, verifyObject } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { GameState, Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { validateSeatAuthorities } from './authority.js';
import type { SeatAuthorities } from './authority-types.js';
import type { EntryRef } from './beacon-state.js';
import type { CryptoContext } from './crypto-context.js';
import { entryHash, genesisDigest } from './genesis.js';
import type { LogContext } from './log-types.js';
import type { RecoveryState } from './recovery-types.js';
import {
  hashSchema,
  key32Schema,
  nonnegativeIntegerSchema,
  seatSchema,
  signature64Schema,
} from './schema-values.js';
import type { LogEntry } from './types.js';
import { PROTOCOL_VERSION } from './types.js';
import { parseCanonical } from './validation.js';

export const SEAT_ONLINE_DOMAIN = `seat-online-v${PROTOCOL_VERSION}`;
const refSchema = v.strictObject({ seq: nonnegativeIntegerSchema, hash: hashSchema });
export const seatOnlineStatementSchema = v.strictObject({
  genesisDigest: key32Schema,
  epoch: nonnegativeIntegerSchema,
  parent: refSchema,
  seat: seatSchema,
  generation: refSchema,
  offline: refSchema,
});
export const seatPresenceChangeSchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('seat-offline'), seat: seatSchema }),
  v.strictObject({
    kind: v.literal('seat-online'),
    proof: v.strictObject({ statement: seatOnlineStatementSchema, sig: signature64Schema }),
  }),
]);
export type SeatOnlineStatement = v.InferOutput<typeof seatOnlineStatementSchema>;
export type SeatPresenceChange = v.InferOutput<typeof seatPresenceChangeSchema>;

function ref(entry: LogEntry): EntryRef {
  return { seq: entry.seq, hash: entryHash(entry) };
}

function same(left: unknown, right: unknown): boolean {
  return toHex(hashValue(left)) === toHex(hashValue(right));
}

export function validateOfflineMarkers(recovery: RecoveryState, context: LogContext): Result<void> {
  let prior = -1;
  for (const marker of recovery.offline) {
    if (
      marker.seat <= prior ||
      !context.genesis.seats.some((seat) => seat.seat === marker.seat) ||
      marker.since.seq <= 0 ||
      marker.since.seq > context.head.seq ||
      !/^[0-9a-f]{64}$/.test(marker.since.hash)
    )
      return failure('presence-history', 'Certified offline markers are malformed or unsorted');
    prior = marker.seat;
  }
  return success(undefined);
}

/** A signature over exactly the current certified controller generation and offline marker. */
export function seatOnlineStatement(context: LogContext, seat: Seat): Result<SeatOnlineStatement> {
  const authority = context.authority;
  const recovery = context.recovery;
  if (!authority || !recovery || !context.crypto)
    return failure('presence-context', 'Certified presence context is unavailable');
  if (recovery.pending || context.transfer?.pending)
    return failure('presence-pending', 'Finish the pending membership change first');
  const checked = validateSeatAuthorities(
    authority,
    genesisDigest(context.genesis),
    context.crypto.epoch,
    context.genesis.config.seats,
  );
  if (!checked.ok) return checked;
  const history = validateOfflineMarkers(recovery, context);
  if (!history.ok) return history;
  const controller = checked.value.controllers.find((item) => item.seat === seat);
  const marker = recovery.offline.find((item) => item.seat === seat);
  if (!controller || controller.kind !== 'human' || controller.status !== 'active' || !marker)
    return failure('presence-online', 'Only a marked active human can announce a return');
  return success({
    genesisDigest: authority.genesisDigest,
    epoch: authority.epoch,
    parent: ref(context.head),
    seat,
    generation: controller.activatedAt,
    offline: marker.since,
  });
}

export interface PresenceTransition {
  readonly authority: SeatAuthorities;
  readonly recovery: RecoveryState;
  readonly crypto: CryptoContext;
  readonly state: GameState;
  readonly input: null;
}

/** Certified ordering only. No peer timestamp or local absence duration enters replay. */
export function validateSeatPresenceTransition(
  change: unknown,
  entry: LogEntry,
  context: LogContext,
  crypto: CryptoContext | null,
): Result<PresenceTransition> {
  if (
    context.genesis.security !== 'verified' ||
    context.genesis.protocolVersion !== PROTOCOL_VERSION ||
    !crypto ||
    !context.authority ||
    !context.recovery
  )
    return failure('presence-context', 'Certified presence requires current verified authority');
  if (context.state.result !== null)
    return failure('presence-finished', 'A finished game cannot change seat presence');
  if (context.recovery.pending || context.transfer?.pending)
    return failure('presence-pending', 'Finish the pending membership change first');
  const parsed = parseCanonical(change, seatPresenceChangeSchema);
  if (!parsed.ok) return parsed;
  const checked = validateSeatAuthorities(
    context.authority,
    genesisDigest(context.genesis),
    crypto.epoch,
    context.genesis.config.seats,
  );
  if (!checked.ok) return checked;
  const history = validateOfflineMarkers(context.recovery, context);
  if (!history.ok) return history;
  if (
    entry.stateHash !== context.head.stateHash ||
    toHex(hashValue(context.state)) !== context.head.stateHash
  )
    return failure('presence-state', 'Presence entries must preserve the certified engine state');
  const current = parsed.value;
  if (current.kind === 'seat-offline') {
    const controller = checked.value.controllers.find((item) => item.seat === current.seat);
    if (
      !controller ||
      controller.kind !== 'human' ||
      controller.status !== 'active' ||
      context.recovery.offline.some((item) => item.seat === current.seat)
    )
      return failure('presence-offline', 'Only an unmarked active human can be marked offline');
    const offline = [
      ...context.recovery.offline,
      { seat: current.seat, since: ref(entry) },
    ].toSorted((a, b) => a.seat - b.seat);
    return success({
      authority: checked.value,
      recovery: { ...context.recovery, offline },
      crypto,
      state: context.state,
      input: null,
    });
  }
  const expected = seatOnlineStatement(
    { ...context, crypto, authority: checked.value },
    current.proof.statement.seat,
  );
  if (!expected.ok) return expected;
  if (!same(current.proof.statement, expected.value))
    return failure('presence-proof', 'Online proof differs from the certified parent');
  const controller = checked.value.controllers.find((item) => item.seat === expected.value.seat);
  if (!controller) return failure('presence-controller', 'Online controller is unavailable');
  try {
    if (
      !verifyObject(
        SEAT_ONLINE_DOMAIN,
        expected.value,
        current.proof.sig,
        parsePeerId(controller.publicKey),
      )
    )
      return failure('presence-signature', 'Current controller did not sign the online proof');
  } catch {
    return failure('presence-signature', 'Current controller did not sign the online proof');
  }
  return success({
    authority: checked.value,
    recovery: {
      ...context.recovery,
      offline: context.recovery.offline.filter((item) => item.seat !== expected.value.seat),
    },
    crypto,
    state: context.state,
    input: null,
  });
}
