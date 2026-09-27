import { fromBase64Url, hashValue, toHex } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Engine, Result } from '@cp2p/engine';
import { MAX_MESSAGE_BYTES as MAX_WEBRTC_MESSAGE_BYTES } from '@cp2p/p2p';
import {
  genesisDigest,
  advanceContext,
  decodeProtocolMessage,
  encodeProtocolMessage,
  entryHash,
  MAX_MESSAGE_BYTES as MAX_PROTOCOL_MESSAGE_BYTES,
  replayCertifiedPrefix,
  validateCertifiedEntry,
  verifyGameSeatBindings,
  validateGenesisOnlineStart,
} from '@cp2p/protocol';
import type {
  LobbyFreezeAgreement,
  CertifiedEntry,
  PeerId,
  ProposalContext,
  ReplayPolicy,
  SignedGameSeatBinding,
  Transport,
  Unsubscribe,
  ValidatedGenesis,
} from '@cp2p/protocol';

const MAGIC = new Uint8Array([0x43, 0x50, 0x32, 0x47]); // CP2G
const FRAME_VERSION = 1;
const DIGEST_BYTES = 32;
const HEADER_BYTES = MAGIC.length + 1 + DIGEST_BYTES;
const RETIRED_GRACE_HEIGHTS = 128;
const MAX_RETIRED_ROUTES = 6;

interface RetiringRoute {
  readonly device: PeerId;
  readonly game: PeerId;
  readonly atSeq: number;
  readonly hint: Uint8Array;
  hinted: boolean;
}

function retireRemovedRoutes(
  prior: ReadonlyMap<PeerId, PeerId>,
  current: ReadonlyMap<PeerId, PeerId>,
  certified: CertifiedEntry,
  retired: Map<PeerId, RetiringRoute>,
): Result<void> {
  if (certified.entry.payload.kind === 'membership')
    for (const [device, game] of prior) {
      if (current.get(device) === game) continue;
      const hint = encodeProtocolMessage({
        t: 'COMMIT',
        certified: { entry: certified.entry, certificate: certified.certificate },
      });
      if (!hint.ok) return hint;
      retired.set(game, {
        device,
        game,
        atSeq: certified.entry.seq,
        hint: hint.value,
        hinted: false,
      });
    }
  for (const [game, route] of retired)
    if (certified.entry.seq - route.atSeq > RETIRED_GRACE_HEIGHTS) retired.delete(game);
  while (retired.size > MAX_RETIRED_ROUTES) {
    const oldest = retired.keys().next().value;
    if (oldest === undefined) break;
    retired.delete(oldest);
  }
  return success(undefined);
}

export interface OnlineGameTransport extends Transport {
  /** Advances routing only from a verified extension of this transport's certified history. */
  advanceCertifiedHistory(entries: readonly CertifiedEntry[]): Result<void>;
  /** Leaves the authenticated device links and their other subscribers alive. */
  dispose(): void;
}

