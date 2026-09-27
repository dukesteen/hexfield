# Manual signaling and relay review brief

Review the exact source snapshot listed in `manual-relay-review-manifest.sha256`. The supplied source bundle contains only repository source and synthetic tests. Do not use tools, browse the repository, or request runtime data. Do not print any manual code, SDP, device identity, TURN credential, or browser storage value.

Find security and lifecycle defects in manual bootstrap, signed in-mesh signaling relay, the WebRTC authentication boundary, room manual-mode handoff, join and QR UI, and the TURN credentials client. Focus on:

- Whether an unseated peer, relay, or forged sender can expand the authorized roster or inject game traffic.
- Signed scope, recipient, attempt, answer-to-offer, expiry or retirement, replay, and reconnect handling.
- Candidate count and code size limits, SDP parsing, and any path that changes required negotiation evidence.
- Cancellation and async close races, including bootstrap-to-direct-link handoff and pending UI operations.
- TURN endpoint validation, credentials exposure or reuse, relay-only behavior, and cache expiry.

Report only actionable defects with severity, exact file and line, a concrete attack or failure sequence, and the missing or ineffective check. Point out relevant tests and limits on confidence. Avoid speculative platform failures and cosmetic advice. Do not modify files.
