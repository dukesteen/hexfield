import { toBase64Url } from '@cp2p/codec';
import { scalarFromBytes } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Engine, Result, Seat } from '@cp2p/engine';
import { createBeaconSecretSource } from './beacon-source.js';
import type { BeaconSecretProvider } from './beacon-source.js';
import { deckCeremonyId } from './deck-genesis.js';
import { createDeckSecretSource } from './deck-source.js';
import { genesisDigest } from './genesis.js';
import { verifyRevealedMaster } from './genesis-secrets.js';
import { createHandSecretSource } from './hand-source.js';
import type { ProposalContext } from './proposal.js';
import { initialProposalContext, replayCertifiedPrefix } from './replay.js';
import type { ReplayPolicy } from './replay.js';
import { createStealSecretSource } from './steal-source.js';
import { VerifiedSessionDriver } from './verified-session-driver.js';

export interface ReconstructedPrivateSeats {
  readonly context: ProposalContext;
  /** Contains only requested seats and checks their public openings after every entry. */
  readonly driver: VerifiedSessionDriver;
  /** Relinquish one owned seat without discarding other reconstructed seats. */
  releaseSeat(seat: Seat): void;
  /** Disposes the driver and clears its retained master copies. */
  dispose(): void;
}

/**
 * Reconstruct already-owned or authorized-revealed seats from certified history.
 * This does not request secrets, authorize disclosure, activate controllers or
 * constitute a complete game audit. The caller must establish the right to use
 * every supplied master before invoking it. Deck setup must be fully certified.
 * No partially rebuilt hand is returned.
 */
export function reconstructPrivateSeats(input: {
  readonly genesisEntry: unknown;
  readonly entries: readonly unknown[];
  readonly engine: Engine;
  readonly policy: ReplayPolicy;
  readonly secrets: readonly { readonly seat: Seat; readonly master: Uint8Array }[];
}): Result<ReconstructedPrivateSeats> {
  const masters = new Map<Seat, Uint8Array>();
  const beacons = new Map<Seat, { length: number; provider: BeaconSecretProvider }>();
  let driver: VerifiedSessionDriver | undefined;
  let retained = false;
  const releaseSeat = (seat: Seat) => {
    driver?.relinquishSeats([seat]);
    const master = masters.get(seat);
    master?.fill(0);
    masters.delete(seat);
    const beacon = beacons.get(seat);
    beacon?.provider.dispose();
    beacons.delete(seat);
  };
  const dispose = () => {
    for (const seat of masters.keys()) releaseSeat(seat);
    driver?.dispose();
  };
  try {
    if (!Array.isArray(input.secrets) || input.secrets.length < 1 || input.secrets.length > 6)
      return failure('private-replay-seats', 'Supply one through six distinct owned seat secrets');
    for (const { seat, master } of input.secrets) {
      if (
        !Number.isSafeInteger(seat) ||
        seat < 0 ||
        seat > 5 ||
        masters.has(seat) ||
        !(master instanceof Uint8Array) ||
        master.length !== 32
      )
        return failure('private-replay-secrets', 'Seat secrets are malformed or duplicated');
      const copy = new Uint8Array(master);
      masters.set(seat, copy);
      scalarFromBytes(copy, { nonzero: true });
    }

    // Authenticate the whole supplied branch before reporting any secret mismatch.
    // A corrupt imported certificate must not be attributed to a departed owner.
    const publicReplay = replayCertifiedPrefix(
      input.genesisEntry,
      input.entries,
      input.engine,
      input.policy,
    );
    if (!publicReplay.ok)
      return failure('private-replay-history', 'Certified history could not be verified', {
        reason: publicReplay.error.code,
      });
    const { genesis, crypto } = publicReplay.value.context.log;
    if (genesis.security !== 'verified' || !crypto)
      return failure('private-replay-security', 'Private reconstruction requires verified history');
    for (const [seat, master] of masters) {
      const verified = verifyRevealedMaster(genesis, crypto.decks, seat, master);
      if (!verified.ok) return verified;
    }
    const initial = initialProposalContext(input.genesisEntry, input.engine, input.policy);
    if (!initial.ok) return initial;
    const initialBeacon = initial.value.log.crypto?.beacon;
    if (!initialBeacon)
      return failure('private-replay-beacon', 'Verified genesis has no beacon state');
    const ceremonyId = deckCeremonyId(genesis);
    for (const chain of initialBeacon.chains) {
      const master = masters.get(chain.seat);
      if (master)
        beacons.set(chain.seat, {
          length: chain.length,
          provider: createBeaconSecretSource(
            master,
            { ceremonyId, seat: chain.seat },
            chain.length,
          ),
        });
    }
    const getMaster = (seat: Seat): Uint8Array => {
      const master = masters.get(seat);
      if (!master) throw new Error('Seat is not owned by this private replay');
      return master;
    };
    driver = new VerifiedSessionDriver(
      input.engine,
      genesis,
      [...masters.keys()],
      (deckId, seat) => {
        const deck = crypto.decks.decks.find(
          (item) => item.commitment.definition.deckId === deckId,
        );
        if (!deck) throw new Error('Private replay deck is not in certified genesis');
        return createDeckSecretSource(getMaster(seat), deck.commitment.definition, seat);
      },
      (seat) => createHandSecretSource(getMaster(seat), genesisDigest(genesis), seat),
      (seat) => {
        const owner = genesis.seats.find((item) => item.seat === seat);
        if (!owner) throw new Error('Private replay seat is not in certified genesis');
        return createStealSecretSource(
          getMaster(seat),
          genesis.ceremonyNonce,
          seat,
          owner.publicKey,
        );
      },
    );
    const activeDriver = driver;
    let prior = initial.value;
    const rebuilt = replayCertifiedPrefix(
      input.genesisEntry,
      publicReplay.value.entries,
      input.engine,
      input.policy,
      (entry, next) => {
        const beacon = next.log.crypto?.beacon;
        if (!beacon) return failure('private-replay-beacon', 'Certified beacon state is missing');
        for (const chain of beacon.chains) {
          let source = beacons.get(chain.seat);
          if (!source) continue;
          if (source.length !== chain.length) {
            source.provider.dispose();
            source = {
              length: chain.length,
              provider: createBeaconSecretSource(
                getMaster(chain.seat),
                { ceremonyId, seat: chain.seat },
                chain.length,
              ),
            };
            beacons.set(chain.seat, source);
          }
          const expected =
            chain.index > 0
              ? source.provider.source.link(chain.chainEpoch, chain.index)
              : chain.chainEpoch === 0
                ? source.provider.initialCommitment.tip
                : source.provider.source.extension(chain.chainEpoch).tip;
          try {
            if (toBase64Url(expected) !== chain.tip)
              return failure(
                'master-beacon-history',
                'Master does not reproduce a certified beacon link',
                {
                  seat: chain.seat,
                  seq: entry.entry.seq,
                },
              );
          } finally {
            expected.fill(0);
          }
        }
        const applied = activeDriver.committedEntry(entry, prior.log, next.log);
        if (!applied.ok) return applied;
        prior = next;
        return success(undefined);
      },
    );
    if (!rebuilt.ok) return rebuilt;
    // Chain sources are needed only for historical checks, not subsequent hand proofs.
    for (const source of beacons.values()) source.provider.dispose();
    beacons.clear();
    retained = true;
    return success({ context: rebuilt.value.context, driver: activeDriver, releaseSeat, dispose });
  } catch {
    return failure('private-replay-failed', 'Could not reconstruct the requested private seats');
  } finally {
    if (!retained) dispose();
  }
}
