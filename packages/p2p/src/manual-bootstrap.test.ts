import { canonicalEncode, fromBase64Url, toBase64Url } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import type { ProtocolClock } from '@cp2p/protocol';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { answerManualOffer, createManualOffer } from './manual-bootstrap.js';
import { MeshRelaySignalingAdapter } from './mesh-relay-signaling.js';
import { signSignalEnvelope } from './signaling-envelope.js';

let nextTimer = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const clock: ProtocolClock = {
  now: () => Date.now(),
  setTimeout(callback, delay) {
    const id = ++nextTimer;
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        callback();
      }, delay),
    );
    return id;
  },
  clearTimeout(handle) {
    if (typeof handle !== 'number') return;
    const timer = timers.get(handle);
    if (timer) clearTimeout(timer);
    timers.delete(handle);
  },
};

class FakeChannel extends EventTarget {
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  readyState: RTCDataChannelState = 'connecting';
  remote: FakeChannel | null = null;

  open(): void {
    if (this.readyState !== 'connecting') return;
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }

  send(data: Uint8Array): void {
    if (this.readyState !== 'open' || !this.remote) throw new Error('Fake channel is closed');
    const copy = new Uint8Array(data);
    this.remote.dispatchEvent(new MessageEvent('message', { data: copy.buffer }));
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
}

class FakePc extends EventTarget {
  static readonly all: FakePc[] = [];
  static emitCandidates = true;
  readonly id = FakePc.all.length + 1;
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  iceGatheringState: RTCIceGatheringState = 'new';
  channel: FakeChannel | null = null;
  closed = false;

  constructor() {
    super();
    FakePc.all.push(this);
  }

  createDataChannel(label: string, options: RTCDataChannelInit): RTCDataChannel {
    if (label !== 'manual-signaling' || options.id !== 2 || !options.negotiated)
      throw new Error('Unexpected bootstrap data channel');
    this.channel = new FakeChannel();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The test implements the RTC members used by the bootstrap.
    return this.channel as unknown as RTCDataChannel;
  }

  async setLocalDescription(): Promise<void> {
    const type = this.remoteDescription ? 'answer' : 'offer';
    const fingerprint = Array(32).fill(this.id.toString(16).padStart(2, '0')).join(':');
    this.localDescription = {
      type,
      sdp:
        [
          'v=0',
          `o=- ${this.id} 2 IN IP4 127.0.0.1`,
          's=-',
          't=0 0',
          'a=group:BUNDLE data',
          'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
          'c=IN IP4 0.0.0.0',
          'a=ice-ufrag:abcd',
          'a=ice-pwd:abcdefghijklmnopqrstuvwx',
          `a=fingerprint:sha-256 ${fingerprint}`,
          `a=setup:${type === 'offer' ? 'actpass' : 'active'}`,
          'a=mid:data',
          'a=sctp-port:5000',
          'a=max-message-size:262144',
          `a=x-fake-pc:${this.id}`,
        ].join('\r\n') + '\r\n',
    };
    if (!FakePc.emitCandidates) return;
    queueMicrotask(() => {
      if (this.closed) return;
      const candidate = {
        candidate: `candidate:${this.id} 1 udp 1 192.0.2.${this.id} 5000 typ host`,
        sdpMid: 'data',
      };
      this.dispatchEvent(
        Object.assign(new Event('icecandidate'), {
          candidate: { toJSON: () => candidate },
        }),
      );
      this.iceGatheringState = 'complete';
      this.dispatchEvent(new Event('icegatheringstatechange'));
      this.dispatchEvent(Object.assign(new Event('icecandidate'), { candidate: null }));
      this.pair();
    });
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
    this.pair();
  }

  private pair(): void {
    if (!this.localDescription || !this.remoteDescription || !this.channel) return;
    const other = FakePc.all.find(
      (pc) =>
        pc !== this &&
        !pc.closed &&
        pc.localDescription &&
        pc.remoteDescription &&
        pc.channel &&
        this.remoteDescription?.sdp?.includes(`a=x-fake-pc:${pc.id}\r\n`) &&
        pc.remoteDescription.sdp?.includes(`a=x-fake-pc:${this.id}\r\n`),
    );
    if (!other?.channel) return;
    this.channel.remote = other.channel;
    other.channel.remote = this.channel;
    this.channel.open();
    other.channel.open();
  }

