import { canonicalDecode, canonicalEncode, fromBase64Url, toBase64Url } from '@cp2p/codec';
import {
  DERIVATION_LABELS,
  deriveBytes,
  encodePoint,
  identityFromSecret,
  parsePeerId,
  scalarFromBytes,
  scalePoint,
  signObject,
  verifyObject,
  G,
} from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import {
  createEscrowShareEnvelopes,
  escrowShareEnvelopeSchema,
  verifyEscrowShareEphemeralProof,
} from './escrow-distribution.js';
import type { EscrowShareEnvelope } from './escrow-distribution.js';
import { verifyEscrowShareDispute } from './escrow-dispute.js';
import type { EscrowDisputeVerdict } from './escrow-dispute.js';
import { deckCeremonyId } from './deck-genesis.js';
import { deriveEscrowRosters } from './escrow-roster.js';
import { validateGenesisEncryption } from './genesis-encryption.js';
import { validateGenesisEscrow } from './genesis-escrow.js';
import { validateGenesisMasters } from './genesis-masters.js';
import { genesisSchema } from './schemas.js';
import { key32Schema, seatSchema, signature64Schema } from './schema-values.js';
import type { GenesisBody } from './types.js';
import { MAX_MESSAGE_BYTES, parseCanonical } from './validation.js';

const APPROVAL_PROTOCOL = 'escrow-manifest-approval-v1';
const RESERVATION_PROTOCOL = 'escrow-master-reservation-v1';
const REGISTRY_PROTOCOL = 'escrow-device-index-v1';
const REGISTRY_ID = 'escrow-lifecycle/device-index-v1';
const MAX_REGISTRY_BYTES = 16 * 1024 * 1024;
const MIN_RETIREMENT_HEADROOM_BYTES = 64 * 1024;
const RETIREMENT_HEADROOM_PER_ACTIVE_CEREMONY = 2 * 1024;
const approvalSchema = v.strictObject({
  body: v.strictObject({
    protocol: v.literal(APPROVAL_PROTOCOL),
    ceremonyId: key32Schema,
    seat: seatSchema,
    publicKey: key32Schema,
  }),
  sig: signature64Schema,
});
const reservationSchema = v.strictObject({
  protocol: v.literal(RESERVATION_PROTOCOL),
  ceremonyId: key32Schema,
  masterPub: key32Schema,
  dealerSeat: seatSchema,
  status: v.picklist(['active', 'retired', 'completed']),
  envelopes: v.pipe(
    v.array(v.pipe(v.string(), v.maxLength(MAX_MESSAGE_BYTES * 2))),
    v.maxLength(5),
  ),
});
const registrySchema = v.strictObject({
  protocol: v.literal(REGISTRY_PROTOCOL),
  reservations: v.pipe(v.array(reservationSchema), v.maxLength(50_000)),
  retiredCeremonies: v.pipe(v.array(key32Schema), v.maxLength(50_000)),
  consentingCeremonies: v.optional(
    v.pipe(
      v.array(v.strictObject({ ceremonyId: key32Schema, genesisDigest: key32Schema })),
      v.maxLength(50_000),
    ),
  ),
  completedCeremonies: v.optional(
    v.pipe(
      v.array(v.strictObject({ ceremonyId: key32Schema, genesisDigest: key32Schema })),
      v.maxLength(50_000),
    ),
  ),
});

export interface EscrowManifestApproval {
  readonly body: {
    readonly protocol: typeof APPROVAL_PROTOCOL;
    readonly ceremonyId: string;
    readonly seat: Seat;
    readonly publicKey: string;
  };
  readonly sig: string;
}

/**
 * Device-global durable storage. A browser implementation must use a
 * transactionally persistent store shared by every tab for this identity.
 * This process-local memory implementation is only a test fixture.
 * The integration layer must preserve each permanent master reservation and
 * clear retained envelope bytes only after validating the certified genesis.
 */
export interface EscrowLifecycleStore {
  load(id: string): Promise<Uint8Array | null>;
  putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean>;
  /** Atomic byte-exact compare-and-swap; true only after durable commit. */
  compareAndSwap(id: string, expected: Uint8Array, replacement: Uint8Array): Promise<boolean>;
  /** Shared device lock, required when this store is used for live delivery. */
  withCeremonyLock?<T>(ceremonyId: string, task: () => Promise<T>): Promise<T>;
}

export class MemoryEscrowLifecycleStore implements EscrowLifecycleStore {
  readonly #records = new Map<string, Uint8Array>();
  readonly #locks = new Map<string, Promise<void>>();

