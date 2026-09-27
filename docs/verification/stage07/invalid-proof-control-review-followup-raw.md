# Follow-up review: invalid-proof proposer accusations

**Verdict:** H1, H2 and M1–M3 are resolved as far as the code shown goes. I found no concrete exploitable path in these files. The design is now sound if one invariant holds, and it is not yet enforced by a test (R1 below). There are also two scope items to check in code I couldn't see (R2, R3).

## Status of prior findings

| # | Finding | Status | Reason |
|---|---|---|---|
| H1 | A bad proof must imply an actually invalid entry | **Resolved** | `control.ts` now requires three things: the proposer-signed entry is deterministically rejected at the certified parent, the rejection is not `entry-verification-failed`, and an extracted claim passes `verifyCheatProof`. The `checked.ok` gate means a verifiable cheat artifact inside a *valid* entry can never exclude the proposer. |
| H2 | Extraction becomes consensus-critical | **Resolved** | The contract is documented on `rejectedProofCandidates`, and `PROTOCOL_VERSION` is bumped to 5 with admission rejecting mixed versions. One extractor serves both capture and admission, so they cannot drift. |
| M1 | Pre-sign check and beacon index | **Resolved** | `verifyBeaconReveal` returns `beacon-seat` or `beacon-operation` before `beacon-link`, so a stale or foreign reveal is never classified as a bad link. In `propose`, `validateProposal` runs before `recordProposal` and the broadcast. The signed objects only exist in the `transition` copy on failure. |
| M2 | Deck wrapper | **Resolved for base game** | Only `pass` is extracted, and `deckId` is ignored. A wrong `deckId` makes the entry invalid, which is already proposer fault. |
| M3 | Command payload in invalid-proof | **Resolved** | The kind gate at `control.ts` allows only `system` and `crypto`. |

## Why an honest proposer can't be framed

An accusation requires the proposer's signatures on both the proposal and the entry. An honest proposer only produces those after `validateProposal` succeeds at the same certified parent. The accusation then needs `validateNextEntry` to fail at that same parent. So an honest proposer can only be excluded if validation gives different answers for the same `(parent, entry)` pair. The residual risks below are all ways that could happen.

## Residual risks, in priority order

**R1. Validator determinism is now enforced by exclusion, not just by liveness.**
- Before this change, a divergent `validateNextEntry` for system/crypto entries only stalled a round. Now it permanently excludes an honest proposer.
- `commandPolicy` comes from `parent.policy`, which is `ReplayPolicy.entry`. That is supplied locally (for example `randomDerivations`).
- Two peers on the same v5 but with different builds or configs could disagree.
- Recommended fixes:
  - Derive the entry policy only from genesis and protocol version.
  - Treat changes to system/crypto validation as version-bumping, the same rule you already apply to the extractor.

**R2. Denylist of local-fault codes.**
- Only `entry-verification-failed` is excluded as a local fault.
- If `validateNextEntry` maps any other environmental failure to a different code (a caught crypto or WASM exception, a missing derived table), rejection alone would satisfy the first gate.
- The `verifyCheatProof` conjunction limits the damage, but only if this invariant holds: *every extracted candidate that verifies as a cheat makes the entry invalid under honest validation.*
- Recommended fixes:
  - Add a property test for that invariant over every payload shape in `payloadSchema`.
  - Consider an allowlist of objective rejection codes for this branch instead of a one-code denylist.

**R3. Operation binding for the non-beacon cheat kinds.**
- The beacon fix only protects beacon reveals. A proposer can embed any artifact that another seat signed earlier.
- For each kind, `verifyCheatProof` must reject rather than classify an artifact that is honest in its own operation but replayed into this parent. This applies to `count-proof`, `steal-contribution`, `false-steal-dispute` and `deck-unlock` prefixes.
- The accusation path is safe either way, because the proposer is the one excluded. But the plain cheat-proof path could otherwise frame the artifact's signer.
- `count-proof` and `steal-contribution` aren't shown, so please confirm they bind an operation ID or anchor the way beacon and deck-pass do. `false-steal-dispute` needs particular care: its claim seat comes from `context.crypto.steal.operation.thief`, not from the artifact body.

## Minor points

- **Scope limits:** the invalid-proof path is a no-op in unverified games, because `rejectedProofCandidates` returns `[]` there. It also does nothing without a crypto context. That seems intended, but it should be stated in the docs.
- **Seafaring / C&K:** the docs for these are being edited. Moving beyond the first pending deck changes both the extractor and the verifier semantics, so it needs v6.
- **Pre-v5 journals:** confirm that restoring or rebroadcasting a persisted proposal from the IndexedDB journal also goes through validation, or only replays proposals already validated at that parent.

The full cheat-table and live-network matrix remains open, as you noted. I'd make R1 and R2 explicit tests before closing this item.
