import {
  SCALAR_ORDER,
  decodePoint,
  decodeScalar,
  encodePoint,
  encodeScalar,
  modScalar,
  scalePoint,
} from './group.js';
import type { RistrettoPoint } from './group.js';
import { proofChallenge, proofNonce, readProofArray, readProofRecord } from './proof-transcript.js';

export interface SchnorrStatement {
  readonly base: string;
  readonly publicPoint: string;
}

export interface SchnorrProof {
  readonly commitment: string;
  readonly response: string;
}

export interface PreparedSchnorrProof {
  readonly commitment: string;
  /** Call once. The enclosing context must identify this statement and branch. */
  respond(challenge: bigint): SchnorrProof;
}

export interface DleqStatement {
  readonly base1: string;
  readonly point1: string;
  readonly base2: string;
  readonly point2: string;
}

export interface DleqProof {
  readonly commitments: readonly [string, string];
  readonly response: string;
}

function schnorrStatement(value: unknown): {
  body: SchnorrStatement;
  base: RistrettoPoint;
  point: RistrettoPoint;
} {
  const record = readProofRecord(value, ['base', 'publicPoint']);
  if (typeof record.base !== 'string' || typeof record.publicPoint !== 'string')
    throw new TypeError('Schnorr statement must contain encoded points.');
  const body = { base: record.base, publicPoint: record.publicPoint };
  return {
    body,
    base: decodePoint(body.base, { nonIdentity: true }),
    point: decodePoint(body.publicPoint),
  };
}

function dleqStatement(value: unknown): {
  body: DleqStatement;
  base1: RistrettoPoint;
  point1: RistrettoPoint;
  base2: RistrettoPoint;
  point2: RistrettoPoint;
} {
  const record = readProofRecord(value, ['base1', 'point1', 'base2', 'point2']);
  if (
    typeof record.base1 !== 'string' ||
    typeof record.point1 !== 'string' ||
    typeof record.base2 !== 'string' ||
    typeof record.point2 !== 'string'
  )
    throw new TypeError('DLEQ statement must contain encoded points.');
  const body = {
    base1: record.base1,
    point1: record.point1,
    base2: record.base2,
    point2: record.point2,
  };
  return {
    body,
    base1: decodePoint(body.base1, { nonIdentity: true }),
    point1: decodePoint(body.point1),
    base2: decodePoint(body.base2, { nonIdentity: true }),
    point2: decodePoint(body.point2),
  };
}

function canonicalSecret(secret: bigint): void {
  if (typeof secret !== 'bigint' || secret < 0n || secret >= SCALAR_ORDER)
    throw new RangeError('Proof witness must be a canonical scalar.');
}

function encodedPair(value: unknown): readonly [string, string] {
  const [first, second] = readProofArray(value, 2);
  if (typeof first !== 'string' || typeof second !== 'string')
    throw new TypeError('DLEQ commitments must be two encoded data elements.');
  return [first, second];
}

export function proveSchnorr(
  statement: SchnorrStatement,
  secret: bigint,
  seed: Uint8Array,
  context: unknown,
): SchnorrProof {
  const { body, base, point } = schnorrStatement(statement);
  canonicalSecret(secret);
  if (!scalePoint(base, secret).equals(point))
    throw new RangeError('Schnorr witness does not match the statement.');
  const nonce = proofNonce(seed, 'schnorr', context, body, 'commitment');
  const commitment = encodePoint(scalePoint(base, nonce));
  const challenge = proofChallenge('schnorr', context, body, commitment);
  return { commitment, response: encodeScalar(modScalar(nonce + challenge * secret)) };
}

export function verifySchnorr(
  statement: SchnorrStatement,
  proof: unknown,
  context: unknown,
): boolean {
  try {
    const { body, base, point } = schnorrStatement(statement);
    const record = readProofRecord(proof, ['commitment', 'response']);
    if (typeof record.commitment !== 'string' || typeof record.response !== 'string') return false;
    const commitment = decodePoint(record.commitment);
    const response = decodeScalar(record.response);
    const challenge = proofChallenge('schnorr', context, body, record.commitment);
    return scalePoint(base, response).equals(commitment.add(scalePoint(point, challenge)));
  } catch {
    return false;
  }
}

