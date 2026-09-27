import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { decodePoint, parsePeerId, verifyObject } from '@cp2p/crypto';
import type { Result } from '@cp2p/engine';
import {
  TRANSFER_BOT_KEY_DOMAIN,
  TRANSFER_DEVICE_DOMAIN,
  TRANSFER_GAME_KEY_DOMAIN,
  transferChangeSchema,
  transferPrivateEnvelopeSchema,
} from '@cp2p/protocol';
import type { SeatTransferAuthorization, TransferPrivateEnvelope } from '@cp2p/protocol';
import * as v from 'valibot';
import type { OnlineTransferArtifact } from './online-transfer-channel.js';
import type { ExpectedOnlineTransferGame } from './online-transfer-bootstrap.js';
import type { OnlineTransferExchangeRecord } from './online-transfer-records.js';
import type { OnlineTransferDestinationSnapshot } from './online-transfer-destination.js';
import type {
  OnlineWorkerHead,
  OnlineWorkerReplyByKind,
  OnlineWorkerRequestBody,
} from './online-worker-messages.js';

// The channel can acknowledge two full certified prefixes before their handlers finish.
const MAX_QUEUED_ARTIFACTS = 3;
const MAX_QUEUED_BYTES = 2 * 16 * 1024 * 1024 + 64 * 1024;

export interface TransferExchangeWorker {
  request<K extends OnlineWorkerRequestBody['kind']>(
    body: Extract<OnlineWorkerRequestBody, { kind: K }>,
  ): Promise<Result<OnlineWorkerReplyByKind[K]>>;
}

export interface TransferExchangeChannel {
  send(artifact: OnlineTransferArtifact): Promise<void>;
}

/** Public retry cursor. The destination's keys and import remain in its separate worker store. */
export type { OnlineTransferExchangeRecord } from './online-transfer-records.js';

interface CommonOptions {
  readonly worker: TransferExchangeWorker;
  readonly channel: TransferExchangeChannel;
  readonly record: OnlineTransferExchangeRecord;
  /** Must durably replace the public cursor before the dependent packet is sent. */
  readonly savePublicRecord: (record: OnlineTransferExchangeRecord) => Promise<void>;
  readonly onChange?: (phase: TransferExchangePhase) => void;
}

export type TransferExchangePhase =
  | 'connecting'
  | 'awaiting-confirmation'
  | 'awaiting-authorization'
  | 'awaiting-private'
  | 'awaiting-readiness'
  | 'awaiting-certification'
  | 'awaiting-receipt'
  | 'cancelled-awaiting-receipt'
  | 'activated'
  | 'cancelled';

const refSchema = v.strictObject({
  seq: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  hash: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
});
const receiptSchema = v.strictObject({
  protocol: v.literal('online-transfer-received-v1'),
  destinationDevice: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/)),
  authorization: refSchema,
  outcome: v.picklist(['activated', 'cancelled']),
  entry: refSchema,
});

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function equal(left: unknown, right: unknown): boolean {
  const first = canonicalEncode(left);
  const second = canonicalEncode(right);
  try {
    return first.length === second.length && first.every((byte, index) => byte === second[index]);
  } finally {
    first.fill(0);
    second.fill(0);
  }
}

function sameRef(left: OnlineWorkerHead, right: OnlineWorkerHead): boolean {
  return left.seq === right.seq && left.hash === right.hash;
}

function detached<T>(publicValue: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Public canonical evidence is detached before retention or callback delivery.
  return canonicalDecode(canonicalEncode(publicValue)) as T;
}

function parsedChange(bytes: Uint8Array) {
  if (bytes.length > 64 * 1024) throw new RangeError('Transfer evidence is oversized');
  return v.parse(transferChangeSchema, canonicalDecode(bytes));
}

