# Full-screen results dialog: design spec

This is a proposal only. I didn't edit files or run anything.

## 1. Score fix, without touching the scoring logic

`victoryBreakdown` already calculates correctly. The bug is in how it's shown. `hidden` holds the VP cards that were _still hidden at the end_. The winner's claim had already revealed theirs, so the "End-game revealed VP cards" row showed 0. Leave `victoryBreakdown` as it is and add one presentation helper to `stats.ts`:

```ts
/** Display summary: revealed and end-game hidden VP cards counted exactly once. */
export function finalScore(state: GameState, seat: Seat, hidden: number | null) {
  const { buildings, awards, revealed, total } = victoryBreakdown(state, seat, hidden);
  return {
    buildings,
    awards,
    revealedVpCards: revealed,
    vpCards: hidden === null ? null : revealed + hidden,
    total, // stays null when private end-game info is unavailable
  };
}
```

- **Unit test for the reported case:** buildings 6, awards 2, 2 revealed, `hidden = 0` gives `{ 6, 2, vpCards: 2, total: 10 }`.
- **Second case:** `hidden = null` gives `vpCards: null` and `total: null`. The UI then shows the VP cards value as `2+?` and the total as "Full score unavailable".

**Standings order:**

- The winner always comes first, taken from `state.result.winner` and never from comparing totals.
- The other players follow by known total (highest first). Unknown totals go last, and ties keep seat order.
- Don't show "1st/2nd" labels. Mark the winner only with a "Winner" badge.

## 2. Integration in `LiveGame`

```tsx
const finished = Boolean(state.result);
const [resultsOpen, setResultsOpen] = useState(finished); // opens when a completed game loads
const wasFinished = useRef(finished);
const resultsButton = useRef<HTMLButtonElement>(null);
useEffect(() => {
  if (finished && !wasFinished.current) setResultsOpen(true); // opens once when the game completes
  if (!finished) setResultsOpen(false); // dev-tools rewind
  wasFinished.current = finished;
}, [finished]);
const closeResults = () => {
  setResultsOpen(false);
  requestAnimationFrame(() => resultsButton.current?.focus()); // auto-open had no prior focus to return to
};
```

- In `.game-bottom`, replace `<GameOverPanel>` with a `FinishedDock`. It renders with the `action-dock` class, so the grid, the hand and the Actions slot sizes stay exactly the same.
  - It shows one line: "Ada won with 10 VP".
  - Below that, a primary **Results** button (`ref={resultsButton}`, 44 px high).
- Also add a **Results** item to the `game-menu` panel for finished games.
- Render `{finished && resultsOpen && <ResultsDialog … onClose={closeResults} />}` as a sibling of `PrivacyCover`, so the board, hand and dock stay mounted behind it.

**`DialogFrame` changes (small):**

- Accept `variant?: 'trade' | 'results'`.
- For `results`, set `className="results-dialog"` and wrap the children in `<div className="results-body">`, the same way `trade` does.
- Add `onClose={() => onCancel?.()}`. If the browser closes the dialog itself without a cancel event, React state still stays in sync.

## 3. DOM structure

```tsx
<DialogFrame
  variant="results"
  title={t('game:winner', { player: winnerName })}
  onCancel={onClose}
  footer={
    <footer className="results-footer" aria-busy={busy}>
      {error && (
        <p className="action-error" role="alert">
          {t('game:gameOverActionFailed')}
        </p>
      )}
      <button className="button button-quiet results-view-board" type="button" onClick={onClose}>
        {t('game:viewBoard')}
      </button>
      <button
        className="button button-quiet"
        type="button"
        disabled={busy}
        onClick={() => void run(onExportReplay)}
      >
        {t('game:exportReplay')}
      </button>
      <button
        className="button button-primary"
        type="button"
        disabled={busy}
        onClick={() => void run(onRematch)}
      >
        {t('game:rematch')}
      </button>
    </footer>
  }
>
  <div className="results-layout">
    <section className="results-hero" aria-label={t('game:resultsWinnerScore')}>
      <div className="results-hero-identity">
        <PlayerMarker identity={winnerIdentity} />
        <strong>{winnerName}</strong>
        <span className="results-badge">{t('game:resultsWinnerBadge')}</span>
      </div>
      <p className="results-total">
        {w.total === null ? (
          t('game:scoreUnknown')
        ) : (
          <>
            <span className="results-total-value">{w.total}</span> <span>{t('game:vpShort')}</span>
          </>
        )}
      </p>
      <ScoreBreakdown score={w} />
    </section>

    <section className="results-standings" aria-labelledby="standings-h">
      <h3 id="standings-h">{t('game:standings')}</h3>
      <ul>
        {ordered.map((p) => (
          <li className="standing" data-winner={p.seat === winnerSeat || undefined} key={p.seat}>
            <PlayerMarker identity={p.identity} />
            <span className="standing-name">
              {p.name}
              {p.seat === winnerSeat && (
                <span className="results-badge">{t('game:resultsWinnerBadge')}</span>
              )}
            </span>
            <ScoreBreakdown score={p.score} compact />
            <span className="standing-total">
              {p.score.total ?? '?'} <small>{t('game:vpShort')}</small>
            </span>
          </li>
        ))}
      </ul>
    </section>

    <details className="results-details" open={!compact}>
      <summary>{t('game:gameStats')}</summary>
      <figure className="results-dice">
        <figcaption>
          {t('game:diceHistory')} · {t('game:diceRollTotal', { count: totalRolls })}
        </figcaption>
        <ol className="dice-histogram">
          {dice.map(({ roll, count }) => (
            <li className="dice-bar" key={roll} aria-label={t('game:diceCount', { roll, count })}>
              <span aria-hidden="true" className="dice-bar-count">
                {count}
              </span>
              <span
                aria-hidden="true"
                className="dice-bar-fill"
                style={{ '--h': count / peak } as CSSProperties}
              />
              <span aria-hidden="true">{roll}</span>
            </li>
          ))}
        </ol>
      </figure>
      <table className="results-production">
        <caption>{t('game:resourcesProduced')}</caption>
        <tbody>{/* marker + name | tabular count | bar (width = count / max) */}</tbody>
      </table>
    </details>
  </div>
</DialogFrame>
```

