# Native same-game writer contention

Passed on 2026-09-28 in installed Chrome, using the production source at
`0c56aa1` with the new opt-in test in `apps/web/tests/online-resume.e2e.ts`.
The test took 13.127 seconds (15.538 seconds including the runner). All 432
recorded production/configuration/test file hashes matched before and after the
run. Shared test typechecking and scoped lint/format checks passed.

Two independent browser contexts started a real two-human game. A second tab in
the host's context opened the same game URL while the original writer remained
active. It received the existing restore-refused UI, opened no game session,
and observed exactly one native game writer lock. The original host and guest
then certified another move, proving that the rejected duplicate did not stop
the active writer.

After closing the original host tab, reloading the rejected copy restored the
same seat, device identity, and certified head. The resumed tab signed a legal
move and both peers reached head 8. No page errors occurred. This verifies native
same-profile writer exclusion and handover after tab closure; it does not claim
power-failure, cross-device, full-game, or final-audit coverage.

The first attempt selected an actor before startup exposed a legal command. It
failed the test helper after the duplicate-tab refusal had already passed. The
test now waits for a legal actor before taking its initial snapshot. No
production change or increased timeout was needed.

Run an isolated local signaling server on `127.0.0.1:8916`, then:

```sh
CP2P_ONLINE_RESUME_E2E=1 CP2P_WRITER_TAB_E2E=1 CI_BROWSER_SET=chromium PLAYWRIGHT_TEST_PORT=5326 pnpm --filter @cp2p/web exec playwright test tests/online-resume.e2e.ts --project=chromium --workers=1 -g 'a second live tab cannot sign'
```

The [evidence archive](native-writer-tabs-2026-09-28-evidence.tar.gz) contains
the runner output, extracted Playwright report, public game heads and lock
observations, and matching source manifests. It contains no private cards or
keys. SHA-256:
`d4ba0a4828b7e9d2ad116fd10ccc9c5c4a312af34e91390060ce276b0f742c28`.

Test source SHA-256:
`3a1728601d84c1d94661633d7888829ea7e204621e2bdf78f5e19784c2535e0c`.
