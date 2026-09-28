# Guest-hosted bot and durable consent races

Two focused genuine protocol checks pass; neither runs a full game or browser.

```sh
pnpm exec vitest run packages/protocol/src/guest-hosted-bot.test.ts --maxWorkers=1 --minWorkers=1
pnpm exec vitest run packages/protocol/src/online-ceremony.test.ts -t 'cross-coordinator abort versus consent race' --maxWorkers=1 --minWorkers=1
```

The guest-hosted bot check passed in 8.878 seconds (9.99-second runner). Two
human verified sessions use the existing signed deck fixture, whose default
round-robin ownership assigns bot seat 3 to human seat 1. No ownership override
or default change was needed. Ownership helpers now read the final signed
genesis. Legal setup reaches that bot, and the guest's production delayed bot
scheduler chooses and certifies a settlement placement. The test checks its bot
signature, guest scheduler origin, absence of the bot key and private state on
the other host, identical peer heads and ordered entries, and strict replay of
each peer's own certified history. The decision callback uses the bot's own
private view and legal commands; admission and proof validation remain real.

The consent races passed in 5.828 and 4.164 seconds (10.95-second runner total).
Each uses a genuine fixed-seed one-human ceremony and two coordinators sharing
one device-global durable store and its production lock behavior. The retirement
case pauses before the consent attempt acquires its outer lock. The competing
abort commits retirement first; the producer emits no consent, and restart
refuses the retired attempt. The consent case pauses after the real consent
registry CAS commits while its locks remain held. The competing abort waits;
after release, the one-human ceremony completes and the abort is refused with
`escrow-ceremony-completed`. Restart restores the exact result and cannot revoke
it. This covers the completion-side race; the existing missing-peer consent
timeout test separately covers the recoverable waiting state.

Earlier guest test attempts included a compile correction and a scheduling
failure before automatic private-count work drained. Earlier race attempts
paused inside the outer lock and therefore blocked the competing abort; another
assertion expected the consenting refusal code even though the one-human
ceremony had already completed. These were corrected test assumptions, not
production failures. No deadlines or acceptance checks were weakened. One
interrupted earlier race overlapped an unrelated short fixture test; these are
correctness checks, not performance measurements.

Final shared test typecheck, scoped type-aware lint, formatting and diff checks
passed. The [source manifest](guest-bot-consent-races-2026-09-28.json) records
post-check source hashes, not a before/after runtime pin. Broader mixed-browser,
device and private-every-sequence gates remain separate.
