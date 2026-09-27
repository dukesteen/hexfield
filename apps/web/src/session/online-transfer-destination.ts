import { canonicalDecode, canonicalEncode, sha256, toHex } from '@cp2p/codec';
import { identityFromSecret, signObject } from '@cp2p/crypto';
import { createBaseEngine } from '@cp2p/engine';
import type { Seat } from '@cp2p/engine';
import {
  genesisDigest,
  importTransferPrivate,
  replayCertifiedPrefix,
  restoreRetiredSafety,
  transferCheckDigest,
  transferEntryRef,
  TRANSFER_BOT_CHECK_DOMAIN,
  TRANSFER_DESTINATION_CHECK_DOMAIN,
  transferAuthorizationStatementSchema,
  transferChangeSchema,
  transferPrivateEnvelopeSchema,
  validateDeckCeremony,
} from '@cp2p/protocol';
import type {
  ReplayPolicy,
  SeatTransferAuthorization,
  SeatTransferAuthorizationStatement,
  TransferPrivateEnvelope,
} from '@cp2p/protocol';
import { IndexedDbByteStore, IndexedDbProtocolJournal, TransferImportStore } from '@cp2p/storage';
import type { VaultOwnerLease } from '@cp2p/storage';
import * as v from 'valibot';
import type { DisposableOnlineIdentity } from './online-credentials.js';
import { saveOnlineGameRecord } from './online-game-records.js';
import {
  prepareOnlineTransferCredentials,
  type OnlineTransferCredentialScope,
} from './online-transfer-credentials.js';
import { loadActiveOnlineResume } from './online-resume-binding.js';
import { verifyImportedTransferCheckpoint } from './online-transfer-imported-checkpoint.js';
import {
  validateOnlineTransferBootstrap,
  type ExpectedOnlineTransferGame,
  type VerifiedOnlineTransferBootstrap,
} from './online-transfer-bootstrap.js';

const PROTOCOL = 'online-transfer-destination-v1';
const MAX_REFRESHES = 8;
const token = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));
const ref = v.strictObject({
  seq: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  hash: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
});
const seatSchema = v.picklist([0, 1, 2, 3, 4, 5] as const);
const scopeSchema = v.strictObject({
  attemptId: token,
  genesisDigest: token,
  anchor: ref,
  validUntilSeq: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(Number.MAX_SAFE_INTEGER),
  ),
  mode: v.picklist(['live', 'return']),
  seat: seatSchema,
  currentController: transferAuthorizationStatementSchema.entries.currentController,
  recovery: transferAuthorizationStatementSchema.entries.recovery,
  nextEpoch: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  devicePeer: token,
  replacements: v.pipe(
    v.array(
      v.strictObject({
        seat: seatSchema,
        oldPublicKey: token,
        newHostSeat: seatSchema,
      }),
    ),
    v.minLength(1),
    v.maxLength(6),
  ),
});
const locatorSchema = v.strictObject({
  protocol: v.literal(PROTOCOL),
  attemptId: token,
  gameId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22}$/)),
  genesisDigest: token,
  devicePeer: token,
  importedArchiveId: v.optional(v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/))),
  importedSeat: v.optional(seatSchema),
  bootstrapKey: v.string(),
  refreshes: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_REFRESHES)),
  scope: v.nullable(scopeSchema),
  stageKey: v.nullable(v.string()),
  authorization: v.nullable(ref),
  finalBootstrapKey: v.nullable(v.string()),
  outcome: v.nullable(
    v.strictObject({
      authorization: ref,
      entry: ref,
      outcome: v.picklist(['activated', 'cancelled']),
    }),
  ),
});

type Locator = v.InferOutput<typeof locatorSchema>;
type TransferMode = SeatTransferAuthorizationStatement['mode'];

export interface OnlineTransferDestinationOptions {
  readonly attemptId: string;
  readonly mode: 'new' | 'resume' | 'open';
  readonly expected: ExpectedOnlineTransferGame;
  readonly identity: DisposableOnlineIdentity;
  readonly store: IndexedDbByteStore;
  readonly vault?: VaultOwnerLease;
  readonly bootstrapBytes?: Uint8Array;
  readonly importStore?: TransferImportStore;
  readonly importedArchiveId?: string;
  /** Worker lifetime; abort prevents output after an asynchronous bootstrap step. */
  readonly signal?: AbortSignal;
}