  async withCeremonyLock<T>(ceremonyId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(ceremonyId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#locks.set(ceremonyId, current);
    await previous;
    try {
      return await task();
    } finally {
      if (this.#locks.get(ceremonyId) === current) this.#locks.delete(ceremonyId);
      release();
    }
  }

  async load(id: string): Promise<Uint8Array | null> {
    return this.#records.get(id)?.slice() ?? null;
  }

  async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    if (this.#records.has(id)) return false;
    this.#records.set(id, bytes.slice());
    return true;
  }

  async compareAndSwap(
    id: string,
    expected: Uint8Array,
    replacement: Uint8Array,
  ): Promise<boolean> {
    const current = this.#records.get(id);
    if (!current || !equalBytes(current, expected)) return false;
    this.#records.set(id, replacement.slice());
    return true;
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function checkedManifest(value: unknown): Result<GenesisBody> {
  const parsed = parseCanonical(
    value,
    v.union([genesisSchema, v.omit(genesisSchema, ['gameId', 'signatures'])]),
  );
  if (!parsed.ok) return failure('escrow-lifecycle-genesis', 'Frozen escrow manifest is malformed');
  const genesis: GenesisBody = {
    protocolVersion: parsed.value.protocolVersion,
    engineVersion: parsed.value.engineVersion,
    config: parsed.value.config,
    seats: parsed.value.seats,
    genesisSeed: parsed.value.genesisSeed,
    ceremonyNonce: parsed.value.ceremonyNonce,
    security: parsed.value.security,
    takeover: parsed.value.takeover,
    commitments: parsed.value.commitments,
    createdAt: parsed.value.createdAt,
  };
  if (genesis.security !== 'verified')
    return failure('escrow-lifecycle-security', 'Escrow lifecycle requires a verified manifest');
  const masters = validateGenesisMasters(genesis);
  if (!masters.ok) return masters;
  const encryption = validateGenesisEncryption(genesis);
  if (!encryption.ok) return encryption;
  const rosters = deriveEscrowRosters(genesis);
  if (!rosters.ok) return rosters;
  return success(genesis);
}

function approvalId(ceremonyId: string, seat: Seat): string {
  return `escrow-manifest-approval/${ceremonyId}/${seat}`;
}

/** Sign the lobby-frozen manifest only when the candidate matches the local pin. */
export async function prepareEscrowManifestApproval(
  candidate: GenesisBody,
  localFrozenManifest: GenesisBody,
  seat: Seat,
  signingKey: Uint8Array,
  store: EscrowLifecycleStore,
): Promise<Result<EscrowManifestApproval>> {
  let key: Uint8Array | undefined;
  try {
    const checkedCandidate = checkedManifest(candidate);
    if (!checkedCandidate.ok) return checkedCandidate;
    const checkedLocal = checkedManifest(localFrozenManifest);
    if (!checkedLocal.ok) return checkedLocal;
    const ceremonyId = deckCeremonyId(checkedCandidate.value);
    if (ceremonyId !== deckCeremonyId(checkedLocal.value))
      return failure(
        'escrow-manifest-conflict',
        'Candidate differs from the locally frozen manifest',
      );
    const human = checkedCandidate.value.seats.find((entry) => entry.seat === seat);
    if (!human || human.kind !== 'human')
      return failure(
        'escrow-manifest-seat',
        'Only an original human seat may approve the manifest',
      );
    if (!(signingKey instanceof Uint8Array) || signingKey.length !== 32)
      return failure('escrow-manifest-key', 'Manifest signing key must be 32 bytes');
    key = signingKey.slice();
    const identity = identityFromSecret(key);
    const matches = identity.peerId === human.publicKey;
    identity.secretKey.fill(0);
    if (!matches)
      return failure('escrow-manifest-key', 'Signing key does not match the frozen seat');
    const body: EscrowManifestApproval['body'] = {
      protocol: APPROVAL_PROTOCOL,
      ceremonyId,
      seat,
      publicKey: human.publicKey,
    };
    const approval: EscrowManifestApproval = {
      body,
      sig: signObject('escrow-manifest-approval', body, key),
    };
    const bytes = canonicalEncode(approval);
    const id = approvalId(ceremonyId, seat);
    const previous = await store.load(id);
    if (previous !== null) return validateStoredApproval(previous, approval, human.publicKey);
    if (await store.putIfAbsent(id, bytes)) return success(approval);
    const winner = await store.load(id);
    return winner
      ? validateStoredApproval(winner, approval, human.publicKey)
      : failure('escrow-manifest-record', 'Winning manifest approval is missing');
  } catch {
    return failure('escrow-manifest-write', 'Could not persist the manifest approval');
  } finally {
    key?.fill(0);
  }
}

function validateStoredApproval(
  bytes: Uint8Array,
  expected: EscrowManifestApproval,
  publicKey: string,
): Result<EscrowManifestApproval> {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_MESSAGE_BYTES)
      return failure('escrow-manifest-record', 'Stored manifest approval is corrupt');
    const parsed = parseCanonical(canonicalDecode(bytes), approvalSchema);
    if (!parsed.ok || !equalBytes(canonicalEncode(parsed.value), bytes))
      return failure('escrow-manifest-record', 'Stored manifest approval is corrupt');
    if (
      parsed.value.body.ceremonyId !== expected.body.ceremonyId ||
      parsed.value.body.seat !== expected.body.seat ||
      parsed.value.sig !== expected.sig ||
      !verifyObject(
        'escrow-manifest-approval',
        parsed.value.body,
        parsed.value.sig,
        parsePeerId(publicKey),
      )
    )
      return failure('escrow-manifest-conflict', 'A different approval is already retained');
    return success(parsed.value as EscrowManifestApproval);
  } catch {
    return failure('escrow-manifest-record', 'Stored manifest approval is corrupt');
  }
}

/** Verify one exact signed approval from every original human, in seat order. */
export function verifyEscrowManifestApprovals(
  manifest: GenesisBody,
  approvals: readonly EscrowManifestApproval[],
): Result<void> {
  const checked = checkedManifest(manifest);
  if (!checked.ok) return checked;
  const humans = checked.value.seats.filter((entry) => entry.kind === 'human');
  if (!Array.isArray(approvals) || approvals.length !== humans.length)
    return failure(
      'escrow-manifest-approvals',
      'Every original human must approve the frozen manifest',
    );
  const ceremonyId = deckCeremonyId(checked.value);
  for (let index = 0; index < humans.length; index += 1) {
    const human = humans[index];
    const parsed = parseCanonical(approvals[index], approvalSchema);
    if (!human || !parsed.ok)
      return failure('escrow-manifest-approvals', 'Manifest approval is malformed');
    const { body, sig } = parsed.value;
    if (
      body.protocol !== APPROVAL_PROTOCOL ||
      body.ceremonyId !== ceremonyId ||
      body.seat !== human.seat ||
      body.publicKey !== human.publicKey
    )
      return failure('escrow-manifest-approvals', 'Manifest approval roster or ceremony differs');
    try {
      if (!verifyObject('escrow-manifest-approval', body, sig, parsePeerId(human.publicKey)))
        return failure('escrow-manifest-signature', 'Manifest approval signature is invalid');
    } catch {
      return failure('escrow-manifest-signature', 'Manifest approval signature is invalid');
    }
  }
  return success(undefined);
}

interface Reservation {
  readonly protocol: typeof RESERVATION_PROTOCOL;
  readonly ceremonyId: string;
  readonly masterPub: string;
  readonly dealerSeat: Seat;
  readonly status: 'active' | 'retired' | 'completed';
  readonly envelopes: readonly string[];
}

interface EscrowRegistry {
  readonly protocol: typeof REGISTRY_PROTOCOL;
  readonly reservations: readonly Reservation[];
  readonly retiredCeremonies: readonly string[];
  readonly consentingCeremonies: readonly {
    readonly ceremonyId: string;
    readonly genesisDigest: string;
  }[];
  readonly completedCeremonies: readonly {
    readonly ceremonyId: string;
    readonly genesisDigest: string;
  }[];
}

function emptyRegistry(): EscrowRegistry {
  return {
    protocol: REGISTRY_PROTOCOL,
    reservations: [],
    retiredCeremonies: [],
    consentingCeremonies: [],
    completedCeremonies: [],
  };
}

function activeCeremonies(registry: EscrowRegistry): number {
  return new Set(
    registry.reservations
      .filter(({ status }) => status === 'active')
      .map(({ ceremonyId }) => ceremonyId),
  ).size;
}

function registryWithinBounds(registry: EscrowRegistry): boolean {
  const active = activeCeremonies(registry);
  return (
    registry.reservations.length + active * 6 <= 50_000 &&
    registry.retiredCeremonies.length +
      registry.consentingCeremonies.length +
      registry.completedCeremonies.length +
      active <=
      50_000
  );
}

function parseRegistry(bytes: Uint8Array): Result<EscrowRegistry> {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_REGISTRY_BYTES)
      return failure('escrow-registry-record', 'Stored escrow registry is corrupt');
    const parsed = v.safeParse(registrySchema, canonicalDecode(bytes));
    if (!parsed.success || !equalBytes(bytes, canonicalEncode(parsed.output)))
      return failure('escrow-registry-record', 'Stored escrow registry is corrupt');
    const registry: EscrowRegistry = {
      ...parsed.output,
      consentingCeremonies: parsed.output.consentingCeremonies ?? [],
      completedCeremonies: parsed.output.completedCeremonies ?? [],
    };
    if (
      new Set(registry.reservations.map(({ masterPub }) => masterPub)).size !==
        registry.reservations.length ||
      new Set(registry.retiredCeremonies).size !== registry.retiredCeremonies.length ||
      new Set(registry.completedCeremonies.map(({ ceremonyId }) => ceremonyId)).size !==
        registry.completedCeremonies.length ||
      new Set(registry.consentingCeremonies.map(({ ceremonyId }) => ceremonyId)).size !==
        registry.consentingCeremonies.length ||
      registry.completedCeremonies.some(({ ceremonyId }) =>
        registry.retiredCeremonies.includes(ceremonyId),
      ) ||
      registry.consentingCeremonies.some(({ ceremonyId }) =>
        registry.retiredCeremonies.includes(ceremonyId),
      )
    )
      return failure('escrow-registry-record', 'Stored escrow registry has duplicate reservations');
    if (!registryWithinBounds(registry))
      return failure('escrow-registry-record', 'Stored escrow registry exceeds reservation bounds');
    return success(registry);
  } catch {
    return failure('escrow-registry-record', 'Stored escrow registry is corrupt');
  }
}

