import { scalarToBytes } from '@cp2p/crypto';
import { describe, expect, test } from 'vitest';
import { genesisDeckDefinitions } from '../deck-genesis.js';
import { validateGenesisEntry } from '../genesis.js';
import { VirtualClock } from './virtual-clock.js';
import { createVerifiedNetworkFixture } from './verified-network-fixture.js';

describe('verified network fixture', () => {
  test('builds strict four-human 25-card genesis with seat-scoped reusable options', async () => {
    const fixture = createVerifiedNetworkFixture({ seed: 802, gameIndex: 3, vpTarget: 3 });
    try {
      expect(fixture.genesis.security).toBe('verified');
      expect(fixture.genesis.seats).toHaveLength(4);
      expect(fixture.genesis.seats.every((seat) => seat.kind === 'human')).toBe(true);
      expect(fixture.genesis.commitments.beaconChains).toMatchObject([
        { seat: 0, length: 128 },
        { seat: 1, length: 128 },
        { seat: 2, length: 128 },
        { seat: 3, length: 128 },
      ]);
      expect(fixture.genesis.commitments.escrow).toHaveLength(4);
      expect(validateGenesisEntry(fixture.entry, fixture.engine, fixture.policy.genesis).ok).toBe(
        true,
      );
      const deck = genesisDeckDefinitions(fixture.genesis);
      expect(deck.ok).toBe(true);
      if (!deck.ok) return;
      expect(deck.value.find((item) => item.deckId === 'dev')?.cards).toHaveLength(25);

      const seatZero = fixture.sessionOptions(0);
      const restoredSeatZero = fixture.sessionOptions(0);
      const seatOne = fixture.sessionOptions(1);
      expect(seatZero.beaconContributions).toBe(restoredSeatZero.beaconContributions);
      expect(seatZero.deckContributions).toBe(restoredSeatZero.deckContributions);
      expect(seatZero.masterReveal?.store).toBe(restoredSeatZero.masterReveal?.store);
      expect(seatZero.beaconContributions).not.toBe(seatOne.beaconContributions);
      expect(seatZero.masterReveal?.store).not.toBe(seatOne.masterReveal?.store);
      expect('secretKey' in seatZero).toBe(false);

      const ownMaster = await seatZero.masterReveal?.loadOwnedMaster(0);
      const foreignMaster = await seatZero.masterReveal?.loadOwnedMaster(1);
      expect(ownMaster).toEqual(scalarToBytes(17n));
      expect(foreignMaster).toBeNull();
      ownMaster?.fill(0);

      expect(() => seatZero.createDeckSource?.('dev', 1)).toThrow(/does not own/);
      expect(() =>
        seatZero.createDriver(fixture.engine, fixture.genesis, new VirtualClock(), [0, 1]),
      ).toThrow(/may own only its human seat/);
      const driver = seatZero.createDriver(
        fixture.engine,
        fixture.genesis,
        new VirtualClock(),
        [0],
      );
      try {
        expect(driver.privateState(0)?.seat).toBe(0);
        expect(driver.privateState(1)).toBeNull();
      } finally {
        driver.dispose?.();
      }

      const masterCopies = fixture.mastersForAudit();
      expect(masterCopies.map(({ seat }) => seat)).toEqual([0, 1, 2, 3]);
      expect(masterCopies[0]?.master).toEqual(scalarToBytes(17n));
      for (const { master } of masterCopies) master.fill(0);

      const beacon = seatZero.beaconSource;
      expect(beacon?.link(0, 1)).toHaveLength(32);
      expect(beacon?.extension(1)).toMatchObject({ length: 128 });
      expect(beacon?.extension(1).tip).toHaveLength(32);
    } finally {
      fixture.dispose();
    }
  }, 30_000);
});
