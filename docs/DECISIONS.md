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

## 2026-09-24 — Stage 04: explicit input shapes and reproducible tools

- Decision: Handlers can declare allowed and optional payload keys; all base handlers do. The core rejects undeclared fields after JSON checks and before pending checks, closes the command envelope and built-in seat-status input, and validates/snapshots declaration metadata. Custom handlers without metadata remain open. Nested base card parameters are closed; knight/road-building plays omit parameters, and random dice omit the balanced-deck index.
- Reason: Stage 04 requires rejected extra-field mutations, while the existing extensible record types allowed ignored fields. Explicit handler declarations make that requirement testable without closing the module extension interface. Removing optional fields or including zero resource counts remains valid where documented.
- Consultation: A read-only `claude -p` review recommended this contract and identified the flat/nested card-parameter mismatch in the briefs. We retained nested parameters and kept proof/timer evidence in the surrounding protocol entry. Prototype-like key names, declaration snapshots, optional fields, and every generated legal command are regression targets.
- Decision: Enumeration receives the engine instance explicitly. The simulator may import codec and map packages directly for canonical checks, replay hashes, and fixed-board fixtures. Local development-card inputs record dealt identities so replays do not require an unstored random-source secret; public state still contains only face-down slots.
- Decision: The first committed golden baseline uses engine version `0.1.0`. Subsequent changes to replay hashes require an intentional version bump and regeneration. Goldens are generated after the current rule changes settle.

## 2026-09-24 — Stage 04: bot stalls and performance measurement

- Consultation: A read-only `claude -p` review of stalled simulations identified competing resource goals, development purchases consuming city savings, and road targets that can become unreachable. It recommended choosing a reachable build target from the public board, reserving its resource cost, and keeping randomized choices among useful actions. The review also warned that a mostly uniform policy may have a long tail of unfinished games.
- Evidence: The initial 100-game pilot had 10 games exceed 500 turns. A first resource-goal policy had 13 failures. Correcting goal selection to use board feasibility reduced the next pilot to one failure. Its saved replay showed a player with no grain production repeatedly buying development cards while saving for a city. These pilot results are diagnostic, not acceptance evidence.
- Decision: Keep the 500-turn limit, default 10-point target and zero-dead-game acceptance while correcting the policy. Do not discard failing seeds. Record any eventual change to those criteria explicitly.
- Decision: Measure the whole single-worker game separately from engine `apply` time. A CPU profile found command enumeration and repeated trade validation dominated runtime. Parallel throughput and apply-only timing do not establish the 30 ms game budget.
- Decision: Choose a weighted action family before choosing randomly among its preferred moves. Favor productive settlement sites, preserve a feasible building cost through trades and discards, and allow road expansion while saving for a city. Purely uniform choices and conflicting resource goals produced stalled games. The revised policy completed two independent 1,000-game four-player pilots and a 1,000-game three-player pilot without stalls; the full acceptance batches remain required.
- Consultation: A second read-only performance review accepted a default-on LocalGame invariant option for the benchmark's explicit exclusion. The option skips diagnostic hand/conservation assertions while retaining input validation, private updates, ownership checks, freezing and rollback. Normal games and acceptance simulations keep diagnostics enabled. The review advised against caching validation by mutable state/input identity and warned that a combined public/private apply method would require updating simulation instrumentation.

## 2026-09-24: Stage 04 verification and private updates

