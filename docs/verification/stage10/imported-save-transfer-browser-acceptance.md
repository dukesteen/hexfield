# Imported-save transfer browser acceptance

The opt-in `apps/web/tests/imported-transfer.e2e.ts` test uses native Chrome with three disposable browser contexts and the local signaling service on port 8909. It starts one two-human online game, exports the certified head with an encrypted private package, imports the file in a third context, and confirms the imported snapshot stays paused and read-only. It then uses the source's signed transfer invitation with that imported archive pinned, completes the certified move, checks the destination device fingerprint differs from the source, verifies the old source no longer resumes as controller, and confirms a later legal move reaches the same certified head on the survivor.

Run only this test on a fresh strict Vite port:

```sh
CI=1 CI_BROWSER_SET=chromium PLAYWRIGHT_TEST_PORT=5297 CP2P_IMPORTED_TRANSFER_E2E=1 pnpm --filter @cp2p/web exec playwright test tests/imported-transfer.e2e.ts --project=chromium
```

Result: passed in native Chrome in 55.1 seconds. The test verified encrypted export and import, read-only presentation before transfer, an imported-archive-bound transfer, source retirement, matching certified heads, and one peer-accepted post-transfer move. It uses a test passphrase and synthetic game names; no real credentials or private material are written to the report.

This is one bounded two-human Chrome trace. It does not establish cross-browser or mobile behavior, nor does it test the separate return-to-human flow.