/** Authenticate public possession before pinning an immutable browser decision. */
function verifyOfferKeys(offer: SeatTransferAuthorization): void {
  const { statement } = offer;
  const { destination, replacements } = statement;
  decodePoint(destination.transferEncryptionKey, { nonIdentity: true });
  const signed = (domain: string, sig: string, key: string) =>
    verifyObject(domain, statement, sig, parsePeerId(key));
  if (
    replacements[0]?.seat !== statement.seat ||
    replacements[0].newPublicKey !== destination.gamePeer ||
    !signed(TRANSFER_DEVICE_DOMAIN, offer.destinationDeviceSig, destination.devicePeer) ||
    !signed(TRANSFER_GAME_KEY_DOMAIN, offer.destinationGameSig, destination.gamePeer) ||
    offer.replacementKeySigs.length !== replacements.length - 1 ||
    !replacements.slice(1).every((replacement, index) => {
      const signature = offer.replacementKeySigs[index];
      return (
        signature?.seat === replacement.seat &&
        signed(TRANSFER_BOT_KEY_DOMAIN, signature.sig, replacement.newPublicKey)
      );
    })
  )
    throw new TypeError('Transfer offer has invalid destination possession signatures');
}

abstract class Exchange {
  protected record: OnlineTransferExchangeRecord;
  protected phase: TransferExchangePhase = 'connecting';
  protected closed = false;
  protected readonly options: CommonOptions;
  private queue: Promise<unknown> = Promise.resolve();
  private queuedArtifacts = 0;
  private queuedBytes = 0;

  protected constructor(options: CommonOptions, role: OnlineTransferExchangeRecord['role']) {
    if (options.record.role !== role || options.record.protocol !== 'online-transfer-exchange-v1')
      throw new TypeError('Transfer exchange record has the wrong role or version');
    this.options = options;
    this.record = detached(options.record);
  }

  snapshot(): {
    readonly phase: TransferExchangePhase;
    readonly record: OnlineTransferExchangeRecord;
  } {
    return { phase: this.phase, record: detached(this.record) };
  }

  protected setPhase(phase: TransferExchangePhase): void {
    if (this.closed) return;
    this.phase = phase;
    try {
      this.options.onChange?.(phase);
    } catch {
      // A view cannot interrupt certified transfer work.
    }
  }

  protected async save(next: OnlineTransferExchangeRecord): Promise<void> {
    this.ensureOpen();
    const copy = detached(next);
    await this.options.savePublicRecord(detached(copy));
    this.ensureOpen();
    this.record = copy;
  }

  protected ensureOpen(): void {
    if (this.closed) throw new Error('Transfer exchange is closed');
  }

  protected run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      this.ensureOpen();
      return task();
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  receive(artifact: OnlineTransferArtifact): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Transfer exchange is closed'));
    const bytes = artifact.bytes;
    if (!(bytes instanceof Uint8Array))
      return Promise.reject(new TypeError('Transfer artifact bytes are malformed'));
    if (
      this.queuedArtifacts >= MAX_QUEUED_ARTIFACTS ||
      this.queuedBytes + bytes.length > MAX_QUEUED_BYTES
    )
      return Promise.reject(new RangeError('Transfer artifact queue is full'));
    const copy = new Uint8Array(bytes);
    this.queuedArtifacts += 1;
    this.queuedBytes += copy.length;
    return this.run(() => this.handle({ kind: artifact.kind, bytes: copy })).finally(() => {
      this.queuedArtifacts -= 1;
      this.queuedBytes -= copy.length;
      copy.fill(0);
    });
  }

  protected abstract handle(artifact: OnlineTransferArtifact): Promise<void>;

  close(): void {
    this.closed = true;
  }
}

export interface SourceTransferExchangeOptions extends CommonOptions {
  readonly record: OnlineTransferExchangeRecord & { readonly role: 'source' };
}

/** The source cannot sign, submit, or disclose until the human calls confirm(). */
export class SourceTransferExchange extends Exchange {
  constructor(options: SourceTransferExchangeOptions) {
    super(options, 'source');
    if (this.record.approved && !this.record.offer)
      throw new TypeError('Approved source record has no destination offer');
  }

  start(): Promise<void> {
    return this.run(async () => {
      await this.sendBootstrap('bootstrap');
      if (this.record.approved) await this.retryNow();
    });
  }

