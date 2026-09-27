import type { PeerId, Unsubscribe } from '@cp2p/protocol';
import type { EnvelopeSignalingAdapter, SignedSignalEnvelope } from './signaling-envelope.js';

interface Endpoint {
  closed: boolean;
  readonly listeners: Set<(from: PeerId, value: unknown) => void>;
}

/** Deterministic signaling route for mesh tests; it has no authentication authority. */
export class InProcessSignaling {
  private readonly endpoints = new Map<PeerId, Endpoint>();
  private drop: ((from: PeerId, to: PeerId, value: SignedSignalEnvelope) => boolean) | null = null;

  adapter(self: PeerId): EnvelopeSignalingAdapter {
    if (this.endpoints.has(self)) throw new Error('Signaling peer already registered');
    const endpoint: Endpoint = { closed: false, listeners: new Set() };
    this.endpoints.set(self, endpoint);
    return {
      send: async (to, value) => {
        if (endpoint.closed) throw new Error('Signaling endpoint is closed');
        const target = this.endpoints.get(to);
        if (!target || target.closed || this.drop?.(self, to, value)) return;
        const copy = structuredClone(value);
        for (const listener of target.listeners) listener(self, copy);
      },
      onSignal: (listener): Unsubscribe => {
        if (endpoint.closed) return () => undefined;
        endpoint.listeners.add(listener);
        return () => {
          endpoint.listeners.delete(listener);
        };
      },
      close: () => {
        if (endpoint.closed) return;
        endpoint.closed = true;
        endpoint.listeners.clear();
        this.endpoints.delete(self);
      },
    };
  }

  setDrop(
    predicate: ((from: PeerId, to: PeerId, value: SignedSignalEnvelope) => boolean) | null,
  ): void {
    this.drop = predicate;
  }

  dispose(): void {
    for (const endpoint of this.endpoints.values()) {
      endpoint.closed = true;
      endpoint.listeners.clear();
    }
    this.endpoints.clear();
    this.drop = null;
  }
}
