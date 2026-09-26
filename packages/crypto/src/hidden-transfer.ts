import { proveCdsOr, verifyCdsOr } from './cds.js';
import type { CdsOrProof, CdsOrStatement } from './cds.js';
import { DERIVATION_LABELS, deriveBytes } from './derivation.js';
import { G, H, decodePoint, encodePoint, modScalar, scalarToBytes, scalePoint } from './group.js';
import type { RistrettoPoint } from './group.js';
import { readProofArray, readProofRecord } from './proof-transcript.js';
import { pedersenCommit, proveBit, verifyBit } from './range.js';
import type { BitProof } from './range.js';
import { proveSchnorr, verifySchnorr } from './sigma.js';
import type { SchnorrProof } from './sigma.js';

const MAX_TYPES = 8;
const RANGE_BITS = 6;
const HASH = /^[0-9a-f]{64}$/;
const PROTOCOL = 'hidden-transfer-v1';

export interface HiddenTransferStatement {
  /** Victim's parent commitments, in canonical resource order. */
  readonly commitments: readonly string[];
  /** Public transfer commitments in the same order. */
  readonly transfer: readonly string[];
  readonly handSize: number;
  readonly index: number;
  /** Hash of the fixed-shape sealed opening delivered to the recipient. */
  readonly payloadHash: string;
}

export interface HiddenTransferWitness {
  readonly counts: readonly number[];
  readonly blindings: readonly bigint[];
  readonly transferBlindings: readonly bigint[];
}

export interface HiddenTransferProof {
  readonly bits: readonly BitProof[];
  readonly sum: SchnorrProof;
  readonly index: CdsOrProof;
}

interface ParsedStatement {
  body: HiddenTransferStatement;
  commitments: readonly RistrettoPoint[];
  transfer: readonly RistrettoPoint[];
}

function boundedVector(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TYPES)
    throw new RangeError('Hidden transfer needs one through eight resource types.');
  return readProofArray(value, value.length);
}

function canonicalPoint(value: unknown): { encoded: string; point: RistrettoPoint } {
  if (typeof value !== 'string') throw new TypeError('Hidden transfer point must be encoded.');
  const point = decodePoint(value);
  if (encodePoint(point) !== value)
    throw new TypeError('Hidden transfer point must have canonical encoding.');
  return { encoded: value, point };
}

function readStatement(value: HiddenTransferStatement): ParsedStatement {
  const record = readProofRecord(value, [
    'commitments',
    'transfer',
    'handSize',
    'index',
    'payloadHash',
  ]);
  const commitments = boundedVector(record.commitments).map(canonicalPoint);
  const transfer = boundedVector(record.transfer).map(canonicalPoint);
  const handSize = record.handSize;
  const index = record.index;
  const payloadHash = record.payloadHash;
  if (
    transfer.length !== commitments.length ||
    typeof handSize !== 'number' ||
    !Number.isSafeInteger(handSize) ||
    handSize < 1 ||
    handSize > commitments.length * 63 ||
    typeof index !== 'number' ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= handSize ||
    typeof payloadHash !== 'string' ||
    !HASH.test(payloadHash)
  )
    throw new RangeError('Hidden transfer statement has invalid size, index or payload hash.');
  return {
    body: {
      commitments: commitments.map((item) => item.encoded),
      transfer: transfer.map((item) => item.encoded),
      handSize,
      index,
      payloadHash,
    },
    commitments: commitments.map((item) => item.point),
    transfer: transfer.map((item) => item.point),
  };
}

function readWitness(value: HiddenTransferWitness, length: number): HiddenTransferWitness {
  const record = readProofRecord(value, ['counts', 'blindings', 'transferBlindings']);
  const counts = readProofArray(record.counts, length).map((count) => {
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 63)
      throw new RangeError('Hidden transfer count is outside the six-bit range.');
    return count;
  });
  const readScalars = (input: unknown): bigint[] =>
    readProofArray(input, length).map((scalar) => {
      if (typeof scalar !== 'bigint') throw new TypeError('Hidden transfer scalar must be bigint.');
      scalarToBytes(scalar);
      return scalar;
    });
  return {
    counts,
    blindings: readScalars(record.blindings),
    transferBlindings: readScalars(record.transferBlindings),
  };
}

function sumPoints(points: readonly RistrettoPoint[]): RistrettoPoint {
  return points.reduce((sum, point) => sum.add(point), scalePoint(G, 0n));
}

function indexStatement(parsed: ParsedStatement): CdsOrStatement {
  const branches: CdsOrStatement['branches'][number][] = [];
  let prefix = scalePoint(G, 0n);
  const lowerIndex = scalePoint(G, BigInt(parsed.body.index));
  const upperIndex = scalePoint(G, BigInt(parsed.body.index + 1));
  for (let at = 0; at < parsed.commitments.length; at += 1) {
    const commitment = parsed.commitments[at];
    const transfer = parsed.transfer[at];
    if (!commitment || !transfer) throw new Error('Hidden transfer vector is incomplete.');
    branches.push({
      opening: { base: encodePoint(H), publicPoint: encodePoint(transfer.subtract(G)) },
      ranges: [
        { commitment: encodePoint(lowerIndex.subtract(prefix)), bits: RANGE_BITS },
        {
          commitment: encodePoint(prefix.add(commitment).subtract(upperIndex)),
          bits: RANGE_BITS,
        },
      ],
    });
    prefix = prefix.add(commitment);
  }
  return { branches };
}

function proofContext(statement: HiddenTransferStatement, context: unknown, component: string) {
  return { protocol: PROTOCOL, statement, context, component };
}