  protected async handle(artifact: OnlineTransferArtifact): Promise<void> {
    if (artifact.kind === 'received') {
      const receipt = v.parse(receiptSchema, canonicalDecode(artifact.bytes));
      if (
        receipt.destinationDevice !== this.record.destinationDevice ||
        !this.record.authorization ||
        !sameRef(receipt.authorization, this.record.authorization)
      )
        throw new TypeError('Transfer receipt belongs to another destination or authorization');
      const status = value(
        await this.options.worker.request({
          kind: 'transferStatus',
          authorization: receipt.authorization,
        }),
      );
      if (
        !status.outcome ||
        status.outcome.outcome !== receipt.outcome ||
        !sameRef(status.outcome.entry, receipt.entry)
      )
        throw new TypeError('Transfer receipt has no matching certified outcome');
      this.setPhase(receipt.outcome);
      return;
    }
    if (
      this.phase === 'activated' ||
      this.phase === 'cancelled' ||
      this.phase === 'cancelled-awaiting-receipt'
    )
      return;
    if (artifact.kind === 'offer') {
      const offer = parsedChange(artifact.bytes);
      if (
        offer.kind !== 'transfer-authorize' ||
        offer.statement.mode !== 'live' ||
        offer.ownerIntent !== undefined ||
        offer.returnIntent !== undefined ||
        offer.humanApprovals !== undefined ||
        offer.statement.seat !== this.record.seat ||
        offer.statement.genesisDigest !== this.record.genesisDigest ||
        offer.statement.destination.devicePeer !== this.record.destinationDevice
      )
        throw new TypeError('Transfer offer differs from the selected source and destination');
      if (this.record.offer && !equal(this.record.offer, offer))
        throw new TypeError('Transfer destination changed its signed offer');
      if (!this.record.offer) {
        verifyOfferKeys(offer);
        await this.save({ ...this.record, offer });
      }
      if (!this.record.approved) this.setPhase('awaiting-confirmation');
      else await this.retryNow();
      return;
    }
    if (artifact.kind !== 'readiness') throw new TypeError('Unexpected source transfer artifact');
    if (this.record.cancelRequested) {
      await this.cancelNow();
      return;
    }
    const readiness = parsedChange(artifact.bytes);
    const authorization = this.record.authorization;
    const approved = this.record.approved;
    if (
      readiness.kind !== 'transfer-activate' ||
      !authorization ||
      !approved ||
      !sameRef(readiness.statement.authorization, authorization) ||
      readiness.statement.destinationDevice !== this.record.destinationDevice ||
      readiness.statement.destinationGame !== approved.statement.destination.gamePeer
    )
      throw new TypeError('Readiness differs from this certified transfer');
    const status = value(
      await this.options.worker.request({ kind: 'transferStatus', authorization }),
    );
    if (status.outcome) {
      await this.deliverOutcome(status.outcome);
      return;
    }
    if (!status.pending || !sameRef(status.pending.entry, authorization))
      throw new TypeError('Transfer authorization is no longer pending');
    if (!sameRef(readiness.statement.parent, status.head)) {
      await this.sendBootstrap('authorized');
      this.setPhase('awaiting-readiness');
      return;
    }
    this.setPhase('awaiting-certification');
    value(
      await this.options.worker.request({
        kind: 'submitTransfer',
        change: readiness,
        head: status.head,
      }),
    );
    await this.retryNow();
  }

  confirm(): Promise<void> {
    return this.run(async () => {
      if (this.record.cancelRequested) throw new TypeError('Transfer cancellation was requested');
      const offer = this.record.offer;
      if (!offer) throw new TypeError('No signed destination offer awaits confirmation');
      if (!this.record.approved) {
        const status = value(await this.options.worker.request({ kind: 'transferStatus' }));
        if (status.pending) throw new TypeError('Another transfer is pending');
        const approved = value(
          await this.options.worker.request({
            kind: 'authorizeLiveTransfer',
            offer,
            head: status.head,
          }),
        );
        if (!equal(approved.statement, offer.statement))
          throw new TypeError('Source authorization changed the signed destination offer');
        await this.save({ ...this.record, approved });
      }
      await this.retryNow();
    });
  }

