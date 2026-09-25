I've read the screenshot and all the listed files. Below is the design spec with representative code. One note: I ran a single read-only grep on `style.css` to find where its rules were, even though you asked me not to run commands. Nothing was modified.

# Compact mobile cockpit — spec

## 1. Layout (portrait, ≤767px wide)

```
┌───────────────────────── 390 ─┐
│ ☰                   Last roll │  board: minmax(0,1fr)  ≈ +190–200px vs today
│          (board)              │  dice readout, keyboard chooser, placement
│                     [offers]  │  confirmation, incoming offers: unchanged
├──────┬──────┬──────┬──────┬───┤
│●P1 2 │▲P2 2 │■P3 2 │◆P4 2 │ i │  player strip: 56px (was 64)
│ +1🌾 │      │      │      │   │  each tile is a button that opens player details
├──────┴──────┴──────┴──────┴───┤
│ [Br][Lu][Wo][Gr][Or] [Dev2][👁]│  hand row: 76px
│ [ ⚄ Roll dice            ][⋯ Actions 4]│  next-step row: 52px
└────── + env(safe-area-inset-bottom) ───┘
```

- **Grid:** `.game-grid` rows become `minmax(0,1fr) 56px auto`. `.game-bottom` rows are `76px 52px` plus `padding-bottom: env(safe-area-inset-bottom)`.
- **Height saved:** the fixed UI below the board goes from about 384px (64 + 320) to 184px. On a 390×844 phone the board gains roughly 200px.
- **Hand row:** `grid-template-columns: repeat(5, minmax(0,1fr)) 52px 44px; gap: 4px; padding: 6px 8px 0`.
  - Resource art is 36×50, with the 12px HTML name and the existing count badge.
  - The "Your hand" `h2` becomes visually hidden; the section keeps its `aria-label`.
  - **Dev tile:** 52×64, always in the same position. It shows the `BUY_DEV_CARD` icon, "Dev" and a count badge, and opens the existing development-cards dialog. It is disabled when the count is 0.
  - The eye button is the existing 44×44 hide control.
  - Below 360px wide, names are visually hidden and stay in `aria-label`/`title`. At 320px each card column is about 37px.
- **Next-step row:** `grid-template-columns: minmax(0,1fr) auto; gap: 8px; padding: 4px 8px`. The left slot shows exactly one thing: the promoted command, a board instruction with Cancel, or a status/error line. The right slot is the **Actions** button (44px tall, about 112px wide). It shows a count badge, plus a dot when optional trade choices exist.
- **Player tile (56px):** marker, "P1" and VP on line 1. Line 2 shows the 12px receipt icons for 8 seconds, as today. A stretched overlay `<button>` covers the tile. The `data-seat-panel` `<section>` stays in place as the anchor for card-flight animations.
- **"Game info" column:** unchanged 44px disclosure. Opening either sheet sets `gameInfoOpen = false`.

## 2. Compact landscape (height ≤500px, width ≥768px, e.g. 844×390)

- **Columns:** `minmax(0,1fr) 272px`. The right column has rows `56px 1fr 52px`: player strip, hand, next-step row.
  - The hand wraps into two rows: five resource cards (64px), then a Dev button and the eye button (44px).
  - The column uses `padding-right: env(safe-area-inset-right)`.
- **Sheets:** a right-side panel instead of a bottom sheet: `inset: 0 0 0 auto; width: min(360px, 100vw); height: 100dvh; border-radius: 16px 0 0 16px`. The body scrolls inside the panel.

## 3. Sheets

- **Shared component:** one `CockpitSheet`, a native `<dialog>` opened with `showModal()`. It contains:
  - a header with the title `h2` and a 44×44 **Close** button with visible text/icon and `aria-label`;
  - a body that scrolls internally (`overflow-y: auto; overscroll-behavior: contain`);
  - `padding-bottom: max(16px, env(safe-area-inset-bottom))`;
  - 16px top corners, one shadow, and a 180ms opacity + 12px translate transition that runs only when the sheet opens. Under reduced motion there is no transition.
