# Local vault browser acceptance

The opt-in `apps/web/tests/local-vault.e2e.ts` test uses native Chrome and one disposable browser context. It enables protection, reloads into the locked gate, rejects a wrong passphrase, unlocks in two same-origin tabs, holds a manual room open in the second tab during passphrase rotation, checks both tabs lock and the room scope closes, verifies the old passphrase is rejected and the new one works, then removes protection and compares the public device peer ID before and after migration. Screenshots contain only the settings status, not passphrases or invitation codes.

Run it with a new unused port and CI mode so Playwright starts a strict-port server instead of reusing an unrelated Vite process:

```sh
CI=1 CI_BROWSER_SET=chromium PLAYWRIGHT_TEST_PORT=5297 CP2P_LOCAL_VAULT_E2E=1 pnpm --filter @cp2p/web exec playwright test tests/local-vault.e2e.ts --project=chromium
```

Result: passed in native Chrome on port 5297 in 5.9 seconds. The run confirmed the old phrase fails, the new phrase unlocks, the second tab's active manual room closes and its gate locks during rotation, and the public device peer ID is unchanged after protection is removed. The desktop and 390×844 screenshots are in the ignored Playwright result directory as `vault-desktop.png` and `vault-mobile.png`; neither includes a passphrase or invitation code.

This covers Chrome in one disposable profile; it does not establish Firefox, WebKit, mobile-browser, or cross-device behavior.