  retry(): Promise<void> {
    return this.run(() => this.retryNow());
  }

  private async retryNow(): Promise<void> {
    if (this.phase === 'activated' || this.phase === 'cancelled') return;
    if (this.record.cancelRequested) {
      await this.cancelNow();
      return;
    }
    const approved = this.record.approved;
    if (!approved) {
      if (this.record.offer) this.setPhase('awaiting-confirmation');
      else await this.sendBootstrap('bootstrap');
      return;
    }
    let authorization = this.record.authorization;
    let status = value(
      await this.options.worker.request({
        kind: 'transferStatus',
        statement: approved.statement,
        ...(authorization ? { authorization } : {}),
      }),
    );
    if (!authorization && status.matchedAuthorization)
      authorization = status.matchedAuthorization.entry;
    if (authorization && !this.record.authorization)
      await this.save({ ...this.record, authorization });
    if (authorization && status.outcome) {
      await this.deliverOutcome(status.outcome);
      return;
    }
    if (status.expiredBeforeCertification) {
      this.setPhase('cancelled');
      return;
    }
    if (!authorization) {
      if (status.pending && equal(status.pending.statement, approved.statement)) {
        authorization = status.pending.entry;
      } else {
        if (status.pending) throw new TypeError('Another transfer was certified');
        this.setPhase('awaiting-authorization');
        value(
          await this.options.worker.request({
            kind: 'submitTransfer',
            change: approved,
            head: status.head,
          }),
        );
        status = value(
          await this.options.worker.request({
            kind: 'transferStatus',
            statement: approved.statement,
          }),
        );
        authorization = status.matchedAuthorization?.entry ?? status.pending?.entry ?? null;
      }
      if (!authorization || !status.pending || !equal(status.pending.statement, approved.statement))
        throw new TypeError('Signed authorization was not certified exactly');
      if (!this.record.authorization) await this.save({ ...this.record, authorization });
    }
    if (!status.pending || !sameRef(status.pending.entry, authorization))
      throw new TypeError('Certified transfer authorization disappeared');
    await this.sendBootstrap('authorized');
    const packet = value(
      await this.options.worker.request({
        kind: 'prepareTransferPrivate',
        authorization,
      }),
    );
    this.ensureOpen();
    if (
      packet.destinationDevice !== this.record.destinationDevice ||
      !sameRef(packet.authorization, authorization)
    )
      throw new TypeError('Prepared private packet differs from certified destination');
    await this.options.channel.send({ kind: 'private', bytes: canonicalEncode(packet) });
    this.setPhase('awaiting-readiness');
  }

  private async sendBootstrap(kind: 'bootstrap' | 'authorized'): Promise<void> {
    const bytes = value(await this.options.worker.request({ kind: 'exportTransferBootstrap' }));
    this.ensureOpen();
    await this.options.channel.send({ kind, bytes });
  }

  private async deliverOutcome(outcome: {
    readonly authorization: OnlineWorkerHead;
    readonly outcome: 'activated' | 'cancelled';
    readonly entry: OnlineWorkerHead;
  }): Promise<void> {
    if (!this.record.authorization || !sameRef(outcome.authorization, this.record.authorization))
      throw new TypeError('Certified outcome belongs to another authorization');
    this.setPhase(
      outcome.outcome === 'cancelled' ? 'cancelled-awaiting-receipt' : 'awaiting-receipt',
    );
    const parent = value(
      await this.options.worker.request({
        kind: 'exportTransferBootstrap',
        throughSeq: outcome.entry.seq - 1,
      }),
    );
    this.ensureOpen();
    await this.options.channel.send({ kind: 'authorized', bytes: parent });
    const final = value(
      await this.options.worker.request({
        kind: 'exportTransferBootstrap',
        throughSeq: outcome.entry.seq,
      }),
    );
    this.ensureOpen();
    await this.options.channel.send({ kind: outcome.outcome, bytes: final });
  }

  cancel(): Promise<void> {
    return this.run(async () => {
      if (!this.record.approved) {
        this.setPhase('cancelled');
        this.close();
        return;
      }
      if (!this.record.cancelRequested) await this.save({ ...this.record, cancelRequested: true });
      await this.cancelNow();
    });
  }