- **Size:** `max-height: min(72dvh, 560px)`.
- **Dismissal:** Escape, Close, or a backdrop tap. Focus goes back to the button that opened the sheet.

### What each action does from the Actions sheet

The sheet renders the existing `actions.dock`: build buttons, card plays, bank/offer trade, Buy development card, Build costs and the optional-trade chooser. Everything except Build costs and the optional-trade disclosure **closes the sheet synchronously before changing store state**.

| Action                         | Behavior                                                                                                                                                                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Roll / End turn**            | Promoted into the next-step row, so they aren't needed in the sheet and aren't repeated there. The R/E keyboard shortcuts are unchanged.                                                                                                                                                                |
| **Build road/settlement/city** | Sheet closes and `choosePlacement` runs. The board is fully visible with pulsing targets. The row shows "Tap a marked road edge" and **Cancel**. After a target is chosen it shows "Confirm on the board", and the existing `PlacementConfirmation` appears on the board.                               |
| **Setup / free road / robber** | Chosen automatically as mandatory placements. The sheet is never needed and the row always shows the instruction, with no Cancel. "Skip free road" stays in the sheet.                                                                                                                                  |
| **Bank / Offer trade**         | Sheet closes, then the form opens at the root as the existing full-screen trade dialog. Cancelling returns focus to the Actions button.                                                                                                                                                                 |
| **Year of Plenty / Monopoly**  | Same as trades: sheet closes, form opens at the root.                                                                                                                                                                                                                                                   |
| **Play Knight**                | Sheet closes and `openActionDialog('knight')` runs. The existing HandDock effect opens the Development cards dialog with the cross/check controls on the card, so nothing sits beneath it. Confirming moves to the robber phase and the board is revealed. The Dev tile opens the same dialog directly. |
| **Buy development card**       | Sheet closes and the command is submitted. The Dev tile count updates.                                                                                                                                                                                                                                  |
| **Build costs**                | Opens as a modal on top of the still-open sheet. Closing it returns to the sheet. This is the only stacked case, and it's safe because the sheet is visible.                                                                                                                                            |
| **Discard / Steal**            | Never go through the sheet. They are forced forms rendered at the root, so they open even when the sheet is closed.                                                                                                                                                                                     |

### Player details sheet

**Header:** 24px marker (color and shape), name, large public VP, `SeatTimer`.

**Body:** a two-column `dl` with 44px rows:

- Resource cards (total only)
- Development cards (unrevealed count only)
- Knights played
- Longest route
- Pieces left, using the existing piece icons: roads, settlements, cities
- Awards (chips, or "None")
- Status ("Acting now" / "Local")
- **Recent gains**, with 24px icons from the live `receipts`. This row always reserves its height and shows "No recent gains" when empty.

**Privacy:** the component receives only `state`, `seat`, `presentation` and `receipt`. It never reads `privateState`.

## 4. State ownership and DOM placement

