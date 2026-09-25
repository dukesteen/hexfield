# 05 — Local UI (Hotseat & vs RandomBot)

## Goal

Design direction from the user: keep the interface clean, legible and easy to reason about. Avoid medieval ornament, parchment textures, decorative type and crowded controls. Use clear typography, obvious action states and distinct player colors. Animate events when motion helps explain what happened, and respect reduced-motion preferences.

A polished, responsive browser UI that plays a full base game locally:

- **hotseat** (pass-and-play), with hand hiding between seats,
- **vs bots** (RandomBot for now).

The UI must be driven entirely by the engine's `getPending`, `getLegalCommands` and events, so the same UI works unchanged in P2P mode later.

## Prerequisites

Stage 04 is complete.

## Architecture

```
apps/web/src/
  routes/              TanStack Router file-based routes (hash history): see "Routing" below
  app/                 router creation, providers (QueryClient, i18n), layout, theme
  session/             GameSession interface + LocalSession implementation
  store/               zustand stores: live session state (pushed by GameSession.subscribe), ui state (selection, dialogs)
  queries/             TanStack Query hooks + query-key factory for async/persisted data (settings, saved games, maps, replays)
  features/
    board/             React wrapper around @cp2p/renderer
    hud/               player panels, turn banner, timers, dice
    hand/              resource + card hand, dev cards
    actions/           contextual action bar (build, buy, trade, end turn)
    trade/             trade composer, incoming offers, bank trade
    dialogs/           discard, year-of-plenty, monopoly, steal target, game over
    log/               event history + chat panel (chat is a no-op locally)
    setup/             new local game screen
  i18n/                i18next setup + locales/<lng>/<namespace>.json (en only initially)
packages/renderer/src/
  BoardRenderer.ts     PixiJS application, layers, camera
  layers/              terrain, tokens, harbors, pieces, highlights, robber, effects
  input/               hit testing for hex/vertex/edge, pan/zoom/pinch
  theme/               palette, player colours (colour-blind safe set + patterns)
  assets/              procedurally generated textures (no external art required)
```

### GameSession abstraction (key for later stages)

```ts
interface GameSession {
  readonly mode: 'local' | 'p2p' | 'replay' | 'spectator';
  getState(): GameState;
  getPrivate(seat: Seat): PrivateState | null; // local: any seat; p2p: own seat only
  controllableSeats(): Seat[]; // hotseat: all human seats; p2p: own seat
  submit(seat: Seat, command: Command): Promise<Result<void>>;
  subscribe(listener: (u: SessionUpdate) => void): Unsubscribe; // state + events + status
}
```

`LocalSession` wraps `LocalGame`:

- It answers `random` pendings via a `LocalRandomSource` (a `crypto.getRandomValues`-based CSPRNG, **outside** the engine).
- It runs bots for bot seats with a small artificial delay (300–800 ms, configurable, 0 in tests).
- It handles turn timers (if configured) by emitting `TIMEOUT` inputs.

### Routing (TanStack Router)

File-based routes in `apps/web/src/routes/`, using hash history (URLs look like `https://app/#/local`):

| Route file          | URL            | Notes                                                                                                                                      |
| ------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `__root.tsx`        | —              | providers, app shell, error boundary, 404 (`notFoundComponent`)                                                                            |
| `index.tsx`         | `#/`           | home                                                                                                                                       |
| `local/new.tsx`     | `#/local/new`  | new local game setup                                                                                                                       |
| `local/$gameId.tsx` | `#/local/<id>` | local game screen. The loader rehydrates a saved local game via TanStack Query (`ensureQueryData`)                                         |
| `dev/board.tsx`     | `#/dev/board`  | renderer test page; production returns Not Found. The preview and DEV hook are pruned, though an unloaded route stub remains in the build. |
| `settings.tsx`      | `#/settings`   |                                                                                                                                            |

Later stages add `online/create`, `join/$roomId` (stage 09), `game/$gameId` (stage 09/10), `history`, `replay/$gameId` (stage 10/17), `editor` (stage 17).

