# Stage 17 Part B: replay viewer

Verification of the replay viewer ([stage doc](../../17-spectators-replays-map-editor.md#part-b--replay-viewer), decisions under 2026-09-30 "Replay viewer" in [DECISIONS](../../DECISIONS.md)).

## What exists

| Piece                                                                          | Where                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ReplaySession` (`GameSession`, `mode: 'replay'`), checkpoints every 50 inputs | `apps/web/src/features/replay/replay-session.ts`                                                                                                                                                             |
| Timeline markers and statistics (public facts only)                            | `apps/web/src/features/replay/replay-analysis.ts`                                                                                                                                                            |
| Replay documents, `HXREPLAY1.` strings                                         | `apps/web/src/features/replay/replay-document.ts`                                                                                                                                                            |
| Verified loading (local save, online archive)                                  | `apps/web/src/features/replay/replay-load.ts`                                                                                                                                                                |
| Viewer, controls, players, stats, export, import                               | `apps/web/src/features/replay/*.tsx`                                                                                                                                                                         |
| Routes                                                                         | `#/replay/$archiveId` (online archive), `#/replay/local/$gameId` (saved local or bot game), `#/replay/import`                                                                                                |
| Entry points                                                                   | "Watch replay" beside each saved game on the home page, "Open a replay string" in the replay library, "Watch replay" on the results screen (local and online), the online history's existing "Replay" button |
| Audit transcript for online games                                              | `auditCertifiedGame({ onPrivateInput })` in `packages/protocol/src/audit.ts`; masters loaded by `session/online-replay-masters.ts`, kept beside the archive, audited again on open                           |

## Seeking

`replay-session.test.ts` builds sessions from engine goldens and seeks to the worst cases (49 inputs past a checkpoint, backwards and forwards, the end). Measured on the development laptop (Apple silicon, shared load), omniscient perspective:

| Golden                                         | Inputs | Precompute (one full replay) | Worst seek |
| ---------------------------------------------- | -----: | ---------------------------: | ---------: |
| `knights/knights-4p-progress`                  |   1676 |                       187 ms |    18.6 ms |
| `seafaring/desert-crossing-56`                 |   2407 |                       842 ms |     1.0 ms |
| `seafarers-knights/desert-crossing-knights-56` |   3792 |                      1881 ms |    10.1 ms |

The test asserts every seek is under 200 ms. The same file checks every golden checkpoint hash after seeking in reverse order.

## Hidden information

- Public perspective: `getPrivate` returns null for every seat and `getState` reduces every hand to its size (min 0, max total per kind), because a local game's public bounds are narrowed by local steals that name their card. The test walks a knights golden every 7 inputs and checks both. The component test and the e2e check no hand is rendered.
- Seat perspective shows only that seat's private state. All hands and seat views need full information: local games, or online games whose masters pass the audit again when the archive opens.
- Statistics use public events and bank transfers only, so they are the same in every perspective.

## Tampering

- `replay-document.test.ts`: round trip of a local game and of an online document; rejects foreign prefixes, bad base64, truncated deflate, non-canonical JSON, an unknown format, a save with a removed input, and a forged final hash.
- `replay-session.test.ts`: a changed input is rejected.
- `online-public-archive.test.ts`: an archive stored with masters but no passing audit opens as public only; its transcript replays to the certified head's state. The existing tests still cover tampered and oversized archives.
- `audit.test.ts`: the audit's private transcript replays to the certified final state with valid private invariants and includes dealt card identities.

## End to end

`apps/web/tests/replay-viewer.e2e.ts`, chromium, desktop (1360×900) and phone (390×844, touch): seeds a finished four-player game with three bot seats (golden `normal-game-05`), opens "Watch replay" from the home page, checks the public view, scrubs, steps by keyboard, jumps to the next 7, switches to all hands and to one seat, opens the statistics, downloads the replay file, copies the string (checks the chat-length warning), re-imports it at `#/replay/import`, and checks a damaged string is refused. Both pass (`--workers=1`).

## Not covered

- No automated end-to-end run of an audited online game's omniscient replay: that path is covered by its parts (audit transcript test, masters sidecar test, archive transcript test).
- The victory screen's online "Watch replay" opens the public archive at once; hands appear when the game is reopened from the history after its audit stored the masters.
