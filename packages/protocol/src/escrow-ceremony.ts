import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { decodeScalar, encodeScalar, verifyFeldmanShare } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Engine, Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { deckCeremonyId, validateDeckCeremony } from './deck-genesis.js';
import type { SignedDeckPass } from './deck-setup.js';
import {
  acceptEscrowShare,
  escrowShareEnvelopeHash,
  verifyEscrowShareAck,
} from './escrow-distribution.js';
import type {
  AcceptedEscrowShare,
  EscrowShareAck,
  EscrowShareEnvelope,
} from './escrow-distribution.js';
import { createEscrowShareDispute } from './escrow-dispute.js';
import { verifyEscrowShareDispute } from './escrow-dispute.js';
import type { EscrowDisputeVerdict, EscrowShareDispute } from './escrow-dispute.js';
import { prepareGenesisConsent } from './genesis-outbox.js';
import { genesisDigest, signVerifiedGenesis, validateGenesisEntry } from './genesis.js';
import {
  checkEscrowCeremonyActive,
  checkEscrowLocalDistribution,
  completeEscrowCeremony,
  prepareEscrowDistribution,
  prepareEscrowManifestApproval,
  reserveEscrowGenesisConsent,
  retireEscrowCeremonyWithinLock,
  retireEscrowCeremony,
} from './escrow-lifecycle.js';
import type { EscrowLifecycleStore, EscrowManifestApproval } from './escrow-lifecycle.js';
import type { GenesisBody, SeatSignature } from './types.js';
import { parseCanonical } from './validation.js';
import { validateGenesisEscrow } from './genesis-escrow.js';
import { deriveEscrowRosters } from './escrow-roster.js';

/** The adapter must use a device-wide lock shared by every local tab. */
export interface EscrowCeremonyStore extends EscrowLifecycleStore {
  withCeremonyLock<T>(ceremonyId: string, task: () => Promise<T>): Promise<T>;
}

/** Enqueue synchronously. A network completion is not awaited under the lock. */
export type CeremonySend<T> = (message: T) => undefined;

const acceptedProtocol = 'escrow-accepted-share-v1';
const acceptedSchema = v.strictObject({
  protocol: v.literal(acceptedProtocol),
  ceremonyId: v.string(),
  envelopeHash: v.string(),
  dealerSeat: v.number(),
  holderSeat: v.number(),
  index: v.number(),
  share: v.string(),
  ack: v.unknown(),
});

