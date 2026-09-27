import { hashValue, toHex } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import * as v from 'valibot';
import { deckCeremonyId } from './deck-genesis.js';
import { validateGenesisMasters } from './genesis-masters.js';
import { validateGenesisSeedTranscript } from './genesis-seed.js';
import type { GenesisSeedTranscript } from './genesis-seed.js';
import { verifyGameSeatBindings } from './online-bindings.js';
import type { VerifiedGameSeatBindings } from './online-bindings.js';
import type { GenesisBody } from './types.js';
import { parseCanonical } from './validation.js';

export const ONLINE_START_PROTOCOL = 'online-start-v1';

const onlineStartSchema = v.strictObject({
  protocol: v.literal(ONLINE_START_PROTOCOL),
  agreement: v.unknown(),
  bindings: v.unknown(),
  seed: v.unknown(),
});

export interface VerifiedOnlineStart {
  readonly bindings: VerifiedGameSeatBindings;
  readonly seed: GenesisSeedTranscript;
}

function sameValue(left: unknown, right: unknown): boolean {
  return toHex(hashValue(left)) === toHex(hashValue(right));
}

/** Mandatory verified-genesis evidence; callback policy cannot substitute for it. */
export function validateGenesisOnlineStart(body: GenesisBody): Result<VerifiedOnlineStart> {
  if (body.security !== 'verified')
    return failure('online-start-security', 'Only verified genesis carries online start');
  const parsed = parseCanonical(body.commitments.onlineStart, onlineStartSchema);
  if (!parsed.ok)
    return failure('online-start', 'Verified genesis needs a strict online-start transcript');
  const bindings = verifyGameSeatBindings(parsed.value.agreement, parsed.value.bindings);
  if (!bindings.ok) return bindings;
  const { agreement, genesisSeats } = bindings.value;
  if (
    !sameValue(agreement.state.config, body.config) ||
    !sameValue(agreement.state.takeover, body.takeover) ||
    !sameValue(genesisSeats, body.seats) ||
    agreement.state.ceremonyNonce !== body.ceremonyNonce
  )
    return failure('online-start-roster', 'Genesis differs from the device-approved freeze');
  const masters = validateGenesisMasters(body);
  if (!masters.ok) return masters;
  if (!sameValue(bindings.value.masters, masters.value))
    return failure('online-start-masters', 'Master commitments differ from seat bindings');
  const seed = validateGenesisSeedTranscript(
    {
      freezeHash: bindings.value.freezeHash,
      ceremonyNonce: body.ceremonyNonce,
      ceremonyId: deckCeremonyId(body),
      participants: body.seats.map(({ seat, publicKey }) => ({ seat, publicKey })),
      mode: agreement.state.seedMode,
    },
    parsed.value.seed,
  );
  if (!seed.ok) return seed;
  if (seed.value.genesisSeed !== body.genesisSeed)
    return failure('online-start-seed', 'Genesis board seed differs from the frozen transcript');
  return success({ bindings: bindings.value, seed: seed.value.transcript });
}
