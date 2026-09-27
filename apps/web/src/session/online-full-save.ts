import { canonicalDecode, canonicalEncode, sha256, toHex } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import {
  deckCeremonyId,
  replayCertifiedPrefix,
  restoreConsensusState,
  restoreRetiredSafety,
  entryHash,
  validateDeckCeremony,
  validateGenesisEscrow,
  verifyRevealedMaster,
  EscrowCeremony,
} from '@cp2p/protocol';
import type { EscrowCeremonyStore, ProposalContext, ProtocolJournal } from '@cp2p/protocol';
import { createBaseEngine } from '@cp2p/engine';
import * as v from 'valibot';
import {
  MAX_ONLINE_PUBLIC_ARCHIVE_BYTES,
  encodeOnlinePublicArchive,
  validateOnlinePublicArchive,
} from './online-public-archive.js';
import type { VerifiedPublicOnlineArchive } from './online-public-archive.js';
import type { SavedOnlineGameRecord } from './online-game-records.js';
import { boundedCanonicalJsonStructure } from './bounded-canonical-json.js';

const FORMAT = 'online-full-save-v1';
const PRIVATE_FORMAT = 'online-full-save-private-v1';
/** Canonical byte tags expand the 16 MiB HXAR1 segment before this whole-file cap. */
export const MAX_ONLINE_FULL_SAVE_BYTES = 25 * 1024 * 1024;
const MAX_PRIVATE_BYTES = 1024 * 1024;
const MAX_SAFETY_BYTES = 1024 * 1024;
const PBKDF2_ITERATIONS = 600_000;
const MIN_PASSPHRASE_LENGTH = 12;
const MAX_PASSPHRASE_LENGTH = 1024;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const SEATS = [0, 1, 2, 3, 4, 5] as const;
const hashSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));
const seatSchema = v.picklist(SEATS);
const bytesSchema = v.custom<Uint8Array>((value) => value instanceof Uint8Array);
const bytes32Schema = v.custom<Uint8Array>(
  (value) => value instanceof Uint8Array && value.length === KEY_BYTES,
);
const safetySchema = v.strictObject({
  revision: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  seat: seatSchema,
  publicKey: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/)),
  bytes: bytesSchema,
});
const cipherSchema = v.strictObject({
  kdf: v.literal('PBKDF2-SHA256'),
  iterations: v.literal(PBKDF2_ITERATIONS),
  salt: v.custom<Uint8Array>((value) => value instanceof Uint8Array && value.length === SALT_BYTES),
  nonce: v.custom<Uint8Array>(
    (value) => value instanceof Uint8Array && value.length === NONCE_BYTES,
  ),
  ciphertext: bytesSchema,
});
const saveSchema = v.strictObject({
  format: v.literal(FORMAT),
  gameId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22}$/)),
  genesisDigest: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/)),
  publicHash: hashSchema,
  publicArchive: bytesSchema,
  safety: safetySchema,
  private: v.nullable(cipherSchema),
});
const privateSchema = v.strictObject({
  format: v.literal(PRIVATE_FORMAT),
  gameId: saveSchema.entries.gameId,
  genesisDigest: saveSchema.entries.genesisDigest,
  publicHash: hashSchema,
  safetyHash: hashSchema,
  holderSeat: seatSchema,
  escrowComplete: v.boolean(),
  masters: v.pipe(
    v.array(v.strictObject({ seat: seatSchema, master: bytes32Schema })),
    v.maxLength(6),
  ),
  escrow: v.pipe(
    v.array(v.strictObject({ dealerSeat: seatSchema, holderSeat: seatSchema, bytes: bytesSchema })),
    v.maxLength(36),
  ),
});

export interface HistoricalOnlineSafety {
  readonly revision: number;
  readonly seat: Seat;
  readonly publicKey: string;
  readonly bytes: Uint8Array;
}

