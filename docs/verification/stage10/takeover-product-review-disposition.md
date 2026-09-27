# Takeover product integration review

The read-only Claude review used the [bounded source packet](takeover-product-review-input.md) (`011e9e8b29913ad06f7eb336bd9327ad2cc34e7214878913e43354041c43c288`) with tools and session persistence disabled. Its [raw response](takeover-product-review-raw.md) (`a0147231ea581bf588e52f58faac74de13f1a05678d492a3ba42a9172daea9ca`) is unchanged. The packet predates the fixes below. No secrets or browser state were sent.

The stale-candidate finding was valid: a locally reconnected seat could still leave a cached approval candidate visible. `RecoveryPanel` now offers approval only while the candidate's departed seat is still locally missing; it hides the panel entirely when no peer is missing. A regression covers reconnect and a different missing seat. The protocol's certified vote gate remains authoritative.

The two low-severity findings were addressed. Auto mode now repeats the irreversible recovery disclosure beside its waiting status. Eligibility polling stops while a matching signed candidate awaits a vote, and resumes if that candidate is stale for a different missing seat. Focused tests cover both behaviors.

The four-human gate is intentional for the current online game. `lobby.ts` and `online-ceremony.ts` cap online games at four seats; `quorumSize(3)` is three, so a departed player in a two- or three-human game leaves fewer reachable humans than the old quorum. The docs/11 expansion is future work, not current online admission. The 120-second vote default is also intentional in `takeover-ui-design.md`; the lobby editor shows the signed policy and the irreversible disclosure before freeze. This review did not change that policy.

The source packet omitted the pre-existing signing chain, so its genesis-binding concern required a separate source check. `LobbyController.configure` signs and commits `takeover` in `LOBBY_CONFIG`; the frozen state and ACKs bind that state. `OnlineCeremony` copies that value into its draft; `genesisSchema` requires it; and `validateGenesisOnlineStart` compares it canonically with the frozen agreement. No caller-only policy controls protocol authority.

Verification after fixes: eight focused web test files passed, 43 tests total; web TypeScript, scoped type-aware lint, formatting, and `git diff --check` passed. No broad suite or browser run was made. This review covers the product bridge and does not independently prove full end-to-end takeover completion.
