# Saved history and public replays

Verified locally on 2026-09-27. This checkpoint is not deployed and does not
complete M-C or M-D.

Saved online games now offer public replay export, read-only opening and confirmed
local removal. Display-only activity metadata marks an unfinished game inactive
after 30 days. Missing or corrupt display metadata cannot grant voting authority
or hide an otherwise valid resume link.

The public HXAR1 file contains the signed start and certified public prefix.
Import checks signatures, deck transcripts, entry certificates and replay before
writing to the separate `online-replay/v1` namespace. Every open rechecks the
content address and history. Verification runs in a disposable worker. The route
shows the board at the end of the exported prefix and its event log; it has no
timeline controls or live session. It does not display private hands or perform
the full end-game audit.

Removal first acquires the live-game writer lease and catalogue lock. One strict
IndexedDB transaction removes the game records, changes the catalogue and stores
permanent deletion markers. Journal writes and transfer promotion check those
markers in their own transactions. An open game returns `busy`; the dialog stays
open and explains that the other tab must close first. Global identity and
ceremony anti-equivocation records remain. The
[deletion design](local-game-deletion-design.md) records the exact scope and
retained data. This is game removal, not a claim of complete private-data erasure.

## Checks

- The focused storage, saved-record, worker, archive, history UI and replay-route
  run passed 54 tests in 46.50 seconds. The final activity/UI checks passed nine
  tests after the layout correction.
- The native Chrome test in `apps/web/tests/online-history.e2e.ts` passed in
  20.4 seconds. It installs only a disposable signed four-human test prefix with
  historical safety, without real user keys or a live session. Through the UI it
  downloads HXAR1, opens the replay, reloads it, checks 390×844 layout, cancels
  removal, confirms removal, reloads Home, reopens the independent replay and
  imports the downloaded file. No page errors occurred. This is not an
  endgame-to-audit acceptance trace.
- The coordinator inspected desktop/mobile screenshots. The native confirmation
  dialog uses the redesigned controls and palette. The mobile replay has no
  horizontal page overflow.
- Production web build, web/test typechecking, dependency boundaries, translation
  key checks and scoped type-aware lint/format checks passed.

The final browser log is `/private/tmp/hexfield-online-history-browser-final.log`.
Screenshots are generated under `apps/web/test-results/online-history.e2e.ts-save-ca4e3--removes-only-the-live-save-chromium/`.
Run the bounded browser check with `CP2P_ONLINE_HISTORY_E2E=1`, a local Vite server
and the installed Chrome channel. Firefox and WebKit were not launched.

General save packages with optional encrypted private material, their import UI
and a certified fresh-key transfer from an imported package remain separate work.