export interface OwnedFullSavePrivate {
  readonly holderSeat: Seat;
  /** False means this package cannot restore the original accepted-share inventory. */
  readonly escrowComplete: boolean;
  readonly masters: readonly { readonly seat: Seat; readonly master: Uint8Array }[];
  readonly escrow: readonly {
    readonly dealerSeat: Seat;
    readonly holderSeat: Seat;
    readonly bytes: Uint8Array;
  }[];
  dispose(): void;
}

export interface VerifiedOnlineFullSave {
  readonly id: string;
  readonly public: VerifiedPublicOnlineArchive;
  /** This is evidence of prior local safety, never authority to vote on import. */
  readonly safety: HistoricalOnlineSafety;
  readonly private: OwnedFullSavePrivate | null;
  readonly privateLocked: boolean;
  readonly mode: 'read-only-paused';
  dispose(): void;
}

export interface FullSavePrivateInventory {
  readonly publicArchive: Uint8Array;
  readonly safety: HistoricalOnlineSafety;
  readonly localSeat: Seat;
  /** Returns a fresh owned buffer, or null if the master is unavailable. */
  readonly loadOwnedMaster: (seat: Seat) => Promise<Uint8Array | null>;
  readonly escrowStore?: EscrowCeremonyStore;
  /** Defaults to true; false deliberately exports masters without accepted shares. */
  readonly includeEscrow?: boolean;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** The decrypted capsule has a bounded shape; only its byte tags need erasure. */
function wipePrivateDecoded(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as { masters?: unknown; escrow?: unknown };
  if (Array.isArray(record.masters) && record.masters.length <= 6) {
    for (const item of record.masters) {
      if (item && typeof item === 'object' && 'master' in item && item.master instanceof Uint8Array)
        item.master.fill(0);
    }
  }
  if (Array.isArray(record.escrow) && record.escrow.length <= 36) {
    for (const item of record.escrow) {
      if (item && typeof item === 'object' && 'bytes' in item && item.bytes instanceof Uint8Array)
        item.bytes.fill(0);
    }
  }
}

function historicalSafetyHash(safety: HistoricalOnlineSafety): string {
  return toHex(sha256(canonicalEncode(safety)));
}

function contextFor(archive: VerifiedPublicOnlineArchive): Result<ProposalContext> {
  const engine = createBaseEngine();
  const replay = replayCertifiedPrefix(archive.start.result.entry, archive.entries, engine, {
    genesis: {
      verifyCommitments(genesis) {
        const checked = validateDeckCeremony(genesis, archive.start.result.transcripts);
        return checked.ok ? success(undefined) : checked;
      },
    },
    entry: {},
  });
  return replay.ok ? success(replay.value.context) : replay;
}

function checkedSafety(context: ProposalContext, safety: HistoricalOnlineSafety): Result<void> {
  if (safety.bytes.length < 1 || safety.bytes.length > MAX_SAFETY_BYTES)
    return failure('full-save-safety-size', 'Historical safety record is missing or oversized');
  if (!boundedCanonicalJsonStructure(safety.bytes, 100_000))
    return failure('full-save-safety', 'Historical safety structure exceeds its limits');
  try {
    const decoded: unknown = canonicalDecode(safety.bytes);
    if (!sameBytes(safety.bytes, canonicalEncode(decoded)))
      return failure('full-save-safety', 'Historical safety record is not canonical');
    const active = context.membership.voters.some(
      (voter) => voter.seat === safety.seat && voter.publicKey === safety.publicKey,
    );
    const restored = active
      ? restoreConsensusState(decoded, context, safety.seat)
      : restoreRetiredSafety(decoded, context, safety.seat, safety.publicKey);
    if (!restored.ok) return restored;
    return success(undefined);
  } catch {
    return failure('full-save-safety', 'Historical safety record is malformed');
  }
}

function ownedPrivate(value: v.InferOutput<typeof privateSchema>): OwnedFullSavePrivate {
  let disposed = false;
  return {
    holderSeat: value.holderSeat,
    escrowComplete: value.escrowComplete,
    masters: value.masters,
    escrow: value.escrow,
    dispose() {
      if (disposed) return;
      disposed = true;
      value.masters.forEach(({ master }) => master.fill(0));
      value.escrow.forEach(({ bytes }) => bytes.fill(0));
    },
  };
}

function privateBinding(
  archive: VerifiedPublicOnlineArchive,
  safety: HistoricalOnlineSafety,
  holderSeat: Seat,
  escrowComplete: boolean,
  masters: OwnedFullSavePrivate['masters'],
  escrow: OwnedFullSavePrivate['escrow'],
) {
  return {
    format: PRIVATE_FORMAT,
    gameId: archive.gameId,
    genesisDigest: archive.genesisDigest,
    publicHash: archive.id,
    safetyHash: historicalSafetyHash(safety),
    holderSeat,
    escrowComplete,
    masters,
    escrow,
  } as const;
}

async function checkedPrivate(
  value: v.InferOutput<typeof privateSchema>,
  archive: VerifiedPublicOnlineArchive,
  context: ProposalContext,
  safety: HistoricalOnlineSafety,
): Promise<Result<void>> {
  const crypto = context.log.crypto;
  if (!crypto) return failure('full-save-private', 'Certified private context is missing');
  if (
    value.gameId !== archive.gameId ||
    value.genesisDigest !== archive.genesisDigest ||
    value.publicHash !== archive.id ||
    value.safetyHash !== historicalSafetyHash(safety) ||
    value.holderSeat !== safety.seat ||
    new Set(value.masters.map(({ seat }) => seat)).size !== value.masters.length ||
    new Set(value.escrow.map(({ dealerSeat, holderSeat }) => `${dealerSeat}/${holderSeat}`))
      .size !== value.escrow.length
  )
    return failure('full-save-private-binding', 'Private material differs from the certified game');
  const hosted =
    context.log.authority?.controllers
      .filter(({ hostSeat, status }) => hostSeat === value.holderSeat && status === 'active')
      .map(({ seat }) => seat) ?? [];
  if (
    !context.membership.voters.some(
      ({ seat, publicKey }) => seat === value.holderSeat && publicKey === safety.publicKey,
    ) ||
    hosted.length !== value.masters.length ||
    hosted.some((seat, index) => value.masters[index]?.seat !== seat)
  )
    return failure('full-save-private-owner', 'Private masters differ from current hosted seats');
  for (const { seat, master } of value.masters) {
    const checked = verifyRevealedMaster(context.log.genesis, crypto.decks, seat, master);
    if (!checked.ok) return checked;
  }
  const transcript = validateGenesisEscrow(context.log.genesis);
  if (!transcript.ok) return transcript;
  const expectedEscrow = transcript.value.flatMap((dealer) =>
    dealer.shares.filter(({ envelope }) => envelope.body.holder.seat === value.holderSeat),
  );
  if (
    (value.escrowComplete && value.escrow.length !== expectedEscrow.length) ||
    (!value.escrowComplete && value.escrow.length !== 0)
  )
    return failure('full-save-escrow', 'Accepted-share inventory is incomplete or mislabeled');
  if (value.escrow.length === 0) return success(undefined);
  const records = new Map<string, Uint8Array>();
  const openedCopies: Uint8Array[] = [];
  const ceremonyId = deckCeremonyId(context.log.genesis);
  for (const item of value.escrow) {
    if (item.holderSeat !== value.holderSeat || item.bytes.length > 16_384)
      return failure('full-save-escrow', 'Escrow record has an invalid holder or size');
    records.set(`escrow-accepted/${ceremonyId}/${item.dealerSeat}/${item.holderSeat}`, item.bytes);
  }
  const store: EscrowCeremonyStore = {
    async load(id) {
      const source = records.get(id);
      if (!source) return null;
      const copy = new Uint8Array(source);
      openedCopies.push(copy);
      return copy;
    },
    async putIfAbsent() {
      return false;
    },
    async compareAndSwap() {
      return false;
    },
    async withCeremonyLock(_id, task) {
      return task();
    },
  };
  const ceremony = new EscrowCeremony(context.log.genesis, store);
  try {
    for (const item of value.escrow) {
      const envelope = transcript.value
        .find(({ dealerSeat }) => dealerSeat === item.dealerSeat)
        ?.shares.find(
          ({ envelope: candidate }) => candidate.body.holder.seat === item.holderSeat,
        )?.envelope;
      if (!envelope)
        return failure('full-save-escrow', 'Escrow record has no signed genesis delivery');
      // oxlint-disable-next-line no-await-in-loop -- Each bounded share is validated against its own signed envelope.
      const checked = await ceremony.loadAcceptedShare(envelope);
      if (!checked.ok) return checked;
    }
    return success(undefined);
  } finally {
    openedCopies.forEach((copy) => copy.fill(0));
  }
}

/** Inventories only current locally hosted masters and optionally original accepted shares. */
export async function collectOnlineFullSavePrivate(
  input: FullSavePrivateInventory,
): Promise<Result<OwnedFullSavePrivate>> {
  if (
    !(input.publicArchive instanceof Uint8Array) ||
    input.publicArchive.length > MAX_ONLINE_PUBLIC_ARCHIVE_BYTES ||
    !(input.safety.bytes instanceof Uint8Array) ||
    input.safety.bytes.length > MAX_SAFETY_BYTES
  )
    return failure('full-save-size', 'Private inventory input exceeds its size limit');
  const publicArchive = new Uint8Array(input.publicArchive);
  const localSeat = input.localSeat;
  const safetyRecord = { ...input.safety, bytes: new Uint8Array(input.safety.bytes) };
  const { loadOwnedMaster, escrowStore } = input;
  const includeEscrow = input.includeEscrow ?? true;
  const archive = validateOnlinePublicArchive(publicArchive);
  if (!archive.ok) return archive;
  const replayed = contextFor(archive.value);
  if (!replayed.ok) return replayed;
  const context = replayed.value;
  const safety = checkedSafety(context, safetyRecord);
  if (!safety.ok) return safety;
  const self = context.log.authority?.controllers.find(({ seat }) => seat === localSeat);
  if (!self || self.kind !== 'human' || self.status !== 'active')
    return failure('full-save-owner', 'Only a current human may inventory local private material');
  const masters: { seat: Seat; master: Uint8Array }[] = [];
  const escrow: { dealerSeat: Seat; holderSeat: Seat; bytes: Uint8Array }[] = [];
  let retained = false;
  try {
    for (const controller of context.log.authority?.controllers ?? []) {
      if (controller.hostSeat !== localSeat || controller.status !== 'active') continue;
      // oxlint-disable-next-line no-await-in-loop -- Bounded to six seats; sources may own fresh buffers.
      const loaded = await loadOwnedMaster(controller.seat);
      if (!loaded) return failure('full-save-master', 'A locally hosted master is unavailable');
      try {
        if (!(loaded instanceof Uint8Array) || loaded.length !== 32)
          return failure('full-save-master', 'A locally hosted master is malformed');
        if (!context.log.crypto)
          return failure('full-save-private', 'Certified private context is missing');
        const checked = verifyRevealedMaster(
          context.log.genesis,
          context.log.crypto.decks,
          controller.seat,
          loaded,
        );
        if (!checked.ok) return checked;
        masters.push({ seat: controller.seat, master: new Uint8Array(loaded) });
      } finally {
        loaded.fill(0);
      }
    }
    if (includeEscrow) {
      if (!escrowStore)
        return failure('full-save-escrow', 'Escrow storage is required for private inventory');
      const transcript = validateGenesisEscrow(context.log.genesis);
      if (!transcript.ok) return transcript;
      const ceremonyId = deckCeremonyId(context.log.genesis);
      for (const dealer of transcript.value) {
        const delivery = dealer.shares.find(
          ({ envelope }) => envelope.body.holder.seat === localSeat,
        );
        if (!delivery) continue;
        const id = `escrow-accepted/${ceremonyId}/${dealer.dealerSeat}/${localSeat}`;
        // oxlint-disable-next-line no-await-in-loop -- Each expected immutable share is loaded by its signed roster slot.
        const bytes = await escrowStore.load(id);
        if (!bytes) return failure('full-save-escrow', 'A required accepted share is missing');
        escrow.push({
          dealerSeat: dealer.dealerSeat,
          holderSeat: localSeat,
          bytes: new Uint8Array(bytes),
        });
      }
    }
    const value = v.parse(
      privateSchema,
      privateBinding(archive.value, safetyRecord, localSeat, includeEscrow, masters, escrow),
    );
    const verified = await checkedPrivate(value, archive.value, context, safetyRecord);
    if (!verified.ok) return verified;
    retained = true;
    return success(ownedPrivate(value));
  } catch {
    return failure('full-save-private', 'Private inventory could not be validated');
  } finally {
    safetyRecord.bytes.fill(0);
    publicArchive.fill(0);
    if (!retained) {
      masters.forEach(({ master }) => master.fill(0));
      escrow.forEach(({ bytes }) => bytes.fill(0));
    }
  }
}

let derivingKey = false;

class FullSaveBusyError extends Error {}

function validPassphrase(passphrase: string): boolean {
  return passphrase.length >= MIN_PASSPHRASE_LENGTH && passphrase.length <= MAX_PASSPHRASE_LENGTH;
}

async function cryptoKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  if (derivingKey) throw new FullSaveBusyError('A full-save key derivation is already running');
  derivingKey = true;
  const passphraseBytes = new TextEncoder().encode(passphrase);
  try {
    const imported = await crypto.subtle.importKey('raw', passphraseBytes, 'PBKDF2', false, [
      'deriveKey',
    ]);
    return await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: new Uint8Array(salt),
        iterations: PBKDF2_ITERATIONS,
      },
      imported,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    passphraseBytes.fill(0);
    derivingKey = false;
  }
}

