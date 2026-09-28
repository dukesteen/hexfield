# Encrypted refresh after the opening disclosure guard

The single focused installed-Chrome check `52356` passed on 2026-09-28:
**2,865.261 ms to restore and 2,988.509 ms to the next peer-certified move**.
The unchanged target is below 3,000 ms, leaving **11.491 ms** of margin. Test time
was 15.4 seconds; runner time was 18.3 seconds. The test cap remained 90 seconds.

Two fresh independent persistent Chrome profiles enabled encrypted local
storage, completed actual signed two-human setup and certified setup commands.
The higher-ID responder reloaded, entered its passphrase, restored the same
head and seats, and submitted its next genuine move. The surviving peer accepted
head 9 from head 8. This focused test shares the existing full resume test's
setup/reload/`certifyMove` callback and stops after that measurement. It does not
repeat whole-browser restart, terminal play, snapshots or final audits; those
remain in the full acceptance test.

The [public output and source/runtime archive](encrypted-refresh-opening-guard-2026-09-28.tar.gz)
contains exact stdout, measurements, before/after hashes and invocation. Its
SHA-256 is `28e36888d95d4c632098a8af62234556a726407b3e9393fc8490ed7107648e18`.
HEAD was `834813d`, including the verified disclosure-opening guard, with the
actor's narrow genesis text optimization and the focused harness in the working
tree. The manifest lists the exact dirty source scope. All **943** pinned source
and configuration files were unchanged after the run. Node was **22.23.3** and
installed Chrome was **153.0.8010.53**. The existing local signaling listener on
8909 was reused; Playwright owned the app server on 5321. Both owned Chrome
profiles and the app server were closed after the run. No concurrent test or
profile workload ran.

```sh
env PATH=/private/tmp/hexfield-npm/_npx/52027bd8fc0022aa/node_modules/node/bin:$PATH \
  NODE_OPTIONS=--conditions=@cp2p/source \
  CP2P_ONLINE_RESUME_E2E=1 CP2P_ENCRYPTED_RESUME_E2E=1 CP2P_REFRESH_BENCH_E2E=1 \
  CI_BROWSER_SET=chromium PLAYWRIGHT_TEST_PORT=5321 \
  pnpm --filter @cp2p/web exec playwright test tests/online-resume.e2e.ts \
  --project=chromium --workers=1 -g 'encrypted refresh is peer-ready'
```

This is one passing local sample after the guard, not a latency guarantee.
The [earlier complete encrypted-process repeat](encrypted-process-resume-acceptance.md)
measured 2,796 ms peer-ready; its preserved preceding samples measured
3,149/3,157 ms. The small current margin and that variation remain visible.
No further repeat or threshold increase was used.
