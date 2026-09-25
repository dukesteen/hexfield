# Stage 05 action and hand follow-up review

Read-only review. Do not edit files, run tests, or run commands. The user explicitly requested Claude's design help; an earlier attempt hit the account limit, which has now reset. Review the current worktree, not an old checkpoint.

Read `docs/design/style-guide.md`, `docs/00-architecture.md`, and `docs/05-local-ui.md`. Keep the current clean, readable game cockpit. The user rejects medieval ornament and wants the board, hand, Actions, and players in one viewport. Preserve approved behavior and avoid speculative redesigns.

Recent requirements and changes:

- Desktop Actions has contextual controls on the left and small square End turn / Bank trade / Offer trade controls stacked at the right. The dock is 180–195px high. Phone controls must remain reachable.
- The hand now gets 60% of desktop dock width. Two development cards stay inline with full names at 1280×720 and 1024×768. Narrow screens or more than two development cards use the existing card dialog. Hide hand is an eye icon with an accessible label, tooltip, and 44px target. Disabled development cards remain gray, and the tooltip explains availability.
- Build costs is a compact public reference dialog using canonical engine constants. It must fit short landscape screens and keep Close visible.
- Road, settlement, and city placement use board-local Confirm/Cancel. Optional build modes can be toggled off. Knight has a cancellable intent step before the card is spent; after confirmation the required robber flow continues.
- Last rolled dice stay at the board's top-right across turn changes and saved-game restoration.
- Monopoly and Year of Plenty now use the shared SVG resource picker and a separate Confirm/Cancel footer. Monopoly selects one type. Year of Plenty requires exactly two requested cards, including duplicates, and preserves existing engine bank-shortage semantics. Selection must not spend the card before Confirm.
- The development-only test hook is now stable for a session. Its versioned action snapshot comes from the displayed UI. It returns no actions while the snapshot's revision is stale, and updates a ref without triggering route renders. Production must omit the hook and debug implementation.

Inspect these current files:

- `apps/web/src/features/game/GameActions.tsx`, `GameReadOnly.tsx`, `BuildCostsDialog.tsx`, `DiceRollReadout.tsx`, their styles, and `apps/web/src/app.css`.
- `apps/web/src/features/dialogs/MonopolyDialog.tsx`, `YearOfPlentyDialog.tsx`, `DialogFrame.tsx`, and `apps/web/src/features/trade/ResourceCard.tsx`.
- `apps/web/src/features/devtools/hook.ts`, `DevDrawer.tsx`, and `apps/web/src/routes/local/$gameId.tsx`.
- Focused component tests and `apps/web/tests/local-game.e2e.ts`, especially two-card hand bounds, development-card confirmation, and the 20-game visible-control driver.

Inspect current screenshots if your Read tool can open images:

- `reports/stage05/desktop-two-development-cards.png`
- `reports/stage05/compact-desktop-two-development-cards.png`
- `reports/stage05/phone-two-development-cards.png`
- `reports/stage05/phone-landscape-build-costs.png`
- `reports/stage05/year-of-plenty-cards-desktop.png`
- `reports/stage05/monopoly-cards-phone.png`

The final all-browser E2E run is in progress against frozen source. Previous focused checks passed. The physical-phone 60 FPS check remains pending at the user's explicit request; desktop emulation is only a proxy. Do not call that criterion complete or request another redundant 110,000-game engine run.

Return concrete defects first, each with severity, file/line, reproducible trigger, and smallest fix. Separate product defects from missing acceptance evidence. Then give a brief visual verdict and at most three high-value suggestions that preserve the user's layout. State if images could not be inspected. Do not invent findings merely to fill the review.
