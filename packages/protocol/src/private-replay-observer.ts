import { toBase64Url } from '@cp2p/codec';
import { scalarFromBytes } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Engine, PrivateState, Result, Seat } from '@cp2p/engine';
import { createBeaconSecretSource } from './beacon-source.js';
import type { BeaconSecretProvider } from './beacon-source.js';
import { deckCeremonyId } from './deck-genesis.js';
import { createDeckSecretSource } from './deck-source.js';
import { genesisDigest } from './genesis.js';
import { verifyRevealedMaster } from './genesis-secrets.js';
import { createHandSecretSource } from './hand-source.js';
import type { ProposalContext } from './proposal.js';
import type { CertifiedEntry } from './proposal.js';
import type { ValidatedEntry } from './log.js';
import { createStealSecretSource } from './steal-source.js';
import { VerifiedSessionDriver } from './verified-session-driver.js';

export interface PrivateReplayObserver {
  readonly driver: VerifiedSessionDriver;
  readonly onEntry: (
    entry: ValidatedEntry & CertifiedEntry,
    prior: ProposalContext,
    next: ProposalContext,
  ) => Result<void>;
  readonly finishHistory: () => void;
  readonly releaseSeat: (seat: Seat) => void;
  readonly dispose: () => void;
}

/** Package-internal driver observer. Its contexts are supplied only by authenticated replay callers. */
export function createPrivateReplayObserver(input: {
  readonly engine: Engine;
  readonly initial: () => Result<ProposalContext>;
  readonly terminal: ProposalContext;
  readonly secrets: readonly { readonly seat: Seat; readonly master: Uint8Array }[];
  readonly verifyPrivateState?: (
    seq: number,
    states: ReadonlyMap<Seat, PrivateState>,
  ) => Result<void>;
}): Result<PrivateReplayObserver> {
  const masters = new Map<Seat, Uint8Array>();
  const beacons = new Map<Seat, { length: number; provider: BeaconSecretProvider }>();
  let driver: VerifiedSessionDriver | undefined;
  let retained = false;
  const releaseSeat = (seat: Seat) => {
    try {
      driver?.relinquishSeats([seat]);
    } finally {
      const master = masters.get(seat);
      master?.fill(0);
      masters.delete(seat);
      const beacon = beacons.get(seat);
      beacon?.provider.dispose();
      beacons.delete(seat);
    }
  };
  const dispose = () => {
    let failed = false;
    let firstError: unknown;
    for (const seat of masters.keys()) {
      try {
        releaseSeat(seat);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
    try {
      driver?.dispose();
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
    if (failed) throw firstError;
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

    const { genesis, crypto } = input.terminal.log;
    if (genesis.security !== 'verified' || !crypto)
      return failure('private-replay-security', 'Private reconstruction requires verified history');
    for (const [seat, master] of masters) {
      const verified = verifyRevealedMaster(genesis, crypto.decks, seat, master);
      if (!verified.ok) return verified;
    }
    const initial = input.initial();
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
    const verifyPrivateState = (seq: number): Result<void> => {
      if (!input.verifyPrivateState) return success(undefined);
      const states = new Map<Seat, PrivateState>();
      for (const seat of masters.keys()) {
        const state = activeDriver.privateState(seat);
        if (!state)
          return failure('verified-private-missing', 'Owned private state is missing', { seq });
        states.set(seat, state);
      }
      return input.verifyPrivateState(seq, states);
    };
    const initialPrivateCheck = verifyPrivateState(initial.value.log.head.seq);
    if (!initialPrivateCheck.ok) return initialPrivateCheck;
    const onEntry = (
      entry: ValidatedEntry & CertifiedEntry,
      prior: ProposalContext,
      next: ProposalContext,
    ): Result<void> => {
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
      const checked = verifyPrivateState(entry.entry.seq);
      if (!checked.ok) return checked;
      return success(undefined);
    };
    const finishHistory = () => {
      // Chain sources are needed only for historical checks, not subsequent hand proofs.
      for (const source of beacons.values()) source.provider.dispose();
      beacons.clear();
    };
    retained = true;
    return success({ driver: activeDriver, onEntry, finishHistory, releaseSeat, dispose });
  } catch {
    return failure('private-replay-failed', 'Could not reconstruct the requested private seats');
  } finally {
    if (!retained) dispose();
  }
}
