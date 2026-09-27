import { parsePeerId } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { genesisSchema } from './schemas.js';
import type { GenesisBody, GenesisSeat } from './types.js';
import { parseCanonical } from './validation.js';

export interface EscrowHolder {
  /** Original genesis seat; its one-based seat index is the Feldman x-coordinate. */
  readonly seat: Seat;
  readonly publicKey: string;
  readonly index: number;
}

export interface EscrowDealerRoster {
  readonly dealer: {
    readonly seat: Seat;
    readonly kind: GenesisSeat['kind'];
    readonly publicKey: string;
  };
  /** Two- and three-human games explicitly have no escrow holders. */
  readonly eligible: boolean;
  readonly threshold: number;
  readonly holders: readonly EscrowHolder[];
}

/** Derive holder sets only from the immutable original genesis roster. */
export function deriveEscrowRosters(value: unknown): Result<readonly EscrowDealerRoster[]> {
  const parsed = parseCanonical(
    value,
    v.union([genesisSchema, v.omit(genesisSchema, ['gameId', 'signatures'])]),
  );
  if (!parsed.ok) return failure('escrow-roster-genesis', 'Genesis roster is malformed');
  const genesis: GenesisBody = {
    protocolVersion: parsed.value.protocolVersion,
    engineVersion: parsed.value.engineVersion,
    config: parsed.value.config,
    seats: parsed.value.seats,
    genesisSeed: parsed.value.genesisSeed,
    ceremonyNonce: parsed.value.ceremonyNonce,
    security: parsed.value.security,
    takeover: parsed.value.takeover,
    commitments: parsed.value.commitments,
    createdAt: parsed.value.createdAt,
  };
  const humans = genesis.seats.filter((seat) => seat.kind === 'human');
  if (
    genesis.seats.length !== genesis.config.seats.length ||
    genesis.seats.some(
      (seat, index) => seat.seat !== index || genesis.config.seats[index] !== index,
    )
  )
    return failure('escrow-roster-seats', 'Genesis seats must exactly match configured seat order');
  if (new Set(genesis.seats.map((seat) => seat.publicKey)).size !== genesis.seats.length)
    return failure('escrow-roster-keys', 'Genesis seat public keys must be unique');

  const humanByKey = new Map<string, Seat>();
  try {
    for (const seat of genesis.seats) {
      parsePeerId(seat.publicKey);
      if (seat.kind === 'human') humanByKey.set(seat.publicKey, seat.seat);
    }
  } catch {
    return failure('escrow-roster-keys', 'Genesis seat identity is invalid');
  }
  for (const seat of genesis.seats) {
    if (seat.kind === 'bot' && !humanByKey.has(seat.botHost))
      return failure('escrow-roster-host', 'Every bot host must be an original human identity');
  }

  const eligible = humans.length >= 4;
  return success(
    genesis.seats.map((dealer) => {
      if (!eligible) {
        return {
          dealer: { seat: dealer.seat, kind: dealer.kind, publicKey: dealer.publicKey },
          eligible: false,
          threshold: 0,
          holders: [],
        };
      }
      const excluded = dealer.kind === 'human' ? dealer.seat : humanByKey.get(dealer.botHost);
      const holders = humans
        .filter((human) => human.seat !== excluded)
        .map((human) => ({ seat: human.seat, publicKey: human.publicKey, index: human.seat + 1 }));
      return {
        dealer: { seat: dealer.seat, kind: dealer.kind, publicKey: dealer.publicKey },
        eligible: true,
        threshold: holders.length,
        holders,
      };
    }),
  );
}
