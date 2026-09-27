# Protocol v6 and vault route fixtures

CI [36350770428](https://github.com/dukesteen/hexfield/actions/runs/36350770428)
on `f9a8253` passed static checks, the engine simulation and all nine network
scenarios. Its unit shards exposed stale fixture assumptions.

- The transfer-membership test pinned protocol 5 even though its fixture now
  creates protocol 6. It now requires `PROTOCOL_VERSION` and checks rejection of
  `PROTOCOL_VERSION - 1`; the full transfer and retired-key assertions remain.
- Home, public-replay and imported-save route tests used mocked application
  queries but attempted to initialize the real vault in happy-dom without
  IndexedDB. They now provide an explicit ready, unencrypted vault query state.
  The dedicated vault UI tests still exercise locked/unlocked routing.
- The imported-save viewer now offers certified device continuation. The test
  checks that its only button is that disabled continuation control while
  private material is locked, rather than assuming no button exists at all.

Focused results: all three route tests and six vault UI tests pass; the targeted
transfer-membership test passes. Scoped lint and formatting checks pass. The
separate deck-card fixture failure is owned by the deck acceptance work. The CI
run is not claimed green by this report.