export interface OnlineGameTransportOptions {
  readonly deviceTransport: Transport;
  /** Output of certified genesis admission, never a caller-supplied draft. */
  readonly validatedGenesis: ValidatedGenesis;
  readonly agreement: LobbyFreezeAgreement;
  readonly bindings: readonly SignedGameSeatBinding[];
  /** Required on restore or when the device joined after genesis. */
  readonly certifiedHistory?: {
    readonly genesisEntry: unknown;
    readonly entries: readonly CertifiedEntry[];
    readonly engine: Engine;
    readonly policy: ReplayPolicy;
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return toHex(hashValue(left)) === toHex(hashValue(right));
}

/** Projects a certified genesis onto the device consent and fresh game-key roster. */
export function createOnlineGameTransport(
  options: OnlineGameTransportOptions,
): Result<OnlineGameTransport> {
  const checked = verifyGameSeatBindings(options.agreement, options.bindings);
  if (!checked.ok) return checked;
  const { genesis } = options.validatedGenesis;
  const { agreement, genesisSeats, masters } = checked.value;
  try {
    const certified = validateGenesisOnlineStart(genesis);
    if (
      !certified.ok ||
      !sameValue(agreement, certified.value.bindings.agreement) ||
      !sameValue(checked.value.bindings, certified.value.bindings.bindings)
    )
      return failure(
        'online-transport-genesis',
        'Device routing differs from the certified online start',
      );
    if (
      genesis.security !== 'verified' ||
      genesis.ceremonyNonce !== agreement.state.ceremonyNonce ||
      !sameValue(genesis.config, agreement.state.config) ||
      !sameValue(genesis.seats, genesisSeats) ||
      !sameValue(genesis.commitments.masters, masters)
    )
      return failure(
        'online-transport-genesis',
        'Game keys differ from the certified frozen roster',
      );
    const digest = fromBase64Url(genesisDigest(genesis));
    if (digest.byteLength !== DIGEST_BYTES)
      return failure('online-transport-genesis', 'Genesis digest is invalid');
    const deviceToGame = new Map<PeerId, PeerId>();
    const gameToDevice = new Map<PeerId, PeerId>();
    for (const frozen of agreement.state.seats) {
      if (frozen.kind !== 'human') continue;
      const game = genesisSeats.find((seat) => seat.seat === frozen.seat);
      if (!game || game.kind !== 'human')
        return failure('online-transport-genesis', 'Human game-key roster is incomplete');
      deviceToGame.set(frozen.peer, game.publicKey);
      gameToDevice.set(game.publicKey, frozen.peer);
    }
    let certifiedContext: ProposalContext | null = null;
    let certifiedHashes: string[] = [];
    const retiring = new Map<PeerId, RetiringRoute>();
    if (options.certifiedHistory) {
      const history = options.certifiedHistory;
      let priorRoutes = new Map(deviceToGame);
      const replayed = replayCertifiedPrefix(
        history.genesisEntry,
        history.entries,
        history.engine,
        history.policy,
        (entry, next) => {
          const routes = projectCertifiedRoutes(next);
          if (!routes.ok) return routes;
          const retained = retireRemovedRoutes(
            priorRoutes,
            routes.value.deviceToGame,
            entry,
            retiring,
          );
          if (retained.ok) priorRoutes = routes.value.deviceToGame;
          return retained;
        },
      );
      if (!replayed.ok) return replayed;
      if (!sameValue(replayed.value.context.log.genesis, genesis))
        return failure('online-transport-history', 'Certified history belongs to another genesis');
      const routes = projectCertifiedRoutes(replayed.value.context);
      if (!routes.ok) return routes;
      deviceToGame.clear();
      gameToDevice.clear();
      for (const [device, game] of routes.value.deviceToGame) deviceToGame.set(device, game);
      for (const [game, device] of routes.value.gameToDevice) gameToDevice.set(game, device);
      certifiedContext = replayed.value.context;
      certifiedHashes = replayed.value.entries.map(({ entry }) => entryHash(entry));
    }
    const self = deviceToGame.get(options.deviceTransport.self);
    if (!self) return failure('online-transport-self', 'Device has no frozen human game seat');
    return success(
      new GameKeyTransport(
        options.deviceTransport,
        self,
        digest,
        deviceToGame,
        gameToDevice,
        certifiedContext,
        certifiedHashes,
        retiring,
        options.certifiedHistory
          ? {
              genesisEntry: options.certifiedHistory.genesisEntry,
              engine: options.certifiedHistory.engine,
              policy: {
                genesis: { ...options.certifiedHistory.policy.genesis },
                entry: { ...options.certifiedHistory.policy.entry },
              },
            }
          : null,
      ),
    );
  } catch {
    return failure('online-transport-genesis', 'Certified genesis projection is invalid');
  }
}

function projectCertifiedRoutes(context: ProposalContext): Result<{
  deviceToGame: Map<PeerId, PeerId>;
  gameToDevice: Map<PeerId, PeerId>;
}> {
  const authority = context.log.authority;
  const transfer = context.log.transfer;
  if (!authority || !transfer)
    return failure('online-transport-history', 'Certified authority or device routes are missing');
  const deviceToGame = new Map<PeerId, PeerId>();
  const gameToDevice = new Map<PeerId, PeerId>();
  for (const controller of authority.controllers) {
    if (controller.kind !== 'human' || controller.status !== 'active') continue;
    const device = transfer.routes.find(({ seat }) => seat === controller.seat)?.devicePeer;
    if (!device || deviceToGame.has(device) || gameToDevice.has(controller.publicKey))
      return failure('online-transport-history', 'Certified human device routes are incomplete');
    deviceToGame.set(device, controller.publicKey);
    gameToDevice.set(controller.publicKey, device);
  }
  return success({ deviceToGame, gameToDevice });
}

class GameKeyTransport implements OnlineGameTransport {
  private readonly messageListeners = new Set<(from: PeerId, message: Uint8Array) => void>();
  private readonly peerListeners = new Set<(peer: PeerId, online: boolean) => void>();
  private readonly offMessage: Unsubscribe;
  private readonly offPeer: Unsubscribe;
  private disposed = false;