function encodeRegistry(
  registry: EscrowRegistry,
  allowRetirementHeadroom: boolean,
): Result<Uint8Array> {
  const parsed = v.safeParse(registrySchema, registry);
  if (!parsed.success || !registryWithinBounds(registry))
    return failure('escrow-registry-record', 'Escrow registry does not match its schema');
  try {
    const bytes = canonicalEncode(parsed.output);
    const active = activeCeremonies(registry);
    const reservedBytes = allowRetirementHeadroom
      ? Math.max(MIN_RETIREMENT_HEADROOM_BYTES, active * RETIREMENT_HEADROOM_PER_ACTIVE_CEREMONY)
      : active * RETIREMENT_HEADROOM_PER_ACTIVE_CEREMONY;
    return bytes.byteLength <= MAX_REGISTRY_BYTES - reservedBytes
      ? success(bytes)
      : failure(
          'escrow-registry-size',
          'Device escrow registry has reached its durable size limit',
        );
  } catch {
    return failure('escrow-registry-record', 'Escrow registry is not canonical data');
  }
}

async function loadRegistry(
  store: EscrowLifecycleStore,
): Promise<Result<{ readonly bytes: Uint8Array | null; readonly value: EscrowRegistry }>> {
  try {
    const bytes = await store.load(REGISTRY_ID);
    if (bytes === null) return success({ bytes: null, value: emptyRegistry() });
    const value = parseRegistry(bytes);
    return value.ok ? success({ bytes, value: value.value }) : value;
  } catch {
    return failure('escrow-registry-read', 'Could not read the device escrow registry');
  }
}

