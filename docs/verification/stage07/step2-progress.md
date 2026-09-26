# Stage 07 beacon progress

The pure helpers for signed beacon reveals, exact participant completion,
deterministic engine-request derivations, exhausted-chain renewal and replayable
public beacon state are implemented. The working-tree `pnpm check` passed 623
tests in 112 files, including 21 focused tests across these four protocol test
files. The production build passed. No browsers ran for this checkpoint.

This does not complete Step 2. The helpers are not yet connected to the certified
log, contribution gossip, durable outgoing messages or `P2PSession`.

## Integration contract

- Signed genesis owns `commitments.beaconChains`, an ordered `{seat, length, tip}`
  array for exactly its human roster. Bot seats do not add chains.
- A certified engine request freezes its original entry reference, membership
  epoch, round, human keys and previous links. Controls preserve that request.
  Starting-seat selection is anchored at the signed genesis entry.
- Reveals may be gossiped only after the request is certified. One result entry
  carries the complete ordered signed evidence. Each preimage is fixed by its
  predecessor; separate consensus rounds for individual reveals are unnecessary.
  Signatures authenticate reveals but do not enter the random seed.
- Start-seat and dice inputs consume all links atomically with their result.
  Steal selection instead fixes its seed and index in an engine-preserving entry.
  The later proven transfer refers to that entry and cannot consume links twice.
- On exhaustion, all required signed replacement tips commit before any reveal
  from a new chain. Renewal keeps the original request, anchor and round.
- The generic integer sampler remains unchanged. Request derivation binds the
  full validated request into its context. Labels are `d1`, `d2`, `start-seat`,
  `balanced-dice` and `steal-index`. Development-card draws belong to the deck
  protocol and cannot use this registry as a fallback.
- Public crypto state is reconstructed from certified history and checked in
  replay snapshots. The engine state hash remains engine-only, avoiding a
  circular dependency between an operation anchor and its containing entry hash.
- Outgoing signed contributions must persist before sending and retry identical
  bytes. Recovery will need certified authority to supply a departed human's
  fixed preimage without recovering that human's independent signing key.

Missing evidence stalls the operation. No subset, timeout reroll or fresh seed
can replace the fixed request. The session integration must test replay, controls
between request and result, stale contributions, crash/retry behavior and one
human playing with bots.
