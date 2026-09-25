# Stage 06 CI acceptance

Stage 06 is accepted. All nine network scenarios, the complete browser suite
and the GitHub Actions workflow passed, including deployment. The coordinator
verified the final results on 2026-09-26, local time.

The [GitHub Actions run](https://github.com/dukesteen/hexfield/actions/runs/36188542842)
tests commit `53c33a2593359171ae5a4dccf39cdcc7f1698860`, with browser tests enabled,
twenty games per network scenario, base seed 42 and game indices 0 through 19.

## Network evidence

The coordinator independently parsed all 180 completed game results and checked
game indices, positive input/turn counts, final hash encodings, fault injection
and recovery evidence, and the source fingerprint. The raw reports are retained
in [network-acceptance-ci](network-acceptance-ci/). Repository formatting changes
only JSON whitespace; parsed values were compared with every downloaded report.
The [artifact manifest](network-acceptance-ci/artifact-manifest.json) records the
downloaded and formatted file hashes.

| Scenario                           | Games | Failures | Verified scenario evidence                                                          |
| ---------------------------------- | ----: | -------: | ----------------------------------------------------------------------------------- |
| 1, clean network                   |    20 |        0 | Full-game convergence                                                               |
| 2, delayed and duplicated messages |    20 |        0 | Duplicate delivery occurs in every game; full-game convergence                      |
| 3, proposer crash                  |    20 |        0 | Replacement proposer before the original returns                                    |
| 4, 2\|2 partition                  |    20 |        0 | All four peers pause, then recover                                                  |
| 5, 3\|1 partition                  |    20 |        0 | Majority progress while the isolated peer cannot keep up                            |
| 6, invalid proposer                |    20 |        0 | Three honest peers certify exclusion; malicious actor's legal commands still commit |
| 7, censorship                      |    20 |        0 | Replacement proposer commits the censored command                                   |
| 8, corrupted state                 |    20 |        0 | Snapshot request/response and recovery                                              |
| 9, simultaneous restarts           |    20 |        0 | Recovery with persisted safety records                                              |

All reports contain the unchanged source fingerprint
`175031536ec5345fbcc6c3aca275c521af7b7becad2901d7d3fe4fb61563967d`.
The full-game simulator checks identical certified histories and final public
state hashes across honest peers, with no rollback of committed entries.

## Other checks

The [check evidence](checks-ci.json) records 534 passing tests across 98 files,
successful build and coverage, and 54 passing browser tests with no unexpected
or flaky results and 69 intentional browser-specific skips. The four-peer view
test passes in Chromium, Firefox and WebKit. Engine coverage is 4,897/4,954 lines
and 2,118/2,388 branches.

The [twenty full UI games](ui-full20-ci.json) complete 11,336 inputs across 2,338
turns, with zero rejected actions. Their UI source fingerprint is
`d05fe81f27533cee6dece5f0f34d61da1e8e13978a2067a70648c34685b2a458`, unchanged
throughout the run and independently matched against the local source. Its scope
includes web source/tests, renderer, engine, maps, bots, codec and Playwright
configuration, so it differs from the network simulation fingerprint.

The coordinator inspected the CI port screenshots at maximum desktop zoom in
Chromium, Firefox and WebKit, plus the Chromium phone-sized board. The `2:1` and
`3:1` labels render completely and the arms connect to both coastal vertices.
This inspection used downloaded images, without launching local Firefox or
WebKit processes.

The completed simulation job reports [2,000 verified engine games](simulation-games-ci.json)
and [50,000 fuzz mutations](simulation-fuzz-ci.json) with zero failures and the same source fingerprint.
The coordinator downloaded and checked both simulation reports.

All nine reports passed the independent acceptance assertions. Their source
fingerprint matches the locally checked source, and the workflow conclusion is
`success` for commit `53c33a2593359171ae5a4dccf39cdcc7f1698860`.
