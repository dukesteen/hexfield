# Stage 06 local verification

Verified on 2026-09-25 with Node 22.23.3 and pnpm 10.7.1, after the three
implementation-review passes and their regression fixes.

- `pnpm check` passed typechecking, type-aware lint, formatting, dependency
  boundaries, engine purity, i18n checks and 534 tests across 98 files.
- `pnpm build` passed. The production JavaScript contains none of the checked
  simulation identifiers: `SimulationDriver`, `NetworkSimulation`, `createMemnet`
  or `STUB MODE`.
- `pnpm test:coverage --maxWorkers=1 --minWorkers=1` passed all 534 tests.
  Engine coverage is 4,897/4,954 lines, 98.85%, and 2,119/2,389 branches, 88.70%.
- The focused Chromium network test passed. It opens four independent peer
  sessions, places a settlement through the active board and verifies that all
  four sessions commit the next revision without browser errors.
- The native CI matrix-planner suite passed all five tests.

The [final crash smoke](network-smoke-final/scenario-3-crashed-proposer-seed42-index1.json)
completed 635 inputs and required the three survivors to certify a replacement
in round two before the crashed proposer returned. The
[final malicious-proposer smoke](network-smoke-final/scenario-6-invalid-proposer-seed42-index0.json)
completed 397 inputs. All three honest peers retained the certified exclusion
and agreed on the full history. The faulty command-only actor submitted 65 exact
signed commands that subsequently appeared in the certified log.

Those two smoke reports record their narrower protocol/simulator source scope
and confirm it remained unchanged. The shared simulation provenance helper gives
the broader source fingerprint
`175031536ec5345fbcc6c3aca275c521af7b7becad2901d7d3fe4fb61563967d`.

These checks do not complete Stage 06 acceptance. The final gate requires twenty
games in each of the nine scenarios and a green GitHub Actions run. It will use
manual dispatch with the full browser suite enabled. No local Firefox or WebKit
process was launched for this verification pass.
