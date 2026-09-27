# Online worker implementation verification

Verified locally on 2026-09-27. The release moves certified multiplayer setup, validation, proofs, journal and live session work into a dedicated browser worker. The main thread renders detached public/local-human snapshots and sends asynchronous commands. Existing pending feedback can now paint while proof work runs. This does not eliminate network agreement latency or change rollback/fairness guarantees.

## Local checks

- Typecheck, lint, formatting, dependency boundaries, engine purity and i18n checks pass. The dependency check was run with Node 22 because the machine default Node 25 is unsupported by dependency-cruiser.
- The complete web unit/integration project passed **242 tests across 62 files** in 67.8 seconds with two test workers. This includes the real two-human startup, restore, writer-lease-loss, room, UI and worker tests.
- The focused worker/proxy/dialog/store set passed **58/58** after the shutdown changes.
- A bounded bridge liveness regression drops one real session SUBMIT frame. The protocol pulse retransmits it; both peers commit the same next head with no disconnect or bridge failure. It passes in 1.43 seconds.
- The Vite production build emits the protocol worker and its nested audit worker.
- Claude reviewed a pinned source snapshot with tools and MCP disabled. Findings and post-review changes are recorded in `online-worker-review-disposition.md`.

## Browser observations

Chrome and the in-app browser played the same two-human game through signed ceremony, eight initial settlement/road placements, a dice roll, an offered/accepted/confirmed Grain-for-Wool trade and an end-turn command. Sending action feedback appeared during submissions. Bank and player trade pickers opened and used the asynchronous validation path. Both browsers restored the same board, dice result and private hands, reconnected, and continued play.

A cached in-app-browser document initially retained an older build on reload and failed its close check. An explicit fresh document loaded the new assets, restored its saved hand and successfully saved and left. The current host also saved and left successfully. No browser failure from an older asset set is counted as acceptance of the final source.

The in-app browser separately started a one-human/three-hosted-bot online game. A hosted bot placed its initial settlement and road; the local human then placed a settlement and road and the other hosted bots completed both their setup placements before control returned to the human. The hosted-bot game also saved and left cleanly. This verifies the runtime's human-only display/control projection while bot execution remains inside the worker. It does not substitute for a two-human/two-bot network acceptance game.

The final Chrome bot-room attempt was interrupted by a password-manager extension popup, so the independent hosted-bot check used the other browser. No Firefox or WebKit process was launched.

## Remaining milestone acceptance

A real terminal audit, mixed-browser capability coverage, detailed proof/heartbeat timing, and a measured reconnect target remain open. The full remote CI run on the earlier commit failed on several expensive crypto test timeouts and a resume polling budget; its simulation and every network-scenario job passed. The resume test now measures bounded inactivity after observable progress and passed twice in isolation plus the full local web suite. The other CI timeouts have not been declared resolved. This report does not mark M-C/M-D complete or claim a green full CI run.