  private async cancelNow(): Promise<void> {
    const approved = this.record.approved;
    if (!approved || !this.record.cancelRequested)
      throw new TypeError('Transfer cancellation has no durable source decision');
    const status = value(
      await this.options.worker.request({
        kind: 'transferStatus',
        statement: approved.statement,
        ...(this.record.authorization ? { authorization: this.record.authorization } : {}),
      }),
    );
    const authorization = this.record.authorization ?? status.matchedAuthorization?.entry;
    if (!authorization) {
      if (status.expiredBeforeCertification) {
        this.setPhase('cancelled');
        return;
      }
      throw new TypeError(
        'Approved transfer outcome is uncertain; cancellation needs its certified ref',
      );
    }
    if (!this.record.authorization) await this.save({ ...this.record, authorization });
    if (status.outcome) {
      await this.deliverOutcome(status.outcome);
      return;
    }
    if (!status.pending || !sameRef(status.pending.entry, authorization))
      throw new TypeError('Certified authorization is no longer pending');
    value(
      await this.options.worker.request({
        kind: 'submitTransfer',
        head: status.head,
        change: {
          kind: 'transfer-cancel',
          genesisDigest: this.record.genesisDigest,
          authorization,
          parent: status.head,
        },
      }),
    );
    const finalized = value(
      await this.options.worker.request({
        kind: 'transferStatus',
        statement: approved.statement,
        authorization,
      }),
    );
    if (!finalized.outcome)
      throw new TypeError('Transfer cancellation has not certified an exact outcome');
    await this.deliverOutcome(finalized.outcome);
  }
}

export interface DestinationTransferExchangeOptions extends CommonOptions {
  readonly record: OnlineTransferExchangeRecord & { readonly role: 'destination' };
  readonly expected: ExpectedOnlineTransferGame;
  readonly onPromoted: (gameId: string) => void | Promise<void>;
  readonly shutdownWorker: () => Promise<void>;
}

/** Destination checks and stores every private consequence inside its isolated worker. */
export class DestinationTransferExchange extends Exchange {
  private readonly destination: DestinationTransferExchangeOptions;
  private initialized = false;
  private terminal: OnlineTransferDestinationSnapshot | null = null;
  private promotionNotified = false;
  private lastReadinessHead: OnlineWorkerHead | null = null;

  constructor(options: DestinationTransferExchangeOptions) {
    super(options, 'destination');
    if (
      options.expected.gameId !== this.record.gameId ||
      options.expected.genesisDigest !== this.record.genesisDigest
    )
      throw new TypeError('Destination expected game differs from transfer record');
    this.destination = options;
  }

  /** Resume a terminal result already verified from the destination's durable worker store. */
  restoreTerminal(snapshot: OnlineTransferDestinationSnapshot): void {
    const outcome = snapshot.outcome;
    if (
      this.closed ||
      this.initialized ||
      !outcome ||
      !this.record.authorization ||
      snapshot.gameId !== this.record.gameId ||
      !sameRef(outcome.authorization, this.record.authorization) ||
      !sameRef(outcome.entry, snapshot.head) ||
      (outcome.outcome === 'cancelled'
        ? snapshot.phase !== 'cancelled'
        : snapshot.phase !== 'promoted')
    )
      throw new TypeError('Restored destination has no matching certified terminal result');
    this.initialized = true;
    this.terminal = detached(snapshot);
    this.promotionNotified = true;
    this.setPhase(outcome.outcome);
  }