- **Search params** are typed and validated with Valibot schemas in `validateSearch` (TanStack Router accepts Standard Schema validators). Examples: `?spectate=1`, `?map=<string>`, `?seat=2`.
- Use route `loader`s together with TanStack Query (`queryClient.ensureQueryData`) for persisted data. Live game state still comes from the session → Zustand.
- **Navigation guards** (`beforeLoad`): e.g. redirect `game/$gameId` to home if the game doesn't exist locally. Use `useBlocker` to confirm leaving an active game ("Leave game? You can resume later").
- Use `Link`/`useNavigate` with typed params everywhere; no string-built URLs.
- Lazy-load heavy routes (`*.lazy.tsx`) such as the game screen (Pixi), the editor and the replay viewer, to meet the stage-18 bundle budget.

### State handling: Zustand vs TanStack Query

- **Zustand** holds the live game: a `useSessionStore` updated from `GameSession.subscribe` (state, events, pending, connection status), plus UI state (placement mode, selection, open dialogs). Components read it with narrow selectors to avoid re-renders.
- **TanStack Query** handles every async, request-shaped operation:
  - `useSettings` / `useUpdateSettings`,
  - `useSavedGames`,
  - `useReplay(gameId)` (loading and parsing a replay),
  - `useExportGame` (mutation),
  - later: saved maps (stage 17), TURN credential fetch and signaling health (stage 08), resumable games (stage 10), audit report computation (stage 07).

  Mutations invalidate the related query keys. Keep query keys in one `queryKeys` factory.

- Don't put live game state in TanStack Query, and don't put persisted/async data in Zustand.
- In this stage, IndexedDB doesn't exist yet (stage 10). Implement the settings and replay-export queries against `localStorage` / in-memory adapters behind a small `SettingsRepository` interface, so stage 10 just swaps the adapter.

### i18n (react-i18next)

- `i18next` + `react-i18next`. Namespaces: `common`, `game`, `lobby`, `rules`, `log`, `editor`. Locales are lazy-loaded (`i18next-resources-to-backend` with dynamic `import()`).
- **All** UI text goes through `useTranslation()` / `t()` or `<Trans>`. Use i18next plurals (`_one`/`_other`) for counts ("1 card" / "3 cards").
- The event-log formatter maps each `GameEvent` to a translation key + interpolation values (`log:roadBuilt`, `{ player }`). It's a pure function taking a `TFunction`, so it's unit-testable.
- Resource/terrain names are translation keys too, never hard-coded strings.
- Add a CI check (e.g. `i18next-parser` or a small script) that fails on keys used in code but missing from `en`, and warns on unused keys.

## Renderer requirements (`@cp2p/renderer`)

- PixiJS v8, a single `Application`, with layers in this order: sea/background → terrain → harbors → number tokens → roads → buildings → robber/pirate → highlights → effects.
- **Original vector art.** Terrain tiles, tokens, harbors and pieces are SVGs in `packages/renderer/src/assets/`, loaded as Pixi textures (rasterised at devicePixelRatio-appropriate sizes and cached). Start with simple placeholders (flat colour + glyph via Pixi Graphics), then **generate the final tiles and pieces with `claude -p`** following the delegation rules in `docs/README.md`:
  - write `docs/design/style-guide.md` first (palette, stroke widths, lighting direction, level of detail, a hex viewBox such as `0 0 200 231` for pointy-top),
  - generate one terrain tile, review it on the board, then batch the rest with the approved tile attached as the style reference.
  - Keep the visual language original.
- Number tokens show the pip dots; 6 and 8 in red.
- Camera: fit-to-screen on load and resize; mouse wheel zoom; drag pan; pinch zoom and two-finger pan on touch; double-tap to re-fit. Clamp to board bounds.
- Hit testing: vertices (radius ~ 0.25 hex size), edges (distance to segment), hexes (axial rounding). Hit targets must be at least 44 px on touch, scaling with zoom.
- `setHighlights({ vertices, edges, hexes, style })` shows legal targets, pulsing gently.
- Animations: dice roll, resource flying from hex to player panel, piece placement pop, robber move. All skippable, and respect `prefers-reduced-motion`.
- The renderer is **stateless with respect to rules**. It gets `render(view: RenderModel)`, where `RenderModel` is derived from `GameState` by a pure function `toRenderModel(state, viewer)` in the web app. This allows snapshot tests of the render model without WebGL.
- Performance: 60 fps on a mid-range phone. Redraw only the dirty layers.

## UI requirements

