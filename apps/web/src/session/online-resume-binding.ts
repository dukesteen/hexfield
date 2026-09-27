import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { G, encodePoint, identityFromSecret, scalarFromBytes, scalePoint } from '@cp2p/crypto';
import { success } from '@cp2p/engine';
import type { Engine, Seat } from '@cp2p/engine';
import {
  decksReady,
  entryHash,
  genesisDigest,
  initialProposalContext,
  replayCertifiedPrefix,
  validateDeckCeremony,
  validateGenesisOnlineStart,
  validateTransferOwnedMaterial,
} from '@cp2p/protocol';
import type { LogContext, ReplayPolicy } from '@cp2p/protocol';
import { IndexedDbProtocolJournal } from '@cp2p/storage';
import * as v from 'valibot';
import type { EscrowCeremonyStore, PeerId, ProtocolJournal } from '@cp2p/protocol';
import type { OwnedSeatMaterial } from './online-credentials.js';
import type { SavedOnlineGameRecord } from './online-game-records.js';

const MAX_BINDING_BYTES = 16 * 1024;
const peer = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));
const secret = v.custom<Uint8Array>((value) => value instanceof Uint8Array && value.length === 32);
const seatSchema = v.picklist([0, 1, 2, 3, 4, 5] as const);
const bindingSchema = v.strictObject({
  protocol: v.literal('online-game-keys-v1'),
  genesisDigest: peer,
  devicePeer: peer,
  humanSeat: seatSchema,
  seats: v.pipe(
    v.array(
      v.strictObject({
        seat: seatSchema,
        kind: v.picklist(['human', 'bot']),
        peerId: peer,
        signingKey: secret,
        master: secret,
      }),
    ),
    v.minLength(1),
    v.maxLength(6),
  ),
});

