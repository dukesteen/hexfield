import { toBase64Url } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Engine, Result, Seat } from '@cp2p/engine';
import { createBeaconSecretSource } from './beacon-source.js';
import type { BeaconSecretProvider } from './beacon-source.js';
import type { BeaconSecretSource } from './beacon-contributions.js';
import { deckCeremonyId } from './deck-genesis.js';
import { createDeckSecretSource } from './deck-source.js';
import type { DeckSourceFactory } from './deck-source.js';
import { entryHash } from './genesis.js';
import type { JournalRecord, ProtocolJournal } from './journal.js';
import { reconstructPrivateSeats } from './private-replay.js';
import type { ReconstructedPrivateSeats } from './private-replay.js';
import type { ProposalContext } from './proposal.js';
import { loadRecoveryPrivate } from './recovery-private.js';
import type { RecoveryPrivateStore } from './recovery-private.js';
import { loadActivatedRecoveryKeys } from './recovery-readiness.js';
import type { RecoveryReadinessStore } from './recovery-readiness.js';
import { replayCertifiedPrefix } from './replay.js';
import type { ReplayPolicy } from './replay.js';
import { VerifiedSessionDriver } from './verified-session-driver.js';

export interface RecoveredHost {
  /** Exact certified parent used for reconstruction. */
  readonly context: ProposalContext;
  /** Donor private state. Keep this bundle alive after adoptRecovered. */
  readonly driver: VerifiedSessionDriver;
  /** Owned current-controller signing keys for the requested recovered seats. */
  readonly keys: ReadonlyMap<Seat, Uint8Array>;
  /** Original-master-backed beacon sources for the requested recovered seats. */
  readonly beaconSources: ReadonlyMap<Seat, BeaconSecretSource>;
  /** Original-master-backed deck sources. Each returned source belongs to its caller. */
  readonly createDeckSource: DeckSourceFactory;
  /** Erase one retired bot's key and original-master-backed sources. */
  releaseSeat(seat: Seat): void;
  /** Wipe keys and masters, dispose beacon sources and reconstructed donor. */
  dispose(): void;
}

export interface RecoveredHostInput {
  readonly journal: ProtocolJournal;
  readonly engine: Engine;
  readonly policy: ReplayPolicy;
  readonly hostSeat: Seat;
  readonly privateStore: RecoveryPrivateStore;
  readonly readinessStore: RecoveryReadinessStore;
  /** Exact nonempty subset of current active recovered bots hosted by hostSeat. */
  readonly seats?: readonly Seat[];
}

function headOf(record: JournalRecord): { seq: number; hash: string } | null {
  const head = record.entries.at(-1)?.entry ?? record.genesis;
  return record.genesis.seq === 0 &&
    record.entries.length === head.seq &&
    record.height === head.seq + 1 &&
    record.safety &&
    Number.isSafeInteger(record.safety.revision) &&
    record.safety.revision >= 0 &&
    record.safety.bytes instanceof Uint8Array
    ? { seq: head.seq, hash: entryHash(head) }
    : null;
}

function sameRef(
  left: { seq: number; hash: string },
  right: { seq: number; hash: string },
): boolean {
  return left.seq === right.seq && left.hash === right.hash;
}