  constructor(
    private readonly device: Transport,
    readonly self: PeerId,
    private readonly digest: Uint8Array,
    private deviceToGame: ReadonlyMap<PeerId, PeerId>,
    private gameToDevice: ReadonlyMap<PeerId, PeerId>,
    private context: ProposalContext | null,
    private certifiedHashes: string[],
    private retiring: Map<PeerId, RetiringRoute>,
    private readonly verifier: {
      readonly genesisEntry: unknown;
      readonly engine: Engine;
      readonly policy: ReplayPolicy;
    } | null,
  ) {
    this.offMessage = device.onMessage((from, bytes) => this.receive(from, bytes));
    this.offPeer = device.onPeerChange((peer, online) => {
      for (const route of this.retiring.values())
        if (route.device === peer) {
          if (online) this.hintRetiring(route);
          else route.hinted = false;
        }
      const game = this.deviceToGame.get(peer);
      if (!this.disposed && game && game !== this.self)
        for (const listener of this.peerListeners) {
          try {
            listener(game, online);
          } catch {
            /* A view cannot interrupt other game or device subscribers. */
          }
        }
    });
    for (const route of this.retiring.values())
      if (device.peers().includes(route.device)) this.hintRetiring(route);
  }

  advanceCertifiedHistory(entries: readonly CertifiedEntry[]): Result<void> {
    if (this.disposed) return failure('online-transport-retired', 'Game transport is disposed');
    if (!this.context || !this.verifier)
      return failure('online-transport-history', 'Certified genesis history was not installed');
    let hashes: string[];
    try {
      hashes = entries.map(({ entry }) => entryHash(entry));
    } catch {
      return failure('online-transport-history', 'Certified history contains an invalid entry');
    }
    if (
      hashes.length < this.certifiedHashes.length ||
      this.certifiedHashes.some((hash, index) => hashes[index] !== hash)
    )
      return failure('online-transport-history', 'Certified history does not extend this prefix');
    if (hashes.length === this.certifiedHashes.length) return success(undefined);
    let next = this.context;
    let priorRoutes = new Map(this.deviceToGame);
    const retiring = new Map(this.retiring);
    for (let index = this.certifiedHashes.length; index < entries.length; index++) {
      const certified = entries[index];
      if (!certified) return failure('online-transport-history', 'Certified entry is missing');
      // Historical accusations need a resolver over their exact certified ancestry.
      const kind = certified.entry?.payload?.kind;
      if (kind === 'control' || kind === 'cheat-proof') {
        const replayed = replayCertifiedPrefix(
          this.verifier.genesisEntry,
          entries.slice(0, index),
          this.verifier.engine,
          this.verifier.policy,
        );
        if (!replayed.ok) return replayed;
        next = replayed.value.context;
      }
      const checked = validateCertifiedEntry(certified, next);
      if (!checked.ok) return checked;
      const advanced = advanceContext(next, checked.value);
      if (!advanced.ok) return advanced;
      next = advanced.value;
      const nextRoutes = projectCertifiedRoutes(next);
      if (!nextRoutes.ok) return nextRoutes;
      const retained = retireRemovedRoutes(
        priorRoutes,
        nextRoutes.value.deviceToGame,
        certified,
        retiring,
      );
      if (!retained.ok) return retained;
      priorRoutes = nextRoutes.value.deviceToGame;
    }
    const routes = projectCertifiedRoutes(next);
    if (!routes.ok) return routes;
    const newSelf = routes.value.deviceToGame.get(this.device.self);
    if (newSelf !== this.self) {
      this.dispose();
      return failure('online-transport-retired', 'Local game key was retired by certified history');
    }
    const online = new Set(this.device.peers());
    const previous = new Set(this.peers());
    const current = new Set(
      [...routes.value.gameToDevice]
        .filter(([, device]) => online.has(device))
        .map(([game]) => game),
    );
    this.context = next;
    this.certifiedHashes = hashes;
    this.deviceToGame = routes.value.deviceToGame;
    this.gameToDevice = routes.value.gameToDevice;
    this.retiring = retiring;
    for (const peer of previous) if (!current.has(peer)) this.notifyPeer(peer, false);
    for (const peer of current)
      if (!previous.has(peer) && peer !== this.self) this.notifyPeer(peer, true);
    for (const route of this.retiring.values())
      if (online.has(route.device)) this.hintRetiring(route);
    return success(undefined);
  }

