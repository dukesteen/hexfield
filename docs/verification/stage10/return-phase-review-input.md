Read-only security and liveness review. Tools and MCP are disabled. The attached source is the current OnlineCeremony implementation, with a diff of its focused tests. The rule in docs/09 is a 20-second timeout for each pre-consent ceremony step. A consented signer must keep waiting; a timeout cannot revoke its signed digest.

Inspect the durable phase deadline change for concrete defects. In particular, check that a duplicate or replayed packet cannot extend a deadline, restart retains the remaining interval, an expired old phase cannot transition into a fresh window, stale queued timer callbacks cannot retire a newer phase, and no new signed output escapes after expiry. Check the attempt-lock and escrow-lock order and the consent race. Review the diagnostic reason as local status only, not authority. Cite code locations and give the smallest repair for any defect. Do not ask for broader protocol or UI redesign.

## docs/09 timeout rule
Before local genesis consent, a step timeout (20 s) aborts the ceremony and returns to the lobby with an error. Once a client durably promises and signs an exact genesis digest, timeout cannot revoke the signature.

## packages/protocol/src/online-ceremony.ts
```ts
import {
  canonicalDecode,
  canonicalEncode,
  fromBase64Url,
  hashValue,
  toBase64Url,
  toHex,
} from '@cp2p/codec';
import {
  G,
  encodePoint,
  identityFromSecret,
  parsePeerId,
  scalarFromBytes,
  scalePoint,
  signObject,
  verifyObject,
} from '@cp2p/crypto';
import { ENGINE_VERSION, failure, success } from '@cp2p/engine';
import type { Engine, Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { createBeaconSecretSource } from './beacon-source.js';
import {
  createDeckGenesisCommitment,
  deckCeremonyId,
  genesisDeckDefinitions,
} from './deck-genesis.js';
import { validateDeckCeremony } from './deck-genesis.js';
import { createDeckSecretSource } from './deck-source.js';
import {
  escrowShareEnvelopeHash,
  prepareEscrowVerifier,
  verifyEscrowShareAck,
} from './escrow-distribution.js';
import type { EscrowShareAck, EscrowShareEnvelope } from './escrow-distribution.js';
import { createEscrowShareDispute, verifyEscrowShareDispute } from './escrow-dispute.js';
import type { EscrowShareDispute } from './escrow-dispute.js';
import { validateGenesisEscrow } from './genesis-escrow.js';
import type { EscrowDealerCommitment } from './genesis-escrow.js';
import { validateGenesisMasters } from './genesis-masters.js';
import { deriveEscrowRosters } from './escrow-roster.js';
import type { EscrowDealerRoster } from './escrow-roster.js';
import { applyDeckPass, initDeckSetup } from './deck-setup.js';
import type { DeckSetupState, SignedDeckPass } from './deck-setup.js';
import { prepareDeckPass } from './deck-setup-outbox.js';
import { EscrowCeremony } from './escrow-ceremony.js';
import type { EscrowCeremonyStore } from './escrow-ceremony.js';
import { checkEscrowCeremonyActive, verifyEscrowManifestApprovals } from './escrow-lifecycle.js';
import type { EscrowManifestApproval } from './escrow-lifecycle.js';
import {
  GENESIS_PREVIOUS_HASH,
  genesisDigest,
  genesisId,
  signEntry,
  validateGenesisEntry,
} from './genesis.js';
import {
  createGenesisSeedCommit,
  createGenesisSeedReveal,
  validateGenesisSeedTranscript,
} from './genesis-seed.js';
import type {
  GenesisSeedScope,
  GenesisSeedTranscript,
  SignedGenesisSeedCommit,
  SignedGenesisSeedReveal,
} from './genesis-seed.js';
import { verifyLobbyFreezeAgreement } from './lobby.js';
import type { LobbyFreezeAgreement } from './lobby-types.js';
import { signGameSeatBinding, verifyGameSeatBindings } from './online-bindings.js';
import type { SignedGameSeatBinding, VerifiedGameSeatBindings } from './online-bindings.js';
import {
  onlineCeremonyAttemptId,
  onlineCeremonySlot,
  signOnlineCeremonyPacket,
  verifyOnlineCeremonyPacket,
} from './online-ceremony-wire.js';
import type { OnlineCeremonyKind, OnlineCeremonyPacket } from './online-ceremony-wire.js';
import {
  hashSchema,
  key32Schema,
  nonnegativeIntegerSchema,
  seatSchema,
  signature64Schema,
} from './schema-values.js';
import { createStealSecretSource } from './steal-source.js';
import { genesisSchema } from './schemas.js';
import type { PeerId, ProtocolClock, Transport, Unsubscribe } from './transport.js';
import { PROTOCOL_VERSION } from './types.js';
import type { Genesis, GenesisBody, LogEntry, SeatSignature } from './types.js';
import { parseCanonical, MAX_MESSAGE_BYTES } from './validation.js';

const TIMEOUT_MS = 20_000;
const RETRY_MS = 1_000;
const ATTEMPT_PROTOCOL = 'online-attempt-v2';
const ceremonySteps = [
  'frozen',
  'bindings',
  'approvals',
  'escrow',
  'beacon-tips',
  'seed-commits',
  'seed-reveals',
  'deck',
  'consent',
  'waiting',
] as const;
type CeremonyStep = (typeof ceremonySteps)[number];
const retirementReasons = [
  'online-ceremony-retired',
  'online-ceremony-timeout',
  'online-ceremony-conflict',
  'online-ceremony-invalid-packet',
  'online-ceremony-escrow-retired',
] as const;
type RetirementReason = (typeof retirementReasons)[number];
const attemptSchema = v.strictObject({
  protocol: v.literal(ATTEMPT_PROTOCOL),
  freezeHash: hashSchema,
  ceremonyNonce: key32Schema,
  devicePeer: key32Schema,
  phase: v.picklist(ceremonySteps),
  startedAt: nonnegativeIntegerSchema,
  status: v.picklist(['active', 'retired'] as const),
  retiredReason: v.optional(v.picklist(retirementReasons)),
  retiredPhase: v.optional(
    v.picklist([
      'frozen',
      'bindings',
      'approvals',
      'escrow',
      'beacon-tips',
      'seed-commits',
      'seed-reveals',
      'deck',
      'consent',
      'waiting',
      'ready',
      'retired',
      'error',
    ] as const),
  ),
});
const createdAtSchema = v.strictObject({ createdAt: nonnegativeIntegerSchema });
const bindingSchema = v.strictObject({
  body: v.strictObject({
    protocol: v.literal('online-seat-binding-v1'),
    freezeHash: hashSchema,
    ceremonyNonce: key32Schema,
    protocolVersion: nonnegativeIntegerSchema,
    engineVersion: v.string(),
    seat: seatSchema,
    devicePeer: key32Schema,
    gamePeer: key32Schema,
    masterPub: key32Schema,
    encryptionKey: key32Schema,
  }),
  sig: signature64Schema,
});
const approvalSchema = v.strictObject({
  body: v.strictObject({
    protocol: v.literal('escrow-manifest-approval-v1'),
    ceremonyId: key32Schema,
    seat: seatSchema,
    publicKey: key32Schema,
  }),
  sig: signature64Schema,
});
const beaconTipSchema = v.strictObject({
  body: v.strictObject({
    protocol: v.literal('online-beacon-tip-v1'),
    ceremonyId: key32Schema,
    seat: seatSchema,
    length: nonnegativeIntegerSchema,
    tip: key32Schema,
  }),
  sig: signature64Schema,
});
const seedCommitSchema = v.strictObject({
  body: v.strictObject({
    protocol: v.literal('genesis-seed-v1'),
    freezeHash: hashSchema,
    ceremonyNonce: key32Schema,
    seat: seatSchema,
    commit: hashSchema,
  }),
  sig: signature64Schema,
});
const seedRevealSchema = v.strictObject({
  body: v.strictObject({
    protocol: v.literal('genesis-seed-v1'),
    freezeHash: hashSchema,
    ceremonyNonce: key32Schema,
    seat: seatSchema,
    share: key32Schema,
  }),
  sig: signature64Schema,
});
const consentSchema = v.strictObject({ seat: seatSchema, sig: signature64Schema });
const acceptedEscrowSchema = v.strictObject({ envelope: v.unknown(), ack: v.unknown() });
const disputedEscrowSchema = v.strictObject({ envelope: v.unknown(), dispute: v.unknown() });
const invalidEscrowSchema = v.strictObject({ dealerPacket: v.string() });

export type OnlineCeremonyPhase =
  | 'frozen'
  | 'bindings'
  | 'approvals'
  | 'escrow'
  | 'beacon-tips'
  | 'seed-commits'
  | 'seed-reveals'
  | 'deck'
  | 'consent'
  | 'waiting'
  | 'ready'
  | 'retired'
  | 'error';

export interface OnlineCeremonyProgress {
  readonly phase: OnlineCeremonyPhase;
  readonly awaitingSeats: readonly Seat[];
  readonly error: string | null;
  readonly locallyConsented: boolean;
}

export interface OnlineCeremonyResult {
  readonly entry: LogEntry;
  readonly genesis: Genesis;
  readonly transcripts: readonly { deckId: string; passes: readonly SignedDeckPass[] }[];
  readonly bindings: readonly SignedGameSeatBinding[];
}

export interface OnlineCeremonyOwnedSeat {
  readonly seat: Seat;
  /** Fresh, durably retained by the caller before this coordinator emits a packet. */
  readonly master: Uint8Array;
  readonly signingKey: Uint8Array;
}

export interface OnlineCeremonyOptions {
  readonly agreement: unknown;
  readonly transport: Transport;
  readonly clock: ProtocolClock;
  readonly deviceSigningKey: Uint8Array;
  readonly ownedSeats: readonly OnlineCeremonyOwnedSeat[];
  readonly store: EscrowCeremonyStore;
  readonly engine: Engine;
  /** Host-only informational Unix timestamp, signed once and pinned across retries. */
  readonly hostCreatedAt?: number;
  /** Previously certified result; restoration may only replay exact durable ceremony records. */
  readonly restoreResult?: OnlineCeremonyResult;
}

interface OwnedSeat {
  seat: Seat;
  master: Uint8Array;
  signingKey: Uint8Array;
  publicKey: PeerId;
}

interface Slot<T> {
  kind: OnlineCeremonyKind;
  seat: Seat;
  step: number;
  ownerDevice: PeerId;
  validate(payload: unknown): Result<T>;
  produce?: () => Promise<Result<T>>;
  /** Sealed escrow deliveries are sent only to their intended holder. */
  escrowRecipients?: readonly PeerId[];
  escrowManifest?: GenesisBody;
}

function copy<T>(value: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Canonical roundtrip detaches schema-checked ceremony data.
  return canonicalDecode(canonicalEncode(value)) as T;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

export class OnlineCeremony {
  readonly #agreement: LobbyFreezeAgreement;
  readonly #freezeHash: string;
  readonly #nonce: string;
  readonly #attemptId: string;
  readonly #self: PeerId;
  readonly #deviceKey: Uint8Array;
  readonly #restoreExpected: OnlineCeremonyResult | null;
  readonly #owned = new Map<Seat, OwnedSeat>();
  readonly #listeners = new Set<(progress: OnlineCeremonyProgress) => void>();
  readonly #accepted = new Map<string, unknown>();
  readonly #sentAt = new Map<string, number>();
  readonly #options: Pick<
    OnlineCeremonyOptions,
    'transport' | 'clock' | 'store' | 'engine' | 'hostCreatedAt'
  >;
  #progress: OnlineCeremonyProgress = {
    phase: 'frozen',
    awaitingSeats: [],
    error: null,
    locallyConsented: false,
  };
  #result: OnlineCeremonyResult | null = null;
  #escrow: EscrowCeremony | null = null;
  #started = false;
  #disposed = false;
  #locallyConsented = false;
  #offMessage: Unsubscribe | null = null;
  #timeoutHandle: unknown = null;
  #retryHandle: unknown = null;
  #queue: Promise<void> = Promise.resolve();
  #waiting = new Map<string, Slot<unknown>>();
  #escrowManifest: GenesisBody | null = null;
  #escrowRosters: readonly EscrowDealerRoster[] = [];
  #dealerEnvelopes = new Map<Seat, readonly EscrowShareEnvelope[]>();
  #failedAcceptance: { dealerSeat: Seat; holderSeat: Seat } | null = null;
  #disclosureBytes = new Map<string, Uint8Array>();
  #restoreValidated = false;

  private constructor(
    options: OnlineCeremonyOptions,
    agreement: LobbyFreezeAgreement,
    self: PeerId,
  ) {
    this.#options = {
      transport: options.transport,
      clock: options.clock,
      store: options.store,
      engine: options.engine,
      ...(options.hostCreatedAt === undefined ? {} : { hostCreatedAt: options.hostCreatedAt }),
    };
    this.#agreement = copy(agreement);
    this.#freezeHash = toHex(hashValue(agreement.state));
    this.#nonce = unwrap(parseCanonical(agreement.state.ceremonyNonce, key32Schema));
    this.#attemptId = onlineCeremonyAttemptId(this.#freezeHash, this.#nonce);
    this.#self = self;
    this.#restoreExpected = options.restoreResult ? copy(options.restoreResult) : null;
    this.#deviceKey = options.deviceSigningKey.slice();
    try {
      for (const material of options.ownedSeats) {
        const key = material.signingKey.slice();
        try {
          const identity = identityFromSecret(key);
          scalarFromBytes(material.master, { nonzero: true });
          this.#owned.set(material.seat, {
            seat: material.seat,
            master: material.master.slice(),
            signingKey: key,
            publicKey: identity.peerId,
          });
          identity.secretKey.fill(0);
        } catch {
          key.fill(0);
          throw new Error('Local seat material is invalid');
        }
      }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  static create(options: OnlineCeremonyOptions): Result<OnlineCeremony> {
    const agreement = verifyLobbyFreezeAgreement(options.agreement);
    if (!agreement.ok) return agreement;
    const state = agreement.value.state;
    const humans = state.seats.filter((seat) => seat.kind === 'human');
    if (state.seats.length < 2 || state.seats.length > 4 || humans.length < 1)
      return failure(
        'online-ceremony-roster',
        'Ceremony requires two to four seats and at least one human',
      );
    try {
      const identity = identityFromSecret(options.deviceSigningKey);
      const self = identity.peerId;
      identity.secretKey.fill(0);
      if (
        self !== options.transport.self ||
        !humans.some((seat) => seat.peer === self) ||
        !humans.some((seat) => seat.peer === state.hostPeer)
      )
        return failure('online-ceremony-device', 'Device key does not own a frozen human seat');
      if (
        options.hostCreatedAt !== undefined &&
        (self !== state.hostPeer ||
          !Number.isSafeInteger(options.hostCreatedAt) ||
          options.hostCreatedAt < 0)
      )
        return failure('online-ceremony-time', 'Only host may propose a valid creation timestamp');
      const owned = state.seats.filter((seat) =>
        seat.kind === 'human' ? seat.peer === self : seat.kind === 'bot' && seat.botHost === self,
      );
      if (
        owned.length !== options.ownedSeats.length ||
        new Set(options.ownedSeats.map((seat) => seat.seat)).size !== owned.length ||
        owned.some((seat) => !options.ownedSeats.some((item) => item.seat === seat.seat))
      )
        return failure(
          'online-ceremony-material',
          'Owned material must match exact frozen host seats',
        );
      return success(new OnlineCeremony(options, agreement.value, self));
    } catch {
      return failure('online-ceremony-material', 'Ceremony keys or masters are invalid');
    }
  }

  snapshot(): OnlineCeremonyProgress {
    return copy(this.#progress);
  }

  onChange(listener: (progress: OnlineCeremonyProgress) => void): Unsubscribe {
    this.#listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.#listeners.delete(listener);
    };
  }

  result(): OnlineCeremonyResult | null {
    if (this.#restoreExpected && !this.#restoreValidated) return null;
    return this.#result ? copy(this.#result) : null;
  }

  flush(): Promise<void> {
    return this.#queue;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#offMessage?.();
    if (this.#timeoutHandle !== null) this.#options.clock.clearTimeout(this.#timeoutHandle);
    if (this.#retryHandle !== null) this.#options.clock.clearTimeout(this.#retryHandle);
    this.#deviceKey.fill(0);
    for (const material of this.#owned.values()) {
      material.master.fill(0);
      material.signingKey.fill(0);
    }
    this.#owned.clear();
    this.#listeners.clear();
  }

  #emit(progress: OnlineCeremonyProgress): void {
    this.#progress = progress;
    for (const listener of this.#listeners) {
      try {
        listener(this.snapshot());
      } catch {
        /* UI observer cannot alter ceremony. */
      }
    }
  }

  #enqueue<T>(task: () => Promise<Result<T>>): Promise<Result<T>> {
    const run = this.#queue.then(task, task);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async start(): Promise<Result<void>> {
    return this.#enqueue(async () => {
      if (this.#disposed) return failure('online-ceremony-disposed', 'Ceremony is disposed');
      if (this.#started) return success(undefined);
      const initialized = await this.#attempt(async (record) => success(record));
      if (!initialized.ok) return initialized;
      if (this.#restoreExpected) {
        if (initialized.value.status !== 'active')
          return failure('online-ceremony-restore', 'Completed attempt was retired');
        this.#started = true;
        this.#offMessage = this.#options.transport.onMessage((from, bytes) => {
          void this.#enqueue(() => this.#receive(from, bytes.slice()));
        });
        const restored = await this.#advance();
        if (!restored.ok || (!this.#result && this.#disclosureBytes.size === 0)) {
          this.#offMessage();
          this.#offMessage = null;
          this.#started = false;
          return restored.ok
            ? failure('online-ceremony-restore', 'Completed result was not restored')
            : restored;
        }
        // This queued step follows every message received during the replay.
        // Observers cannot open a game from the saved result until those messages run.
        void this.#enqueue(async () => {
          if (this.#disposed) return failure('online-ceremony-disposed', 'Ceremony is disposed');
          this.#restoreValidated = true;
          if (this.#result && this.#disclosureBytes.size === 0)
            this.#emit({
              phase: 'ready',
              awaitingSeats: [],
              error: null,
              locallyConsented: this.#locallyConsented,
            });
          return this.#advance();
        });
        this.#scheduleRetry();
        return success(undefined);
      }
      const elapsed = this.#options.clock.now() - initialized.value.startedAt;
      if (initialized.value.status === 'retired' || elapsed < 0 || elapsed >= TIMEOUT_MS) {
        const saved = await this.#hasSavedDisclosure();
        if (!saved.ok) return saved;
        if (saved.value) {
          const restored = await this.#restoreDisclosureManifest();
          if (!restored.ok) return restored;
          const disclosures = await this.#resumeEscrowDisclosures();
          if (!disclosures.ok) return disclosures;
        }
      }
      if (initialized.value.status === 'retired' && this.#disclosureBytes.size === 0)
        return failure(
          initialized.value.retiredReason ?? 'online-ceremony-retired',
          `Ceremony attempt was durably retired${initialized.value.retiredPhase ? ` during ${initialized.value.retiredPhase}` : ''}`,
        );
      this.#started = true;
      this.#offMessage = this.#options.transport.onMessage((from, bytes) => {
        void this.#enqueue(() => this.#receive(from, bytes.slice()));
      });
      if (this.#disclosureBytes.size > 0) {
        this.#scheduleRetry();
        return success(undefined);
      }
      if (elapsed < 0 || elapsed >= TIMEOUT_MS) {
        const consented = await this.#restoreConsentBarrier();
        if (!consented.ok) return consented;
        if (!consented.value) return this.#abortUnsafe('online-ceremony-timeout');
        this.#locallyConsented = true;
      }
      this.#scheduleRetry();
      return this.#advance();
    });
  }

  async abort(): Promise<Result<void>> {
    return this.#enqueue(() => this.#abortUnsafe());
  }

  #scheduleRetry(): void {
    if (this.#disposed || (this.#progress.phase === 'retired' && this.#disclosureBytes.size === 0))
      return;
    this.#retryHandle = this.#options.clock.setTimeout(() => {
      this.#retryHandle = null;
      void this.#enqueue(async () => {
        if (this.#disposed) return failure('online-ceremony-disposed', 'Ceremony is disposed');
        const result = await this.#advance();
        this.#scheduleRetry();
        return result;
      });
    }, RETRY_MS);
  }

  async #attempt<T>(
    task: (record: v.InferOutput<typeof attemptSchema>) => Promise<Result<T>>,
  ): Promise<Result<T>> {
    try {
      return await this.#options.store.withCeremonyLock(this.#attemptId, async () => {
        const id = `online-attempt/${this.#attemptId}`;
        let bytes = await this.#options.store.load(id);
        if (bytes === null) {
          if (this.#restoreExpected)
            return failure('online-ceremony-restore', 'Completed attempt record is missing');
          const initial = {
            protocol: ATTEMPT_PROTOCOL,
            freezeHash: this.#freezeHash,
            ceremonyNonce: this.#nonce,
            devicePeer: this.#self,
            phase: 'frozen',
            startedAt: Math.floor(this.#options.clock.now()),
            status: 'active',
          } as const;
          const proposed = canonicalEncode(initial);
          if (await this.#options.store.putIfAbsent(id, proposed)) bytes = proposed;
          else bytes = await this.#options.store.load(id);
        }
        if (bytes === null) return failure('online-ceremony-record', 'Attempt record is missing');
        const parsed = parseCanonical(canonicalDecode(bytes), attemptSchema);
        if (
          !parsed.ok ||
          !sameBytes(bytes, canonicalEncode(parsed.value)) ||
          parsed.value.freezeHash !== this.#freezeHash ||
          parsed.value.ceremonyNonce !== this.#nonce ||
          parsed.value.devicePeer !== this.#self
        )
          return failure(
            'online-ceremony-record',
            'Attempt record is corrupt or belongs to another device',
          );
        return task(parsed.value);
      });
    } catch {
      return failure('online-ceremony-store', 'Could not access durable ceremony state');
    }
  }

  async #restoreConsentBarrier(): Promise<Result<boolean>> {
    return this.#attempt(async () => {
      const bytes = await this.#options.store.load(`online-manifest/${this.#attemptId}`);
      if (bytes === null) return success(false);
      const manifest = parseCanonical(
        canonicalDecode(bytes),
        v.omit(genesisSchema, ['gameId', 'signatures']),
      );
      if (
        !manifest.ok ||
        manifest.value.ceremonyNonce !== this.#nonce ||
        toHex(hashValue(manifest.value.config)) !== toHex(hashValue(this.#agreement.state.config))
      )
        return failure('online-ceremony-record', 'Pinned manifest is invalid');
      const status = await checkEscrowCeremonyActive(manifest.value, this.#options.store);
      if (status.ok) return success(false);
      if (
        status.error.code === 'escrow-ceremony-consenting' ||
        status.error.code === 'escrow-ceremony-completed'
      )
        return success(true);
      if (status.error.code === 'escrow-ceremony-retired') return success(false);
      return status;
    });
  }

  async #restoreDisclosureManifest(): Promise<Result<void>> {
    try {
      const bytes = await this.#options.store.load(`online-manifest/${this.#attemptId}`);
      if (!bytes)
        return failure('online-ceremony-record', 'Retired disclosure has no pinned manifest');
      const manifest = parseCanonical(
        canonicalDecode(bytes),
        v.omit(genesisSchema, ['gameId', 'signatures']),
      );
      if (
        !manifest.ok ||
        manifest.value.ceremonyNonce !== this.#nonce ||
        toHex(hashValue(manifest.value.config)) !== toHex(hashValue(this.#agreement.state.config))
      )
        return failure('online-ceremony-record', 'Retired disclosure manifest is invalid');
      const rosters = deriveEscrowRosters(manifest.value);
      if (!rosters.ok) return rosters;
      this.#escrowManifest = manifest.value;
      this.#escrowRosters = rosters.value;
      this.#escrow = new EscrowCeremony(manifest.value, this.#options.store);
      return success(undefined);
    } catch {
      return failure('online-ceremony-record', 'Retired disclosure manifest could not be restored');
    }
  }

  async #hasSavedDisclosure(): Promise<Result<boolean>> {
    try {
      const humans = this.#agreement.state.seats.filter((seat) => seat.kind === 'human');
      for (const holder of humans) {
        for (const dealer of humans) {
          if (holder.seat === dealer.seat) continue;
          for (const kind of ['escrow-dispute', 'escrow-invalid'] as const) {
            // oxlint-disable-next-line no-await-in-loop -- Fixed roster evidence slots are checked before expired-attempt output.
            if (await this.#options.store.load(this.#packetKey(kind, holder.seat, dealer.seat)))
              return success(true);
          }
        }
      }
      return success(false);
    } catch {
      return failure('online-ceremony-store', 'Could not inspect durable escrow disclosures');
    }
  }

  async #abortUnsafe(
    reason: RetirementReason = 'online-ceremony-retired',
    expected?: { phase: CeremonyStep; startedAt: number },
  ): Promise<Result<void>> {
    if (this.#disposed) return failure('online-ceremony-disposed', 'Ceremony is disposed');
    if (this.#locallyConsented || this.#result)
      return failure('online-ceremony-consented', 'An exact genesis consent cannot be revoked');
    let recordedReason = reason;
    let recordedPhase: OnlineCeremonyPhase = this.#progress.phase;
    let stale = false;
    const retired = await this.#attempt(async (record) => {
      if (
        expected &&
        (record.phase !== expected.phase || record.startedAt !== expected.startedAt)
      ) {
        stale = true;
        return success(undefined);
      }
      if (record.status === 'retired') {
        recordedReason = record.retiredReason ?? 'online-ceremony-retired';
        recordedPhase = record.retiredPhase ?? 'retired';
        return success(undefined);
      }
      recordedPhase = record.phase;
      const pinned = await this.#options.store.load(`online-manifest/${this.#attemptId}`);
      if (pinned) {
        const manifest = parseCanonical(
          canonicalDecode(pinned),
          v.omit(genesisSchema, ['gameId', 'signatures']),
        );
        if (
          !manifest.ok ||
          manifest.value.ceremonyNonce !== this.#nonce ||
          toHex(hashValue(manifest.value.config)) !== toHex(hashValue(this.#agreement.state.config))
        )
          return failure('online-ceremony-record', 'Pinned retirement manifest is invalid');
        const escrow = await new EscrowCeremony(manifest.value, this.#options.store).abort();
        if (!escrow.ok) return escrow;
      }
      const before = canonicalEncode(record);
      const after = canonicalEncode({
        ...record,
        status: 'retired',
        retiredReason: recordedReason,
        retiredPhase: recordedPhase,
      });
      const updated = await this.#options.store.compareAndSwap(
        `online-attempt/${this.#attemptId}`,
        before,
        after,
      );
      return updated
        ? success(undefined)
        : failure('online-ceremony-record', 'Attempt retirement lost its durable race');
    });
    if (retired.ok && !stale)
      this.#emit({
        phase: 'retired',
        awaitingSeats: [],
        error:
          recordedReason === 'online-ceremony-retired'
            ? recordedReason
            : `${recordedReason}:${recordedPhase}`,
        locallyConsented: false,
      });
    else if (
      !retired.ok &&
      (retired.error.code === 'escrow-ceremony-consenting' ||
        retired.error.code === 'escrow-ceremony-completed')
    ) {
      this.#locallyConsented = true;
      this.#emit({ phase: 'waiting', awaitingSeats: [], error: null, locallyConsented: true });
    }
    return retired;
  }

  #phaseExpired(startedAt: number): boolean {
    const elapsed = this.#options.clock.now() - startedAt;
    return elapsed < 0 || elapsed >= TIMEOUT_MS;
  }

  #schedulePhaseTimeout(phase: CeremonyStep, startedAt: number): void {
    if (this.#timeoutHandle !== null) this.#options.clock.clearTimeout(this.#timeoutHandle);
    this.#timeoutHandle = null;
    if (this.#disposed || this.#result || this.#locallyConsented) return;
    const elapsed = this.#options.clock.now() - startedAt;
    const remaining = elapsed < 0 ? 0 : Math.max(0, TIMEOUT_MS - elapsed);
    const handle = this.#options.clock.setTimeout(() => {
      void this.#enqueue(() => this.#onTimeout({ phase, startedAt }, handle));
    }, remaining);
    this.#timeoutHandle = handle;
  }

  async #enterPhase(phase: CeremonyStep): Promise<Result<boolean>> {
    const entered = await this.#attempt(async (record) => {
      if (record.status === 'retired')
        return failure('online-ceremony-retired', 'Ceremony attempt was durably retired');
      const prior = { phase: record.phase, startedAt: record.startedAt };
      if (!this.#locallyConsented && this.#phaseExpired(record.startedAt))
        return success({ ...prior, expired: true });
      if (ceremonySteps.indexOf(phase) <= ceremonySteps.indexOf(record.phase))
        return success({ ...prior, expired: false });
      const next = { ...record, phase, startedAt: Math.floor(this.#options.clock.now()) };
      if (
        !(await this.#options.store.compareAndSwap(
          `online-attempt/${this.#attemptId}`,
          canonicalEncode(record),
          canonicalEncode(next),
        ))
      )
        return failure('online-ceremony-record', 'Phase transition lost its durable race');
      return success({
        phase,
        startedAt: next.startedAt,
        expired: !this.#locallyConsented && this.#phaseExpired(record.startedAt),
      });
    });
    if (!entered.ok) {
      if (entered.error.code !== 'online-ceremony-retired') return entered;
      const retired = await this.#abortUnsafe();
      return retired.ok ? success(false) : retired;
    }
    if (entered.value.expired) {
      const retired = await this.#abortUnsafe('online-ceremony-timeout', entered.value);
      return retired.ok ? success(false) : retired;
    }
    this.#schedulePhaseTimeout(entered.value.phase, entered.value.startedAt);
    return success(true);
  }

  async #onTimeout(
    expected: { phase: CeremonyStep; startedAt: number },
    handle: unknown,
  ): Promise<Result<void>> {
    if (this.#timeoutHandle === handle) this.#timeoutHandle = null;
    if (this.#disposed || this.#result) return success(undefined);
    if (this.#locallyConsented) {
      this.#emit({
        phase: 'waiting',
        awaitingSeats: this.#progress.awaitingSeats,
        error: null,
        locallyConsented: true,
      });
      return success(undefined);
    }
    const current = await this.#attempt(async (record) =>
      success({ phase: record.phase, startedAt: record.startedAt, status: record.status }),
    );
    if (!current.ok) return current;
    if (current.value.status === 'retired') return success(undefined);
    if (current.value.phase !== expected.phase || current.value.startedAt !== expected.startedAt)
      return success(undefined);
    if (!this.#phaseExpired(expected.startedAt)) {
      this.#schedulePhaseTimeout(expected.phase, expected.startedAt);
      return success(undefined);
    }
    return this.#abortUnsafe('online-ceremony-timeout', expected);
  }

  #packetKey(kind: OnlineCeremonyKind, seat: Seat, step: number): string {
    return `online-ceremony/${this.#attemptId}/${onlineCeremonySlot(kind, seat, step)}`;
  }

  #ownerDevice(seat: Seat): PeerId | null {
    const owner = this.#agreement.state.seats[seat];
    return owner?.kind === 'human' ? owner.peer : owner?.kind === 'bot' ? owner.botHost : null;
  }

  #broadcast(slot: string, bytes: Uint8Array, recipients?: readonly PeerId[]): void {
    if (this.#disposed || (this.#restoreExpected && !this.#restoreValidated)) return;
    const now = this.#options.clock.now();
    const prior = this.#sentAt.get(slot);
    if (prior !== undefined && now >= prior && now - prior < RETRY_MS) return;
    this.#sentAt.set(slot, now);
    const peers =
      recipients ??
      this.#agreement.state.seats.filter((seat) => seat.kind === 'human').map((seat) => seat.peer);
    for (const peer of peers) {
      if (this.#disposed) break;
      if (peer === this.#self) continue;
      try {
        this.#options.transport.send(peer, bytes.slice());
      } catch {
        /* Durable packet remains available for the next retry. */
      }
    }
  }

  async #sendSlotWithinAttempt<T>(
    slot: Slot<T>,
    key: string,
    bytes: Uint8Array,
  ): Promise<Result<void>> {
    if (this.#restoreExpected && !this.#restoreValidated) return success(undefined);
    const manifest = slot.escrowManifest;
    if (!manifest) {
      this.#broadcast(key, bytes, slot.escrowRecipients);
      return success(undefined);
    }
    try {
      return await this.#options.store.withCeremonyLock(deckCeremonyId(manifest), async () => {
        if (this.#disposed) return failure('online-ceremony-disposed', 'Ceremony is disposed');
        const active = await checkEscrowCeremonyActive(manifest, this.#options.store);
        if (!active.ok) {
          // Once this device has consented, signed genesis contains the complete
          // public escrow transcript. Earlier share traffic has no further role.
          if (
            active.error.code === 'escrow-ceremony-consenting' ||
            active.error.code === 'escrow-ceremony-completed'
          )
            return success(undefined);
          return active;
        }
        this.#broadcast(key, bytes, slot.escrowRecipients);
        return success(undefined);
      });
    } catch {
      return failure('online-ceremony-store', 'Could not check escrow retirement before send');
    }
  }

  #checkedPayload<T>(packet: OnlineCeremonyPacket, slot: Slot<T>): Result<T> {
    if (
      packet.body.kind !== slot.kind ||
      packet.body.seat !== slot.seat ||
      packet.body.step !== slot.step ||
      packet.body.senderDevice !== slot.ownerDevice
    )
      return failure('online-ceremony-slot', 'Packet actor or phase differs from the frozen slot');
    return slot.validate(packet.body.payload);
  }

  async #outgoing<T>(slot: Slot<T>, key: string): Promise<Result<T>> {
    return this.#attempt(async (record) => {
      if (this.#disposed) return failure('online-ceremony-disposed', 'Ceremony is disposed');
      if (record.status === 'retired')
        return failure('online-ceremony-retired', 'Ceremony attempt was durably retired');
      const prior = await this.#options.store.load(key);
      if (prior !== null) {
        const packet = verifyOnlineCeremonyPacket(prior, this.#self, this.#freezeHash, this.#nonce);
        if (!packet.ok) return packet;
        const checked = this.#checkedPayload(packet.value, slot);
        if (!checked.ok) return checked;
        if (slot.kind === 'consent') this.#locallyConsented = true;
        if (!this.#locallyConsented && this.#phaseExpired(record.startedAt))
          return failure('online-ceremony-timeout', 'Ceremony phase expired before output');
        const sent = await this.#sendSlotWithinAttempt(slot, key, prior);
        return sent.ok ? checked : sent;
      }
      if (!this.#locallyConsented && this.#phaseExpired(record.startedAt))
        return failure('online-ceremony-timeout', 'Ceremony phase expired before output');
      if (this.#restoreExpected)
        return failure('online-ceremony-restore', 'Completed phase packet is missing');
      if (!slot.produce)
        return failure('online-ceremony-owner', 'Only the local owner may produce this slot');
      const produced = await slot.produce();
      if (!produced.ok) return produced;
      if (!this.#locallyConsented && this.#phaseExpired(record.startedAt))
        return failure('online-ceremony-timeout', 'Ceremony phase expired before signing');
      const body: OnlineCeremonyPacket['body'] = {
        protocol: 'online-ceremony-v1',
        freezeHash: this.#freezeHash,
        ceremonyNonce: this.#nonce,
        senderDevice: this.#self,
        kind: slot.kind,
        seat: slot.seat,
        step: slot.step,
        payload: produced.value,
      };
      const signed = signOnlineCeremonyPacket(body, this.#deviceKey);
      if (!signed.ok) return signed;
      const checked = this.#checkedPayload(signed.value.packet, slot);
      if (!checked.ok) return checked;
      if (!this.#locallyConsented && this.#phaseExpired(record.startedAt))
        return failure('online-ceremony-timeout', 'Ceremony phase expired before persistence');
      if (this.#disposed) return failure('online-ceremony-disposed', 'Ceremony is disposed');
      if (!(await this.#options.store.putIfAbsent(key, signed.value.bytes))) {
        const winner = await this.#options.store.load(key);
        if (!winner || !sameBytes(winner, signed.value.bytes))
          return failure('online-ceremony-conflict', 'Another packet already owns this phase slot');
      }
      if (slot.kind === 'consent') this.#locallyConsented = true;
      if (this.#disposed) return failure('online-ceremony-disposed', 'Ceremony is disposed');
      const sent = await this.#sendSlotWithinAttempt(slot, key, signed.value.bytes);
      return sent.ok ? checked : sent;
    });
  }

  async #exchange<T>(
    phase: CeremonyStep,
    slots: readonly Slot<T>[],
  ): Promise<Result<readonly T[] | null>> {
    const entered = await this.#enterPhase(phase);
    if (!entered.ok) return entered;
    if (!entered.value) return success(null);
    this.#waiting.clear();
    const values: T[] = [];
    const missing: Seat[] = [];
    for (const slot of slots) {
      const key = this.#packetKey(slot.kind, slot.seat, slot.step);
      const cached = this.#accepted.get(key);
      if (cached !== undefined) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Cached only after this exact slot validator accepted the value.
        values.push(cached as T);
        if (slot.kind === 'consent' && slot.ownerDevice === this.#self)
          this.#locallyConsented = true;
        if (slot.ownerDevice === this.#self) {
          // oxlint-disable-next-line no-await-in-loop -- Each authenticated slot is replayed in exact phase order.
          const bytes = await this.#options.store.load(key);
          if (bytes) {
            // oxlint-disable-next-line no-await-in-loop -- Escrow output is ordered under the attempt then ceremony locks.
            const sent = await this.#attempt(async (record) =>
              record.status === 'retired'
                ? failure('online-ceremony-retired', 'Ceremony attempt was durably retired')
                : !this.#locallyConsented && this.#phaseExpired(record.startedAt)
                  ? failure('online-ceremony-timeout', 'Ceremony phase expired before retry')
                  : this.#sendSlotWithinAttempt(slot, key, bytes),
            );
            if (!sent.ok) return sent;
          }
        }
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- Preserve ordered transcript replay and backpressure.
      const bytes = await this.#options.store.load(key);
      if (bytes !== null) {
        const packet = verifyOnlineCeremonyPacket(
          bytes,
          slot.ownerDevice,
          this.#freezeHash,
          this.#nonce,
        );
        if (!packet.ok) return packet;
        const checked = this.#checkedPayload(packet.value, slot);
        if (!checked.ok) return checked;
        this.#accepted.set(key, checked.value);
        values.push(checked.value);
        if (slot.kind === 'consent' && slot.ownerDevice === this.#self)
          this.#locallyConsented = true;
        if (slot.ownerDevice === this.#self) {
          // oxlint-disable-next-line no-await-in-loop -- Retried escrow output must respect the retirement barrier.
          const sent = await this.#attempt(async (record) =>
            record.status === 'retired'
              ? failure('online-ceremony-retired', 'Ceremony attempt was durably retired')
              : !this.#locallyConsented && this.#phaseExpired(record.startedAt)
                ? failure('online-ceremony-timeout', 'Ceremony phase expired before retry')
                : this.#sendSlotWithinAttempt(slot, key, bytes),
          );
          if (!sent.ok) return sent;
        }
      } else if (slot.ownerDevice === this.#self) {
        if (this.#restoreExpected)
          return failure('online-ceremony-restore', 'Completed local phase packet is missing');
        // oxlint-disable-next-line no-await-in-loop -- Only the next signed slot may be produced.
        const produced = await this.#outgoing(slot, key);
        if (!produced.ok) return produced;
        this.#accepted.set(key, produced.value);
        values.push(produced.value);
        if (slot.kind === 'consent') this.#locallyConsented = true;
      } else {
        if (this.#restoreExpected)
          return failure('online-ceremony-restore', 'Completed remote phase packet is missing');
        missing.push(slot.seat);
        this.#waiting.set(key, slot);
      }
    }
    if (missing.length) {
      this.#emit({
        phase,
        awaitingSeats: missing,
        error: null,
        locallyConsented: this.#locallyConsented,
      });
      return success(null);
    }
    return success(values);
  }

  async #receive(from: PeerId, bytes: Uint8Array): Promise<Result<void>> {
    if (this.#disposed || !this.#started || this.#progress.phase === 'retired')
      return success(undefined);
    const packet = verifyOnlineCeremonyPacket(bytes, from, this.#freezeHash, this.#nonce);
    if (!packet.ok) return packet;
    const body = packet.value.body;
    if (!this.#agreement.state.seats.some((seat) => seat.kind === 'human' && seat.peer === from))
      return failure('online-ceremony-sender', 'Sender is outside the frozen human roster');
    if (this.#ownerDevice(body.seat) !== from)
      return failure('online-ceremony-sender', 'Sender does not own this phase actor');
    if (body.kind === 'escrow-dispute') return this.#acceptDisputePacket(packet.value, bytes);
    if (body.kind === 'escrow-invalid') return this.#acceptInvalidPacket(packet.value, bytes);
    if (body.kind === 'escrow-envelope' || body.kind === 'escrow-accepted')
      return this.#receiveEscrowPacket(packet.value, bytes);
    const key = this.#packetKey(body.kind, body.seat, body.step);
    const slot = this.#waiting.get(key);
    if (slot && slot.ownerDevice !== from)
      return failure('online-ceremony-sender', 'Sender does not own this phase slot');
    if (!slot) {
      const prior = await this.#options.store.load(key);
      if (prior !== null && !sameBytes(prior, bytes)) {
        await this.#abortUnsafe('online-ceremony-conflict');
        return failure(
          'online-ceremony-conflict',
          'Conflicting packet repeats a committed phase slot',
        );
      }
      return success(undefined);
    }
    const checked = this.#checkedPayload(packet.value, slot);
    if (!checked.ok) {
      await this.#abortUnsafe('online-ceremony-invalid-packet');
      return checked;
    }
    const saved = await this.#attempt(async (record) => {
      if (record.status === 'retired')
        return failure('online-ceremony-retired', 'Ceremony attempt was durably retired');
      const prior = await this.#options.store.load(key);
      if (prior !== null && !sameBytes(prior, bytes))
        return failure('online-ceremony-conflict', 'Another packet already owns this phase slot');
      if (prior === null && !(await this.#options.store.putIfAbsent(key, bytes))) {
        const winner = await this.#options.store.load(key);
        if (!winner || !sameBytes(winner, bytes))
          return failure('online-ceremony-conflict', 'Another packet already owns this phase slot');
      }
      return success(undefined);
    });
    if (!saved.ok) {
      if (saved.error.code === 'online-ceremony-conflict')
        await this.#abortUnsafe('online-ceremony-conflict');
      return saved;
    }
    this.#accepted.set(key, checked.value);
    return this.#advance();
  }

  async #receiveEscrowPacket(
    packet: OnlineCeremonyPacket,
    bytes: Uint8Array,
  ): Promise<Result<void>> {
    const manifest = this.#escrowManifest;
    if (!manifest) return success(undefined);
    const { kind, seat, step } = packet.body;
    const roster = this.#escrowRosters.find(
      (item) => item.dealer.seat === (kind === 'escrow-envelope' ? seat : step),
    );
    const holderSeat = kind === 'escrow-envelope' ? step : seat;
    const holder = roster?.holders.find((item) => item.seat === holderSeat);
    if (!roster?.eligible || !holder)
      return failure('online-ceremony-escrow', 'Escrow packet has no frozen dealer/holder pair');
    if (kind === 'escrow-envelope' && this.#ownerDevice(holder.seat) !== this.#self)
      return failure('online-ceremony-escrow', 'Private share was delivered to another holder');
    const checked =
      kind === 'escrow-envelope'
        ? this.#checkedPayload(packet, this.#escrowEnvelopeSlot(manifest, [], roster, holder.seat))
        : this.#checkedPayload(packet, this.#escrowAcceptedSlot(manifest, roster, holder.seat));
    if (!checked.ok) {
      if (kind === 'escrow-envelope') {
        const published = await this.#publishInvalidEnvelope(packet, bytes, roster, holder.seat);
        if (published.ok)
          return failure('online-ceremony-escrow-invalid', 'Dealer signed an invalid sealed share');
      }
      return checked;
    }
    const key = this.#packetKey(kind, seat, step);
    const saved = await this.#attempt(async (record) => {
      if (record.status === 'retired')
        return failure('online-ceremony-retired', 'Ceremony attempt was durably retired');
      const prior = await this.#options.store.load(key);
      if (prior !== null)
        return sameBytes(prior, bytes)
          ? success(undefined)
          : failure('online-ceremony-conflict', 'Another escrow packet owns this slot');
      if (await this.#options.store.putIfAbsent(key, bytes)) return success(undefined);
      const winner = await this.#options.store.load(key);
      return winner && sameBytes(winner, bytes)
        ? success(undefined)
        : failure('online-ceremony-conflict', 'Another escrow packet owns this slot');
    });
    if (!saved.ok) {
      if (saved.error.code === 'online-ceremony-conflict')
        await this.#abortUnsafe('online-ceremony-conflict');
      return saved;
    }
    this.#accepted.set(key, checked.value);
    return this.#advance();
  }

  async #publishInvalidEnvelope(
    dealerPacket: OnlineCeremonyPacket,
    dealerBytes: Uint8Array,
    roster: EscrowDealerRoster,
    holderSeat: Seat,
  ): Promise<Result<void>> {
    if (this.#ownerDevice(holderSeat) !== this.#self)
      return failure('online-ceremony-escrow', 'Only the affected holder can report this delivery');
    const signed = signOnlineCeremonyPacket(
      {
        protocol: 'online-ceremony-v1',
        freezeHash: this.#freezeHash,
        ceremonyNonce: this.#nonce,
        senderDevice: this.#self,
        kind: 'escrow-invalid',
        seat: holderSeat,
        step: roster.dealer.seat,
        payload: { dealerPacket: toBase64Url(dealerBytes) },
      },
      this.#deviceKey,
    );
    if (!signed.ok) return signed;
    if (dealerPacket.body.kind !== 'escrow-envelope')
      return failure('online-ceremony-escrow', 'Invalid-envelope evidence has no delivery');
    return this.#acceptInvalidPacket(signed.value.packet, signed.value.bytes);
  }

  async #acceptInvalidPacket(
    packet: OnlineCeremonyPacket,
    bytes: Uint8Array,
  ): Promise<Result<void>> {
    const manifest = this.#escrowManifest;
    const escrow = this.#escrow;
    if (!manifest || !escrow) return success(undefined);
    const { seat: holderSeat, step: dealerSeat } = packet.body;
    const roster = this.#escrowRosters.find((item) => item.dealer.seat === dealerSeat);
    const holder = roster?.holders.find((item) => item.seat === holderSeat);
    if (!roster?.eligible || !holder || this.#ownerDevice(holder.seat) !== packet.body.senderDevice)
      return failure('online-ceremony-escrow', 'Invalid-envelope reporter is not its holder');
    const parsed = parseCanonical(packet.body.payload, invalidEscrowSchema);
    if (!parsed.ok) return parsed;
    let dealerBytes: Uint8Array;
    try {
      dealerBytes = fromBase64Url(parsed.value.dealerPacket);
      if (toBase64Url(dealerBytes) !== parsed.value.dealerPacket)
        return failure('online-ceremony-escrow', 'Invalid-envelope bytes are noncanonical');
    } catch {
      return failure('online-ceremony-escrow', 'Invalid-envelope bytes are malformed');
    }
    const dealerDevice = this.#ownerDevice(roster.dealer.seat);
    if (!dealerDevice)
      return failure('online-ceremony-escrow', 'Invalid-envelope dealer is missing');
    const dealerPacket = verifyOnlineCeremonyPacket(
      dealerBytes,
      dealerDevice,
      this.#freezeHash,
      this.#nonce,
    );
    if (
      !dealerPacket.ok ||
      dealerPacket.value.body.kind !== 'escrow-envelope' ||
      dealerPacket.value.body.seat !== roster.dealer.seat ||
      dealerPacket.value.body.step !== holder.seat
    )
      return failure('online-ceremony-escrow', 'Evidence lacks an authenticated dealer delivery');
    const envelopeSlot = this.#escrowEnvelopeSlot(manifest, [], roster, holder.seat);
    if (envelopeSlot.validate(dealerPacket.value.body.payload).ok)
      return failure('online-ceremony-escrow', 'A valid sealed share cannot be rejected');
    const key = this.#packetKey('escrow-invalid', holder.seat, roster.dealer.seat);
    const applied = await this.#attempt(async (record) => {
      const prior = await this.#options.store.load(key);
      if (prior !== null && !sameBytes(prior, bytes))
        return failure(
          'online-ceremony-conflict',
          'Another invalid-envelope report owns this slot',
        );
      if (prior === null && record.status === 'retired')
        return failure('online-ceremony-retired', 'New evidence cannot enter a retired attempt');
      if (prior === null && !(await this.#options.store.putIfAbsent(key, bytes))) {
        const winner = await this.#options.store.load(key);
        if (!winner || !sameBytes(winner, bytes))
          return failure(
            'online-ceremony-conflict',
            'Another invalid-envelope report owns this slot',
          );
      }
      const retired = await escrow.abort();
      if (
        !retired.ok &&
        retired.error.code !== 'escrow-ceremony-consenting' &&
        retired.error.code !== 'escrow-ceremony-completed'
      )
        return retired;
      if (!retired.ok) return success('consented' as const);
      if (record.status !== 'retired') {
        const before = canonicalEncode(record);
        const after = canonicalEncode({ ...record, status: 'retired' });
        if (
          !(await this.#options.store.compareAndSwap(
            `online-attempt/${this.#attemptId}`,
            before,
            after,
          ))
        )
          return failure('online-ceremony-record', 'Evidence retirement lost its durable race');
      }
      return success('retired' as const);
    });
    if (!applied.ok) return applied;
    this.#broadcast(key, bytes);
    if (applied.value === 'consented') {
      this.#locallyConsented = true;
      // A malformed dealer packet proves misconduct but reveals no private share.
      // It cannot revoke an already signed or certified genesis.
    } else {
      this.#result = null;
      this.#disclosureBytes.set(key, bytes.slice());
      this.#emit({
        phase: 'retired',
        awaitingSeats: [],
        error: 'online-ceremony-escrow-invalid',
        locallyConsented: false,
      });
    }
    return success(undefined);
  }

  async #acceptDisputePacket(
    packet: OnlineCeremonyPacket,
    bytes: Uint8Array,
  ): Promise<Result<void>> {
    const manifest = this.#escrowManifest;
    const escrow = this.#escrow;
    if (!manifest || !escrow) return success(undefined);
    const { seat: holderSeat, step: dealerSeat } = packet.body;
    const roster = this.#escrowRosters.find((item) => item.dealer.seat === dealerSeat);
    const holder = roster?.holders.find((item) => item.seat === holderSeat);
    if (!roster?.eligible || !holder || this.#ownerDevice(holder.seat) !== packet.body.senderDevice)
      return failure('online-ceremony-escrow', 'Dispute actor differs from frozen escrow holder');
    const parsed = parseCanonical(packet.body.payload, disputedEscrowSchema);
    if (!parsed.ok) return parsed;
    const verifier = prepareEscrowVerifier(manifest);
    if (!verifier.ok) return verifier;
    const masters = validateGenesisMasters(manifest);
    if (!masters.ok) return masters;
    const master = masters.value.find((item) => item.seat === roster.dealer.seat);
    if (!master) return failure('online-ceremony-escrow', 'Disputed dealer has no master');
    const envelope = verifier.value.envelope(
      parsed.value.envelope,
      roster.dealer.seat,
      master.masterPub,
    );
    if (!envelope.ok || envelope.value.body.holder.seat !== holder.seat)
      return failure('online-ceremony-escrow', 'Dispute references another sealed share');
    const verdict = verifyEscrowShareDispute(parsed.value.dispute, envelope.value, manifest);
    if (
      !verdict.ok ||
      verdict.value.dispute.body.holderSeat !== holder.seat ||
      verdict.value.dispute.body.dealerSeat !== roster.dealer.seat
    )
      return failure('online-ceremony-escrow', 'Dispute proof does not bind this delivery');
    const bound = await this.#checkConsentedDisputeEnvelope(
      manifest,
      roster.dealer.seat,
      holder.seat,
      envelope.value,
    );
    if (!bound.ok) return bound;
    const key = this.#packetKey('escrow-dispute', holder.seat, roster.dealer.seat);
    const applied = await this.#attempt(async (record) => {
      const prior = await this.#options.store.load(key);
      if (prior !== null && !sameBytes(prior, bytes))
        return failure('online-ceremony-conflict', 'Another dispute owns this slot');
      if (prior === null && record.status === 'retired')
        return failure('online-ceremony-retired', 'New dispute cannot enter a retired attempt');
      if (prior === null && !(await this.#options.store.putIfAbsent(key, bytes))) {
        const winner = await this.#options.store.load(key);
        if (!winner || !sameBytes(winner, bytes))
          return failure('online-ceremony-conflict', 'Another dispute owns this slot');
      }
      const disclosed = await escrow.receiveDispute(envelope.value, verdict.value.dispute);
      if (!disclosed.ok && disclosed.error.code !== 'escrow-ceremony-consenting-dispute')
        return disclosed;
      if (!disclosed.ok) return success('consented' as const);
      if (record.status !== 'retired') {
        const before = canonicalEncode(record);
        const after = canonicalEncode({ ...record, status: 'retired' });
        if (
          !(await this.#options.store.compareAndSwap(
            `online-attempt/${this.#attemptId}`,
            before,
            after,
          ))
        )
          return failure('online-ceremony-record', 'Dispute retirement lost its durable race');
      }
      return success('retired' as const);
    });
    if (!applied.ok) return applied;
    this.#result = null;
    this.#disclosureBytes.set(key, bytes.slice());
    this.#broadcast(key, bytes);
    if (applied.value === 'consented') {
      this.#locallyConsented = true;
      this.#emit({
        phase: 'waiting',
        awaitingSeats: [],
        error: 'online-ceremony-disputed',
        locallyConsented: true,
      });
    } else {
      this.#emit({
        phase: 'retired',
        awaitingSeats: [],
        error: 'online-ceremony-disputed',
        locallyConsented: false,
      });
    }
    return success(undefined);
  }

  async #checkConsentedDisputeEnvelope(
    manifest: GenesisBody,
    dealerSeat: Seat,
    holderSeat: Seat,
    envelope: EscrowShareEnvelope,
  ): Promise<Result<void>> {
    const status = await checkEscrowCeremonyActive(manifest, this.#options.store);
    if (status.ok || status.error.code === 'escrow-ceremony-retired') return success(undefined);
    if (
      status.error.code !== 'escrow-ceremony-consenting' &&
      status.error.code !== 'escrow-ceremony-completed'
    )
      return status;

    let finalBody: GenesisBody;
    if (this.#result) finalBody = this.#result.genesis;
    else if (this.#restoreExpected) finalBody = this.#restoreExpected.genesis;
    else {
      let bytes: Uint8Array | null;
      try {
        bytes = await this.#options.store.load(`online-draft/${this.#attemptId}`);
      } catch {
        return failure('online-ceremony-store', 'Could not read the pinned consent draft');
      }
      if (!bytes)
        return failure('online-ceremony-escrow', 'Consented ceremony has no pinned final draft');
      if (bytes.byteLength > MAX_MESSAGE_BYTES)
        return failure('online-ceremony-size', 'Pinned consent draft exceeds its size limit');
      let parsed: Result<GenesisBody>;
      try {
        parsed = parseCanonical(
          canonicalDecode(bytes),
          v.omit(genesisSchema, ['gameId', 'signatures']),
        );
      } catch {
        return failure('online-ceremony-record', 'Pinned consent draft is malformed');
      }
      if (!parsed.ok) return parsed;
      finalBody = parsed.value;
    }

    const transcript = validateGenesisEscrow(finalBody);
    if (!transcript.ok) return transcript;
    const expected = transcript.value
      .find((dealer) => dealer.dealerSeat === dealerSeat)
      ?.shares.find((share) => share.envelope.body.holder.seat === holderSeat)?.envelope;
    if (!expected || escrowShareEnvelopeHash(expected) !== escrowShareEnvelopeHash(envelope))
      return failure(
        'online-ceremony-escrow',
        'Post-consent dispute does not reference the pinned escrow delivery',
      );
    return success(undefined);
  }

  async #publishLocalDispute(
    manifest: GenesisBody,
    dealerSeat: Seat,
    holderSeat: Seat,
  ): Promise<Result<void>> {
    const roster = this.#escrowRosters.find((item) => item.dealer.seat === dealerSeat);
    const holder = roster?.holders.find((item) => item.seat === holderSeat);
    const owned = this.#owned.get(holderSeat);
    if (!roster || !holder || !owned)
      return failure('online-ceremony-escrow', 'Local dispute holder is missing');
    const bytes = await this.#options.store.load(
      this.#packetKey('escrow-envelope', dealerSeat, holderSeat),
    );
    if (!bytes) return failure('online-ceremony-escrow', 'Disputed sealed share is missing');
    const dealerDevice = this.#ownerDevice(dealerSeat);
    if (!dealerDevice)
      return failure('online-ceremony-escrow', 'Disputed dealer device is missing');
    const packet = verifyOnlineCeremonyPacket(bytes, dealerDevice, this.#freezeHash, this.#nonce);
    if (!packet.ok) return packet;
    const source = createStealSecretSource(owned.master, this.#nonce, holderSeat, owned.publicKey);
    let dispute: Result<EscrowShareDispute>;
    try {
      dispute = createEscrowShareDispute({
        genesis: manifest,
        envelope: packet.value.body.payload,
        dealerSeat,
        holderSeat,
        recipientEncryptionSecret: source.encryptionSecret(),
        holderSigningKey: owned.signingKey,
      });
    } finally {
      source.dispose();
    }
    if (!dispute.ok) return dispute;
    const signed = signOnlineCeremonyPacket(
      {
        protocol: 'online-ceremony-v1',
        freezeHash: this.#freezeHash,
        ceremonyNonce: this.#nonce,
        senderDevice: this.#self,
        kind: 'escrow-dispute',
        seat: holderSeat,
        step: dealerSeat,
        payload: { envelope: packet.value.body.payload, dispute: dispute.value },
      },
      this.#deviceKey,
    );
    return signed.ok ? this.#acceptDisputePacket(signed.value.packet, signed.value.bytes) : signed;
  }

  async #resumeEscrowDisclosures(): Promise<Result<boolean>> {
    for (const roster of this.#escrowRosters.filter((item) => item.eligible)) {
      for (const holder of roster.holders) {
        for (const kind of ['escrow-dispute', 'escrow-invalid'] as const) {
          const key = this.#packetKey(kind, holder.seat, roster.dealer.seat);
          // oxlint-disable-next-line no-await-in-loop -- Bounded fixed evidence slots precede new output.
          const bytes = await this.#options.store.load(key);
          if (!bytes) continue;
          const owner = this.#ownerDevice(holder.seat);
          if (!owner) return failure('online-ceremony-escrow', 'Disclosure owner is missing');
          const packet = verifyOnlineCeremonyPacket(bytes, owner, this.#freezeHash, this.#nonce);
          if (!packet.ok) return packet;
          // oxlint-disable no-await-in-loop -- A saved disclosure must retire/pause before returning.
          const handled =
            kind === 'escrow-dispute'
              ? await this.#acceptDisputePacket(packet.value, bytes)
              : await this.#acceptInvalidPacket(packet.value, bytes);
          // oxlint-enable no-await-in-loop
          if (!handled.ok) return handled;
          if (this.#disclosureBytes.has(key)) return success(true);
        }
      }
    }
    return success(false);
  }

  async #persistObject(id: string, value: unknown): Promise<Result<void>> {
    const bytes = canonicalEncode(value);
    if (bytes.length > MAX_MESSAGE_BYTES)
      return failure('online-ceremony-size', 'Durable ceremony record exceeds its limit');
    return this.#attempt(async (record) => {
      if (record.status === 'retired')
        return failure('online-ceremony-retired', 'Ceremony attempt was durably retired');
      const previous = await this.#options.store.load(id);
      if (previous !== null)
        return sameBytes(previous, bytes)
          ? success(undefined)
          : failure('online-ceremony-conflict', 'An immutable ceremony record differs');
      if (this.#restoreExpected)
        return failure('online-ceremony-restore', 'Completed ceremony record is missing');
      if (await this.#options.store.putIfAbsent(id, bytes)) return success(undefined);
      const winner = await this.#options.store.load(id);
      return winner && sameBytes(winner, bytes)
        ? success(undefined)
        : failure('online-ceremony-conflict', 'An immutable ceremony record differs');
    });
  }

  #createdAtSlot(): Slot<{ createdAt: number }> {
    const host = this.#agreement.state.hostPeer;
    const human = this.#agreement.state.seats.find(
      (seat) => seat.kind === 'human' && seat.peer === host,
    );
    if (!human) throw new Error('Frozen host has no human seat');
    return {
      kind: 'created-at',
      seat: human.seat,
      step: 0,
      ownerDevice: host,
      validate(payload) {
        return parseCanonical(payload, createdAtSchema);
      },
      ...(host === this.#self
        ? {
            produce: async (): Promise<Result<{ createdAt: number }>> =>
              this.#options.hostCreatedAt === undefined
                ? failure('online-ceremony-time', 'Host must provide a creation timestamp')
                : success({ createdAt: this.#options.hostCreatedAt }),
          }
        : {}),
    };
  }

  #bindingSlots(): readonly Slot<SignedGameSeatBinding>[] {
    return this.#agreement.state.seats.map((frozen) => {
      const ownerDevice = this.#ownerDevice(frozen.seat);
      if (!ownerDevice) throw new Error('Frozen seat has no device owner');
      return {
        kind: 'binding',
        seat: frozen.seat,
        step: 0,
        ownerDevice,
        validate: (payload): Result<SignedGameSeatBinding> => {
          const parsed = parseCanonical(payload, bindingSchema);
          if (!parsed.ok) return parsed;
          const body = parsed.value.body;
          if (
            body.seat !== frozen.seat ||
            body.devicePeer !== ownerDevice ||
            body.freezeHash !== this.#freezeHash ||
            body.ceremonyNonce !== this.#nonce ||
            body.protocolVersion !== PROTOCOL_VERSION ||
            body.engineVersion !== ENGINE_VERSION ||
            !verifyObject(
              'online-seat-binding-v1',
              body,
              parsed.value.sig,
              parsePeerId(ownerDevice),
            )
          )
            return failure(
              'online-ceremony-binding',
              'Binding differs from frozen owner or version',
            );
          return success(parsed.value);
        },
        ...(ownerDevice === this.#self
          ? {
              produce: async (): Promise<Result<SignedGameSeatBinding>> => {
                const owned = this.#owned.get(frozen.seat);
                if (!owned)
                  return failure('online-ceremony-material', 'Local seat material is missing');
                const masterPub = encodePoint(
                  scalePoint(G, scalarFromBytes(owned.master, { nonzero: true })),
                );
                const source = createStealSecretSource(
                  owned.master,
                  this.#nonce,
                  frozen.seat,
                  owned.publicKey,
                );
                try {
                  const encryptionKey = encodePoint(scalePoint(G, source.encryptionSecret()));
                  return signGameSeatBinding({
                    agreement: this.#agreement,
                    seat: frozen.seat,
                    deviceSecretKey: this.#deviceKey,
                    gamePeer: owned.publicKey,
                    masterPub,
                    encryptionKey,
                  });
                } finally {
                  source.dispose();
                }
              },
            }
          : {}),
      };
    });
  }

  #buildManifest(bindings: VerifiedGameSeatBindings, createdAt: number): GenesisBody {
    return {
      protocolVersion: PROTOCOL_VERSION,
      engineVersion: ENGINE_VERSION,
      config: copy(this.#agreement.state.config),
      takeover: copy(this.#agreement.state.takeover),
      seats: bindings.genesisSeats.map((seat) => ({ ...seat })),
      genesisSeed: toBase64Url(new Uint8Array(32)),
      ceremonyNonce: this.#nonce,
      security: 'verified',
      commitments: { masters: copy(bindings.masters) },
      createdAt,
    };
  }

  #approvalSlots(manifest: GenesisBody): readonly Slot<EscrowManifestApproval>[] {
    const ceremonyId = deckCeremonyId(manifest);
    return manifest.seats
      .filter((seat) => seat.kind === 'human')
      .map((human) => {
        const ownerDevice = this.#ownerDevice(human.seat);
        if (!ownerDevice) throw new Error('Human approval has no device owner');
        return {
          kind: 'approval',
          seat: human.seat,
          step: 0,
          ownerDevice,
          validate: (payload): Result<EscrowManifestApproval> => {
            const parsed = parseCanonical(payload, approvalSchema);
            if (!parsed.ok) return parsed;
            const body = parsed.value.body;
            if (
              body.ceremonyId !== ceremonyId ||
              body.seat !== human.seat ||
              body.publicKey !== human.publicKey ||
              !verifyObject(
                'escrow-manifest-approval',
                body,
                parsed.value.sig,
                parsePeerId(human.publicKey),
              )
            )
              return failure(
                'online-ceremony-approval',
                'Manifest approval differs from frozen game seat',
              );
            return success(parsed.value);
          },
          ...(ownerDevice === this.#self
            ? {
                produce: async (): Promise<Result<EscrowManifestApproval>> => {
                  const owned = this.#owned.get(human.seat);
                  if (!owned || !this.#escrow)
                    return failure('online-ceremony-material', 'Local approval source is missing');
                  return this.#escrow.approveAndSend(
                    manifest,
                    human.seat,
                    owned.signingKey,
                    () => undefined,
                  );
                },
              }
            : {}),
        };
      });
  }

  #escrowEnvelopeSlot(
    manifest: GenesisBody,
    approvals: readonly EscrowManifestApproval[],
    roster: EscrowDealerRoster,
    holderSeat: Seat,
  ): Slot<EscrowShareEnvelope> {
    const dealerSeat = roster.dealer.seat;
    const ownerDevice = this.#ownerDevice(dealerSeat);
    const holderDevice = this.#ownerDevice(holderSeat);
    if (!ownerDevice || !holderDevice) throw new Error('Escrow delivery lacks a frozen device');
    const masters = validateGenesisMasters(manifest);
    if (!masters.ok) throw new Error('Escrow dealer master roster is invalid');
    const masterPub = masters.value.find((item) => item.seat === dealerSeat)?.masterPub;
    if (!masterPub) throw new Error('Escrow dealer master is missing');
    return {
      kind: 'escrow-envelope',
      seat: dealerSeat,
      step: holderSeat,
      ownerDevice,
      escrowRecipients: [holderDevice],
      escrowManifest: manifest,
      validate: (payload) => {
        const verifier = prepareEscrowVerifier(manifest);
        if (!verifier.ok) return verifier;
        const checked = verifier.value.envelope(payload, dealerSeat, masterPub);
        return checked.ok && checked.value.body.holder.seat !== holderSeat
          ? failure('online-ceremony-escrow', 'Sealed share belongs to another holder')
          : checked;
      },
      ...(ownerDevice === this.#self
        ? {
            produce: async (): Promise<Result<EscrowShareEnvelope>> => {
              let envelopes = this.#dealerEnvelopes.get(dealerSeat);
              if (!envelopes) {
                const owned = this.#owned.get(dealerSeat);
                if (!owned || !this.#escrow)
                  return failure('online-ceremony-material', 'Escrow dealer material is missing');
                const captured: EscrowShareEnvelope[] = [];
                const result = await this.#escrow.distributeAndSend({
                  genesis: manifest,
                  approvals,
                  dealerSeat,
                  master: owned.master,
                  dealerSigningKey: owned.signingKey,
                  send: (_holder, envelope) => {
                    captured.push(envelope);
                  },
                });
                if (!result.ok) return result;
                if (captured.length !== result.value.length)
                  return failure('online-ceremony-escrow', 'Distribution callback omitted a share');
                envelopes = result.value;
                this.#dealerEnvelopes.set(dealerSeat, envelopes);
              }
              const envelope = envelopes.find((item) => item.body.holder.seat === holderSeat);
              return envelope
                ? success(envelope)
                : failure('online-ceremony-escrow', 'Dealer omitted a required holder');
            },
          }
        : {}),
    };
  }

  #escrowAcceptedSlot(
    manifest: GenesisBody,
    roster: EscrowDealerRoster,
    holderSeat: Seat,
  ): Slot<{ envelope: EscrowShareEnvelope; ack: EscrowShareAck }> {
    const dealerSeat = roster.dealer.seat;
    const ownerDevice = this.#ownerDevice(holderSeat);
    if (!ownerDevice) throw new Error('Escrow holder lacks a frozen device');
    const envelopeSlot = this.#escrowEnvelopeSlot(manifest, [], roster, holderSeat);
    return {
      kind: 'escrow-accepted',
      seat: holderSeat,
      step: dealerSeat,
      ownerDevice,
      escrowManifest: manifest,
      validate: (payload) => {
        const parsed = parseCanonical(payload, acceptedEscrowSchema);
        if (!parsed.ok) return parsed;
        const envelope = envelopeSlot.validate(parsed.value.envelope);
        if (!envelope.ok) return envelope;
        const masterPub = envelope.value.body.masterPub;
        const ack = verifyEscrowShareAck(parsed.value.ack, manifest, {
          ceremonyId: deckCeremonyId(manifest),
          dealerSeat,
          holderSeat,
          expectedMasterPub: masterPub,
          shareHash: envelope.value.body.shareHash,
          envelopeHash: escrowShareEnvelopeHash(envelope.value),
        });
        return ack.ok ? success({ envelope: envelope.value, ack: ack.value }) : ack;
      },
      ...(ownerDevice === this.#self
        ? {
            produce: async (): Promise<
              Result<{ envelope: EscrowShareEnvelope; ack: EscrowShareAck }>
            > => {
              const bytes = await this.#options.store.load(
                this.#packetKey('escrow-envelope', dealerSeat, holderSeat),
              );
              if (!bytes) return failure('online-ceremony-escrow', 'Private share has not arrived');
              const packet = verifyOnlineCeremonyPacket(
                bytes,
                envelopeSlot.ownerDevice,
                this.#freezeHash,
                this.#nonce,
              );
              if (!packet.ok) return packet;
              const envelope = envelopeSlot.validate(packet.value.body.payload);
              if (!envelope.ok) return envelope;
              const owned = this.#owned.get(holderSeat);
              if (!owned || !this.#escrow)
                return failure('online-ceremony-material', 'Escrow holder material is missing');
              const source = createStealSecretSource(
                owned.master,
                this.#nonce,
                holderSeat,
                owned.publicKey,
              );
              try {
                const result = await this.#escrow.acceptAndSendAck({
                  envelope: envelope.value,
                  dealerSeat,
                  expectedMasterPub: envelope.value.body.masterPub,
                  holderSeat,
                  recipientEncryptionSecret: source.encryptionSecret(),
                  holderSigningKey: owned.signingKey,
                  send: () => undefined,
                });
                if (!result.ok) this.#failedAcceptance = { dealerSeat, holderSeat };
                return result.ok
                  ? success({ envelope: envelope.value, ack: result.value })
                  : result;
              } finally {
                source.dispose();
              }
            },
          }
        : {}),
    };
  }

  async #escrowTranscript(
    manifest: GenesisBody,
    approvals: readonly EscrowManifestApproval[],
  ): Promise<Result<readonly EscrowDealerCommitment[] | null>> {
    const rosters = this.#escrowRosters.filter((roster) => roster.eligible);
    for (const roster of rosters) {
      if (this.#ownerDevice(roster.dealer.seat) !== this.#self) continue;
      for (const holder of roster.holders) {
        const slot = this.#escrowEnvelopeSlot(manifest, approvals, roster, holder.seat);
        // oxlint-disable-next-line no-await-in-loop -- Each durable private share is sent in roster order.
        const produced = await this.#outgoing(
          slot,
          this.#packetKey(slot.kind, slot.seat, slot.step),
        );
        if (!produced.ok) return produced;
      }
    }
    const missing: Seat[] = [];
    for (const roster of rosters) {
      for (const holder of roster.holders) {
        if (this.#ownerDevice(holder.seat) !== this.#self) continue;
        // oxlint-disable-next-line no-await-in-loop -- Fixed private inbox slots are inspected in roster order.
        const bytes = await this.#options.store.load(
          this.#packetKey('escrow-envelope', roster.dealer.seat, holder.seat),
        );
        if (!bytes) missing.push(roster.dealer.seat);
      }
    }
    if (missing.length) {
      if (this.#restoreExpected)
        return failure('online-ceremony-restore', 'Completed private escrow inbox is missing');
      this.#emit({ phase: 'escrow', awaitingSeats: missing, error: null, locallyConsented: false });
      return success(null);
    }
    const slots = rosters.flatMap((roster) =>
      roster.holders.map((holder) => this.#escrowAcceptedSlot(manifest, roster, holder.seat)),
    );
    const accepted = await this.#exchange('escrow', slots);
    if (!accepted.ok) {
      const failed = this.#failedAcceptance;
      this.#failedAcceptance = null;
      if (failed) {
        const disputed = await this.#publishLocalDispute(
          manifest,
          failed.dealerSeat,
          failed.holderSeat,
        );
        if (disputed.ok)
          return failure('online-ceremony-disputed', 'A sealed escrow share was invalid');
      }
      return accepted;
    }
    if (accepted.value === null) return success(null);
    const pairs = accepted.value;
    let index = 0;
    const transcript = rosters.map((roster) => ({
      dealerSeat: roster.dealer.seat,
      shares: roster.holders.map(() => {
        const pair = pairs[index++];
        if (!pair) throw new Error('Escrow accepted pair is missing');
        return pair;
      }),
    }));
    const checked = validateGenesisEscrow({
      ...manifest,
      commitments: { ...manifest.commitments, escrow: transcript },
    });
    return checked.ok ? success(checked.value) : checked;
  }

  #beaconSlots(manifest: GenesisBody): readonly Slot<v.InferOutput<typeof beaconTipSchema>>[] {
    const ceremonyId = deckCeremonyId(manifest);
    return manifest.seats
      .filter((seat) => seat.kind === 'human')
      .map((human) => {
        const ownerDevice = this.#ownerDevice(human.seat);
        if (!ownerDevice) throw new Error('Human beacon has no device owner');
        return {
          kind: 'beacon-tip',
          seat: human.seat,
          step: 0,
          ownerDevice,
          validate: (payload) => {
            const parsed = parseCanonical(payload, beaconTipSchema);
            if (!parsed.ok) return parsed;
            const body = parsed.value.body;
            if (
              body.ceremonyId !== ceremonyId ||
              body.seat !== human.seat ||
              body.length < 1 ||
              body.length > 65_536 ||
              !verifyObject(
                'online-beacon-tip-v1',
                body,
                parsed.value.sig,
                parsePeerId(human.publicKey),
              )
            )
              return failure('online-ceremony-beacon', 'Beacon tip differs from frozen human seat');
            return success(parsed.value);
          },
          ...(ownerDevice === this.#self
            ? {
                produce: async () => {
                  const owned = this.#owned.get(human.seat);
                  if (!owned)
                    return failure('online-ceremony-material', 'Local beacon master is missing');
                  const source = createBeaconSecretSource(owned.master, {
                    ceremonyId,
                    seat: human.seat,
                  });
                  try {
                    const initial = source.initialCommitment;
                    const body = {
                      protocol: 'online-beacon-tip-v1' as const,
                      ceremonyId,
                      seat: human.seat,
                      length: initial.length,
                      tip: toBase64Url(initial.tip),
                    };
                    return success({
                      body,
                      sig: signObject('online-beacon-tip-v1', body, owned.signingKey),
                    });
                  } finally {
                    source.dispose();
                  }
                },
              }
            : {}),
        };
      });
  }

  #seedScope(manifest: GenesisBody): GenesisSeedScope {
    return {
      freezeHash: this.#freezeHash,
      ceremonyNonce: this.#nonce,
      ceremonyId: deckCeremonyId(manifest),
      participants: manifest.seats.map(({ seat, publicKey }) => ({ seat, publicKey })),
      mode: this.#agreement.state.seedMode,
    };
  }

  #seedCommitSlots(scope: GenesisSeedScope): readonly Slot<SignedGenesisSeedCommit>[] {
    return scope.participants.map((participant) => {
      const ownerDevice = this.#ownerDevice(participant.seat);
      if (!ownerDevice) throw new Error('Seed participant has no device owner');
      return {
        kind: 'seed-commit',
        seat: participant.seat,
        step: 0,
        ownerDevice,
        validate: (payload) => {
          const parsed = parseCanonical(payload, seedCommitSchema);
          if (!parsed.ok) return parsed;
          const body = parsed.value.body;
          if (
            body.seat !== participant.seat ||
            body.freezeHash !== scope.freezeHash ||
            body.ceremonyNonce !== scope.ceremonyNonce ||
            !verifyObject(
              'genesis-seed-commit-v1',
              body,
              parsed.value.sig,
              parsePeerId(participant.publicKey),
            )
          )
            return failure(
              'online-ceremony-seed',
              'Seed commitment differs from exact signed seat',
            );
          return success(parsed.value);
        },
        ...(ownerDevice === this.#self
          ? {
              produce: async (): Promise<Result<SignedGenesisSeedCommit>> => {
                const owned = this.#owned.get(participant.seat);
                return owned
                  ? createGenesisSeedCommit(scope, participant.seat, owned.master, owned.signingKey)
                  : failure('online-ceremony-material', 'Local seed master is missing');
              },
            }
          : {}),
      };
    });
  }

  #seedRevealSlots(
    scope: GenesisSeedScope,
    commits: readonly SignedGenesisSeedCommit[],
  ): readonly Slot<SignedGenesisSeedReveal>[] {
    return scope.participants.map((participant, index) => {
      const ownerDevice = this.#ownerDevice(participant.seat);
      if (!ownerDevice) throw new Error('Seed participant has no device owner');
      const commit = commits[index];
      if (!commit) throw new Error('Seed commitment is missing');
      return {
        kind: 'seed-reveal',
        seat: participant.seat,
        step: 0,
        ownerDevice,
        validate: (payload) => {
          const parsed = parseCanonical(payload, seedRevealSchema);
          if (!parsed.ok) return parsed;
          const body = parsed.value.body;
          const expected = toHex(
            hashValue({
              domain: 'cp2p/v1/genesis-seed-commit',
              ceremonyNonce: scope.ceremonyNonce,
              seat: participant.seat,
              share: body.share,
            }),
          );
          if (
            body.seat !== participant.seat ||
            body.freezeHash !== scope.freezeHash ||
            body.ceremonyNonce !== scope.ceremonyNonce ||
            expected !== commit.body.commit ||
            !verifyObject(
              'genesis-seed-reveal-v1',
              body,
              parsed.value.sig,
              parsePeerId(participant.publicKey),
            )
          )
            return failure(
              'online-ceremony-seed',
              'Seed reveal differs from committed signed share',
            );
          return success(parsed.value);
        },
        ...(ownerDevice === this.#self
          ? {
              produce: async (): Promise<Result<SignedGenesisSeedReveal>> => {
                const owned = this.#owned.get(participant.seat);
                return owned
                  ? createGenesisSeedReveal(scope, participant.seat, owned.master, owned.signingKey)
                  : failure('online-ceremony-material', 'Local seed master is missing');
              },
            }
          : {}),
      };
    });
  }

  async #seedTranscript(
    manifest: GenesisBody,
  ): Promise<Result<{ transcript: GenesisSeedTranscript; seed: string } | null>> {
    const scope = this.#seedScope(manifest);
    if (scope.mode.kind === 'fixed') {
      const transcript = { protocol: 'genesis-seed-v1', kind: 'fixed', seed: scope.mode.seed };
      const checked = validateGenesisSeedTranscript(scope, transcript);
      return checked.ok
        ? success({ transcript: checked.value.transcript, seed: checked.value.genesisSeed })
        : checked;
    }
    const commits = await this.#exchange('seed-commits', this.#seedCommitSlots(scope));
    if (!commits.ok) return commits;
    if (commits.value === null) return success(null);
    const reveals = await this.#exchange(
      'seed-reveals',
      this.#seedRevealSlots(scope, commits.value),
    );
    if (!reveals.ok) return reveals;
    if (reveals.value === null) return success(null);
    const checked = validateGenesisSeedTranscript(scope, {
      protocol: 'genesis-seed-v1',
      kind: 'joint',
      commits: commits.value,
      reveals: reveals.value,
    });
    return checked.ok
      ? success({ transcript: checked.value.transcript, seed: checked.value.genesisSeed })
      : checked;
  }

  async #deckTranscripts(
    manifest: GenesisBody,
  ): Promise<Result<readonly { deckId: string; passes: readonly SignedDeckPass[] }[] | null>> {
    const definitions = genesisDeckDefinitions(manifest);
    if (!definitions.ok) return definitions;
    const transcripts: { deckId: string; passes: SignedDeckPass[] }[] = [];
    for (const definition of definitions.value) {
      const initial = initDeckSetup(definition);
      if (!initial.ok) return initial;
      let state: DeckSetupState = initial.value;
      const passes: SignedDeckPass[] = [];
      for (let step = 0; step < definition.participants.length * 2; step += 1) {
        const actor = definition.participants[step % definition.participants.length];
        if (!actor) return failure('online-ceremony-deck', 'Deck actor is missing');
        const ownerDevice = this.#ownerDevice(actor.seat);
        if (!ownerDevice) return failure('online-ceremony-deck', 'Deck actor has no device owner');
        const before = state;
        const slot: Slot<SignedDeckPass> = {
          kind: 'deck-pass',
          seat: actor.seat,
          step,
          ownerDevice,
          validate: (payload) => {
            const applied = applyDeckPass(before, payload);
            if (!applied.ok) return applied;
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- applyDeckPass validates the exact complete signed pass.
            return success(payload as SignedDeckPass);
          },
          ...(ownerDevice === this.#self
            ? {
                produce: async (): Promise<Result<SignedDeckPass>> => {
                  const owned = this.#owned.get(actor.seat);
                  if (!owned)
                    return failure('online-ceremony-material', 'Local deck master is missing');
                  const source = createDeckSecretSource(owned.master, definition, actor.seat);
                  try {
                    const produced = await prepareDeckPass(
                      before,
                      actor.seat,
                      owned.signingKey,
                      source,
                      this.#options.store,
                    );
                    return produced.ok
                      ? produced.value
                        ? success(produced.value)
                        : failure('online-ceremony-deck', 'Local actor did not produce its pass')
                      : produced;
                  } finally {
                    source.dispose();
                  }
                },
              }
            : {}),
        };
        // oxlint-disable-next-line no-await-in-loop -- A deck pass depends on the certified preceding pass.
        const exchanged = await this.#exchange('deck', [slot]);
        if (!exchanged.ok) return exchanged;
        if (exchanged.value === null) return success(null);
        const pass = exchanged.value[0];
        if (!pass) return failure('online-ceremony-deck', 'Deck pass is missing');
        const applied = applyDeckPass(state, pass);
        if (!applied.ok) return applied;
        state = applied.value;
        passes.push(pass);
      }
      transcripts.push({ deckId: definition.deckId, passes });
    }
    return success(transcripts);
  }

  #finalBody(
    manifest: GenesisBody,
    bindings: VerifiedGameSeatBindings,
    escrow: readonly EscrowDealerCommitment[],
    beacons: readonly v.InferOutput<typeof beaconTipSchema>[],
    seed: { transcript: GenesisSeedTranscript; seed: string },
    transcripts: readonly { deckId: string; passes: readonly SignedDeckPass[] }[],
  ): Result<GenesisBody> {
    const definitions = genesisDeckDefinitions(manifest);
    if (!definitions.ok) return definitions;
    const decks = definitions.value.map((definition, index) => {
      const transcript = transcripts[index];
      if (!transcript || transcript.deckId !== definition.deckId)
        throw new Error('Deck transcript differs from canonical definition order');
      return unwrap(createDeckGenesisCommitment(definition, transcript.passes));
    });
    return success({
      ...manifest,
      genesisSeed: seed.seed,
      commitments: {
        ...manifest.commitments,
        escrow,
        beaconChains: beacons.map(({ body }) => ({
          seat: body.seat,
          length: body.length,
          tip: body.tip,
        })),
        decks,
        onlineStart: {
          protocol: 'online-start-v1',
          agreement: this.#agreement,
          bindings: bindings.bindings,
          seed: seed.transcript,
        },
      },
    });
  }

  #consentSlots(
    body: GenesisBody,
    transcripts: readonly { deckId: string; passes: readonly SignedDeckPass[] }[],
  ): readonly Slot<SeatSignature>[] {
    const digest = genesisDigest(body);
    return body.seats
      .filter((seat) => seat.kind === 'human')
      .map((human) => {
        const ownerDevice = this.#ownerDevice(human.seat);
        if (!ownerDevice) throw new Error('Genesis voter has no device owner');
        return {
          kind: 'consent',
          seat: human.seat,
          step: 0,
          ownerDevice,
          validate: (payload) => {
            const parsed = parseCanonical(payload, consentSchema);
            if (!parsed.ok) return parsed;
            if (
              parsed.value.seat !== human.seat ||
              !verifyObject(
                'genesis',
                { genesisDigest: digest },
                parsed.value.sig,
                parsePeerId(human.publicKey),
              )
            )
              return failure(
                'online-ceremony-consent',
                'Genesis signature differs from exact final body',
              );
            return success(parsed.value);
          },
          ...(ownerDevice === this.#self
            ? {
                produce: async (): Promise<Result<SeatSignature>> => {
                  const owned = this.#owned.get(human.seat);
                  if (!owned || !this.#escrow)
                    return failure(
                      'online-ceremony-material',
                      'Local genesis consent source is missing',
                    );
                  const signed = await this.#escrow.consentAndSend({
                    body,
                    transcripts,
                    seat: human.seat,
                    signingKey: owned.signingKey,
                    send: () => undefined,
                  });
                  if (signed.ok) this.#locallyConsented = true;
                  return signed;
                },
              }
            : {}),
        };
      });
  }

  #entrySlot(
    genesis: Genesis,
    transcripts: readonly { deckId: string; passes: readonly SignedDeckPass[] }[],
  ): Slot<LogEntry> {
    const firstHuman = genesis.seats.find((seat) => seat.kind === 'human');
    if (!firstHuman) throw new Error('Genesis has no human sequencer');
    const ownerDevice = this.#ownerDevice(firstHuman.seat);
    if (!ownerDevice) throw new Error('Genesis sequencer has no device owner');
    const digest = genesisDigest(genesis);
    return {
      kind: 'genesis-entry',
      seat: firstHuman.seat,
      step: 0,
      ownerDevice,
      validate: (payload) => {
        const checkedEntry = validateGenesisEntry(payload, this.#options.engine, {
          verifyCommitments: (candidate) => {
            if (genesisDigest(candidate) !== digest)
              return failure('online-ceremony-genesis', 'Entry differs from final signed body');
            return validateDeckCeremony(candidate, transcripts);
          },
        });
        return checkedEntry.ok ? success(checkedEntry.value.entry) : checkedEntry;
      },
      ...(ownerDevice === this.#self
        ? {
            produce: async (): Promise<Result<LogEntry>> => {
              const owned = this.#owned.get(firstHuman.seat);
              if (!owned)
                return failure('online-ceremony-material', 'Genesis sequencer key is missing');
              const state = this.#options.engine.createGame(
                genesis.config,
                fromBase64Url(genesis.genesisSeed),
              );
              return success(
                signEntry(
                  {
                    seq: 0,
                    term: 1,
                    prevHash: GENESIS_PREVIOUS_HASH,
                    payload: { kind: 'genesis', genesis },
                    stateHash: toHex(hashValue(state)),
                    sequencer: firstHuman.publicKey,
                  },
                  owned.signingKey,
                ),
              );
            },
          }
        : {}),
    };
  }

  async #advance(): Promise<Result<void>> {
    if (this.#disposed) return failure('online-ceremony-disposed', 'Ceremony is disposed');
    if (this.#disclosureBytes.size > 0) {
      for (const [key, bytes] of this.#disclosureBytes) this.#broadcast(key, bytes);
      return success(undefined);
    }
    if (this.#progress.phase === 'retired')
      return failure('online-ceremony-retired', 'Ceremony attempt was durably retired');
    if (this.#result) {
      const first = this.#result.genesis.seats.find((seat) => seat.kind === 'human');
      if (first && this.#ownerDevice(first.seat) === this.#self) {
        const key = this.#packetKey('genesis-entry', first.seat, 0);
        const bytes = await this.#options.store.load(key);
        if (bytes) this.#broadcast(key, bytes);
      }
      return success(undefined);
    }
    try {
      const advanced = await this.#advancePhases();
      if (!advanced.ok && advanced.error.code === 'online-ceremony-timeout') {
        const retired = await this.#abortUnsafe('online-ceremony-timeout');
        return retired.ok || (this.#locallyConsented && this.#progress.phase === 'waiting')
          ? success(undefined)
          : retired;
      }
      if (!advanced.ok && this.#locallyConsented && this.#progress.phase === 'waiting')
        return success(undefined);
      if (
        !advanced.ok &&
        this.snapshot().phase !== 'retired' &&
        this.#progress.error !== 'online-ceremony-disputed' &&
        this.#progress.error !== 'online-ceremony-escrow-invalid'
      )
        this.#emit({
          phase: 'error',
          awaitingSeats: [],
          error: advanced.error.code,
          locallyConsented: this.#locallyConsented,
        });
      return advanced;
    } catch {
      this.#emit({
        phase: 'error',
        awaitingSeats: [],
        error: 'online-ceremony-internal',
        locallyConsented: this.#locallyConsented,
      });
      return failure('online-ceremony-internal', 'Could not advance the frozen ceremony');
    }
  }

  async #advancePhases(): Promise<Result<void>> {
    const created = await this.#exchange('frozen', [this.#createdAtSlot()]);
    if (!created.ok) return created;
    if (created.value === null) return success(undefined);
    const createdAt = created.value[0]?.createdAt;
    if (createdAt === undefined)
      return failure('online-ceremony-time', 'Host creation timestamp is missing');

    const exchangedBindings = await this.#exchange('bindings', this.#bindingSlots());
    if (!exchangedBindings.ok) return exchangedBindings;
    if (exchangedBindings.value === null) return success(undefined);
    const verified = verifyGameSeatBindings(this.#agreement, exchangedBindings.value);
    if (!verified.ok) return verified;
    const manifest = this.#buildManifest(verified.value, createdAt);
    const pinned = await this.#persistObject(`online-manifest/${this.#attemptId}`, manifest);
    if (!pinned.ok) return pinned;
    this.#escrow ??= new EscrowCeremony(manifest, this.#options.store);
    this.#escrowManifest = manifest;
    if (!this.#restoreExpected) {
      const status = await checkEscrowCeremonyActive(manifest, this.#options.store);
      if (!status.ok && status.error.code === 'escrow-ceremony-retired')
        return this.#abortUnsafe('online-ceremony-escrow-retired');
    }
    if (this.#restoreExpected) {
      const completed = await checkEscrowCeremonyActive(manifest, this.#options.store);
      if (completed.ok || completed.error.code !== 'escrow-ceremony-completed')
        return failure('online-ceremony-restore', 'Certified escrow completion is missing');
    }
    const rosters = deriveEscrowRosters(manifest);
    if (!rosters.ok) return rosters;
    this.#escrowRosters = rosters.value;
    const disclosure = await this.#resumeEscrowDisclosures();
    if (!disclosure.ok) return disclosure;
    if (disclosure.value) return success(undefined);

    const approvals = await this.#exchange('approvals', this.#approvalSlots(manifest));
    if (!approvals.ok) return approvals;
    if (approvals.value === null) return success(undefined);
    const approved = verifyEscrowManifestApprovals(manifest, approvals.value);
    if (!approved.ok) return approved;

    const escrow = rosters.value.some((roster) => roster.eligible)
      ? await this.#escrowTranscript(manifest, approvals.value)
      : success([] as readonly EscrowDealerCommitment[]);
    if (!escrow.ok) return escrow;
    if (escrow.value === null) return success(undefined);

    const beacons = await this.#exchange('beacon-tips', this.#beaconSlots(manifest));
    if (!beacons.ok) return beacons;
    if (beacons.value === null) return success(undefined);

    const seed = await this.#seedTranscript(manifest);
    if (!seed.ok) return seed;
    if (seed.value === null) return success(undefined);

    const transcripts = await this.#deckTranscripts(manifest);
    if (!transcripts.ok) return transcripts;
    if (transcripts.value === null) return success(undefined);
    const retained = await this.#persistObject(
      `online-transcripts/${this.#attemptId}`,
      transcripts.value,
    );
    if (!retained.ok) return retained;
    const finalBody = this.#finalBody(
      manifest,
      verified.value,
      escrow.value,
      beacons.value,
      seed.value,
      transcripts.value,
    );
    if (!finalBody.ok) return finalBody;
    const pinnedDraft = await this.#persistObject(
      `online-draft/${this.#attemptId}`,
      finalBody.value,
    );
    if (!pinnedDraft.ok) return pinnedDraft;

    const consents = await this.#exchange(
      'consent',
      this.#consentSlots(finalBody.value, transcripts.value),
    );
    if (!consents.ok) return consents;
    if (consents.value === null) return success(undefined);
    const genesis: Genesis = {
      ...finalBody.value,
      gameId: genesisId(finalBody.value),
      signatures: [...consents.value],
    };
    const entry = await this.#exchange('waiting', [this.#entrySlot(genesis, transcripts.value)]);
    if (!entry.ok) return entry;
    if (entry.value === null) return success(undefined);
    const signedEntry = entry.value[0];
    if (!signedEntry || !this.#escrow)
      return failure('online-ceremony-genesis', 'Signed genesis entry is missing');
    const complete = await this.#escrow.complete({
      signedGenesisEntry: signedEntry,
      transcripts: transcripts.value,
      engine: this.#options.engine,
    });
    if (!complete.ok) return complete;
    const retainedEntry = await this.#persistObject(`online-entry/${this.#attemptId}`, signedEntry);
    if (!retainedEntry.ok) return retainedEntry;
    const result: OnlineCeremonyResult = {
      entry: signedEntry,
      genesis,
      transcripts: transcripts.value,
      bindings: verified.value.bindings,
    };
    if (
      this.#restoreExpected &&
      !sameBytes(canonicalEncode(result), canonicalEncode(this.#restoreExpected))
    )
      return failure('online-ceremony-restore', 'Restored result differs from completed result');
    this.#result = copy(result);
    if (!this.#restoreExpected)
      this.#emit({
        phase: 'ready',
        awaitingSeats: [],
        error: null,
        locallyConsented: this.#locallyConsented,
      });
    return success(undefined);
  }
}

