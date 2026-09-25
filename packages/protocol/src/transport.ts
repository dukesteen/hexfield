/** Ed25519 public key encoded as canonical, unpadded base64url. */
export type PeerId = string;

export type Unsubscribe = () => void;

/** Authenticated peer links. Packets may be lost while a link reconnects. */
export interface Transport {
  readonly self: PeerId;
  peers(): PeerId[];
  send(to: PeerId, message: Uint8Array): void;
  broadcast(message: Uint8Array): void;
  onMessage(listener: (from: PeerId, message: Uint8Array) => void): Unsubscribe;
  onPeerChange(listener: (peer: PeerId, online: boolean) => void): Unsubscribe;
  disconnect(peer: PeerId): void;
}

/** Injected monotonic clock; the protocol never depends on browser timers. */
export interface ProtocolClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}