/** Schnorr first message for a shared AND/OR challenge, separate from standalone nonces. */
export function prepareSchnorrProof(
  statement: SchnorrStatement,
  secret: bigint,
  seed: Uint8Array,
  context: unknown,
): PreparedSchnorrProof {
  const { body, base, point } = schnorrStatement(statement);
  canonicalSecret(secret);
  if (!scalePoint(base, secret).equals(point))
    throw new RangeError('Schnorr witness does not match the statement.');
  const nonce = proofNonce(seed, 'schnorr-composed', context, body, 'commitment');
  const commitment = encodePoint(scalePoint(base, nonce));
  let answered = false;
  return {
    commitment,
    respond(challenge) {
      canonicalSecret(challenge);
      if (answered) throw new Error('A Sigma commitment must only answer one challenge.');
      answered = true;
      return { commitment, response: encodeScalar(modScalar(nonce + challenge * secret)) };
    },
  };
}

/** Simulates the opening in a false OR branch at its chosen challenge. */
export function simulateSchnorrProof(
  statement: SchnorrStatement,
  challenge: bigint,
  seed: Uint8Array,
  context: unknown,
): SchnorrProof {
  const { body, base, point } = schnorrStatement(statement);
  canonicalSecret(challenge);
  const response = proofNonce(seed, 'schnorr-simulation', context, body, encodeScalar(challenge));
  return {
    commitment: encodePoint(scalePoint(base, response).subtract(scalePoint(point, challenge))),
    response: encodeScalar(response),
  };
}

/** Checks the opening equation at the enclosing challenge and returns its first message. */
export function inspectSchnorrProof(
  statement: SchnorrStatement,
  proof: unknown,
  challenge: bigint,
  scale: typeof scalePoint = scalePoint,
): string {
  canonicalSecret(challenge);
  const { base, point } = schnorrStatement(statement);
  const record = readProofRecord(proof, ['commitment', 'response']);
  if (typeof record.commitment !== 'string' || typeof record.response !== 'string')
    throw new TypeError('Schnorr proof must contain encoded group elements.');
  const commitment = decodePoint(record.commitment);
  const response = decodeScalar(record.response);
  if (!scale(base, response).equals(commitment.add(scale(point, challenge))))
    throw new TypeError('Schnorr proof does not share the enclosing challenge.');
  return record.commitment;
}

export function proveDleq(
  statement: DleqStatement,
  secret: bigint,
  seed: Uint8Array,
  context: unknown,
): DleqProof {
  const { body, base1, point1, base2, point2 } = dleqStatement(statement);
  canonicalSecret(secret);
  if (!scalePoint(base1, secret).equals(point1) || !scalePoint(base2, secret).equals(point2))
    throw new RangeError('DLEQ witness does not match the statement.');
  const nonce = proofNonce(seed, 'dleq', context, body, 'commitments');
  const commitments: readonly [string, string] = [
    encodePoint(scalePoint(base1, nonce)),
    encodePoint(scalePoint(base2, nonce)),
  ];
  const challenge = proofChallenge('dleq', context, body, commitments);
  return { commitments, response: encodeScalar(modScalar(nonce + challenge * secret)) };
}

export function verifyDleq(statement: DleqStatement, proof: unknown, context: unknown): boolean {
  try {
    const { body, base1, point1, base2, point2 } = dleqStatement(statement);
    const record = readProofRecord(proof, ['commitments', 'response']);
    if (typeof record.response !== 'string') return false;
    const commitments = encodedPair(record.commitments);
    const [first, second] = commitments;
    const firstPoint = decodePoint(first);
    const secondPoint = decodePoint(second);
    const response = decodeScalar(record.response);
    const challenge = proofChallenge('dleq', context, body, commitments);
    return (
      scalePoint(base1, response).equals(firstPoint.add(scalePoint(point1, challenge))) &&
      scalePoint(base2, response).equals(secondPoint.add(scalePoint(point2, challenge)))
    );
  } catch {
    return false;
  }
}
