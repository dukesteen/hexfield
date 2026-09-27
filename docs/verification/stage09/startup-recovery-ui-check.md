# Setup and recovery UI checks

Focused run on 2026-09-28:

```sh
pnpm exec vitest run apps/web/src/features/online/OnlineLobby.test.tsx \
  apps/web/src/features/online/RecoveryPanel.test.tsx
```

Eight tests passed in 3.05 seconds. Scoped type-aware lint and formatting checks
also passed.

The lobby test renders failed, halted, retired and post-consent waiting states.
Failed and halted attempts expose their public diagnostics in a disclosure.
Retired attempts now expose the same diagnostics, including setup timeouts,
and offer a new-room path rather than retrying retired keys. A client waiting
after consent sees the agreement-waiting message and no restart or new-room
action in that progress panel.

The recovery panel tests cover local eligibility before a request is available,
an early request refused by the protocol, approval of the exact candidate,
local decline, candidate removal after the missing player returns, and stopping
eligibility polling when the panel closes. Automatic and never-takeover policies
do not expose the manual request action.

These are component tests with controlled public state, not proofs of key
retirement or timer admission. The separate
[signed timer traces](../stage10/timer-acceptance.md) exercise early timeout
refusal at real replicas. Ceremony consent, retirement and disclosure behavior
has separate tests in `packages/protocol/src/online-ceremony.test.ts` and
`apps/web/src/session/online-startup-retry.test.ts`. This UI run does not by itself
close every cryptographic abort path or the native recovery-to-finish gate.