- Consultation: A read-only simulator review found gaps in the verifier. Deck checks now compare the source's remaining count with the public deck, require each unrevealed slot to have exactly one identity in its owner's private state, and reject unknown card kinds. Local golden tests also reconstruct private state. Generic replay files and checkpoint hashes remain public so they can support spectator and peer logs later.
- Decision: Fuzz guaranteed-invalid inputs separately from changed, plausible inputs. Required-field omissions follow handler metadata; seat mutations include real seats without a matching pending choice. A duplicate is classified as stale only when the resulting phase no longer requests it. Repeated trade commands can be legitimate; signed nonce protection belongs to the protocol stage.
- Decision: Keep plausible hidden outcomes independently feasible. A public card draw may omit its identity while the private update receives the original identity. A public rules engine cannot determine whether an arbitrary claimed card matches a secret external deck, so private-handler failures cannot simply be counted as impossible outcomes and ignored.
- Decision: Fingerprint the source used for measured runs, including untracked files, and record whether it changed during execution. Failure replay must match the recorded state or accepted prefix and the recorded failure category. A fixed bug must report that the old failure no longer reproduces.
- Consultation: A read-only review approved a strict `applyAllPrivates` method for the omniscient driver. It validates the public input once, then updates configured seats in order through the same private handlers. The existing single-seat method retains its validation. LocalGame still calls public `apply` separately, preserving per-input simulation checks and public apply timing. This removes redundant validation without unchecked flags or caches tied to mutable inputs. Seat ownership, private-data routing, rollback and equality with per-seat updates remain regression requirements.
- Decision: Apply a bot's pure candidate predicate before validating concrete legal commands, and retain validation of every returned command. Discarding zero-weight trade candidates preserves the existing weighted choices. Bounds helpers sum already validated internal maps without repeating descriptor checks, and base-rule bookkeeping retains unchanged seat and offer objects. These changes reduce allocation and repeated work while preserving replay hashes.
- Evidence: An idle, single-worker benchmark completed 1,000 default four-player games at 27.96 ms per game, with five separate warmups and diagnostic invariants disabled. Public apply p99 was 0.037 ms. The measured source fingerprint and machine details are in `verification/stage04/bench-1000-seed42-acceptance.json`. The complete game timer includes bot decisions, validation, private updates and LocalGame bookkeeping.
- Consultation: The read-only end-stage review found no blocking engine or measurement issue. It identified narrow plausible-input fuzz coverage, a permissive bank-shortage fixture catch and diagnostic/reporting gaps. The fuzzer now checks alternative legal placements, robber moves, discards, trades and balanced outcomes, reports accepted types, and checks recorded prefixes publicly as well as privately. Shortage fixtures accept only an explicit dead-game limit. Benchmarks require one worker, report the invariant setting and retain warmup failures as replayable failures.

## 2026-09-24: Stage 04 committed verification baseline

- Evidence: Repeating the benchmark on committed implementation `2012b269b39f26f0448b00c81915e6e0db6d31f5` completed 1,000 default four-player games at 28.03 ms per game, with public apply p99 of 0.037 ms. The acceptance JSON now records this committed repeat; the preceding 27.96 ms measurement was the precommit run. Both used one worker, five separate warmups and the same diagnostic exclusions.
- Evidence: The committed baseline passed 1,000,000 invalid-input mutations and checked 62,595 accepted alternative inputs. The PR-sized simulation and fuzz checks finished in approximately 42.7 seconds. The 10,000 three-player games completed with invariants enabled and zero failures; their dice chi-square p-value was 0.3712.
- Decision: Keep the tested source frozen until the 100,000 four-player batch completes. Record its result and the combined three- and four-player dice check before closing Stage 04 or starting Stage 05.
- Reason: These are the remaining scale criteria. Smaller runs and a passing benchmark cannot establish the required 100,000-game result.
- Evidence: The frozen-source run completed all 100,000 four-player games with invariants enabled and zero failures in 35.45 minutes. Together with the 10,000 three-player games, it produced 13,075,286 rolls; the combined chi-square statistic is 13.9511 (10 degrees of freedom), with p = 0.1752. Both raw reports match the committed source fingerprint and report unchanged source. The coordinator independently checked the totals and recomputed the combined statistic before closing Stage 04.

## 2026-09-24: Stage 05 session, persistence, and visual direction

