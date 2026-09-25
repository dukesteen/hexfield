import { fromBase64Url, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { parsePeerId, signObject, verifyObject } from '@cp2p/crypto';
import { ENGINE_VERSION, failure, success } from '@cp2p/engine';
import type { Engine, GameState, Result } from '@cp2p/engine';
import { genesisSchema, logEntrySchema } from './schemas.js';
import { PROTOCOL_VERSION } from './types.js';
import type { EntryBody, Genesis, GenesisBody, LogEntry, SeatSignature } from './types.js';
import { parseCanonical } from './validation.js';

export const GENESIS_PREVIOUS_HASH = '0'.repeat(64);

export interface GenesisPolicy {
  /** Only a simulation/dev entry point may enable the stage-06 random driver. */
  allowStub?: boolean;
  verifyCommitments?: (genesis: Genesis) => Result<void>;
}

export interface ValidatedGenesis {
  genesis: Genesis;
  state: GameState;
}

/** Explicit fields prevent gameId or signatures becoming part of their own hash. */
export function genesisBody(genesis: GenesisBody): GenesisBody {
  return {
    protocolVersion: genesis.protocolVersion,
    engineVersion: genesis.engineVersion,
    config: genesis.config,
    seats: genesis.seats,
    genesisSeed: genesis.genesisSeed,
    ceremonyNonce: genesis.ceremonyNonce,
    security: genesis.security,
    commitments: genesis.commitments,
    createdAt: genesis.createdAt,
  };
}

export function genesisId(body: GenesisBody): string {
  return genesisDigest(body).slice(0, 22);
}

/** The full digest binds protocol signatures; gameId is only its routing alias. */
export function genesisDigest(body: GenesisBody): string {
  return toBase64Url(hashValue({ domain: 'cp2p/v1/genesis-body', body: genesisBody(body) }));
}

/** Every human signs the same draft, including its derived identifier. */
export function signGenesis(
  body: GenesisBody,
  seat: SeatSignature['seat'],
  secretKey: Uint8Array,
): SeatSignature {
  return {
    seat,
    sig: signObject('genesis', { genesisDigest: genesisDigest(body) }, secretKey),
  };
}

export function validateGenesis(
  value: unknown,
  engine: Engine,
  policy: GenesisPolicy = {},
): Result<ValidatedGenesis> {
  const parsed = parseCanonical(value, genesisSchema);
  if (!parsed.ok) return parsed;
  const genesis = parsed.value;
  if (genesis.protocolVersion !== PROTOCOL_VERSION || genesis.engineVersion !== ENGINE_VERSION)
    return failure('version-mismatch', 'The protocol or engine version differs');
  if (genesis.gameId !== genesisId(genesis))
    return failure('genesis-id', 'The game identifier does not match genesis');
  if (
    genesis.seats.length !== genesis.config.seats.length ||
    genesis.seats.some(
      (seat, index) => seat.seat !== index || genesis.config.seats[index] !== index,
    )
  )
    return failure('genesis-seats', 'Genesis and engine seats must match in seat order');
  const humans = genesis.seats.filter((seat) => seat.kind === 'human');
  if (humans.length === 0)
    return failure('genesis-voters', 'An online game needs at least one human voter');
  if (
    new Set(genesis.seats.map((seat) => seat.publicKey)).size !== genesis.seats.length ||
    new Set(genesis.seats.map((seat) => seat.colour)).size !== genesis.seats.length
  )
    return failure('genesis-duplicates', 'Seat keys and colours must be unique');
  try {
    for (const seat of genesis.seats) {
      parsePeerId(seat.publicKey);
      if (seat.kind === 'bot' && !humans.some((human) => human.publicKey === seat.botHost))
        return failure('genesis-bot-host', 'Every bot host must be a human in this game');
    }
  } catch {
    return failure('genesis-key', 'Genesis contains an invalid identity key');
  }
  if (genesis.signatures.length !== humans.length)
    return failure('genesis-signatures', 'Every human must sign genesis exactly once');
  const signedBody = { genesisDigest: genesisDigest(genesis) };
  for (const [index, human] of humans.entries()) {
    const signature = genesis.signatures[index];
    if (
      signature?.seat !== human.seat ||
      !verifyObject('genesis', signedBody, signature.sig, parsePeerId(human.publicKey))
    )
      return failure('genesis-signatures', 'Genesis signatures are invalid or out of seat order');
  }
  if (genesis.security === 'stub') {
    if (!policy.allowStub)
      return failure('stub-forbidden', 'Stub randomness is only available in explicit simulations');
    if (Object.keys(genesis.commitments).length !== 0)
      return failure('stub-commitments', 'Stub genesis must not claim cryptographic commitments');
  } else {
    if (!policy.verifyCommitments)
      return failure(
        'commitments-unavailable',
        'Cryptographic genesis verification is unavailable',
      );
    try {
      const verified = policy.verifyCommitments(genesis);
      if (!verified.ok) return verified;
    } catch {
      return failure('commitments-invalid', 'Cryptographic genesis verification failed');
    }
  }
  try {
    const state = engine.createGame(genesis.config, fromBase64Url(genesis.genesisSeed));
    const violations = engine.checkInvariants(state);
    if (violations.length !== 0)
      return failure('genesis-state', 'Genesis violates engine invariants', { violations });
    return success({ genesis, state });
  } catch {
    return failure('genesis-config', 'Genesis configuration is not supported by the engine');
  }
}

export function entryBody(entry: EntryBody): EntryBody {
  return {
    seq: entry.seq,
    term: entry.term,
    prevHash: entry.prevHash,
    payload: entry.payload,
    stateHash: entry.stateHash,
    sequencer: entry.sequencer,
  };
}

export function entryHash(entry: EntryBody): string {
  // Certificates and proposer changes must not change the value being agreed on.
  // Genesis signatures can have multiple valid encodings from malicious signers.
  return toHex(
    hashValue({
      seq: entry.seq,
      prevHash: entry.prevHash,
      payload:
        entry.payload.kind === 'genesis'
          ? { kind: 'genesis', genesisDigest: genesisDigest(entry.payload.genesis) }
          : entry.payload,
      stateHash: entry.stateHash,
    }),
  );
}

export function signEntry(body: EntryBody, secretKey: Uint8Array): LogEntry {
  return { ...entryBody(body), sig: signObject('entry', entryBody(body), secretKey) };
}

export function validateGenesisEntry(
  value: unknown,
  engine: Engine,
  policy: GenesisPolicy = {},
): Result<ValidatedGenesis & { entry: LogEntry; hash: string }> {
  const parsed = parseCanonical(value, logEntrySchema);
  if (!parsed.ok) return parsed;
  const entry = parsed.value;
  if (
    entry.seq !== 0 ||
    entry.term !== 1 ||
    entry.prevHash !== GENESIS_PREVIOUS_HASH ||
    entry.payload.kind !== 'genesis'
  )
    return failure('genesis-entry', 'The first entry must be genesis at sequence zero, term one');
  const validated = validateGenesis(entry.payload.genesis, engine, policy);
  if (!validated.ok) return validated;
  const firstHuman = validated.value.genesis.seats.find((seat) => seat.kind === 'human');
  if (
    !firstHuman ||
    entry.sequencer !== firstHuman.publicKey ||
    !verifyObject('entry', entryBody(entry), entry.sig, parsePeerId(firstHuman.publicKey))
  )
    return failure('sequencer-signature', 'Genesis must be signed by the initial sequencer');
  if (entry.stateHash !== toHex(hashValue(validated.value.state)))
    return failure('state-hash', 'Genesis state hash does not match');
  return success({ ...validated.value, entry, hash: entryHash(entry) });
}
