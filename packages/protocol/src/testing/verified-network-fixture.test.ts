import { scalarToBytes } from '@cp2p/crypto';
import { describe, expect, test, vi } from 'vitest';
import type {
  VerifiedNetworkAuditRequest,
  VerifiedNetworkAuditResult,
} from './verified-network-audit.js';
import { genesisDeckDefinitions } from '../deck-genesis.js';
import { validateGenesisEntry } from '../genesis.js';
import { VirtualClock } from './virtual-clock.js';
import { createVerifiedNetworkFixture } from './verified-network-fixture.js';

describe('verified network fixture', () => {
  test('builds strict four-human 25-card genesis with seat-scoped reusable options', async () => {
    const fixture = createVerifiedNetworkFixture({
      seed: 802,
      gameIndex: 3,
      vpTarget: 3,
      verifyLivePrivateStates: true,
    });
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

      const restoredDriver = restoredSeatZero.createDriver(
        fixture.engine,
        fixture.genesis,
        new VirtualClock(),
        [0],
      );
      restoredDriver.dispose?.();
      expect(fixture.privateStateEvidence()).toMatchObject({
        capturedSequences: 1,
        capturedSnapshots: 1,
        checkedSequences: 0,
        repeatedSnapshots: 1,
      });

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
  test('reserves private comparison before dispatch and retains async failures', async () => {
    const requests: VerifiedNetworkAuditRequest[] = [];
    const rejectors: ((error: Error) => void)[] = [];
    const fixture = createVerifiedNetworkFixture({
      seed: 803,
      verifyLivePrivateStates: true,
      auditExecutor(request) {
        requests.push(request);
        return {
          result: new Promise<VerifiedNetworkAuditResult>((_resolve, reject) =>
            rejectors.push(reject),
          ),
          cancel() {},
        };
      },
    });
    const clock = vi.spyOn(performance, 'now');
    const started = performance.now();
    clock.mockReturnValue(started);
    try {
      const firstRunner = fixture.sessionOptions(0).auditRunner;
      const secondRunner = fixture.sessionOptions(1).auditRunner;
      if (!firstRunner || !secondRunner) throw new Error('Missing audit runner');
      const first = firstRunner({
        genesisEntry: fixture.entry,
        entries: [],
        masters: fixture.mastersForAudit(),
      });
      clock.mockReturnValue(started + 20);
      const second = secondRunner({
        genesisEntry: fixture.entry,
        entries: [],
        masters: fixture.mastersForAudit(),
      });
      clock.mockReturnValue(started + 100);
      expect(fixture.auditTimingEvidence()).toMatchObject([
        {
          seat: 0,
          invocations: 1,
          completedInvocations: 0,
          pendingInvocations: 1,
          runningMilliseconds: 100,
          oldestPendingMilliseconds: 100,
          totalMilliseconds: 0,
          lastMilliseconds: 0,
        },
        {
          seat: 1,
          invocations: 1,
          completedInvocations: 0,
          pendingInvocations: 1,
          runningMilliseconds: 80,
          oldestPendingMilliseconds: 80,
          totalMilliseconds: 0,
          lastMilliseconds: 0,
        },
      ]);
      const starts = fixture.auditTimingEvidence().map((timing) => timing.lastStartedMilliseconds);
      expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBe(20);
      expect(requests[0]?.privateStates).toBeDefined();
      expect(requests[1]?.privateStates).toBeUndefined();
      const failed = Promise.allSettled([first.result, second.result]);
      const waiting = fixture.waitForAudits().catch((error: unknown) => error);
      for (const reject of rejectors) reject(new Error('comparison failed'));
      expect((await failed).every((item) => item.status === 'rejected')).toBe(true);
      expect(fixture.auditTimingEvidence()).toMatchObject([
        {
          seat: 0,
          invocations: 1,
          completedInvocations: 1,
          pendingInvocations: 0,
          runningMilliseconds: 0,
          oldestPendingMilliseconds: 0,
          totalMilliseconds: 100,
          lastMilliseconds: 100,
        },
        {
          seat: 1,
          invocations: 1,
          completedInvocations: 1,
          pendingInvocations: 0,
          runningMilliseconds: 0,
          oldestPendingMilliseconds: 0,
          totalMilliseconds: 80,
          lastMilliseconds: 80,
        },
      ]);
      expect(await waiting).toMatchObject({ message: 'comparison failed' });
      expect(fixture.privateStateEvidence().checkedSequences).toBe(0);
      await expect(fixture.waitForAudits()).rejects.toThrow('comparison failed');
    } finally {
      fixture.dispose();
      clock.mockRestore();
    }
  }, 30_000);
});