function envelopeBytes(envelope: EscrowShareEnvelope): Uint8Array {
  return canonicalEncode(envelope);
}

function decodeRetainedEnvelopes(reservation: Reservation): Result<readonly EscrowShareEnvelope[]> {
  try {
    const output: EscrowShareEnvelope[] = [];
    for (const encoded of reservation.envelopes) {
      const bytes = fromBase64Url(encoded);
      if (bytes.byteLength > MAX_MESSAGE_BYTES)
        return failure('escrow-reservation-record', 'Stored escrow envelope is too large');
      const parsed = parseCanonical(canonicalDecode(bytes), escrowShareEnvelopeSchema);
      if (!parsed.ok || !equalBytes(bytes, canonicalEncode(parsed.value)))
        return failure('escrow-reservation-record', 'Stored escrow envelope is corrupt');
      output.push(parsed.value);
    }
    return success(output);
  } catch {
    return failure('escrow-reservation-record', 'Stored escrow envelope is corrupt');
  }
}

/** Read the durable registry immediately before an outgoing ceremony action. */
export async function checkEscrowCeremonyActive(
  localFrozenManifest: GenesisBody,
  store: EscrowLifecycleStore,
): Promise<Result<void>> {
  const checked = checkedManifest(localFrozenManifest);
  if (!checked.ok) return checked;
  const ceremonyId = deckCeremonyId(checked.value);
  const loaded = await loadRegistry(store);
  if (!loaded.ok) return loaded;
  if (loaded.value.value.retiredCeremonies.includes(ceremonyId))
    return failure('escrow-ceremony-retired', 'This escrow ceremony has been permanently retired');
  if (loaded.value.value.completedCeremonies.some((item) => item.ceremonyId === ceremonyId))
    return failure('escrow-ceremony-completed', 'This escrow ceremony has completed');
  if (loaded.value.value.consentingCeremonies.some((item) => item.ceremonyId === ceremonyId))
    return failure('escrow-ceremony-consenting', 'This escrow ceremony has issued genesis consent');
  return success(undefined);
}

/** Reject a final draft that omits any locally retained dealer envelope. */
export async function checkEscrowLocalDistribution(
  localFrozenManifest: GenesisBody,
  finalBody: GenesisBody,
  store: EscrowLifecycleStore,
): Promise<Result<void>> {
  const local = checkedManifest(localFrozenManifest);
  if (!local.ok) return local;
  const final = checkedManifest(finalBody);
  if (!final.ok) return final;
  const ceremonyId = deckCeremonyId(local.value);
  if (deckCeremonyId(final.value) !== ceremonyId)
    return failure('escrow-manifest-conflict', 'Final draft differs from local ceremony');
  const transcript = validateGenesisEscrow(final.value);
  if (!transcript.ok) return transcript;
  const loaded = await loadRegistry(store);
  if (!loaded.ok) return loaded;
  if (loaded.value.value.retiredCeremonies.includes(ceremonyId))
    return failure('escrow-ceremony-retired', 'Retired ceremony cannot consent');
  for (const reservation of loaded.value.value.reservations) {
    if (reservation.ceremonyId !== ceremonyId) continue;
    if (reservation.status !== 'active')
      return failure('escrow-ceremony-retired', 'Local master is no longer active');
    const dealer = transcript.value.find((item) => item.dealerSeat === reservation.dealerSeat);
    if (!dealer || dealer.shares.length !== reservation.envelopes.length)
      return failure('escrow-ceremony-transcript', 'Local retained shares differ from final draft');
    for (let index = 0; index < dealer.shares.length; index += 1) {
      const signed = dealer.shares[index];
      if (!signed || reservation.envelopes[index] !== toBase64Url(canonicalEncode(signed.envelope)))
        return failure(
          'escrow-ceremony-transcript',
          'Local retained share differs from final draft',
        );
    }
  }
  return success(undefined);
}