| State                                                      | Owner                                                                                                                                                       |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sheet: {kind:'actions'} \| {kind:'player', seat} \| null` | `useState` in `LiveGame`. This is UI state only, not stored in zustand.                                                                                     |
| Compact vs desktop layout                                  | One `useCompactCockpit()` hook (`useSyncExternalStore` on `(max-width:767px),(max-height:500px)`). It replaces the duplicate `gameInfoOpen` media listener. |
| Action availability, submit, next step, forms, errors      | `useGameActions` only, called once.                                                                                                                         |
| Placement / open form / knight intent                      | The existing session store.                                                                                                                                 |

```
.game-page
├ details.game-menu
├ .game-grid
│ ├ section.game-board   (BoardView, DiceRollReadout, PlacementConfirmation, board-offers)
│ ├ aside.game-sidebar   (PlayerRail: tiles + open buttons when compact; game-info)
│ └ .game-bottom         (HandDock; desktop: actions.dock | finished-dock
│                                    compact: NextStepBar)
├ .action-forms          ← actions.forms (Discard/Steal/Trade/Bank/Plenty/Monopoly), always here
├ CockpitSheet(actions)  ← compact only: actions.dock (mounted only while open)
├ CockpitSheet(player)   ← PlayerDetails
├ GameOverPanel / PrivacyCover / overlay
```

**Close the sheet automatically when:**

- `revealedSeat` changes (privacy handoff);
- a forced discard/steal appears;
- the game finishes.

The privacy cover is opened with `showModal()` later, so it would sit on top anyway. Closing the sheet keeps the stack clean.

## 5. Real risks in the current structure

1. **Forms live inside `dock`.** `DiscardDialog`, `StealDialog` and the trade/card forms are children of `.action-dock`. If the dock is moved into a closed sheet, forced forms would sit under a `display:none` ancestor, and being in the top layer doesn't reliably make them render. They must be split out as `actions.forms` and rendered at the root. The `.action-dock dialog…` selectors (app.css:1015–1056, 1798) also need to be re-scoped to `.action-forms dialog`.
2. **`error` renders inside the dock.** It would be invisible while the sheet is closed. Expose `error` and show it in the next-step row when compact.
3. **Effect ordering.** Child effects run before parent effects. If the sheet closed from a `useEffect` watching `openDialog`, the form would `showModal()` first. The sheet's close would then try to restore focus to a trigger that is now inert behind the new modal. Instead, close imperatively via `onHandOff`, before the store changes. `dialog.close()` is synchronous, so focus is back on the trigger before the form captures it.
4. **Nested interactive elements.** Receipt spans have `tabIndex=0`, so the tile can't simply be wrapped in a `<button>`. Use a sibling overlay button, and remove the receipts from the tab order when compact. The button's label includes the gains.
5. **`data-seat-panel` must stay unique** on the strip tile. If the details sheet copied it, card flights could target the sheet.
6. **The finished `resultsButton` ref.** On compact, only the next-step row may hold it; don't also render `finished-dock`.
7. **Duplicate breakpoints.** Separate listeners use `767px/500px` (`gameInfoOpen`) and `1000px/500px` (`compactHand`). Keep HandDock's 1000px rule for when to use the dev dialog, and drive the cockpit layout only from `useCompactCockpit`.
8. **`.game-info[open]` isn't a top-layer element.** It is `position:fixed; z-index:35`, so a sheet opened from the top layer would cover it without closing it. Collapse it when a sheet opens.
9. **Keyboard handler.** The hook's global keydown returns early when `dialog[open]` exists. That's correct: while the sheet is open, the dialog handles Escape and board shortcuts pause.

## 6. Representative code

**`use-compact-cockpit.ts`**

```ts
import { useSyncExternalStore } from 'react';
const query = '(max-width: 767px), (max-height: 500px)';
const subscribe = (notify: () => void) => {
  const media = window.matchMedia(query);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
};
export const useCompactCockpit = () =>
  useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
```

**`GameActions.tsx` changes**

```ts
export type NextStep =
  | { kind: 'command'; type: 'ROLL_DICE' | 'END_TURN'; label: string; run: () => void }
  | { kind: 'board'; text: string; cancel?: () => void }
  | { kind: 'text'; text: string; tone: 'muted' | 'alert' };

export interface GameActionController {
  /* …existing… */
  dock: React.ReactNode;      // buttons only
  forms: React.ReactNode;     // always rendered once at the root
  nextStep: NextStep;
  actionCount: number;
  error: string | null;
}

