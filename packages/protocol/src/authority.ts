import { fromBase64Url, toHex } from '@cp2p/codec';
import { parsePeerId } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import type {
  ArtifactSigner,
  CarriedOperation,
  ControllerRecord,
  SeatAuthorities,
} from './authority-types.js';
import { hashSchema, key32Schema, nonnegativeIntegerSchema, seatSchema } from './schema-values.js';
import type { Genesis } from './types.js';
import { parseCanonical } from './validation.js';
import { genesisDigest } from './genesis-identity.js';

const entryRefSchema = v.strictObject({ seq: nonnegativeIntegerSchema, hash: hashSchema });
const controllerSchema = v.strictObject({
  seat: seatSchema,
  publicKey: key32Schema,
  hostSeat: seatSchema,
  kind: v.picklist(['human', 'bot']),
  status: v.picklist(['active', 'pending-recovery']),
  activatedAt: entryRefSchema,
});
const authoritiesSchema = v.strictObject({
  genesisDigest: key32Schema,
  epoch: nonnegativeIntegerSchema,
  controllers: v.pipe(v.array(controllerSchema), v.minLength(1), v.maxLength(6)),
  usedPublicKeys: v.pipe(v.array(key32Schema), v.minLength(1), v.maxLength(4096)),
  carriedOperations: v.pipe(
    v.array(
      v.strictObject({
        kind: v.picklist(['beacon', 'deck', 'count', 'steal']),
        id: hashSchema,
        epoch: nonnegativeIntegerSchema,
        anchor: entryRefSchema,
      }),
    ),
    v.maxLength(4),
  ),
});

/** Only call with a validated genesis; initial generation binds its full signed body. */
export function initialSeatAuthorities(genesis: Genesis): Result<SeatAuthorities> {
  const digest = genesisDigest(genesis);
  const anchor = { seq: 0, hash: toHex(fromBase64Url(digest)) };
  const controllers: ControllerRecord[] = [];
  for (const owner of genesis.seats) {
    const host =
      owner.kind === 'human'
        ? owner
        : genesis.seats.find((candidate) => candidate.publicKey === owner.botHost);
    if (!host || host.kind !== 'human')
      return failure('authority-host', 'Each initial controller needs an original human host');
    controllers.push({
      seat: owner.seat,
      publicKey: owner.publicKey,
      hostSeat: host.seat,
      kind: owner.kind,
      status: 'active',
      activatedAt: { ...anchor },
    });
  }
  return validateSeatAuthorities(
    {
      genesisDigest: digest,
      epoch: 0,
      controllers,
      usedPublicKeys: controllers.map(({ publicKey }) => publicKey),
      carriedOperations: [],
    },
    digest,
    0,
    genesis.seats.map(({ seat }) => seat),
  );
}

/** Structural integrity only. Replay establishes the provenance of every transition. */
export function validateSeatAuthorities(
  value: unknown,
  digest: string,
  epoch: number,
  seats: readonly Seat[],
): Result<SeatAuthorities> {
  const parsed = parseCanonical(value, authoritiesSchema);
  if (!parsed.ok) return parsed;
  const authority = parsed.value;
  if (
    authority.genesisDigest !== digest ||
    authority.epoch !== epoch ||
    authority.controllers.length !== seats.length ||
    authority.controllers.some((controller, index) => controller.seat !== seats[index]) ||
    new Set(authority.controllers.map(({ publicKey }) => publicKey)).size !== seats.length ||
    new Set(authority.usedPublicKeys).size !== authority.usedPublicKeys.length ||
    new Set(authority.carriedOperations.map(({ kind }) => kind)).size !==
      authority.carriedOperations.length ||
    authority.carriedOperations.some((operation) => operation.epoch >= authority.epoch)
  )
    return failure('authority-context', 'Controller state differs from its certified context');
  try {
    for (const key of authority.usedPublicKeys) parsePeerId(key);
    for (const controller of authority.controllers) {
      const host = authority.controllers.find(({ seat }) => seat === controller.hostSeat);
      if (
        !authority.usedPublicKeys.includes(controller.publicKey) ||
        !host ||
        host.kind !== 'human' ||
        host.status !== 'active' ||
        (controller.kind === 'human' &&
          (controller.hostSeat !== controller.seat || controller.status !== 'active'))
      )
        return failure('authority-host', 'Controller host or key reservation is inconsistent');
    }
  } catch {
    return failure('authority-key', 'Controller history contains an invalid signing key');
  }
  return success(authority);
}

/** A pending recovery freezes all ordinary signatures until certified activation. */
export function artifactSigner(authority: SeatAuthorities, seat: Seat): Result<ArtifactSigner> {
  const controller = authority.controllers.find((item) => item.seat === seat);
  if (!controller) return failure('authority-seat', 'Seat has no certified controller');
  if (controller.status !== 'active')
    return failure('authority-pending', 'Seat is waiting for certified recovery activation');
  return success({
    seat,
    publicKey: controller.publicKey,
    generation: { ...controller.activatedAt },
  });
}

/** Legacy direct helpers may omit authority only at the original genesis epoch. */
export function resolveArtifactSigner(
  authority: SeatAuthorities | undefined,
  genesis: Genesis,
  epoch: number,
  seat: Seat,
): Result<ArtifactSigner> {
  if (authority === undefined) {
    if (epoch !== 0)
      return failure('authority-required', 'Current certified controller state is required');
    const initial = initialSeatAuthorities(genesis);
    return initial.ok ? artifactSigner(initial.value, seat) : initial;
  }
  const checked = validateSeatAuthorities(
    authority,
    genesisDigest(genesis),
    epoch,
    genesis.seats.map((owner) => owner.seat),
  );
  return checked.ok ? artifactSigner(checked.value, seat) : checked;
}

/** Membership may carry an old operation only with its exact certified identity. */
export function permitsFrozenOperation(
  authority: SeatAuthorities | undefined,
  kind: CarriedOperation['kind'],
  id: string,
  operation: Pick<CarriedOperation, 'epoch' | 'anchor'>,
  currentEpoch: number,
): boolean {
  if (operation.epoch === currentEpoch) return true;
  return (
    operation.epoch < currentEpoch &&
    authority?.epoch === currentEpoch &&
    authority.carriedOperations.some(
      (carried) =>
        carried.kind === kind &&
        carried.id === id &&
        carried.epoch === operation.epoch &&
        carried.anchor.seq === operation.anchor.seq &&
        carried.anchor.hash === operation.anchor.hash,
    )
  );
}
