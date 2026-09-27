import { identityFromSecret } from '@cp2p/crypto';
import { WebRtcTransport } from '@cp2p/p2p';
import type { SignedSignalEnvelope } from '@cp2p/p2p';
import type { PeerId, ProtocolClock } from '@cp2p/protocol';

declare global {
  interface Window {
    cp2pSignalSend?: (to: PeerId, value: SignedSignalEnvelope) => Promise<void>;
    cp2pHarness: {
      identity: typeof identity;
      create: typeof create;
      begin: typeof begin;
      start: typeof start;
      receiveSignal: typeof receiveSignal;
      status: typeof status;
      send: typeof send;
      forceLoss: typeof forceLoss;
      stop: typeof stop;
    };
  }
}

const clock: ProtocolClock = {
  now: () => performance.now(),
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeout: (handle) => {
    if (typeof handle === 'number') window.clearTimeout(handle);
  },
};

const listeners = new Set<(from: PeerId, value: unknown) => void>();
const connections = new Map<PeerId, RTCPeerConnection[]>();
const messages: { from: PeerId; length: number; pattern: boolean; first: number }[] = [];
const changes: { peer: PeerId; online: boolean }[] = [];
let transport: WebRtcTransport | null = null;

export function identity(seed: number): PeerId {
  const owned = identityFromSecret(new Uint8Array(32).fill(seed));
  owned.secretKey.fill(0);
  return owned.peerId;
}

export function create(seed: number, roster: readonly PeerId[]): PeerId {
  if (transport) throw new Error('Browser transport already started');
  const owned = identityFromSecret(new Uint8Array(32).fill(seed));
  try {
    transport = new WebRtcTransport({
      self: owned.peerId,
      secretKey: owned.secretKey,
      roster,
      scope: 'chromium-four-contexts',
      clock,
      adapter: {
        send: async (to, value) => {
          if (!window.cp2pSignalSend) throw new Error('Missing Playwright signal bridge');
          await window.cp2pSignalSend(to, value);
        },
        onSignal: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        close: () => {
          listeners.clear();
        },
      },
      rtcFactory: (peer, configuration) => {
        const pc = new RTCPeerConnection(configuration);
        const values = connections.get(peer) ?? [];
        values.push(pc);
        connections.set(peer, values);
        return pc;
      },
      iceServers: [],
    });
    transport.onPeerChange((peer, online) => changes.push({ peer, online }));
    transport.onMessage((from, bytes) => {
      const first = bytes[0] ?? -1;
      messages.push({
        from,
        length: bytes.length,
        first,
        pattern: bytes.every((byte, index) => byte === index % 251),
      });
    });
    return owned.peerId;
  } finally {
    owned.secretKey.fill(0);
  }
}

export function begin(): void {
  if (!transport) throw new Error('Browser transport is not prepared');
  transport.start();
}

export function start(seed: number, roster: readonly PeerId[]): PeerId {
  const id = create(seed, roster);
  begin();
  return id;
}

export function receiveSignal(from: PeerId, value: unknown): void {
  for (const listener of listeners) listener(from, value);
}

export function status() {
  return { peers: transport?.peers() ?? [], messages: [...messages], changes: [...changes] };
}

export function send(to: PeerId, bulk: boolean): void {
  if (!transport) throw new Error('Browser transport is not started');
  const bytes = bulk
    ? Uint8Array.from({ length: 1_048_576 }, (_, index) => index % 251)
    : new Uint8Array([7, 8, 9]);
  if (bulk) transport.sendBulk(to, bytes);
  else transport.send(to, bytes);
}

export function forceLoss(peer: PeerId): void {
  for (const pc of connections.get(peer) ?? []) pc.close();
}

export function stop(): void {
  transport?.dispose();
  transport = null;
  connections.clear();
  listeners.clear();
}

window.cp2pHarness = {
  identity,
  create,
  begin,
  start,
  receiveSignal,
  status,
  send,
  forceLoss,
  stop,
};
