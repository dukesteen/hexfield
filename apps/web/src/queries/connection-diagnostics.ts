import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { WebRtcPeerStats } from '@cp2p/p2p';
import { loadOnlineConnectionSettings } from './network';

const HEALTH_TIMEOUT_MS = 4_000;
const ICE_GATHER_TIMEOUT_MS = 12_000;

export interface SignalingHealth {
  readonly reachable: true;
  readonly elapsedMs: number;
}

export type CandidateObservation = 'observed' | 'not-observed' | 'not-configured';

export interface ConnectivityDiagnostic {
  readonly elapsedMs: number;
  readonly gatheringTimedOut: boolean;
  readonly hostCandidates: number;
  readonly serverReflexiveCandidates: number;
  readonly relayCandidates: number;
  readonly stun: CandidateObservation;
  readonly turn: CandidateObservation;
  readonly iceTransportPolicy: RTCIceTransportPolicy;
}

export interface ConnectionPeerStats {
  readonly label: string;
  readonly status: 'connected' | 'connecting' | 'disconnected';
  readonly rttMs?: number | null;
  readonly route?: 'host' | 'srflx' | 'relay' | 'unknown';
}

export interface ConnectivityTestDependencies {
  readonly loadSettings?: () => Promise<{
    iceServers: readonly RTCIceServer[];
    iceTransportPolicy: RTCIceTransportPolicy;
  }>;
  readonly createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection;
  readonly now?: () => number;
  readonly settingsTimeoutMs?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

function healthUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (
    (url.protocol !== 'ws:' && url.protocol !== 'wss:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  )
    throw new TypeError('Signaling address must be a WebSocket server origin');
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/healthz';
  return url.toString();
}

export async function fetchSignalingHealth(
  serverUrl: string,
  options: {
    readonly fetcher?: typeof fetch;
    readonly now?: () => number;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<SignalingHealth> {
  const endpoint = healthUrl(serverUrl);
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? HEALTH_TIMEOUT_MS);
  try {
    const response = await fetcher(endpoint, {
      method: 'GET',
      signal: controller.signal,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      headers: { Accept: 'text/plain' },
    });
    if (!response.ok) throw new Error(`Signaling health returned HTTP ${response.status}`);
    return { reachable: true, elapsedMs: Math.max(0, now() - startedAt) };
  } finally {
    controller.abort();
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function useSignalingHealth(serverUrl: string, enabled = true) {
  return useQuery({
    queryKey: ['signaling-health', serverUrl],
    queryFn: ({ signal }) => fetchSignalingHealth(serverUrl, { signal }),
    enabled: enabled && serverUrl !== '',
    staleTime: 15_000,
    retry: false,
  });
}

export function usePeerConnectionStats(
  queryKey: string,
  loadStats: (() => Promise<readonly WebRtcPeerStats[]>) | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: ['connection-peer-stats', queryKey],
    queryFn: () => {
      if (!loadStats) throw new Error('Peer statistics are unavailable');
      return loadStats();
    },
    enabled: enabled && loadStats !== undefined,
    staleTime: 1_000,
    refetchInterval: enabled && loadStats ? 3_000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

function iceUrls(server: RTCIceServer): readonly string[] {
  if (typeof server.urls === 'string') return [server.urls];
  return Array.isArray(server.urls) ? server.urls : [];
}

function candidateKind(candidate: string): 'host' | 'srflx' | 'relay' | null {
  return /\btyp\s+host\b/.test(candidate)
    ? 'host'
    : /\btyp\s+srflx\b/.test(candidate)
      ? 'srflx'
      : /\btyp\s+relay\b/.test(candidate)
        ? 'relay'
        : null;
}

function configuredObservation(configured: boolean, observed: boolean): CandidateObservation {
  if (!configured) return 'not-configured';
  return observed ? 'observed' : 'not-observed';
}

export async function testConnectivity(
  dependencies: ConnectivityTestDependencies = {},
): Promise<ConnectivityDiagnostic> {
  const loadSettings = dependencies.loadSettings ?? loadOnlineConnectionSettings;
  const createPeerConnection =
    dependencies.createPeerConnection ??
    ((configuration: RTCConfiguration) => new RTCPeerConnection(configuration));
  const now = dependencies.now ?? (() => performance.now());
  const settingsTimeoutMs = dependencies.settingsTimeoutMs ?? 10_000;
  const timeoutMs = dependencies.timeoutMs ?? ICE_GATHER_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(settingsTimeoutMs) ||
    settingsTimeoutMs < 1 ||
    settingsTimeoutMs > 30_000
  )
    throw new RangeError('Settings diagnostic timeout must be between 1 and 30000 ms');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new RangeError('ICE diagnostic timeout must be between 1 and 30000 ms');

  const startedAt = now();
  const signal = dependencies.signal;
  const throwIfAborted = (): void => {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('Diagnostic cancelled', 'AbortError');
    }
  };
  throwIfAborted();
  let settingsTimeout: ReturnType<typeof setTimeout> | undefined;
  let removeSettingsAbort: (() => void) | undefined;
  let connectionSettings: Awaited<ReturnType<typeof loadSettings>>;
  try {
    const settingsAborted = new Promise<never>((_resolve, reject) => {
      if (!signal) return;
      const rejectAbort = (): void =>
        reject(signal.reason ?? new DOMException('Diagnostic cancelled', 'AbortError'));
      if (signal.aborted) rejectAbort();
      else {
        signal.addEventListener('abort', rejectAbort, { once: true });
        removeSettingsAbort = () => signal.removeEventListener('abort', rejectAbort);
      }
    });
    connectionSettings = await Promise.race([
      loadSettings(),
      settingsAborted,
      new Promise<never>((_resolve, reject) => {
        settingsTimeout = setTimeout(
          () => reject(new Error('Connection settings did not load before diagnostic timeout')),
          settingsTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (settingsTimeout !== undefined) clearTimeout(settingsTimeout);
    removeSettingsAbort?.();
  }
  throwIfAborted();
  const pc = createPeerConnection({
    iceServers: [...connectionSettings.iceServers],
    iceTransportPolicy: connectionSettings.iceTransportPolicy,
  });
  let dataChannel: RTCDataChannel;
  try {
    dataChannel = pc.createDataChannel('connectivity-diagnostic');
  } catch (error) {
    pc.close();
    throw error;
  }
  const counts = { host: 0, srflx: 0, relay: 0 };
  let stopped = false;
  let timedOut = false;
  let removeGatherAbort: (() => void) | undefined;
  let resolveGathering!: () => void;
  let rejectGathering!: (reason: unknown) => void;
  const gathered = new Promise<void>((resolve, reject) => {
    resolveGathering = resolve;
    rejectGathering = reject;
  });
  const finish = (): void => {
    if (stopped) return;
    stopped = true;
    resolveGathering();
  };
  const closeResources = (): void => {
    pc.onicecandidate = null;
    pc.onicegatheringstatechange = null;
    dataChannel.close();
    pc.close();
  };
  const cancelGathering = (): void => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timeout);
    closeResources();
    rejectGathering(signal?.reason ?? new DOMException('Diagnostic cancelled', 'AbortError'));
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    finish();
  }, timeoutMs);
  pc.onicecandidate = (event) => {
    if (event.candidate === null) {
      finish();
      return;
    }
    const kind = candidateKind(event.candidate.candidate);
    if (kind) counts[kind] += 1;
  };
  pc.onicegatheringstatechange = () => {
    if (pc.iceGatheringState === 'complete') finish();
  };
  if (signal) {
    signal.addEventListener('abort', cancelGathering, { once: true });
    removeGatherAbort = () => signal.removeEventListener('abort', cancelGathering);
    if (signal.aborted) cancelGathering();
  }

  try {
    const gather = async (): Promise<void> => {
      throwIfAborted();
      const offer = await pc.createOffer();
      if (stopped) return;
      await pc.setLocalDescription(offer);
      if (stopped) return;
      if (pc.iceGatheringState === 'complete') finish();
      await gathered;
    };
    const setup = gather();
    void setup.catch((error: unknown) => {
      if (stopped) return;
      stopped = true;
      rejectGathering(error);
    });
    await gathered;
    const urls = connectionSettings.iceServers.flatMap(iceUrls);
    const hasStun = urls.some((url) => /^stuns?:/i.test(url));
    const hasTurn = urls.some((url) => /^turns?:/i.test(url));
    return {
      elapsedMs: Math.max(0, now() - startedAt),
      gatheringTimedOut: timedOut,
      hostCandidates: counts.host,
      serverReflexiveCandidates: counts.srflx,
      relayCandidates: counts.relay,
      stun: configuredObservation(hasStun, counts.srflx > 0),
      turn: configuredObservation(hasTurn, counts.relay > 0),
      iceTransportPolicy: connectionSettings.iceTransportPolicy,
    };
  } finally {
    clearTimeout(timeout);
    removeGatherAbort?.();
    stopped = true;
    closeResources();
  }
}

export function useTestConnectivity() {
  const activeController = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      activeController.current?.abort();
      activeController.current = null;
    },
    [],
  );
  return useMutation({
    mutationFn: async () => {
      activeController.current?.abort();
      const controller = new AbortController();
      activeController.current = controller;
      try {
        return await testConnectivity({ signal: controller.signal });
      } finally {
        if (activeController.current === controller) activeController.current = null;
      }
    },
  });
}