- Decision: Follow `docs/design/style-guide.md`: a central board, clear sans-serif controls, light/dark CSS tokens, distinct player shapes as well as colors, and motion tied to game events. The home screen uses the actual board renderer when a preview is useful. Game artwork will be original SVG generated through the documented Claude workflow.
- Reason: The user explicitly asked for a clean, readable interface and purposeful animation. The frontend design skill's marketing layouts apply only where relevant to the home screen, not to the game's action controls.
- Consultation: A read-only `claude -p` review checked the proposed session against LocalGame, card draws, timeouts, replay behavior, and storage. It identified ambiguity between submitted and automatic victory claims, stale timer callbacks, bot proposals without meaningful pending work, and old save revisions overwriting newer ones. These are implementation test cases, not changes to engine rules.
- Decision: Local saves record genesis inputs and submission batches, each containing the submitted input and its generated inputs. Restoration checks the exact flattened log and final hash before switching a delegating random source from replay to live operation. Diagnostic state snapshots do not replace the authoritative log. Live local draws sample the remaining card multiset with a CSPRNG; replayed identities must also fit the remaining stock. No future random sequence needs to be stored.
- Decision: Session revisions equal accepted log length. UI submissions include the revision they were based on. Notifications are queued, and any driver failure after public validation stops bots and timers. Each bot sees only its own hand and acts on a meaningful pending choice, with one scheduled action per tick.
- Decision: Local timer identities include the turn, player, phase/interrupt identity, and relevant trade offer. Unrelated actions do not reset a timer. A phase's budget pauses during a nested interrupt and resumes with its remaining time. Hotseat handoff covers pause local bots and timers. Rehydrating a closed local game starts fresh configured timers; wall-clock deadlines are not persisted. Network deadline agreement belongs to the later protocol stages.
- Decision: App-local repository interfaces use localStorage or memory in Stage 05. TanStack Query owns async reads, writes, export, and invalidation; Zustand holds pushed live session state and transient UI state. Save writes and cached revisions stay monotonic, and concurrent writers surface a conflict. A privacy handoff clears private state, private legal choices, and drafts together. Public panels show opponent totals, and the ordinary event log never exposes raw private input payloads.
- Reason: These boundaries preserve local resume behavior and privacy while allowing later storage and network adapters to replace the current implementations.
- Decision: The local session can return a detached private view for any configured seat, as required by the session contract. Ordinary gameplay reads only the revealed human seat; developer inspection and completed-game scoring can inspect other seats. Session updates and public caches never carry these private views.

## 2026-09-25: Stage 05 artwork and playable UI checkpoint

- Decision: Generate the forest tile first with `claude -p`, approve it on the board, then generate the remaining seventeen SVG assets against that tile and the style guide. Keep the complete prompts in `packages/renderer/src/assets/prompts/`. Validate exact paths, viewBoxes, SVG elements and attributes before saving, then optimize with SVGO. All eighteen assets are below 1.4 KiB and were visually checked at 256 px and at 48 px on light and dark backgrounds.
- Decision: Load SVGs through static `?no-inline` imports and cache their rasterized textures by dimensions and resolution. Rasterization accounts for the maximum board zoom and the capped device pixel ratio. Shared textures live for the page lifetime; destroying a board does not destroy the shared cache.
- Reason: Separate SVG URLs work with the application's existing CSP and give Pixi stable cache keys. Resolution-specific keys prevent a previously cached small raster from being reused at a larger size.
- Decision: Use one renderer-owned ResizeObserver and one coalesced manual render path. Add a Graphics object only when at least one drawable target or pip exists. Empty Pixi Graphics caused intermittent null-geometry failures in full-game browser testing.
- Evidence: The playable UI checkpoint passed `pnpm check` with 276 tests across 64 files. A browser pilot completed twenty default ten-point games through visible human controls with zero ordinary action rejections. Renderer edits overlapped that pilot, so final acceptance still requires a frozen-source run. Animation, memory-lifetime, mobile full-game and performance work remain open.

## 2026-09-25: Stage 05 integration review

- Consultation: A read-only `claude -p` review checked the session, storage, hotseat controls, renderer and browser tests against Stage 05. The coordinator independently confirmed that base dice production changes resource state without emitting the declared `resourcesProduced` event. A test using a fabricated event had hidden this integration gap. The review also identified optional trade responses being treated as mandatory handoffs, per-game route state surviving rematches, and incomplete browser coverage of card and trade controls.
- Decision: Emit exact public production gains at the engine's existing dice-production boundary, after bank allocation. Keep state transitions and resource rules unchanged. Replaying the authoritative input log must recreate these events, so a resumed game's log and statistics retain the same history. An app-only transient gain ledger would lose that history on restore.
- Decision: Optional trade proposals and responses do not force a hotseat handoff. A human explicitly chooses to inspect or answer another seat's optional trade; mandatory discards retain their required handoff. Single-human games keep that owner's hand visible during bot turns unless the owner hides it.
- Decision: Keep the specified full local-game VP breakdown, including each seat's hidden VP at game end. Capture terminal scoring through the session store and identify these cards as revealed at game end. A session that cannot supply a private view must not present an unknown count as zero.
- Decision: Board-contained animations stay in Pixi. Resource flights use a viewport overlay in the web app, with origins from renderer coordinates and destinations from player-panel bounds. A canvas-local overlay would clip flights before they reach the panels. Both paths honor the same skip and reduced-motion controls.