/** Reserve an irreversible exact final genesis digest before signing it. */
export async function reserveEscrowGenesisConsent(
  localFrozenManifest: GenesisBody,
  digest: string,
  store: EscrowLifecycleStore,
): Promise<Result<void>> {
  const checked = checkedManifest(localFrozenManifest);
  if (!checked.ok) return checked;
  const ceremonyId = deckCeremonyId(checked.value);
  // oxlint-disable no-await-in-loop -- Each durable CAS retry reads the preceding winner.
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const loaded = await loadRegistry(store);
    if (!loaded.ok) return loaded;
    const { bytes, value } = loaded.value;
    if (value.retiredCeremonies.includes(ceremonyId))
      return failure('escrow-ceremony-retired', 'Retired ceremony cannot consent');
    if (value.completedCeremonies.some((item) => item.ceremonyId === ceremonyId))
      return failure('escrow-ceremony-completed', 'Completed ceremony cannot consent');
    const previous = value.consentingCeremonies.find((item) => item.ceremonyId === ceremonyId);
    if (previous)
      return previous.genesisDigest === digest
        ? success(undefined)
        : failure(
            'escrow-ceremony-consent-conflict',
            'Ceremony already consented to another genesis',
          );
    const encoded = encodeRegistry(
      {
        ...value,
        consentingCeremonies: [
          ...value.consentingCeremonies,
          { ceremonyId, genesisDigest: digest },
        ],
      },
      false,
    );
    if (!encoded.ok) return encoded;
    try {
      const won =
        bytes === null
          ? await store.putIfAbsent(REGISTRY_ID, encoded.value)
          : await store.compareAndSwap(REGISTRY_ID, bytes, encoded.value);
      if (won) return success(undefined);
    } catch {
      return failure('escrow-registry-write', 'Could not durably reserve genesis consent');
    }
  }
  // oxlint-enable no-await-in-loop
  return failure('escrow-registry-contention', 'Could not reserve genesis consent');
}

/**
 * Called only after the coordinator validates the signed genesis entry and all
 * deck transcripts. Retained envelopes must appear byte-exactly in genesis.
 */
export async function completeEscrowCeremony(
  localFrozenManifest: GenesisBody,
  certifiedGenesis: GenesisBody,
  digest: string,
  store: EscrowLifecycleStore,
): Promise<Result<void>> {
  const local = checkedManifest(localFrozenManifest);
  if (!local.ok) return local;
  const certified = checkedManifest(certifiedGenesis);
  if (!certified.ok) return certified;
  const ceremonyId = deckCeremonyId(local.value);
  if (deckCeremonyId(certified.value) !== ceremonyId)
    return failure(
      'escrow-manifest-conflict',
      'Certified genesis differs from the frozen ceremony',
    );
  const transcript = validateGenesisEscrow(certified.value);
  if (!transcript.ok) return transcript;
  // oxlint-disable no-await-in-loop -- Each durable CAS retry reads the preceding winner.
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const loaded = await loadRegistry(store);
    if (!loaded.ok) return loaded;
    const { bytes, value } = loaded.value;
    if (value.retiredCeremonies.includes(ceremonyId))
      return failure('escrow-ceremony-retired', 'Retired ceremony cannot complete');
    const completed = value.completedCeremonies.find((item) => item.ceremonyId === ceremonyId);
    if (completed)
      return completed.genesisDigest === digest
        ? success(undefined)
        : failure('escrow-ceremony-conflict', 'Ceremony already completed with another genesis');
    const consented = value.consentingCeremonies.find((item) => item.ceremonyId === ceremonyId);
    if (!consented || consented.genesisDigest !== digest)
      return failure('escrow-ceremony-consent', 'Certified genesis lacks matching local consent');
    const reservations = [...value.reservations];
    for (const [index, reservation] of reservations.entries()) {
      if (reservation.ceremonyId !== ceremonyId) continue;
      if (reservation.status !== 'active')
        return failure('escrow-ceremony-retired', 'A local master has been retired');
      const dealer = transcript.value.find((item) => item.dealerSeat === reservation.dealerSeat);
      if (!dealer || dealer.shares.length !== reservation.envelopes.length)
        return failure('escrow-ceremony-transcript', 'Local retained shares differ from genesis');
      for (let shareIndex = 0; shareIndex < dealer.shares.length; shareIndex += 1) {
        const retained = reservation.envelopes[shareIndex];
        const signed = dealer.shares[shareIndex];
        if (!retained || !signed || retained !== toBase64Url(canonicalEncode(signed.envelope)))
          return failure('escrow-ceremony-transcript', 'Local retained share differs from genesis');
      }
      reservations[index] = { ...reservation, status: 'completed', envelopes: [] };
    }
    const updated: EscrowRegistry = {
      ...value,
      reservations,
      completedCeremonies: [...value.completedCeremonies, { ceremonyId, genesisDigest: digest }],
    };
    const encoded = encodeRegistry(updated, false);
    if (!encoded.ok) return encoded;
    try {
      const won =
        bytes === null
          ? await store.putIfAbsent(REGISTRY_ID, encoded.value)
          : await store.compareAndSwap(REGISTRY_ID, bytes, encoded.value);
      if (won) return success(undefined);
    } catch {
      return failure('escrow-registry-write', 'Could not durably complete the ceremony');
    }
  }
  // oxlint-enable no-await-in-loop
  return failure(
    'escrow-registry-contention',
    'Could not complete the ceremony after concurrent updates',
  );
}

