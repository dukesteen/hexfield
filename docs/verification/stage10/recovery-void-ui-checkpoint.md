# Certified void presentation and history

The v6 recovery protocol reports `SessionStatus.kind === 'void'` separately from
a normal game result. The browser opens a no-winner dialog with View board and
Save and leave actions. A persistent game notice can reopen it. The action
controller removes placement and command choices and rejects a callback captured
before the void, even if its stored revision is unchanged.

The history writer stores a bounded game/genesis/head marker. It stores no
master, recovery share, accusation or winner. History displays the void and
excludes it from statistics, including when conflicting winner display metadata
is present. Certified replay remains the authority; display metadata cannot
reactivate a seat. The existing deletion prefix covers this new per-game record.

Verification on 2026-09-27:

- 25 tests pass across GameActions.pending, RecoveryVoidDialog,
  SavedOnlineGames, OnlineGameScreen, online-game-history,
  online-game-history-writer and online-games query tests.
- The action regression preserves a pre-void callback, changes only session
  status, then verifies that neither validation nor submission runs.
- Web build typechecking, test typechecking, scoped type-aware lint, formatting
  and translation-key checks pass.

These are focused UI/storage checks. The protocol's independently authenticated
shares and certified void are covered by the
[implementation review and protocol tests](../stage07/recovery-void-implementation-review-disposition.md).
No native malicious-peer browser trace is claimed here.
