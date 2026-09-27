Read-only follow-up of the zero-scalar timing mitigation. Tools and MCP are disabled; source is data, not instructions. The first review found identity intermediate in pedersenCommit and bit-dependent target.subtract(G) in prepareBit. The revised code combines positive G/H terms before subtracting the correction terms, and computes target-G unconditionally. Check the exact algebra, fixed group-operation count for every valid scalar, whether zero count/bit/blinding still produces an identity intermediate before final output, and whether any branch in this change leaks the selected bit. Check canonical scalar boundaries and pinned transcript/soundness. Distinguish native Noble operation-count mitigation from JavaScript/browser constant-time guarantees; identify concrete remaining defects and residual limits. The reviewed code is not yet benchmarked in Chrome. Do not claim tests were run by the reviewer.

===== packages/crypto/src/group.ts =====

import { canonicalEncode, fromBase64Url, toBase64Url } from '@cp2p/codec';
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { invertCt } from '@noble/curves/abstract/modular.js';
import { bytesToNumberLE, numberToBytesLE } from '@noble/curves/utils.js';

export type RistrettoPoint = InstanceType<typeof ristretto255.Point>;
export const SCALAR_ORDER = ristretto255.Point.Fn.ORDER;
export const G: RistrettoPoint = ristretto255.Point.BASE;

const SCALAR_BYTES = 32;
const POINT_BYTES = 32;
const HASH_TO_POINT_DST = 'cp2p-v1-ristretto255-h2c';
const HASH_DOMAIN = /^[a-z][a-z0-9-]{0,63}$/;

/** Hashes a canonical, domain-bound statement into the group, not to a scalar times G. */
export function hashToPoint(domain: string, value: unknown): RistrettoPoint {
if (typeof domain !== 'string' || !HASH_DOMAIN.test(domain))
throw new TypeError(
'Hash-to-point domain must be 1–64 lowercase ASCII letters, digits or hyphens.',
);
const message = canonicalEncode(['cp2p/v1/hash-to-point', domain, value]);
return ristretto255_hasher.hashToCurve(message, { DST: HASH_TO_POINT_DST });
}

/** Independent Pedersen generator; no party knows its discrete log relative to G. */
// H is public and fixed. Its window table accelerates the same secret-safe multiply path.
export const H: RistrettoPoint = hashToPoint('pedersen-h', 'cp2p/pedersen/H').precompute(8, false);

export function modScalar(value: bigint): bigint {
if (typeof value !== 'bigint') throw new TypeError('Scalar must be a bigint.');
const reduced = value % SCALAR_ORDER;
return reduced < 0n ? reduced + SCALAR_ORDER : reduced;
}

/** Canonical 32-byte little-endian scalar; zero is legal unless explicitly forbidden. */
export function scalarFromBytes(bytes: Uint8Array, options: { nonzero?: boolean } = {}): bigint {
if (!(bytes instanceof Uint8Array) || bytes.length !== SCALAR_BYTES)
throw new TypeError('Scalar must be exactly 32 bytes.');
const scalar = bytesToNumberLE(bytes);
if (scalar >= SCALAR_ORDER || (options.nonzero && scalar === 0n))
throw new RangeError('Scalar is noncanonical or forbidden to be zero.');
return scalar;
}

export function scalarToBytes(scalar: bigint): Uint8Array {
if (typeof scalar !== 'bigint' || scalar < 0n || scalar >= SCALAR_ORDER)
throw new RangeError('Scalar must be a canonical field element.');
return numberToBytesLE(scalar, SCALAR_BYTES);
}

export function pointFromBytes(
bytes: Uint8Array,
options: { nonIdentity?: boolean } = {},
): RistrettoPoint {
if (!(bytes instanceof Uint8Array) || bytes.length !== POINT_BYTES)
throw new TypeError('Ristretto point must be exactly 32 bytes.');
const point = ristretto255.Point.fromBytes(bytes);
if (options.nonIdentity && point.is0()) throw new RangeError('Identity point is forbidden.');
return point;
}

export function pointToBytes(point: RistrettoPoint): Uint8Array {
if (!(point instanceof ristretto255.Point)) throw new TypeError('Ristretto point required.');
return point.toBytes();
}

export function encodeScalar(scalar: bigint): string {
return toBase64Url(scalarToBytes(scalar));
}

export function decodeScalar(encoded: string, options: { nonzero?: boolean } = {}): bigint {
if (typeof encoded !== 'string' || encoded.length !== 43)
throw new TypeError('Expected canonical 32-byte base64url encoding.');
return scalarFromBytes(fromBase64Url(encoded), options);
}

export function encodePoint(point: RistrettoPoint): string {
return toBase64Url(pointToBytes(point));
}

export function decodePoint(
encoded: string,
options: { nonIdentity?: boolean } = {},
): RistrettoPoint {
if (typeof encoded !== 'string' || encoded.length !== 43)
throw new TypeError('Expected canonical 32-byte base64url encoding.');
return pointFromBytes(fromBase64Url(encoded), options);
}

/** Inversion rejects zero; Noble's prime-field path avoids secret-dependent Euclidean loops. */
export function invertScalar(scalar: bigint): bigint {
if (typeof scalar !== 'bigint' || scalar <= 0n || scalar >= SCALAR_ORDER)
throw new RangeError('Scalar to invert must be canonical and nonzero.');
return invertCt(scalar, SCALAR_ORDER);
}