/**
 * Produce dealer envelopes only after unanimous frozen-manifest approval.
 * The retained master is the retry entropy root; callers must keep it until
 * the ceremony is certified or explicitly retired. This API persists before
 * returning any bytes that may be sent to holders. The local manifest must be
 * the locally accepted lobby freeze, including original identities and hosts.
 */
export async function prepareEscrowDistribution(input: {
  readonly genesis: GenesisBody;
  readonly localFrozenManifest: GenesisBody;
  readonly approvals: readonly EscrowManifestApproval[];
  readonly dealerSeat: Seat;
  readonly master: Uint8Array;
  readonly dealerSigningKey: Uint8Array;
  readonly store: EscrowLifecycleStore;
}): Promise<Result<readonly EscrowShareEnvelope[]>> {
  let master: Uint8Array | undefined;
  let signingKey: Uint8Array | undefined;
  let entropy: Uint8Array | undefined;
  try {
    const checked = checkedManifest(input.genesis);
    if (!checked.ok) return checked;
    const localManifest = checkedManifest(input.localFrozenManifest);
    if (!localManifest.ok) return localManifest;
    if (deckCeremonyId(checked.value) !== deckCeremonyId(localManifest.value))
      return failure(
        'escrow-manifest-conflict',
        'Distribution proposal differs from the local frozen manifest',
      );
    const approved = verifyEscrowManifestApprovals(checked.value, input.approvals);
    if (!approved.ok) return approved;
    if (!(input.master instanceof Uint8Array) || input.master.length !== 32)
      return failure('escrow-lifecycle-master', 'Retained master must be 32 bytes');
    master = input.master.slice();
    const masterSecret = scalarFromBytes(master, { nonzero: true });
    const expectedMasterPub = encodePoint(scalePoint(G, masterSecret));
    const manifestMasters = validateGenesisMasters(checked.value);
    if (!manifestMasters.ok) return manifestMasters;
    const manifestMaster = manifestMasters.value.find((entry) => entry.seat === input.dealerSeat);
    if (!manifestMaster || manifestMaster.masterPub !== expectedMasterPub)
      return failure('escrow-master', 'Retained master differs from the frozen genesis manifest');
    if (!(input.dealerSigningKey instanceof Uint8Array) || input.dealerSigningKey.length !== 32)
      return failure('escrow-dealer-key', 'Dealer signing key must be 32 bytes');
    signingKey = input.dealerSigningKey.slice();
    const identity = identityFromSecret(signingKey);
    const dealer = checked.value.seats.find((entry) => entry.seat === input.dealerSeat);
    const dealerMatches = dealer?.publicKey === identity.peerId;
    identity.secretKey.fill(0);
    if (!dealerMatches)
      return failure('escrow-dealer-key', 'Dealer key does not match the frozen manifest');
    const ceremonyId = deckCeremonyId(checked.value);
    entropy = deriveBytes(
      master,
      DERIVATION_LABELS.escrowDistributionEntropy,
      {
        protocol: 'escrow-distribution-retry-entropy-v1',
        ceremonyId,
        dealerSeat: input.dealerSeat,
        masterPub: expectedMasterPub,
        dealerPublicKey: dealer?.publicKey,
      },
      32,
    );
    const generated = createEscrowShareEnvelopes({
      genesis: checked.value,
      dealerSeat: input.dealerSeat,
      expectedMasterPub,
      masterSecret,
      entropy,
      dealerSigningKey: signingKey,
    });
    if (!generated.ok) return generated;
    const generatedBytes = generated.value.map(envelopeBytes);
    const reservation: Reservation = {
      protocol: RESERVATION_PROTOCOL,
      ceremonyId,
      masterPub: expectedMasterPub,
      dealerSeat: input.dealerSeat,
      status: 'active',
      envelopes: generatedBytes.map(toBase64Url),
    };
    return reserveOrRestore(input.store, reservation, generatedBytes, checked.value, 0);
  } catch {
    return failure('escrow-reservation-write', 'Could not persist the escrow distribution');
  } finally {
    master?.fill(0);
    signingKey?.fill(0);
    entropy?.fill(0);
  }
}

