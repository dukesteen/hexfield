# Stage 07 Step 2 local checks

The beacon now runs through certified-log validation, replay, peer delivery and
session callbacks. This is a local implementation checkpoint, not Stage 07
acceptance or playable online multiplayer.

## Verified behavior

- Signed genesis tips establish the human participants. Bots contribute no chain.
  Starting-seat and dice results require every frozen participant's valid next
  preimage and must match the locally derived result.
- Real certified replay preserves the original request anchor through a proposer
  control and an exhausted-chain extension. Tampered outcomes, missing/reordered
  or repeated evidence, and an absent verified crypto context are rejected.
- A memnet test drives legal setup and the first roll from genesis using a
  deliberately short chain. It checks that the extension commits before the next
  reveal, then compares the live and replayed snapshots after the dice result.
- A missing human contribution stalls. One human with hosted bots works with one
  contribution and one vote. The fixtures stand in only for later genesis
  deck/escrow checks and explicitly approve public setup/roll commands.
- A failed local write emits no contribution. Restoration and transient send
  failures reuse the persisted signed bytes. Competing inserts return the stored
  winner; corrupt records cannot trigger fresh signing.
- With all contributions present but votes missing, replaying duplicate or
  future-round contributions causes no derivation, voting-store write or outgoing
  message. Old contributions remain inert after commitment.
- The full-entry session callback receives control/crypto evidence, including
  null engine inputs, during live commits and restore. It replaces the legacy
  input callback. Mutating callback inputs cannot change certified state, and a
  failed callback does not publish the next private/public view.
- Registered module derivations receive detached inputs and return detached
  outcomes, and their result type must match the frozen pending. The base
  derivations keep their direct pure implementation.
- A fresh source reconstructs initial and extension chains from the same master
  and ceremony context. The crash-before-write regression applies a verified extension transition and verifies its next reveal from another fresh source.

## Results

On 2026-09-26, with Node 22.23.3 and pnpm 10.7.1:

- `pnpm check` passed **655 tests in 116 files**, production/test typechecks,
  type-aware lint, formatting, dependency rules, purity and i18n checks.
- `pnpm build` passed all workspace packages and the production web build.
- No local browser was launched. This avoids the reported macOS browser crash
  dialogs and makes no browser performance claim.

The coordinator inspected both successful exit codes. The source fingerprint for
the 97 files in protocol, crypto and codec is
`7b0df0023902535d42712f98db694105ca89120bb883fbf1cff5370ecb8b90da`.
The [source manifest](step2-source-manifest.json) records its inputs.

The authorized [Claude review](step2-review.md) is complete. The
[response](step2-review-response.md) records its extension-lifecycle correction
and stronger tests. The [read-only follow-up](step2-followup-review.md) is complete.
Both reviews have exact packet manifests. The final duplicate-message regression
was strengthened after the first packet was sent.

## Remaining work

The fixed-steal test covers index fixation and single consumption only. The later
sealed transfer and receipt path is not implemented, so such a pending operation
currently stalls. Deck setup/draw/reveal, resource commitments, escrow and audit
remain later Stage 07 steps. The contribution-store interface still needs a
durable browser adapter and private-secret lifecycle in Stage 10. Membership
changes and recovered contributions must preserve the frozen operation.

Worker timings, distribution checks and full games under adversarial network
conditions remain acceptance requirements. This checkpoint does not satisfy them.
