import { canonicalDecode, canonicalEncode, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import {
  G,
  encodePoint,
  identityFromSecret,
  openSealed,
  parsePeerId,
  scalarFromBytes,
  scalePoint,
  seal,
  signObject,
  verifyObject,
} from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Engine, Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import type { EntryRef } from './beacon-state.js';
import { entryHash, genesisDigest } from './genesis.js';
import { verifyRevealedMaster } from './genesis-secrets.js';
import type { ProtocolJournal } from './journal.js';
import type { LogContext } from './log-types.js';
import { reconstructPrivateSeats } from './private-replay.js';
import type { ReconstructedPrivateSeats } from './private-replay.js';
import { loadRecoveryPrivate } from './recovery-private.js';
import type { RecoveryPrivateStore } from './recovery-private.js';
import type { CertifiedEntry } from './proposal.js';
import { replayCertifiedPrefix } from './replay.js';
import type { ReplayPolicy } from './replay.js';
import { hashSchema, key32Schema, seatSchema, signature64Schema } from './schema-values.js';
import { transferRefSchema, transferEntryRef } from './transfer-readiness.js';
import type { AuthorizedTransfer, TransferReturnRoot } from './transfer-types.js';
import type { LogEntry } from './types.js';

export const TRANSFER_PRIVATE_DOMAIN = 'seat-transfer-private-v1';
const SEAL_DOMAIN = 'cp2p/v1/seat-transfer-private-seal';
const MAX_PACKET = 8192;
const masterSchema = v.strictObject({
  seat: seatSchema,
  master: v.custom<Uint8Array>((x): x is Uint8Array => x instanceof Uint8Array && x.length === 32),
});
const mastersSchema = v.pipe(v.array(masterSchema), v.minLength(1), v.maxLength(6));
const custodySchema = v.strictObject({
  authorization: transferRefSchema,
  recipientSeat: seatSchema,
  masters: mastersSchema,
});
const plaintextSchema = v.strictObject({
  protocol: v.literal('seat-transfer-private-plaintext-v1'),
  authorization: transferRefSchema,
  masters: mastersSchema,
  recoveryCustody: v.pipe(v.array(custodySchema), v.maxLength(6)),
});
const packetBodySchema = v.strictObject({
  protocol: v.literal('seat-transfer-private-v1'),
  genesisDigest: key32Schema,
  authorization: transferRefSchema,
  sourceParent: transferRefSchema,
  sourceSeat: seatSchema,
  sourceSigner: v.strictObject({
    kind: v.picklist(['current-controller', 'certified-device']),
    publicKey: key32Schema,
  }),
  destinationDevice: key32Schema,
  destinationGame: key32Schema,
  affectedSeats: v.pipe(v.array(seatSchema), v.minLength(1), v.maxLength(6)),
  nonce: key32Schema,
  sealed: v.strictObject({
    ephemeral: key32Schema,
    ciphertext: v.pipe(v.string(), v.maxLength(5462)),
  }),
  ciphertextHash: hashSchema,
});
export const transferPrivateEnvelopeSchema = v.strictObject({
  ...packetBodySchema.entries,
  sourceSig: signature64Schema,
});
const importRecordSchema = v.strictObject({
  protocol: v.literal('seat-transfer-private-import-v1'),
  packet: transferPrivateEnvelopeSchema,
  encryptionSecret: v.custom<Uint8Array>(
    (x): x is Uint8Array => x instanceof Uint8Array && x.length === 32,
  ),
});
export type TransferPrivateEnvelope = v.InferOutput<typeof transferPrivateEnvelopeSchema>;
type Master = v.InferOutput<typeof masterSchema>;
type Custody = v.InferOutput<typeof custodySchema>;
type Plaintext = v.InferOutput<typeof plaintextSchema>;

/** load returns owned bytes; putIfAbsent copies before awaiting and commits durably. */
export interface TransferPrivateStore {
  load(id: string): Promise<Uint8Array | null>;
  putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean>;
}

export interface ImportedTransferPrivate extends ReconstructedPrivateSeats {
  /** Owned copies; dispose clears these as well as the reconstructed driver. */
  readonly masters: readonly Master[];
}

function sameRef(a: EntryRef, b: EntryRef): boolean {
  return a.seq === b.seq && a.hash === b.hash;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function packetBody(packet: TransferPrivateEnvelope) {
  const { sourceSig: _sourceSig, ...body } = packet;
  return body;
}

function sealContext(
  body: Pick<
    TransferPrivateEnvelope,
    | 'genesisDigest'
    | 'authorization'
    | 'sourceParent'
    | 'sourceSeat'
    | 'sourceSigner'
    | 'destinationDevice'
    | 'destinationGame'
    | 'affectedSeats'
    | 'nonce'
  >,
  encryptionKey: string,
) {
  return {
    domain: SEAL_DOMAIN,
    genesisDigest: body.genesisDigest,
    authorization: body.authorization,
    sourceParent: body.sourceParent,
    sourceSeat: body.sourceSeat,
    sourceSigner: body.sourceSigner,
    destinationDevice: body.destinationDevice,
    destinationGame: body.destinationGame,
    affectedSeats: body.affectedSeats,
    nonce: body.nonce,
    encryptionKey,
  };
}

function packetHash(sealed: TransferPrivateEnvelope['sealed']): string {
  return toHex(hashValue({ domain: 'cp2p/v1/transfer-private-ciphertext', sealed }));
}

function scope(context: LogContext, authorization: EntryRef): Result<AuthorizedTransfer> {
  const transfer = context.transfer;
  const approved = transfer?.authorizations.find((item) => sameRef(item.entry, authorization));
  if (
    !transfer ||
    !approved ||
    !transfer.pending ||
    !sameRef(transfer.pending, authorization) ||
    approved.statement.genesisDigest !== genesisDigest(context.genesis) ||
    !context.crypto ||
    !context.authority
  )
    return failure('transfer-private-authority', 'Exact certified pending transfer is unavailable');
  return success(approved);
}

function affected(approved: AuthorizedTransfer): Seat[] {
  return approved.statement.replacements.map((item) => item.seat);
}

function authorizeSource(
  context: LogContext,
  approved: AuthorizedTransfer,
  sourceSeat: Seat,
  kind: 'current-controller' | 'certified-device',
  signer: string,
): Result<void> {
  const statement = approved.statement;
  const controller = context.authority?.controllers.find((item) => item.seat === sourceSeat);
  const route = context.transfer?.routes.find((item) => item.seat === sourceSeat);
  if (!controller || controller.kind !== 'human' || controller.status !== 'active')
    return failure('transfer-private-source', 'Source is not an active human controller');
  if (
    !(kind === 'current-controller' && signer === controller.publicKey) &&
    !(statement.mode === 'live' && kind === 'certified-device' && signer === route?.devicePeer)
  )
    return failure('transfer-private-source', 'Packet source is not the certified controller');
  if (statement.mode === 'live')
    return sourceSeat === statement.seat
      ? success(undefined)
      : failure('transfer-private-source', 'Live source is not the transferring owner');
  const root = currentReturnRoot(context, statement.seat);
  const recovery = statement.recovery;
  const recoverer = context.recovery?.authorizations
    .find((item) => recovery && sameRef(item.entry, recovery.authorization))
    ?.statement.recoverers.find((item) => item.seat === sourceSeat);
  if (
    !root ||
    !recovery ||
    !sameRef(root.finalAuthorization, recovery.authorization) ||
    !root.activation ||
    !sameRef(root.activation, recovery.activation) ||
    !recoverer ||
    !lawfulSuccessor(
      context,
      sourceSeat,
      recoverer.publicKey,
      controller.publicKey,
      recovery.activation,
    )
  )
    return failure('transfer-private-custody', 'Source is not a lawful current recoverer');
  return success(undefined);
}

/** Authenticate bounded packet bytes before performing any certified replay. */
function authenticateEnvelope(value: unknown): Result<TransferPrivateEnvelope> {
  const parsed = v.safeParse(transferPrivateEnvelopeSchema, value);
  if (!parsed.success)
    return failure('transfer-private-schema', 'Malformed transfer private packet');
  const packet = parsed.output;
  if (canonicalEncode(packet).length > MAX_PACKET)
    return failure('transfer-private-size', 'Transfer private packet is oversized');
  const signer = packet.sourceSigner.publicKey;
  try {
    if (
      !verifyObject(
        TRANSFER_PRIVATE_DOMAIN,
        packetBody(packet),
        packet.sourceSig,
        parsePeerId(signer),
      )
    )
      return failure('transfer-private-signature', 'Private packet signature is invalid');
  } catch {
    return failure('transfer-private-signature', 'Private packet signer is malformed');
  }
  return success(packet);
}

/** Authenticate the public envelope before any destination private-key operation. */
export function verifyTransferPrivateEnvelope(
  value: unknown,
  context: LogContext,
): Result<TransferPrivateEnvelope> {
  const parsed = authenticateEnvelope(value);
  if (!parsed.ok) return parsed;
  const packet = parsed.value;
  const approved = scope(context, packet.authorization);
  if (!approved.ok) return approved;
  const statement = approved.value.statement;
  if (
    packet.genesisDigest !== statement.genesisDigest ||
    !sameRef(packet.sourceParent, transferEntryRef(context.head)) ||
    packet.destinationDevice !== statement.destination.devicePeer ||
    packet.destinationGame !== statement.destination.gamePeer ||
    packet.affectedSeats.length !== statement.replacements.length ||
    packet.affectedSeats.some((seat, i) => seat !== statement.replacements[i]?.seat) ||
    packet.ciphertextHash !== packetHash(packet.sealed)
  )
    return failure('transfer-private-binding', 'Packet differs from the certified transfer');
  const signer = packet.sourceSigner.publicKey;
  const source = authorizeSource(
    context,
    approved.value,
    packet.sourceSeat,
    packet.sourceSigner.kind,
    signer,
  );
  if (!source.ok) return source;

  return success(packet);
}

function currentReturnRoot(context: LogContext, seat: Seat): TransferReturnRoot | undefined {
  return (context.transfer?.returnRoots ?? [])
    .toReversed()
    .find((root) => root.departedSeat === seat);
}

function lawfulSuccessor(
  context: LogContext,
  seat: Seat,
  original: string,
  current: string,
  after: EntryRef,
): boolean {
  let key = original;
  const transfer = context.transfer;
  if (!transfer) return false;
  for (const completion of transfer.completed) {
    if (completion.outcome !== 'activated' || completion.entry.seq <= after.seq) continue;
    const authorized = transfer.authorizations.find((item) =>
      sameRef(item.entry, completion.authorization),
    );
    if (!authorized || authorized.statement.mode !== 'live' || authorized.statement.seat !== seat)
      continue;
    if (authorized.statement.currentController.publicKey !== key) return false;
    key = authorized.statement.destination.gamePeer;
  }
  return key === current;
}

function validateMasters(
  context: LogContext,
  masters: readonly Master[],
  seats: readonly Seat[],
): Result<void> {
  if (
    !context.crypto ||
    masters.length !== seats.length ||
    masters.some((item, i) => item.seat !== seats[i])
  )
    return failure('transfer-private-seats', 'Private packet has an incomplete affected set');
  for (const { seat, master } of masters) {
    const checked = verifyRevealedMaster(context.genesis, context.crypto.decks, seat, master);
    if (!checked.ok) return checked;
  }
  return success(undefined);
}

function wipeMasters(items: unknown): void {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (item && typeof item === 'object' && 'master' in item && item.master instanceof Uint8Array)
      item.master.fill(0);
  }
}

function wipePlaintext(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if ('masters' in value) wipeMasters(value.masters);
  if ('recoveryCustody' in value && Array.isArray(value.recoveryCustody))
    for (const item of value.recoveryCustody) {
      if (item && typeof item === 'object' && 'masters' in item) wipeMasters(item.masters);
    }
}

function decodePlaintext(
  bytes: Uint8Array,
  authorization: EntryRef,
  context: LogContext,
): Result<Plaintext> {
  let decoded: unknown;
  try {
    if (bytes.length > 4096) return failure('transfer-private-size', 'Opened packet is oversized');
    decoded = canonicalDecode(bytes);
    const parsed = v.safeParse(plaintextSchema, decoded);
    if (!parsed.success || !sameRef(parsed.output.authorization, authorization))
      return failure('transfer-private-plaintext', 'Opened private packet has wrong authorization');
    const approved = scope(context, authorization);
    if (!approved.ok) return approved;
    const checked = validateMasters(context, parsed.output.masters, affected(approved.value));
    if (!checked.ok) return checked;
    if (approved.value.statement.mode === 'return' && parsed.output.recoveryCustody.length !== 0)
      return failure('transfer-private-custody', 'Return packet cannot disclose recoverer custody');
    const seen = new Set<string>();
    for (const custody of parsed.output.recoveryCustody) {
      const key = `${custody.authorization.seq}:${custody.authorization.hash}:${custody.recipientSeat}`;
      if (seen.has(key)) return failure('transfer-private-custody', 'Repeated recovery custody');
      seen.add(key);
      const recovery = context.recovery?.authorizations.find((item) =>
        sameRef(item.entry, custody.authorization),
      );
      const completed = context.recovery?.completed.some((item) =>
        sameRef(item.authorization, custody.authorization),
      );
      const current = context.authority?.controllers.find(
        (item) => item.seat === custody.recipientSeat,
      );
      const activation = context.recovery?.completed.find((item) =>
        sameRef(item.authorization, custody.authorization),
      )?.activation;
      const recovererKey = recovery?.statement.recoverers.find(
        (item) => item.seat === custody.recipientSeat,
      )?.publicKey;
      const root = context.transfer?.returnRoots.find((item) =>
        sameRef(item.finalAuthorization, custody.authorization),
      );
      const departed = root && currentReturnRoot(context, root.departedSeat);
      const departedController =
        root && context.authority?.controllers.find((item) => item.seat === root.departedSeat);
      if (
        !recovery ||
        !completed ||
        approved.value.statement.mode !== 'live' ||
        custody.recipientSeat !== approved.value.statement.seat ||
        !current ||
        current.kind !== 'human' ||
        current.status !== 'active' ||
        !activation ||
        !recovererKey ||
        !root ||
        departed !== root ||
        !root.activation ||
        !sameRef(root.activation, activation) ||
        departedController?.kind !== 'bot' ||
        departedController.status !== 'active' ||
        !lawfulSuccessor(
          context,
          custody.recipientSeat,
          recovererKey,
          current.publicKey,
          activation,
        )
      )
        return failure('transfer-private-custody', 'Custody has no certified completed recovery');
      const valid = validateMasters(
        context,
        custody.masters,
        recovery.statement.replacements.map((item) => item.seat),
      );
      if (!valid.ok) return valid;
    }
    return success({
      protocol: parsed.output.protocol,
      authorization: { ...parsed.output.authorization },
      masters: parsed.output.masters.map(({ seat, master }) => ({
        seat,
        master: new Uint8Array(master),
      })),
      recoveryCustody: parsed.output.recoveryCustody.map((item) => ({
        authorization: { ...item.authorization },
        recipientSeat: item.recipientSeat,
        masters: item.masters.map(({ seat, master }) => ({ seat, master: new Uint8Array(master) })),
      })),
    });
  } catch {
    return failure('transfer-private-plaintext', 'Opened private packet is malformed');
  } finally {
    wipePlaintext(decoded);
  }
}

function wipeOwned(value: Plaintext): void {
  value.masters.forEach(({ master }) => master.fill(0));
  value.recoveryCustody.forEach((item) => item.masters.forEach(({ master }) => master.fill(0)));
}

function recordId(packet: TransferPrivateEnvelope): string {
  return `transfer-private/import/${packet.genesisDigest}/${packet.authorization.seq}-${packet.authorization.hash}/${packet.destinationGame}`;
}

function outboxId(context: LogContext, authorization: EntryRef, sourceSeat: Seat): string {
  return `transfer-private/outbox/${genesisDigest(context.genesis)}/${authorization.seq}-${authorization.hash}/${sourceSeat}`;
}

function historicalPrefix(genesis: LogEntry, entries: readonly CertifiedEntry[], ref: EntryRef) {
  if (ref.seq < 0 || ref.seq > entries.length) return null;
  const head = ref.seq === 0 ? genesis : entries[ref.seq - 1]?.entry;
  return head && entryHash(head) === ref.hash ? entries.slice(0, ref.seq) : null;
}

function stillPending(packet: TransferPrivateEnvelope, context: LogContext): Result<void> {
  const approved = scope(context, packet.authorization);
  if (!approved.ok) return approved;
  const statement = approved.value.statement;
  return packet.genesisDigest === statement.genesisDigest &&
    packet.destinationDevice === statement.destination.devicePeer &&
    packet.destinationGame === statement.destination.gamePeer &&
    packet.affectedSeats.length === statement.replacements.length &&
    packet.affectedSeats.every((seat, index) => seat === statement.replacements[index]?.seat)
    ? success(undefined)
    : failure('transfer-private-binding', 'Old packet does not match the pending authorization');
}

function verifyHistoricalPacket(
  packet: unknown,
  genesis: LogEntry,
  entries: readonly CertifiedEntry[],
  engine: Engine,
  policy: ReplayPolicy,
): Result<TransferPrivateEnvelope> {
  const parsed = v.safeParse(transferPrivateEnvelopeSchema, packet);
  if (!parsed.success)
    return failure('transfer-private-schema', 'Malformed transfer private packet');
  const prefix = historicalPrefix(genesis, entries, parsed.output.sourceParent);
  if (!prefix) return failure('transfer-private-history', 'Packet source parent is not certified');
  const replay = replayCertifiedPrefix(genesis, prefix, engine, policy);
  if (!replay.ok) return replay;
  return verifyTransferPrivateEnvelope(parsed.output, replay.value.context.log);
}

async function loadImportedCustody(input: {
  genesis: LogEntry;
  entries: readonly CertifiedEntry[];
  engine: Engine;
  policy: ReplayPolicy;
  context: LogContext;
  sourceSeat: Seat;
  store: TransferPrivateStore;
}): Promise<Result<Custody[]>> {
  const controller = input.context.authority?.controllers.find(
    (item) => item.seat === input.sourceSeat,
  );
  const completion = input.context.transfer?.completed.find(
    (item) =>
      item.outcome === 'activated' && controller && sameRef(item.entry, controller.activatedAt),
  );
  if (!completion) return success([]);
  const approved = input.context.transfer?.authorizations.find((item) =>
    sameRef(item.entry, completion.authorization),
  );
  if (!approved) return failure('transfer-private-custody', 'Prior import ancestry is missing');
  // A return import deliberately contains no recoverer custody.
  if (approved.statement.mode !== 'live') return success([]);
  const id = `transfer-private/import/${genesisDigest(input.context.genesis)}/${completion.authorization.seq}-${completion.authorization.hash}/${approved.statement.destination.gamePeer}`;
  let bytes: Uint8Array | null = null;
  let secret: Uint8Array | undefined;
  let opened: Uint8Array | undefined;
  let plain: Plaintext | undefined;
  let decoded: unknown;
  let canonicalRecord: Uint8Array | undefined;
  try {
    bytes = await input.store.load(id);
    if (!bytes || bytes.length > MAX_PACKET + 512)
      return failure('transfer-private-custody', 'Authenticated prior import record is missing');
    decoded = canonicalDecode(bytes);
    const record = v.safeParse(importRecordSchema, decoded);
    if (!record.success)
      return failure('transfer-private-custody', 'Prior import record is malformed');
    canonicalRecord = canonicalEncode(record.output);
    if (!sameBytes(bytes, canonicalRecord))
      return failure('transfer-private-custody', 'Prior import record is malformed');
    secret = record.output.encryptionSecret;
    const parsed = v.safeParse(transferPrivateEnvelopeSchema, record.output.packet);
    if (
      !parsed.success ||
      !sameRef(parsed.output.authorization, completion.authorization) ||
      parsed.output.destinationGame !== approved.statement.destination.gamePeer
    )
      return failure(
        'transfer-private-custody',
        'Prior import packet differs from certified activation',
      );
    const prefix = historicalPrefix(input.genesis, input.entries, parsed.output.sourceParent);
    if (!prefix) return failure('transfer-private-custody', 'Prior import parent is unavailable');
    const replay = replayCertifiedPrefix(input.genesis, prefix, input.engine, input.policy);
    if (!replay.ok) return replay;
    const verified = verifyTransferPrivateEnvelope(parsed.output, replay.value.context.log);
    if (!verified.ok) return verified;
    opened = openSealed(
      parsed.output.sealed,
      scalarFromBytes(secret, { nonzero: true }),
      sealContext(parsed.output, approved.statement.destination.transferEncryptionKey),
    );
    const decodedPlain = decodePlaintext(
      opened,
      completion.authorization,
      replay.value.context.log,
    );
    if (!decodedPlain.ok) return decodedPlain;
    plain = decodedPlain.value;
    const custody = plain.recoveryCustody.map((item) => ({
      authorization: { ...item.authorization },
      recipientSeat: item.recipientSeat,
      masters: item.masters.map(({ seat, master }) => ({ seat, master: new Uint8Array(master) })),
    }));
    return success(custody);
  } catch {
    return failure('transfer-private-custody', 'Prior import cannot be authenticated or opened');
  } finally {
    if (plain) wipeOwned(plain);
    opened?.fill(0);
    if (
      decoded &&
      typeof decoded === 'object' &&
      'encryptionSecret' in decoded &&
      decoded.encryptionSecret instanceof Uint8Array
    )
      decoded.encryptionSecret.fill(0);
    canonicalRecord?.fill(0);
    secret?.fill(0);
    bytes?.fill(0);
  }
}

async function collectCustody(input: {
  genesis: LogEntry;
  entries: readonly CertifiedEntry[];
  engine: Engine;
  policy: ReplayPolicy;
  context: LogContext;
  sourceSeat: Seat;
  recoveryPrivateStore: RecoveryPrivateStore | undefined;
  importStore: TransferPrivateStore | undefined;
  onlyAuthorization?: EntryRef;
}): Promise<Result<Custody[]>> {
  const prior = input.importStore
    ? await loadImportedCustody({ ...input, store: input.importStore })
    : success([] as Custody[]);
  if (!prior.ok) return prior;
  const custody = prior.value.filter((item) => {
    const root = input.context.transfer?.returnRoots.find((candidate) =>
      sameRef(candidate.finalAuthorization, item.authorization),
    );
    const latest = root && currentReturnRoot(input.context, root.departedSeat);
    const departed =
      root &&
      input.context.authority?.controllers.find(
        (candidate) => candidate.seat === root.departedSeat,
      );
    const keep =
      (!input.onlyAuthorization || sameRef(item.authorization, input.onlyAuthorization)) &&
      root &&
      latest === root &&
      root.activation &&
      departed?.kind === 'bot' &&
      departed.status === 'active';
    if (!keep) item.masters.forEach(({ master }) => master.fill(0));
    return Boolean(keep);
  });
  const sourceController = input.context.authority?.controllers.find(
    (item) => item.seat === input.sourceSeat,
  );
  const priorLive = input.context.transfer?.completed.some(
    (completion) =>
      completion.outcome === 'activated' &&
      sourceController &&
      sameRef(completion.entry, sourceController.activatedAt) &&
      input.context.transfer?.authorizations.some(
        (authorization) =>
          sameRef(authorization.entry, completion.authorization) &&
          authorization.statement.mode === 'live' &&
          authorization.statement.seat === input.sourceSeat,
      ),
  );
  if (priorLive && !input.importStore) {
    custody.forEach((item) => item.masters.forEach(({ master }) => master.fill(0)));
    return failure(
      'transfer-private-custody',
      'Transferred recoverer requires authenticated prior import',
    );
  }
  let retained = false;
  try {
    // Every root is certified. Only its final authorization is useful; stale
    // roots for a newer generation cannot confer return custody.
    for (const root of input.context.transfer?.returnRoots ?? []) {
      if (
        (input.onlyAuthorization && !sameRef(root.finalAuthorization, input.onlyAuthorization)) ||
        !root.activation ||
        currentReturnRoot(input.context, root.departedSeat) !== root ||
        !input.context.authority?.controllers.some(
          (item) =>
            item.seat === root.departedSeat && item.kind === 'bot' && item.status === 'active',
        )
      )
        continue;
      const recoverer = input.context.recovery?.authorizations
        .find((item) => sameRef(item.entry, root.finalAuthorization))
        ?.statement.recoverers.find((item) => item.seat === input.sourceSeat);
      if (!recoverer) continue;
      const current = input.context.authority?.controllers.find(
        (item) => item.seat === input.sourceSeat,
      );
      if (
        !current ||
        !lawfulSuccessor(
          input.context,
          input.sourceSeat,
          recoverer.publicKey,
          current.publicKey,
          root.activation,
        )
      )
        continue;
      const key = `${root.finalAuthorization.seq}:${root.finalAuthorization.hash}:${input.sourceSeat}`;
      if (
        custody.some(
          (item) =>
            `${item.authorization.seq}:${item.authorization.hash}:${item.recipientSeat}` === key,
        )
      )
        continue;
      if (!input.recoveryPrivateStore)
        return failure('transfer-private-custody', 'Recovery private store is required');
      const prefix = historicalPrefix(input.genesis, input.entries, root.activation);
      if (!prefix)
        return failure('transfer-private-custody', 'Recovery activation ancestry is unavailable');
      const replay = replayCertifiedPrefix(input.genesis, prefix, input.engine, input.policy);
      if (!replay.ok) return replay;
      // Certified roots are processed in order; each owned secret is disposed before the next load.
      // oxlint-disable-next-line eslint/no-await-in-loop
      const loaded = await loadRecoveryPrivate(
        replay.value.context.log,
        root.finalAuthorization,
        input.sourceSeat,
        input.recoveryPrivateStore,
      );
      if (!loaded.ok) return loaded;
      try {
        custody.push({
          authorization: { ...root.finalAuthorization },
          recipientSeat: input.sourceSeat,
          masters: loaded.value.secrets.map(({ seat, master }) => ({
            seat,
            master: new Uint8Array(master),
          })),
        });
      } finally {
        loaded.value.dispose();
      }
    }
    if (custody.length > 6) return failure('transfer-private-custody', 'Too many custody records');
    retained = true;
    return success(custody);
  } catch {
    return failure('transfer-private-custody', 'Custody history could not be loaded');
  } finally {
    if (!retained) custody.forEach((item) => item.masters.forEach(({ master }) => master.fill(0)));
  }
}

export async function prepareTransferPrivate(input: {
  readonly journal: ProtocolJournal;
  readonly engine: Engine;
  readonly policy: ReplayPolicy;
  readonly authorization: EntryRef;
  readonly sourceSeat: Seat;
  readonly sourceKind: 'current-controller' | 'certified-device';
  readonly signingKey: Uint8Array;
  readonly entropy: Uint8Array;
  readonly nonce: Uint8Array;
  readonly masters?: readonly Master[];
  readonly outbox: TransferPrivateStore;
  readonly recoveryPrivateStore?: RecoveryPrivateStore;
  readonly importStore?: TransferPrivateStore;
}): Promise<Result<TransferPrivateEnvelope>> {
  const authorization = { ...input.authorization };
  const sourceSeat = input.sourceSeat;
  const sourceKind = input.sourceKind;
  let signingKey = new Uint8Array(0);
  let entropy = new Uint8Array(0);
  let nonce = new Uint8Array(0);
  const supplied: Master[] = [];
  const hasSuppliedMasters = input.masters !== undefined;
  const { journal, engine, policy, outbox, recoveryPrivateStore, importStore } = input;
  let recordBytes: Uint8Array | null = null;
  let priorBytes: Uint8Array | null = null;
  let encoded: Uint8Array | undefined;
  let plaintextBytes: Uint8Array | undefined;
  let plaintext: Plaintext | undefined;
  let collectedCustody: Custody[] | undefined;
  try {
    if (
      ![input.signingKey, input.entropy, input.nonce].every(
        (bytes) => bytes instanceof Uint8Array && bytes.length === 32,
      )
    )
      return failure('transfer-private-key', 'Signing key, entropy and nonce must be 32 bytes');
    signingKey = new Uint8Array(input.signingKey);
    entropy = new Uint8Array(input.entropy);
    nonce = new Uint8Array(input.nonce);
    if (hasSuppliedMasters) {
      if (!Array.isArray(input.masters) || input.masters.length < 1 || input.masters.length > 6)
        return failure('transfer-private-masters', 'Supply one through six owned masters');
      for (const item of input.masters) {
        if (!(item?.master instanceof Uint8Array) || item.master.length !== 32)
          return failure('transfer-private-masters', 'Owned master must be 32 bytes');
        supplied.push({ seat: item.seat, master: new Uint8Array(item.master) });
      }
    }
    const record = await journal.load();
    if (!record || record.height !== record.entries.length + 1)
      return failure('transfer-private-history', 'Authoritative journal is missing or incomplete');
    const replay = replayCertifiedPrefix(record.genesis, record.entries, engine, policy);
    if (!replay.ok) return replay;
    const context = replay.value.context.log;
    const approved = scope(context, authorization);
    if (!approved.ok) return approved;
    const identity = identityFromSecret(signingKey);
    const signer = identity.peerId;
    identity.secretKey.fill(0);
    identity.publicKey.fill(0);
    const source = authorizeSource(context, approved.value, sourceSeat, sourceKind, signer);
    if (!source.ok) return source;
    const id = outboxId(context, authorization, sourceSeat);
    priorBytes = await outbox.load(id);
    if (priorBytes) {
      if (priorBytes.length > MAX_PACKET)
        return failure('transfer-private-outbox', 'Saved packet is oversized');
      const packet = canonicalDecode(priorBytes);
      const verified = verifyHistoricalPacket(
        packet,
        record.genesis,
        record.entries,
        engine,
        policy,
      );
      if (!verified.ok) return verified;
      const pending = stillPending(verified.value, context);
      if (!pending.ok) return pending;
      if (verified.value.sourceSeat !== sourceSeat)
        return failure('transfer-private-outbox', 'Saved packet has a different source seat');
      const latest = await journal.load();
      if (
        !latest ||
        latest.height !== record.height ||
        entryHash(latest.genesis) !== entryHash(record.genesis) ||
        entryHash(latest.entries.at(-1)?.entry ?? latest.genesis) !== entryHash(context.head) ||
        !sameBytes(latest.safety.bytes, record.safety.bytes) ||
        latest.safety.revision !== record.safety.revision
      )
        return failure(
          'transfer-private-stale',
          'Certified parent changed during private delivery',
        );
      return success(verified.value);
    }
    const statement = approved.value.statement;
    let masters: Master[];
    let custody: Custody[];
    if (statement.mode === 'live') {
      if (!hasSuppliedMasters)
        return failure('transfer-private-masters', 'Live owner masters are required');
      masters = supplied;
      const collected = await collectCustody({
        genesis: record.genesis,
        entries: record.entries,
        engine,
        policy,
        context,
        sourceSeat,
        recoveryPrivateStore,
        importStore,
      });
      if (!collected.ok) return collected;
      custody = collected.value;
      collectedCustody = custody;
    } else {
      if (!statement.recovery)
        return failure('transfer-private-custody', 'Return recovery reference is missing');
      if (hasSuppliedMasters)
        return failure(
          'transfer-private-masters',
          'Return masters require authenticated recovery custody',
        );
      const collected = await collectCustody({
        genesis: record.genesis,
        entries: record.entries,
        engine,
        policy,
        context,
        sourceSeat,
        recoveryPrivateStore,
        importStore,
        onlyAuthorization: statement.recovery.authorization,
      });
      if (!collected.ok) return collected;
      custody = collected.value;
      collectedCustody = custody;
      const recovery = statement.recovery;
      const held = custody.find(
        (item) =>
          recovery &&
          sameRef(item.authorization, recovery.authorization) &&
          item.recipientSeat === sourceSeat,
      );
      if (!held)
        return failure(
          'transfer-private-custody',
          'Exact completed recovery custody is unavailable',
        );
      masters = affected(approved.value).flatMap((seat) => {
        const item = held.masters.find((candidate) => candidate.seat === seat);
        return item ? [{ seat, master: new Uint8Array(item.master) }] : [];
      });
      custody.forEach((item) => item.masters.forEach(({ master }) => master.fill(0)));
      custody = [];
    }
    plaintext = {
      protocol: 'seat-transfer-private-plaintext-v1',
      authorization,
      masters,
      recoveryCustody: custody,
    };
    const checked = validateMasters(context, masters, affected(approved.value));
    if (!checked.ok) return checked;
    plaintextBytes = canonicalEncode(plaintext);
    if (plaintextBytes.length > 4096)
      return failure('transfer-private-size', 'Private material exceeds sealed limit');
    const base = {
      genesisDigest: genesisDigest(context.genesis),
      authorization,
      sourceParent: transferEntryRef(context.head),
      sourceSeat,
      sourceSigner: { kind: sourceKind, publicKey: signer },
      destinationDevice: statement.destination.devicePeer,
      destinationGame: statement.destination.gamePeer,
      affectedSeats: affected(approved.value),
      nonce: toBase64Url(nonce),
    };
    const sealed = seal(
      plaintextBytes,
      statement.destination.transferEncryptionKey,
      entropy,
      sealContext(base, statement.destination.transferEncryptionKey),
    );
    const body = {
      protocol: 'seat-transfer-private-v1' as const,
      ...base,
      sealed,
      ciphertextHash: packetHash(sealed),
    };
    const packet = v.parse(transferPrivateEnvelopeSchema, {
      ...body,
      sourceSig: signObject(TRANSFER_PRIVATE_DOMAIN, body, signingKey),
    });
    encoded = canonicalEncode(packet);
    if (encoded.length > MAX_PACKET)
      return failure('transfer-private-size', 'Signed packet is oversized');
    if (!(await outbox.putIfAbsent(id, encoded))) {
      recordBytes = await outbox.load(id);
      if (!recordBytes || !sameBytes(recordBytes, encoded))
        return failure(
          'transfer-private-outbox',
          'Different packet occupies immutable outbox slot',
        );
    }
    const latest = await journal.load();
    if (
      !latest ||
      latest.height !== record.height ||
      entryHash(latest.genesis) !== entryHash(record.genesis) ||
      entryHash(latest.entries.at(-1)?.entry ?? latest.genesis) !== entryHash(context.head) ||
      !sameBytes(latest.safety.bytes, record.safety.bytes) ||
      latest.safety.revision !== record.safety.revision
    )
      return failure('transfer-private-stale', 'Certified parent changed during private delivery');
    return success(packet);
  } catch {
    return failure('transfer-private-error', 'Private transfer packet could not be prepared');
  } finally {
    signingKey.fill(0);
    entropy.fill(0);
    nonce.fill(0);
    supplied?.forEach(({ master }) => master.fill(0));
    if (plaintext) wipeOwned(plaintext);
    collectedCustody?.forEach((item) => item.masters.forEach(({ master }) => master.fill(0)));
    plaintextBytes?.fill(0);
    encoded?.fill(0);
    recordBytes?.fill(0);
    priorBytes?.fill(0);
  }
}

export async function importTransferPrivate(input: {
  readonly genesisEntry: unknown;
  readonly entries: readonly unknown[];
  readonly engine: Engine;
  readonly policy: ReplayPolicy;
  readonly authorization: EntryRef;
  readonly packet: unknown;
  readonly destinationEncryptionSecret: Uint8Array;
  readonly importStore: TransferPrivateStore;
}): Promise<Result<ImportedTransferPrivate>> {
  let secret = new Uint8Array(0);
  const authorization = { ...input.authorization };
  const { engine, policy, importStore } = input;
  let opened: Uint8Array | undefined;
  let plain: Plaintext | undefined;
  let encoded: Uint8Array | undefined;
  let prior: Uint8Array | null = null;
  let rebuilt: ReconstructedPrivateSeats | undefined;
  try {
    const authenticated = authenticateEnvelope(input.packet);
    if (!authenticated.ok) return authenticated;
    if (
      !(input.destinationEncryptionSecret instanceof Uint8Array) ||
      input.destinationEncryptionSecret.length !== 32
    )
      return failure('transfer-private-key', 'Destination encryption key must be 32 bytes');
    secret = new Uint8Array(input.destinationEncryptionSecret);
    let sourceContext: LogContext | undefined;
    const replay = replayCertifiedPrefix(
      input.genesisEntry,
      input.entries,
      engine,
      policy,
      (_entry, next) => {
        if (sameRef(transferEntryRef(next.log.head), authenticated.value.sourceParent))
          sourceContext = next.log;
        return success(undefined);
      },
    );
    if (!replay.ok) return replay;
    if (!sourceContext)
      return failure('transfer-private-history', 'Packet source parent is not certified');
    const context = replay.value.context.log;
    const verified = verifyTransferPrivateEnvelope(authenticated.value, sourceContext);
    if (!verified.ok) return verified;
    const packet = verified.value;
    const pending = stillPending(packet, context);
    if (!pending.ok) return pending;
    if (!sameRef(packet.authorization, authorization))
      return failure('transfer-private-binding', 'Import authorization differs from packet');
    const statement = context.transfer?.authorizations.find((item) =>
      sameRef(item.entry, authorization),
    )?.statement;
    if (!statement || secret.length !== 32)
      return failure('transfer-private-key', 'Destination encryption key is missing');
    const scalar = scalarFromBytes(secret, { nonzero: true });
    const point = encodePoint(scalePoint(G, scalar));
    if (point !== statement.destination.transferEncryptionKey)
      return failure(
        'transfer-private-key',
        'Destination key differs from certified authorization',
      );
    opened = openSealed(packet.sealed, scalar, sealContext(packet, point));
    const decoded = decodePlaintext(opened, authorization, context);
    if (!decoded.ok) return decoded;
    plain = decoded.value;
    rebuilt = (() => {
      const result = reconstructPrivateSeats({
        genesisEntry: input.genesisEntry,
        entries: input.entries,
        engine,
        policy,
        secrets: plain?.masters ?? [],
      });
      return result.ok ? result.value : undefined;
    })();
    if (!rebuilt)
      return failure(
        'transfer-private-replay',
        'Imported private hands failed certified reconstruction',
      );
    const storeRecord = {
      protocol: 'seat-transfer-private-import-v1',
      packet,
      encryptionSecret: secret,
    };
    encoded = canonicalEncode(storeRecord);
    const id = recordId(packet);
    if (!(await importStore.putIfAbsent(id, encoded))) {
      prior = await importStore.load(id);
      if (!prior || !sameBytes(prior, encoded))
        return failure(
          'transfer-private-import',
          'Different immutable import occupies this destination',
        );
    }
    const masters = plain.masters.map(({ seat, master }) => ({
      seat,
      master: new Uint8Array(master),
    }));
    const retained = rebuilt;
    rebuilt = undefined;
    return success({
      context: retained.context,
      driver: retained.driver,
      masters,
      releaseSeat(seat) {
        masters.find((item) => item.seat === seat)?.master.fill(0);
        retained.releaseSeat(seat);
      },
      dispose() {
        masters.forEach(({ master }) => master.fill(0));
        retained.dispose();
      },
    });
  } catch {
    return failure(
      'transfer-private-import',
      'Private import could not be authenticated or retained',
    );
  } finally {
    rebuilt?.dispose();
    if (plain) wipeOwned(plain);
    opened?.fill(0);
    encoded?.fill(0);
    prior?.fill(0);
    secret.fill(0);
  }
}