**`ScoreBreakdown`:**

- Uses `<dl className="score-breakdown">` with four cells: Buildings, Awards, VP cards, Total.
- When `vpCards === null`, the VP cards cell shows `t('game:scoreVpCardsPartial', { count: revealedVpCards })` → "2+?".
- `compact` leaves out the Total cell, because `.standing-total` already shows it.

**Other details:**

- `compact` uses the existing `matchMedia('(max-width: 767px), (max-height: 500px)')` pattern.
- Compute dice and production once, with `useMemo` over `events`.
- `busy`/`error`/`run` move over unchanged from `GameOverPanel`.

## 4. CSS

```css
.results-dialog {
  inset: 0;
  width: 100dvw;
  height: 100dvh;
  max-width: none;
  max-height: none;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  background: var(--surface);
  color: var(--text);
  z-index: 40;
}
.results-dialog[open] {
  animation: results-in 180ms ease-out;
}
.results-dialog::backdrop {
  background: #091d17a8;
}
@keyframes results-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .results-dialog[open] {
    animation: none;
  }
}
:root[data-motion='reduce'] .results-dialog[open] {
  animation: none;
}

.results-dialog > h2 {
  /* header */
  min-height: 64px;
  display: flex;
  align-items: center;
  padding: 12px max(24px, env(safe-area-inset-left));
  border-bottom: 1px solid var(--border);
  font-size: 1.75rem;
  font-weight: 760;
  letter-spacing: -0.025em;
}
.results-dialog > h2:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: -3px;
}
.results-body {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 24px 32px;
}
.results-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 12px 32px max(12px, env(safe-area-inset-bottom));
  border-top: 1px solid var(--border);
  background: var(--surface);
}
.results-footer .results-view-board {
  margin-right: auto;
}
.results-footer [role='alert'] {
  flex-basis: 100%;
}

.results-layout {
  max-width: 1180px;
  margin: 0 auto;
  display: grid;
  gap: 24px 32px;
  grid-template-columns: minmax(0, 1.35fr) minmax(300px, 1fr);
  grid-template-areas: 'hero stats' 'standings stats';
  align-items: start;
}
.results-hero {
  grid-area: hero;
  padding: 24px;
  border: 1px solid var(--border);
  border-radius: 12px;
}
.results-hero-identity {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 1.25rem;
}
.results-hero-identity .player-marker {
  --marker: 28px;
}
.results-total {
  margin-top: 8px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  font-weight: 680;
}
.results-total-value {
  font-size: 3.5rem;
  line-height: 1;
  font-weight: 780;
  color: var(--text);
}
.score-breakdown {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin: 16px 0 0;
}
.score-breakdown > div {
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--raised);
}
.score-breakdown dt {
  font-size: 0.8125rem;
  color: var(--muted);
}
.score-breakdown dd {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 720;
  font-variant-numeric: tabular-nums;
}
.score-breakdown.is-compact {
  grid-template-columns: repeat(3, auto);
  justify-content: start;
  margin: 0;
}
.score-breakdown.is-compact > div {
  display: flex;
  gap: 4px;
  padding: 0;
  background: none;
  font-size: 0.8125rem;
}
.score-breakdown.is-compact dd {
  font-size: inherit;
}

.results-standings {
  grid-area: standings;
}
.results-standings ul {
  display: grid;
  gap: 8px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}
.standing {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  gap: 4px 12px;
  grid-template-areas: 'marker name total' '. breakdown total';
  align-items: center;
  min-height: 64px;
  padding: 10px 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
}
.standing[data-winner] {
  border: 2px solid var(--accent);
  padding: 9px 15px;
}
.standing-total {
  grid-area: total;
  font-size: 1.5rem;
  font-weight: 760;
  font-variant-numeric: tabular-nums;
}
.results-badge {
  margin-left: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--accent-text);
  background: var(--accent);
}

.results-details {
  grid-area: stats;
}
.results-details > summary {
  min-height: 44px;
  display: flex;
  align-items: center;
  font-weight: 700;
  cursor: pointer;
}
.results-dice .dice-histogram {
  display: grid;
  grid-template-columns: repeat(11, minmax(0, 1fr));
  align-items: end;
  gap: 4px;
  height: 128px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}
.results-dice .dice-bar-fill {
  height: calc(var(--h) * 88px);
}
.results-production {
  width: 100%;
  margin-top: 24px;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}
.results-production td {
  height: 44px;
  border-top: 1px solid var(--border);
}

@media (max-width: 767px) {
  /* 390x844: header 56, footer 120, about 668 px of content */
  .results-dialog > h2 {
    min-height: 56px;
    padding-inline: 16px;
    font-size: 1.375rem;
  }
  .results-body {
    padding: 16px;
  }
  .results-layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: 'hero' 'standings' 'stats';
    gap: 16px;
  }
  .results-hero {
    padding: 16px;
  }
  .results-total-value {
    font-size: 2.75rem;
  }
  .score-breakdown {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .results-footer {
    display: grid;
    grid-template-columns: 1fr 1fr;
    padding-inline: 16px;
  }
  .results-footer .button-primary,
  .results-footer [role='alert'] {
    grid-column: 1 / -1;
  }
}
@media (max-height: 500px) and (min-width: 768px) {
  /* 844x390: header 48, footer 60, about 282 px of content */
  .results-dialog > h2 {
    min-height: 48px;
    padding-block: 4px;
    font-size: 1.25rem;
  }
  .results-body {
    padding: 12px 24px;
  }
  .results-layout {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-areas: 'hero standings' 'stats stats';
    gap: 12px 24px;
  }
  .results-hero {
    padding: 12px 16px;
  }
  .results-total-value {
    font-size: 2.5rem;
  }
  .standing {
    min-height: 52px;
    padding-block: 6px;
  }
  .results-footer {
    padding: 8px 24px max(8px, env(safe-area-inset-bottom));
  }
  .results-dice .dice-histogram {
    height: 88px;
  }
}
```

