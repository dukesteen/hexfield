# Review: answer→offer binding (signaling envelope v2 + PeerLink)

The core binding is sound for a single PeerLink instance. It holds across glare (polite rollback clears `localOfferRevision` at `:244`; the impolite side keeps its pin), manual answer-only (no pin before authentication, so every answer is dropped), ICE restart within a link, duplicate or fresh revisions, and the async answer window.

I found one likely defect, one conditional defect, one low-severity parser gap, and some missing tests.

## 1. A bound but mismatched answer after authentication wedges the link (likely defect)

**Where:** `packages/p2p/src/peer-link.ts:218-229`

**What happens:**
- After authentication, an answer whose `inReplyTo` matches the outstanding offer but whose `applicationFingerprint` differs is silently dropped.
- Before this change, dropping was a reasonable response to a possibly stale answer.
- Now the signed `inReplyTo` proves the answer is current. A fingerprint change is therefore a peer or DTLS identity change, not staleness.
- The link stays in `have-local-offer` indefinitely. `negotiationneeded` won't fire again, so ICE restart and renegotiation can never complete. No `fail` is raised.

**Fix:** When `description.type === 'answer'` and the fingerprint differs, call `this.fail('negotiation-error')` (or a dedicated identity reason) instead of `return`. Keep the silent drop for offers.

**Test:** Authenticate, trigger `negotiationneeded`, then send an answer with `inReplyTo` equal to the offer revision but a different fingerprint. Expect `leftDown` to contain the failure.

## 2. The binding is only as unique as `localRevision`, which restarts per PeerLink (conditional defect)

**Where:** `peer-link.ts:330-333`, `signaling-envelope.ts:15-19`, `web-rtc-transport.ts:590-608`

**What happens:**
- `inReplyTo` names a revision in the offerer's per-link counter, and that counter starts at 0 in each new PeerLink.
- The answer's envelope carries the answerer's `attemptId`, `sessionId` and `attemptSeq`. Nothing in the answer identifies which offerer link or attempt it answers.
- Suppose the local side replaces its link for a peer while the remote side is still in its old attempt. An in-flight answer to the old link's offer rev 1 can then satisfy the new link's offer rev 1.
- That answer would pass the signature check, the generation check (if generation is per peer rather than per attempt), and `inReplyTo`. It is the same stale-answer class, moved across link instances.

**Why conditional:** From these excerpts I can't see whether the transport rejects the remote's pre-recreation `attemptId`/`attemptSeq`, or whether the answerer echoes the offerer's `attemptId` and the receiver requires equality.

**Fix, if it isn't already covered:** Bind to an offerer-chosen value, not just a counter. The smallest change inside v2 is to sign `inReplyTo` together with the offerer's attempt ID. For example, add `replyToAttemptId` next to `inReplyTo` in answer blobs, validate it with `validAttemptId`, and compare it to the link's own `attemptId` in PeerLink.

**Test:** Recreate the local link for the same peer and generation, then deliver an answer with `inReplyTo: 1` produced for the old link. It must be dropped.

## 3. Candidates for a dropped answer's revision are re-buffered (minor)

**Where:** `peer-link.ts:209-217` and `:277-295`

**What happens:**
- On an `inReplyTo` mismatch, only candidates already buffered under that key are deleted.
- The dropped revision isn't recorded anywhere. Trickle candidates for it that arrive afterwards (the normal order) pass the check at `:277` and are buffered again.
- They occupy the `MAX_EARLY_CANDIDATES` budget until the next accepted description clears the buffer at `:248`.
- If the relay reorders messages, this can crowd out early candidates for the correct answer.

**Fix:** In the mismatch branch, mirror the ignored-offer path:
```ts
this.ignoredRevision = Math.max(this.ignoredRevision, blob.revision);
```
This touches only candidate filtering, not `remoteRevision`, `remoteGeneration` or authentication state. If blocking earlier revisions is a concern, use a small bounded set of dropped revisions instead of the max.

**Test:** Drop an answer at rev R, deliver candidates for R, then deliver the correct answer at R+1 plus its early candidates. Only R+1's candidates should be added.

## 4. Candidate objects are not exact-parsed (low)

**Where:** `packages/p2p/src/signaling-envelope.ts:116-122`

Every other level of the envelope uses `exact()`, but `blob.candidate` accepts arbitrary extra keys and untyped `sdpMid`/`sdpMLineIndex`/`usernameFragment`. The overall size cap bounds this, and `addIceCandidate` errors are caught, so it isn't exploitable. It is inconsistent with a signed, canonical parser.

**Fix:** Allow only keys in `['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment']`, requiring:
- `sdpMid`: string or null
- `sdpMLineIndex`: non-negative safe integer or null
- `usernameFragment`: string or null, capped at a small length

## Size bounds

These are fine. `sdp.length` counts UTF-16 units rather than bytes, but `canonicalEncode(...) <= 70_000` (`signaling-envelope.ts:125`) enforces the real byte bound. A maximum-length ASCII SDP plus envelope overhead still fits.

The duplicated literals in `peer-link.ts:204` and `:274` could import the envelope constants, but that is cosmetic.

## Missing tests (add any that don't already exist)

- **Glare, stale answer to a rolled-back offer:** the polite peer has offer rev N, accepts the impolite offer (rollback), then receives an answer with `inReplyTo: N`. It must be dropped with no failure. Neighbouring tests check glare state but not this.
- **No generation pinning from a dropped answer:** the first description received is a mismatched answer with `generation: 2`, followed by a valid `generation: 1` answer. The second must be accepted, proving `:230` wasn't reached.
- **Envelope parser rejections** (`signaling-envelope.test.ts`):
  - an offer carrying `inReplyTo`
  - an answer missing `inReplyTo`
  - `inReplyTo` of `0`, `1.5`, `"1"`, or above `MAX_SAFE_INTEGER`
- **ICE restart with authentication:** the `peer-link.test.ts:879` scenario runs before authentication. Repeat it after authentication with same-fingerprint answers, so the pinned-revision check and the fingerprint check are covered together.
