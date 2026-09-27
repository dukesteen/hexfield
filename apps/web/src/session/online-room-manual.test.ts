import { BASE_VERSION } from '@cp2p/engine';
import { identityFromSecret } from '@cp2p/crypto';
import { answerManualOffer, createManualOffer, readManualLobbyOffer } from '@cp2p/p2p';
import { MemoryEscrowLifecycleStore, VirtualClock } from '@cp2p/protocol/testing';
import { expect, test } from 'vitest';
import { OnlineRoom } from './online-room.js';

class ManualChannel extends EventTarget {
  binaryType = 'arraybuffer';
  readyState: RTCDataChannelState = 'connecting';
  bufferedAmount = 0;
  close(): void {
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
}

class ManualPc extends EventTarget {
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  iceGatheringState: RTCIceGatheringState = 'new';
  readonly channel = new ManualChannel();
  closed = false;

  createDataChannel(): RTCDataChannel {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Bounded test RTC fake.
    return this.channel as unknown as RTCDataChannel;
  }

  async setLocalDescription(): Promise<void> {
    const type = this.remoteDescription ? 'answer' : 'offer';
    this.localDescription = {
      type,
      sdp:
        [
          'v=0',
          'o=- 1 2 IN IP4 127.0.0.1',
          's=-',
          't=0 0',
          'a=group:BUNDLE data',
          'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
          'c=IN IP4 0.0.0.0',
          'a=ice-ufrag:abcd',
          'a=ice-pwd:abcdefghijklmnopqrstuvwx',
          `a=fingerprint:sha-256 ${Array(32).fill('11').join(':')}`,
          `a=setup:${type === 'offer' ? 'actpass' : 'active'}`,
          'a=mid:data',
          'a=sctp-port:5000',
        ].join('\r\n') + '\r\n',
    };
    queueMicrotask(() => {
      this.iceGatheringState = 'complete';
      this.dispatchEvent(new Event('icegatheringstatechange'));
    });
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
  }

  close(): void {
    this.closed = true;
    this.channel.close();
  }
}

class PeerLinkChannel extends EventTarget {
  binaryType: BinaryType = 'arraybuffer';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState: RTCDataChannelState = 'connecting';
  send(): void {}
  close(): void {
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
}

class PeerLinkPc extends EventTarget {
  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescription | null = null;
  currentLocalDescription: RTCSessionDescription | null = null;
  currentRemoteDescription: RTCSessionDescription | null = null;

  createDataChannel(): RTCDataChannel {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Bounded PeerLink fake.
    return new PeerLinkChannel() as unknown as RTCDataChannel;
  }
  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(): Promise<void> {}
  async addIceCandidate(): Promise<void> {}
  close(): void {
    this.connectionState = 'closed';
  }
}

test('manual host publishes one signed room-bound offer and cancels its owned RTC attempt', async () => {
  const pcs: ManualPc[] = [];
  const room = await OnlineRoom.open(
    {
      kind: 'host',
      serverUrl: '',
      name: 'Manual lobby',
      hostName: 'Host',
      config: {
        modules: [{ id: 'base', version: BASE_VERSION }],
        seats: [0, 1],
        options: { base: { mapLayout: 'random', vpTarget: 3 } },
      },
    },
    {
      store: new MemoryEscrowLifecycleStore(),
      clock: new VirtualClock(),
      acquireLease: async () => ({
        lockName: 'manual-room-test',
        run: async <T>(task: () => T | PromiseLike<T>) => task(),
        close: async () => undefined,
      }),
      manualRtcFactory: () => {
        const pc = new ManualPc();
        pcs.push(pc);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Bounded test RTC fake.
        return pc as unknown as RTCPeerConnection;
      },
    },
  );
  try {
    expect(room.invite.serverUrl).toBe('');
    expect(room.getSnapshot().lobby?.takeover).toEqual({ mode: 'vote', afterSeconds: 120 });
    const offered = await room.startManualInvitation();
    if (!offered.ok) throw new Error(offered.error.message);
    const hint = await readManualLobbyOffer(offered.value.code);
    expect(hint).toEqual({ roomId: room.invite.roomId, from: room.getSnapshot().self });
    expect(room.getSnapshot().manual.code).toBe(offered.value.code);
    expect(await room.startManualInvitation()).toEqual(offered);
    expect(pcs).toHaveLength(1);
    expect(Object.isFrozen(room.getSnapshot().manual)).toBe(true);
    expect(Object.isFrozen(room.getSnapshot().invite)).toBe(true);
    expect(Object.isFrozen(room.getSnapshot().peers)).toBe(true);
    room.cancelManualInvitation();
    expect(room.getSnapshot().manual.phase).toBe('idle');
    expect(pcs[0]?.closed).toBe(true);
  } finally {
    await room.close();
  }
});

test('a targeted reconnect code cannot create a new lobby', async () => {
  const inviter = identityFromSecret(new Uint8Array(32).fill(91));
  const target = identityFromSecret(new Uint8Array(32).fill(92));
  const clock = new VirtualClock();
  const offer = await createManualOffer({
    self: inviter.peerId,
    secretKey: inviter.secretKey,
    to: target.peerId,
    scope: 'lobby:abcdefgh23',
    clock,
    rtcFactory: () => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Bounded test RTC fake.
      return new ManualPc() as unknown as RTCPeerConnection;
    },
  });
  try {
    await expect(
      OnlineRoom.open(
        { kind: 'manual-join', offerCode: offer.code },
        { store: new MemoryEscrowLifecycleStore(), clock },
      ),
    ).rejects.toThrow('reconnect code requires the saved room');
  } finally {
    offer.close();
    inviter.secretKey.fill(0);
    target.secretKey.fill(0);
  }
});

test('a closed pending answer bridge resets the room to a retryable state', async () => {
  const host = identityFromSecret(new Uint8Array(32).fill(93));
  const clock = new VirtualClock();
  const scope = 'lobby:abcde23456';
  const invitation = await createManualOffer({
    self: host.peerId,
    secretKey: host.secretKey,
    scope,
    clock,
    rtcFactory: () => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Bounded bootstrap fake.
      return new ManualPc() as unknown as RTCPeerConnection;
    },
  });
  const manualPcs: ManualPc[] = [];
  const room = await OnlineRoom.open(
    { kind: 'manual-join', offerCode: invitation.code },
    {
      store: new MemoryEscrowLifecycleStore(),
      clock,
      acquireLease: async () => ({
        lockName: 'manual-answer-test',
        run: async <T>(task: () => T | PromiseLike<T>) => task(),
        close: async () => undefined,
      }),
      manualRtcFactory: () => {
        const pc = new ManualPc();
        manualPcs.push(pc);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Bounded bootstrap fake.
        return pc as unknown as RTCPeerConnection;
      },
      rtcFactory: () => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Bounded PeerLink fake.
        return new PeerLinkPc() as unknown as RTCPeerConnection;
      },
    },
  );
  try {
    expect(room.getSnapshot().manual.phase).toBe('answering');
    expect(room.getSnapshot().manual.code).not.toBeNull();
    clock.advanceBy(5 * 60_000, 1_000);
    expect(manualPcs[0]?.closed).toBe(true);
    expect(room.getSnapshot().manual.phase).toBe('error');
    expect(room.getSnapshot().manual.code).toBeNull();

    const retry = await room.answerManualOffer(invitation.code);
    expect(retry.ok).toBe(true);
    expect(room.getSnapshot().manual.phase).toBe('answering');
  } finally {
    await room.close();
    invitation.close();
    host.secretKey.fill(0);
  }
});

