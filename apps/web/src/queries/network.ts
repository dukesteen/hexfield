import { queryOptions, useQuery } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import * as v from 'valibot';
import {
  effectiveNetworkSettings,
  networkSettingsSchema,
  turnCredentialsEndpointSchema,
  turnCredentialsResponseSchema,
} from './network-config';
import { getWebRepositories } from './hooks';
import { queryKeys } from './keys';
import { queryClient as browserQueryClient } from '../queryClient';
import type { SettingsRepository } from './repositories/settings';

const MAX_RESPONSE_BYTES = 32 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;

export interface TurnCredentials {
  readonly iceServers: readonly RTCIceServer[];
  readonly expiresAt: number;
}

export interface OnlineConnectionSettings {
  readonly iceServers: readonly RTCIceServer[];
  readonly iceTransportPolicy: RTCIceTransportPolicy;
  readonly expiresAt?: number;
}

async function boundedText(response: Response): Promise<string> {
  const declared = response.headers.get('Content-Length');
  if (declared && Number(declared) > MAX_RESPONSE_BYTES)
    throw new Error('TURN credentials response is too large');
  if (!response.body) throw new Error('TURN credentials response is empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- Enforce the limit before reading another response chunk.
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('TURN credentials response is too large');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Only the endpoint explicitly configured on this device receives this request. */
export async function fetchTurnCredentials(
  endpoint: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<TurnCredentials> {
  const url = v.parse(turnCredentialsEndpointSchema, endpoint);
  if (!url) throw new Error('No TURN credentials endpoint is configured');
  const abort = new AbortController();
  const cancel = () => abort.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) abort.abort();
  const requestedAt = now();
  const timeout = setTimeout(cancel, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      signal: abort.signal,
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error('TURN credentials could not be loaded');
    const payload: unknown = JSON.parse(await boundedText(response));
    const checked = v.parse(turnCredentialsResponseSchema, payload);
    // Count request time against the token lifetime instead of extending a
    // short-lived credential by however long the response took to arrive.
    return { iceServers: checked.iceServers, expiresAt: requestedAt + checked.ttl * 1_000 };
  } finally {
    abort.abort();
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

export function turnCredentialsQuery(endpoint: string) {
  return queryOptions({
    queryKey: queryKeys.turnCredentials(endpoint),
    queryFn: ({ signal }) => fetchTurnCredentials(endpoint, signal),
    staleTime: (query) =>
      Math.max(0, (query.state.data?.expiresAt ?? 0) - query.state.dataUpdatedAt - 60_000),
    retry: false,
    gcTime: 5 * 60_000,
    enabled: endpoint !== '',
  });
}

export function useTurnCredentials(endpoint: string) {
  return useQuery(turnCredentialsQuery(endpoint));
}

/** Resolve device settings immediately before creating peer connections. */
export async function loadOnlineConnectionSettings(
  client: QueryClient = browserQueryClient,
  repository: SettingsRepository = getWebRepositories().settings,
): Promise<OnlineConnectionSettings> {
  const saved = await client.fetchQuery({
    queryKey: queryKeys.settings(),
    queryFn: () => repository.get(),
    staleTime: 0,
  });
  const network = effectiveNetworkSettings(v.parse(networkSettingsSchema, saved.network));
  const servers: RTCIceServer[] = [];
  if (network.iceTransportPolicy === 'all' && network.stunUrls.length > 0)
    servers.push({ urls: network.stunUrls });
  if (network.turn.urls.length > 0) servers.push(network.turn);
  let expiresAt: number | undefined;
  if (network.turnCredentialsUrl) {
    const credentials = await client.fetchQuery(turnCredentialsQuery(network.turnCredentialsUrl));
    if (credentials.expiresAt <= Date.now()) throw new Error('TURN credentials have expired');
    servers.push(...credentials.iceServers);
    expiresAt = credentials.expiresAt;
  }
  return {
    iceServers: servers,
    iceTransportPolicy: network.iceTransportPolicy,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}