/** Secret-safe multiplication for nonzero scalars; handle the legal zero case explicitly. */
export function scalePoint(point: RistrettoPoint, scalar: bigint): RistrettoPoint {
if (!(point instanceof ristretto255.Point)) throw new TypeError('Ristretto point required.');
if (typeof scalar !== 'bigint' || scalar < 0n || scalar >= SCALAR_ORDER)
throw new RangeError('Scalar multiplier must be canonical.');
if (scalar === 0n || point.is0()) return ristretto255.Point.ZERO;
return point.multiply(scalar);
}

/** Two nonzero multiplications whose difference equals scalar times point, including zero. */
export function zeroSafeProductTerms(
point: RistrettoPoint,
scalar: bigint,
): readonly [positive: RistrettoPoint, correction: RistrettoPoint] {
if (!(point instanceof ristretto255.Point)) throw new TypeError('Ristretto point required.');
if (typeof scalar !== 'bigint' || scalar < 0n || scalar >= SCALAR_ORDER)
throw new RangeError('Scalar multiplier must be canonical.');
const half = (scalar >> 1n) + 1n;
const correction = 2n - (scalar & 1n);
return [point.multiply(half).double(), point.multiply(correction)];
}

/** Variable-time multiplication only when scalar and call selection are public. */
export function scalePublicPoint(point: RistrettoPoint, scalar: bigint): RistrettoPoint {
if (!(point instanceof ristretto255.Point)) throw new TypeError('Ristretto point required.');
if (typeof scalar !== 'bigint' || scalar < 0n || scalar >= SCALAR_ORDER)
throw new RangeError('Scalar multiplier must be canonical.');
return point.multiplyUnsafe(scalar);
}

===== packages/crypto/src/range.ts =====

import {
G,
H,
decodePoint,
decodeScalar,
encodePoint,
encodeScalar,
invertScalar,
modScalar,
scalarToBytes,
scalePublicPoint,
scalePoint,
zeroSafeProductTerms,
} from './group.js';
import { proofChallenge, proofNonce, readProofArray, readProofRecord } from './proof-transcript.js';

export interface BitProof {
readonly challenges: readonly [string, string];
readonly responses: readonly [string, string];
}

export interface RangeStatement {
readonly commitment: string;
readonly bits: number;
}

export interface RangeProof {
readonly commitments: readonly string[];
readonly proofs: readonly BitProof[];
}

export type BitAnnouncements = readonly [string, string];
export interface PreparedRangeProof {
readonly commitments: readonly string[];
readonly announcements: readonly BitAnnouncements[];
/** Single-use: answering a different challenge with the same nonce leaks the witness. */
respond(challenge: bigint): RangeProof;
}

const MAX_RANGE_BITS = 16;
const inverseWeights = new Map<number, bigint>();

function inverseLastWeight(bits: number): bigint {
let inverse = inverseWeights.get(bits);
if (inverse === undefined) {
inverse = invertScalar(1n << BigInt(bits - 1));
inverseWeights.set(bits, inverse);
}
return inverse;
}

/** Allows field values, including zero. Counts used in range proofs have narrower bounds. */
export function pedersenCommit(value: bigint, blinding: bigint): string {
scalarToBytes(value);
scalarToBytes(blinding);
const [valuePositive, valueCorrection] = zeroSafeProductTerms(G, value);
const [blindPositive, blindCorrection] = zeroSafeProductTerms(H, blinding);
return encodePoint(
valuePositive.add(blindPositive).subtract(valueCorrection).subtract(blindCorrection),
);
}

function readEncoded(value: unknown): string {
if (typeof value !== 'string' || value.length !== 43)
throw new TypeError('Expected a canonical 32-byte group encoding.');
return value;
}

function readStatement(value: RangeStatement): RangeStatement {
const record = readProofRecord(value, ['commitment', 'bits']);
const bits = record['bits'];
if (typeof bits !== 'number' || !Number.isInteger(bits) || bits < 1 || bits > MAX_RANGE_BITS)
throw new RangeError('Range width must be from 1 through 16 bits.');
const commitment = readEncoded(record['commitment']);
decodePoint(commitment);
return { commitment, bits };
}

function readBitProof(value: unknown): BitProof {
const record = readProofRecord(value, ['challenges', 'responses']);
const challenges = readProofArray(record['challenges'], 2).map(readEncoded);
const responses = readProofArray(record['responses'], 2).map(readEncoded);
const [e0, e1] = challenges;
const [z0, z1] = responses;
if (e0 === undefined || e1 === undefined || z0 === undefined || z1 === undefined)
throw new TypeError('Bit proof requires two challenges and responses.');
return { challenges: [e0, e1], responses: [z0, z1] };
}

/** First messages reconstructed from a CDS bit proof, independent of its enclosing challenge. */
export function inspectBitProof(
commitment: string,
proof: unknown,
scale: typeof scalePoint = scalePoint,
): { challenge: bigint; announcements: BitAnnouncements } {
const parsed = readBitProof(proof);
const target = decodePoint(readEncoded(commitment));
const e0 = decodeScalar(parsed.challenges[0]);
const e1 = decodeScalar(parsed.challenges[1]);
const z0 = decodeScalar(parsed.responses[0]);
const z1 = decodeScalar(parsed.responses[1]);
return {
challenge: modScalar(e0 + e1),
announcements: [
encodePoint(scale(H, z0).subtract(scale(target, e0))),
encodePoint(scale(H, z1).subtract(scale(target.subtract(G), e1))),
],
};
}

interface PreparedBitProof {
readonly announcements: BitAnnouncements;
respond(challenge: bigint): BitProof;
}

