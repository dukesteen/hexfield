# Live recovery and bot continuation

The session now exchanges recovery shares and approval checks, installs an
activated replacement bot, and restores that bot after its host restarts.
This extends the [certified recovery checkpoint](recovery-checkpoint.md).
Milestones C and D remain incomplete.

## Behavior

- Recovery release messages are routed to their named recipient. The authenticated
  sender must host the original share holder. Approval messages require the
  current recoverer, exact authorization and certified parent. Retained packets,
  verification attempts and retries are bounded.
- Every participant prepares its own approval from durably retained, verified
  original shares. The replica proposes activation only after all required
  approvals are present. It keeps the existing quorum rules.
- The activated host loads only replacement keys and masters bound to completed
  certified authorizations. It reconstructs the bot's private hand, checks its
  original beacon secrets and rereads the journal before returning ownership.
- The replica installs ownership inside its commit queue, checks the exact current
  hosted controller keys, and rejects installation if it closes or the journal
  changes during I/O. Contributions use the new signing generation with the
  original private secrets. The departed human key remains retired.
- The session adopts reconstructed private state at the same certified head and
  retains the secret sources until disposal. Ordinary commands wait while the
  handoff is loading. Recovered seats are installed again on restore.
- An injected bot policy receives only the bot's private hand and detached public
  state. The paced scheduler selects active bots hosted by this peer, waits for
  required human choices and cancels stale timers on commits and disposal. Local
  play and P2P share the same pending-action selector.

## Evidence

The live replica regression exchanges real recovery shares and approvals, then
certifies activation and finishes the original frozen beacon with the replacement
signing key. The earlier regression still covers a delayed departing voter that
replays its removal, persists retirement and cannot reopen its former key.

The session regression starts from a certified four-human genesis and completed
deck setup, with one human absent. The remaining three sessions authorize and
complete recovery, finish the waiting beacon and accept a legal bot setup move.
The command verifies under the replacement key and fails verification under the
original human key. Only the selected host exposes the recovered private hand.
Restarting that host restores the same hand and head, then all three peers accept
another bot move. Non-host sessions remain available after activation.

Additional focused tests cover restored key/source disposal, refusing an
unauthorized or overlapping private hand adoption, bot decision delay, one
submission per parent, and timer cancellation after a commit or disposal.

The 2026-09-27 combined `pnpm check` passed all static checks and 1,104 tests in
184 files, with the existing opt-in draw benchmark skipped. The unit suite took
164.73 seconds. `pnpm build` also passed. All 610 source hashes stayed unchanged
through both commands. The [verification record](live-recovery-verification.json)
links the source manifest and command logs. No browser automation was launched
for this checkpoint. A read-only implementation review by another agent found no
blocking lifecycle issue; it does not replace the pending Claude review.

## Remaining work

This is a recovery and restart trace during setup, not a complete game or audit.
The end-of-game reveal coordinator, omniscient audit and its worker/UI report are
still missing. Remaining integration includes automatic cheat consequences,
complete-game and chaos acceptance, manual/relay signaling, the online lobby,
browser writer-lease consumers, takeover policy UI, returning humans and certified
cross-device transfers. The Claude implementation review remains pending its
usage-limit reset.
