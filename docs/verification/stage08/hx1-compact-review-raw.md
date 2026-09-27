# HX1 compact wire review

**Summary:** I found no proven signature bypass, binding bypass, or line-dropping bug. The per-field wire layer is canonical because `decodeManualCode` re-encodes and compares bytes. The deflate layer is not canonical. There are two encode/decode asymmetries that make `encodeManualCode` emit codes that cannot be decoded. Both come from one gap: the encoder never checks its own round-trip.

## Proven findings

### 1. Deflate layer accepts many HX1 strings for one signed body
**Where:** `manual-code.ts` → `decodeManualCode` / `transform`

**Counterexample:** Take any valid code. Decompress it to `W`, then re-deflate `W` as stored blocks (BTYPE=00), or with a different compression level or block split. Base64url the result and prefix `HX1.`. That string is different but is also canonical base64url. `DecompressionStream` yields the same `W`, the byte-compare against `wireBytes` passes, and the signature verifies. The base64 canonicality check only covers the outer text, not the deflate stream. Stored blocks add about 5 bytes per 64 KiB, so this fits under 1,533 whenever the original did (for small `W`).

**Impact:** Low. The signed body and `manualOfferHash` are unchanged, since the hash is over the decoded `{b,g}`, not the string. However, anything keyed on the code string is bypassable:
- `acceptAnswer` in `manual-bootstrap.ts:343,347` treats a re-encoded identical answer as a different answer. It returns "already used" or "being answered" instead of the idempotent bridge.
- Any replay or dedup cache outside this bundle that keys on the code string is also affected.

**Minimal fix:** Don't try to require a canonical deflate stream, because browser `CompressionStream` output isn't stable across engines. Instead, key idempotency and dedup on a hash of the decoded signed object. For example, compare `hashValue(answer)` in `acceptAnswer` instead of `answerCode`.

### 2. Line limit is counted in chars on encode but bytes on decode
**Where:** `manual-sdp.ts` → `linesOf` vs. `manual-sdp-codec.ts` → `decodeManualSdpWire`

**Counterexample:**
- `linesOf` limits `line.length ≤ 4096` UTF-16 units.
- The compact decoder rejects `encoder.encode(line).length > MAX_LINE_BYTES` (4,096 bytes).
- Take the test SDP plus `a=x-f:${'é'.repeat(3000)}\r\n`. That line is 3,006 chars but about 6,006 bytes.
  1. `validBody` passes.
  2. `encodeManualSdpWire` picks compact mode, because the constants and fingerprint savings exceed the 3-byte tag overhead.
  3. It compresses well under 1,533 bytes.
  4. `decodeManualSdpWire` throws, which surfaces as "invalid compact data".
- Literal mode has no per-line check, so whether the same SDP decodes depends on which mode the encoder happened to choose.

**Impact:**
- **Offer:** `createManualOffer` fails at its own self-decode (`manual-bootstrap.ts:332`).
- **Answer:** `answerManualOffer` never decodes its own code, so the guest shows a code that the host always rejects. Negotiation fails late.
- Real browser SDP is ASCII, so the practical risk is low. It is still a definite asymmetry.

**Minimal fix:** Pick one unit. Either:
- have `linesOf` check `new TextEncoder().encode(line).length > 4_096`, or
- drop the per-line check in the decoder and rely on the total bound plus `validSigned`.

Also add the round-trip assertion from finding 3.

### 3. The encoder never proves exact restoration, and lone surrogates are lossy
**Where:** `manual-code.ts` → `encodeManualCode` / `wireBytes`; `manual-sdp-codec.ts` → `writeLine`