  protected async handle(artifact: OnlineTransferArtifact): Promise<void> {
    if (this.terminal) {
      if (
        artifact.kind === 'bootstrap' ||
        artifact.kind === 'authorized' ||
        artifact.kind === 'activated' ||
        artifact.kind === 'cancelled'
      ) {
        await this.completeTerminal();
        return;
      }
      throw new TypeError('Finalized destination cannot accept more transfer material');
    }
    if (artifact.kind === 'bootstrap') {
      if (this.initialized) {
        const snapshot = value(
          await this.options.worker.request({
            kind: 'refreshTransferBootstrap',
            bootstrapBytes: artifact.bytes,
          }),
        );
        if (snapshot.phase === 'prepared' || snapshot.phase === 'offered') await this.sendOffer();
        if (snapshot.phase === 'imported' || snapshot.phase === 'ready')
          await this.sendReadiness(snapshot.head, false);
        return;
      }
      const opened = value(
        await this.options.worker.request({
          kind: 'initializeTransfer',
          self: this.record.destinationDevice,
          attemptId: this.record.attemptId,
          mode: 'open',
          expected: this.destination.expected,
          ...(this.record.importedArchiveId === undefined
            ? {}
            : { importedArchiveId: this.record.importedArchiveId }),
          bootstrapBytes: artifact.bytes,
        }),
      );
      this.ensureOpen();
      this.initialized = true;
      if (opened.phase === 'promoted') {
        await this.pinOutcome(opened, 'activated');
        await this.destination.shutdownWorker();
        this.ensureOpen();
        this.terminal = detached(opened);
        await this.completeTerminal();
        return;
      }
      if (opened.phase === 'cancelled') {
        await this.pinOutcome(opened, 'cancelled');
        await this.destination.shutdownWorker();
        this.ensureOpen();
        this.terminal = detached(opened);
        await this.completeTerminal();
        return;
      }
      await this.sendOffer();
      if (opened.phase === 'imported' || opened.phase === 'ready') {
        await this.sendReadiness(opened.head, true);
        this.setPhase('awaiting-certification');
      } else this.setPhase('awaiting-authorization');
      return;
    }
    if (!this.initialized) throw new TypeError('Destination has no verified initial bootstrap');
    if (artifact.kind === 'authorized') {
      const snapshot = value(
        await this.options.worker.request({
          kind: 'refreshTransferBootstrap',
          bootstrapBytes: artifact.bytes,
        }),
      );
      this.ensureOpen();
      if (snapshot.authorization && !this.record.authorization)
        await this.save({ ...this.record, authorization: snapshot.authorization });
      if (snapshot.phase === 'imported' || snapshot.phase === 'ready') {
        await this.sendReadiness(snapshot.head, false);
        this.setPhase('awaiting-certification');
      } else this.setPhase('awaiting-private');
      return;
    }
    if (artifact.kind === 'private') {
      if (artifact.bytes.length > 64 * 1024) throw new RangeError('Private packet is oversized');
      const packet: TransferPrivateEnvelope = v.parse(
        transferPrivateEnvelopeSchema,
        canonicalDecode(artifact.bytes),
      );
      if (packet.destinationDevice !== this.record.destinationDevice)
        throw new TypeError('Private packet addresses another destination');
      const snapshot = value(
        await this.options.worker.request({ kind: 'importTransferPacket', packet }),
      );
      if (!snapshot.authorization) throw new TypeError('Authenticated import has no authorization');
      if (!sameRef(packet.authorization, snapshot.authorization))
        throw new TypeError('Private packet differs from staged authorization');
      if (this.record.authorization && !sameRef(this.record.authorization, snapshot.authorization))
        throw new TypeError('Transfer authorization changed after import');
      if (!this.record.authorization)
        await this.save({ ...this.record, authorization: snapshot.authorization });
      await this.sendReadiness(snapshot.head, true);
      this.setPhase('awaiting-certification');
      return;
    }
    if (artifact.kind === 'activated') {
      const observed = value(
        await this.options.worker.request({
          kind: 'observeTransferActivation',
          bootstrapBytes: artifact.bytes,
        }),
      );
      await this.pinOutcome(observed.snapshot, 'activated');
      await this.destination.shutdownWorker();
      this.ensureOpen();
      this.terminal = detached(observed.snapshot);
      await this.completeTerminal();
      return;
    }
    if (artifact.kind === 'cancelled') {
      const observed = value(
        await this.options.worker.request({
          kind: 'observeTransferCancellation',
          bootstrapBytes: artifact.bytes,
        }),
      );
      await this.pinOutcome(observed, 'cancelled');
      await this.destination.shutdownWorker();
      this.ensureOpen();
      this.terminal = detached(observed);
      await this.completeTerminal();
      return;
    }
    throw new TypeError('Unexpected destination transfer artifact');
  }

