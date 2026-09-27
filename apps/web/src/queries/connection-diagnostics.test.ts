// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import {
  fetchSignalingHealth,
  testConnectivity,
  usePeerConnectionStats,
  useSignalingHealth,
} from './connection-diagnostics';
import type { ConnectivityTestDependencies } from './connection-diagnostics';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

class FakePeerConnection {
  iceGatheringState: RTCIceGatheringState = 'new';
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;
  closed = false;
  readonly channel = { closed: false, close: () => (this.channel.closed = true) };

  constructor(private readonly finishGathering: boolean) {}

  createDataChannel(): RTCDataChannel {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This fake only exposes the close operation used by the diagnostics probe.
    return this.channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'v=0' };
  }

  async setLocalDescription(): Promise<void> {
    if (!this.finishGathering) return;
    this.emitCandidate('candidate:1 1 udp 1 192.0.2.1 5000 typ host');
    this.emitCandidate('candidate:2 1 udp 1 198.51.100.1 5001 typ srflx');
    this.emitCandidate('candidate:3 1 udp 1 203.0.113.1 5002 typ relay');
    this.iceGatheringState = 'complete';
    this.onicegatheringstatechange?.();
    this.emitCandidate(null);
  }

  private emitCandidate(candidate: string | null): void {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fake only models candidate strings.
    const iceCandidate = candidate === null ? null : ({ candidate } as unknown as RTCIceCandidate);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fake only models candidate strings.
    this.onicecandidate?.({ candidate: iceCandidate } as unknown as RTCPeerConnectionIceEvent);
  }

  close(): void {
    this.closed = true;
  }
}

function dependencies(
  pc: FakePeerConnection,
  overrides: Partial<ConnectivityTestDependencies> = {},
): ConnectivityTestDependencies {
  return {
    loadSettings: async () => ({
      iceServers: [
        { urls: 'stun:stun.example.test:3478' },
        { urls: 'turn:turn.example.test:3478', username: 'test', credential: 'test' },
      ],
      iceTransportPolicy: 'all',
    }),
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Return the fake through the browser API seam.
    createPeerConnection: () => pc as unknown as RTCPeerConnection,
    timeoutMs: 50,
    ...overrides,
  };
}

describe('connection diagnostics', () => {
  test('checks the signaling server health endpoint with a bounded request', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('ok', { status: 200 }));
    const report = await fetchSignalingHealth('wss://signal.example.test', {
      fetcher,
      now: (() => {
        let time = 100;
        return () => (time += 12);
      })(),
    });

    expect(report).toEqual({ reachable: true, elapsedMs: 12 });
    expect(fetcher).toHaveBeenCalledWith(
      'https://signal.example.test/healthz',
      expect.objectContaining({ credentials: 'omit', redirect: 'error' }),
    );
    await expect(fetchSignalingHealth('https://signal.example.test')).rejects.toThrow(
      /WebSocket server origin/,
    );
  });

  test('aborts the health request when its query is cancelled', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          observedSignal = init?.signal ?? undefined;
          if (!observedSignal) throw new Error('Health request has no abort signal');
          observedSignal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const health = fetchSignalingHealth('wss://signal.example.test', {
      fetcher,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    controller.abort();
    await expect(health).rejects.toMatchObject({ name: 'AbortError' });
    expect(observedSignal?.aborted).toBe(true);
  });

  test('unmounting the health query immediately aborts its request', async () => {
    let observedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          observedSignal = init?.signal ?? undefined;
          observedSignal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client, children });
    const query = renderHook(() => useSignalingHealth('wss://signal.example.test'), { wrapper });
    await waitFor(() => expect(observedSignal).toBeDefined());
    query.unmount();
    expect(observedSignal?.aborted).toBe(true);
    client.clear();
  });

  test('peer stats polling stops when the diagnostics observer unmounts', async () => {
    vi.useFakeTimers();
    const loadStats = vi.fn<() => Promise<[]>>(async () => []);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client, children });
    const query = renderHook(() => usePeerConnectionStats('lobby-test', loadStats, true), {
      wrapper,
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loadStats).toHaveBeenCalledTimes(1);
    query.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(loadStats).toHaveBeenCalledTimes(1);
    client.clear();
  });

  test('reports observed host, STUN, and TURN candidates and closes its probe peer', async () => {
    const pc = new FakePeerConnection(true);
    const report = await testConnectivity(dependencies(pc));

    expect(report).toMatchObject({
      gatheringTimedOut: false,
      hostCandidates: 1,
      serverReflexiveCandidates: 1,
      relayCandidates: 1,
      stun: 'observed',
      turn: 'observed',
    });
    expect(pc.closed).toBe(true);
    expect(pc.channel.closed).toBe(true);
    expect(pc.onicecandidate).toBeNull();
    expect(pc.onicegatheringstatechange).toBeNull();
  });

  test('reports unobserved candidates without claiming the network blocks them', async () => {
    const pc = new FakePeerConnection(false);
    const report = await testConnectivity(dependencies(pc, { timeoutMs: 5 }));

    expect(report).toMatchObject({
      gatheringTimedOut: true,
      hostCandidates: 0,
      serverReflexiveCandidates: 0,
      relayCandidates: 0,
      stun: 'not-observed',
      turn: 'not-observed',
    });
    expect(pc.closed).toBe(true);
    expect(pc.channel.closed).toBe(true);
  });

  test('distinguishes an unconfigured TURN server from one configured but not observed', async () => {
    const pc = new FakePeerConnection(false);
    const report = await testConnectivity(
      dependencies(pc, {
        loadSettings: async () => ({
          iceServers: [],
          iceTransportPolicy: 'all',
        }),
        timeoutMs: 5,
      }),
    );

    expect(report).toMatchObject({ stun: 'not-configured', turn: 'not-configured' });
  });

  test('bounds settings loading before creating a peer connection', async () => {
    const createPeerConnection = vi.fn<(configuration: RTCConfiguration) => RTCPeerConnection>();
    await expect(
      testConnectivity({
        loadSettings: () => new Promise(() => undefined),
        createPeerConnection,
        settingsTimeoutMs: 5,
      }),
    ).rejects.toThrow(/settings did not load/);
    expect(createPeerConnection).not.toHaveBeenCalled();
  });

  test('cancellation closes the peer immediately while offer creation is still pending', async () => {
    const pc = new FakePeerConnection(false);
    let offerStarted!: () => void;
    const started = new Promise<void>((resolve) => (offerStarted = resolve));
    pc.createOffer = () => {
      offerStarted();
      return new Promise<RTCSessionDescriptionInit>(() => undefined);
    };
    const controller = new AbortController();
    const probe = testConnectivity(dependencies(pc, { signal: controller.signal }));
    await started;
    controller.abort();
    await expect(probe).rejects.toMatchObject({ name: 'AbortError' });
    expect(pc.closed).toBe(true);
    expect(pc.channel.closed).toBe(true);
    expect(pc.onicecandidate).toBeNull();
    expect(pc.onicegatheringstatechange).toBeNull();
  });

  test('cancellation while settings are loading does not create a peer', async () => {
    const controller = new AbortController();
    const createPeerConnection = vi.fn<(configuration: RTCConfiguration) => RTCPeerConnection>();
    const probe = testConnectivity({
      signal: controller.signal,
      loadSettings: () => new Promise(() => undefined),
      createPeerConnection,
    });
    controller.abort();
    await expect(probe).rejects.toMatchObject({ name: 'AbortError' });
    expect(createPeerConnection).not.toHaveBeenCalled();
  });
});