**Counterexample:** Use `s` containing a line `a=x-n:\uD800`, or `sc = 'lobby:\uD800'`.
- `validBody` accepts it: `aggregateManualSdp` only rejects NUL and bare CR, and scope is only length-checked.
- `TextEncoder` replaces the lone surrogate with U+FFFD, so the decoded `b.s`/`b.sc` is not equal to the signed `body.s`/`body.sc`.
- The outcome then depends on how `signObject` serializes strings, which I can't see:
  - If it hashes UTF-16 or rejects lone surrogates, verification fails and you get the same late-failure pattern as finding 2.
  - If it UTF-8-encodes via `TextEncoder`, the signature verifies over a body that differs from what the sender passed in. Exact restoration is then violated silently.

**Impact:** Low in practice (browsers don't emit lone surrogates). But the claim in the codec's doc comment, "Exact SDP bytes are restored", has no enforcement.

**Minimal fix:**
- In `validBody`, reject `!value.sc.isWellFormed() || !value.s.isWellFormed()`.
- In `encodeManualCode`, before compressing, run `signedFromWire(wire)` and require `b.s === body.s && b.sc === body.sc`, or simply `verifyObject` over the decoded body. This single check also closes finding 2 at the source and covers the answer path.

## Questions that need unavailable context

### 4. Candidate duplication may exhaust the 16-candidate or 1,533-byte cap
**Where:** `gatherCandidates` (not in bundle) → `aggregateManualSdp`

Chrome's `onicecandidate` strings typically carry `ufrag … network-id …`. The `a=candidate:` lines in the post-gathering `localDescription` do not. If `gathered.candidates` holds the event strings:
- Each candidate appears twice, because `Set` dedup is exact-string.
- The event-form copies don't match `MDNS_HOST`, so they fall back to tag 5.

A host with 9 or more local candidates would then fail with "too many distinct ICE candidates". Mid-sized sets would compress worse and could hit "size limit".

**Needs:** the `gatherCandidates` source, and whether it passes candidates when `localDescription` already contains them.

**Fix if confirmed:** normalize or strip `ufrag`/`network-id` before deduplicating, or pass no extra candidates when gathering completed.

### 5. Primitive strictness I can't verify
- **Trailing and truncated deflate data:** Does `DecompressionStream('deflate-raw')` reject bytes after the final block, and reject a truncated stream, in every engine you ship to? Current Chromium errors on junk after the end. Older Safari and Firefox behavior should be confirmed. If trailing junk is accepted, that is another string-malleability vector (same impact and fix as finding 1).
- **Ed25519 verification:** Does `verifyObject` reject non-canonical `S ≥ L` and small-order `A`/`R`? A malleated `g` changes `manualOfferHash`. That only lets an in-path tamperer break binding (a DoS they already have), but strict verification should still be confirmed.
- **Key order:** Does `signObject`/`hashValue` canonicalize key order? `signedFromWire` rebuilds bodies in a fixed order. Current callers match that order, but a caller with a different insertion order would fail verification if serialization is order-dependent.

## Checked and found sound
- **Wire-level canonicality:** Every alternative tag choice gets rejected by the `wireBytes` byte-compare. That includes a raw line equal to a constant, tag 3 with a non-canonical foundation or priority 0, and literal-vs-compact. Literal mode fully preserves CRLF, lines, and unknown lines.
- **Bounds:**
  - The maximum wire is about 66.2 KB, under the 70,000-byte decompressed cap. The decompression cap is enforced while streaming.
  - The compressed cap of 1,533 bytes becomes 2,044 base64 chars, so the code is 2,048 chars with the prefix.
  - All u16 length fields fit, given the 4,096-char line and 512-byte scope limits.
  - The fixed-width decoders are bounds-checked.
  - Header flag/kind combinations are validated, and `t ≠ f` is checked.
- **Tag round-trips:** origin session and version, mDNS UUID case, fingerprint uppercase hex, priority ≤ 2³²−1, and port and cost ranges all restore exactly.
- **Answer binding:** The host checks `k`, `t`, `n`, `h`, and the optional `f` against the hash of its own decoded offer. The recipient check in `decodeManualCode` applies whenever `t` is present.
- **Oversized codes:** They fail with "size limit" instead of dropping ICE or SDP lines.
