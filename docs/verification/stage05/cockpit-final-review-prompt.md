# Stage 05 cockpit follow-up review

Read-only review of the current committed UI. Do not edit files, run tests, or run commands. Review only the files and generated screenshots listed here. The user requested Claude's design help throughout this work. Keep the clean, readable cockpit and avoid speculative redesigns.

Read `docs/design/style-guide.md`, `docs/00-architecture.md`, `docs/05-local-ui.md`, and the Stage 05 section of `docs/STATUS.md`.

Current behavior to review:

- Mobile keeps a compact hand, tappable player strip, and persistent Roll/End turn/required-board instruction. Secondary actions open a native sheet. Close that sheet before board placement or another dialog. Required discard and steal choices remain independent of the sheet.
- Mobile player details expose public card totals, Knights, longest route, pieces, awards, status, timers, and eight-second production receipts. Opponents' private identities must not appear.
- Desktop shows two development cards inline. Larger hands overlap up to three faces at narrow desktop widths and five at wider widths. A control opens the full collection beyond that cap; touch screens use a drawer. Hover targets stay stationary while pointer-inert artwork moves. A selected Knight retains visible Cancel/Play controls. Keyboard focus reveals names, and reduced motion suppresses transitions.
- Only committed public `resourceStolen` events create a 650ms neutral card-back flight from victim to thief. The revealed player's endpoint is their hand, other endpoints are public player panels. No private resource data is used. Skip, reduced motion, and session disposal clear pending motion. Restore must not replay historical transfers.
- Results use a full-screen modal over the finished board, correctly combine revealed and end-game VP cards, and support dismissal, reopening, export, and rematch.

Inspect these files:

- `apps/web/src/features/game/GameReadOnly.tsx`
- `apps/web/src/features/game/GameActions.tsx`
- `apps/web/src/features/game/CockpitSheet.tsx`
- `apps/web/src/features/game/NextStepBar.tsx`
- `apps/web/src/features/game/use-compact-cockpit.ts`
- `apps/web/src/features/game/GameOverPanel.tsx`
- `apps/web/src/features/game/visual-effects.ts`
- `apps/web/src/features/game/use-visual-effects.tsx`
- `apps/web/src/features/game/steal-card-flight.css`
- `apps/web/src/features/game/use-appearance.ts`
- `apps/web/src/app.css`
- `apps/web/src/store/session-store.ts`
- Related focused tests, particularly `apps/web/src/features/game/visual-effects.test.ts` and `apps/web/tests/local-game.e2e.ts`.

Inspect these six generated screenshots if your Read tool supports images:

- `reports/stage05/phone-compact-cockpit.png`
- `reports/stage05/phone-actions-sheet.png`
- `reports/stage05/phone-player-details.png`
- `reports/stage05/desktop-three-dev-hover.png`
- `reports/stage05/narrow-desktop-three-dev-knight-intent.png`
- `reports/stage05/inbound-desktop-steal-card.png`

Evidence so far: `pnpm check` passes 317 tests in 74 files and `pnpm build` passes. Focused Chromium checks pass real pointer sweeps and Knight cancellation at 900/1024/1280px, phone/touch-tablet drawers, and replay-backed inbound/outbound steals on desktop/phone with Skip and reduced motion. The all-browser suite including 20 complete UI-driven games is now refreshing against frozen source. Earlier complete runs exist, but do not treat the current refresh as passed until its result is recorded. The physical-phone performance check remains pending at the user's explicit request. Do not mark it complete or request another engine simulation campaign.

Return only concrete defects with severity, file/line, reproducible trigger, and smallest fix. Separate missing acceptance evidence from product defects. Finish with a short visual verdict and state whether all six images were inspected. Do not invent findings to fill the review.
