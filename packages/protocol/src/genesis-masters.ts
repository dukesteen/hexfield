import { decodePoint, encodePoint } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { key32Schema, seatSchema } from './schema-values.js';
import { genesisSchema } from './schemas.js';
import type { GenesisBody } from './types.js';
import { parseCanonical } from './validation.js';

export interface MasterCommitment {
  seat: Seat;
  masterPub: string;
}

const bodySchema = v.union([genesisSchema, v.omit(genesisSchema, ['gameId', 'signatures'])]);
const mastersSchema = v.pipe(
  v.array(v.strictObject({ seat: seatSchema, masterPub: key32Schema })),
  v.minLength(2),
  v.maxLength(6),
);

/** Public shape/key checks only. Genesis consent authenticates these commitments. */
export function validateGenesisMasters(value: GenesisBody): Result<readonly MasterCommitment[]> {
  const body = parseCanonical(value, bodySchema);
  if (!body.ok) return body;
  if (body.value.security === 'stub')
    return body.value.commitments.masters === undefined
      ? success([])
      : failure('stub-masters', 'Stub genesis cannot claim master commitments');
  const parsed = parseCanonical(body.value.commitments.masters, mastersSchema);
  if (!parsed.ok) return failure('genesis-masters', 'Every seat needs a master commitment');
  if (
    parsed.value.length !== body.value.seats.length ||
    body.value.seats.length !== body.value.config.seats.length ||
    parsed.value.some(
      (item, index) =>
        item.seat !== index ||
        item.seat !== body.value.seats[index]?.seat ||
        item.seat !== body.value.config.seats[index],
    )
  )
    return failure('genesis-masters', 'Master commitments must match the exact seat order');
  const keys = new Set<string>();
  try {
    for (const { masterPub } of parsed.value) {
      const point = decodePoint(masterPub, { nonIdentity: true });
      if (encodePoint(point) !== masterPub)
        return failure('genesis-masters', 'Master commitment point encoding is not canonical');
      if (keys.has(masterPub))
        return failure('genesis-masters', 'Seats must use independent master secrets');
      keys.add(masterPub);
    }
  } catch {
    return failure('genesis-masters', 'Master commitment is not a nonidentity group point');
  }
  return success(parsed.value);
}