function aad(archive: VerifiedPublicOnlineArchive, safety: HistoricalOnlineSafety): Uint8Array {
  return canonicalEncode({
    format: FORMAT,
    gameId: archive.gameId,
    genesisDigest: archive.genesisDigest,
    publicHash: archive.id,
    safetyHash: historicalSafetyHash(safety),
  });
}

/** Produces a portable file; neither private capsule nor safety can install a voting key. */
export async function encodeOnlineFullSave(input: {
  readonly publicArchive: Uint8Array;
  readonly safety: HistoricalOnlineSafety;
  readonly private?: OwnedFullSavePrivate;
  readonly passphrase?: string;
}): Promise<Result<Uint8Array>> {
  if (input.private && (!input.passphrase || !validPassphrase(input.passphrase)))
    return failure(
      'full-save-passphrase',
      'Private export requires a 12–1024 character passphrase',
    );
  if (!input.private && input.passphrase !== undefined)
    return failure('full-save-passphrase', 'A passphrase requires private material');
  if (
    !(input.publicArchive instanceof Uint8Array) ||
    input.publicArchive.length > MAX_ONLINE_PUBLIC_ARCHIVE_BYTES ||
    !(input.safety.bytes instanceof Uint8Array) ||
    input.safety.bytes.length > MAX_SAFETY_BYTES ||
    (input.private !== undefined &&
      (input.private.masters.length > 6 ||
        input.private.escrow.length > 36 ||
        input.private.escrow.some(({ bytes }) => bytes.length > 16_384)))
  )
    return failure('full-save-size', 'Full-save input exceeds its size limit');
  const publicArchive = new Uint8Array(input.publicArchive);
  const safetyInput = { ...input.safety, bytes: new Uint8Array(input.safety.bytes) };
  const passphrase = input.passphrase;
  const suppliedPrivate = input.private;
  let privateCopy: {
    holderSeat: Seat;
    escrowComplete: boolean;
    masters: { seat: Seat; master: Uint8Array }[];
    escrow: { dealerSeat: Seat; holderSeat: Seat; bytes: Uint8Array }[];
  } | null = null;
  let ciphertext: v.InferOutput<typeof cipherSchema> | null = null;
  let plaintext: Uint8Array | undefined;
  try {
    const archive = validateOnlinePublicArchive(publicArchive);
    if (!archive.ok) return archive;
    const context = contextFor(archive.value);
    if (!context.ok) return context;
    const safety = v.safeParse(safetySchema, safetyInput);
    if (!safety.success)
      return failure('full-save-safety', 'Historical safety metadata is malformed');
    const checked = checkedSafety(context.value, safety.output);
    if (!checked.ok) return checked;
    privateCopy = suppliedPrivate
      ? {
          holderSeat: suppliedPrivate.holderSeat,
          escrowComplete: suppliedPrivate.escrowComplete,
          masters: suppliedPrivate.masters.map(({ seat, master }) => ({
            seat,
            master: new Uint8Array(master),
          })),
          escrow: suppliedPrivate.escrow.map(({ dealerSeat, holderSeat, bytes }) => ({
            dealerSeat,
            holderSeat,
            bytes: new Uint8Array(bytes),
          })),
        }
      : null;
    if (privateCopy && passphrase) {
      const privateValue = v.parse(
        privateSchema,
        privateBinding(
          archive.value,
          safety.output,
          privateCopy.holderSeat,
          privateCopy.escrowComplete,
          privateCopy.masters,
          privateCopy.escrow,
        ),
      );
      const verified = await checkedPrivate(
        privateValue,
        archive.value,
        context.value,
        safety.output,
      );
      if (!verified.ok) return verified;
      plaintext = canonicalEncode(privateValue);
      if (plaintext.length > MAX_PRIVATE_BYTES)
        return failure('full-save-private-size', 'Private capsule exceeds its size limit');
      const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
      const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
      const key = await cryptoKey(passphrase, salt);
      const encryptionInput = new Uint8Array(plaintext);
      try {
        ciphertext = {
          kdf: 'PBKDF2-SHA256',
          iterations: PBKDF2_ITERATIONS,
          salt,
          nonce,
          ciphertext: new Uint8Array(
            await crypto.subtle.encrypt(
              {
                name: 'AES-GCM',
                iv: new Uint8Array(nonce),
                additionalData: new Uint8Array(aad(archive.value, safety.output)),
              },
              key,
              encryptionInput,
            ),
          ),
        };
      } finally {
        encryptionInput.fill(0);
      }
    }
    const output = canonicalEncode(
      v.parse(saveSchema, {
        format: FORMAT,
        gameId: archive.value.gameId,
        genesisDigest: archive.value.genesisDigest,
        publicHash: archive.value.id,
        publicArchive,
        safety: safety.output,
        private: ciphertext,
      }),
    );
    if (output.length > MAX_ONLINE_FULL_SAVE_BYTES) {
      output.fill(0);
      return failure('full-save-size', 'Full save exceeds its size limit');
    }
    return success(output);
  } catch (error) {
    return error instanceof FullSaveBusyError
      ? failure('full-save-busy', 'Another full-save key derivation is running')
      : failure('full-save-encode', 'Full save could not be encoded');
  } finally {
    plaintext?.fill(0);
    publicArchive.fill(0);
    safetyInput.bytes.fill(0);
    privateCopy?.masters.forEach(({ master }) => master.fill(0));
    privateCopy?.escrow.forEach(({ bytes }) => bytes.fill(0));
  }
}

