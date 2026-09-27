import { hashValue, toHex } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import * as v from 'valibot';
import type { EntryRef } from './beacon-state.js';
import { entryHash, genesisDigest } from './genesis.js';
import { validateGenesisOnlineStart } from './genesis-online-start.js';
import type { LogContext } from './log-types.js';
import {
  hashSchema,
  key32Schema,
  nonnegativeIntegerSchema,
  seatSchema,
  signature64Schema,
} from './schema-values.js';
import type { TransferState } from './transfer-types.js';
import type { Genesis, LogEntry } from './types.js';

export const TRANSFER_DEVICE_DOMAIN = 'seat-transfer-device-v1';
export const TRANSFER_GAME_KEY_DOMAIN = 'seat-transfer-game-key-v1';
export const TRANSFER_BOT_KEY_DOMAIN = 'seat-transfer-bot-key-v1';
export const TRANSFER_OWNER_GAME_DOMAIN = 'seat-transfer-owner-game-v1';
export const TRANSFER_OWNER_DEVICE_DOMAIN = 'seat-transfer-owner-device-v1';
export const TRANSFER_RETURN_INTENT_DOMAIN = 'seat-transfer-return-intent-v1';
export const TRANSFER_HUMAN_APPROVAL_DOMAIN = 'seat-transfer-human-approval-v1';
export const TRANSFER_DESTINATION_CHECK_DOMAIN = 'seat-transfer-dest-check-v1';
export const TRANSFER_BOT_CHECK_DOMAIN = 'seat-transfer-bot-check-v1';

export const transferRefSchema = v.strictObject({
  seq: nonnegativeIntegerSchema,
  hash: hashSchema,
});
export const transferReplacementSchema = v.strictObject({
  seat: seatSchema,
  oldPublicKey: key32Schema,
  newPublicKey: key32Schema,
  newHostSeat: seatSchema,
});
const replacementsSchema = v.pipe(
  v.array(transferReplacementSchema),
  v.minLength(1),
  v.maxLength(6),
);
const signaturesSchema = v.pipe(
  v.array(v.strictObject({ seat: seatSchema, sig: signature64Schema })),
  v.maxLength(6),
);
export const transferAuthorizationStatementSchema = v.strictObject({
  protocol: v.literal('seat-transfer-v1'),
  genesisDigest: key32Schema,
  anchor: transferRefSchema,
  validUntilSeq: nonnegativeIntegerSchema,
  mode: v.picklist(['live', 'return']),
  seat: seatSchema,
  currentController: v.strictObject({
    publicKey: key32Schema,
    kind: v.picklist(['human', 'bot']),
    activatedAt: transferRefSchema,
    hostSeat: seatSchema,
  }),
  recovery: v.nullable(
    v.strictObject({
      authorization: transferRefSchema,
      activation: transferRefSchema,
    }),
  ),
  nextEpoch: nonnegativeIntegerSchema,
  destination: v.strictObject({
    devicePeer: key32Schema,
    gamePeer: key32Schema,
    transferEncryptionKey: key32Schema,
  }),
  replacements: replacementsSchema,
});
export const transferActivationStatementSchema = v.strictObject({
  protocol: v.literal('seat-transfer-activation-v1'),
  genesisDigest: key32Schema,
  authorization: transferRefSchema,
  parent: transferRefSchema,
  nextEpoch: nonnegativeIntegerSchema,
  destinationDevice: key32Schema,
  destinationGame: key32Schema,
  replacements: replacementsSchema,
  checkDigest: hashSchema,
});
export const transferChangeSchema = v.variant('kind', [
  v.strictObject({
    kind: v.literal('transfer-authorize'),
    statement: transferAuthorizationStatementSchema,
    destinationDeviceSig: signature64Schema,
    destinationGameSig: signature64Schema,
    replacementKeySigs: signaturesSchema,
    ownerIntent: v.optional(
      v.strictObject({
        signer: v.picklist(['current-game', 'current-device']),
        sig: signature64Schema,
      }),
    ),
    returnIntent: v.optional(
      v.strictObject({
        signer: v.literal('last-human-game-key'),
        sig: signature64Schema,
      }),
    ),
    humanApprovals: v.optional(signaturesSchema),
  }),
  v.strictObject({
    kind: v.literal('transfer-activate'),
    statement: transferActivationStatementSchema,
    destinationCheck: signature64Schema,
    replacementChecks: signaturesSchema,
  }),
  v.strictObject({
    kind: v.literal('transfer-cancel'),
    genesisDigest: key32Schema,
    authorization: transferRefSchema,
    parent: transferRefSchema,
  }),
]);

export function transferEntryRef(entry: LogEntry): EntryRef {
  return { seq: entry.seq, hash: entryHash(entry) };
}

/** The public check binds import readiness to one certified activation parent. */
export function transferCheckDigest(context: LogContext, authorization: EntryRef): string {
  return toHex(
    hashValue({
      domain: 'cp2p/v1/transfer-check',
      genesisDigest: genesisDigest(context.genesis),
      authorization,
      parent: transferEntryRef(context.head),
      publicStateHash: toHex(hashValue(context.state)),
      cryptoStateHash: toHex(hashValue(context.crypto)),
      authorityStateHash: toHex(hashValue(context.authority ?? null)),
    }),
  );
}

/** Validated genesis is the only source of initial device routes. */
export function initialTransferState(
  genesis: Genesis,
  genesisEntry: LogEntry,
): Result<TransferState> {
  const routes = genesis.seats.map(({ seat }) => ({ seat, devicePeer: null as string | null }));
  let knownDevicePeers: string[] = [];
  if (genesis.security === 'verified') {
    const online = validateGenesisOnlineStart(genesis);
    if (!online.ok) return online;
    const state = online.value.bindings.agreement.state;
    knownDevicePeers = [
      ...new Set([
        state.hostPeer,
        ...state.spectators,
        ...state.seats.flatMap((seat) => (seat.kind === 'human' ? [seat.peer] : [])),
      ]),
    ];
    for (const frozen of state.seats) {
      if (frozen.kind !== 'human') continue;
      const route = routes.find((item) => item.seat === frozen.seat);
      if (!route) return failure('transfer-route', 'Frozen human route has no genesis seat');
      route.devicePeer = frozen.peer;
    }
  }
  return success({
    genesisDigest: genesisDigest(genesis),
    routes,
    knownDevicePeers,
    recentHeads: [transferEntryRef(genesisEntry)],
    intentBarrier: transferEntryRef(genesisEntry),
    pending: null,
    authorizations: [],
    completed: [],
    returnRoots: [],
  });
}

/** Keep the signed authorization anchor available for its entire 64-height window. */
export function advanceTransferHead(state: TransferState, entry: LogEntry): TransferState {
  const ref = transferEntryRef(entry);
  return {
    ...state,
    recentHeads: [...state.recentHeads, ref].slice(-65),
    intentBarrier: entry.payload.kind === 'membership' ? ref : state.intentBarrier,
  };
}
