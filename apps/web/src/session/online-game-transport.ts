import { fromBase64Url, hashValue, toHex } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { MAX_MESSAGE_BYTES as MAX_WEBRTC_MESSAGE_BYTES } from '@cp2p/p2p';
import {
  genesisDigest,
  MAX_MESSAGE_BYTES as MAX_PROTOCOL_MESSAGE_BYTES,
  verifyGameSeatBindings,
  validateGenesisOnlineStart,
} from '@cp2p/protocol';
import type {
  LobbyFreezeAgreement,
  PeerId,
  SignedGameSeatBinding,
  Transport,
  Unsubscribe,
  ValidatedGenesis,
} from '@cp2p/protocol';

const MAGIC = new Uint8Array([0x43, 0x50, 0x32, 0x47]); // CP2G
const FRAME_VERSION = 1;
const DIGEST_BYTES = 32;
const HEADER_BYTES = MAGIC.length + 1 + DIGEST_BYTES;

export interface OnlineGameTransport extends Transport {
  /** Leaves the authenticated device links and their other subscribers alive. */
  dispose(): void;
}

export interface OnlineGameTransportOptions {
  readonly deviceTransport: Transport;
  /** Output of certified genesis admission, never a caller-supplied draft. */
  readonly validatedGenesis: ValidatedGenesis;
  readonly agreement: LobbyFreezeAgreement;
  readonly bindings: readonly SignedGameSeatBinding[];
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
    const self = deviceToGame.get(options.deviceTransport.self);
    if (!self) return failure('online-transport-self', 'Device has no frozen human game seat');
    return success(
      new GameKeyTransport(options.deviceTransport, self, digest, deviceToGame, gameToDevice),
    );
  } catch {
    return failure('online-transport-genesis', 'Certified genesis projection is invalid');
  }
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
    private readonly deviceToGame: ReadonlyMap<PeerId, PeerId>,
    private readonly gameToDevice: ReadonlyMap<PeerId, PeerId>,
  ) {
    this.offMessage = device.onMessage((from, bytes) => this.receive(from, bytes));
    this.offPeer = device.onPeerChange((peer, online) => {
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
    if (!devicePeer || to === this.self) throw new Error('Game peer is not a remote human');
    this.device.send(devicePeer, this.frame(message));
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
      !gamePeer ||
      gamePeer === this.self ||
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength < HEADER_BYTES ||
      bytes.byteLength > HEADER_BYTES + MAX_PROTOCOL_MESSAGE_BYTES ||
      bytes.byteLength > MAX_WEBRTC_MESSAGE_BYTES ||
      MAGIC.some((byte, index) => bytes[index] !== byte) ||
      bytes[MAGIC.length] !== FRAME_VERSION ||
      this.digest.some((byte, index) => bytes[MAGIC.length + 1 + index] !== byte)
    )
      return;
    for (const listener of this.messageListeners) {
      try {
        listener(gamePeer, bytes.slice(HEADER_BYTES));
      } catch {
        /* A view cannot interrupt other game or device subscribers. */
      }
    }
  }
}