test('concurrent acceptance of the same manual answer preserves its shared bridge', async () => {
  const guest = identityFromSecret(new Uint8Array(32).fill(94));
  const clock = new VirtualClock();
  const manualPcs: ManualPc[] = [];
  const room = await OnlineRoom.open(
    {
      kind: 'host',
      serverUrl: '',
      name: 'Manual lobby',
      hostName: 'Host',
      config: {
        modules: [{ id: 'base', version: BASE_VERSION }],
        seats: [0, 1],
        options: { base: { mapLayout: 'random', vpTarget: 3 } },
      },
    },
    {
      store: new MemoryEscrowLifecycleStore(),
      clock,
      acquireLease: async () => ({
        lockName: 'manual-accept-test',
        run: async <T>(task: () => T | PromiseLike<T>) => task(),
        close: async () => undefined,
      }),
      manualRtcFactory: () => {
        const pc = new ManualPc();
        manualPcs.push(pc);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Bounded bootstrap fake.
        return pc as unknown as RTCPeerConnection;
      },
      rtcFactory: () => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Bounded PeerLink fake.
        return new PeerLinkPc() as unknown as RTCPeerConnection;
      },
    },
  );
  let answer: Awaited<ReturnType<typeof answerManualOffer>> | null = null;
  try {
    const offer = await room.startManualInvitation();
    if (!offer.ok) throw new Error(offer.error.message);
    answer = await answerManualOffer(
      {
        self: guest.peerId,
        secretKey: guest.secretKey,
        scope: `lobby:${room.invite.roomId}`,
        clock,
        rtcFactory: () => {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Bounded bootstrap fake.
          return new ManualPc() as unknown as RTCPeerConnection;
        },
      },
      offer.value.code,
    );
    const first = room.acceptManualAnswer(answer.code);
    const duplicate = room.acceptManualAnswer(answer.code);
    const [accepted, duplicateResult] = await Promise.all([first, duplicate]);
    expect(accepted).toEqual({ ok: true, value: guest.peerId });
    expect(duplicateResult).toBe(accepted);
    expect(room.getSnapshot().manual.phase).toBe('answering');
    expect(manualPcs[0]?.closed).toBe(false);

    room.cancelManualInvitation();
    const nextOffer = await room.startManualInvitation(guest.peerId);
    if (!nextOffer.ok) throw new Error(nextOffer.error.message);
    const nextAnswer = await answerManualOffer(
      {
        self: guest.peerId,
        secretKey: guest.secretKey,
        scope: `lobby:${room.invite.roomId}`,
        clock,
        rtcFactory: () => {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Bounded bootstrap fake.
          return new ManualPc() as unknown as RTCPeerConnection;
        },
      },
      nextOffer.value.code,
    );
    const cancelled = room.acceptManualAnswer(nextAnswer.code);
    room.cancelManualInvitation();
    expect((await cancelled).ok).toBe(false);
    expect(room.getSnapshot().manual.phase).toBe('idle');
    const afterCancel = await room.startManualInvitation(guest.peerId);
    expect(afterCancel.ok).toBe(true);
    room.cancelManualInvitation();
    nextAnswer.bridge.close();
  } finally {
    await room.close();
    answer?.bridge.close();
    guest.secretKey.fill(0);
  }
});
