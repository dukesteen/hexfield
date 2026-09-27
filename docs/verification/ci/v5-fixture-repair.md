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
