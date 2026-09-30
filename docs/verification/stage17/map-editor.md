# Stage 17 Part C — map editor verification (2026-09-30)

Acceptance: _a custom map made in the editor can be shared as a string, loaded in a lobby, and played P2P._ Met. Design decisions are in [DECISIONS.md](../../DECISIONS.md) ("Stage 17 Part C — the map editor and custom maps").

## What was checked

| Check                                                                                                                                                                                                                                                                                    | Where                                                                                                                      | Result            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `MapDef` schema, canonical form, `HXMAP1.` codec round trip; malformed, damaged, oversized and deflate-bomb input refused without throwing                                                                                                                                               | `packages/maps/src/custom/custom.test.ts`                                                                                  | passed            |
| Every fixed scenario board validates with no errors; each error and warning case; engine dry run                                                                                                                                                                                         | same                                                                                                                       | passed            |
| Token solver (stage 03 search, `solveTokens`), randomiser, default fog stack                                                                                                                                                                                                             | same, `packages/engine/src/modules/base/board/custom.test.ts`                                                              | passed            |
| Engine: `mapLayout: custom` plays any land shape, robber on land, five-six keeps the shape, knights track outside the perimeter; bad robber, inland harbor and seafaring terrain refused                                                                                                 | `packages/engine/src/modules/base/board/custom.test.ts`                                                                    | passed            |
| Golden replays and state hashes byte-identical                                                                                                                                                                                                                                           | `packages/engine` suite, `tools/sim/src/{golden,seafaring-golden,knights-golden,seafarers-knights-golden}.test.ts`         | passed, unchanged |
| Storage: database version 6 adds `maps` to a version 5 database and keeps its data; save, list, replace, delete, damaged records skipped                                                                                                                                                 | `packages/storage/src/map-store.test.ts`                                                                                   | passed            |
| Random bots finish games with invariants on: a 23-hex custom island at 3 (base), 4 (knights) and 5 (five-six) players; re-dealt Four Isles with seafaring and with seafaring + knights at 3 and 4                                                                                        | `tools/sim/src/custom-map.test.ts`                                                                                         | passed            |
| The lobby replicates a custom config byte for byte; four peers certify a game on a map passed as its share string                                                                                                                                                                        | same (full game with `CP2P_HEAVY_TESTS=1`)                                                                                 | passed            |
| Editor document model: painting, numbers, harbors, erase, modules, start areas, resize, undo/redo; render model                                                                                                                                                                          | `apps/web/src/features/map-editor/document.test.ts`                                                                        | passed            |
| Editor component: paint, keyboard tools, undo/redo, errors, save; export decodes to the same map and errors block it                                                                                                                                                                     | `apps/web/src/features/map-editor/MapEditor.test.tsx`                                                                      | passed            |
| Lobby: custom map picker (paste, seat checks), online configuration keeps a custom map across seat counts, guests see it                                                                                                                                                                 | `apps/web/src/features/setup/CustomMapPicker.test.tsx`, `apps/web/src/features/online/OnlineConfiguration.custom.test.tsx` | passed            |
| Browser, desktop 1440×900 and phone 390×844: build a seven-hex map with the number keys, see the errors, fix them (balanced numbers, robber, player range), undo and redo, export the string, Play against bots, start the local game and check the board (7 hexes, `mapLayout: custom`) | `apps/web/tests/map-editor.e2e.ts`                                                                                         | 3 passed          |
| Browser, online: host (desktop) creates a room with a pasted custom map, a guest (phone) joins, both ready, the game starts and both load the board                                                                                                                                      | `apps/web/tests/map-editor-online.e2e.ts` (`CP2P_MAP_EDITOR_ONLINE_E2E=1`, signaling on `127.0.0.1:8911`)                  | passed            |

## Full peer-to-peer games from share strings

`node tools/sim/dist/index.js net --scenario 1 --seeds 1 --seed 42 --players 4 --map HXMAP1.…` — four peers with the real sessions, signatures, wire encoding and journals (stub randomness), clean network, each decoding the map string and building the genesis from it:

| Map                                                                | Result                                                        | File                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Bitten island: the classic island with a corner removed, seats 2–4 | 87 turns, 485 inputs, finished; 8 setup settlements, 7 cities | [map-editor-net-bitten-island.json](map-editor-net-bitten-island.json) |
| Re-dealt Four Isles (seafaring, randomised tiles and numbers)      | 178 turns, 946 inputs, finished; 12 ships built, 10 cities    | [map-editor-net-redealt-isles.json](map-editor-net-redealt-isles.json) |

## Commands

```
npx vitest run packages/maps packages/storage packages/engine/src/modules/base/board tools/sim/src/custom-map.test.ts apps/web/src/features/map-editor apps/web/src/features/setup
cd apps/web && PLAYWRIGHT_TEST_PORT=5191 CI_BROWSER_SET=chromium npx playwright test tests/map-editor.e2e.ts --workers=1
PORT=8911 HOST=127.0.0.1 node apps/signaling/dist/server.js   # in another shell
cd apps/web && CP2P_MAP_EDITOR_ONLINE_E2E=1 PLAYWRIGHT_TEST_PORT=5191 CI_BROWSER_SET=chromium npx playwright test tests/map-editor-online.e2e.ts --workers=1
```

## Not covered

- Lakes: no module has a lake terrain, so the editor offers none.
- The online test checks that both peers start and load the board; board equality between peers is proven by the signed genesis and by the network simulation above, since online games expose no development hook.
- The verified-security (real cryptography) network run was not repeated for custom maps; custom maps change only the genesis config, which the verified path signs like any other.