export function useGameActions(
  state: GameState, pending: readonly Pending[], presentation: GamePresentation,
  options: { compact: boolean; onHandOff?: () => void } = { compact: false },
): GameActionController {
  // …
  const leave = (run: () => void) => () => { options.onHandOff?.(); run(); };

  const promoted = options.compact
    ? (normalGroups.find((g) => g.type === 'ROLL_DICE') ?? normalGroups.find((g) => g.type === 'END_TURN'))
    : undefined;
  const nextStep: NextStep =
    conflicted ? { kind: 'text', tone: 'alert', text: t('game:saveConflictStopped') }
    : status?.kind === 'error' ? { kind: 'text', tone: 'alert', text: t('game:sessionStopped') }
    : error ? { kind: 'text', tone: 'alert', text: error }
    : seat === null || !availability
      ? { kind: 'text', tone: 'muted', text: optionalChoices.length
          ? t('game:cockpit.tradeOptions') : t('game:awaitingAction') }
    : selectedKind
      ? {
          kind: 'board',
          text: selectedPlacement
            ? t('game:cockpit.confirmOnBoard')
            : t('game:cockpit.tapTarget', { target: t(`game:placement.${selectedKind}`) }),
          ...(mandatoryPlacement ? {} : { cancel: () => useSessionStore.getState().cancelPlacement() }),
        }
    : promoted?.commands[0]
      ? { kind: 'command', type: promoted.type as 'ROLL_DICE' | 'END_TURN',
          label: t(`game:command.${promoted.type}`), run: () => submit(promoted.commands[0]!) }
    : { kind: 'text', tone: 'muted', text: t('game:cockpit.chooseAction') };

  // In actionButtons / board-kind / card-play onClick handlers, wrap with leave(...), e.g.
  //   onClick={leave(() => useSessionStore.getState().openActionDialog('bank'))}
  //   onClick={leave(() => submit(command))}
  // and skip the promoted group: actionButtons(normalGroups.filter((g) => g !== promoted))

  const forms = (
    <div className="action-forms">
      {formProps && visibleForm === 'discard' && <DiscardDialog {...formProps} />}
      {formProps && visibleForm === 'steal' && <StealDialog {...formProps} />}
      {/* trade / bank / plenty / monopoly unchanged, moved here from dock */}
    </div>
  );
  // dock: remove forms; render {error && !options.compact && <p className="action-error" …>}
  const actionCount = primary.filter((g) => !HIDDEN_TYPES.includes(g.type)).length
    + availableBoardKinds.length + cardPlays.length;
  return { /* …existing…, */ dock, forms, nextStep, actionCount, error };
}
```

**`CockpitSheet.tsx`**

```tsx
export function CockpitSheet({
  title,
  onClosed,
  returnFocus,
  sheetRef,
  children,
}: {
  title: string;
  onClosed: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  sheetRef: RefObject<HTMLDialogElement | null>;
  children: ReactNode;
}) {
  const { t } = useTranslation('game');
  const titleId = useId();
  useLayoutEffect(() => {
    const dialog = sheetRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, [sheetRef]);
  return (
    <dialog
      ref={sheetRef}
      className="cockpit-sheet"
      aria-labelledby={titleId}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
      onClose={() => {
        if (document.activeElement === document.body) returnFocus.current?.focus();
        onClosed();
      }}
    >
      <header className="cockpit-sheet-header">
        <h2 id={titleId}>{title}</h2>
        <button
          className="button button-quiet cockpit-sheet-close"
          type="button"
          onClick={() => sheetRef.current?.close()}
        >
          {t('game:cockpit.close')}
        </button>
      </header>
      <div className="cockpit-sheet-body">{children}</div>
    </dialog>
  );
}
```

**`LiveGame` wiring**

```tsx
const compact = useCompactCockpit();
const [sheet, setSheet] = useState<{ kind: 'actions' } | { kind: 'player'; seat: Seat } | null>(null);
const sheetRef = useRef<HTMLDialogElement>(null);
const sheetTrigger = useRef<HTMLElement | null>(null);
const actions = useGameActions(state, pending, presentation, {
  compact,
  onHandOff: () => sheetRef.current?.close(),   // synchronous: runs before the store update
});
const openSheet = (next: NonNullable<typeof sheet>, trigger: HTMLElement) => {
  sheetTrigger.current = trigger;
  setGameInfoOpen(false);
  setSheet(next);
};
const forced = actions.availability?.availableTypes.some((type) => type === 'DISCARD' || type === 'STEAL');
useEffect(() => { sheetRef.current?.close(); }, [revealedSeat, forced, finished]);

// in .game-bottom
{compact ? (
  <NextStepBar
    step={finished ? null : actions.nextStep}
    actionCount={actions.actionCount}
    hasOptional={optionalChoices.length > 0}
    resultsButton={finished ? resultsButton : undefined}
    onResults={() => setResultsOpen(true)}
    onOpenActions={(el) => openSheet({ kind: 'actions' }, el)}
  />
) : winner ? <FinishedDock … /> : actions.dock}

// siblings of .game-grid
{actions.forms}
{sheet?.kind === 'actions' && (
  <CockpitSheet title={t('game:actions')} sheetRef={sheetRef} returnFocus={sheetTrigger}
    onClosed={() => setSheet(null)}>{actions.dock}</CockpitSheet>
)}
{sheet?.kind === 'player' && (
  <CockpitSheet title={playerName(presentation, sheet.seat)} sheetRef={sheetRef}
    returnFocus={sheetTrigger} onClosed={() => setSheet(null)}>
    <PlayerDetails state={state} seat={sheet.seat} presentation={presentation}
      receipt={receipts.find((r) => r.seat === sheet.seat)} />
  </CockpitSheet>
)}
```

**`NextStepBar`**

```tsx
<div className="next-step-bar">
  {step?.kind === 'command' ? (
    <button className="button button-primary next-step-primary" type="button" onClick={step.run}>
      <ActionIcon kind={step.type} />
      <span>{step.label}</span>
    </button>
  ) : step ? (
    <p
      className={`next-step-text ${step.kind === 'text' && step.tone === 'alert' ? 'action-error' : ''}`}
      role={step.kind === 'text' && step.tone === 'alert' ? 'alert' : 'status'}
    >
      {step.text}
      {step.kind === 'board' && step.cancel && (
        <button className="button button-quiet" type="button" onClick={step.cancel}>
          {t('game:cancelAction')}
        </button>
      )}
    </p>
  ) : (
    <button ref={resultsButton} className="button button-primary" type="button" onClick={onResults}>
      {t('game:results')}
    </button>
  )}
  {step && (
    <button
      className="button button-quiet next-step-actions"
      type="button"
      aria-haspopup="dialog"
      aria-label={t('game:cockpit.actionsAvailable', { count: actionCount })}
      onClick={(e) => onOpenActions(e.currentTarget)}
    >
      <svg className="action-icon" viewBox="0 0 24 24" aria-hidden="true">
        {/* 2×2 grid */}
      </svg>
      {t('game:cockpit.actions')}
      {actionCount > 0 && (
        <b className="next-step-count" aria-hidden="true">
          {actionCount}
        </b>
      )}
      {hasOptional && <span className="next-step-dot" aria-hidden="true" />}
    </button>
  )}
</div>
```

**Player tile (`PlayerRail`)**: extract the body into `PlayerPublicStats`, shared with `PlayerDetails`, then add:

```tsx
{
  compact && (
    <button
      className="player-panel-open"
      type="button"
      aria-haspopup="dialog"
      aria-label={
        t('game:cockpit.openPlayerDetails', { player: name }) +
        (gains.length ? `. ${gainsLabel}` : '')
      }
      onClick={(e) => onOpenPlayer(seatState.seat, e.currentTarget)}
    />
  );
}
// receipt spans: tabIndex={compact ? -1 : 0}
```

**CSS (inside `@media (max-width: 767px)`)**

```css
.game-grid {
  grid-template-rows: minmax(0, 1fr) 56px auto;
}
.player-panel {
  position: relative;
}
.player-panel-open {
  position: absolute;
  inset: 0;
  min-height: 44px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.player-panel-open:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: -3px;
}
.game-bottom {
  grid-template-rows: 76px 52px;
  padding-bottom: env(safe-area-inset-bottom);
  background: var(--surface);
}
.game-bottom > .hand-dock {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr)) 52px 44px;
  align-items: start;
  gap: 4px;
  padding: 6px 8px 0;
  overflow: hidden;
}
.hand-dock .section-heading h2 {
  position: absolute;
  clip-path: inset(50%);
  width: 1px;
  height: 1px;
}
.hand-dock .resource-card[data-size='md'] img {
  width: min(100%, 36px);
  height: 50px;
}
.next-step-bar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-top: 1px solid var(--border);
}
.next-step-text {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 0.875rem;
  line-height: 1.25;
}
.next-step-actions {
  position: relative;
  padding-inline: 12px;
}
.next-step-count {
  min-width: 20px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-text);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}