- **Layout**: the game fills one viewport without document scrolling or outer gutters. Desktop has the board on the left, hand and actions directly below it, and players with a collapsible log on the right. A top-left hamburger overlay holds save status, Leave, animation controls and secondary utilities instead of header rows. Mobile keeps a compact hand at the bottom, below a tappable player strip. A short next-step row keeps Roll, End turn, or the current board instruction visible; Actions opens a sheet for other choices. Short landscape layouts use a compact side rail. Long detail lists can scroll inside their own panes.
- **Player panels**: name, colour, public VP, resource card count, dev card count, knights played, longest road length, award badges, "active" indicator, timer ring, connection status (placeholder).
  Remaining roads, settlements, and cities use small piece icons with counts and accessible labels.
  Tapping any mobile player tile opens their full public details, including knights played, longest road, remaining pieces, awards, timer, and recent resource gains. A downward swipe dismisses the sheet when its content is at the top, and returns focus to that player tile. Short, horizontal, and upward gestures leave it open. Resource and development-card totals are public; opponents' private card identities are not displayed.
  Public resource payouts also appear beside each player for eight seconds. Recent payouts remain readable across fast bot turns; each payout expires independently. These readouts use the public production event, remain visible with reduced motion or skipped animations, and do not reveal private transfers.
- **Hand**: original SVG resource cards grouped with visible counts; dev cards (face up for the owner) showing a "new — playable next turn" state; disabled states with a tooltip explaining why (from the `RuleError` message).
- **Actions** are contextual and derived from `getLegalCommands` for the controllable seat:
  - desktop places contextual actions on the left and square normal-action buttons in a vertical stack on the right; mobile uses the Actions sheet and a persistent next-step row, with 44px touch targets,
  - build road/settlement/city → enters placement mode with highlights,
  - road, settlement, and city selection previews the piece at a legal location; an explicit confirmation on the board commits it, while Cancel clears the preview. This also applies during setup and free-road placement,
  - clicking an active optional build action again exits its placement mode. Reselecting an uncommitted board preview clears that preview,
  - clicking a playable Knight card or its action selects it and shows cross/check confirmation controls at the bottom of that card. Cancel keeps it unplayed; the check commits it and starts the required robber move. Narrow layouts open the card dialog for this choice,
  - buy dev card, trade, bank trade, end turn,
  - roll dice (in preRoll).
  - a compact Build costs dialog shows the engine's public road, settlement, city, and development-card prices, even when the current hand cannot afford them.
  - selecting a board action closes the mobile Actions sheet before exposing placement targets. Opening another dialog closes the sheet first. Required discard and steal choices open independently of the sheet; required setup and robber instructions remain visible beside the Actions trigger.
  - Keyboard shortcuts: `R` roll, `E` end turn, `1/2/3` build modes, `Esc` cancel.
- **Last roll**: two dice faces and their total remain at the top-right of the board viewport after the animation, across turn changes and saved-game restoration.
- **Stealing**: a committed stolen-card event slides a neutral card back from victim to thief. The revealed player's endpoint is their visible hand; other endpoints are public player panels. This covers cards received and lost, respects reduced motion and Skip animations, and never reveals a hidden resource identity.
- **Hand sizing**: desktop reserves space for two development cards with full names beside the resource cards. Larger desktop hands show overlapping card faces; hovering or focusing a card raises it above its neighbors and exposes its name. Hover targets stay stationary while the artwork moves, and leaving the stack lowers unselected cards. A selected Knight stays above the stack with its confirmation controls reachable. Reserve room for the lift so artwork and outlines do not clip, and disable its transition with reduced motion. A compact control opens all cards when the hand exceeds the visible stack. Mobile and touch layouts keep the development-card drawer. A compact eye control conceals the hand in games with multiple human seats. Single-human games omit it and show that player's hand automatically.
- **Dialogs**: discard (select resource cards with the same SVG picker used for trades, choose exactly N with a selected/required count, and confirm before spending), robber (select hex on board), steal target (choose among eligible players with card counts), year of plenty, monopoly, road building (placement mode ×2 with skip).
  Year of Plenty and Monopoly also use the SVG card picker and a separate confirmation footer. Year of Plenty selects exactly two requested cards; Monopoly selects one resource type. Cancelling either dialog does not spend the development card.