async function reserveOrRestore(
  store: EscrowLifecycleStore,
  desired: Reservation,
  generatedBytes: readonly Uint8Array[],
  genesis: GenesisBody,
  attempts: number,
): Promise<Result<readonly EscrowShareEnvelope[]>> {
  if (attempts >= 64)
    return failure(
      'escrow-registry-contention',
      'Could not reserve the escrow master after concurrent updates',
    );
  const loaded = await loadRegistry(store);
  if (!loaded.ok) return loaded;
  const { value: registry, bytes: previousBytes } = loaded.value;
  if (registry.retiredCeremonies.includes(desired.ceremonyId))
    return failure('escrow-ceremony-retired', 'This escrow ceremony has been permanently retired');
  if (registry.completedCeremonies.some(({ ceremonyId }) => ceremonyId === desired.ceremonyId))
    return failure('escrow-ceremony-completed', 'This escrow ceremony has completed');
  if (registry.consentingCeremonies.some(({ ceremonyId }) => ceremonyId === desired.ceremonyId))
    return failure('escrow-ceremony-consenting', 'This escrow ceremony has issued genesis consent');
  const existing = registry.reservations.find(({ masterPub }) => masterPub === desired.masterPub);
  if (existing)
    return validateReservationWinner(
      existing,
      generatedBytes,
      desired.ceremonyId,
      desired.masterPub,
      desired.dealerSeat,
      genesis,
    );
  const updated: EscrowRegistry = {
    ...registry,
    reservations: [...registry.reservations, desired],
  };
  const encoded = encodeRegistry(updated, true);
  if (!encoded.ok) return encoded;
  const replacement = encoded.value;
  try {
    const won =
      previousBytes === null
        ? await store.putIfAbsent(REGISTRY_ID, replacement)
        : await store.compareAndSwap(REGISTRY_ID, previousBytes, replacement);
    if (won) return success(generatedFromBytes(generatedBytes));
    return reserveOrRestore(store, desired, generatedBytes, genesis, attempts + 1);
  } catch {
    return failure('escrow-registry-write', 'Could not durably reserve the dealer master');
  }
}

function generatedFromBytes(bytes: readonly Uint8Array[]): readonly EscrowShareEnvelope[] {
  const decoded: EscrowShareEnvelope[] = [];
  for (const item of bytes) {
    const parsed = parseCanonical(canonicalDecode(item), escrowShareEnvelopeSchema);
    if (!parsed.ok) throw new Error('Generated envelope failed canonical validation');
    decoded.push(parsed.value);
  }
  return decoded;
}

function validateReservationWinner(
  reservation: Reservation,
  generated: readonly Uint8Array[],
  ceremonyId: string,
  masterPub: string,
  dealerSeat: Seat,
  genesis: GenesisBody,
): Result<readonly EscrowShareEnvelope[]> {
  if (
    reservation.status !== 'active' ||
    reservation.ceremonyId !== ceremonyId ||
    reservation.masterPub !== masterPub ||
    reservation.dealerSeat !== dealerSeat
  )
    return failure(
      'escrow-master-reserved',
      'This master is reserved or retired for another ceremony',
    );
  if (reservation.envelopes.length !== generated.length)
    return failure(
      'escrow-reservation-conflict',
      'Retained escrow distribution differs from deterministic retry',
    );
  for (let index = 0; index < generated.length; index += 1) {
    const encoded = reservation.envelopes[index];
    const expected = generated[index];
    if (!encoded || !expected || !equalBytes(fromBase64Url(encoded), expected))
      return failure(
        'escrow-reservation-conflict',
        'Retained escrow distribution differs from deterministic retry',
      );
  }
  const decoded = decodeRetainedEnvelopes(reservation);
  if (!decoded.ok) return decoded;
  for (const envelope of decoded.value) {
    const verified = verifyEscrowShareEphemeralProof(envelope, genesis, dealerSeat, masterPub);
    if (!verified.ok)
      return failure('escrow-reservation-record', 'Retained escrow envelope failed verification');
  }
  return decoded;
}

/**
 * Atomically retire every local dealer master and permanently tombstone a ceremony.
 * Call this on abort and after any authenticated share disclosure, including a
 * valid-DLEQ false complaint that reveals a correctly sealed share. It races
 * safely with preparation: only an already persisted winner can precede the
 * tombstone, and retained masters cannot be used for further dealing. A
 * previously returned envelope may already have been copied for transmission.
 */
