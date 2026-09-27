# Recovery groundwork local checks

Verified locally on 2026-09-27 with Node 22 and pnpm 10.7.1. This checkpoint does not accept Stage 07, Stage 10 or milestones C/D.

`pnpm check` passed all static checks and **1,031 tests in 170 files**, with one opt-in draw timing test skipped. Vitest took 155.42 seconds. No game-count acceptance batch or browser process was launched. The [575-file source manifest](recovery-local-checks-manifest.json) was captured before the run and remained unchanged after the test run and production build. `pnpm build` passed, and the native storage harness strings and worker are absent from the production bundle.

The new ceremony coordinator pins the frozen manifest, persists accepted private shares with exact ACKs, reserves irrevocable final-genesis consent and validates signed genesis/deck transcripts before completion. Completed master bindings remain permanent. Authenticated post-consent disclosures survive restart and prevent a successful completion result. Focused regressions cover genuine invalid dealer ciphertext, durable retirement before publication, enqueue failure and exact retry, master reuse refusal, and the crash gap between saving disclosure and retiring setup. A valid four-human final draft cannot bypass the pending-disclosure barrier. Additional post-consent disclosures remain retainable.

`IndexedDbByteStore` has eight passing tests, including concurrent connections, migration/version errors, close/reopen, corruption, unavailable locks and abort after a write request reports success. The separate [native Chrome check](native-storage-check.md) uses two workers with native IndexedDB and Web Locks. It does not claim tab-crash, power-loss or cross-browser acceptance.

Private reconstruction has four focused tests covering owned-seat isolation/disposal, valid beacon extension length changes, a signed inconsistent extension, and invalid public history checked before secret blame. Existing live draw and steal traces now reconstruct selected bot hands from certified history and compare their private state, including dealt slots and at least one steal endpoint. These checks do not authorize recovery or constitute full end-game audit.

The [Claude design review and response](recovery-integration-review-response.md) are complete. The [implementation review attempt](recovery-implementation-review.md) produced only a session-limit response. The root agent's [local review](recovery-implementation-review-response.md) found and verified the crash fix; it is not an independent Claude approval.

Remaining work includes certified recovery authorization/release/activation, controller-key resolution, browser protocol journal/session restoration, lobby delivery, full audit and remaining networking/performance acceptance. The verified mode is not exposed in the published online UI.