function prepareBit(
commitment: string,
bit: 0 | 1,
blinding: bigint,
seed: Uint8Array,
context: unknown,
): PreparedBitProof {
const target = decodePoint(commitment);
if (pedersenCommit(BigInt(bit), blinding) !== commitment)
throw new RangeError('Bit witness does not open its commitment.');
const nonce = proofNonce(seed, 'bit', context, commitment, 'honest-nonce');
const falseChallenge = proofNonce(seed, 'bit', context, commitment, 'simulated-challenge');
const falseResponse = proofNonce(seed, 'bit', context, commitment, 'simulated-response');
const shiftedTarget = target.subtract(G);
const falseTarget = bit === 0 ? shiftedTarget : target;
const honestAnnouncement = encodePoint(scalePoint(H, nonce));
const falseAnnouncement = encodePoint(
scalePoint(H, falseResponse).subtract(scalePoint(falseTarget, falseChallenge)),
);
let answered = false;
return {
announcements:
bit === 0 ? [honestAnnouncement, falseAnnouncement] : [falseAnnouncement, honestAnnouncement],
respond(challenge) {
scalarToBytes(challenge);
if (answered) throw new Error('A Sigma commitment must only answer one challenge.');
answered = true;
const honestChallenge = modScalar(challenge - falseChallenge);
const honestResponse = modScalar(nonce + honestChallenge * blinding);
const e = encodeScalar(honestChallenge);
const z = encodeScalar(honestResponse);
const fakeE = encodeScalar(falseChallenge);
const fakeZ = encodeScalar(falseResponse);
return {
challenges: bit === 0 ? [e, fakeE] : [fakeE, e],
responses: bit === 0 ? [z, fakeZ] : [fakeZ, z],
};
},
};
}

export function proveBit(
commitment: string,
bit: 0 | 1,
blinding: bigint,
seed: Uint8Array,
context: unknown,
): BitProof {
if (bit !== 0 && bit !== 1) throw new RangeError('Bit must be zero or one.');
const prepared = prepareBit(commitment, bit, blinding, seed, { mode: 'standalone-bit', context });
return prepared.respond(proofChallenge('bit', context, commitment, prepared.announcements));
}

export function verifyBit(commitment: string, proof: unknown, context: unknown): boolean {
try {
const inspected = inspectBitProof(commitment, proof);
return (
inspected.challenge === proofChallenge('bit', context, commitment, inspected.announcements)
);
} catch {
return false;
}
}

/**

- Prepares a range as a Sigma protocol for AND/OR composition. Callers must bind
- the whole enclosing statement and branch in context and use one shared challenge.
  */
  export function prepareRangeProof(
  statement: RangeStatement,
  value: bigint,
  blinding: bigint,
  seed: Uint8Array,
  context: unknown,
  ): PreparedRangeProof {
  return prepareRange(statement, value, blinding, seed, { mode: 'composed-range', context });
  }

function prepareRange(
statement: RangeStatement,
value: bigint,
blinding: bigint,
seed: Uint8Array,
context: unknown,
): PreparedRangeProof {
const parsed = readStatement(statement);
if (typeof value !== 'bigint' || value < 0n || value >= 1n << BigInt(parsed.bits))
throw new RangeError('Value is outside the declared range.');
if (pedersenCommit(value, blinding) !== parsed.commitment)
throw new RangeError('Range witness does not open its commitment.');
const commitments: string[] = [];
const blindings: bigint[] = [];
let weightedBlinding = 0n;
for (let index = 0; index < parsed.bits; index += 1) {
const weight = 1n << BigInt(index);
const blind =
index === parsed.bits - 1
? modScalar((blinding - weightedBlinding) * inverseLastWeight(parsed.bits))
: proofNonce(seed, 'range', context, parsed, ['bit-blinding', index]);
weightedBlinding = modScalar(weightedBlinding + weight * blind);
const bit = (value >> BigInt(index)) & 1n;
commitments.push(pedersenCommit(bit, blind));
blindings.push(blind);
}
const prepared = commitments.map((commitment, index) => {
const blind = blindings[index];
if (blind === undefined) throw new Error('Missing bit blinding.');
const bit = ((value >> BigInt(index)) & 1n) === 0n ? 0 : 1;
return prepareBit(commitment, bit, blind, seed, {
mode: 'range-bit',
context,
statement: parsed,
commitments,
index,
});
});
let answered = false;
return {
commitments: [...commitments],
announcements: prepared.map((bit) => bit.announcements),
respond(challenge) {
scalarToBytes(challenge);
if (answered) throw new Error('A Sigma commitment must only answer one challenge.');
answered = true;
return {
commitments: [...commitments],
proofs: prepared.map((bit) => bit.respond(challenge)),
};
},
};
}

/** Simulates a range for a fixed enclosing OR-branch challenge, even for false statements. */
export function simulateRangeProof(
statement: RangeStatement,
challenge: bigint,
seed: Uint8Array,
context: unknown,
): RangeProof {
const parsed = readStatement(statement);
scalarToBytes(challenge);
const commitments: string[] = [];
let weighted = scalePoint(G, 0n);
for (let index = 0; index < parsed.bits; index += 1) {
const weight = 1n << BigInt(index);
const point =
index === parsed.bits - 1
? scalePublicPoint(
decodePoint(parsed.commitment).subtract(weighted),
inverseLastWeight(parsed.bits),
)
: scalePoint(
H,
proofNonce(seed, 'range-simulation', context, parsed, ['commitment', index]),
);
weighted = weighted.add(scalePublicPoint(point, weight));
commitments.push(encodePoint(point));
}
const proofs = commitments.map((_, index): BitProof => {
const role = { index, challenge: encodeScalar(challenge), commitments };
const e0 = proofNonce(seed, 'range-simulation', context, parsed, [role, 'challenge']);
const z0 = proofNonce(seed, 'range-simulation', context, parsed, [role, 'response0']);
const z1 = proofNonce(seed, 'range-simulation', context, parsed, [role, 'response1']);
return {
challenges: [encodeScalar(e0), encodeScalar(modScalar(challenge - e0))],
responses: [encodeScalar(z0), encodeScalar(z1)],
};
});
return { commitments, proofs };
}

