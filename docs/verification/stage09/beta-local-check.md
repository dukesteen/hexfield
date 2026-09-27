# Multiplayer beta local release checks

Verified on 2026-09-27 using Node 22 and pnpm 10.7.1. This is the smaller
[friends-play beta](../../multiplayer-beta.md), not completion of M-C or M-D.

## Static checks and build

The final source passes production and test typechecks, the engine type guard,
type-aware lint, formatting, dependency boundaries, engine purity, translation
keys and all workspace builds. The dependency check covers 667 modules and
4,234 dependencies. Both GitHub workflow files parse as YAML.

The Pages build passes with `GITHUB_PAGES=true pnpm --filter @cp2p/web build`.
Vite reports an existing chunk-size warning for the online bundle; it is not a
build failure.

The SHA-256 fingerprint of sorted source/config paths and their file hashes is
`a1d87937fe9aecbfcfb4cd26107221d02e4b3a64dd5514c9540157eb34d82e49`.
It covers the 714 tracked or unignored files under `apps`, `packages`, `tools`
and `.github`, plus the root package, lockfile, workspace, TypeScript, Vitest,
formatter, linter and dependency-check configuration. Documentation is excluded.

## Tests

The full unit run took 456.8 seconds and initially reported 1,289 passes,
14 failures and two intentional skips across 223 files. All 14 failures were
then fixed and rerun in their affected cases:

- Ten trade-session cases now provide `getTimers` in their partial replica mock.
- The dropped-delivery steal case advances virtual time between asynchronous
  consensus phases. It still requires exactly one certified steal result and
  unchanged retry bytes after restart. It passes in 30.56 seconds.
- The automatic victory-card retry case uses a deterministic protocol-v3 seed
  that actually deals a victory-point card. Its proof and claim checks remain.
- Two delayed-bot cases supply the second host's bot identity and route that
  bot's setup commands through its host. The revised helper is used only by
  these two tests.

These final corrections modify only the four test files. Production behavior
and other test cases did not change. The cumulative result is 1,303 passing
tests with two intentional skips; the full eight-minute suite was not repeated
after these focused corrections. Coverage was not rerun locally for this beta;
normal CI retains its coverage run and thresholds.

The opt-in [v3 ten-point game](beta-v3-game-check.md) also passes. It completed
332 commands and 478 certified entries with two humans and two hosted bots,
including purchases, development-card plays and hidden steals. Both independent
end-game audits agree and report no violations or missing secrets.

## Browser checks and publication

The [four-human production-browser check](beta-browser-check.md) passes manual
startup, all setup placements, shared dice, a player trade and same-browser
close/reopen and reconnect. The browsers ran on separate origins on one laptop.
The final Pages build's create-room and join-room forms were also inspected at
390 by 844 pixels, with no browser warnings or errors.
External-network connectivity, physical-phone multiplayer and multiple browser
engines remain unverified.

The manual `Publish locally verified build` workflow publishes the exact verified
commit after it is pushed. Normal CI still runs independently, with its duplicate
unit run removed: coverage is now its single full unit-test run. A successful
deployment does not imply that remote CI or the broader milestones have passed.
