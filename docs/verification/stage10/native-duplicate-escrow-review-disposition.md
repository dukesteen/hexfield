# Exact escrow retry review disposition

Claude approved the immutable source-only input with no correctness or security blockers. The archived input, manifest and raw response identify the reviewed bytes. Final source has one comment-only follow-up: coalescing a copy that arrives before readiness relies on the sender's existing roughly one-second retry. The final manifest separately pins that comment and the strengthened tests. No deadline or protocol authority changed.

The correction coalesces exact full bytes from the same transport sender while one handler is queued/running. A private accepted escrow cache is populated only after outer authentication, roster/owner checks, inner validation, durable slot acceptance and successful advance. Failed/rejected packets remain retryable. Different bytes follow the existing conflict path. Both caches clear on disposal/retirement; overflow follows normal validation. Accepted wires are limited to 32 entries, ingress to 128; each map retains at most 2 MiB.

Review notes addressed:

- Wrong-sender regression now observes the outer verifier and its rejection; it cannot mistake a cache hit for signature rejection.
- The conflicting-wire regression compares its reconstructed original directly to the actual occupied durable seed-commit slot before injecting different bytes.
- Ingress and `verifyOnlineCeremonyPacket` import the same `MAX_MESSAGE_BYTES`; verifier rejects oversized input at `online-ceremony-wire.ts:81`.
- The documented coalescing behavior uses existing retransmission if a first copy arrives before its phase can accept it.
- Optional changes to promotion identity, duplicate copying and finally ownership were not necessary for this approved correction. Clearing during retirement can remove a newer dedup entry, but any subsequent receive is already a no-op; validation authority is unaffected. The safe 32-entry bound is an upper bound, including both packet kinds across four possible dealer/holder seats.

Verification:

- Before-fix replay: eight exact previously accepted acknowledgements caused eight additional proof validations; `/private/tmp/hexfield-duplicate-escrow-before.log`.
- Full ceremony suite: 28 of 29 passed in 193.10 seconds. The new conflict test's error-string assertion was corrected; its retirement check already passed. `/private/tmp/hexfield-duplicate-escrow-full.log`.
- Final strengthened two-case run: both passed in 10.03 seconds, including wrong-sender outer rejection, byte-distinct conflict retirement, repeated invalid packets and transient durable write retry. `/private/tmp/hexfield-duplicate-escrow-reviewed-regressions.log`.
- Scoped type-aware lint and formatting checks passed. Final scoped TypeScript check passed after the test strengthening (`/private/tmp/hexfield-duplicate-scoped-typecheck-reviewed.log`). Shared TypeScript currently has unrelated optional-method errors in `testing/verified-network-fixture.test.ts:116,123`.

The source approval and deterministic reduction do not establish native startup speed, default 10-VP completion, second recovery or three terminal audits. Those acceptance gates remain open until a separately pinned native trace completes.
