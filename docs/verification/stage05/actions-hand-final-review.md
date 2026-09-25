# Claude follow-up review, 2026-09-25

Read-only response to [the approved review brief](actions-hand-final-review-prompt.md), preserved below. This is advice, not acceptance evidence. The reviewer inspected the listed source and six screenshots but explicitly did not read the requested architecture, stage, or style documents. The earlier stage reviews and the coordinator's checks remain necessary.

I found one product defect worth fixing before sign-off, two minor ones, and three gaps in acceptance evidence. I read the code and tests without editing anything or running commands, and I opened all six screenshots. I didn't read the three docs you listed (`style-guide.md`, `00-architecture.md`, `05-local-ui.md`), so the visual verdict relies on the screenshots and your stated constraints.

## Product defects

**1. Medium: on desktop, the Knight Confirm/Cancel controls land below the visible part of the Actions dock.**

- **Where:** `apps/web/src/features/game/GameActions.tsx:548-571`, with `app.css:498` (dock row `clamp(180px, 20dvh, 195px)`), `:885` (`.action-context` top padding of 44px) and `:838` (the dock scrolls).
- **Trigger:** at 1280×720 after rolling, click Play Knight. In `desktop-two-development-cards.png`, Play Knight already sits around y≈613 and "Optional trade actions" around y≈666. The confirmation block adds about 82px below that (8px margin, 8px padding, the title, 6px gap, a 44px button row), so it ends near y≈760 in a 720px viewport. If the player can also build, the road/settlement/city buttons take more rows in the roughly 300px context column and push it lower. Scrolling the dock also moves the Actions heading out of view.
- **Why tests miss it:** the Knight test at `local-game.e2e.ts:494` checks `toBeVisible()`, which passes off-screen, and Playwright's `.click()` scrolls automatically.
- **Smallest fix:** give the confirmation `<div>` a ref and call `scrollIntoView({ block: 'nearest' })` when it mounts. Then add `await expect(confirmation.getByRole('button', { name: 'Play Knight' })).toBeInViewport()` at 1280×720 and 1024×768.
- **Alternative:** move this confirmation into the same board-local overlay that road, settlement and city placement use. That is more consistent but a bigger change, so I wouldn't do it now.

**2. Low: Year of Plenty accepts a third card and more.**

- **Where:** `YearOfPlentyDialog.tsx:40-43`.
- **Trigger:** tap Grain three times. The footer shows "Selected 3 of 2" and Confirm stays disabled, so nothing wrong gets submitted, but the picker let the player make an impossible choice.
- **Smallest fix:** in `change`, return early when `selected - resources[resource] + count > 2`. For a visual cue too, pass `selectable={selected >= 2 ? RESOURCES.filter(r => resources[r] > 0) : undefined}`.

**3. Low / spec question: at 1024×768 the hand gets 62.5% of the dock, not 60%.**

- **Where:** `app.css:1355-1358` sets `1.25fr / 0.75fr` between 1001px and 1260px.
- **Evidence:** the compact screenshot measures about 464 of 744px, which is 62%. At 1280×720 it's exactly 60%.
- **Fix:** if the 60% rule is strict, change the override to `1.2fr / 0.8fr` and recheck that two cards still fit (my estimate is about 180px free against 148px needed). If the override is deliberate, record it in `docs/DECISIONS.md`.

**Checked and correct:**

- **Dev hook:** `subscribe` fires right away, so `revision` is correct even when a saved game is restored. The revision check makes snapshots from the wrong revision return null, route re-renders don't trigger it, and cleanup removes only the hook that installed itself.
- **Card spending:** Monopoly and Year of Plenty don't spend the card before Confirm. The Monopoly selection switches correctly, and the engine still pays fewer cards when the bank runs short (`devcards.ts:79-84`).
- **Build costs:** the dialog reads the engine's canonical constants.
- **Last roll:** it's derived from the full event log (`session.getEvents()`), so it survives turn changes and save restoration.
- **Build-mode toggles:** pressing an active build button again turns it off in optional modes and clears the candidate in mandatory ones.
- **Knight → robber:** after Confirm, the store clears the Knight state when the phase changes, and the robber flow continues.
- **Dev cards:** only victory points skip the gray style. The tooltip and `aria-label` both carry the availability reason. The hide-hand button is 44px.

## Missing acceptance evidence (not product defects)

1. **Production omission of the hook.** The code looks right: `import.meta.env.DEV` guards both the lazy `DevDrawer` and the dynamic `installDevHook` import. But I found no test or recorded check that the built bundle lacks `__cp2p`, `installDevHook` or the `DevDrawer` chunk. A preview-build check (`window.__cp2p === undefined`, no devtools chunk) would close this.
2. **The 20-game driver never plays a development card**, and never trades or builds roads outside setup (`local-game.e2e.ts:1634-1658`). It proves no inputs are rejected along a narrow path. Coverage of Knight, Monopoly and Year of Plenty comes only from the single replay-backed tests.
3. **Physical-phone 60 FPS is still pending, as you asked.** Desktop emulation is only a proxy, so this criterion isn't complete.

## Visual verdict

The layout holds. At both desktop sizes the board, hand, Actions and players fit in one viewport. Development cards show full names (Road building wraps cleanly at 1024). Disabled cards are clearly gray, and the stacked End turn / Bank trade / Offer trade buttons fit in 180px. The last-roll card is small and clear. On phone the card dialog and fullscreen Monopoly are usable. In phone landscape, Build costs fits with Close visible. In the Year of Plenty dialog, the footer separates Confirm/Cancel well. There's no medieval ornament anywhere.

## Suggestions (keep your layout)

1. **Fix the Knight confirmation** as in defect 1, and add the in-viewport assertion so a dock overflow can't recur silently.
2. **Hide the "1" count badge and the "1 card selected" line in single-select Monopoly** (in `monopoly-cards-phone.png`). They make it read as taking one card rather than choosing a type. The selected outline is enough.
3. **Make the capitalization consistent.** The button says "Play Year of plenty" but the dialog title says "Year of Plenty", visible together in `year-of-plenty-cards-desktop.png`. That's a one-line fix in the `game` locale's development-card name.
