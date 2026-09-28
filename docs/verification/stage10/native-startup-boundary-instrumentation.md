# Native startup boundary diagnostic

This isolated startup-only variant runs with `CP2P_NATIVE_STARTUP_ONLY=1`, caps the test at 120 seconds, and returns immediately after all four contexts reach game routes. It retains the durable 20-second ceremony phases. It cannot establish departure, takeover, return, a command from either replacement authority, terminal completion or audits. The manifest pins actual isolated runtime files; the patch records instrumentation relative to main source.

Every packet boundary uses SHA256 of the exact complete packet bytes and a common `performance.timeOrigin + performance.now()` epoch timestamp. Logs include only public digest, size, device/peer, phase/step and queue/visibility measurements. Digest/stage events are deduplicated; coordinator and worker-bridge caps are 256, each PeerLink cap is 192, and existing phase/proof telemetry remains capped at 200 per coordinator.

Boundaries: signed packet encoding; local validation and durable put completion; coordinator transport send; main bridge send; PeerLink framing/enqueue; actual final RTC frame send; final RTC onmessage entry and complete-message reassembly; main bridge receive; worker-port delivery; coordinator enqueue; queued handler entry; outer verification; exact-slot validated durable acceptance. Sender final-frame metadata follows the existing frame object through the queue in a WeakMap; it does not affect routing or framing. Reassembly logs retain the final RTC callback entry time. Cached prefix hits are counted without per-hit logging and summarized at consent/retirement. Context visibility/focus is captured before ceremony launch.

Final isolated TypeScript test check passed. No native result is claimed before the trace completes.
