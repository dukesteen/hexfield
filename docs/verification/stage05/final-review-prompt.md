# Stage 05 final review request

Review the current Stage 05 implementation against `docs/00-architecture.md` and `docs/05-local-ui.md`. This is a read-only review. Do not edit files or run tests. Report only concrete defects or unmet acceptance criteria, with severity, file and line references, a reproducible trigger, and the smallest reasonable fix. Distinguish a product bug from missing evidence. Do not expand the work into Stage 06 or later.

The user wants clean, readable controls. Recent requests require blue sea tiles, upright ports visibly joined to both eligible coastal vertices, consistent board scaling, larger rolling dice, and road/settlement/city previews with explicit on-board Confirm and Cancel actions. Confirmation applies during setup, ordinary construction, and Road Building. The selected location must remain changeable before confirmation. Empty settlement sites need high-contrast indicators, and city upgrade markers must remain visible outside existing pieces. The renderer must use engine-supplied legal IDs and must never mutate rules state.

Prioritize these files and their focused tests:

- `apps/web/src/session/local-session.ts` and the session tests, including save restoration, timers, paused validation, automatic outcomes, public production events, and private state access.
- `apps/web/src/store/session-store.ts`, `pending-actors.ts`, and their tests, including three-human snake setup, optional trade handoffs, privacy clearing, and single-human bot turns.
- `apps/web/src/features/game/GameActions.tsx`, `GameReadOnly.tsx`, `GameOverPanel.tsx`, `stats.ts`, `event-format.ts`, and the visual-effects files.
- `apps/web/src/features/dialogs/`, `apps/web/src/features/trade/`, and their tests. Check actual engine command shapes and every development-card flow.
- `apps/web/src/routes/local/$gameId.tsx`, `new.tsx`, `apps/web/src/queries/`, and their tests. Check save conflicts, rematch lifecycle, import/export validation, navigation guards, and query/store separation.
- `packages/renderer/src/BoardRenderer.ts`, geometry/layout helpers, renderer types, and `apps/web/src/features/board/BoardView.tsx`. Check camera transforms, legal target and preview visibility, effect cancellation, disposal, and lifecycle cleanup.
- `apps/web/tests/local-game.e2e.ts`, `renderer-effects.e2e.ts`, and `renderer-performance.e2e.ts`. Check whether the tests actually exercise visible controls and establish their stated results.

Native `resourcesProduced` events were added at the engine's existing bank allocation boundary. They contain actual public gains and must survive authoritative replay without changing state hashes. Stage 04 simulations and golden replay acceptance already passed before this small event change. Review its semantics without requesting a redundant 110,000-game run merely because event reporting changed.

The final twenty-game run and full local CI will run on frozen source after review fixes. Earlier twenty-game runs overlapped renderer edits and are explicitly recorded as pilots. The mobile rendering measurement uses a 390 by 844 viewport with 4x Chromium CPU throttling on an Apple M3 Pro. That is a proxy, not physical mid-range-phone evidence. A recent complete-game engine benchmark exceeds the previous 30 ms budget, but the isolated accepted Stage 04 source also runs slower on the current host. Neither limitation should be disguised as a pass.

Give an overall verdict after listing the concrete findings. Avoid speculative rewrites and styling preferences that contradict the user's approved screenshots.
