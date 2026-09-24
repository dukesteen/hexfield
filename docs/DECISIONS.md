# Decisions

Record decisions here as they are made. Keep earlier entries.

## Entry template

- Date:
- Stage:
- Decision:
- Alternatives:
- Reason:

## 2026-09-24: Clarify milestone A and B contracts before implementation

- Stage: 01, with corrections to the stage 02–04 specifications.
- Decision: Use strict-balance pip caps of 14 for resources on four hexes and 11 for resources on three hexes. Bound generation to 100 terrain retries after each 10,000-attempt token search. Keep ordinary random boards unconstrained and apply balance rules to balanced-random boards.
- Alternatives: A uniform cap of 12, or removing the pip limit. The original uniform cap of 11 is impossible.
- Reason: The tokens total 58 pips, exceeding the original five-resource capacity of 55. The chosen limits account for terrain counts and keep the limit of 11 for three-hex resources. A finite retry bound prevents genesis from hanging.
- Decision: Add `CLAIM_VICTORY { slotIds }` for hidden victory points. Public points win automatically. The local driver submits and records an immediate claim when the active seat's private total wins.
- Alternatives: Store private VP totals in public state, or let public `apply` inspect private state.
- Reason: Both alternatives violate public/private separation or deterministic replay. A claim reveals the winning cards through an explicit input and uses the existing protocol obligation to verify card reveals.
- Decision: Support two-player base games with unchanged rules, as stage 05 already requires. Put board generation under `modules/base/setup`, expose a separate RNG entry for external bots and simulators, and inject enumeration sampling. Clarify local draw ownership, trade-response pendings, offer invalidation, and the validation rules for timeout and seat-status inputs.
- Alternatives: Remove two-player setup, share a hidden RNG with rule handlers, or allow inputs without a defined phase contract.
- Reason: These choices reconcile the existing stage briefs while preserving their required behavior and engine dependency rules.
- Consultation: A read-only `claude -p` review of stages 00–05 confirmed the impossible pip cap and private-VP contradiction and identified the RNG layout, player-count and pending-model inconsistencies. The coordinator checked those findings against the documents. Suggestions to add new acceptance workloads or weaken runtime dependency rules were not adopted.

## 2026-09-24: Repository foundation and local CI gate

- Stage: 01.
- Decision: Pin pnpm 10.7.1 and Node 22 for CI. The bootstrap steps were implemented and checked together because the workspace had no runnable package until the scripts, package manifests and tool configurations existed.
- Alternatives: Commit each incomplete setup step separately, or use the host's Node 25 for verification.
- Reason: A partial skeleton cannot pass `pnpm check`; dependency-cruiser 18 also rejects Node 25. The completed foundation was checked with Node 22.23.3.
- Decision: Commit TanStack Router's generated `routeTree.gen.ts` and run `tsr generate` before every TypeScript build check. Keep package production exports at `dist`, and use a namespaced `@cp2p/source` condition for source imports during development and tooling.
- Alternatives: Ignore the generated tree, point all exports at source, or use Vite's `development` condition for every dependency.
- Reason: A clean clone can typecheck before Vite runs; the generator refreshes route types when routes change. The source condition leaves production and third-party resolution intact.
- Decision: Use the user-authorized local equivalent of the GitHub Actions gate until a remote workflow run exists. Keep the workflow configured for Node 22, frozen pnpm install, checks, build, coverage and browser smoke tests.
- Alternatives: Claim a hosted CI result without a remote, or stop Stage 01 solely for a missing hosted run.
- Reason: The user explicitly chose the same checks locally. The final gate will run from a clean clone. Browser tests need the Playwright browser install and an unsandboxed launch on this macOS host.
- Consultation: A read-only `claude -p` review of Stage 01 found that dependency-cruiser could miss compiled workspace imports, a production-only Vite condition could select the wrong exports, and test files were outside TypeScript's production check. We reproduced the boundary issue and added source-condition fixtures, package references and a separate test typecheck. Vitest 3 warns that its workspace file is deprecated; the requested file still runs all twelve package/app sanity tests, so it remains for this stage.