```
## Focused test diff
```diff
diff --git a/packages/protocol/src/online-ceremony.test.ts b/packages/protocol/src/online-ceremony.test.ts
index 01e68dc..b0ba54e 100644
--- a/packages/protocol/src/online-ceremony.test.ts
+++ b/packages/protocol/src/online-ceremony.test.ts
@@ -1046,4 +1046,84 @@ describe('online genesis ceremony', () => {
       error: { code: 'online-ceremony-retired' },
     });
   });
+
+  test('a preconsent timeout retains its bounded phase diagnostic after restart', async () => {
+    const room = setup();
+    const store = new MemoryEscrowLifecycleStore();
+    const first = room.create(0, store);
+    active.push({
+      dispose() {
+        first.dispose();
+        room.network.dispose();
+      },
+    });
+    expect((await first.start()).ok).toBe(true);
+    expect(first.snapshot().phase).toBe('bindings');
+    room.network.clock.advanceBy(20_001);
+    await until(room, () => first.snapshot().phase === 'retired');
+    expect(first.snapshot().error).toBe('online-ceremony-timeout:bindings');
+    first.dispose();
+    const restored = room.create(0, store);
+    active.push(restored);
+    expect(await restored.start()).toMatchObject({
+      ok: false,
+      error: { code: 'online-ceremony-timeout' },
+    });
+  });
+
+  test('later signed phases get their own 20-second window without renewing earlier phases', async () => {
+    const room = setup();
+    let holdGuestCommit = true;
+    const guestTransport = interceptTransport(
+      room,
+      1,
+      (_to, _bytes, packet) => holdGuestCommit && packet.body.kind === 'seed-commit',
+    );
+    const host = room.create(0);
+    const guest = room.create(1, required(room.stores[1]), guestTransport);
+    active.push({
+      dispose() {
+        host.dispose();
+        guest.dispose();
+        room.network.dispose();
+      },
+    });
+    expect((await host.start()).ok).toBe(true);
+    expect(host.snapshot().phase).toBe('bindings');
+    room.network.clock.advanceBy(15_000);
+    expect((await guest.start()).ok).toBe(true);
+    await until(room, () => host.snapshot().phase === 'seed-commits');
+    room.network.clock.advanceBy(10_000);
+    await until(room, () => host.snapshot().phase === 'seed-commits');
+    expect(host.snapshot().phase).not.toBe('retired');
+    holdGuestCommit = false;
+    room.network.clock.advanceBy(1_001);
+    await settle(room, [host, guest]);
+    expect(host.snapshot().phase).toBe('ready');
+    expect(guest.snapshot().phase).toBe('ready');
+  }, 60_000);
+
+  test('same-phase retries and restart retain the original deadline', async () => {
+    const room = setup();
+    const store = new MemoryEscrowLifecycleStore();
+    const first = room.create(0, store);
+    active.push({
+      dispose() {
+        first.dispose();
+        room.network.dispose();
+      },
+    });
+    expect((await first.start()).ok).toBe(true);
+    room.network.clock.advanceBy(10_000);
+    await until(room, () => first.snapshot().phase === 'bindings');
+    first.dispose();
+    const restored = room.create(0, store);
+    active.push(restored);
+    expect((await restored.start()).ok).toBe(true);
+    room.network.clock.advanceBy(9_999);
+    await until(room, () => restored.snapshot().phase === 'bindings');
+    room.network.clock.advanceBy(1);
+    await until(room, () => restored.snapshot().phase === 'retired');
+    expect(restored.snapshot().error).toBe('online-ceremony-timeout:bindings');
+  });
 });

```
