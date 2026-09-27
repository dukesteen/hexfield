import type { Result } from '@cp2p/engine';
import * as v from 'valibot';
import { recoveryChangeSchema } from './recovery-membership.js';
import { seatPresenceChangeSchema } from './recovery-presence.js';
import type { SeatPresenceChange } from './recovery-presence.js';
import type { RecoveryChange } from './recovery-types.js';
import { transferChangeSchema } from './transfer-readiness.js';
import type { SeatTransferChange } from './transfer-types.js';
import { parseCanonical } from './validation.js';

export const membershipChangeSchema = v.union([
  recoveryChangeSchema,
  transferChangeSchema,
  seatPresenceChangeSchema,
]);
export type MembershipChange = RecoveryChange | SeatTransferChange | SeatPresenceChange;

/** Strict admission shared by certified replay and local candidate construction. */
export function parseMembershipChange(value: unknown): Result<MembershipChange> {
  return parseCanonical(value, membershipChangeSchema);
}
