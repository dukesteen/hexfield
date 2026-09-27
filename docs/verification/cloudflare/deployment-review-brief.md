# Cloudflare deployment review brief

Review the pinned source snapshot as text. Tools are disabled. Do not inspect the checkout or infer account state. The bundle contains no actual TURN token, device identity, browser save, room code or WebRTC payload. The account ID and hostname in Wrangler are public configuration.

The Worker serves a public friends-beta app. Its room WebSocket endpoint has a signed challenge join. Its public TURN endpoint has a Cloudflare rate-limit binding configured at 10 requests per minute per IP, a global Durable Object budget of 200 issued credentials per UTC day, and two-hour credentials. The rate-limit binding is an abuse throttle, not exact accounting; the Durable Object budget is intended as the hard issuance cap.

Find concrete security or lifecycle defects in:

- Durable Object hibernation restoration, challenge replay, per-socket message rate state, room expiry, attachment validation and oversized signaling.
- TURN upstream routing, response bounds, TTL, quota reservation/refund, error handling and credential leakage.
- Wrangler deployment routing, Workers assets fallback and browser network defaults.

Give each finding a reproducible trace, source line, severity and narrow correction. Separate confirmed defects from platform behavior that needs a real Worker test. Do not propose authentication for the deliberately public TURN endpoint or broader product features.