export async function retireEscrowCeremony(
  localFrozenManifest: GenesisBody,
  store: EscrowLifecycleStore,
): Promise<Result<void>> {
  const checked = checkedManifest(localFrozenManifest);
  if (!checked.ok) return checked;
  const ceremonyId = deckCeremonyId(checked.value);
  if (store.withCeremonyLock) {
    try {
      return await store.withCeremonyLock(ceremonyId, () =>
        retireEscrowCeremonyWithinLock(checked.value, store),
      );
    } catch {
      return failure('escrow-ceremony-lock', 'Could not lock escrow retirement');
    }
  }
  return retireEscrowCeremonyWithinLock(checked.value, store);
}

/** Use only from a coordinator that already holds the same ceremony lock. */
export async function retireEscrowCeremonyWithinLock(
  localFrozenManifest: GenesisBody,
  store: EscrowLifecycleStore,
): Promise<Result<void>> {
  const checked = checkedManifest(localFrozenManifest);
  if (!checked.ok) return checked;
  const masters = validateGenesisMasters(checked.value);
  if (!masters.ok) return masters;
  return retireCeremonyAttempt(deckCeremonyId(checked.value), masters.value, store, 0);
}

/** Verify authenticated disclosure evidence and durably abort before returning its verdict. */
export async function verifyAndRetireEscrowShareDispute(input: {
  readonly dispute: unknown;
  readonly envelope: unknown;
  readonly genesis: GenesisBody;
  readonly localFrozenManifest: GenesisBody;
  readonly store: EscrowLifecycleStore;
}): Promise<Result<EscrowDisputeVerdict>> {
  const checkedLocal = checkedManifest(input.localFrozenManifest);
  if (!checkedLocal.ok) return checkedLocal;
  const checkedCandidate = checkedManifest(input.genesis);
  if (!checkedCandidate.ok) return checkedCandidate;
  if (deckCeremonyId(checkedCandidate.value) !== deckCeremonyId(checkedLocal.value))
    return failure(
      'escrow-manifest-conflict',
      'Dispute genesis differs from the local frozen manifest',
    );
  const verdict = verifyEscrowShareDispute(input.dispute, input.envelope, checkedCandidate.value);
  if (!verdict.ok) return verdict;
  const retired = await retireEscrowCeremony(checkedLocal.value, input.store);
  if (!retired.ok) return retired;
  return verdict;
}

async function retireCeremonyAttempt(
  ceremonyId: string,
  masters: readonly { readonly seat: Seat; readonly masterPub: string }[],
  store: EscrowLifecycleStore,
  attempts: number,
): Promise<Result<void>> {
  if (attempts >= 64)
    return failure(
      'escrow-registry-contention',
      'Could not retire the ceremony after concurrent updates',
    );
  const loaded = await loadRegistry(store);
  if (!loaded.ok) return loaded;
  const { bytes, value } = loaded.value;
  if (value.completedCeremonies.some((entry) => entry.ceremonyId === ceremonyId))
    return failure('escrow-ceremony-completed', 'Certified escrow ceremony cannot be retired');
  if (value.consentingCeremonies.some((entry) => entry.ceremonyId === ceremonyId))
    return failure(
      'escrow-ceremony-consenting',
      'A signed genesis cannot be revoked by retirement',
    );
  const alreadyRetired = value.retiredCeremonies.includes(ceremonyId);
  const reservations = [...value.reservations];
  for (const master of masters) {
    const index = reservations.findIndex(
      (reservation) => reservation.masterPub === master.masterPub,
    );
    const current = index < 0 ? undefined : reservations[index];
    if (current && current.ceremonyId !== ceremonyId) continue;
    const retired: Reservation = {
      protocol: RESERVATION_PROTOCOL,
      ceremonyId,
      masterPub: master.masterPub,
      dealerSeat: master.seat,
      status: 'retired',
      envelopes: [],
    };
    if (index < 0) reservations.push(retired);
    else if (current?.status === 'active' || current?.envelopes.length)
      reservations[index] = retired;
  }
  const reservationsChanged = reservations.some(
    (reservation, index) => reservation !== value.reservations[index],
  );
  if (alreadyRetired && !reservationsChanged) return success(undefined);
  const updated: EscrowRegistry = {
    ...value,
    reservations,
    retiredCeremonies: alreadyRetired
      ? value.retiredCeremonies
      : [...value.retiredCeremonies, ceremonyId],
  };
  const encoded = encodeRegistry(updated, false);
  if (!encoded.ok) return encoded;
  const replacement = encoded.value;
  try {
    const won =
      bytes === null
        ? await store.putIfAbsent(REGISTRY_ID, replacement)
        : await store.compareAndSwap(REGISTRY_ID, bytes, replacement);
    return won
      ? success(undefined)
      : retireCeremonyAttempt(ceremonyId, masters, store, attempts + 1);
  } catch {
    return failure('escrow-registry-write', 'Could not durably retire the ceremony');
  }
}