function copy<T>(value: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Canonical roundtrip detaches a caller-owned value without changing its shape.
  return canonicalDecode(canonicalEncode(value)) as T;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Owns every pre-genesis sign/send edge for one locally pinned ceremony. The
 * caller must use this coordinator rather than directly sending outputs of the
 * lower-level proof helpers. The store retains private accepted shares and all
 * immutable outbound records across process restarts.
 */
export class EscrowCeremony {
  readonly #manifest: GenesisBody;
  readonly #ceremonyId: string;
  readonly #store: EscrowCeremonyStore;

  constructor(localFrozenManifest: GenesisBody, store: EscrowCeremonyStore) {
    const detached = copy(localFrozenManifest);
    if (detached.security !== 'verified')
      throw new Error('Escrow ceremony requires a verified manifest');
    this.#manifest = detached;
    this.#ceremonyId = deckCeremonyId(detached);
    this.#store = store;
  }

  get ceremonyId(): string {
    return this.#ceremonyId;
  }

  async #locked<T>(task: () => Promise<Result<T>>): Promise<Result<T>> {
    try {
      return await this.#store.withCeremonyLock(this.#ceremonyId, task);
    } catch {
      return failure('escrow-ceremony-lock', 'Could not acquire or complete the ceremony lock');
    }
  }

  async #active(): Promise<Result<void>> {
    const status = await checkEscrowCeremonyActive(this.#manifest, this.#store);
    if (
      !status.ok &&
      !['escrow-ceremony-consenting', 'escrow-ceremony-completed'].includes(status.error.code)
    )
      return status;
    const disclosures = await this.#loadDisclosures();
    if (!disclosures.ok) return disclosures;
    if (disclosures.value.length === 0) return status;
    if (!status.ok)
      return failure(
        'escrow-ceremony-consenting-dispute',
        'Authenticated disclosure is pending disposition after genesis consent',
      );
    // A prior call may have persisted evidence and crashed before retirement.
    // Finish that durable transition before any further ceremony output.
    const retired = await retireEscrowCeremonyWithinLock(this.#manifest, this.#store);
    if (!retired.ok) return retired;
    return failure('escrow-ceremony-retired', 'Authenticated disclosure retired the ceremony');
  }

  async approveAndSend(
    candidate: GenesisBody,
    seat: Seat,
    signingKey: Uint8Array,
    send: CeremonySend<EscrowManifestApproval>,
  ): Promise<Result<EscrowManifestApproval>> {
    const proposed = copy(candidate);
    const key = signingKey.slice();
    try {
      return await this.#locked(async () => {
        const active = await this.#active();
        if (!active.ok) return active;
        const approval = await prepareEscrowManifestApproval(
          proposed,
          this.#manifest,
          seat,
          key,
          this.#store,
        );
        if (!approval.ok) return approval;
        const beforeSend = await this.#active();
        if (!beforeSend.ok) return beforeSend;
        send(copy(approval.value));
        return approval;
      });
    } finally {
      key.fill(0);
    }
  }

  async distributeAndSend(input: {
    genesis: GenesisBody;
    approvals: readonly EscrowManifestApproval[];
    dealerSeat: Seat;
    master: Uint8Array;
    dealerSigningKey: Uint8Array;
    send: (holderSeat: Seat, envelope: EscrowShareEnvelope) => undefined;
  }): Promise<Result<readonly EscrowShareEnvelope[]>> {
    const genesis = copy(input.genesis);
    const approvals = copy(input.approvals);
    const master = input.master.slice();
    const key = input.dealerSigningKey.slice();
    const { dealerSeat, send } = input;
    try {
      return await this.#locked(async () => {
        const active = await this.#active();
        if (!active.ok) return active;
        const prepared = await prepareEscrowDistribution({
          genesis,
          localFrozenManifest: this.#manifest,
          approvals,
          dealerSeat,
          master,
          dealerSigningKey: key,
          store: this.#store,
        });
        if (!prepared.ok) return prepared;
        // oxlint-disable no-await-in-loop -- Each send must recheck retirement after the preceding enqueue.
        for (const envelope of prepared.value) {
          const beforeSend = await this.#active();
          if (!beforeSend.ok) return beforeSend;
          send(envelope.body.holder.seat, copy(envelope));
        }
        // oxlint-enable no-await-in-loop
        return prepared;
      });
    } finally {
      master.fill(0);
      key.fill(0);
    }
  }

  async acceptAndSendAck(input: {
    envelope: EscrowShareEnvelope;
    dealerSeat: Seat;
    expectedMasterPub: string;
    holderSeat: Seat;
    recipientEncryptionSecret: bigint;
    holderSigningKey: Uint8Array;
    send: CeremonySend<EscrowShareAck>;
  }): Promise<Result<EscrowShareAck>> {
    const envelope = copy(input.envelope);
    const key = input.holderSigningKey.slice();
    const { dealerSeat, expectedMasterPub, holderSeat, recipientEncryptionSecret, send } = input;
    try {
      return await this.#locked(async () => {
        const active = await this.#active();
        if (!active.ok) return active;
        const accepted = acceptEscrowShare({
          envelope,
          genesis: this.#manifest,
          dealerSeat,
          expectedMasterPub,
          holderSeat,
          recipientEncryptionSecret,
          holderSigningKey: key,
        });
        if (!accepted.ok) return accepted;
        const record = {
          protocol: acceptedProtocol,
          ceremonyId: this.#ceremonyId,
          envelopeHash: escrowShareEnvelopeHash(envelope),
          dealerSeat: accepted.value.dealerSeat,
          holderSeat: accepted.value.holderSeat,
          index: accepted.value.index,
          share: encodeScalar(accepted.value.value),
          ack: accepted.value.ack,
        } as const;
        const bytes = canonicalEncode(record);
        const id = `escrow-accepted/${this.#ceremonyId}/${dealerSeat}/${holderSeat}`;
        const previous = await this.#store.load(id);
        if (previous === null && !(await this.#store.putIfAbsent(id, bytes))) {
          const winner = await this.#store.load(id);
          if (!winner) return failure('escrow-accepted-record', 'Accepted share winner is missing');
          const parsed = parseCanonical(canonicalDecode(winner), acceptedSchema);
          if (!parsed.ok || !sameBytes(winner, bytes))
            return failure('escrow-accepted-conflict', 'Another private share is already retained');
        } else if (previous !== null && !sameBytes(previous, bytes)) {
          return failure('escrow-accepted-conflict', 'Another private share is already retained');
        }
        const beforeSend = await this.#active();
        if (!beforeSend.ok) return beforeSend;
        send(copy(accepted.value.ack));
        return success(accepted.value.ack);
      });
    } finally {
      key.fill(0);
    }
  }

  /** Local-only recovery of a previously accepted private share; never sends it. */
  async loadAcceptedShare(
    envelopeValue: EscrowShareEnvelope,
  ): Promise<Result<AcceptedEscrowShare>> {
    const envelope = copy(envelopeValue);
    return this.#locked(async () => {
      const { dealer, holder, masterPub, shareHash } = envelope.body;
      const id = `escrow-accepted/${this.#ceremonyId}/${dealer.seat}/${holder.seat}`;
      const bytes = await this.#store.load(id);
      if (!bytes)
        return failure('escrow-accepted-missing', 'No accepted private share is retained');
      const parsed = parseCanonical(canonicalDecode(bytes), acceptedSchema);
      if (
        !parsed.ok ||
        !sameBytes(canonicalEncode(parsed.value), bytes) ||
        parsed.value.ceremonyId !== this.#ceremonyId ||
        parsed.value.dealerSeat !== dealer.seat ||
        parsed.value.holderSeat !== holder.seat ||
        parsed.value.index !== holder.index ||
        parsed.value.envelopeHash !== escrowShareEnvelopeHash(envelope)
      )
        return failure('escrow-accepted-record', 'Stored private share differs from this envelope');
      const ack = verifyEscrowShareAck(parsed.value.ack, this.#manifest, {
        ceremonyId: this.#ceremonyId,
        dealerSeat: dealer.seat,
        holderSeat: holder.seat,
        expectedMasterPub: masterPub,
        shareHash,
        envelopeHash: parsed.value.envelopeHash,
      });
      if (!ack.ok) return ack;
      try {
        const value = decodeScalar(parsed.value.share);
        if (
          !verifyFeldmanShare({ index: holder.index, value }, envelope.body.commitments, {
            threshold: envelope.body.threshold,
            masterPub,
            recipientIndex: holder.index,
          })
        )
          return failure('escrow-accepted-record', 'Stored private share fails the commitment');
        return success({
          dealerSeat: dealer.seat,
          holderSeat: holder.seat,
          index: holder.index,
          value,
          shareHash,
          ack: ack.value,
        });
      } catch {
        return failure('escrow-accepted-record', 'Stored private share is malformed');
      }
    });
  }

  async consentAndSend(input: {
    body: GenesisBody;
    transcripts: readonly { deckId: string; passes: readonly SignedDeckPass[] }[];
    seat: Seat;
    signingKey: Uint8Array;
    send: CeremonySend<SeatSignature>;
  }): Promise<Result<SeatSignature>> {
    const body = copy(input.body);
    const transcripts = copy(input.transcripts);
    const key = input.signingKey.slice();
    const { seat, send } = input;
    try {
      return await this.#locked(async () => {
        const active = await this.#active();
        if (!active.ok && active.error.code !== 'escrow-ceremony-consenting') return active;
        if (deckCeremonyId(body) !== this.#ceremonyId)
          return failure('escrow-manifest-conflict', 'Consent differs from the frozen ceremony');
        const checked = signVerifiedGenesis(body, transcripts, seat, key);
        if (!checked.ok) return checked;
        const localDistribution = await checkEscrowLocalDistribution(
          this.#manifest,
          body,
          this.#store,
        );
        if (!localDistribution.ok) return localDistribution;
        const localAcks = await this.#checkAcceptedAcks(body);
        if (!localAcks.ok) return localAcks;
        const digest = genesisDigest(body);
        const reserved = await reserveEscrowGenesisConsent(this.#manifest, digest, this.#store);
        if (!reserved.ok) return reserved;
        const consent = await prepareGenesisConsent(body, transcripts, seat, key, this.#store);
        if (!consent.ok) return consent;
        const beforeSend = await reserveEscrowGenesisConsent(this.#manifest, digest, this.#store);
        if (!beforeSend.ok) return beforeSend;
        send(copy(consent.value));
        return consent;
      });
    } finally {
      key.fill(0);
    }
  }

  async #checkAcceptedAcks(body: GenesisBody): Promise<Result<void>> {
    const transcript = validateGenesisEscrow(body);
    if (!transcript.ok) return transcript;
    for (const dealer of transcript.value) {
      for (const { envelope, ack } of dealer.shares) {
        const id = `escrow-accepted/${this.#ceremonyId}/${dealer.dealerSeat}/${envelope.body.holder.seat}`;
        // oxlint-disable-next-line no-await-in-loop -- Each bounded local record is checked against the final draft before consent.
        const bytes = await this.#store.load(id);
        if (bytes === null) continue;
        const parsed = parseCanonical(canonicalDecode(bytes), acceptedSchema);
        if (
          !parsed.ok ||
          !sameBytes(canonicalEncode(parsed.value), bytes) ||
          parsed.value.envelopeHash !== escrowShareEnvelopeHash(envelope) ||
          !sameBytes(canonicalEncode(parsed.value.ack), canonicalEncode(ack))
        )
          return failure(
            'escrow-ceremony-ack-conflict',
            'Final draft differs from a locally accepted share',
          );
      }
    }
    return success(undefined);
  }

  async disputeAndPublish(input: {
    envelope: EscrowShareEnvelope;
    dealerSeat: Seat;
    holderSeat: Seat;
    recipientEncryptionSecret: bigint;
    holderSigningKey: Uint8Array;
    publish: CeremonySend<EscrowShareDispute>;
  }): Promise<Result<EscrowShareDispute>> {
    const envelope = copy(input.envelope);
    const key = input.holderSigningKey.slice();
    const { dealerSeat, holderSeat, recipientEncryptionSecret, publish } = input;
    try {
      return await this.#locked(async () => {
        const acceptedId = `escrow-accepted/${this.#ceremonyId}/${dealerSeat}/${holderSeat}`;
        if ((await this.#store.load(acceptedId)) !== null)
          return failure(
            'escrow-dispute-acknowledged',
            'An accepted share cannot be locally disputed',
          );
        const dispute = createEscrowShareDispute({
          genesis: this.#manifest,
          envelope,
          dealerSeat,
          holderSeat,
          recipientEncryptionSecret,
          holderSigningKey: key,
        });
        if (!dispute.ok) return dispute;
        const handled = await this.#handleDispute(envelope, dispute.value, true, publish);
        return handled.ok ? success(dispute.value) : handled;
      });
    } finally {
      key.fill(0);
    }
  }

  async receiveDispute(
    envelopeValue: EscrowShareEnvelope,
    disputeValue: EscrowShareDispute,
  ): Promise<Result<void>> {
    const envelope = copy(envelopeValue);
    const dispute = copy(disputeValue);
    return this.#locked(() => this.#handleDispute(envelope, dispute, false));
  }

  async #handleDispute(
    envelope: EscrowShareEnvelope,
    dispute: EscrowShareDispute,
    local: boolean,
    publish?: CeremonySend<EscrowShareDispute>,
  ): Promise<Result<void>> {
    const verdict = verifyEscrowShareDispute(dispute, envelope, this.#manifest);
    if (!verdict.ok) return verdict;
    if (local && verdict.value.kind !== 'bad-share')
      return failure('escrow-dispute-local', 'A local holder cannot publish a false complaint');
    // Dispute intake must continue for later authenticated disclosures after
    // consent; the outgoing-action barrier belongs only on sign/send paths.
    const active = await checkEscrowCeremonyActive(this.#manifest, this.#store);
    if (
      !active.ok &&
      ![
        'escrow-ceremony-consenting',
        'escrow-ceremony-completed',
        'escrow-ceremony-retired',
      ].includes(active.error.code)
    )
      return active;
    const { dealerSeat, holderSeat } = dispute.body;
    const recordId = `escrow-dispute/${this.#ceremonyId}/${dealerSeat}/${holderSeat}`;
    const record = canonicalEncode({ envelope, dispute, verdict: verdict.value });
    const previous = await this.#store.load(recordId);
    if (!active.ok && active.error.code === 'escrow-ceremony-retired' && previous === null)
      return failure('escrow-ceremony-retired', 'Only an exact retained dispute can be retried');
    if (previous === null && !(await this.#store.putIfAbsent(recordId, record))) {
      const winner = await this.#store.load(recordId);
      if (!winner || !sameBytes(winner, record))
        return failure('escrow-dispute-record', 'Another disclosure is retained');
    } else if (previous !== null && !sameBytes(previous, record)) {
      return failure('escrow-dispute-record', 'Another disclosure is retained');
    }
    if (!active.ok) {
      if (active.error.code === 'escrow-ceremony-retired') {
        publish?.(copy(dispute));
        return success(undefined);
      }
      return failure(
        'escrow-ceremony-consenting-dispute',
        'Authenticated disclosure retained after genesis consent; game disposition is pending',
      );
    }
    const retired = await retireEscrowCeremonyWithinLock(this.#manifest, this.#store);
    if (!retired.ok) return retired;
    publish?.(copy(dispute));
    return success(undefined);
  }

  async abort(): Promise<Result<void>> {
    return retireEscrowCeremony(this.#manifest, this.#store);
  }

  /** Restores bounded authenticated disclosures for a consented or completed ceremony. */
  async loadDisclosures(): Promise<Result<readonly EscrowDisputeVerdict[]>> {
    return this.#locked(() => this.#loadDisclosures());
  }

  async #loadDisclosures(): Promise<Result<readonly EscrowDisputeVerdict[]>> {
    const rosters = deriveEscrowRosters(this.#manifest);
    if (!rosters.ok) return rosters;
    const output: EscrowDisputeVerdict[] = [];
    for (const roster of rosters.value.filter((item) => item.eligible)) {
      for (const holder of roster.holders) {
        const id = `escrow-dispute/${this.#ceremonyId}/${roster.dealer.seat}/${holder.seat}`;
        // oxlint-disable-next-line no-await-in-loop -- Fixed roster slots bound reads and preserve deterministic order.
        const bytes = await this.#store.load(id);
        if (bytes === null) continue;
        const parsed = parseCanonical(
          canonicalDecode(bytes),
          v.strictObject({
            envelope: v.unknown(),
            dispute: v.unknown(),
            verdict: v.unknown(),
          }),
        );
        if (!parsed.ok || !sameBytes(canonicalEncode(parsed.value), bytes))
          return failure('escrow-dispute-record', 'Stored disclosure is corrupt');
        const verdict = verifyEscrowShareDispute(
          parsed.value.dispute,
          parsed.value.envelope,
          this.#manifest,
        );
        if (
          !verdict.ok ||
          !sameBytes(canonicalEncode(verdict.value), canonicalEncode(parsed.value.verdict))
        )
          return failure('escrow-dispute-record', 'Stored disclosure failed verification');
        output.push(verdict.value);
      }
    }
    return success(output);
  }

  async complete(input: {
    signedGenesisEntry: unknown;
    transcripts: readonly { deckId: string; passes: readonly SignedDeckPass[] }[];
    engine: Engine;
  }): Promise<Result<string>> {
    const entry = copy(input.signedGenesisEntry);
    const transcripts = copy(input.transcripts);
    const { engine } = input;
    return this.#locked(async () => {
      const checked = validateGenesisEntry(entry, engine, {
        verifyCommitments: (genesis) => {
          // The mandatory escrow verifier already runs in validateGenesisEntry.
          return validateDeckCeremony(genesis, transcripts);
        },
      });
      if (!checked.ok) return checked;
      const genesis = checked.value.genesis;
      if (deckCeremonyId(genesis) !== this.#ceremonyId)
        return failure(
          'escrow-manifest-conflict',
          'Signed genesis differs from the frozen ceremony',
        );
      const digest = genesisDigest(genesis);
      const completed = await completeEscrowCeremony(this.#manifest, genesis, digest, this.#store);
      if (!completed.ok) return completed;
      const disclosures = await this.#loadDisclosures();
      if (!disclosures.ok) return disclosures;
      return disclosures.value.length
        ? failure(
            'escrow-ceremony-disputed',
            'Certified genesis has an authenticated escrow disclosure pending disposition',
          )
        : success(digest);
    });
  }
}
