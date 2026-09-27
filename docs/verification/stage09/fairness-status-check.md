# Fairness status checkpoint

Verified locally on 2026-09-27. This change is not deployed yet.

Verified sessions publish a detached public projection of their committed head,
accepted command count and certified proof failures. Automatic engine and
protocol entries do not increase the move count. The existing commit replay
reconstructs the count after restore. Local games do not display this status.
No private hand, proof payload, secret or unverified peer accusation enters the
projection.

The board indicator opens a dialog that distinguishes live validation from the
final hidden-card audit. Certified failures also appear beside the affected
player, in the event log and in game results. The UI identifies the proof type
and history record without exposing internal errors or raw evidence.

Verification:

- The fairness UI, online worker session and session store passed 20 tests in
  three files. They cover unsupported sessions, dialog close/focus behavior,
  certified failure display, public projection while hands are hidden and store
  lifecycle behavior.
- The [terminal worker check](online-worker-terminal-check.md) exercises a real
  certified game through the worker runtime and session proxy. Its 33 accepted
  commands are distinct from its 53 certified entries; both peers pass the final
  audit. The native nested browser audit also passes.
- Chrome inspection covered the board indicator and dialog on desktop and at
  390 by 844 pixels. The indicator fits beside the menu and dice; the dialog and
  close control fit on mobile. The preview used controlled public fairness data,
  so this visual check does not establish the cryptographic validity of a new
  misconduct trace. The final explanation text was checked again after reload.
- Translation validation passes for 621 referenced keys.
- Protocol/web typechecking, scoped type-aware lint and formatting pass. The
  current workspace production build passes; that build includes the separate,
  unactivated transfer foundation and is not a deployment candidate.

The remaining proposer consequences and broader Stage 07/09 acceptance work are
not completed by this UI change.
