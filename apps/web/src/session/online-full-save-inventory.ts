import { createBaseEngine } from '@cp2p/engine';
import type { Seat } from '@cp2p/engine';
import {
  entryHash,
  loadRecoveryPrivate,
  replayCertifiedPrefix,
  validateDeckCeremony,
} from '@cp2p/protocol';
import type { EscrowCeremonyStore, ProtocolJournal, ReplayPolicy } from '@cp2p/protocol';
import { success } from '@cp2p/engine';
import { loadOnlineIdentity } from './online-credentials.js';
import type { SavedOnlineGameRecord } from './online-game-records.js';
import { loadActiveOnlineResume } from './online-resume-binding.js';

interface OwnedMasterInventory {
  loadOwnedMaster(seat: Seat): Promise<Uint8Array | null>;
  dispose(): void;
}

function sameRef(
  a: { readonly seq: number; readonly hash: string },
  b: { readonly seq: number; readonly hash: string },
): boolean {
  return a.seq === b.seq && a.hash === b.hash;
}

/** Read-only inventory of exactly the seats this device currently hosts. */
export async function loadStoredOnlineMasterInventory(input: {
  readonly start: SavedOnlineGameRecord;
  readonly journal: Pick<ProtocolJournal, 'load'>;
  readonly store: EscrowCeremonyStore;
}): Promise<OwnedMasterInventory> {
  const identity = await loadOnlineIdentity(input.store);
  const devicePeer = identity.peerId;
  identity.dispose();
  const engine = createBaseEngine();
  const policy: ReplayPolicy = {
    genesis: {
      verifyCommitments(genesis) {
        const checked = validateDeckCeremony(genesis, input.start.result.transcripts);
        return checked.ok ? success(undefined) : checked;
      },
    },
    entry: {},
  };
  const material = await loadActiveOnlineResume({
    store: input.store,
    record: input.start,
    devicePeer,
    engine,
    includeMaterial: true,
  });
  if (!material.material) throw new Error('Current bound game material is missing');
  const masters = new Map<Seat, Uint8Array>();
  let retained = false;
  try {
    const snapshot = await input.journal.load();
    if (!snapshot || entryHash(snapshot.genesis) !== entryHash(input.start.result.entry))
      throw new Error('Current certified journal is missing');
    const replayed = replayCertifiedPrefix(snapshot.genesis, snapshot.entries, engine, policy);
    if (!replayed.ok) throw new Error(replayed.error.message);
    const context = replayed.value.context.log;
    const host = context.authority?.controllers.find((seat) => seat.seat === material.humanSeat);
    if (host?.kind !== 'human' || host.status !== 'active' || host.publicKey !== material.gamePeer)
      throw new Error('Bound human no longer controls the certified seat');
    const hosted =
      context.authority?.controllers.filter(
        (seat) => seat.status === 'active' && seat.hostSeat === material.humanSeat,
      ) ?? [];
    for (const controller of hosted) {
      const bound = material.material.keys.find(
        (seat) => seat.seat === controller.seat && seat.peerId === controller.publicKey,
      );
      if (bound) masters.set(controller.seat, new Uint8Array(bound.master));
    }
    const missing = hosted.filter((seat) => !masters.has(seat.seat));
    for (const controller of missing) {
      if (controller.kind !== 'bot')
        throw new Error('Current human master is absent from the bound material');
      const completed = context.recovery?.completed.find((item) =>
        sameRef(item.activation, controller.activatedAt),
      );
      if (!completed)
        throw new Error('Hosted bot has neither bound nor completed recovery material');
      // oxlint-disable-next-line no-await-in-loop -- At most five hosted bots, each record has its own certified authorization.
      const recovered = await loadRecoveryPrivate(
        context,
        completed.authorization,
        material.humanSeat,
        input.store,
      );
      if (!recovered.ok) throw new Error(recovered.error.message);
      try {
        const secret = recovered.value.secrets.find((item) => item.seat === controller.seat);
        if (!secret) throw new Error('Recovered bot master is absent');
        masters.set(controller.seat, new Uint8Array(secret.master));
      } finally {
        recovered.value.dispose();
      }
    }
    if (masters.size !== hosted.length)
      throw new Error('Current hosted master inventory is incomplete');
    retained = true;
    return {
      async loadOwnedMaster(seat) {
        const master = masters.get(seat);
        return master ? new Uint8Array(master) : null;
      },
      dispose() {
        for (const master of masters.values()) master.fill(0);
        masters.clear();
      },
    };
  } finally {
    material.material.dispose();
    if (!retained) {
      for (const master of masters.values()) master.fill(0);
      masters.clear();
    }
  }
}
