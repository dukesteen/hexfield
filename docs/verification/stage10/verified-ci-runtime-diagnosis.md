# Verified CI runtime diagnosis

Read-only diagnosis of artifacts from run36389605903 in `/private/tmp/hexfield-ci-36389605903`. No game or cryptographic tests were run for this diagnosis.

## Artifact evidence

| Scenario | Last certified state                                                                             | Outcome           |
| -------- | ------------------------------------------------------------------------------------------------ | ----------------- |
| 2        | seq324, turn54, main phase; seat2 submission pending                                             | 900000ms deadline |
| 5        | seq791, turn139, dice phase; result null                                                         | 900000ms deadline |
| 7        | seq641, turn104; certified public-vp winner0; all audits awaiting reveals                        | 900000ms deadline |
| 9        | seq641, turn104; certified public-vp winner0; seat1 audit complete, other three awaiting reveals | 900000ms deadline |

The artifacts do not contain last-progress wall time, terminal-entry wall time, missing reveal seats, packet census, public beacon position or audit timing. They cannot establish whether each timeout was continuing slowly or stalled. CLAIM_VICTORY appearing in pending actions is not a victory: scenario5 explicitly has result null.

## Deadline accounting defect

`tools/sim/src/net.ts` starts its clock before fixture creation. It checks maxElapsedMs only at the top of the loop, before awaited flush. Successful completion is checked after flush and can return without another deadline check. The verified fixture auditRunner executes auditCertifiedGame synchronously before returning its resolved Promise. Terminal queue work can therefore cross the deadline and still return success. Artifact scenarios1 and3 are marked successful despite elapsed962906.188104ms and977854.132175ms, both above900000ms.

Smallest repair: use one deadline assertion immediately after initial opens, after the main flush, and immediately before the successful return after all terminal checks. This retains the900s budget and50–400ms scenario2 latency/jitter. A check cannot preempt synchronous crypto; it can correctly reject its late result. Add a tiny deterministic deadline-accounting test using a controlled clock or stubbed work, not a full game.

## Scenario5 chain extension

The fixture starts every owned beacon provider with length128. `beacon-source.ts` generates deterministic epoch chains on demand and exposes extension(chainEpoch). `beacon-contributions.ts` detects frozen active participants with index===length and prepares an extension for exhausted participants. `beacon-state.ts` then resets via a certified extension before further reveals. Existing focused beacon-replica coverage certifies extension before the next reveal/dice result.

Turn139 alone does not identify an extension fault or its exact position. It is later than the initial128-turn interval, and normal dice consumption would already have required extension. A public diagnostic of each active participant's seat/chainEpoch/index/length, plus last crypto entry action and counts of SYS_CONTRIB kinds, would establish whether the game is awaiting extensions, reveals or another operation. Do not lengthen the chain to bypass extension acceptance. A bounded existing extension test with four original-human providers and deterministic short chains can resolve extension liveness without a139-turn game.

## Terminal reveals7/9

`replicated-log.ts` creates MasterRevealCoordinator only after a certified result; prepareMasterReveals restores accepted packets, determines eligible publishers, prepares owned packets and broadcasts/retransmits them. `master-reveal.ts` independently replays the durable prefix on its first terminal lookup, then caches the matching certified head. Each session's independent audit performs another synchronous full audit in the fixture. These costs can consume the remaining deadline while other sessions still display awaiting-reveals. Seat1's completed audit in9 proves terminal reveal/audit completion was possible on that branch; it does not prove delivery or acceptance at every peer. The historical artifacts alone cannot distinguish delayed packets from absent publishers.

Current net diagnostics already expose missingSeats and fixture audit timings. Smallest additional instrumentation: elapsed wall time of the first certified result and last certified progress; public outgoing/incoming MASTER_REVEAL counts keyed by originalSeat/publisherSeat and peer; rejected public status codes; and fixture/preterminal/terminal phase durations. Never log masters, signatures or private hands. This makes one coordinated rerun informative without changing the budget. A bounded terminal reveal fixture with a short certified winning branch can test restore/relay/dedup paths separately, but cannot establish900s full-game acceptance.