  private hintRetiring(route: RetiringRoute): void {
    if (this.disposed || route.hinted) return;
    try {
      this.device.send(route.device, this.frame(route.hint));
      route.hinted = true;
    } catch {
      // Retry on the next authenticated link event or retired peer request.
    }
  }

  private notifyPeer(peer: PeerId, online: boolean): void {
    for (const listener of this.peerListeners) {
      try {
        listener(peer, online);
      } catch {
        /* A view cannot interrupt other game or device subscribers. */
      }
    }
  }

  peers(): PeerId[] {
    if (this.disposed) return [];
    return this.device
      .peers()
      .map((peer) => this.deviceToGame.get(peer))
      .filter((peer): peer is PeerId => peer !== undefined && peer !== this.self)
      .toSorted();
  }

  send(to: PeerId, message: Uint8Array): void {
    this.assertActive();
    const devicePeer = this.gameToDevice.get(to);
    if (devicePeer && to !== this.self) {
      this.device.send(devicePeer, this.frame(message));
      return;
    }
    const retired = this.retiring.get(to);
    if (!retired || !this.device.peers().includes(retired.device))
      throw new Error('Game peer is not a remote human');
    const decoded = decodeProtocolMessage(message);
    if (!decoded.ok || decoded.value.t !== 'SYNC_RES')
      throw new Error('Retired game peer accepts certified sync responses only');
    this.device.send(retired.device, this.frame(message));
  }

  broadcast(message: Uint8Array): void {
    this.assertActive();
    let firstError: unknown = null;
    for (const peer of this.peers()) {
      try {
        this.send(peer, message);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }

  onMessage(listener: (from: PeerId, message: Uint8Array) => void): Unsubscribe {
    if (this.disposed) return () => undefined;
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onPeerChange(listener: (peer: PeerId, online: boolean) => void): Unsubscribe {
    if (this.disposed) return () => undefined;
    this.peerListeners.add(listener);
    return () => this.peerListeners.delete(listener);
  }

  disconnect(peer: PeerId): void {
    this.assertActive();
    const devicePeer = this.gameToDevice.get(peer);
    if (!devicePeer || peer === this.self) throw new Error('Game peer is not a remote human');
    this.device.disconnect(devicePeer);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offMessage();
    this.offPeer();
    this.messageListeners.clear();
    this.peerListeners.clear();
    this.retiring.clear();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Game transport is disposed');
  }

  private frame(message: Uint8Array): Uint8Array {
    if (
      !(message instanceof Uint8Array) ||
      message.byteLength > MAX_PROTOCOL_MESSAGE_BYTES ||
      message.byteLength + HEADER_BYTES > MAX_WEBRTC_MESSAGE_BYTES
    )
      throw new RangeError('Gameplay packet exceeds the transport limit');
    const frame = new Uint8Array(HEADER_BYTES + message.byteLength);
    frame.set(MAGIC);
    frame[MAGIC.length] = FRAME_VERSION;
    frame.set(this.digest, MAGIC.length + 1);
    frame.set(message, HEADER_BYTES);
    return frame;
  }

  private receive(from: PeerId, bytes: Uint8Array): void {
    if (this.disposed) return;
    const gamePeer = this.deviceToGame.get(from);
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength < HEADER_BYTES ||
      bytes.byteLength > HEADER_BYTES + MAX_PROTOCOL_MESSAGE_BYTES ||
      bytes.byteLength > MAX_WEBRTC_MESSAGE_BYTES ||
      MAGIC.some((byte, index) => bytes[index] !== byte) ||
      bytes[MAGIC.length] !== FRAME_VERSION ||
      this.digest.some((byte, index) => bytes[MAGIC.length + 1 + index] !== byte)
    )
      return;
    if (!gamePeer) {
      const retired = [...this.retiring.values()].find((route) => route.device === from);
      if (!retired) return;
      const decoded = decodeProtocolMessage(bytes.slice(HEADER_BYTES));
      if (!decoded.ok || decoded.value.t !== 'SYNC_REQ') return;
      this.hintRetiring(retired);
      for (const listener of this.messageListeners) {
        try {
          listener(retired.game, bytes.slice(HEADER_BYTES));
        } catch {
          /* A view cannot interrupt certified catch-up or other subscribers. */
        }
      }
      return;
    }
    if (gamePeer === this.self) return;
    for (const listener of this.messageListeners) {
      try {
        listener(gamePeer, bytes.slice(HEADER_BYTES));
      } catch {
        /* A view cannot interrupt other game or device subscribers. */
      }
    }
  }
}