## 2026-09-24: Resource affordability must preserve a feasible hand

- Stage: 02 specification review, before implementation.
- Decision: Require `max[r] ≥ cost[r]` for every resource and `sum(max(min[r], cost[r])) ≤ total` for public affordability. Use the same guard for known losses, and normalize all bounds updates. Reject infeasible bounds and hidden losses greater than the hand total.
- Alternatives: Check only per-resource maxima, or also check only the total cost.
- Reason: A five-card hand with three guaranteed ore and at most two each of brick and lumber cannot spend two brick plus two lumber. Both alternatives accept that impossible spend. The chosen condition exactly characterizes whether some publicly consistent hand can pay, while preserving the need for later private-hand audits.
- Consultation: A read-only `claude -p` review independently proved the condition by intersecting the hand bounds with the cost lower bounds. It confirmed that the documented loss formulas are sound after this guard and normalization. Stage 02 tests must compare the operations against brute-force feasible hands as well as the required 10k soundness runs.

## 2026-09-24: Local UI design direction

- Stage: 05 design constraints, recorded before implementation.
- Decision: Use a clean, readable interface with clear controls and meaningful animation. Avoid medieval styling, parchment textures, decorative type and visual clutter.
- Alternatives: A themed tabletop interface with ornamental panels and period typography.
- Reason: The user explicitly requested a UI that is easy to read and reason about. Motion should explain game events and respect reduced-motion preferences.

## 2026-09-24: Canonical byte tag and strict decoding

- Stage: 02.
- Decision: Reserve an exact one-key `{"$b":"..."}` object for `Uint8Array`. Encoding rejects every ordinary one-key object named `$b`, regardless of its value. Decoding accepts that exact shape only when its value is canonical unpadded base64url. `canonicalDecode` also requires re-encoding the decoded value to reproduce the input bytes exactly, rejecting duplicate keys, whitespace, unsorted keys and other noncanonical JSON forms.
- Alternatives: Allow ordinary objects to collide with the byte tag, or accept noncanonical JSON and normalize it during decoding.
- Reason: A single byte tag shape makes snapshot decoding reversible, and strict decoding ensures peers hash one representation for each value.

## 2026-09-24: Engine registration and local submission ownership

- Stage: 02.
- Decision: Bind each engine's pipeline methods to a copied module registry through `createEngine(modules)`. Order dependency-ready modules by id. Require one explicit initial phase and provide an ordered genesis hook for shared bank, deck and seat fields.
- Alternatives: Use mutable global registration, choose the first phase alphabetically, or force common state initialization into module extension data.
- Reason: Multiple engines can coexist, module order is deterministic, and genesis remains explicit.
- Decision: Commit a `LocalGame.submit` command and its generated inputs atomically. If automatic resolution fails, preserve the previous committed state and log and make the driver terminal. Ordinary invalid player commands remain recoverable. Expose borrowed state and log views, with explicit snapshots for mutable consumers.
- Alternatives: Retry the source after rolling back, or clone the whole state and log on every simulation access.
- Reason: An external source may already have consumed a secret deck item when it fails. Retrying would silently change its outcome. Borrowed views avoid repeated copies in simulations while retaining the engine's immutable-state contract.
- Consultation: A read-only `claude -p` stage review identified non-JSON inputs accepted before log encoding, uncaught automatic-source errors, invariant checks that threw on missing phases, registration edge cases and the single-kind bounds convergence bug. Focused regressions reproduced and fixed these cases. The review also prompted a guard against rule handlers importing RNG through setup reexports. Atomic rollback remains deliberate; the failed batch is never retried. Local committed values are frozen with already-frozen shared branches skipped, and log/event getters copy their arrays. The codec accepts integer values as documented; engine state uses the stricter safe-integer range.
