# Current-v6 hosted-bot terminal audit

2026-09-28, Node 22. The opt-in `beta-game.test.ts` passed one default-ten-point
verified game with two human peer sessions and two hosted bots. Both humans
received the terminal master reveals, independently audited the game, and
installed matching successful complete reports. There were no false cheating
findings or `CHEAT_PROOF` entries.

- Terminal head: sequence **764**, hash
  `06004e4633b036b5e00538b519f69520da0bd5230d7dc1b5f8bb881767c88e2b`.
- Seat 0 won through public victory points at turn **146**.
- **527 commands**, including 25 steals, 49 discards, 6 development purchases,
  5 development plays, and road/settlement/city building.
- Both audit-report hashes:
  `59a56314abc2e639cf4966d01a16235ca1d8a11f5ff846294a8ee8fd839936cf`.
- Total fixture time: **401,123 ms**, including reveals and both sequential
  independent audits. The last pre-terminal progress sample was step 525 at
  212,068 ms; the test does not separately measure each terminal operation.

The audit compares every reconstructed private state with the independent
omniscient replay at genesis and every certified sequence. Each peer's master
loader can supply only its own human seat and hosted bots; the test records and
rejects any foreign-master request. Report completion uses the masters actually
received through the protocol. The test also asserts no missing masters, input
errors, history errors, audit-processing errors, violations or cheat findings.

The public [result](hosted-bot-v6-result.json), [test log](hosted-bot-v6-run.log)
and [source hashes](hosted-bot-v6-source.sha256) are retained. No private game
material is included.

## Bounds and provenance

The first run stopped at the helper's existing 500-step cap in 211 seconds while
play was still advancing. That helper also serves short three-point audit
fixtures. The full ten-point test now requests **1,000 steps** explicitly; the
helper still defaults to 500. The existing **480-second game-loop** and
**600-second test** wall-clock limits are unchanged. This is one full game, not
an increased seed count or a shortened victory target.

The successful run began from `7693752` with the reviewed consensus optimization
and the explicit full-game step allowance on disk. Its consensus source matches
[the final review manifest](../stage07/consensus-fastpath-final-manifest.sha256).
During the run, `cdbb204` moved the post-reducer context check ahead of the error
return, covering failed callbacks as well as successful ones. That final
failure-path guard was not loaded by this run; its regression and the remaining
85 consensus tests passed separately. The controller, audit and fixture hashes
in the run manifest otherwise match the captured sources. This report does not
claim that the run used an identical checkout of `cdbb204`.

Command:

```sh
CP2P_BETA_GAME_ARTIFACT=/private/tmp/hexfield-v6-beta-acceptance/result.json \
  pnpm exec vitest run packages/protocol/src/beta-game.test.ts
```

This proves the current-protocol hosted-bot terminal composition over memnet.
It does not prove native browser takeover/return, recovered-bot completion,
mixed-engine networking, or all nine real-crypto fault scenarios.