export interface OnlineTransferDestinationSnapshot {
  readonly phase: 'prepared' | 'offered' | 'imported' | 'ready' | 'promoted' | 'cancelled';
  readonly gameId: string;
  readonly head: { readonly seq: number; readonly hash: string };
  readonly authorization: { readonly seq: number; readonly hash: string } | null;
  readonly outcome: {
    readonly authorization: { readonly seq: number; readonly hash: string };
    readonly entry: { readonly seq: number; readonly hash: string };
    readonly outcome: 'activated' | 'cancelled';
  } | null;
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function wipeStage(stage: import('@cp2p/storage').TransferImportRecord | null): void {
  stage?.bindingBytes.fill(0);
  stage?.sealedPackage.fill(0);
  stage?.privateReplayBytes.fill(0);
}

function sameCanonical(left: unknown, right: unknown): boolean {
  const first = canonicalEncode(left);
  const second = canonicalEncode(right);
  try {
    return equal(first, second);
  } finally {
    first.fill(0);
    second.fill(0);
  }
}

function sameRef(
  left: { readonly seq: number; readonly hash: string },
  right: { readonly seq: number; readonly hash: string },
): boolean {
  return left.seq === right.seq && left.hash === right.hash;
}

function policyFor(bootstrap: VerifiedOnlineTransferBootstrap): ReplayPolicy {
  return {
    genesis: {
      verifyCommitments(genesis) {
        return validateDeckCeremony(genesis, bootstrap.record.result.transcripts);
      },
    },
    entry: {},
  };
}

function verified(bytes: Uint8Array, expected: ExpectedOnlineTransferGame) {
  const result = validateOnlineTransferBootstrap(bytes, expected);
  if (!result.ok) throw new TypeError(`Invalid certified transfer bootstrap: ${result.error.code}`);
  return result.value;
}

function locatorKey(expected: ExpectedOnlineTransferGame, attemptId: string): string {
  return `online-transfer/destination/${expected.genesisDigest}/${attemptId}`;
}

function bootstrapKey(bytes: Uint8Array, attemptId: string): string {
  const digest = sha256(bytes);
  try {
    return `online-transfer/bootstrap/${attemptId}/${toHex(digest)}`;
  } finally {
    digest.fill(0);
  }
}

function credentialKey(scope: OnlineTransferCredentialScope): string {
  return `online-transfer-credentials/v1/${scope.genesisDigest}/${scope.devicePeer}/${scope.seat}/${scope.attemptId}`;
}

function parseLocator(bytes: Uint8Array, key: string): Locator {
  if (bytes.length > 16 * 1024) throw new TypeError('Transfer attempt locator is oversized');
  const parsed = v.parse(locatorSchema, canonicalDecode(bytes));
  const canonical = canonicalEncode(parsed);
  try {
    if (!equal(canonical, bytes) || !parsed.bootstrapKey.startsWith('online-transfer/bootstrap/'))
      throw new TypeError('Transfer attempt locator is not canonical');
    if (!key.endsWith(`/${parsed.attemptId}`))
      throw new TypeError('Transfer attempt locator is misplaced');
    if ((parsed.importedArchiveId === undefined) !== (parsed.importedSeat === undefined))
      throw new TypeError('Transfer attempt has an incomplete imported checkpoint');
    return parsed;
  } finally {
    canonical.fill(0);
  }
}

function deriveScope(
  bootstrap: VerifiedOnlineTransferBootstrap,
  attemptId: string,
  devicePeer: string,
  seat: Seat,
  mode: TransferMode,
): OnlineTransferCredentialScope {
  const context = bootstrap.replay.context.log;
  const authority = context.authority;
  const transfer = context.transfer;
  const controller = authority?.controllers.find((item) => item.seat === seat);
  if (
    !authority ||
    !transfer ||
    transfer.pending ||
    context.recovery?.pending ||
    context.state.result !== null ||
    !controller ||
    controller.status !== 'active'
  )
    throw new TypeError('Transfer offer requires an active certified parent');
  let controllers: typeof authority.controllers;
  let recovery: OnlineTransferCredentialScope['recovery'] = null;
  if (mode === 'live') {
    if (controller.kind !== 'human') throw new TypeError('Live transfer requires a human seat');
    controllers = [
      controller,
      ...authority.controllers.filter(
        (item) => item.kind === 'bot' && item.status === 'active' && item.hostSeat === seat,
      ),
    ];
  } else {
    const root = transfer.returnRoots.toReversed().find((item) => item.departedSeat === seat);
    if (
      controller.kind !== 'bot' ||
      !root?.activation ||
      !root.finalAuthorization ||
      !root.affectedSeats.includes(seat)
    )
      throw new TypeError('Return offer requires a certified recovery lineage');
    controllers = root.affectedSeats.flatMap((affected) => {
      const item = authority.controllers.find((candidate) => candidate.seat === affected);
      return item?.kind === 'bot' &&
        item.status === 'active' &&
        item.hostSeat === controller.hostSeat
        ? [item]
        : [];
    });
    if (controllers[0]?.seat !== seat)
      throw new TypeError('Returned seat is not the first eligible recovered seat');
    recovery = { authorization: root.finalAuthorization, activation: root.activation };
  }
  if (controllers.length === 0 || controllers.length > 6)
    throw new TypeError('Transfer replacement roster is unsupported');
  const anchor = transferEntryRef(context.head);
  return {
    attemptId,
    genesisDigest: genesisDigest(context.genesis),
    anchor,
    validUntilSeq: anchor.seq + 64,
    mode,
    seat,
    currentController: {
      publicKey: controller.publicKey,
      kind: controller.kind,
      activatedAt: controller.activatedAt,
      hostSeat: controller.hostSeat,
    },
    recovery,
    nextEpoch: authority.epoch + 1,
    devicePeer,
    replacements: controllers.map((item) => ({
      seat: item.seat,
      oldPublicKey: item.publicKey,
      newHostSeat: seat,
    })),
  };
}

/** A destination-side worker participant. Public methods never return private material. */
export class OnlineTransferDestination {
  readonly #options: OnlineTransferDestinationOptions;
  readonly #key: string;
  readonly #imports: TransferImportStore;
  #locator: Locator;
  #bootstrap: VerifiedOnlineTransferBootstrap;
  #closed = false;
  #phase: OnlineTransferDestinationSnapshot['phase'];
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(
    options: OnlineTransferDestinationOptions,
    key: string,
    locator: Locator,
    bootstrap: VerifiedOnlineTransferBootstrap,
  ) {
    this.#options = options;
    this.#key = key;
    this.#locator = locator;
    this.#bootstrap = bootstrap;
    this.#imports = options.importStore ?? new TransferImportStore(options.store);
    this.#phase = locator.stageKey ? 'imported' : locator.scope ? 'offered' : 'prepared';
  }

  #journal(gameId: string, keyBinding?: { recordKey: string; bytes: Uint8Array }) {
    return new IndexedDbProtocolJournal(gameId, {
      ...(keyBinding ? { keyBinding } : {}),
      ...(this.#options.vault ? { vault: this.#options.vault } : {}),
    });
  }

