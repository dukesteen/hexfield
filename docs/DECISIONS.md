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

## 2026-09-24: Base card shortages and deterministic dice reset

- Stage: 03.
- Decision: A year-of-plenty command requests exactly two cards and receives the available portion of each requested resource. It does not substitute other types. This pins the project specification's partial-shortage wording, including when unrequested resources remain available.
- Alternatives: Require two available cards whenever the bank's total allows it, or reject any request the bank cannot fill completely.
- Reason: The plan explicitly allows partial fulfillment when a selected resource is unavailable. The [published base-game almanac](https://www.catan.com/sites/default/files/2024-01/Almanac%20CATAN-3D.pdf) describes choosing two resources from supply; the partial-request behavior here is our interpretation of this project's specification, not a claim about that publication.
- Decision: Balanced dice reset to all 36 ordered combinations when the next roll is requested and six or fewer combinations remain. Each external random answer selects uniformly among remaining combinations.
- Reason: This fixes the reset point in the input log and keeps all live randomness outside the engine.
- Decision: Test the literal figure-eight trail on an abstract graph. Real board fixtures retain their maximum vertex degree of three.
- Reason: Two edge-disjoint loops sharing one vertex require degree four. The abstract fixture tests the required trail behavior without changing hex geometry.
- Decision: Pass `HandlerContext` as the final private-handler callback argument, while keeping the external `Engine.applyPrivate` signature unchanged. Production hooks modify demand before bank shortage allocation.
- Reason: Public and private updates must use identical hook-adjusted costs and production. Without the hook context, a private handler could silently calculate different resource changes.
- Decision: Add ordered module private-invariant callbacks and invoke them from `LocalGame` after each input. Base rules check the bank plus exact hands against the initial 19 cards of each resource.
- Reason: Individual hands can fit their public bounds even when a hidden transfer incorrectly changes resource composition. A private conservation check detects that error while keeping the core independent of base-game quantities.
- Consultation: A read-only `claude -p` review of longest-road search and award transfer found no incorrect result for a legal base-game position. We retained exhaustive edge-unique traversal, allowed repeated vertices and blocked passage through opponent buildings. Tests cover the abstract figure-eight, real-board loops and cuts, holder transfers after cuts, and a 15-road three-hex graph whose longest trail has 14 edges. Geometry is cached by its immutable hex-array identity, outside public state.

## 2026-09-24 — Stage 03: road-building deadline

- Decision: The road-building card interrupt uses `mainSec`, including when played before rolling. Robber movement and victim selection use `robberSec`.
- Reason: The four timer settings did not specify the building interrupt. Reusing the action timer gives building decisions the configured main-action duration without adding an option.

## 2026-09-24 — Stage 03: trade lifetime and timeout clarifications

- Decision: Keep at most one open offer per proposer. A new offer replaces that proposer's previous offer with a new id and no responses. The active seat can cancel any offer; another seat can cancel its own counter-offer or withdraw its acceptance of an active-seat offer, recording a decline. An actual unanswered trade response has a `mainSec` deadline; optional proposals and withdrawals do not.
- Reason: Repeated proposals otherwise grew shared state without limit, and a responder could remain committed to an offer after deciding to withdraw. Fresh ids ensure an old acceptance cannot authorize a replacement offer.
- Decision: Resolve a zero-card discard automatically. Timeout discards sort piles once by initial size, then drain each pile as needed, breaking ties in canonical resource order. They do not rebalance after each removed card.
- Reason: The zero discard needs no decision, and the timeout wording admitted two interpretations. These choices make the input sequence and the client's private-hand calculation unambiguous.
- Consultation: The read-only Stage 03 review found no additional high-severity defect after the timeout and public/private dice fixes. Its trade lifetime, withdrawal and missing response-deadline findings were reproduced before fixes. It also confirmed the legal-command omission for hidden victory claims during interrupts, which the concurrent legal-action review had already found. The zero-discard and whole-pile timeout clarifications were adopted with regression tests.