- **Trade**:
  - The composer lets players select resource cards to give and receive, with quantities, separate remove controls, available hand counts and target players. Give and receive stay visible together on desktop; mobile uses compact stacked selections and a visible submit footer. Incoming offers appear as a compact overlay at the bottom-right of the board viewport, with resource card graphics and accept/decline controls. Offer wording must identify whose cards each side represents.
  - The active seat sees the responses and confirms with one.
  - Bank trade picker shows the best rate for each resource.
  - Completed public player trades animate the exchanged cards between player panels. Creating or accepting an offer does not imply a completed transfer. Animation uses public offer terms and the confirmed counterparty, respects reduced motion and can be skipped.
- **Log**: human-readable event history ("Red built a road", "Blue rolled 8: Red +1 grain…") generated from `GameEvent`s by an i18n formatter.
- **Hotseat privacy**: when control passes to a different human seat, show a full-screen "Pass to <Name> — tap to reveal" cover that hides hands. Option to disable.
- **Game over** screen: a full-screen results modal over the preserved game cockpit, opened on completion and when loading a completed game. Show the recorded winner, final VP breakdown per seat, dice histogram, resources gained per seat, Rematch, and Export replay. Combine claimed and still-hidden victory-point cards into one VP cards total without double-counting. Keep unavailable private totals unknown. View board or Escape dismisses the modal, and Results reopens it from the finished board. Keep the footer visible while long content scrolls inside the modal. The replay viewer arrives in stage 17, so export the replay JSON for now.
- **New local game** screen: player count 2–4 (2 players uses base rules without variants), names and colours, human/bot per seat, and all base options from stage 03.
- **Accessibility**: all actions reachable by keyboard; ARIA labels on panels; colour-blind-safe player colours plus a pattern or shape per player; resource icons carry text labels on hover/focus. Focus the board to browse legal locations with arrows or Home/End and select with Enter or Space. Screen-reader instructions describe these controls and announce the current location.
- **Theming**: light/dark via CSS variables.

## Dev tools (dev builds only)

- Debug drawer showing the public state JSON, private state per seat, state hash, pending list and a legal command list, with "apply raw command" and "force dice" (LocalSession only).
- Load/save state snapshot and replay JSON.
- A `window.__cp2p` test hook exposing `session`, used by Playwright.

## Steps

1. `GameSession` interface and `LocalSession` (no UI). Unit-test it with bots only.
2. Renderer: static board rendering from a render model; camera; hit testing. Visual check in a dev page `#/dev/board`.
3. Render-model derivation plus snapshot tests.
4. Game screen layout with player panels and hand (read-only).
5. Placement modes with highlights for setup and building.
6. Dice, production animation, 7-flow dialogs.
7. Dev cards UI.
8. Trade UI (player + bank).
9. Log, game over, new-game screen, hotseat privacy cover.
10. Art pass: style guide + `claude -p`-generated SVG tiles, tokens, harbors, pieces and resource icons; and UI component polish (panels, dialogs, trade sheet) via `claude -p` where useful. Save the prompts in `assets/prompts/`.
11. Responsive/mobile pass and accessibility pass.
12. Dev tools.
13. Playwright E2E tests.

## Required tests

- Unit: `toRenderModel` snapshots for key states; hit-testing math; action availability derived from legal commands.
- Component tests (Vitest + Testing Library): discard dialog enforces the exact count; trade composer validation.
- E2E (Playwright):
  1. Start a 4-bot game at speed 0 through the UI hook and let it run to completion. Assert that the game-over screen appears.
  2. Hotseat: a scripted setup phase by clicking vertices/edges (using `__cp2p` to find pixel coordinates of ids), roll, build a road.
  3. Mobile viewport (iPhone-sized): the same setup flow with touch.

## Acceptance criteria

- [x] A human can play a complete 4-player game against RandomBots on desktop and on a phone-sized viewport.
- [x] Hotseat game with 3 humans works, with privacy covers.
- [x] The UI never offers an action the engine rejects (E2E bot-driven UI test clicks only offered actions for 20 games without a single rejected submit).
- [ ] 60 fps panning on a mid-range device (record a manual check in STATUS.md).
- [x] All UI strings go through react-i18next; the missing-key check passes in CI; keyboard-only play is possible.
- [x] Live game state is only in Zustand; normal persisted and asynchronous operations use TanStack Query hooks. Synchronous page-exit flushing is the documented exception.