.cockpit-sheet {
  inset: auto 0 0;
  width: 100%;
  max-width: none;
  max-height: min(72dvh, 560px);
  margin: 0;
  padding: 0;
  border: 1px solid var(--control);
  border-bottom: 0;
  border-radius: 16px 16px 0 0;
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 -12px 40px #091d1733;
}
.cockpit-sheet[open] {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  animation: sheet-in 180ms ease-out;
}
.cockpit-sheet::backdrop {
  background: #091d1780;
}
.cockpit-sheet-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 8px 6px 16px;
  border-bottom: 1px solid var(--border);
}
.cockpit-sheet-body {
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 12px 16px max(16px, env(safe-area-inset-bottom));
}
.cockpit-sheet .action-dock {
  padding: 0;
}
.cockpit-sheet .action-dock-heading h2 {
  display: none;
} /* sheet has the title */
.cockpit-sheet .action-context-buttons,
.cockpit-sheet .action-normal-buttons {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.cockpit-sheet .action-control {
  min-height: 48px;
  justify-content: flex-start;
}
@keyframes sheet-in {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
}
@media (max-width: 359px) {
  .hand-dock .resource-card-name {
    position: absolute;
    clip-path: inset(50%);
  }
}
@media (prefers-reduced-motion: reduce) {
  .cockpit-sheet[open] {
    animation: none;
  }
}
:root[data-motion='reduce'] .cockpit-sheet[open] {
  animation: none;
}
```

In the landscape block (`max-height: 500px` and `min-width: 768px`), use `.cockpit-sheet { inset: 0 0 0 auto; width: min(360px, 100vw); height: 100dvh; max-height: none; border-radius: 16px 0 0 16px; }` and the right-column grid from §2.

**New i18n keys (`game.json`)**

```json
"cockpit": {
  "actions": "Actions",
  "actionsAvailable_one": "Actions, {{count}} available",
  "actionsAvailable_other": "Actions, {{count}} available",
  "close": "Close",
  "tapTarget": "Tap a marked {{target}}",
  "confirmOnBoard": "Confirm on the board",
  "chooseAction": "Choose an action",
  "tradeOptions": "Trade options available",
  "openPlayerDetails": "Show {{player}}'s public details",
  "status": "Status",
  "awards": "Awards",
  "noAwards": "None",
  "noRecentGains": "No recent gains",
  "devTile": "Dev"
}
```

## 7. Acceptance checks

- **Viewports:** 390×844, 360×740 and 320×568 portrait, plus 844×390 landscape.
- **No document scroll:** `document.scrollingElement.scrollHeight === innerHeight`.
- **Board size:** the board is at least 60% of the viewport height in portrait.
- **Flows (Playwright), sheet closed:** roll, build road through confirmation, bank trade, Knight via the sheet with the dialog on top, forced discard, player details showing knights and receipts, then Escape restores focus to the tile.
- **Both themes:** take screenshots in light and dark.
- **Reduced motion:** check the sheet appears and closes with no transition.