## 2026-09-25: Coastal port readability

- Request: The user asked for a clearer blue sea and ports that visibly connect to their two eligible coastal settlement locations, illustrated with two arms meeting offshore.
- Decision: Generate an original harbor marker and two-arm jetty with `claude -p`, using explicit shoreline anchors and an offshore hub. Map the anchors to the harbor edge's exact engine vertices, place the upright marker at the offshore hub, and draw the connections below settlement pieces. Keep the resource symbol and trade ratio as separate readable overlays.
- Evidence: The two generated SVGs passed element, attribute, viewBox and size validation, then SVGO optimization. Both are below 1 KiB. The complete prompt is saved in `packages/renderer/src/assets/prompts/harbors-connected.md`.
- Consultation: A read-only Claude review confirmed that inverse camera scaling made port badges and token labels change proportion relative to their artwork. The coordinator independently observed the mismatch in Chrome and the user's screenshots. Claude could inspect repository files but could not open the supplied temporary screenshot paths; its conclusions were checked against the coordinator's visual observations.
- Decision: Keep port and token components in board coordinates under one camera transform. Fit visible island and port content rather than the full decorative sea ring. Retain the rectangular port artwork so its silhouette differs from number tokens. At phone fit, a ratio can be smaller than interface text; zoom and named keyboard locations provide detail without distorting the board.

## 2026-09-25: Road placement confirmation

- Request: The user asked for explicit road confirmation, clearer legal locations, and confirmation controls directly on the board. The user also requested Claude's visual design for this interaction.
- Decision: Selecting an engine-provided legal edge stores a temporary road candidate in Zustand. Another legal edge replaces it. Confirm road resolves and validates the current legal command before submission; Cancel clears the candidate and keeps placement active. Setup, paid roads, and free roads share this interaction. Revision changes and privacy handoffs clear the candidate.
- Decision: Keep the confirmation controls on the board beside the candidate, within the visible bounds. Renderer view-change notifications update their position after pan, zoom, or resize. A pending candidate takes precedence over the keyboard chooser's temporary focus, so the visible road matches the command that Confirm will submit.
- Evidence: Focused desktop hotseat, phone touch, and Road Building browser tests verify that choosing and cancelling do not change the revision or placed-road count, while confirming commits the legal road.
- Consultation: Claude authored a replacement visual treatment using short neutral lanes with three white dashes, inset from the vertices. Dedicated edge layers sit below buildings; a thin outline and player-colored road identify the selected candidate. The complete request and style guide are saved in `packages/renderer/src/assets/prompts/road-placement-ui.md`.
- Decision: Adopt Claude's edge drawing treatment and pause the legal-edge pulse while confirmation is pending. Keep the board-local popover already verified in Chrome. Claude's alternative bar docked at the board frame could sit outside the viewport on a tall desktop board; the popover follows the selected road and is clamped to the visible board area.

## 2026-09-25: Settlement and city previews

- Request: The user extended confirmation to settlements and cities, including setup settlements, and asked for stronger contrast on both empty sites and city upgrade indicators.
- Decision: Use one placement candidate and one board-local confirmation for roads, settlements, and cities. A selected building preview reuses the committed building artwork, color, and player shape. A city preview temporarily hides the settlement it will replace; cancellation restores it. The visible Confirm label is short, while its accessible name identifies the building type.
- Consultation: Claude proposed white settlement-site rings on small dark halos, and city targets with corner brackets and an upgrade badge outside the existing piece. These use the same dark/white palette as road targets. The complete prompt is saved in `packages/renderer/src/assets/prompts/building-placement-ui.md`. The coordinator checked settlement markers and the on-board preview in Chrome and left a demo game open for the user.
- Review: A separate read-only stage review identified a sole human concealing their hand during a bot turn without a way to reveal it again. A focused test reproduced the missing cover seat. Manual conceal now retains a reveal path and remains effective when automatic hotseat covers are disabled. The store regression passes; browser acceptance still verifies the complete handoff flows.

