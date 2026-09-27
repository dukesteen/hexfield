# Running a TURN server

Hexfield uses WebRTC DataChannels. Direct ICE paths may fail across restrictive networks, so operators can provide a TURN relay. The app has no default TURN server. Its network settings accept static TURN credentials or an HTTPS endpoint that issues temporary credentials. A TURN server carries encrypted WebRTC traffic, but it still sees connection metadata and consumes bandwidth.

## Coturn

Install coturn from your operating system package or the [coturn project](https://github.com/coturn/coturn). Give it a DNS name such as `turn.example.org` and a TLS certificate for that name. The following is a template for `turnserver.conf`, using coturn's [configuration reference](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf):

```ini
listening-port=3478
tls-listening-port=5349
realm=turn.example.org
fingerprint
use-auth-secret
static-auth-secret=REPLACE_WITH_A_PRIVATE_RANDOM_SECRET
cert=/etc/letsencrypt/live/turn.example.org/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.org/privkey.pem
min-port=49160
max-port=49360
no-cli
no-multicast-peers
user-quota=16
total-quota=256
```

Replace the example secret before starting coturn. Generate it with a cryptographic random source, keep the config readable only by the service administrator and coturn process, and never put the shared secret in the browser settings or this repository. Coturn's `use-auth-secret` mode checks temporary credentials derived from that secret; `realm` is required for this authentication mode. Do not combine `use-auth-secret` with `user=` or `lt-cred-mech` as a second authentication mode. Coturn documents these modes as alternatives. [Coturn configuration reference](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)

Start the server with `turnserver -c /etc/turnserver.conf`, or use your distribution's coturn service with that config file. Keep the service under an account that can read its TLS key and config. Coturn documents the [`-c` config option](https://github.com/coturn/coturn/blob/master/man/man1/turnserver.1).

Open the chosen listener ports, normally UDP/TCP 3478 and TCP 5349, and the configured UDP relay port range on both the host firewall and any upstream firewall. The relay port range must accommodate concurrent allocations; increase it for more rooms. If coturn sits behind NAT, set `external-ip=<public-ip>/<private-ip>` and forward relay ports without changing their numbers. The [coturn network options](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf) describe the mapping requirement. Protect the TLS private key and renew the certificate. `turns:turn.example.org:5349?transport=tcp` needs the TLS listener and a certificate trusted by the browser. `turn:turn.example.org:3478?transport=udp` uses the UDP listener.

The sample quotas are starting limits, not sizing advice for a production deployment. A six-person room can create up to five peer connections per device. Monitor allocations, bandwidth and failures, then size `user-quota`, `total-quota` and the relay port range for your actual concurrency. A shared static username aggregates all devices under one user quota. Coturn's [quota and port options](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf) define these controls.

## Give the app credentials

In **Settings → Network → Advanced**, enter one or more TURN URLs. The client accepts `turn:` and `turns:` URLs with an optional port and `?transport=udp|tcp`; `turns:` with UDP transport is rejected. It accepts at most eight TURN URLs per server entry. These URLs are separate from the signaling server URL.

For a private deployment with a small, trusted set of devices, coturn can instead use long-term credentials: replace `use-auth-secret` and `static-auth-secret` with `lt-cred-mech` and a `user=<name>:<password>` entry, then put that ordinary TURN username and password in the app's static TURN fields. This password is persisted in the browser's IndexedDB settings, so anyone with access to that browser profile can recover and reuse it. Do not put coturn's REST shared secret there. Coturn documents the [static user form](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf).

For a public deployment, configure **TURN credentials endpoint** instead. The app makes a `GET` request with `Accept: application/json`, omits cookies, rejects redirects, uses `cache: no-store`, and times out after eight seconds. The endpoint must be HTTPS, except that HTTP is accepted for localhost, 127.0.0.1 or ::1 development. If it is on another origin, send an explicit `Access-Control-Allow-Origin` for the app origin. CORS is not authentication; the current client sends no auth header or cookie. Rate-limit issuance and control coturn allocation quotas.

For example, return this JSON shape:

```json
{
  "iceServers": [
    {
      "urls": [
        "turn:turn.example.org:3478?transport=udp",
        "turns:turn.example.org:5349?transport=tcp"
      ],
      "username": "<expiry-unix-seconds>:<opaque-id>",
      "credential": "BASE64_HMAC_SHA1"
    }
  ],
  "ttl": 7200
}
```

The example username and credential are placeholders. In coturn REST mode, make `username` the Unix expiry time in seconds, followed by `:<opaque-id>`. Set `credential` to standard Base64 of HMAC-SHA1 over that _entire username_, keyed by the server-side shared secret. Return `ttl` as the remaining valid seconds, no greater than the expiry minus current server time. This HMAC format is coturn's [documented TURN REST API](https://github.com/coturn/coturn/blob/master/man/man1/turnserver.1), not a custom Hexfield credential scheme.

The client requires one to eight `iceServers`; each entry needs one to eight valid TURN URLs, a nonempty username and credential. It accepts an integer `ttl` from 1 to 86,400 seconds and caps the entire response at 32 KiB. It fetches credentials before opening the room, checks that they have not expired, and considers cached credentials stale 60 seconds before expiry. Request time counts against the lifetime. These limits come from [the client schema](../../apps/web/src/queries/network-config.ts) and [fetch path](../../apps/web/src/queries/network.ts).

While the room is open, the [RTC configuration owner](../../apps/web/src/session/online-ice.ts) refreshes temporary credentials before expiry and updates existing peer connections so later ICE restarts use them. New manual and normal peer connections use the same refreshed settings. A failed refresh retries every five seconds without closing an established game link; it refuses to create a new connection using expired credentials. Closing the room stops refresh work. Use a practical lifetime such as the two-hour example: very short tokens cause frequent endpoint requests and leave less time to recover from a network outage. Credentials remain in memory rather than being added to the saved game.

## Verify the relay

Save the network settings, set **Connection policy** to **Relay only**, then open the lobby's **Connection** panel and run **Test connectivity**. A relay candidate confirms that this browser could allocate through the configured TURN server. The local diagnostic does not prove a peer-to-peer path. Join from a second network and confirm both devices connect and the peer route reports relay. Return the policy to **Direct or relay** if you want ICE to prefer a direct path when available. With relay-only selected, the client omits the configured STUN servers but still passes TURN servers to WebRTC.

If no relay candidate appears, check the endpoint response and expiry, coturn authentication mode and realm, DNS/TLS certificate, listener and UDP relay firewall ports, and the public/private address mapping. Do not paste real TURN credentials, shared secrets or full ICE candidate lines into issue reports; candidate lines can contain IP addresses.
