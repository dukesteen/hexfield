import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, test, vi } from 'vitest';
import * as v from 'valibot';
import {
  DEFAULT_NETWORK_SETTINGS,
  deploymentNetworkDefaults,
  effectiveNetworkSettings,
  networkSettingsSchema,
} from './network-config';
import {
  fetchTurnCredentials,
  loadOnlineConnectionSettings,
  turnCredentialsQuery,
} from './network';
import { DEFAULT_SETTINGS } from './repositories/settings';
import type { SettingsRepository } from './repositories/settings';

const clients: QueryClient[] = [];
afterEach(() => {
  for (const client of clients) client.clear();
  clients.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeClient() {
  const result = new QueryClient();
  clients.push(result);
  return result;
}

function response(ttl = 300) {
  return {
    iceServers: [
      {
        urls: 'turns:relay.example.org:5349?transport=tcp',
        username: 'test',
        credential: 'fixture-only',
      },
    ],
    ttl,
  };
}

test('validates ICE URLs and requires usable TURN settings for relay-only mode', () => {
  expect(v.parse(networkSettingsSchema, DEFAULT_NETWORK_SETTINGS)).toEqual(
    DEFAULT_NETWORK_SETTINGS,
  );
  expect(
    v.safeParse(networkSettingsSchema, { ...DEFAULT_NETWORK_SETTINGS, iceTransportPolicy: 'relay' })
      .success,
  ).toBe(false);
  const relay = {
    ...DEFAULT_NETWORK_SETTINGS,
    turn: { urls: ['turn:[::1]:3478?transport=udp'], username: 'test', credential: 'fixture-only' },
    iceTransportPolicy: 'relay',
  };
  expect(v.safeParse(networkSettingsSchema, relay).success).toBe(true);
  for (const url of [
    'https://relay.example.org',
    'turn:example.org:99999',
    'turn:user:secret@example.org',
    'turns:example.org?transport=udp',
  ])
    expect(
      v.safeParse(networkSettingsSchema, { ...relay, turn: { ...relay.turn, urls: [url] } })
        .success,
    ).toBe(false);
  expect(
    v.safeParse(networkSettingsSchema, {
      ...relay,
      turnCredentialsUrl: 'http://remote.example.org/credentials',
    }).success,
  ).toBe(false);
});

test('deployment URLs are validated and empty saved defaults inherit them without replacing custom settings', () => {
  const deployed = deploymentNetworkDefaults({
    VITE_SIGNALING_URL: 'wss://hexfield.steenbakkers.cc',
    VITE_TURN_CREDENTIALS_URL: 'https://hexfield.steenbakkers.cc/api/turn',
  });
  expect(deployed.signalingUrl).toBe('wss://hexfield.steenbakkers.cc');
  expect(deployed.turnCredentialsUrl).toBe('https://hexfield.steenbakkers.cc/api/turn');
  expect(deployed.stunUrls).toContain('stun:stun.cloudflare.com:3478');
  expect(() =>
    deploymentNetworkDefaults({ VITE_SIGNALING_URL: 'https://not-a-websocket.example' }),
  ).toThrow('Invalid input');
  expect(() =>
    deploymentNetworkDefaults({ VITE_TURN_CREDENTIALS_URL: 'http://remote.example/turn' }),
  ).toThrow('Use HTTPS');

  const original = deploymentNetworkDefaults({});
  expect(effectiveNetworkSettings(original, deployed)).toMatchObject({
    signalingUrl: deployed.signalingUrl,
    turnCredentialsUrl: deployed.turnCredentialsUrl,
  });
  expect(
    effectiveNetworkSettings(
      {
        ...original,
        signalingUrl: 'wss://custom.example',
        turnCredentialsUrl: 'https://custom.example/turn',
      },
      deployed,
    ),
  ).toMatchObject({
    signalingUrl: 'wss://custom.example',
    turnCredentialsUrl: 'https://custom.example/turn',
  });
  expect(
    effectiveNetworkSettings(
      {
        ...original,
        turnCredentialsUrl: '',
        turn: { urls: ['turn:custom.example:3478'], username: 'u', credential: 'c' },
      },
      deployed,
    ).turnCredentialsUrl,
  ).toBe('');
});

test('loads only bounded, validated temporary credentials without ambient cookies or redirects', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(response()));
  const credentials = await fetchTurnCredentials(
    'https://operator.example.org/turn',
    undefined,
    fetcher,
    () => 1000,
  );
  expect(credentials.expiresAt).toBe(301_000);
  expect(fetcher).toHaveBeenCalledWith(
    'https://operator.example.org/turn',
    expect.objectContaining({ credentials: 'omit', redirect: 'error', cache: 'no-store' }),
  );
  await expect(
    fetchTurnCredentials('http://remote.example.org/turn', undefined, fetcher),
  ).rejects.toThrow('Use HTTPS');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(
    fetchTurnCredentials(
      'https://operator.example.org/turn',
      undefined,
      async () => new Response('x'.repeat(32 * 1024 + 1)),
    ),
  ).rejects.toThrow('too large');
  await expect(
    fetchTurnCredentials('https://operator.example.org/turn', undefined, async () =>
      Response.json({ ...response(), ttl: 0 }),
    ),
  ).rejects.toThrow('>=1');
  await expect(
    fetchTurnCredentials(
      'https://operator.example.org/turn',
      undefined,
      async () => new Response('', { status: 503 }),
    ),
  ).rejects.toThrow('could not be loaded');
});

test('caches temporary credentials until sixty seconds before their expiry', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(response(300)));
  vi.stubGlobal('fetch', fetcher);
  const queries = makeClient();
  const options = turnCredentialsQuery('https://operator.example.org/turn');
  await queries.fetchQuery(options);
  now.mockReturnValue(300_000);
  await queries.fetchQuery(options);
  expect(fetcher).toHaveBeenCalledTimes(1);
  now.mockReturnValue(341_000);
  await queries.fetchQuery(options);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('passes relay-only TURN settings without adding STUN servers', async () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    network: {
      ...DEFAULT_NETWORK_SETTINGS,
      turn: { urls: ['turn:relay.example.org:3478'], username: 'test', credential: 'fixture-only' },
      iceTransportPolicy: 'relay' as const,
    },
  };
  const repository: SettingsRepository = {
    get: async () => settings,
    update: async () => {
      throw new Error('Not used');
    },
    claimStoragePersistenceRequest: async () => false,
  };
  const configuration = await loadOnlineConnectionSettings(makeClient(), repository);
  expect(configuration).toEqual({
    iceServers: [settings.network.turn],
    iceTransportPolicy: 'relay',
  });
  expect(
    configuration.iceServers.some((server) => JSON.stringify(server.urls).includes('stun:')),
  ).toBe(false);
});
