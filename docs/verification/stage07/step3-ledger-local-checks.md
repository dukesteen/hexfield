# Deck ledger checkpoint

This checkpoint connects the Stage 07 deck proofs to genesis and certified log
validation. Step 3 and Stage 07 remain incomplete.

Genesis fixes the canonical 25-card base catalogue, full seat roster, ordered
pass hashes and final setup hash. Durable outgoing consent checks the complete
ceremony and reserves one final genesis per ceremony and signer. The replica
certifies those exact passes before gameplay or beacon contributions begin.
Missing local pass blobs prevent startup before any voting journal is initialized.

The replayed ledger owns deck setup, the next position, the pending draw and
unrevealed receipts. `CARD_DEALT` requires its complete ordered unlock chain.
Development-card plays and victory claims require matching owned-card proofs,
even with a permissive policy callback. Only successful entry application advances
the prospective ledger. Rejected entries consume no position or slot.

Command admission performs full candidate validation before queueing. Failed
proofs cannot frame an honest proposer or block a valid queued command. Repeated
distinct invalid proofs are bounded by sender strikes; exact and stale retries
do not consume repeated strikes after a local validation failure.
Exact proposal replays avoid proof work and storage writes. Objective accusations
use the command policy from the same certified parent, including historical replay.

## Local evidence

- `pnpm check`: 722 tests in 128 files passed, along with typechecking, lint,
  formatting, dependency, engine-purity and i18n checks. Raw log:
  `/private/tmp/hexfield-step3-ledger-resumed-check.log`. The preceding run was
  interrupted at the user's request; this completed run checks the same source.
- `pnpm build`: all workspace builds and the production web bundle passed. Raw log:
  `/private/tmp/hexfield-step3-ledger-final-build.log`.
- Verified beacon integration: all 15 focused tests passed with real deck setup,
  signed contributions and certified replay. Coverage includes storage failures,
  partial setup, restart retransmission and transient send failures.
- The six-seat 25-card envelope regression measured 13,000-byte proposals,
  12,808-byte commits and 26,091-byte two-proposal accusations, below 262,144 bytes.
  It uses real pass proofs and explicitly synthetic envelope certificates.
- No browser process was launched. These protocol changes do not complete the
  outstanding browser performance acceptance check.

The [source manifest](step3-ledger-source-manifest.json) records 189 source and test
files, with fingerprint
`920a5ba79ed90fc4b2cfca685c529e1817c3cb88fa6e032e0def380e90cf973b`.
The [review response](step3-ledger-review-response.md) records the findings and
corrections. Each review packet has its own source manifest.

## Remaining work

`DeckInbox` is still isolated from live messages. Next, connect ordered unlock
delivery and retries to the local certified pending request, persist contributions
for the human and hosted bots, and apply owner identities through certified private
replay. Session submission also needs reveal-evidence production before signing.
Browser stores, the lobby ceremony, resource commitments, hidden transfers, escrow
and the final audit remain later Stage 07–10 work. The prior cold Chrome shuffle
benchmark still misses the three-second target.