/** Validates the range equations and recovers its shared challenge and first messages. */
export function inspectRangeProof(
statement: RangeStatement,
proof: unknown,
scale: typeof scalePoint = scalePoint,
): {
challenge: bigint;
commitments: readonly string[];
announcements: readonly BitAnnouncements[];
} {
const parsed = readStatement(statement);
const record = readProofRecord(proof, ['commitments', 'proofs']);
const commitments = readProofArray(record['commitments'], parsed.bits).map(readEncoded);
const proofs = readProofArray(record['proofs'], parsed.bits);
let weighted = scalePoint(G, 0n);
let challenge: bigint | undefined;
const announcements = commitments.map((commitment, index) => {
weighted = weighted.add(scale(decodePoint(commitment), 1n << BigInt(index)));
const inspected = inspectBitProof(commitment, proofs[index], scale);
if (challenge !== undefined && challenge !== inspected.challenge)
throw new TypeError('Range bit proofs must share one challenge.');
challenge = inspected.challenge;
return inspected.announcements;
});
if (challenge === undefined || !weighted.equals(decodePoint(parsed.commitment)))
throw new TypeError('Range bit commitments do not sum to the statement.');
return { challenge, commitments, announcements };
}

export function proveRange(
statement: RangeStatement,
value: bigint,
blinding: bigint,
seed: Uint8Array,
context: unknown,
): RangeProof {
const parsed = readStatement(statement);
const prepared = prepareRange(parsed, value, blinding, seed, {
mode: 'standalone-range',
context,
});
const challenge = proofChallenge('range', context, parsed, {
commitments: prepared.commitments,
announcements: prepared.announcements,
});
return prepared.respond(challenge);
}

export function verifyRange(statement: RangeStatement, proof: unknown, context: unknown): boolean {
try {
const parsed = readStatement(statement);
const inspected = inspectRangeProof(parsed, proof, scalePublicPoint);
return (
inspected.challenge ===
proofChallenge('range', context, parsed, {
commitments: inspected.commitments,
announcements: inspected.announcements,
})
);
} catch {
return false;
}
}

===== packages/crypto/src/hidden-transfer.ts =====

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
/** Victim's parent commitments, in canonical resource order. _/
readonly commitments: readonly string[];
/_* Public transfer commitments in the same order. _/
readonly transfer: readonly string[];
readonly handSize: number;
readonly index: number;
/_* Hash of the fixed-shape sealed opening delivered to the recipient. */
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

- Bounded verifier: every nested proof has a fixed protocol-owned shape.
- Certified accounting must already ensure small nonnegative committed counts
- and a matching public handSize. This proof preserves that invariant; it does
- not establish it for arbitrary supplied parent commitments.
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

===== packages/crypto/src/group.test.ts =====

import { canonicalEncode, toBase64Url } from '@cp2p/codec';
import { ristretto255_hasher } from '@noble/curves/ed25519.js';
import { expand_message_xmd } from '@noble/curves/abstract/hash-to-curve.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, test } from 'vitest';
import {
G,
H,
SCALAR_ORDER,
decodePoint,
decodeScalar,
encodePoint,
encodeScalar,
hashToPoint,
invertScalar,
modScalar,
pointFromBytes,
pointToBytes,
scalarFromBytes,
scalarToBytes,
scalePublicPoint,
scalePoint,
zeroSafeProductTerms,
} from './group.js';

// RFC 9496 Appendix A.1: identity, generator, and its next two multiples.
const GENERATOR_MULTIPLES = [
'00'.repeat(32),
'e2f2ae0a6abc4e71a884a961c500515f58e30b6aa582dd8db6a65945e08d2d76',
'6a493210f7499cd17fecb510ae0cea23a110e8d5b901f8acadd3095c73a3b919',
'94741f5d5d52755ece4f23f044ee27d5d1ea1e2bd196b462166b16152a9d0259',
] as const;

// RFC 9496 Appendix A.3 inputs are uniform 64-byte strings, not messages
// supplied to RFC 9380 hash_to_ristretto255.
const ELEMENT_DERIVATION_VECTORS = [
{
input:
'5d1be09e3d0c82fc538112490e35701979d99e06ca3e2b5b54bffe8b4dc772c1' +
'4d98b696a1bbfb5ca32c436cc61c16563790306c79eaca7705668b47dffe5bb6',
output: '3066f82a1a747d45120d1740f14358531a8f04bbffe6a819f86dfe50f44a0a46',
},
{
input:
'f116b34b8f17ceb56e8732a60d913dd10cce47a6d53bee9204be8b44f6678b27' +
'0102a56902e2488c46120e9276cfe54638286b9e4b3cdb470b542d46c2068d38',
output: 'f26e5b6f7d362d2d2a94c5d0e7602cb4773c95a2e5c31a64f133189fa76ed61b',
},
] as const;

function deriveToCurve(bytes: Uint8Array) {
if (!ristretto255_hasher.deriveToCurve)
throw new Error('Noble Ristretto element derivation is unavailable.');
return ristretto255_hasher.deriveToCurve(bytes);
}

