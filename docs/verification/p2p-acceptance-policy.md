# Bounded M-C and M-D acceptance

The user authorized reducing redundant game counts. Stages 07 and 10 use the
following deterministic coverage requirements instead of hundreds of repetitions
of each scenario. This changes sample counts, not the required failure cases,
security guarantees, performance targets or browser coverage. No unchecked gate
becomes complete through this policy change.

## Stage 07

Run one reproducible game for each of the nine Stage 06 scenarios with the real
cryptographic participants and verified genesis. The existing stub-randomness
simulation remains useful separate coverage; it cannot satisfy these checks.

| Scenario                        | Required observation                                                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean four-peer network         | Complete play and independent final audits with matching certified histories.                                                                                               |
| Delayed and duplicated messages | Actually deliver duplicates and 50–400 ms latency; certify the same history and finish.                                                                                     |
| Sequencer crash and restart     | Crash mid-turn, keep durable safety records, return after 20 seconds, and finish without conflicting votes.                                                                 |
| Two-against-two partition       | Neither partition commits during the 30-second split. Heal and finish from the same prefix.                                                                                 |
| Three-against-one partition     | The quorum commits when required inputs are available. A missing private input must wait. Heal, catch up and finish.                                                        |
| Invalid proposer                | Reject the signed invalid command, certify the attributable finding and proposer exclusion, then finish with three honest voters and legal commands from the excluded seat. |
| Censoring proposer              | Observe an actually censored command, replace the proposer and commit that command, then finish.                                                                            |
| Corrupted local state           | Exercise verified repair from certified history and finish without rolling back any committed entry.                                                                        |
| Two simultaneous restarts       | Restore both peers from durable records, fetch missing certified entries, and finish on the same history.                                                                   |

Record protocol version, source revision, seed, actual injected fault, certified
head and relevant safety assertions. The faulty client in the invalid-proposer
case is not required to maintain an honest history. Expected misconduct findings
in that case are distinct from false findings in honest games.

Require three honest terminal compositions: human-only, humans with hosted bots,
and survivors with a recovered bot. Each must finish on the current protocol,
have no false `CHEAT_PROOF`, and obtain a complete successful independent audit
from every surviving human. At least one uses the server-backed browser path.
The same game can satisfy a scenario and a composition when it proves both.

Keep one focused signed adversarial case for every row of the Stage 07 cheat
table. Assert the stated detection time and outcome, including the private
recovery-void policy. Primitive rejection alone does not prove admission or
certification behavior. Keep the fast 100,000-round dice distribution test.

## Stage 10

Exercise every named chaos addition at least once with deterministic faults and
the current protocol. A trace may cover multiple rows only when it records the
required observation for each.

| Case                         | Required observation                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Periodic restart             | In a four-human game, restart a peer with storage intact at each reached approximately 50-entry boundary, rotating the peer. Restore the exact certified prefix and safety state before voting.                                |
| Permanent departure          | Depart mid-game with four humans, certify old-quorum authorization, reconstruct private state, activate the bot, finish and independently audit every survivor.                                                                |
| Everyone leaves              | Close all peers mid-game, reopen them in a fixed non-seat order, restore the same prefix, certify a new move, finish and audit.                                                                                                |
| Sequencer loss during unlock | Interrupt before persistence, after persistence but before send, and after peer acceptance but before local commit. Never send an unpersisted vote or replace a durable contribution; retry the same operation after recovery. |
| Return after takeover        | Rebuild the returning human's private state, certify fresh keys, keep old keys retired and continue. Exercise another takeover where the signed quorum permits it; otherwise assert pause.                                     |

Compare reconstructed private state with an independent omniscient engine at
every certified sequence of the representative lifecycle game. Add focused
fixtures for draw, steal, transfer, recovery and return if that game does not
exercise their private-state changes. Public-state or final-score agreement
cannot replace exact private-state equality.

Retain focused checks for every signing/persistence interruption boundary,
transaction abort, lost acknowledgement, writer contention, stale import,
migration, withholding shares and two-/three-human quorum loss. Retain native
browser refresh, takeover, save transfer, encryption, history and snapshot
checks. The measured three-second resume target remains unchanged.

## Execution

Use bounded runs with explicit time and move limits. A timeout is a failure to
investigate, not a reason to silently increase the limit. Store public results
and source provenance; keep private game material out of reports. Run local
native browser checks in Chrome. Run the required Firefox/WebKit combinations
on CI to avoid the user's local browser crash popups.

The existing Stage 06 CI policy is unchanged. The new real-crypto and lifecycle
fixtures must be named and mapped to these rows before claiming acceptance.
