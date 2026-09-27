# Chrome check after reconnect fixes

On 2026-09-27 the coordinator used the existing Chrome session to open
`http://127.0.0.1:5187/dev/webrtc-smoke.html` and click Run. Vite had been restarted
to clear stale transformed modules. The [source manifest](chromium-reconnect-smoke-manifest.json)
was captured before the run and remained unchanged afterward.

The completed page displayed:

```text
PASS all six native links authenticated
PASS small message and 1 MiB bulk pattern delivered
PASS lost pair reauthenticated once
PASS Chrome iframe smoke complete
```

The Run button was enabled again after cleanup. No separate browser process was
launched. This validates native WebRTC in four same-origin iframe globals in one
Chrome tab. It does not establish isolation across browser processes,
cross-browser interoperability, TURN routing, cross-network behavior or the
signaling-server adapter. The forced lost-pair browser check is symmetric;
asymmetric failure and delayed negotiation have focused unit regressions.

This run includes signed session/attempt sequencing, bounded early candidates,
the pre-auth deadline and the peer-link backpressure and HELLO fixes. The
follow-up security review and remaining Stage 08 acceptance checks are still
required.
