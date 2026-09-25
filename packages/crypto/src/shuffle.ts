import { canonicalEncode, fromBase64Url, sha256, toBase64Url } from '@cp2p/codec';
import { DERIVATION_LABELS, deriveBytes } from './derivation.js';
import {
  G,
  SCALAR_ORDER,
  decodePoint,
  decodeScalar,
  encodePoint,
  encodeScalar,
  invertScalar,
  modScalar,
  scalePoint,
  type RistrettoPoint,
} from './group.js';
import { proofNonce, readProofArray, readProofRecord } from './proof-transcript.js';
import { uniformInt } from './uniform.js';

const ROUNDS = 64;
const CHALLENGE_BYTES = ROUNDS / 8;
const MAX_CARDS = 128;
const MAX_CONTEXT_BYTES = 16_384;

export interface ShuffleStatement {
  input: readonly string[];
  output: readonly string[];
  publicKey: string;
}

export interface ShuffleResponse {
  scalar: string;
  /** old index → new index, so (πX)[π(i)] = X[i]. */
  permutation: readonly number[];
}

export interface ShuffleProof {
  /** Exactly eight bytes, MSB-first across the 64 rounds. */
  challenge: string;
  responses: readonly ShuffleResponse[];
}

type RoundCommitment = readonly [string, readonly string[]];

interface ParsedStatement {
  wire: ShuffleStatement;
  input: RistrettoPoint[];
  output: RistrettoPoint[];
  publicKey: RistrettoPoint;
}

function parsePoints(value: unknown, length: number): { wire: string[]; points: RistrettoPoint[] } {
  const items = readProofArray(value, length);
  const wire: string[] = [];
  const points: RistrettoPoint[] = [];
  for (const item of items) {
    if (typeof item !== 'string') throw new TypeError('Deck points must be encoded strings.');
    wire.push(item);
    points.push(decodePoint(item, { nonIdentity: true }));
  }
  if (new Set(wire).size !== length) throw new RangeError('Deck points must be distinct.');
  return { wire, points };
}

function parseStatement(value: unknown): ParsedStatement {
  const record = readProofRecord(value, ['input', 'output', 'publicKey']);
  const inputLength: unknown = Array.isArray(record.input) ? record.input.length : null;
  if (
    typeof inputLength !== 'number' ||
    !Number.isSafeInteger(inputLength) ||
    inputLength < 1 ||
    inputLength > MAX_CARDS
  )
    throw new RangeError('Shuffle deck size is out of bounds.');
  const input = parsePoints(record.input, inputLength);
  const output = parsePoints(record.output, inputLength);
  if (typeof record.publicKey !== 'string') throw new TypeError('Shuffle key must be encoded.');
  const publicKey = decodePoint(record.publicKey, { nonIdentity: true });
  return {
    wire: { input: input.wire, output: output.wire, publicKey: record.publicKey },
    input: input.points,
    output: output.points,
    publicKey,
  };
}

function checkContext(context: unknown): void {
  if (canonicalEncode(context).length > MAX_CONTEXT_BYTES)
    throw new RangeError('Shuffle context exceeds its byte limit.');
}

function parsePermutation(value: unknown, length: number): number[] {
  const items = readProofArray(value, length);
  const permutation = items.map((item) => {
    if (!Number.isSafeInteger(item) || Number(item) < 0 || Number(item) >= length)
      throw new RangeError('Shuffle permutation index is invalid.');
    return Number(item);
  });
  if (new Set(permutation).size !== length)
    throw new RangeError('Shuffle permutation must be a bijection.');
  return permutation;
}

/** `permutation[oldIndex]` is the new index occupied by that old element. */
function permute<T>(items: readonly T[], permutation: readonly number[]): T[] {
  const result = items.slice();
  for (let oldIndex = 0; oldIndex < items.length; oldIndex += 1) {
    const item = items[oldIndex];
    if (item === undefined) throw new TypeError('Shuffle input contains a missing element.');
    result[permutation[oldIndex] ?? -1] = item;
  }
  return result;
}

function challengeFor(
  context: unknown,
  statement: ShuffleStatement,
  rounds: readonly RoundCommitment[],
): Uint8Array {
  return sha256(canonicalEncode(['cp2p/v1/shuffle', context, statement, rounds])).slice(
    0,
    CHALLENGE_BYTES,
  );
}

function challengeBit(challenge: Uint8Array, round: number): boolean {
  return ((challenge[Math.floor(round / 8)] ?? 0) & (0x80 >> (round % 8))) !== 0;
}

