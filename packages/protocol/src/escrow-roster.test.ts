import { identityFromSecret } from '@cp2p/crypto';
import { describe, expect, test } from 'vitest';
import { deriveEscrowRosters } from './escrow-roster.js';
import type { GenesisBody, GenesisSeat } from './types.js';
import { protocolFixture } from './testing/fixtures.js';
import type { Seat } from '@cp2p/engine';

const identities = Array.from({ length: 6 }, (_, index) =>
  identityFromSecret(new Uint8Array(32).fill(index + 20)),
);

function identityAt(index: number) {
  const identity = identities[index];
  if (!identity) throw new Error(`Missing test identity ${index}`);
  return identity;
}

function body(humanCount: number, seatCount = humanCount): GenesisBody {
  const fixture = protocolFixture();
  const allSeats: readonly Seat[] = [0, 1, 2, 3, 4, 5];
  const configuredSeats = allSeats.slice(0, seatCount);
  return {
    ...fixture.body,
    config: { ...fixture.body.config, seats: configuredSeats },
    seats: configuredSeats.map((seat): GenesisSeat => {
      const identity = identities[seat];
      if (!identity) throw new Error('Missing test identity');
      if (seat < humanCount)
        return {
          seat,
          kind: 'human',
          publicKey: identity.peerId,
          name: `Human ${seat}`,
          colour: `#${(seat + 1).toString(16).repeat(6)}`,
        };
      const host = identities[seat % humanCount];
      if (!host) throw new Error('Missing host identity');
      return {
        seat,
        kind: 'bot',
        publicKey: identity.peerId,
        botHost: host.peerId,
        name: `Bot ${seat}`,
        colour: `#${(seat + 1).toString(16).repeat(6)}`,
      };
    }),
  };
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('original-human escrow roster', () => {
  test.each([2, 3])('%i-human games explicitly have no escrow distribution', (humans) => {
    const rosters = value(deriveEscrowRosters(body(humans, 4)));
    expect(rosters).toHaveLength(4);
    expect(rosters.every((roster) => !roster.eligible && roster.threshold === 0)).toBe(true);
    expect(rosters.every((roster) => roster.holders.length === 0)).toBe(true);
  });

  test('four-human dealers require every other original human', () => {
    const rosters = value(deriveEscrowRosters(body(4)));
    expect(rosters.map((roster) => roster.threshold)).toEqual([3, 3, 3, 3]);
    expect(rosters[0]?.holders).toEqual([
      { seat: 1, publicKey: identityAt(1).peerId, index: 2 },
      { seat: 2, publicKey: identityAt(2).peerId, index: 3 },
      { seat: 3, publicKey: identityAt(3).peerId, index: 4 },
    ]);
  });

  test('bot dealers exclude each possible original human host', () => {
    for (let hostSeat = 0; hostSeat < 4; hostSeat++) {
      const genesis = body(4, 5);
      const bot = genesis.seats[4];
      if (bot?.kind !== 'bot') throw new Error('Expected a bot dealer');
      genesis.seats[4] = { ...bot, botHost: identityAt(hostSeat).peerId };
      const roster = value(deriveEscrowRosters(genesis))[4];
      expect(roster?.holders.map((holder) => holder.seat)).toEqual(
        [0, 1, 2, 3].filter((seat) => seat !== hostSeat),
      );
      expect(roster?.threshold).toBe(3);
    }
  });

  test('six humans require all other original human devices', () => {
    expect(value(deriveEscrowRosters(body(6)))[0]?.threshold).toBe(5);
  });

  test.each([
    [
      'duplicate public keys',
      (genesis: GenesisBody) => {
        const first = genesis.seats[0];
        const second = genesis.seats[1];
        if (!first || !second) throw new Error('Expected first two seats');
        genesis.seats[1] = { ...second, publicKey: first.publicKey };
      },
    ],
    [
      'missing configured seat',
      (genesis: GenesisBody) => {
        genesis.config.seats = [0, 1, 2];
      },
    ],
    [
      'reordered seats',
      (genesis: GenesisBody) => {
        const first = genesis.seats[0];
        const second = genesis.seats[1];
        if (!first || !second) throw new Error('Expected first two seats');
        [genesis.seats[0], genesis.seats[1]] = [second, first];
      },
    ],
    [
      'invalid bot host',
      (genesis: GenesisBody) => {
        const bot = genesis.seats[4];
        if (bot?.kind !== 'bot') throw new Error('Expected bot seat');
        genesis.seats[4] = { ...bot, botHost: identityAt(5).peerId };
      },
    ],
  ])('rejects %s before deriving holder rows', (_name, mutate) => {
    const genesis = body(4, 6);
    mutate(genesis);
    expect(deriveEscrowRosters(genesis).ok).toBe(false);
  });
});