/** Takes a coherent journal snapshot, then refuses to return it if the durable head moved. */
export async function exportOnlineFullSaveFromJournal(input: {
  readonly start: SavedOnlineGameRecord;
  readonly journal: Pick<ProtocolJournal, 'load'>;
  readonly includePrivate?: boolean;
  readonly passphrase?: string;
  readonly loadOwnedMaster?: (seat: Seat) => Promise<Uint8Array | null>;
  readonly escrowStore?: EscrowCeremonyStore;
  readonly includeEscrow?: boolean;
}): Promise<Result<Uint8Array>> {
  const journal = input.journal;
  const includePrivate = input.includePrivate ?? false;
  const passphrase = input.passphrase;
  const loadOwnedMaster = input.loadOwnedMaster;
  const escrowStore = input.escrowStore;
  const includeEscrow = input.includeEscrow;
  if (includePrivate && (!passphrase || !validPassphrase(passphrase)))
    return failure(
      'full-save-passphrase',
      'Private export requires a 12–1024 character passphrase',
    );
  if (!includePrivate && passphrase !== undefined)
    return failure('full-save-passphrase', 'A passphrase requires private material');
  let archiveBytes: Uint8Array | undefined;
  let privateMaterial: OwnedFullSavePrivate | null = null;
  let safetyBytes: Uint8Array | undefined;
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The public archive encoder validates this detached start before use.
    const start = canonicalDecode(canonicalEncode(input.start)) as SavedOnlineGameRecord;
    const first = await journal.load();
    if (!first || !sameBytes(canonicalEncode(first.genesis), canonicalEncode(start.result.entry)))
      return failure('full-save-journal', 'Journal is missing or belongs to another signed start');
    const archive = encodeOnlinePublicArchive({ start, entries: first.entries });
    if (!archive.ok) return archive;
    archiveBytes = archive.value;
    if (first.safety.bytes.length > MAX_SAFETY_BYTES)
      return failure('full-save-safety-size', 'Journal safety record exceeds its size limit');
    safetyBytes = new Uint8Array(first.safety.bytes);
    const identity = v.safeParse(
      v.object({ localSeat: seatSchema, localPublicKey: v.string() }),
      canonicalDecode(safetyBytes),
    );
    if (!identity.success)
      return failure('full-save-safety', 'Journal safety identity is malformed');
    const safety: HistoricalOnlineSafety = {
      revision: first.safety.revision,
      seat: identity.output.localSeat,
      publicKey: identity.output.localPublicKey,
      bytes: safetyBytes,
    };
    if (includePrivate) {
      if (!loadOwnedMaster)
        return failure('full-save-private', 'Private export needs the local master source');
      const collected = await collectOnlineFullSavePrivate({
        publicArchive: archiveBytes,
        safety,
        localSeat: safety.seat,
        loadOwnedMaster,
        ...(escrowStore ? { escrowStore } : {}),
        ...(includeEscrow === undefined ? {} : { includeEscrow }),
      });
      if (!collected.ok) return collected;
      privateMaterial = collected.value;
    }
    const encoded = await encodeOnlineFullSave({
      publicArchive: archiveBytes,
      safety,
      ...(privateMaterial ? { private: privateMaterial } : {}),
      ...(passphrase === undefined ? {} : { passphrase }),
    });
    if (!encoded.ok) return encoded;
    const last = await journal.load();
    if (
      !last ||
      entryHash(last.entries.at(-1)?.entry ?? last.genesis) !==
        entryHash(first.entries.at(-1)?.entry ?? first.genesis) ||
      last.safety.revision !== first.safety.revision ||
      !sameBytes(last.safety.bytes, first.safety.bytes)
    ) {
      encoded.value.fill(0);
      return failure('full-save-stale', 'Journal advanced while the full save was prepared');
    }
    return encoded;
  } catch {
    return failure('full-save-journal', 'Journal full-save export failed');
  } finally {
    archiveBytes?.fill(0);
    safetyBytes?.fill(0);
    privateMaterial?.dispose();
  }
}

