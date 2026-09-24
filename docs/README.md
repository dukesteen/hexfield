# Implementation Plan — P2P Hex-Settlement Game

This folder is the complete implementation plan for a browser-based, fully peer-to-peer hex-settlement trading game (a clone of the gameplay you'd find on colonist.io, with no game server). Each numbered document is **one stage**. Implement them **in order**. Each one is a self-contained brief with goals, design, step-by-step tasks, required tests and acceptance criteria.

## Instructions for the implementing agent

1. **Read `00-architecture.md` first, then read it again before every stage.** It holds the non-negotiable invariants: determinism, dependency direction, where randomness comes from, and how public and private state are separated. Any code that breaks them is wrong, even if its tests pass.
2. **Work one stage at a time.** Don't start stage N+1 until every acceptance criterion in stage N passes in CI. For this workspace, the user authorized running the same checks locally because there is no GitHub remote. Record the commands and results in `STATUS.md`; keep the GitHub Actions workflow ready for a future remote.
3. **Follow the steps as written.** Each step is sized so it ends in a verifiable result: code plus tests. After each step, run `pnpm check` (typecheck + lint + test) and commit.
4. **Tests are part of the deliverable.** "Required tests" sections are minimums. Where a rule is ambiguous, write a test that pins down the interpretation you chose, and record the choice in `docs/DECISIONS.md`.
5. **Rules marked `[VERIFY]`** are details the plan author wasn't fully sure of. Before implementing one, check it against the official published rules for that mechanic, then record the resolved rule in `docs/rules/<module>.md` along with the source you used. Never guess silently.
6. **Don't use trademarked names or copyrighted assets.** In code, UI and assets, don't use "Catan", "Colonist", official expansion names, official card text, artwork, sounds or exact official scenario maps. Use the neutral names defined in these docs (e.g. module `knights`, not "Cities & Knights"). Game _mechanics_ are fine to implement.
7. **Keep `docs/DECISIONS.md`** as an append-only log: date, stage, decision, alternatives, reason.
8. **Keep `docs/STATUS.md`**: tick off each stage's acceptance criteria as they pass.
9. **If a doc is wrong or contradicts itself**, stop, write the issue in `DECISIONS.md` with your resolution, and follow the resolution consistently. Fix the doc in the same commit.
10. **When unsure, ask for a second opinion** with `claude -p` instead of guessing: before tricky implementations, after security- or correctness-critical code, and at the end of each stage for a review against the acceptance criteria. See "Using `claude -p` for review and second opinions" below.

## Delegating visual/UI work to Claude (`claude -p`)

The implementing agent (Codex / GPT 6 Astra) **may call the Claude Code CLI non-interactively** with `claude -p "<prompt>"` for two purposes:

1. design-heavy work where a second model gives better visual results (this section),
2. reviewing work and getting a second opinion when unsure (next section).

Typical design uses:

- **Board tiles**: SVG terrain hexes (hills, forest, pasture, fields, mountains, desert, sea, gold, fog, lake), number tokens, harbor markers, the robber/pirate.
- **Pieces & icons**: roads, settlements, cities, ships, knights, walls, resource/commodity icons, dev/progress card faces, UI icons.
- **UI components**: React/CSS for polished panels, dialogs, the trade composer, the lobby, the game-over screen, and animations/micro-interactions.
- **Design tokens**: colour palettes (including colour-blind-safe player colours), typography scale, light/dark themes.

Rules for using it:

1. **Give a complete, self-contained prompt.** Claude has none of your context. Include:
   - the art-direction guide (`docs/design/style-guide.md`; create it the first time, and keep every asset consistent with it),
   - exact dimensions/viewBox (pointy-top hex; state the size),
   - the target file path and format,
   - constraints: original artwork only; no trademarked names, logos or imitation of official art; flat SVG with no external references, fonts or raster images; must look good at 48 px and 256 px; works on light and dark backgrounds.
2. **Run it from the repo root** so Claude can write files directly, e.g.
   `claude -p "Create packages/renderer/src/assets/tiles/forest.svg: ..." --allowedTools "Read,Write,Edit"`,
   or ask for output on stdout and write it yourself.
3. **Save every prompt** next to its output (`assets/prompts/<asset>.md`) so assets can be regenerated or restyled consistently. Log significant asset batches in `DECISIONS.md`.
4. **Review and validate the result.** Optimise SVGs with `svgo`. Check the viewBox and size budget (< 8 KB per tile SVG). Render them in the `#/dev/board` page (stage 05) and screenshot-check with Playwright. Regenerate if the style drifts.
5. **Claude doesn't replace the engineering work.** Rules, engine, protocol and crypto code are written by the implementing agent and must pass these docs' tests. For those areas, use `claude -p` as a reviewer and advisor (see below), not as the author.
6. Everything it produces is subject to the same review, lint (oxlint), format (oxfmt) and tests as your own code.

### Using `claude -p` for review and second opinions

When you're **unsure about an implementation detail** or want your work checked, ask Claude. Good moments:

- **Before implementing** something ambiguous or high-risk: an unclear rule interaction, a `[VERIFY]` item, a design choice these docs leave open, or a spot where two docs seem to contradict each other.
- **After implementing** tricky code, get a review:
  - longest road/route algorithms,
  - bounds operations,
  - the sequencer/election logic,
  - the beacon, deck protocol and DLEQ proofs, Shamir escrow and the audit,
  - WebRTC negotiation, reconnection flows, module hooks.
- **At the end of each stage**: ask for a review of the stage's diff against its doc's acceptance criteria, before ticking them in `STATUS.md`.
- **When stuck** on a failing test, a flaky chaos seed, or a desync you can't explain after a reasonable attempt.

How to ask:

- Run it from the repo root with **read-only tools** so it can inspect the code but not change it, e.g.
  `claude -p "<question>" --allowedTools "Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(pnpm test:*)"`
- Make the prompt specific and self-contained:
  - which doc and section apply (e.g. `docs/07-fair-randomness-hidden-info.md §3`),
  - which files to look at,
  - what you're unsure about,
  - the options you're weighing,
  - what kind of answer you want (a verdict, a list of bugs, a recommended approach).

  For reviews, pass the range to review (`git diff main...HEAD -- packages/crypto`) and ask for concrete issues with file:line references, ranked by severity.

- Example:
  `claude -p "Review packages/engine/src/modules/base/awards/longestRoad.ts against docs/03-base-rules.md 'Awards'. Look for bugs in the trail search (vertex revisits, opponent-building cuts, award transfer on ties). List concrete failing inputs if you find any." --allowedTools "Read,Grep,Glob"`

Handling the answer:

- **Treat it as advice, not authority.** Verify every claimed bug with a failing test before fixing it. When Claude and these docs disagree, the docs win, unless you conclude the doc is wrong (then follow rule 9 of the instructions above).
- For rules questions, Claude's recollection is not a source. `[VERIFY]` items still have to be resolved against the official rules; Claude can help you find and interpret them.
- Record the conclusions of meaningful consultations (question, answer, what you decided) in `DECISIONS.md`.
- Don't paste secrets or private keys into prompts. Test fixtures are fine.

## Stage index

| #   | Document                                                                  | Deliverable                                                          | Depends on                      |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------- |
| 00  | [Architecture](00-architecture.md)                                        | Invariants, package map, glossary                                    | —                               |
| 01  | [Repository foundation](01-repo-foundation.md)                            | Monorepo, tooling, CI, boundaries                                    | 00                              |
| 02  | [Engine core](02-engine-core.md)                                          | Hex geometry, board, state model, input pipeline, module system      | 01                              |
| 03  | [Base rules](03-base-rules.md)                                            | Complete 3–4 player base game                                        | 02                              |
| 04  | [Simulation & rule testing](04-simulation-testing.md)                     | Legal-move generator, RandomBot, fuzzing, invariants, golden replays | 03                              |
| 05  | [Local UI (hotseat)](05-local-ui.md)                                      | Playable local game in the browser                                   | 04                              |
| 06  | [Protocol & event log](06-protocol-event-log.md)                          | Signed commands, hash-chained log, sequencer, in-memory network      | 04                              |
| 07  | [Fair randomness & hidden information](07-fair-randomness-hidden-info.md) | Dice beacon, mental-poker decks, hidden hands, audit, key escrow     | 06                              |
| 08  | [WebRTC networking](08-webrtc-networking.md)                              | Full-mesh transport, signaling adapters, STUN/TURN                   | 06                              |
| 09  | [Lobby & game setup](09-lobby-and-game-setup.md)                          | Invites, seats, config, genesis ceremony, P2P play end-to-end        | 05, 07, 08                      |
| 10  | [Persistence, reconnection, migration](10-persistence-reconnection.md)    | IndexedDB, resume, sequencer failover, seat takeover                 | 09                              |
| 11  | [Module framework & 5–6 players](11-module-framework-5-6-players.md)      | Hardened module composition, `five-six` module                       | 10                              |
| 12  | [Seafaring module](12-seafaring.md)                                       | Ships, pirate, gold, islands, fog, scenarios                         | 11                              |
| 13  | [Knights & Commerce module](13-knights-and-commerce.md)                   | Commodities, improvements, knights, barbarians, progress cards       | 11                              |
| 14  | [Frontier scenarios](14-frontier-scenarios.md)                            | Fishermen, rivers, caravans, barbarian attack, wagons, variants      | 13                              |
| 15  | [Explorers module](15-explorers.md)                                       | Exploration, crews/settlers, missions                                | 12                              |
| 16  | [Bots](16-bots.md)                                                        | Heuristic + search bots in Web Workers                               | 11 (advanced parts after 12/13) |
| 17  | [Spectators, replays, map editor](17-spectators-replays-map-editor.md)    | Spectator mode, replay viewer, custom maps                           | 10                              |
| 18  | [PWA, polish, release](18-pwa-release.md)                                 | Offline install, polish, accessibility, deployment                   | all                             |

Milestones (useful checkpoints):

- **M-A "Rules complete"**: stages 01–04, a headless engine that plays 100k random games without invariant violations.
- **M-B "Playable locally"**: stage 05.
- **M-C "Playable P2P"**: stages 06–09.
- **M-D "Robust P2P"**: stage 10.
- **M-E "Expansions"**: stages 11–15.
- **M-F "Complete product"**: stages 16–18.