export interface ActiveOnlineResume {
  readonly peers: readonly PeerId[];
  readonly humanSeat: Seat;
  readonly gamePeer: PeerId;
  /** Null only when no binding and no journal exist yet at the original genesis. */
  readonly material: { readonly keys: readonly OwnedSeatMaterial[]; dispose(): void } | null;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function wipe(value: unknown): void {
  if (value instanceof Uint8Array) value.fill(0);
  else if (Array.isArray(value)) value.forEach(wipe);
  else if (value && typeof value === 'object') Object.values(value).forEach(wipe);
}

function activeRoutes(context: LogContext): Map<PeerId, PeerId> {
  if (!context.authority || !context.transfer)
    throw new Error('Certified game authority has no device routes');
  const routes = new Map<PeerId, PeerId>();
  for (const controller of context.authority.controllers) {
    if (controller.kind !== 'human' || controller.status !== 'active') continue;
    const device = context.transfer.routes.find(({ seat }) => seat === controller.seat)?.devicePeer;
    if (!device || routes.has(device)) throw new Error('Certified human device route is missing');
    routes.set(device, controller.publicKey);
  }
  return routes;
}

function verifyOriginalMaterial(
  binding: v.InferOutput<typeof bindingSchema>,
  context: LogContext,
): void {
  const human = context.genesis.seats.find(({ seat }) => seat === binding.humanSeat);
  if (!human || human.kind !== 'human') throw new Error('Original human seat is missing');
  const expected = context.genesis.seats.filter(
    (seat) => seat.seat === human.seat || (seat.kind === 'bot' && seat.botHost === human.publicKey),
  );
  const start = validateGenesisOnlineStart(context.genesis);
  if (!start.ok) throw new Error(start.error.message);
  if (
    context.head.seq !== 0 ||
    binding.seats.length !== expected.length ||
    binding.seats.some(
      (seat, index) =>
        seat.seat !== expected[index]?.seat ||
        seat.kind !== expected[index]?.kind ||
        seat.peerId !== expected[index]?.publicKey,
    )
  )
    throw new Error('Pre-deck binding differs from the original frozen owners');
  for (const seat of binding.seats) {
    const identity = identityFromSecret(seat.signingKey);
    try {
      const master = start.value.bindings.masters.find((item) => item.seat === seat.seat);
      if (
        identity.peerId !== seat.peerId ||
        !master ||
        encodePoint(scalePoint(G, scalarFromBytes(seat.master, { nonzero: true }))) !==
          master.masterPub
      )
        throw new Error('Pre-deck binding secrets differ from certified commitments');
    } finally {
      identity.secretKey.fill(0);
    }
  }
}

/** Read-only admission from the binding-bound journal; no safety or key record is created. */
export async function loadActiveOnlineResume(input: {
  readonly store: Pick<EscrowCeremonyStore, 'load'>;
  readonly record: SavedOnlineGameRecord;
  readonly devicePeer: PeerId;
  readonly engine: Engine;
  readonly includeMaterial?: boolean;
  /** Test/runtime journal seam; production leaves this absent for binding-bound IndexedDB. */
  readonly createJournal?: (
    gameId: string,
    keyBinding: { recordKey: string; bytes: Uint8Array },
  ) => Pick<ProtocolJournal, 'load'> & { close(): Promise<void> };
}): Promise<ActiveOnlineResume> {
  const { record, devicePeer, engine } = input;
  const policy: ReplayPolicy = {
    genesis: {
      verifyCommitments(genesis) {
        const decks = validateDeckCeremony(genesis, record.result.transcripts);
        return decks.ok ? success(undefined) : decks;
      },
    },
    entry: {},
  };
  const initial = initialProposalContext(record.result.entry, engine, policy);
  if (!initial.ok) throw new Error(initial.error.message);
  const digest = genesisDigest(initial.value.log.genesis);
  if (
    digest !== record.genesisDigest ||
    entryHash(record.result.entry) !== entryHash(initial.value.log.head)
  )
    throw new Error('Saved online genesis differs from certified replay');
  const key = `online-game/${digest}/keys`;
  const bytes = await input.store.load(key);
  if (!bytes) {
    const journal = input.createJournal
      ? input.createJournal(record.gameId, { recordKey: key, bytes: new Uint8Array() })
      : new IndexedDbProtocolJournal(record.gameId);
    try {
      const saved = await journal.load();
      if (saved) throw new Error('Voting journal exists without its key binding');
    } finally {
      await journal.close();
    }
    const routes = activeRoutes(initial.value.log);
    const gamePeer = routes.get(devicePeer);
    if (!gamePeer) throw new Error('Device is not an original active human');
    const humanSeat = initial.value.log.authority?.controllers.find(
      (item) => item.kind === 'human' && item.publicKey === gamePeer,
    )?.seat;
    if (humanSeat === undefined) throw new Error('Original human seat is unavailable');
    return { peers: [...routes.keys()].toSorted(), humanSeat, gamePeer, material: null };
  }
  let decoded: unknown;
  try {
    if (bytes.byteLength > MAX_BINDING_BYTES) throw new Error('Stored game binding is oversized');
    decoded = canonicalDecode(bytes);
    const parsed = v.parse(bindingSchema, decoded);
    const canonical = canonicalEncode(parsed);
    try {
      if (
        !equalBytes(canonical, bytes) ||
        parsed.genesisDigest !== digest ||
        parsed.devicePeer !== devicePeer
      )
        throw new Error('Stored game binding differs from this device and genesis');
    } finally {
      canonical.fill(0);
    }
    const local = parsed.seats.find(
      (seat) => seat.seat === parsed.humanSeat && seat.kind === 'human',
    );
    if (!local) throw new Error('Stored game binding lacks its human key');
    const journal = input.createJournal
      ? input.createJournal(record.gameId, { recordKey: key, bytes })
      : new IndexedDbProtocolJournal(record.gameId, { keyBinding: { recordKey: key, bytes } });
    try {
      const saved = await journal.load();
      if (!saved || entryHash(saved.genesis) !== entryHash(record.result.entry))
        throw new Error('Stored voting journal is absent or has another genesis');
      let installed: LogContext | null =
        initial.value.log.authority?.controllers.find((item) => item.seat === parsed.humanSeat)
          ?.publicKey === local.peerId
          ? initial.value.log
          : null;
      let previous = initial.value.log.authority?.controllers.find(
        (item) => item.seat === parsed.humanSeat,
      )?.publicKey;
      const replayed = replayCertifiedPrefix(
        saved.genesis,
        saved.entries,
        engine,
        policy,
        (_entry, next) => {
          const currentKey = next.log.authority?.controllers.find(
            (item) => item.seat === parsed.humanSeat,
          )?.publicKey;
          if (currentKey !== previous && currentKey === local.peerId) installed = next.log;
          previous = currentKey;
          return success(undefined);
        },
      );
      if (!replayed.ok || !installed)
        throw new Error('Stored key has no certified active generation');
      const current = replayed.value.context.log;
      const routes = activeRoutes(current);
      if (
        routes.get(devicePeer) !== local.peerId ||
        !current.authority?.controllers.some(
          (item) =>
            item.seat === parsed.humanSeat &&
            item.kind === 'human' &&
            item.status === 'active' &&
            item.publicKey === local.peerId,
        )
      )
        throw new Error('Stored game key is not the active certified device route');
      let keys: OwnedSeatMaterial[];
      if (current.crypto && decksReady(current.crypto.decks)) {
        const checked = validateTransferOwnedMaterial(parsed, {
          ...installed,
          crypto: current.crypto,
        });
        if (!checked.ok) throw new Error(checked.error.message);
        keys = checked.value.seats.map((seat) => ({ ...seat }));
      } else {
        verifyOriginalMaterial(parsed, installed);
        keys = parsed.seats.map((seat) => ({
          ...seat,
          signingKey: seat.signingKey.slice(),
          master: seat.master.slice(),
        }));
      }
      if (!input.includeMaterial) {
        wipe(keys);
        return {
          peers: [...routes.keys()].toSorted(),
          humanSeat: parsed.humanSeat,
          gamePeer: local.peerId,
          material: null,
        };
      }
      return {
        peers: [...routes.keys()].toSorted(),
        humanSeat: parsed.humanSeat,
        gamePeer: local.peerId,
        material: { keys, dispose: () => wipe(keys) },
      };
    } finally {
      await journal.close();
    }
  } finally {
    wipe(decoded);
    bytes.fill(0);
  }
}