/** Exact public replay and historical safety are checked before optional private decryption. */
export async function validateOnlineFullSave(
  supplied: Uint8Array,
  passphrase?: string,
): Promise<Result<VerifiedOnlineFullSave>> {
  if (
    !(supplied instanceof Uint8Array) ||
    supplied.length < 1 ||
    supplied.length > MAX_ONLINE_FULL_SAVE_BYTES
  )
    return failure('full-save-size', 'Full save exceeds its size limit');
  if (passphrase !== undefined && !validPassphrase(passphrase))
    return failure(
      'full-save-passphrase',
      'Private import requires a 12–1024 character passphrase',
    );
  if (!boundedCanonicalJsonStructure(supplied, 2048))
    return failure('full-save-format', 'Full save structure exceeds its limits');
  let parsedSave: v.InferOutput<typeof saveSchema> | null = null;
  let plaintext: Uint8Array | undefined;
  let retained: OwnedFullSavePrivate | null = null;
  try {
    const decoded: unknown = canonicalDecode(supplied);
    const parsed = v.safeParse(saveSchema, decoded);
    if (!parsed.success || !sameBytes(canonicalEncode(parsed.output), supplied))
      return failure('full-save-format', 'Full save is malformed or not canonical');
    const saved = parsed.output;
    parsedSave = saved;
    if (
      saved.publicArchive.length > MAX_ONLINE_PUBLIC_ARCHIVE_BYTES ||
      saved.safety.bytes.length > MAX_SAFETY_BYTES ||
      (saved.private && saved.private.ciphertext.length > MAX_PRIVATE_BYTES + 16)
    )
      return failure('full-save-size', 'Full save segment exceeds its size limit');
    const archive = validateOnlinePublicArchive(saved.publicArchive);
    if (!archive.ok) return archive;
    if (
      archive.value.gameId !== saved.gameId ||
      archive.value.genesisDigest !== saved.genesisDigest ||
      archive.value.id !== saved.publicHash
    )
      return failure('full-save-binding', 'Full save public replay binding differs');
    const context = contextFor(archive.value);
    if (!context.ok) return context;
    const safety = checkedSafety(context.value, saved.safety);
    if (!safety.ok) return safety;
    if (saved.private && passphrase !== undefined) {
      const key = await cryptoKey(passphrase, saved.private.salt);
      try {
        plaintext = new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv: new Uint8Array(saved.private.nonce),
              additionalData: new Uint8Array(aad(archive.value, saved.safety)),
            },
            key,
            new Uint8Array(saved.private.ciphertext),
          ),
        );
      } catch {
        return failure('full-save-decrypt', 'Private capsule could not be decrypted');
      }
      if (plaintext.length > MAX_PRIVATE_BYTES)
        return failure('full-save-private-size', 'Private capsule exceeds its size limit');
      if (!boundedCanonicalJsonStructure(plaintext, 2048))
        return failure('full-save-private', 'Decrypted private structure exceeds its limits');
      const privateDecoded: unknown = canonicalDecode(plaintext);
      try {
        const parsedPrivate = v.safeParse(privateSchema, privateDecoded);
        if (!parsedPrivate.success)
          return failure('full-save-private', 'Decrypted private capsule is malformed');
        const reencoded = canonicalEncode(parsedPrivate.output);
        try {
          if (!sameBytes(reencoded, plaintext))
            return failure('full-save-private', 'Decrypted private capsule is malformed');
        } finally {
          reencoded.fill(0);
        }
        const verified = await checkedPrivate(
          parsedPrivate.output,
          archive.value,
          context.value,
          saved.safety,
        );
        if (!verified.ok) return verified;
        retained = ownedPrivate({
          ...parsedPrivate.output,
          masters: parsedPrivate.output.masters.map(({ seat, master }) => ({
            seat,
            master: new Uint8Array(master),
          })),
          escrow: parsedPrivate.output.escrow.map(({ dealerSeat, holderSeat, bytes }) => ({
            dealerSeat,
            holderSeat,
            bytes: new Uint8Array(bytes),
          })),
        });
      } finally {
        wipePrivateDecoded(privateDecoded);
      }
    }
    const safetyCopy = { ...saved.safety, bytes: new Uint8Array(saved.safety.bytes) };
    const privateCopy = retained;
    retained = null;
    return success({
      id: toHex(sha256(supplied)),
      public: archive.value,
      safety: safetyCopy,
      private: privateCopy,
      privateLocked: saved.private !== null && privateCopy === null,
      mode: 'read-only-paused',
      dispose() {
        safetyCopy.bytes.fill(0);
        privateCopy?.dispose();
      },
    });
  } catch (error) {
    return error instanceof FullSaveBusyError
      ? failure('full-save-busy', 'Another full-save key derivation is running')
      : failure('full-save-format', 'Full save could not be validated');
  } finally {
    plaintext?.fill(0);
    retained?.dispose();
    parsedSave?.publicArchive.fill(0);
    parsedSave?.safety.bytes.fill(0);
    parsedSave?.private?.ciphertext.fill(0);
  }
}
