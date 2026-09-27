# Protocol v5 CI fixture repair

Date: 2026-09-27.

The [no-E2E run on 8b6cab9](https://github.com/dukesteen/hexfield/actions/runs/36342027981)
passed static checks, builds, simulation and all nine network scenarios. Its
serial unit job failed 13 tests and one setup hook, with 1,577 tests passing and
14 skipped. Browser tests were disabled by the manual workflow input.

The fixes preserve production protocol validation:

- Card-dependent fixtures now select ceremony entropy for the current signed
  deck definition. They still use real shuffle proofs, legal purchases and
  certified draws. The audit fixture explicitly requires a private draw before
  checking forged private results and exception handling.
- Trade and deck-log setup paths answer mandatory discard templates with legal
  resource selections instead of assuming every choice is an enumerated command.
- The Monopoly fixture reaches a purchase using legal setup placements that
  supply its cost. It no longer waits through unrelated random production.
- Three- and four-human draw tests retain every live head, certificate and
  unlock assertion. Their post-draw restore checks cover the owner and one
  foreign peer instead of replaying the same history for every peer.
- A malformed membership envelope expects the schema rejection that occurs
  before recovery-context validation.
- IndexedDB upgrade fixtures use the current v5 schema and v6 for a later
  upgrade. The recovery-readiness fixture has a 30-second setup allowance,
  separate from its individual test deadlines.

Focused local verification passed:

| Check                                                    | Result                       |
| -------------------------------------------------------- | ---------------------------- |
| Audit and log suites                                     | 13 tests, 23.36 seconds      |
| Certified deck log and export dialog                     | 5 tests, 23.34 seconds       |
| Automatic VP reveal and dropped-unlock restore           | 2 tests, 61.00 seconds total |
| Three-human relay and four-human draw                    | 2 tests, 83.73 seconds total |
| Monopoly count replication                               | 1 test, 33.67 seconds        |
| Uncertain-hand trade                                     | 1 test, 45.4 seconds         |
| Recovery readiness                                       | 11 tests, about 6.1 seconds  |
| Vault, byte store, journal, transfer import and deletion | 50 tests, 26.52 seconds      |

Type checks, builds, dependency boundaries, engine purity, translation checks,
and application-source lint/format checks pass. Whole-directory lint/format also
sees an unrelated untracked `.redesign` directory; its files were left untouched
and are not included in the push. These local results are not a claim that the
new full CI run has passed. The next run uses the four unit-test shards and
`skip_e2e=true` authorized by the user.

## First sharded run

[Run 36345905718](https://github.com/dukesteen/hexfield/actions/runs/36345905718)
completed all four unit shards in about 15 minutes. Static checks, build, engine
coverage, simulation and all nine network scenarios passed. The stale fixture
assertions were fixed. Three real-crypto tests hit wall-clock limits: the
four-human draw and uncertain trade exceeded 60 seconds, and the three-recoverer
activation check exceeded Vitest's default five seconds.

The draw now decodes the certified receipt directly after checking all four live
peers; separate relay and dropped-unlock tests retain owner/foreign restore
coverage. The trade still restarts both owners at the pending proof, and performs
one final post-commit restore of the proof supplier. These two focused checks
pass locally in 50.18 and 44.39 seconds. Their hosted-runner allowance is now
90 seconds; the recovery activation check gets 15 seconds. Protocol deadlines,
bounded move counts and the separate performance benchmarks are unchanged.

## Second sharded run

[Run 36347483384](https://github.com/dukesteen/hexfield/actions/runs/36347483384)
passed static checks, simulation, network scenarios and the other three unit
shards. Unit shard 2 failed only the three-human deck relay (64.71 seconds
against 60 seconds) and four-human draw (90.27 seconds against 90 seconds).
The seven-test deck file took 323.60 seconds. No protocol rejection caused
either failure; both exceeded their test wall-clock limits.

The draw driver previously drained 32 fixed network passes after every legal
command and 64 after the purchase, even when the certified heads and dealt card
had already converged. It now stops after the command result and every live
replica agrees on the certified head, and stops the final drain only once every
replica has the first certified card. The existing maximum pass counts, legal
setup, dropped direct contribution, relay observation, quorum certificates,
unlock checks and owner/foreign private restore assertions remain.

Two focused local runs of the affected cases passed: relay 35.30 and 35.23
seconds; four-human draw 64.60 and 64.57 seconds. Scoped lint and formatting
checks passed. The whole test typecheck still reports errors in a concurrently
edited recovery test; it did not diagnose the deck change. A fresh CI result
is still required.
