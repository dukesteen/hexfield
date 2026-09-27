# Signaling review response

The [source review](server-review.md) covered the Node WebSocket host, room core
and browser adapter. These changes address its blocking findings.

- B1: a fresh signed socket challenge replaces an old connection for the same
  identity. The old socket receives `replaced`; the adapter treats that as
  terminal so two tabs cannot keep evicting each other. The host pings every
  15 seconds and terminates sockets that still owe a pong at the next tick.
  A stale socket's later disconnect cannot remove its replacement.
- B2: the client spaces signaling frames 50 ms apart. Up to 32 unsent frames
  wait for readiness or pacing, each with a ten-second deadline. A send resolves
  only after its socket write. The 31-frame regression observes one signal
  immediately, 20 before one second, and all 31 after 1.5 seconds.
- B3: the adapter measures both the inbound and forwarded UTF-8 frame, including
  nested JSON escaping. An exact 64 KiB forwarded frame passes; one extra byte
  and an escaped multibyte overflow fail before a socket write.
- B4: join tests now carry correctly shaped statements with a forged signature,
  the wrong signing key, another room, or a second valid join on the same socket.
  They reach the corresponding authentication and lifecycle checks.
- F1: after a failed roster send, removal announces the new membership and
  stops the obsolete outer announcement. A regression checks the survivors'
  final received roster.

Focused checks cover the real localhost relay, heartbeat, asynchronous send
failure, TTL refresh, byte limits, queued sends surviving reconnect and stale
socket events. The adapter exposes connecting, ready, retrying and closed
statuses. Permanent admission failures stop retries; transient failures retain
bounded exponential retry.

This is not deployment acceptance. Per-client abuse limits at the TLS proxy,
retry jitter, Cloudflare hibernation, manual signaling and lobby integration
remain unfinished. Generic signed envelopes can exceed the server route's
64 KiB limit; this adapter rejects those frames explicitly. The WebRTC layer
reports a signaling error, but the final UI still needs route-specific guidance.
No browser or cross-network result is claimed for this server slice.
