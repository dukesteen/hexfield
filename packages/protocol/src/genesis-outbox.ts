import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import * as v from 'valibot';
import { deckCeremonyId } from './deck-genesis.js';
import { genesisDigest, signVerifiedGenesis } from './genesis.js';
import { genesisSchema } from './schemas.js';
import { key32Schema, seatSchema, signature64Schema } from './schema-values.js';
import type { SignedDeckPass } from './deck-setup.js';
import type { GenesisBody, SeatSignature } from './types.js';
import { MAX_MESSAGE_BYTES, parseCanonical } from './validation.js';

const consentSchema = v.strictObject({
  genesisDigest: key32Schema,
  signature: v.strictObject({ seat: seatSchema, sig: signature64Schema }),
});

export interface GenesisConsentStore {
  /** Read the durable reservation, including after process or page restart. */
  load(id: string): Promise<Uint8Array | null>;
  /**
   * Atomic, write-once reservation. Resolve true only after the transaction is
   * durably committed (for IndexedDB, on transaction complete, not request
   * success). A false result means another immutable record won and must be
   * returned by load. If a write's outcome is unknown, retry must observe the
   * same retained bytes or fail closed; never replace an existing reservation.
   */
  putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean>;
}

/** Process-local fixture store; production consent needs a durable implementation. */
export class MemoryGenesisConsentStore implements GenesisConsentStore {
  readonly #records = new Map<string, Uint8Array>();

  async load(id: string): Promise<Uint8Array | null> {
    return this.#records.get(id)?.slice() ?? null;
  }

  async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    if (this.#records.has(id)) return false;
    this.#records.set(id, bytes.slice());
    return true;
  }
}

/** Reserve one final genesis digest per ceremony and seat before returning consent. */
export async function prepareGenesisConsent(
  body: GenesisBody,
  transcripts: readonly { deckId: string; passes: readonly SignedDeckPass[] }[],
  seat: SeatSignature['seat'],
  key: Uint8Array,
  store: GenesisConsentStore,
): Promise<Result<SeatSignature>> {
  const checkedBody = parseCanonical(body, v.omit(genesisSchema, ['gameId', 'signatures']));
  if (!checkedBody.ok) return checkedBody;
  let signingKey: Uint8Array;
  try {
    if (!(key instanceof Uint8Array) || key.length !== 32)
      return failure('genesis-outbox-key', 'Genesis consent key must be 32 bytes');
    signingKey = key.slice();
  } catch {
    return failure('genesis-outbox-key', 'Could not copy the genesis consent key');
  }
  try {
    const signed = signVerifiedGenesis(checkedBody.value, transcripts, seat, signingKey);
    if (!signed.ok) return signed;
    const digest = genesisDigest(checkedBody.value);
    const id = `genesis-consent/${deckCeremonyId(checkedBody.value)}/${seat}`;
    const stored = (bytes: Uint8Array): Result<SeatSignature> => {
      try {
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_MESSAGE_BYTES)
          return failure('genesis-outbox-record', 'Stored genesis consent is corrupt');
        const parsed = parseCanonical(canonicalDecode(bytes), consentSchema);
        if (!parsed.ok)
          return failure('genesis-outbox-record', 'Stored genesis consent is corrupt');
        if (
          parsed.value.genesisDigest !== digest ||
          parsed.value.signature.seat !== seat ||
          parsed.value.signature.sig !== signed.value.sig
        )
          return failure(
            'genesis-outbox-conflict',
            'This ceremony already consented to another genesis',
          );
        return success(parsed.value.signature);
      } catch {
        return failure('genesis-outbox-record', 'Stored genesis consent is corrupt');
      }
    };
    let previous: Uint8Array | null;
    try {
      previous = await store.load(id);
    } catch {
      return failure('genesis-outbox-read', 'Could not read prior genesis consent');
    }
    if (previous !== null) return stored(previous);
    try {
      const bytes = canonicalEncode({ genesisDigest: digest, signature: signed.value });
      if (await store.putIfAbsent(id, bytes)) return success(signed.value);
      const winner = await store.load(id);
      return winner
        ? stored(winner)
        : failure('genesis-outbox-record', 'Winning genesis consent record is missing');
    } catch {
      return failure('genesis-outbox-write', 'Could not persist genesis consent');
    }
  } finally {
    signingKey.fill(0);
  }
}