  static async create(
    options: OnlineTransferDestinationOptions,
  ): Promise<OnlineTransferDestination> {
    const ensureActive = () => {
      if (options.signal?.aborted) throw new TypeError('Transfer destination was cancelled');
    };
    ensureActive();
    if (
      options.importedArchiveId !== undefined &&
      !/^[0-9a-f]{64}$/.test(options.importedArchiveId)
    )
      throw new TypeError('Imported full-save identifier is malformed');
    const key = locatorKey(options.expected, options.attemptId);
    const identity = identityFromSecret(new Uint8Array(options.identity.secretKey));
    try {
      if (identity.peerId !== options.identity.peerId)
        throw new TypeError('Transfer device identity is inconsistent');
    } finally {
      identity.secretKey.fill(0);
      identity.publicKey.fill(0);
    }
    let locator: Locator;
    if (options.mode === 'new' || options.mode === 'open') {
      const existing = await options.store.load(key);
      ensureActive();
      if (existing) {
        existing.fill(0);
        if (options.mode === 'new')
          throw new TypeError('Transfer attempt already exists; resume it explicitly');
      } else {
        if (!options.bootstrapBytes)
          throw new TypeError('New transfer requires certified bootstrap');
        const initial = verified(options.bootstrapBytes, options.expected);
        const importedSeat =
          options.importedArchiveId === undefined
            ? undefined
            : await verifyImportedTransferCheckpoint(
                options.store,
                options.importedArchiveId,
                options.expected,
                initial,
              );
        const image = new Uint8Array(options.bootstrapBytes);
        const imageKey = bootstrapKey(image, options.attemptId);
        try {
          ensureActive();
          await options.store.withCeremonyLock(key, async () => {
            ensureActive();
            const raced = await options.store.load(key);
            if (raced) {
              raced.fill(0);
              if (options.mode === 'new')
                throw new TypeError('Transfer attempt already exists; resume it explicitly');
              return;
            }
            if (!(await options.store.putIfAbsent(imageKey, image))) {
              ensureActive();
              const prior = await options.store.load(imageKey);
              try {
                if (!prior || !equal(prior, image))
                  throw new TypeError('Transfer bootstrap hash collision');
              } finally {
                prior?.fill(0);
              }
            }
            const record: Locator = {
              protocol: PROTOCOL,
              attemptId: options.attemptId,
              gameId: options.expected.gameId,
              genesisDigest: options.expected.genesisDigest,
              devicePeer: options.identity.peerId,
              ...(options.importedArchiveId === undefined
                ? {}
                : { importedArchiveId: options.importedArchiveId, importedSeat }),
              bootstrapKey: imageKey,
              refreshes: 0,
              scope: null,
              stageKey: null,
              authorization: null,
              finalBootstrapKey: null,
              outcome: null,
            };
            const bytes = canonicalEncode(record);
            try {
              ensureActive();
              if (!(await options.store.putIfAbsent(key, bytes)))
                throw new TypeError('Transfer attempt changed during creation');
            } finally {
              bytes.fill(0);
            }
          });
        } finally {
          image.fill(0);
        }
      }
    } else if (options.bootstrapBytes) {
      throw new TypeError(
        'Resume loads its exact durable bootstrap; no supplied replacement is allowed',
      );
    }
    const saved = await options.store.load(key);
    ensureActive();
    if (!saved) throw new TypeError('Transfer attempt is absent');
    try {
      locator = parseLocator(saved, key);
    } finally {
      saved.fill(0);
    }
    if (
      locator.gameId !== options.expected.gameId ||
      locator.genesisDigest !== options.expected.genesisDigest ||
      locator.devicePeer !== options.identity.peerId ||
      locator.attemptId !== options.attemptId ||
      locator.importedArchiveId !== options.importedArchiveId
    )
      throw new TypeError('Transfer attempt belongs to another game or device');
    const bootstrapBytes = await options.store.load(locator.bootstrapKey);
    ensureActive();
    if (!bootstrapBytes) throw new TypeError('Transfer attempt bootstrap is missing');
    try {
      if (locator.bootstrapKey !== bootstrapKey(bootstrapBytes, options.attemptId))
        throw new TypeError('Transfer attempt bootstrap key differs from its bytes');
      const initial = verified(bootstrapBytes, options.expected);
      if (locator.importedArchiveId !== undefined) {
        const seat = await verifyImportedTransferCheckpoint(
          options.store,
          locator.importedArchiveId,
          options.expected,
          initial,
        );
        if (seat !== locator.importedSeat)
          throw new TypeError('Imported full-save seat differs from pinned transfer attempt');
      }
      const participant = new OnlineTransferDestination(options, key, locator, initial);
      if (locator.scope) {
        const credentials = await participant.#reservedCredentials(locator.scope);
        credentials.dispose();
      }
      await participant.#restorePhase();
      ensureActive();
      return participant;
    } finally {
      bootstrapBytes.fill(0);
    }
  }