## 2026-09-25: Single-viewport cockpit and card trading

- Request: The user asked for a non-scrolling game cockpit with board left, hand and actions below, players and collapsible log right, and no gaps between panes. They then replaced both header rows with a top-left hamburger menu and placed trade offers at the bottom-right of the board viewport. This placement request does not change engine state.
- Decision: Give the game route a definite viewport height, with internal scrolling limited to long detail lists. Keep one player-panel instance for both responsive layouts and animation destinations. Move save status, Leave, animation controls and developer utilities into the menu. Use compact player summaries and a mobile details disclosure.
- Consultation: Claude inspected the current components and proposed a grid with zero outer gutters, definite canvas bounds, compact resource/player summaries, and responsive details. The user's later hamburger instruction replaces Claude's suggested slim header. The full prompt is saved in `packages/renderer/src/assets/prompts/game-cockpit-ui.md`.
- Request: Replace text-led resource displays with original SVG cards and let players compose trades by selecting the cards they give and want. Keep quantities visible, provide separate removal controls, and preserve current hand limits and live engine validation.
- Decision: A completed trade event includes its public confirmed counterparty so the UI can animate the exact exchange from the public offer terms. Multiple accepted recipients make inference from the old offerId-only event ambiguous. This additive event data changes no resource rules or public state hashes, and no private hand data is needed for the animation.
- Artwork: Claude authored five resource cards and five development-card faces with a shared 80×112 viewBox, original central illustrations and no embedded text. The renderer exports typed URL getters; HTML supplies accessible labels and quantities. SVG validation, optimization and asset tests pass. The coordinator inspected all ten faces at 48×68 and 96×134 in a contact sheet.
- Review: The card-based bank composer initially passed exact bank counts into the resource picker even when bank counts were hidden. A failing component test reproduced this display leak. The picker now omits those counts in hidden-bank games while preserving live trade validation.
- Consultation: After the user rejected the bulky offer overlay, Claude proposed a compact proposer header, two card groups labeled from the viewer's perspective, and a paired action footer. The prompt is saved in `packages/renderer/src/assets/prompts/trade-overlay-redesign.md`. The implementation keeps the engine's available commands and live validation; a component test checks that an incoming wool-for-ore offer places Wool under "You get" and Ore under "You give".
- Request: The user asked to right-align development cards, remove their outer borders, and grey out newly bought action cards with a next-turn explanation on hover. Desktop uses a separate right-aligned group; compact layouts expose the same cards in a labeled dialog. Names and counts retain contrast when card artwork is dimmed.
- Request: The user found the trade composer too tall and repetitive. Give and receive selections now need to fit together on desktop, with compact mobile rows and a visible action footer, without a second copy of the selected exchange.
- Clarification: The user liked the card-selection UI and identified the modal itself as broken. The footer was covering recipient buttons and validation text. Keep the established card UI and give the title, scrollable body, and footer separate layout areas. Browser checks at 1728×944, 1280×720, 390×844, and 844×390 confirm the recipient controls and footer do not overlap.

## 2026-09-25: Readable public production payouts

- Request: Fast bot turns made resource distribution difficult to follow. The user asked for received resources to remain beside players for five to ten seconds.
- Decision: Show public production receipts for eight seconds after each payout. Aggregate still-visible receipts per player, but expire each payout independently so rapid turns neither replace unread gains nor keep old gains visible indefinitely. Use the public `resourcesProduced.bySeat` event, which already reflects bank shortages. The readout stays visible with reduced motion and skipped animations; it is information rather than an animation delay.
- Evidence: Focused timer/subscription tests cover independent expiry, session replacement, unmount cleanup, reduced motion, and Skip. Two Chromium checks use a legal visible roll to generate actual public payouts, compare each player's resource icons and quantities to the event, advance the turn, skip animations, and observe expiry. The coordinator inspected desktop dark and phone screenshots; receipts remain within the player rail and compact phone strip.