describe('Ristretto255 group encodings', () => {
test('matches published RFC 9496 generator multiples and accepts identity by default', () => {
expect(pointToBytes(scalePoint(G, 0n))).toEqual(hexToBytes(GENERATOR_MULTIPLES[0]));
for (let multiple = 1; multiple < GENERATOR_MULTIPLES.length; multiple += 1) {
const encoded = hexToBytes(GENERATOR_MULTIPLES[multiple] ?? '');
expect(pointToBytes(scalePoint(G, BigInt(multiple)))).toEqual(encoded);
expect(pointToBytes(pointFromBytes(encoded))).toEqual(encoded);
expect(
decodePoint(encodePoint(pointFromBytes(encoded))).equals(scalePoint(G, BigInt(multiple))),
).toBe(true);
}
expect(pointFromBytes(new Uint8Array(32)).is0()).toBe(true);
expect(() => pointFromBytes(new Uint8Array(32), { nonIdentity: true })).toThrow(/Identity/);
});

test('rejects RFC 9496 invalid encodings and malformed base64url', () => {
const invalid = [
// Appendix A.2: noncanonical field element, negative field element, nonsquare x².
'00' + 'ff'.repeat(31),
'01' + '00'.repeat(31),
'26948d35ca62e643e26a83177332e6b6afeb9d08e4268b650f1f5bbd8d81d371',
];
for (const hex of invalid) expect(() => pointFromBytes(hexToBytes(hex))).toThrow(/./);
expect(() => pointFromBytes(new Uint8Array(31))).toThrow(/32 bytes/);
expect(() => decodePoint(`${encodePoint(G)}=`)).toThrow(/base64url/);
expect(() => decodePoint('A'.repeat(100_000))).toThrow(/base64url/);
expect(() => decodePoint(toBase64Url(new Uint8Array(31)))).toThrow(/32-byte base64url/);
});

test('hash-to-group H is stable, separate from G, and binds domain and canonical value', () => {
expect(H.is0()).toBe(false);
expect(H.equals(G)).toBe(false);
expect(pointToBytes(H)).toEqual(pointToBytes(hashToPoint('pedersen-h', 'cp2p/pedersen/H')));
expect(pointToBytes(H)).toEqual(
hexToBytes('6e91c18c5b6a7567893b7f5c05d68d6096b85a32fbb34c0568ed88877b351869'),
);
expect(hashToPoint('card', { b: 2, a: 1 }).equals(hashToPoint('card', { a: 1, b: 2 }))).toBe(
true,
);
expect(hashToPoint('card', 'x').equals(hashToPoint('deck', 'x'))).toBe(false);
expect(() => hashToPoint('card\0other', 'x')).toThrow(/domain/);
expect(() => hashToPoint('card', { invalid: undefined })).toThrow(/./);
});

test('matches RFC 9496 A.3 element derivation from uniform bytes', () => {
for (const vector of ELEMENT_DERIVATION_VECTORS) {
expect(pointToBytes(deriveToCurve(hexToBytes(vector.input)))).toEqual(
hexToBytes(vector.output),
);
}
});

test('matches RFC 9380 K.3 SHA-512 XMD expansion and the actual H derivation path', () => {
const rfcDst = 'QUUX-V01-CS02-with-expander-SHA512-256';
expect(expand_message_xmd(new Uint8Array(), rfcDst, 32, sha512)).toEqual(
hexToBytes('6b9a7312411d92f921c6f68ca0b6380730a1a4d982c507211a90964c394179ba'),
);
expect(expand_message_xmd(new TextEncoder().encode('abc'), rfcDst, 32, sha512)).toEqual(
hexToBytes('0da749f12fbe5483eb066a5f595055679b976e93abe9be6f0f6318bce7aca8dc'),
);

    // The expected 64 bytes were computed independently with SHA-512's XMD
    // formula over this canonical message and our fixed domain tag.
    const hMessage = canonicalEncode(['cp2p/v1/hash-to-point', 'pedersen-h', 'cp2p/pedersen/H']);
    const uniform = expand_message_xmd(hMessage, 'cp2p-v1-ristretto255-h2c', 64, sha512);
    expect(uniform).toEqual(
      hexToBytes(
        '0a928a2d4088f246b0e7245fbbbf155c065f019da61a4ae0a8cb1550a08d7d99' +
          '74e1def7a38426f5f7e2cff486738dbdc3a2af118f308695ed4baff5c05e5b83',
      ),
    );
    expect(pointToBytes(deriveToCurve(uniform))).toEqual(pointToBytes(H));
    expect(pointToBytes(hashToPoint('pedersen-h', 'cp2p/pedersen/H'))).toEqual(pointToBytes(H));

});
});