/** Restore only currently active hosted bots from the local certified journal. */
export async function loadRecoveredHost(input: RecoveredHostInput): Promise<Result<RecoveredHost>> {
  const { journal, engine, policy, privateStore, readinessStore, hostSeat } = input;
  const requested = input.seats?.slice();
  const keys = new Map<Seat, Uint8Array>();
  const keyBuffers: Uint8Array[] = [];
  const masters = new Map<Seat, Uint8Array>();
  const providers = new Map<Seat, BeaconSecretProvider>();
  const beaconSources = new Map<Seat, BeaconSecretSource>();
  let reconstructed: ReconstructedPrivateSeats | undefined;
  let retained = false;
  let disposed = false;
  const releaseSeat = (seat: Seat) => {
    if (disposed) return;
    reconstructed?.releaseSeat(seat);
    const key = keys.get(seat);
    key?.fill(0);
    keys.delete(seat);
    const master = masters.get(seat);
    master?.fill(0);
    masters.delete(seat);
    const provider = providers.get(seat);
    provider?.dispose();
    providers.delete(seat);
    beaconSources.delete(seat);
  };
  const dispose = () => {
    if (disposed) return;
    for (const seat of keys.keys()) releaseSeat(seat);
    disposed = true;
    reconstructed?.dispose();
    for (const key of keyBuffers) key.fill(0);
    for (const master of masters.values()) master.fill(0);
    for (const provider of providers.values()) provider.dispose();
    keys.clear();
    keyBuffers.length = 0;
    masters.clear();
    providers.clear();
    beaconSources.clear();
  };
  try {
    if (
      !Number.isSafeInteger(hostSeat) ||
      hostSeat < 0 ||
      hostSeat > 5 ||
      (requested &&
        (requested.length === 0 ||
          requested.length > 5 ||
          new Set(requested).size !== requested.length))
    )
      return failure('recovered-host-input', 'Host seat or requested seats are malformed');
    const record = await journal.load();
    const parent = record && headOf(record);
    if (!record || !parent)
      return failure('recovered-host-journal', 'Certified journal or safety height is missing');
    const genesisHash = entryHash(record.genesis);
    const replayed = replayCertifiedPrefix(record.genesis, record.entries, engine, policy);
    if (!replayed.ok) return replayed;
    const context = replayed.value.context;
    const log = context.log;
    if (!sameRef(parent, { seq: log.head.seq, hash: entryHash(log.head) }))
      return failure('recovered-host-journal', 'Certified replay differs from durable head');
    const authority = log.authority;
    const recovery = log.recovery;
    const host = authority?.controllers.find((item) => item.seat === hostSeat);
    if (!authority || !recovery || host?.kind !== 'human' || host.status !== 'active')
      return failure('recovered-host-authority', 'Current active human host is required');
    const available = authority.controllers.filter(
      (item) =>
        item.kind === 'bot' &&
        item.status === 'active' &&
        item.hostSeat === hostSeat &&
        item.activatedAt.seq > 0,
    );
    const selected = requested ?? available.map(({ seat }) => seat);
    if (
      selected.length === 0 ||
      selected.some((seat) => !available.some((item) => item.seat === seat))
    )
      return failure(
        'recovered-host-seats',
        'Requested seats are not active hosted recovered bots',
      );

    const activated = await loadActivatedRecoveryKeys(log, hostSeat, readinessStore);
    if (!activated.ok) return activated;
    try {
      for (const seat of selected) {
        const found = activated.value.keys.find((item) => item.seat === seat);
        if (!found)
          return failure('recovered-host-key', 'Activated controller signing key is missing');
        const copy = new Uint8Array(found.secretKey);
        keys.set(seat, copy);
        keyBuffers.push(copy);
      }
    } finally {
      activated.value.dispose();
    }

    const authorizations = new Map<string, { ref: { seq: number; hash: string }; seats: Seat[] }>();
    for (const seat of selected) {
      const controller = available.find((item) => item.seat === seat);
      const completed = recovery.completed.find((item) =>
        sameRef(item.activation, controller?.activatedAt ?? { seq: -1, hash: '' }),
      );
      if (!completed)
        return failure(
          'recovered-host-history',
          'Recovered controller has no completed activation',
        );
      const key = `${completed.authorization.seq}/${completed.authorization.hash}`;
      const grouped = authorizations.get(key);
      if (grouped) grouped.seats.push(seat);
      else authorizations.set(key, { ref: completed.authorization, seats: [seat] });
    }
    for (const { ref, seats } of authorizations.values()) {
      // Each private record verifies every affected master before the selected copies leave it.
      // oxlint-disable-next-line eslint/no-await-in-loop
      const loaded = await loadRecoveryPrivate(log, ref, hostSeat, privateStore);
      if (!loaded.ok) return loaded;
      try {
        for (const { seat, master } of loaded.value.secrets) {
          if (seats.includes(seat) && !masters.has(seat)) masters.set(seat, new Uint8Array(master));
        }
      } finally {
        loaded.value.dispose();
      }
    }
    if (masters.size !== selected.length)
      return failure('recovered-host-private', 'An activated seat has no matching private master');

    const secrets = [];
    for (const seat of selected) {
      const master = masters.get(seat);
      if (!master)
        return failure(
          'recovered-host-private',
          'An activated seat has no matching private master',
        );
      secrets.push({ seat, master });
    }
    const rebuilt = reconstructPrivateSeats({
      genesisEntry: record.genesis,
      entries: record.entries,
      engine,
      policy,
      secrets,
    });
    if (!rebuilt.ok) return rebuilt;
    reconstructed = rebuilt.value;
    if (
      !sameRef(parent, {
        seq: rebuilt.value.context.log.head.seq,
        hash: entryHash(rebuilt.value.context.log.head),
      })
    )
      return failure('recovered-host-private', 'Private replay used another certified head');

    const crypto = log.crypto;
    if (!crypto) return failure('recovered-host-crypto', 'Verified crypto state is missing');
    const ceremonyId = deckCeremonyId(log.genesis);
    for (const seat of selected) {
      const master = masters.get(seat);
      const chain = crypto.beacon.chains.find((item) => item.seat === seat);
      if (!master) return failure('recovered-host-private', 'Recovered master is missing');
      if (!chain) {
        if (log.genesis.seats.find((item) => item.seat === seat)?.kind !== 'bot')
          return failure('recovered-host-beacon', 'Original beacon chain is missing');
        continue;
      }
      const provider = createBeaconSecretSource(master, { ceremonyId, seat }, chain.length);
      providers.set(seat, provider);
      beaconSources.set(seat, provider.source);
      const expected =
        chain.index > 0
          ? provider.source.link(chain.chainEpoch, chain.index)
          : chain.chainEpoch === 0
            ? provider.initialCommitment.tip
            : provider.source.extension(chain.chainEpoch).tip;
      try {
        if (toBase64Url(expected) !== chain.tip)
          return failure('recovered-host-beacon', 'Original master differs from beacon chain');
      } finally {
        expected.fill(0);
      }
    }

    const latest = await journal.load();
    const latestParent = latest && headOf(latest);
    if (
      !latest ||
      !latestParent ||
      !sameRef(parent, latestParent) ||
      latest.height !== record.height ||
      entryHash(latest.genesis) !== genesisHash
    )
      return failure('recovered-host-stale', 'Certified parent advanced during recovery restore');

    const createDeckSource: DeckSourceFactory = (deckId, seat) => {
      const master = masters.get(seat);
      const deck = crypto.decks.decks.find((item) => item.commitment.definition.deckId === deckId);
      if (disposed || !master || !deck) throw new Error('Recovered deck source is unavailable');
      return createDeckSecretSource(master, deck.commitment.definition, seat);
    };
    retained = true;
    return success({
      context: rebuilt.value.context,
      driver: rebuilt.value.driver,
      keys,
      beaconSources,
      createDeckSource,
      releaseSeat,
      dispose,
    });
  } catch {
    return failure('recovered-host-unavailable', 'Could not restore recovered host state');
  } finally {
    if (!retained) dispose();
  }
}