  retry(): Promise<void> {
    return this.run(async () => {
      if (this.terminal) {
        await this.completeTerminal();
        return;
      }
      if (!this.initialized) return;
      const snapshot = value(await this.options.worker.request({ kind: 'transferSnapshot' }));
      if (snapshot.phase === 'prepared' || snapshot.phase === 'offered') {
        await this.sendOffer();
      } else if (snapshot.phase === 'imported' || snapshot.phase === 'ready') {
        await this.sendReadiness(snapshot.head, true);
      }
    });
  }

  private async sendOffer(): Promise<void> {
    const offer = value(
      await this.options.worker.request({
        kind: 'prepareTransferOffer',
        seat: this.record.seat,
        mode: 'live',
      }),
    );
    if (
      offer.statement.destination.devicePeer !== this.record.destinationDevice ||
      offer.statement.genesisDigest !== this.record.genesisDigest ||
      offer.statement.seat !== this.record.seat ||
      (this.record.offer && !equal(this.record.offer, offer))
    )
      throw new TypeError('Destination worker prepared another signed transfer offer');
    if (!this.record.offer) await this.save({ ...this.record, offer });
    this.ensureOpen();
    await this.options.channel.send({ kind: 'offer', bytes: canonicalEncode(offer) });
  }

  private async sendReadiness(head: OnlineWorkerHead, explicit: boolean): Promise<void> {
    if (!explicit && this.lastReadinessHead && sameRef(this.lastReadinessHead, head)) return;
    const readiness = value(
      await this.options.worker.request({ kind: 'prepareTransferReadiness' }),
    );
    this.ensureOpen();
    await this.options.channel.send({ kind: 'readiness', bytes: canonicalEncode(readiness) });
    this.lastReadinessHead = head;
  }

  /** A lost receipt must be retryable after the importer has already shut down. */
  private async completeTerminal(): Promise<void> {
    const snapshot = this.terminal;
    const outcome = snapshot?.outcome?.outcome;
    if (!snapshot || !outcome) throw new TypeError('Finalized transfer outcome is missing');
    this.setPhase(outcome);
    if (outcome === 'activated' && !this.promotionNotified) {
      await this.destination.onPromoted(this.record.gameId);
      this.promotionNotified = true;
    }
    await this.sendReceipt(snapshot, outcome);
  }

  private async pinOutcome(
    snapshot: OnlineTransferDestinationSnapshot,
    outcome: 'activated' | 'cancelled',
  ): Promise<void> {
    const certified = snapshot.outcome;
    if (
      !certified ||
      certified.outcome !== outcome ||
      !sameRef(certified.entry, snapshot.head) ||
      (this.record.authorization && !sameRef(this.record.authorization, certified.authorization))
    )
      throw new TypeError('Destination did not verify this exact certified outcome');
    if (!this.record.authorization)
      await this.save({ ...this.record, authorization: certified.authorization });
  }

  private async sendReceipt(
    snapshot: OnlineTransferDestinationSnapshot,
    outcome: 'activated' | 'cancelled',
  ): Promise<void> {
    const certified = snapshot.outcome;
    if (
      !certified ||
      certified.outcome !== outcome ||
      !this.record.authorization ||
      !sameRef(certified.authorization, this.record.authorization) ||
      !sameRef(certified.entry, snapshot.head)
    )
      throw new TypeError('Observed transfer has no matching certified final head');
    this.ensureOpen();
    await this.options.channel.send({
      kind: 'received',
      bytes: canonicalEncode({
        protocol: 'online-transfer-received-v1',
        destinationDevice: this.record.destinationDevice,
        authorization: certified.authorization,
        outcome,
        entry: certified.entry,
      }),
    });
  }

  override close(): void {
    if (this.closed) return;
    super.close();
    void this.destination.shutdownWorker().catch(() => undefined);
  }
}