describe('Ristretto255 scalar field', () => {
test('reads and writes canonical little-endian values including zero', () => {
expect(scalarFromBytes(new Uint8Array(32))).toBe(0n);
expect(scalarToBytes(0n)).toEqual(new Uint8Array(32));
expect(scalarFromBytes(scalarToBytes(SCALAR_ORDER - 1n))).toBe(SCALAR_ORDER - 1n);
expect(scalarToBytes(258n).subarray(0, 3)).toEqual(Uint8Array.of(2, 1, 0));
expect(decodeScalar(encodeScalar(258n))).toBe(258n);
expect(() => scalarFromBytes(new Uint8Array(32), { nonzero: true })).toThrow(/zero/);
expect(() => decodeScalar(encodeScalar(0n), { nonzero: true })).toThrow(/zero/);
});

test('rejects noncanonical or malformed scalars instead of silently reducing them', () => {
expect(() => scalarFromBytes(scalarToBytes(SCALAR_ORDER - 1n).subarray(0, 31))).toThrow(
/32 bytes/,
);
expect(() => scalarToBytes(SCALAR_ORDER)).toThrow(/canonical/);
expect(() => scalarToBytes(-1n)).toThrow(/canonical/);
expect(() => scalarFromBytes(new Uint8Array(32).fill(0xff))).toThrow(/noncanonical/);
expect(() => decodeScalar(`${encodeScalar(1n)}=`)).toThrow(/base64url/);
expect(() => decodeScalar('A'.repeat(100_000))).toThrow(/base64url/);
});

test('normalizes signed integers and performs secret-safe inversion/multiplication', () => {
expect(modScalar(-1n)).toBe(SCALAR_ORDER - 1n);
expect(modScalar(SCALAR_ORDER + 3n)).toBe(3n);
expect((3n * invertScalar(3n)) % SCALAR_ORDER).toBe(1n);
expect(scalePoint(G, 3n).equals(scalePoint(G, 9n).multiply(invertScalar(3n)))).toBe(true);
expect(scalePoint(H, 0n).is0()).toBe(true);
expect(() => invertScalar(0n)).toThrow(/nonzero/);
expect(() => scalePoint(G, SCALAR_ORDER)).toThrow(/canonical/);
});

test('public proof scalar multiplication matches the secret-safe path', () => {
const variablePoint = G.add(scalePoint(H, 17n));
for (const point of [variablePoint, H, scalePoint(G, 0n)])
for (const scalar of [0n, 1n, 2n, 31n, SCALAR_ORDER - 1n])
expect(scalePublicPoint(point, scalar).equals(scalePoint(point, scalar))).toBe(true);
expect(() => scalePublicPoint(variablePoint, SCALAR_ORDER)).toThrow(/canonical/);
expect(() => scalePublicPoint(variablePoint, -1n)).toThrow(/canonical/);
});

test('zero-safe terms match every scalar boundary', () => {
for (const point of [G, H, G.add(H), scalePoint(G, 0n)])
for (const scalar of [0n, 1n, 2n, 3n, 63n, SCALAR_ORDER - 2n, SCALAR_ORDER - 1n]) {
const [positive, correction] = zeroSafeProductTerms(point, scalar);
expect(positive.subtract(correction).equals(scalePoint(point, scalar))).toBe(true);
}
expect(() => zeroSafeProductTerms(G, SCALAR_ORDER)).toThrow(/canonical/);
});
});

===== packages/crypto/src/hidden-transfer.test.ts =====

import { describe, expect, test } from 'vitest';
import { hashValue, toHex } from '@cp2p/codec';
import { verifyCdsOr } from './cds.js';
import type { CdsOrStatement } from './cds.js';
import { DERIVATION_LABELS, deriveBytes } from './derivation.js';
import {
decodePoint,
decodeScalar,
encodePoint,
encodeScalar,
G,
H,
modScalar,
scalePoint,
} from './group.js';
import { proveHiddenTransfer, verifyHiddenTransfer } from './hidden-transfer.js';
import type { HiddenTransferProof, HiddenTransferStatement } from './hidden-transfer.js';
import {
inspectRangeProof,
pedersenCommit,
prepareRangeProof,
proveBit,
simulateRangeProof,
verifyBit,
} from './range.js';
import {
inspectSchnorrProof,
prepareSchnorrProof,
proveSchnorr,
simulateSchnorrProof,
verifySchnorr,
} from './sigma.js';

const SEED = new Uint8Array(32).fill(41);
const CONTEXT = { genesis: 'a'.repeat(64), parent: 'b'.repeat(64), input: 9 };
const PAYLOAD = 'c'.repeat(64);

function itemAt<T>(values: readonly T[], index: number): T {
const value = values[index];
if (value === undefined) throw new Error('Missing test fixture value.');
return value;
}

function fixture(counts: number[], index: number) {
const blindings = counts.map((_, at) => BigInt(at + 11));
const transferBlindings = counts.map((_, at) => BigInt(at + 31));
const selected = counts.findIndex((count, at) => {
const prefix = counts.slice(0, at).reduce((sum, item) => sum + item, 0);
return index >= prefix && index < prefix + count;
});
const statement: HiddenTransferStatement = {
commitments: counts.map((count, at) => pedersenCommit(BigInt(count), itemAt(blindings, at))),
transfer: counts.map((_, at) =>
pedersenCommit(BigInt(at === selected ? 1 : 0), itemAt(transferBlindings, at)),
),
handSize: counts.reduce((sum, count) => sum + count, 0),
index,
payloadHash: PAYLOAD,
};
return {
statement,
witness: { counts, blindings, transferBlindings },
};
}

function prove(counts: number[], index: number) {
const { statement, witness } = fixture(counts, index);
return { statement, proof: proveHiddenTransfer(statement, witness, SEED, CONTEXT) };
}

