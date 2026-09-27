import * as v from 'valibot';

function serverOrigin(value: string): boolean {
  if (value === '') return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'ws:' || url.protocol === 'wss:') &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/'
    );
  } catch {
    return false;
  }
}

function credentialsEndpoint(value: string): boolean {
  if (value === '') return true;
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return (
      (url.protocol === 'https:' || (local && url.protocol === 'http:')) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/** ICE URLs are not ordinary web URLs; credentials live in separate fields. */
function iceUrl(value: string, kind: 'stun' | 'turn'): boolean {
  const match =
    /^(stun|stuns|turn|turns):(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?(?:\?transport=(udp|tcp))?$/.exec(
      value,
    );
  if (!match) return false;
  const [, scheme, host, port, transport] = match;
  if (!scheme?.startsWith(kind) || !host) return false;
  if (kind === 'stun' && transport) return false;
  if (scheme === 'turns' && transport === 'udp') return false;
  if (port && (Number(port) < 1 || Number(port) > 65_535)) return false;
  try {
    const parsed = new URL(`https://${host}/`);
    return !!parsed.hostname && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export const stunUrlSchema = v.pipe(
  v.string(),
  v.maxLength(512),
  v.check((value) => iceUrl(value, 'stun'), 'Enter a valid stun: or stuns: URL'),
);
export const turnUrlSchema = v.pipe(
  v.string(),
  v.maxLength(512),
  v.check((value) => iceUrl(value, 'turn'), 'Enter a valid turn: or turns: URL'),
);
export const turnCredentialsEndpointSchema = v.pipe(
  v.string(),
  v.maxLength(2048),
  v.check(credentialsEndpoint, 'Use HTTPS for the TURN credentials endpoint'),
);

const staticTurnSchema = v.strictObject({
  urls: v.pipe(v.array(turnUrlSchema), v.maxLength(8)),
  username: v.pipe(v.string(), v.maxLength(512)),
  credential: v.pipe(v.string(), v.maxLength(2048)),
});

export const networkSettingsSchema = v.pipe(
  v.strictObject({
    signalingUrl: v.pipe(v.string(), v.maxLength(2048), v.check(serverOrigin)),
    stunUrls: v.pipe(v.array(stunUrlSchema), v.maxLength(8)),
    turn: staticTurnSchema,
    turnCredentialsUrl: turnCredentialsEndpointSchema,
    iceTransportPolicy: v.picklist(['all', 'relay']),
  }),
  v.check(
    (value) =>
      value.turn.urls.length === 0 || (!!value.turn.username.trim() && !!value.turn.credential),
    'TURN servers need a username and credential',
  ),
  v.check(
    (value) =>
      value.iceTransportPolicy !== 'relay' ||
      value.turn.urls.length > 0 ||
      value.turnCredentialsUrl !== '',
    'Relay-only connections need a TURN server',
  ),
);

export type NetworkSettings = v.InferOutput<typeof networkSettingsSchema>;

export function deploymentNetworkDefaults(environment: {
  readonly VITE_SIGNALING_URL?: string;
  readonly VITE_TURN_CREDENTIALS_URL?: string;
}): NetworkSettings {
  return v.parse(networkSettingsSchema, {
    signalingUrl: environment.VITE_SIGNALING_URL ?? '',
    stunUrls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'],
    turn: { urls: [], username: '', credential: '' },
    turnCredentialsUrl: environment.VITE_TURN_CREDENTIALS_URL ?? '',
    iceTransportPolicy: 'all',
  });
}

export const DEFAULT_NETWORK_SETTINGS = deploymentNetworkDefaults({
  VITE_SIGNALING_URL: import.meta.env.VITE_SIGNALING_URL,
  VITE_TURN_CREDENTIALS_URL: import.meta.env.VITE_TURN_CREDENTIALS_URL,
});

/** Older saved defaults may be empty; explicit nonempty device settings take precedence. */
export function effectiveNetworkSettings(
  saved: NetworkSettings,
  defaults: NetworkSettings = DEFAULT_NETWORK_SETTINGS,
): NetworkSettings {
  const useSavedTurn = saved.turnCredentialsUrl !== '' || saved.turn.urls.length > 0;
  return v.parse(networkSettingsSchema, {
    ...saved,
    signalingUrl: saved.signalingUrl || defaults.signalingUrl,
    turnCredentialsUrl: useSavedTurn ? saved.turnCredentialsUrl : defaults.turnCredentialsUrl,
  });
}

const endpointIceServerSchema = v.strictObject({
  urls: v.union([turnUrlSchema, v.pipe(v.array(turnUrlSchema), v.minLength(1), v.maxLength(8))]),
  username: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  credential: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
});

/** A user-operated endpoint returns short-lived TURN credentials and their remaining TTL. */
export const turnCredentialsResponseSchema = v.strictObject({
  iceServers: v.pipe(v.array(endpointIceServerSchema), v.minLength(1), v.maxLength(8)),
  ttl: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(86_400)),
});