function componentSeed(
  seed: Uint8Array,
  statement: HiddenTransferStatement,
  context: unknown,
  component: string,
): Uint8Array {
  return deriveBytes(
    seed,
    DERIVATION_LABELS.proofRandomness,
    proofContext(statement, context, component),
    32,
  );
}

/** Proves a one-hot transfer of the card at the fixed beacon index. */
export function proveHiddenTransfer(
  statement: HiddenTransferStatement,
  witness: HiddenTransferWitness,
  seed: Uint8Array,
  context: unknown,
): HiddenTransferProof {
  const parsed = readStatement(statement);
  const opening = readWitness(witness, parsed.commitments.length);
  const counts = opening.counts;
  const blindings = opening.blindings;
  const transferBlindings = opening.transferBlindings;
  if (counts.reduce((total, count) => total + count, 0) !== parsed.body.handSize)
    throw new RangeError('Hidden transfer counts do not sum to the public hand size.');
  let prefix = 0;
  let selected = -1;
  let selectedPrefix = 0;
  let selectedPrefixBlinding = 0n;
  let runningBlinding = 0n;
  for (let at = 0; at < counts.length; at += 1) {
    const count = counts[at];
    const blinding = blindings[at];
    if (count === undefined || blinding === undefined)
      throw new Error('Hidden transfer witness is incomplete.');
    if (pedersenCommit(BigInt(count), blinding) !== parsed.body.commitments[at])
      throw new RangeError('Hidden transfer hand opening differs from its commitment.');
    if (parsed.body.index >= prefix && parsed.body.index < prefix + count) {
      selected = at;
      selectedPrefix = prefix;
      selectedPrefixBlinding = runningBlinding;
    }
    prefix += count;
    runningBlinding = modScalar(runningBlinding + blinding);
  }
  if (selected < 0) throw new RangeError('Beacon index is outside the opened hand.');
  const bits: BitProof[] = [];
  let transferBlindSum = 0n;
  for (let at = 0; at < counts.length; at += 1) {
    const transferBlinding = transferBlindings[at];
    if (transferBlinding === undefined) throw new Error('Hidden transfer witness is incomplete.');
    const bit = at === selected ? 1 : 0;
    if (pedersenCommit(BigInt(bit), transferBlinding) !== parsed.body.transfer[at])
      throw new RangeError('Hidden transfer is not one-hot at the selected index.');
    const entropy = componentSeed(seed, parsed.body, context, `bit-${at}`);
    try {
      bits.push(
        proveBit(
          parsed.body.transfer[at] ?? '',
          bit,
          transferBlinding,
          entropy,
          proofContext(parsed.body, context, `bit-${at}`),
        ),
      );
    } finally {
      entropy.fill(0);
    }
    transferBlindSum = modScalar(transferBlindSum + transferBlinding);
  }
  const sum = sumPoints(parsed.transfer).subtract(G);
  const sumEntropy = componentSeed(seed, parsed.body, context, 'sum');
  let sumProof: SchnorrProof;
  try {
    sumProof = proveSchnorr(
      { base: encodePoint(H), publicPoint: encodePoint(sum) },
      transferBlindSum,
      sumEntropy,
      proofContext(parsed.body, context, 'sum'),
    );
  } finally {
    sumEntropy.fill(0);
  }
  const selectedCount = counts[selected];
  const selectedBlinding = blindings[selected];
  const selectedTransferBlinding = transferBlindings[selected];
  if (
    selectedCount === undefined ||
    selectedBlinding === undefined ||
    selectedTransferBlinding === undefined
  )
    throw new Error('Selected hidden transfer witness is incomplete.');
  const lower = parsed.body.index - selectedPrefix;
  const upper = selectedPrefix + selectedCount - 1 - parsed.body.index;
  const indexEntropy = componentSeed(seed, parsed.body, context, 'index');
  let indexProof: CdsOrProof;
  try {
    indexProof = proveCdsOr(
      indexStatement(parsed),
      selected,
      {
        secret: selectedTransferBlinding,
        ranges: [
          { value: BigInt(lower), blinding: modScalar(-selectedPrefixBlinding) },
          {
            value: BigInt(upper),
            blinding: modScalar(selectedPrefixBlinding + selectedBlinding),
          },
        ],
      },
      indexEntropy,
      proofContext(parsed.body, context, 'index'),
    );
  } finally {
    indexEntropy.fill(0);
  }
  return { bits, sum: sumProof, index: indexProof };
}

/**
 * Bounded verifier: every nested proof has a fixed protocol-owned shape.
 * Certified accounting must already ensure small nonnegative committed counts
 * and a matching public handSize. This proof preserves that invariant; it does
 * not establish it for arbitrary supplied parent commitments.
 */
export function verifyHiddenTransfer(
  statement: HiddenTransferStatement,
  proof: unknown,
  context: unknown,
): boolean {
  try {
    const parsed = readStatement(statement);
    const record = readProofRecord(proof, ['bits', 'sum', 'index']);
    const bits = readProofArray(record.bits, parsed.body.transfer.length);
    for (let at = 0; at < bits.length; at += 1)
      if (
        !verifyBit(
          parsed.body.transfer[at] ?? '',
          bits[at],
          proofContext(parsed.body, context, `bit-${at}`),
        )
      )
        return false;
    return (
      verifySchnorr(
        { base: encodePoint(H), publicPoint: encodePoint(sumPoints(parsed.transfer).subtract(G)) },
        record.sum,
        proofContext(parsed.body, context, 'sum'),
      ) &&
      verifyCdsOr(indexStatement(parsed), record.index, proofContext(parsed.body, context, 'index'))
    );
  } catch {
    return false;
  }
}