describe('hidden card transfer proofs', () => {
test('proves index zero and the last index across zero-valued resource gaps', () => {
for (const index of [0, 8]) {
const { statement, proof } = prove([2, 0, 3, 0, 4], index);
expect(verifyHiddenTransfer(statement, proof, CONTEXT)).toBe(true);
}
});

test('supports prefixes and total hands above 63 with each component six-bit bounded', () => {
const { statement, proof } = prove([40, 30, 20, 1], 90);
expect(statement.handSize).toBeGreaterThan(63);
expect(verifyHiddenTransfer(statement, proof, CONTEXT)).toBe(true);
});

test('supports the maximum eight resource components', () => {
const { statement, proof } = prove([10, 11, 12, 13, 14, 15, 16, 17], 107);
expect(verifyHiddenTransfer(statement, proof, CONTEXT)).toBe(true);
// Recorded before fixed-H precomputation; hashes the exact canonical proof bytes.
expect(toHex(hashValue(proof))).toBe(
'b1e86a98ef84995fee4601548728a63045e165d999447a77fd1fd7b201eb573a',
);
});

test('binds the proof to index, context, payload, parent commitments and transfer points', () => {
const { statement, proof } = prove([2, 1, 3], 2);
expect(verifyHiddenTransfer({ ...statement, index: 1 }, proof, CONTEXT)).toBe(false);
expect(verifyHiddenTransfer(statement, proof, { ...CONTEXT, parent: 'd'.repeat(64) })).toBe(
false,
);
expect(
verifyHiddenTransfer({ ...statement, payloadHash: 'e'.repeat(64) }, proof, CONTEXT),
).toBe(false);
expect(
verifyHiddenTransfer(
{ ...statement, commitments: [pedersenCommit(3n, 11n), ...statement.commitments.slice(1)] },
proof,
CONTEXT,
),
).toBe(false);
expect(
verifyHiddenTransfer(
{ ...statement, transfer: [pedersenCommit(0n, 99n), ...statement.transfer.slice(1)] },
proof,
CONTEXT,
),
).toBe(false);
});

test('rejects zero-hot, two-hot and wrong-type transfer openings', () => {
const { statement, witness } = fixture([2, 1, 3], 2);
const zeroHot = statement.transfer.map((_, at) => pedersenCommit(0n, BigInt(at + 31)));
const twoHot = statement.transfer.map((_, at) =>
pedersenCommit(BigInt(at < 2 ? 1 : 0), BigInt(at + 31)),
);
const wrongTypeWitness = {
...witness,
transferBlindings: witness.transferBlindings.map((_, at) => BigInt(at + 31)),
};
expect(() =>
proveHiddenTransfer({ ...statement, transfer: zeroHot }, witness, SEED, CONTEXT),
).toThrow(RangeError);
expect(() =>
proveHiddenTransfer({ ...statement, transfer: twoHot }, witness, SEED, CONTEXT),
).toThrow(RangeError);
expect(() =>
proveHiddenTransfer(
{
...statement,
transfer: statement.transfer.map((_, at) =>
pedersenCommit(BigInt(at === 0 ? 1 : 0), BigInt(at + 31)),
),
},
wrongTypeWitness,
SEED,
CONTEXT,
),
).toThrow(RangeError);
});

test('rejects a valid one-hot proof for the wrong resource even when its bit and sum proofs pass', () => {
const { statement, proof } = prove([2, 1, 3], 2);
const blindings = [31n, 32n, 33n];
const transfer = statement.transfer.map((_, at) =>
pedersenCommit(BigInt(at === 0 ? 1 : 0), itemAt(blindings, at)),
);
const wrongTypeStatement = { ...statement, transfer };
const bitProofs = transfer.map((commitment, at) =>
proveBit(commitment, at === 0 ? 1 : 0, itemAt(blindings, at), SEED, {
protocol: 'hidden-transfer-v1',
statement: wrongTypeStatement,
context: CONTEXT,
component: `bit-${at}`,
}),
);
const sumBlinding = blindings.reduce((sum, blinding) => modScalar(sum + blinding), 0n);
const sumPoint = transfer
.map((point) => decodePoint(point))
.reduce((sum, point) => sum.add(point), scalePoint(G, 0n))
.subtract(G);
const sumProof = proveSchnorr(
{ base: encodePoint(H), publicPoint: encodePoint(sumPoint) },
sumBlinding,
SEED,
{
protocol: 'hidden-transfer-v1',
statement: wrongTypeStatement,
context: CONTEXT,
component: 'sum',
},
);
for (const [at, commitment] of transfer.entries())
expect(
verifyBit(commitment, itemAt(bitProofs, at), {
protocol: 'hidden-transfer-v1',
statement: wrongTypeStatement,
context: CONTEXT,
component: `bit-${at}`,
}),
).toBe(true);
expect(
verifySchnorr({ base: encodePoint(H), publicPoint: encodePoint(sumPoint) }, sumProof, {
protocol: 'hidden-transfer-v1',
statement: wrongTypeStatement,
context: CONTEXT,
component: 'sum',
}),
).toBe(true);
expect(
verifyHiddenTransfer(
wrongTypeStatement,
{ ...proof, bits: bitProofs, sum: sumProof },
CONTEXT,
),
).toBe(false);
});

test('rejects a mutated shared range/opening challenge in the CDS index branch', () => {
const { statement, proof } = prove([2, 1, 3], 2);
const branches = proof.index.branches.map((branch, at) =>
at === 0
? {
...branch,
challenge: encodeScalar(modScalar(decodeScalar(branch.challenge) + 1n)),
}
: branch,
);
expect(verifyHiddenTransfer(statement, { ...proof, index: { branches } }, CONTEXT)).toBe(false);
});

test('rejects a forged zero-count branch with a true opening and upper range but impossible lower range', () => {
const { statement, witness } = fixture([2, 1, 0, 3], 2);
const zeroCountPrefix = witness.counts.slice(0, 2).reduce((sum, count) => sum + count, 0);
expect(statement.index - zeroCountPrefix).toBe(-1);
expect(zeroCountPrefix + itemAt(witness.counts, 2) - statement.index - 1).toBe(0);
const transfer = statement.transfer.map((_, at) =>
pedersenCommit(BigInt(at === 2 ? 1 : 0), itemAt(witness.transferBlindings, at)),
);
const forgedStatement = { ...statement, transfer };
const branches: CdsOrStatement['branches'][number][] = [];
let prefix = scalePoint(G, 0n);
const lowerIndex = scalePoint(G, BigInt(statement.index));
const upperIndex = scalePoint(G, BigInt(statement.index + 1));
for (let at = 0; at < statement.commitments.length; at += 1) {
const commitment = decodePoint(itemAt(statement.commitments, at));
branches.push({
opening: {
base: encodePoint(H),
publicPoint: encodePoint(decodePoint(itemAt(transfer, at)).subtract(G)),
},
ranges: [
{ commitment: encodePoint(lowerIndex.subtract(prefix)), bits: 6 },
{ commitment: encodePoint(prefix.add(commitment).subtract(upperIndex)), bits: 6 },
],
});
prefix = prefix.add(commitment);
}
const indexStatement: CdsOrStatement = { branches };
const indexContext = {
protocol: 'hidden-transfer-v1',
statement: forgedStatement,
context: CONTEXT,
component: 'index',
};
const compositionSeed = deriveBytes(
SEED,
DERIVATION_LABELS.proofRandomness,
{ domain: 'cds-or-entropy', context: indexContext, statement: indexStatement },
32,
);
const simulatedBranches = branches.map((branch, branchIndex) => {
const challenge = BigInt(branchIndex + 5);
const branchContext = {
context: indexContext,
statement: indexStatement,
branch: branchIndex,
};
if (branchIndex !== 2)
return {
challenge: encodeScalar(challenge),
opening: simulateSchnorrProof(branch.opening, challenge, compositionSeed, {
...branchContext,
component: 'opening',
}),
ranges: branch.ranges.map((range, rangeIndex) =>
simulateRangeProof(range, challenge, compositionSeed, {
...branchContext,
component: 'range',
index: rangeIndex,
}),
),
};

      const opening = prepareSchnorrProof(
        branch.opening,
        itemAt(witness.transferBlindings, branchIndex),
        compositionSeed,
        { ...branchContext, component: 'opening' },
      );
      const prefixBlinding = witness.blindings
        .slice(0, branchIndex)
        .reduce((sum, blinding) => modScalar(sum + blinding), 0n);
      const lowerImpossible = simulateRangeProof(
        itemAt(branch.ranges, 0),
        challenge,
        compositionSeed,
        { ...branchContext, component: 'range', index: 0 },
      );
      const upperTrue = prepareRangeProof(
        itemAt(branch.ranges, 1),
        0n,
        modScalar(prefixBlinding + itemAt(witness.blindings, branchIndex)),
        compositionSeed,
        { ...branchContext, component: 'range', index: 1 },
      );
      return {
        challenge: encodeScalar(challenge),
        opening: opening.respond(challenge),
        ranges: [lowerImpossible, upperTrue.respond(challenge)],
      };
    });
    const attempted = itemAt(simulatedBranches, 2);
    const chosenChallenge = decodeScalar(attempted.challenge);
    expect(
      inspectSchnorrProof(itemAt(branches, 2).opening, attempted.opening, chosenChallenge),
    ).toBeTypeOf('string');
    expect(
      inspectRangeProof(itemAt(itemAt(branches, 2).ranges, 0), itemAt(attempted.ranges, 0))
        .challenge,
    ).toBe(chosenChallenge);
    expect(
      inspectRangeProof(itemAt(itemAt(branches, 2).ranges, 1), itemAt(attempted.ranges, 1))
        .challenge,
    ).toBe(chosenChallenge);
    expect(verifyCdsOr(indexStatement, { branches: simulatedBranches }, indexContext)).toBe(false);
    compositionSeed.fill(0);

});

test('rejects malformed, oversized and noncanonical statement or proof shapes', () => {
const { statement, proof } = prove([2, 1, 3], 2);
const firstTransfer = itemAt(statement.transfer, 0);
const firstBit = itemAt(proof.bits, 0);
expect(verifyHiddenTransfer({ ...statement, commitments: [] }, proof, CONTEXT)).toBe(false);
expect(
verifyHiddenTransfer(
{ ...statement, transfer: [...statement.transfer, firstTransfer] },
proof,
CONTEXT,
),
).toBe(false);
expect(verifyHiddenTransfer({ ...statement, handSize: 7 }, proof, CONTEXT)).toBe(false);
expect(
verifyHiddenTransfer({ ...statement, payloadHash: 'z'.repeat(64) }, proof, CONTEXT),
).toBe(false);
expect(
verifyHiddenTransfer(statement, { ...proof, bits: [...proof.bits, firstBit] }, CONTEXT),
).toBe(false);
expect(verifyHiddenTransfer(statement, { ...proof, unexpected: true }, CONTEXT)).toBe(false);
const malformed = {
...statement,
commitments: [encodePoint(scalePoint(G, 1n)).slice(1), ...statement.commitments.slice(1)],
};
expect(verifyHiddenTransfer(malformed, proof, CONTEXT)).toBe(false);
expect(verifyHiddenTransfer(statement, { ...proof, index: { branches: [] } }, CONTEXT)).toBe(
false,
);
});

test('rejects wrong openings, out-of-range counts and an incorrect hand size before proving', () => {
const { statement, witness } = fixture([2, 1, 3], 2);
expect(() =>
proveHiddenTransfer(statement, { ...witness, counts: [2, 2, 2] }, SEED, CONTEXT),
).toThrow(RangeError);
expect(() =>
proveHiddenTransfer(statement, { ...witness, counts: [-1, 1, 5] }, SEED, CONTEXT),
).toThrow(RangeError);
expect(() =>
proveHiddenTransfer(statement, { ...witness, counts: [64, 0, 2] }, SEED, CONTEXT),
).toThrow(RangeError);
});

test('rejects malformed one-hot sum proof encodings', () => {
const { statement, proof } = prove([1, 1], 0);
const altered = {
...proof,
sum: { ...proof.sum, response: '00'.repeat(32) },
} satisfies HiddenTransferProof;
expect(verifyHiddenTransfer(statement, altered, CONTEXT)).toBe(false);
});
});