function roundPermutation(
  seed: Uint8Array,
  context: unknown,
  statement: ShuffleStatement,
  round: number,
  length: number,
): number[] {
  const roundSeed = deriveBytes(
    seed,
    DERIVATION_LABELS.deckPermutation,
    { domain: 'cp2p/v1/shuffle-rho', context, statement, round },
    32,
  );
  const permutation = Array.from({ length }, (_, index) => index);
  try {
    for (let end = length - 1; end > 0; end -= 1) {
      const swap = uniformInt(roundSeed, 'shuffle-rho-step', end + 1, { round, end });
      const atEnd = permutation[end];
      const atSwap = permutation[swap];
      if (atEnd === undefined || atSwap === undefined)
        throw new TypeError('Shuffle permutation index missing.');
      permutation[end] = atSwap;
      permutation[swap] = atEnd;
    }
  } finally {
    roundSeed.fill(0);
  }
  return permutation;
}

/** Proves output = π(secret·input) without transmitting the 64 round commitments. */
export function proveShuffle(
  statement: ShuffleStatement,
  secret: bigint,
  permutation: readonly number[],
  seed: Uint8Array,
  context: unknown,
): ShuffleProof {
  if (typeof secret !== 'bigint' || secret <= 0n || secret >= SCALAR_ORDER)
    throw new RangeError('Shuffle secret must be a canonical nonzero scalar.');
  if (!(seed instanceof Uint8Array) || seed.length !== 32)
    throw new TypeError('Shuffle proof seed must be exactly 32 bytes.');
  checkContext(context);
  const parsed = parseStatement(statement);
  const pi = parsePermutation(permutation, parsed.input.length);
  if (!scalePoint(G, secret).equals(parsed.publicKey))
    throw new RangeError('Shuffle secret does not open the public key.');
  const expected = permute(
    parsed.input.map((point) => scalePoint(point, secret)),
    pi,
  );
  if (
    expected.some((point, index) => {
      const output = parsed.output[index];
      return !output || !point.equals(output);
    })
  )
    throw new RangeError('Shuffle output does not match the witness.');

  const witnesses: { r: bigint; rho: number[] }[] = [];
  const commitments: RoundCommitment[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const r = proofNonce(seed, 'shuffle', context, parsed.wire, { role: 'scalar', round });
    const rho = roundPermutation(seed, context, parsed.wire, round, parsed.input.length);
    witnesses.push({ r, rho });
    commitments.push([
      encodePoint(scalePoint(G, r)),
      permute(
        parsed.input.map((point) => encodePoint(scalePoint(point, r))),
        rho,
      ),
    ]);
  }
  const challenge = challengeFor(context, parsed.wire, commitments);
  const responses = witnesses.map(({ r, rho }, round): ShuffleResponse => {
    if (!challengeBit(challenge, round)) return { scalar: encodeScalar(r), permutation: rho };
    const tau = rho.slice();
    for (let oldIndex = 0; oldIndex < rho.length; oldIndex += 1) {
      const from = rho[oldIndex];
      const to = pi[oldIndex];
      if (from === undefined || to === undefined)
        throw new TypeError('Shuffle permutation index missing.');
      tau[from] = to;
    }
    return {
      scalar: encodeScalar(modScalar(secret * invertScalar(r))),
      permutation: tau,
    };
  });
  return { challenge: toBase64Url(challenge), responses };
}

/** Parses every response before group work; malformed proofs fail closed. */
export function verifyShuffle(
  statement: ShuffleStatement,
  proof: unknown,
  context: unknown,
): boolean {
  try {
    checkContext(context);
    const parsed = parseStatement(statement);
    const record = readProofRecord(proof, ['challenge', 'responses']);
    if (typeof record.challenge !== 'string') return false;
    const challenge = fromBase64Url(record.challenge);
    if (challenge.length !== CHALLENGE_BYTES) return false;
    const rawResponses = readProofArray(record.responses, ROUNDS);
    const responses = rawResponses.map((item) => {
      const response = readProofRecord(item, ['scalar', 'permutation']);
      if (typeof response.scalar !== 'string') throw new TypeError('Shuffle scalar missing.');
      return {
        scalar: decodeScalar(response.scalar, { nonzero: true }),
        permutation: parsePermutation(response.permutation, parsed.input.length),
      };
    });

    const commitments: RoundCommitment[] = responses.map((response, round) => {
      if (!challengeBit(challenge, round)) {
        return [
          encodePoint(scalePoint(G, response.scalar)),
          permute(
            parsed.input.map((point) => encodePoint(scalePoint(point, response.scalar))),
            response.permutation,
          ),
        ];
      }
      const inverse = invertScalar(response.scalar);
      return [
        encodePoint(scalePoint(parsed.publicKey, inverse)),
        response.permutation.map((outIndex) => {
          const output = parsed.output[outIndex];
          if (!output) throw new TypeError('Shuffle output index missing.');
          return encodePoint(scalePoint(output, inverse));
        }),
      ];
    });
    const expected = challengeFor(context, parsed.wire, commitments);
    return expected.every((byte, index) => byte === challenge[index]);
  } catch {
    return false;
  }
}
