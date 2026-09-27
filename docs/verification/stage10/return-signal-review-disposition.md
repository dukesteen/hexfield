# Signed answer-to-offer review disposition

The read-only review used the pinned inputs in `return-signal-review-manifest.json`; its original response is `return-signal-review-raw.md`. This disposition describes the subsequent source delta.

1. **Current answer with a changed fingerprint — fixed.** Once authenticated, a signed answer bound to the outstanding offer but carrying a different DTLS fingerprint now closes the link with `fingerprint-changed`. A focused test exercises the current-offer case. Offers with a changed fingerprint remain ignored without replacing authenticated state.
2. **Revision reuse across PeerLink instances — not reachable through WebRtcTransport.** WebRtcTransport matches the signed `attemptId`, `sessionId`, and `attemptSeq` against the current primary or pending record _before_ forwarding a blob to PeerLink. A recreated local-origin link uses a fresh attempt ID; a remote-origin link is answer-only until authenticated. The attempt ID, not the per-link revision alone, scopes the answer. Transport tests cover stale attempts and replacement. No new offer-attempt field was added to the blob.
3. **Candidates following a dropped answer — fixed.** A rejected answer revision is recorded in `ignoredRevision`, so its later candidates cannot consume the bounded early-candidate budget. A focused delayed-candidate test verifies that the next bound answer receives only its own candidate.
4. **Candidate exact parsing — deferred low-severity hardening.** The signed envelope has a canonical whole-frame byte cap and PeerLink bounds candidate text; malformed candidates are caught by `addIceCandidate`. Stricter optional-field parsing is separate from the stale-answer correctness fix.

The signed signaling envelope is version 2. Version 1 envelopes fail strict parsing; no mixed-version fallback is claimed. PeerLink's focused suite passed 34/34 after the fixes, and scoped type-aware lint and formatting checks passed.