  close(): void {
    this.closed = true;
    this.channel?.close();
  }
}

function rtcFactory(): RTCPeerConnection {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fake covers the bootstrap's RTC contract.
  return new FakePc() as unknown as RTCPeerConnection;
}

test('two signed codes bootstrap an unknown joiner, then carry exact verified signaling', async () => {
  FakePc.all.length = 0;
  FakePc.emitCandidates = true;
  const host = identityFromSecret(new Uint8Array(32).fill(21));
  const guest = identityFromSecret(new Uint8Array(32).fill(22));
  const foreign = identityFromSecret(new Uint8Array(32).fill(23));
  const common = { scope: 'lobby:abcde23456', clock, rtcFactory };
  const invitation = await createManualOffer({
    ...common,
    self: host.peerId,
    secretKey: host.secretKey,
  });
  let guestBridge: Awaited<ReturnType<typeof answerManualOffer>>['bridge'] | null = null;
  try {
    expect(invitation.code.startsWith('HX1.')).toBe(true);
    expect(invitation.gatheringComplete).toBe(true);
    const answered = await answerManualOffer(
      {
        ...common,
        self: guest.peerId,
        secretKey: guest.secretKey,
      },
      invitation.code,
    );
    guestBridge = answered.bridge;
    expect(answered.peer).toBe(host.peerId);
    expect(answered.gatheringComplete).toBe(true);
    const hostBridge = await invitation.acceptAnswer(answered.code);
    expect(await invitation.acceptAnswer(answered.code)).toBe(hostBridge);
    const sameAnswer = `HX1.${toBase64Url(
      deflateRawSync(inflateRawSync(fromBase64Url(answered.code.slice(4))), { level: 0 }),
    )}`;
    expect(sameAnswer).not.toBe(answered.code);
    expect(await invitation.acceptAnswer(sameAnswer)).toBe(hostBridge);
    await Promise.all([hostBridge.ready(), guestBridge.ready()]);
    const received: unknown[] = [];
    const envelope = signSignalEnvelope(
      {
        version: 2,
        scope: common.scope,
        from: host.peerId,
        to: guest.peerId,
        attemptId: 'AAAAAAAAAAAAAAAAAAAAAA',
        sessionId: 'AAAAAAAAAAAAAAAAAAAAAA',
        attemptSeq: 1,
        blob: { kind: 'candidate', generation: 1, revision: 1, candidate: null },
      },
      host.secretKey,
    );
    await hostBridge.send(guest.peerId, envelope);
    guestBridge.onSignal((from, value) => received.push({ from, value }));
    expect(received).toEqual([{ from: host.peerId, value: envelope }]);
    const forged = signSignalEnvelope(envelope.body, foreign.secretKey);
    required(FakePc.all[0]?.channel).send(canonicalEncode(forged));
    expect(received).toHaveLength(1);
    await expect(hostBridge.send(foreign.peerId, envelope)).rejects.toThrow('recipient');
    const competing = await answerManualOffer(
      {
        ...common,
        self: foreign.peerId,
        secretKey: foreign.secretKey,
      },
      invitation.code,
    );
    try {
      await expect(invitation.acceptAnswer(competing.code)).rejects.toThrow('already used');
    } finally {
      competing.bridge.close();
    }
    expect(invitation.code.length).toBeLessThanOrEqual(2_048);
    expect(answered.code.length).toBeLessThanOrEqual(2_048);
  } finally {
    invitation.close();
    guestBridge?.close();
    host.secretKey.fill(0);
    guest.secretKey.fill(0);
    foreign.secretKey.fill(0);
  }
});

test('known-peer reconnect refuses another signed device and an answer to another offer', async () => {
  FakePc.all.length = 0;
  FakePc.emitCandidates = true;
  const host = identityFromSecret(new Uint8Array(32).fill(31));
  const guest = identityFromSecret(new Uint8Array(32).fill(32));
  const foreign = identityFromSecret(new Uint8Array(32).fill(33));
  const common = { scope: 'lobby:abcde23456', clock, rtcFactory };
  const invitation = await createManualOffer({
    ...common,
    self: host.peerId,
    secretKey: host.secretKey,
    to: guest.peerId,
  });
  try {
    await expect(
      answerManualOffer(
        {
          ...common,
          self: foreign.peerId,
          secretKey: foreign.secretKey,
        },
        invitation.code,
      ),
    ).rejects.toThrow('recipient');
    const answered = await answerManualOffer(
      {
        ...common,
        self: guest.peerId,
        secretKey: guest.secretKey,
      },
      invitation.code,
    );
    try {
      const another = await createManualOffer({
        ...common,
        self: host.peerId,
        secretKey: host.secretKey,
        to: guest.peerId,
      });
      try {
        await expect(another.acceptAnswer(answered.code)).rejects.toThrow('bind');
      } finally {
        another.close();
      }
      const bridge = await invitation.acceptAnswer(answered.code);
      await bridge.ready();
      bridge.close();
      await expect(invitation.acceptAnswer(answered.code)).resolves.toBe(bridge);
    } finally {
      answered.bridge.close();
    }
  } finally {
    invitation.close();
    host.secretKey.fill(0);
    guest.secretKey.fill(0);
    foreign.secretKey.fill(0);
  }
});

test('a closed bootstrap bridge unregisters and permits a same-peer reconnect bridge', async () => {
  FakePc.all.length = 0;
  FakePc.emitCandidates = true;
  const host = identityFromSecret(new Uint8Array(32).fill(41));
  const guest = identityFromSecret(new Uint8Array(32).fill(42));
  const common = { scope: 'lobby:abcde23456', clock, rtcFactory };
  const relay = new MeshRelaySignalingAdapter(host.peerId, common.scope, clock);
  const firstOffer = await createManualOffer({
    ...common,
    self: host.peerId,
    secretKey: host.secretKey,
  });
  let firstAnswer: Awaited<ReturnType<typeof answerManualOffer>> | null = null;
  let firstHostBridge: Awaited<ReturnType<typeof firstOffer.acceptAnswer>> | null = null;
  let secondOffer: Awaited<ReturnType<typeof createManualOffer>> | null = null;
  let secondAnswer: Awaited<ReturnType<typeof answerManualOffer>> | null = null;
  try {
    firstAnswer = await answerManualOffer(
      { ...common, self: guest.peerId, secretKey: guest.secretKey },
      firstOffer.code,
    );
    const currentHostBridge = await firstOffer.acceptAnswer(firstAnswer.code);
    firstHostBridge = currentHostBridge;
    relay.addBridge(currentHostBridge);
    expect(relay.hasBridge(guest.peerId)).toBe(true);
    expect(() => relay.addBridge(currentHostBridge)).toThrow('unavailable');

    required(FakePc.all[0]?.channel).close();
    expect(currentHostBridge.isClosed).toBe(true);
    expect(relay.hasBridge(guest.peerId)).toBe(false);

    secondOffer = await createManualOffer({
      ...common,
      self: host.peerId,
      secretKey: host.secretKey,
      to: guest.peerId,
    });
    secondAnswer = await answerManualOffer(
      { ...common, self: guest.peerId, secretKey: guest.secretKey },
      secondOffer.code,
    );
    const secondHostBridge = await secondOffer.acceptAnswer(secondAnswer.code);
    relay.addBridge(secondHostBridge);
    expect(relay.hasBridge(guest.peerId)).toBe(true);

    // A late close from the old bridge must not unregister its replacement.
    firstHostBridge.close();
    expect(relay.hasBridge(guest.peerId)).toBe(true);
  } finally {
    relay.close();
    firstOffer.close();
    firstAnswer?.bridge.close();
    secondOffer?.close();
    secondAnswer?.bridge.close();
    host.secretKey.fill(0);
    guest.secretKey.fill(0);
  }
});

test('manual ICE gathering has a finite deadline and seals one immutable code', async () => {
  FakePc.all.length = 0;
  FakePc.emitCandidates = false;
  const host = identityFromSecret(new Uint8Array(32).fill(41));
  try {
    const invitation = await createManualOffer({
      self: host.peerId,
      secretKey: host.secretKey,
      scope: 'lobby:abcde23456',
      clock,
      rtcFactory,
      gatherDeadlineMs: 5,
    });
    try {
      expect(invitation.gatheringComplete).toBe(false);
      const sealed = invitation.code;
      required(FakePc.all[0]).dispatchEvent(
        Object.assign(new Event('icecandidate'), {
          candidate: { toJSON: () => ({ candidate: 'candidate:late', sdpMid: 'data' }) },
        }),
      );
      expect(invitation.code).toBe(sealed);
    } finally {
      invitation.close();
    }
  } finally {
    FakePc.emitCandidates = true;
    host.secretKey.fill(0);
  }
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing fake peer connection');
  return value;
}
