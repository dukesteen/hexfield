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
    throw new RangeError('Scalar must be a canonical field element.');
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