**How each viewport fits:**

| Viewport          | Layout                                         | Space check                                                        |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------------ |
| 1728×960          | Two columns, capped at 1180 px wide            | Plenty of room                                                     |
| 1280×720          | Two columns                                    | About 584 px of content height; hero (~200) + standings (4×72) fit |
| 1024×768          | Two columns                                    | Roughly 560 / 410 px wide                                          |
| Phone 390×844     | Winner, score and all standings above the fold | Stats collapsed                                                    |
| Landscape 844×390 | Winner beside standings                        | Stats collapsed below                                              |

The footer is a grid row, not `position: fixed`, so it can never cover content.

**Markers:** reuse `player-marker marker-{shape} color-{color}`, sized by a `--marker` variable (20 px in rows, 28 px in the hero).

## 5. i18n (`game.json`)

- Add: `results` ("Results"), `viewBoard` ("View board"), `resultsWinnerBadge` ("Winner"), `resultsWinnerScore` ("Winner's score"), `standings` ("Final standings"), `scoreBuildings`, `scoreAwards`, `scoreVpCards` ("VP cards"), `scoreTotal`, `scoreVpCardsPartial` ("{{count}}+?"), `gameStats` ("Game statistics"), `resourcesProduced` ("Resources produced"), `diceRollTotal_one`/`_other`, `gameFinishedSummary` ("{{player}} won with {{count}} VP").
- Retire `scoreBreakdown` and `productionTotal`, and update any tests that assert them.

## 6. Problems in the current integration

1. **Misleading score label:** "End-game revealed VP cards" labels `hidden`, but `hidden` means _cards still hidden at the end_. That label caused the bug report. Section 1 fixes it without touching the engine.
2. **Inconsistent winner name fallback:** `playerName()` in `GameReadOnly.tsx:34` falls back to `String(seat + 1)`, but `GameOverPanel` uses `playerFallback`. So the menu can say "3 wins" while the panel says "Player 3 wins". Use `playerFallback` in both places.
3. **Dice histogram hidden from screen readers:** `role="img"` with only "Dice rolls" as its label hides every count. The `title`s sit on elements that can't be focused, so keyboard and touch users can't reach them either. The `<ol>` with per-bar `aria-label` fixes this.
4. **Focus is lost after the auto-opened dialog closes:** nothing had focus before it opened, so focus ends up on `<body>`. `closeResults` sends it to the Results button instead.
5. **Private hand stays visible after the game ends:** `PrivacyCover` is turned off once there's a winner (`GameReadOnly.tsx:793`), so `HandDock` keeps showing the last revealed seat's private hand to the whole table. That may be fine because the game is over, but it's a product decision. It becomes visible as soon as someone presses View board.
6. **Board overlays can outlive the game:** only the Actions dock is replaced at game end. `placementConfirmation`, `offerOverlay` and `highlights` still come from `useGameActions`. Check that they're empty once `state.result` is set, or leftover confirmations and offers could show on the finished board.