  async #restorePhase(): Promise<void> {
    const authorization =
      this.#locator.authorization ??
      this.#locator.outcome?.authorization ??
      this.#bootstrap.replay.context.log.transfer?.pending;
    if (!authorization) return;
    const outcome = await this.#imports.readOutcome(this.#options.expected.gameId, authorization);
    if (outcome.kind !== 'missing') {
      let final = this.#bootstrap;
      if (this.#locator.finalBootstrapKey) {
        const bytes = await this.#options.store.load(this.#locator.finalBootstrapKey);
        if (!bytes) throw new TypeError('Final certified transfer bootstrap is missing');
        try {
          if (bootstrapKey(bytes, this.#options.attemptId) !== this.#locator.finalBootstrapKey)
            throw new TypeError('Final certified transfer bootstrap key is invalid');
          final = verified(bytes, this.#options.expected);
          await this.#checkImportedCheckpoint(final);
        } finally {
          bytes.fill(0);
        }
      } else if (!this.#locator.outcome) {
        throw new TypeError('Durable transfer outcome has no certified final bootstrap');
      }
      const kind = outcome.kind === 'promoted' ? 'activated' : 'cancelled';
      const entry = this.#finalEntry(final, authorization, kind, this.#locator.outcome !== null);
      if (outcome.kind === 'promoted') {
        if (!sameRef(outcome.activation, entry))
          throw new TypeError('Promoted outcome differs from certified activation');
        const active = await loadActiveOnlineResume({
          store: this.#options.store,
          record: final.record,
          engine: createBaseEngine(),
          devicePeer: this.#options.identity.peerId,
          ...(this.#options.vault
            ? {
                createJournal: (
                  gameId: string,
                  keyBinding: { recordKey: string; bytes: Uint8Array },
                ) => this.#journal(gameId, keyBinding),
              }
            : {}),
        });
        const expectedGame = this.#locator.scope?.replacements[0]?.seat;
        if (active.humanSeat !== expectedGame)
          throw new TypeError('Promoted destination seat differs from reserved transfer');
        const journal = this.#journal(this.#options.expected.gameId);
        try {
          const saved = await journal.load();
          if (!saved?.entries.some((item) => sameRef(transferEntryRef(item.entry), entry)))
            throw new TypeError('Promoted activation is absent from the bound certified journal');
        } finally {
          await journal.close();
        }
      }
      if (this.#locator.outcome) {
        if (
          this.#locator.outcome.outcome !== kind ||
          !sameRef(this.#locator.outcome.authorization, authorization) ||
          !sameRef(this.#locator.outcome.entry, entry)
        )
          throw new TypeError('Stored transfer outcome differs from certified final entry');
        this.#bootstrap = final;
        this.#phase = kind === 'activated' ? 'promoted' : 'cancelled';
      } else {
        await this.#finish(final, authorization, entry, kind);
      }
      return;
    }
    if (this.#locator.outcome)
      throw new TypeError('Certified transfer outcome lost its durable final marker');
    if (outcome.kind === 'missing' && !this.#locator.authorization) return;
    if (!this.#locator.stageKey) throw new TypeError('Transfer authorization has no staged import');
    const stage = await this.#imports.load(this.#locator.stageKey);
    if (!stage) throw new TypeError('Transfer attempt points to an absent stage');
    try {
      if (!sameRef(stage.authorization, authorization))
        throw new TypeError('Transfer attempt points to a different authorization');
      this.#phase = (await this.#imports.loadReadiness(this.#locator.stageKey))
        ? 'ready'
        : 'imported';
    } finally {
      wipeStage(stage);
    }
  }

  #run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(async () => {
      this.#ensureActive();
      return task();
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #ensureActive(): void {
    if (this.#closed || this.#options.signal?.aborted)
      throw new TypeError('Transfer destination is closed');
  }

  async #checkImportedCheckpoint(bootstrap: VerifiedOnlineTransferBootstrap): Promise<void> {
    const id = this.#locator.importedArchiveId;
    if (id === undefined) return;
    const seat = await verifyImportedTransferCheckpoint(
      this.#options.store,
      id,
      this.#options.expected,
      bootstrap,
    );
    this.#ensureActive();
    if (seat !== this.#locator.importedSeat)
      throw new TypeError('Imported full-save seat differs from pinned transfer attempt');
  }

  async #reservedCredentials(scope: OnlineTransferCredentialScope) {
    const saved = await this.#options.store.load(credentialKey(scope));
    if (!saved) throw new TypeError('Reserved transfer credentials are missing');
    saved.fill(0);
    this.#ensureActive();
    const credentials = await prepareOnlineTransferCredentials({
      store: this.#options.store,
      identity: this.#options.identity,
      scope,
    });
    try {
      this.#ensureActive();
      return credentials;
    } catch (error) {
      credentials.dispose();
      throw error;
    }
  }

  async #replace(update: (current: Locator) => Locator): Promise<void> {
    this.#ensureActive();
    await this.#options.store.withCeremonyLock(this.#key, async () => {
      this.#ensureActive();
      const prior = await this.#options.store.load(this.#key);
      if (!prior) throw new TypeError('Transfer attempt was removed');
      try {
        const current = parseLocator(prior, this.#key);
        const expected = canonicalEncode(this.#locator);
        try {
          if (!equal(prior, expected))
            throw new TypeError('Transfer attempt changed in another worker');
        } finally {
          expected.fill(0);
        }
        const next = update(current);
        const bytes = canonicalEncode(next);
        try {
          this.#ensureActive();
          if (!(await this.#options.store.compareAndSwap(this.#key, prior, bytes)))
            throw new TypeError('Transfer attempt changed during update');
          this.#locator = next;
        } finally {
          bytes.fill(0);
        }
      } finally {
        prior.fill(0);
      }
    });
  }

  async #pinFinalBootstrap(bytes: Uint8Array): Promise<string> {
    const key = bootstrapKey(bytes, this.#options.attemptId);
    if (this.#locator.finalBootstrapKey && this.#locator.finalBootstrapKey !== key)
      throw new TypeError('Transfer attempt has another certified final entry');
    if (this.#locator.finalBootstrapKey === key) return key;
    const image = new Uint8Array(bytes);
    try {
      this.#ensureActive();
      if (!(await this.#options.store.putIfAbsent(key, image))) {
        const prior = await this.#options.store.load(key);
        try {
          if (!prior || !equal(prior, image))
            throw new TypeError('Final transfer bootstrap hash collision');
        } finally {
          prior?.fill(0);
        }
      }
      await this.#replace((current) => ({ ...current, finalBootstrapKey: key }));
      return key;
    } finally {
      image.fill(0);
    }
  }

  #finalEntry(
    next: VerifiedOnlineTransferBootstrap,
    authorization: { readonly seq: number; readonly hash: string },
    outcome: 'activated' | 'cancelled',
    alreadyCurrent = false,
  ): { seq: number; hash: string } {
    if (
      !alreadyCurrent &&
      ((outcome === 'activated'
        ? next.entries.length !== this.#bootstrap.entries.length + 1
        : next.entries.length <= this.#bootstrap.entries.length) ||
        this.#bootstrap.entries.some((entry, index) => !sameCanonical(entry, next.entries[index])))
    )
      throw new TypeError('Final transfer entry does not extend the certified prefix');
    const certified = next.entries.at(-1);
    if (!certified) throw new TypeError('Final transfer entry is missing');
    const previous = next.entries.at(-2)?.entry ?? next.record.result.entry;
    const change =
      certified.entry.payload.kind === 'membership'
        ? v.safeParse(transferChangeSchema, certified.entry.payload.change)
        : null;
    if (
      !change?.success ||
      (outcome === 'activated'
        ? change.output.kind !== 'transfer-activate' ||
          !sameRef(change.output.statement.authorization, authorization)
        : change.output.kind !== 'transfer-cancel' ||
          !sameRef(change.output.authorization, authorization) ||
          !sameRef(change.output.parent, transferEntryRef(previous)))
    )
      throw new TypeError('Final certified entry differs from this transfer authorization');
    return transferEntryRef(certified.entry);
  }

  async #finish(
    next: VerifiedOnlineTransferBootstrap,
    authorization: { readonly seq: number; readonly hash: string },
    entry: { readonly seq: number; readonly hash: string },
    outcome: 'activated' | 'cancelled',
  ): Promise<void> {
    const key = this.#locator.finalBootstrapKey;
    if (!key) throw new TypeError('Final certified bootstrap was not durably pinned');
    const result = { authorization: { ...authorization }, entry: { ...entry }, outcome };
    await this.#replace((current) => ({
      ...current,
      bootstrapKey: key,
      finalBootstrapKey: null,
      authorization,
      outcome: result,
    }));
    this.#bootstrap = next;
    this.#phase = outcome === 'activated' ? 'promoted' : 'cancelled';
  }

  snapshot(): OnlineTransferDestinationSnapshot {
    const head = transferEntryRef(this.#bootstrap.replay.context.log.head);
    const authorization = this.#locator.authorization;
    return {
      phase: this.#phase,
      gameId: this.#options.expected.gameId,
      head,
      authorization,
      outcome: this.#locator.outcome
        ? {
            authorization: { ...this.#locator.outcome.authorization },
            entry: { ...this.#locator.outcome.entry },
            outcome: this.#locator.outcome.outcome,
          }
        : null,
    };
  }

  prepareOffer(input: {
    readonly seat: Seat;
    readonly mode: TransferMode;
  }): Promise<SeatTransferAuthorization> {
    return this.#run(async () => {
      await this.#checkImportedCheckpoint(this.#bootstrap);
      if (this.#locator.importedSeat !== undefined && input.seat !== this.#locator.importedSeat)
        throw new TypeError('Transfer offer differs from imported full-save seat');
      if (this.#phase === 'promoted' || this.#phase === 'cancelled')
        throw new TypeError('Finalized transfer cannot prepare another offer');
      const scope: OnlineTransferCredentialScope =
        this.#locator.scope === null
          ? deriveScope(
              this.#bootstrap,
              this.#options.attemptId,
              this.#options.identity.peerId,
              input.seat,
              input.mode,
            )
          : this.#locator.scope;
      if (scope.seat !== input.seat || scope.mode !== input.mode)
        throw new TypeError('Transfer attempt is reserved for another seat or mode');
      const context = this.#bootstrap.replay.context.log;
      const pending = context.transfer?.pending;
      if (pending) {
        const outcome = await this.#imports.readOutcome(this.#options.expected.gameId, pending);
        if (outcome.kind !== 'missing')
          throw new TypeError('Transfer authorization was already finalized locally');
      }
      if (pending) {
        const approved = context.transfer?.authorizations.find((item) =>
          sameRef(item.entry, pending),
        );
        if (!approved) throw new TypeError('Certified transfer authorization is missing');
      } else if (
        !context.transfer?.recentHeads.some((item) => sameRef(item, scope.anchor)) ||
        context.head.seq > scope.validUntilSeq
      ) {
        throw new TypeError('Reserved transfer parent is no longer eligible');
      }
      this.#ensureActive();
      if (this.#locator.scope !== null) {
        const prior = await this.#options.store.load(credentialKey(scope));
        if (!prior) throw new TypeError('Reserved transfer credentials are missing');
        prior.fill(0);
      }
      const credentials = await prepareOnlineTransferCredentials({
        store: this.#options.store,
        identity: this.#options.identity,
        scope,
      });
      try {
        this.#ensureActive();
        if (pending) {
          const approved = context.transfer?.authorizations.find((item) =>
            sameRef(item.entry, pending),
          );
          if (!approved || !sameCanonical(approved.statement, credentials.authorization.statement))
            throw new TypeError('Certified authorization differs from reserved credentials');
        }
        if (this.#locator.scope === null) {
          await this.#replace((current) => ({ ...current, scope: v.parse(scopeSchema, scope) }));
          this.#phase = 'offered';
        }
        return credentials.authorization;
      } finally {
        credentials.dispose();
      }
    });
  }

  refreshBootstrap(bytes: Uint8Array): Promise<void> {
    return this.#run(async () => {
      if (this.#phase === 'promoted' || this.#phase === 'cancelled')
        throw new TypeError('Finalized transfer cannot refresh its parent');
      const next = verified(bytes, this.#options.expected);
      await this.#checkImportedCheckpoint(next);
      this.#ensureActive();
      const oldEntries = this.#bootstrap.entries;
      if (
        next.entries.length < oldEntries.length ||
        oldEntries.some((entry, index) => {
          const newer = next.entries[index];
          return !newer || !sameCanonical(entry, newer);
        })
      )
        throw new TypeError('Transfer bootstrap does not extend the certified prefix');
      if (this.#locator.scope) {
        const scope = this.#locator.scope;
        const transfer = next.replay.context.log.transfer;
        const authorization = this.#bootstrap.replay.context.log.transfer?.pending;
        const pending = transfer?.pending;
        if (pending) {
          if (authorization && !sameRef(pending, authorization))
            throw new TypeError('Certified prefix changed the pending transfer authorization');
          const approved = transfer.authorizations.find((item) => sameRef(item.entry, pending));
          if (!approved) throw new TypeError('Certified transfer authorization is missing');
          const credentials = await this.#reservedCredentials(scope);
          try {
            if (!sameCanonical(approved.statement, credentials.authorization.statement))
              throw new TypeError('Certified authorization differs from reserved credentials');
          } finally {
            credentials.dispose();
          }
        } else if (
          !transfer?.recentHeads.some((item) => sameRef(item, scope.anchor)) ||
          next.replay.context.log.head.seq > scope.validUntilSeq
        ) {
          throw new TypeError('Certified prefix invalidated reserved transfer scope');
        }
      }
      if (next.entries.length === oldEntries.length) return;
      if (this.#locator.refreshes >= MAX_REFRESHES)
        throw new TypeError('Transfer bootstrap refresh budget exhausted');
      const image = new Uint8Array(bytes);
      const key = bootstrapKey(image, this.#options.attemptId);
      let nextStageKey: string | null = null;
      try {
        if (this.#locator.stageKey) {
          const oldStage = await this.#imports.load(this.#locator.stageKey);
          if (!oldStage) throw new TypeError('Staged transfer import is missing');
          try {
            const oldHead = transferEntryRef(this.#bootstrap.replay.context.log.head);
            if (
              !sameRef(oldStage.head, oldHead) ||
              !this.#locator.authorization ||
              !sameRef(oldStage.authorization, this.#locator.authorization)
            )
              throw new TypeError('Staged transfer does not match its certified parent');
            const packet = v.parse(
              transferPrivateEnvelopeSchema,
              canonicalDecode(oldStage.sealedPackage),
            );
            const scope = this.#locator.scope;
            if (!scope) throw new TypeError('Staged transfer scope is missing');
            const credentials = await this.#reservedCredentials(scope);
            try {
              nextStageKey = await this.#stagePacket(next, packet, credentials, scope);
            } finally {
              credentials.dispose();
            }
          } finally {
            wipeStage(oldStage);
          }
        }
        await this.#options.store.withCeremonyLock(this.#key, async () => {
          this.#ensureActive();
          if (!(await this.#options.store.putIfAbsent(key, image))) {
            const prior = await this.#options.store.load(key);
            try {
              if (!prior || !equal(prior, image)) throw new TypeError('Bootstrap hash collision');
            } finally {
              prior?.fill(0);
            }
          }
        });
        await this.#replace((current) => ({
          ...current,
          bootstrapKey: key,
          refreshes: current.refreshes + 1,
          stageKey: nextStageKey,
        }));
        this.#ensureActive();
        this.#bootstrap = next;
        if (nextStageKey) this.#phase = 'imported';
      } finally {
        image.fill(0);
      }
    });
  }

  importPacket(packet: TransferPrivateEnvelope): Promise<void> {
    return this.#run(async () => {
      if (this.#phase === 'promoted' || this.#phase === 'cancelled')
        throw new TypeError('Finalized transfer cannot import another packet');
      if (this.#locator.stageKey) {
        const stage = await this.#imports.load(this.#locator.stageKey);
        if (!stage) throw new TypeError('Staged transfer import is missing');
        const encoded = canonicalEncode(v.parse(transferPrivateEnvelopeSchema, packet));
        try {
          if (
            !this.#locator.authorization ||
            !sameRef(stage.authorization, this.#locator.authorization) ||
            !sameRef(stage.head, transferEntryRef(this.#bootstrap.replay.context.log.head)) ||
            !equal(stage.sealedPackage, encoded)
          )
            throw new TypeError('Private import differs from the durable staged packet');
          return;
        } finally {
          encoded.fill(0);
          wipeStage(stage);
        }
      }
      const scope = this.#locator.scope;
      if (!scope) throw new TypeError('Transfer offer has not reserved a scope');
      const credentials = await this.#reservedCredentials(scope);
      try {
        const key = await this.#stagePacket(this.#bootstrap, packet, credentials, scope);
        const authorization = this.#bootstrap.replay.context.log.transfer?.pending;
        if (!authorization) throw new TypeError('Private import authorization disappeared');
        await this.#replace((current) => ({ ...current, stageKey: key, authorization }));
        this.#phase = 'imported';
      } finally {
        credentials.dispose();
      }
    });
  }

  async #stagePacket(
    bootstrap: VerifiedOnlineTransferBootstrap,
    packet: TransferPrivateEnvelope,
    credentials: Awaited<ReturnType<typeof prepareOnlineTransferCredentials>>,
    scope: OnlineTransferCredentialScope,
  ): Promise<string> {
    const context = bootstrap.replay.context.log;
    const authorization = context.transfer?.pending;
    const approved = context.transfer?.authorizations.find((item) =>
      authorization ? sameRef(item.entry, authorization) : false,
    );
    if (!authorization || !approved)
      throw new TypeError('Private import requires a certified pending authorization');
    if (!sameCanonical(approved.statement, credentials.authorization.statement))
      throw new TypeError('Certified authorization differs from reserved credentials');
    const imported = await importTransferPrivate({
      genesisEntry: bootstrap.record.result.entry,
      entries: bootstrap.entries,
      engine: createBaseEngine(),
      policy: policyFor(bootstrap),
      authorization,
      packet,
      destinationEncryptionSecret: credentials.encryptionSecret,
      importStore: this.#options.store,
    });
    if (!imported.ok) throw new TypeError(`Authenticated import failed: ${imported.error.code}`);
    let binding: Uint8Array | undefined;
    let sealed: Uint8Array | undefined;
    let replayBytes: Uint8Array | undefined;
    try {
      this.#ensureActive();
      const seats = credentials.keys.map(({ seat, peerId, signingKey }) => {
        const master = imported.value.masters.find((item) => item.seat === seat)?.master;
        if (!master) throw new TypeError('Imported master is missing for a replacement seat');
        return {
          seat,
          kind: seat === scope.seat ? ('human' as const) : ('bot' as const),
          peerId,
          signingKey,
          master,
        };
      });
      binding = canonicalEncode({
        protocol: 'online-game-keys-v1',
        genesisDigest: scope.genesisDigest,
        devicePeer: scope.devicePeer,
        humanSeat: scope.seat,
        seats,
      });
      sealed = canonicalEncode(packet);
      replayBytes = canonicalEncode({
        protocol: 'online-transfer-private-replay-v1',
        authorization,
        parent: transferEntryRef(context.head),
        seats: seats.map(({ seat }) => ({ seat, state: imported.value.driver.privateState(seat) })),
      });
      this.#ensureActive();
      const key = await this.#imports.stage(
        {
          gameId: this.#options.expected.gameId,
          authorization,
          destinationGameKey: credentials.authorization.statement.destination.gamePeer,
          bindingBytes: binding,
          sealedPackage: sealed,
          privateReplayBytes: replayBytes,
          genesis: bootstrap.record.result.entry,
          entries: bootstrap.entries,
        },
        createBaseEngine(),
        policyFor(bootstrap),
      );
      this.#ensureActive();
      return key;
    } finally {
      binding?.fill(0);
      sealed?.fill(0);
      replayBytes?.fill(0);
      imported.value.dispose();
    }
  }

  prepareReadiness(): Promise<{
    readonly kind: 'transfer-activate';
    readonly statement: import('@cp2p/storage').TransferReadinessRecord['statement'];
    readonly destinationCheck: string;
    readonly replacementChecks: readonly { readonly seat: Seat; readonly sig: string }[];
  }> {
    return this.#run(async () => {
      await this.#checkImportedCheckpoint(this.#bootstrap);
      if (this.#phase === 'promoted' || this.#phase === 'cancelled')
        throw new TypeError('Finalized transfer cannot sign readiness');
      const scope = this.#locator.scope;
      const stageKey = this.#locator.stageKey;
      const authorization = this.#locator.authorization;
      if (!scope || !stageKey || !authorization)
        throw new TypeError('Transfer import has not been durably staged');
      const stage = await this.#imports.load(stageKey);
      if (!stage) throw new TypeError('Staged transfer import is missing');
      try {
        const context = this.#bootstrap.replay.context.log;
        if (
          !sameRef(stage.head, transferEntryRef(context.head)) ||
          !sameRef(stage.authorization, authorization)
        )
          throw new TypeError('Readiness parent differs from the staged certified head');
        const approved = context.transfer?.authorizations.find((item) =>
          sameRef(item.entry, authorization),
        );
        if (
          !approved ||
          !sameRef(context.transfer?.pending ?? { seq: -1, hash: '' }, authorization)
        )
          throw new TypeError('Readiness authorization is no longer pending');
        const credentials = await this.#reservedCredentials(scope);
        try {
          const statement = {
            protocol: 'seat-transfer-activation-v1' as const,
            genesisDigest: scope.genesisDigest,
            authorization,
            parent: stage.head,
            nextEpoch: approved.statement.nextEpoch,
            destinationDevice: approved.statement.destination.devicePeer,
            destinationGame: approved.statement.destination.gamePeer,
            replacements: approved.statement.replacements.map((replacement) => ({
              ...replacement,
            })),
            checkDigest: transferCheckDigest(context, authorization),
          };
          const first = credentials.keys[0];
          if (!first) throw new TypeError('Destination game key is missing');
          const readiness = {
            protocol: 'seat-transfer-readiness-v1' as const,
            statement,
            destinationCheck: signObject(
              TRANSFER_DESTINATION_CHECK_DOMAIN,
              statement,
              first.signingKey,
            ),
            replacementChecks: credentials.keys.slice(1).map(({ seat, signingKey }) => ({
              seat,
              sig: signObject(TRANSFER_BOT_CHECK_DOMAIN, statement, signingKey),
            })),
          };
          await this.#imports.saveReadiness(stageKey, readiness);
          this.#ensureActive();
          this.#phase = 'ready';
          return {
            kind: 'transfer-activate',
            statement,
            destinationCheck: readiness.destinationCheck,
            replacementChecks: readiness.replacementChecks,
          };
        } finally {
          credentials.dispose();
        }
      } finally {
        wipeStage(stage);
      }
    });
  }

  observeActivation(bytes: Uint8Array): Promise<string> {
    return this.#run(async () => {
      if (this.#phase === 'promoted' && this.#locator.outcome?.outcome === 'activated') {
        const repeated = verified(bytes, this.#options.expected);
        await this.#checkImportedCheckpoint(repeated);
        if (
          repeated.entries.length !== this.#bootstrap.entries.length ||
          repeated.entries.some(
            (item, index) => !sameCanonical(item, this.#bootstrap.entries[index]),
          )
        )
          throw new TypeError('Repeated activation differs from certified final bootstrap');
        return this.#options.expected.gameId;
      }
      const stageKey = this.#locator.stageKey;
      const authorization = this.#locator.authorization;
      if (!stageKey || !authorization) throw new TypeError('Transfer import is not staged');
      const next = verified(bytes, this.#options.expected);
      await this.#checkImportedCheckpoint(next);
      const outcome = await this.#imports.readOutcome(this.#options.expected.gameId, authorization);
      if (outcome.kind === 'cancelled') {
        this.#phase = 'cancelled';
        throw new TypeError('Transfer authorization was cancelled');
      }
      const stage = await this.#imports.load(stageKey);
      try {
        const stagedEntries = stage?.entries ?? this.#bootstrap.entries;
        if (
          next.entries.length !== stagedEntries.length + 1 ||
          stagedEntries.some(
            (entry, index) =>
              !next.entries[index] ||
              !equal(canonicalEncode(entry), canonicalEncode(next.entries[index])),
          )
        )
          throw new TypeError('Activation must be the exact certified child of staged import');
        const activation = next.entries.at(-1);
        if (!activation) throw new TypeError('Certified activation entry is missing');
        const change =
          activation.entry.payload.kind === 'membership'
            ? v.safeParse(transferChangeSchema, activation.entry.payload.change)
            : null;
        if (
          !change?.success ||
          change.output.kind !== 'transfer-activate' ||
          !sameRef(change.output.statement.authorization, authorization)
        )
          throw new TypeError('Certified child is not this transfer activation');
        const activationRef = this.#finalEntry(next, authorization, 'activated');
        await this.#pinFinalBootstrap(bytes);
        if (outcome.kind === 'promoted') {
          if (!sameRef(outcome.activation, activationRef))
            throw new TypeError('Transfer was promoted with another activation');
          const active = await loadActiveOnlineResume({
            store: this.#options.store,
            record: next.record,
            engine: createBaseEngine(),
            devicePeer: this.#options.identity.peerId,
            ...(this.#options.vault
              ? {
                  createJournal: (
                    gameId: string,
                    keyBinding: { recordKey: string; bytes: Uint8Array },
                  ) => this.#journal(gameId, keyBinding),
                }
              : {}),
          });
          if (active.gamePeer !== change.output.statement.destinationGame)
            throw new TypeError('Promoted journal binding differs from certified destination');
          const journal = this.#journal(this.#options.expected.gameId);
          try {
            const saved = await journal.load();
            if (
              !saved?.entries.some((entry) =>
                sameRef(transferEntryRef(entry.entry), outcome.activation),
              )
            )
              throw new TypeError('Promoted activation is absent from the bound certified journal');
          } finally {
            await journal.close();
          }
          await this.#finish(next, authorization, activationRef, 'activated');
          return this.#options.expected.gameId;
        }
        if (!stage) throw new TypeError('Staged transfer import is missing');
        // The public start is independently validated and indexed before any voter journal appears.
        await saveOnlineGameRecord(this.#options.store, {
          invite: next.record.invite,
          agreement: next.record.agreement,
          result: next.record.result,
        });
        this.#ensureActive();
        const bindingKey = `online-game/${this.#options.expected.genesisDigest}/keys`;
        const oldBinding = await this.#options.store.load(bindingKey);
        let expectedActive: {
          head: { seq: number; hash: string };
          bindingBytes: Uint8Array;
        } | null = null;
        try {
          if (oldBinding) {
            if (oldBinding.length > 16 * 1024)
              throw new TypeError('Existing game binding is oversized');
            const oldJournal = this.#journal(this.#options.expected.gameId, {
              recordKey: bindingKey,
              bytes: oldBinding,
            });
            try {
              const saved = await oldJournal.load();
              if (
                !saved ||
                !sameCanonical(saved.genesis, stage.genesis) ||
                saved.entries.length > next.entries.length ||
                saved.entries.some((entry, index) => !sameCanonical(entry, next.entries[index]))
              )
                throw new TypeError('Existing journal is not a certified prefix of activation');
              const replayed = replayCertifiedPrefix(
                saved.genesis,
                saved.entries,
                createBaseEngine(),
                policyFor(next),
              );
              if (!replayed.ok)
                throw new TypeError(`Existing journal did not replay: ${replayed.error.code}`);
              const approved = next.replay.context.log.transfer?.authorizations.find((item) =>
                sameRef(item.entry, authorization),
              );
              const oldKey =
                approved?.statement.mode === 'live'
                  ? approved.statement.currentController.publicKey
                  : next.replay.context.log.transfer?.returnRoots
                      .toReversed()
                      .find((item) => item.departedSeat === approved?.statement.seat)
                      ?.lastHumanGameKey;
              if (!oldKey || !approved)
                throw new TypeError('Certified retired controller identity is unavailable');
              let marker: unknown;
              try {
                marker = canonicalDecode(saved.safety.bytes);
              } catch {
                throw new TypeError('Existing journal is not retired');
              } finally {
                saved.safety.bytes.fill(0);
              }
              const retired = restoreRetiredSafety(
                marker,
                replayed.value.context,
                approved.statement.seat,
                oldKey,
              );
              if (!retired.ok)
                throw new TypeError(`Existing journal is not retired: ${retired.error.code}`);
              const prior = saved.entries.at(-1)?.entry ?? saved.genesis;
              expectedActive = { head: transferEntryRef(prior), bindingBytes: oldBinding };
            } finally {
              await oldJournal.close();
            }
          }
          const journal = this.#journal(this.#options.expected.gameId, {
            recordKey: bindingKey,
            bytes: stage.bindingBytes,
          });
          try {
            if (
              !(await journal.promoteTransfer({
                stageKey,
                activation,
                engine: createBaseEngine(),
                policy: policyFor(next),
                expectedActive,
              }))
            )
              throw new TypeError('Transfer promotion lost its durable race');
          } finally {
            await journal.close();
          }
        } finally {
          oldBinding?.fill(0);
        }
        this.#ensureActive();
        await this.#finish(next, authorization, activationRef, 'activated');
        return this.#options.expected.gameId;
      } finally {
        wipeStage(stage);
      }
    });
  }

  /** Certified cancellation closes every staged parent and leaves voting state untouched. */
  observeCancellation(bytes: Uint8Array): Promise<void> {
    return this.#run(async () => {
      if (this.#phase === 'cancelled' && this.#locator.outcome?.outcome === 'cancelled') {
        const repeated = verified(bytes, this.#options.expected);
        await this.#checkImportedCheckpoint(repeated);
        if (
          repeated.entries.length !== this.#bootstrap.entries.length ||
          repeated.entries.some(
            (item, index) => !sameCanonical(item, this.#bootstrap.entries[index]),
          )
        )
          throw new TypeError('Repeated cancellation differs from certified final bootstrap');
        return;
      }
      if (this.#phase === 'promoted')
        throw new TypeError('Promoted transfer cannot be cancelled locally');
      const scope = this.#locator.scope;
      if (!scope) throw new TypeError('Transfer offer has no reserved credentials');
      const prior = await this.#options.store.load(credentialKey(scope));
      if (!prior) throw new TypeError('Transfer credentials are absent');
      prior.fill(0);
      const next = verified(bytes, this.#options.expected);
      await this.#checkImportedCheckpoint(next);
      if (
        next.entries.length <= this.#bootstrap.entries.length ||
        this.#bootstrap.entries.some((entry, index) => !sameCanonical(entry, next.entries[index]))
      )
        throw new TypeError('Cancellation must extend the retained certified prefix');
      const cancelled = next.entries.at(-1);
      if (!cancelled) throw new TypeError('Certified cancellation entry is missing');
      const change =
        cancelled.entry.payload.kind === 'membership'
          ? v.safeParse(transferChangeSchema, cancelled.entry.payload.change)
          : null;
      if (
        !change?.success ||
        change.output.kind !== 'transfer-cancel' ||
        (this.#locator.authorization &&
          !sameRef(change.output.authorization, this.#locator.authorization)) ||
        (this.#bootstrap.replay.context.log.transfer?.pending &&
          !sameRef(
            change.output.authorization,
            this.#bootstrap.replay.context.log.transfer.pending,
          ))
      )
        throw new TypeError('Certified final entry does not cancel this transfer authorization');
      const authorization = change.output.authorization;
      const approved = next.replay.context.log.transfer?.authorizations.find((item) =>
        sameRef(item.entry, authorization),
      );
      if (!approved) throw new TypeError('Certified transfer authorization is missing');
      const credentials = await this.#reservedCredentials(scope);
      try {
        if (!sameCanonical(approved.statement, credentials.authorization.statement))
          throw new TypeError('Cancellation authorization differs from reserved credentials');
      } finally {
        credentials.dispose();
      }
      const cancellationRef = this.#finalEntry(next, authorization, 'cancelled');
      await this.#pinFinalBootstrap(bytes);
      await this.#imports.cancelCertified({
        gameId: this.#options.expected.gameId,
        authorization,
        genesis: next.record.result.entry,
        entries: next.entries,
        engine: createBaseEngine(),
        policy: policyFor(next),
      });
      this.#ensureActive();
      await this.#finish(next, authorization, cancellationRef, 'cancelled');
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#queue;
  }
}
