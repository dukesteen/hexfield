import type { PeerId, Unsubscribe } from '@cp2p/protocol';

/** A bounded envelope; adapters may encode it as a manual code, WebSocket, or mesh relay. */
export type SignalBlob =
  | {
      readonly kind: 'description';
      readonly generation: number;
      readonly revision: number;
      readonly description: RTCSessionDescriptionInit;
    }
  | {
      readonly kind: 'candidate';
      readonly generation: number;
      readonly revision: number;
      readonly candidate: RTCIceCandidateInit | null;
    };

export interface SignalingAdapter {
  readonly kind: 'manual' | 'server' | 'mesh-relay';
  /** The literal `room` is accepted because PeerId is currently a string alias. */
  send(to: PeerId, blob: SignalBlob): Promise<void>;
  onSignal(listener: (from: PeerId, blob: SignalBlob) => void): Unsubscribe;
  close(): void;
}
