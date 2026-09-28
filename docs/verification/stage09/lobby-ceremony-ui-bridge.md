# Signed lobby diagnostics and ceremony startup UI

Verified on 2026-09-28 with current protocol v6. These focused tests connect genuine signed lobby/ceremony admission to startup presentation. They do not exercise the OnlineRoom worker relay, RTC transport, native browsers, every ceremony abort point or a terminal game.

## Version mismatch

[OnlineLobby.test.tsx](../../../apps/web/src/features/online/OnlineLobby.test.tsx) sends a genuine host-signed lobby snapshot with an incompatible protocol version or engine version to a real guest `LobbyController`. Verification emits the corresponding host-version diagnostic and refuses to install the lobby state. The component renders the matching English translation, including the host's version, as an accessible alert. The start action is absent and the room start callback is not called.

## Durable retirement and consent

The new [ceremony UI bridge](../../../apps/web/src/features/online/OnlineLobby.ceremony.test.tsx) uses two real signed lobby controllers, memnet, retained lifecycle stores and production `OnlineStartup`/`OnlineCeremony`. `OnlineStartup` remains the core used by `OnlineWorkerRuntime`. A cached room adapter forwards real startup emissions to the mounted component across disposal and restoration. Only game opening after assembled and persisted genesis is stubbed.

The fail-before pre-consent trace held the guest's genuine seed-commit packet until the 20-second deadline. Initial retirement displayed correctly. After restoring the host on the same store, the coordinator refused the durably retired attempt, but startup converted its typed failure into a generic error. This exposed a retry action for retired keys. The focused failure completed in 1.054 seconds; no key-safety bypass was observed.

The coordinator now emits the retired disposition from its validated durable record before returning the existing failure. Startup preserves that disposition, so restoration retains the retired message and new-room action without a retry action. The existing protocol timeout test also asserts the restored retired phase and original phase diagnostic.

The post-consent trace holds the guest's original signed consent packet. The host persists its own exact consent, waits through the deadline, disposes and restores on the same store. Startup presents locally consented `consent` progress as waiting, including after restoration. The UI offers no restart or new-room action. Releasing the exact held bytes completes the genuine ceremony; the assembled genesis contains that original signature and reaches game opening. The host's emitted consent bytes remain identical across restoration. This presentation change does not alter signatures, protocol deadlines or agreement assembly.

## Checks

| Check                                                                     | Result                                                                                                                                          |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Version and genuine ceremony UI tests                                     | 5/5 passed; final subscribed-UI run 5.74 s, with 3.527 s post-consent and 0.331 s pre-consent traces                                            |
| Existing ceremony regressions                                             | 4/4 passed in 24.71 s: durable pre-consent timeout, pre-manifest abort, post-consent timeout, authenticated post-consent disclosure and restart |
| Existing startup retry regressions                                        | 5/5 passed in 36.07 s: signer loss, exact-game writer retry, freeze retry, consented dispute during opening, close during deferred lease        |
| Shared test typecheck, scoped type-aware lint, formatting and diff checks | Passed                                                                                                                                          |

Commands:

```sh
pnpm exec vitest run apps/web/src/features/online/OnlineLobby.test.tsx apps/web/src/features/online/OnlineLobby.ceremony.test.tsx
pnpm exec vitest run packages/protocol/src/online-ceremony.test.ts -t 'preconsent timeout|timeout after durable local consent|pre-manifest abort|post-consent disclosure clears'
pnpm exec vitest run apps/web/src/session/online-startup-retry.test.ts
pnpm exec tsc -p tsconfig.test.json --noEmit
```

Game secrets and private ceremony payloads are not included in this evidence.
