# Current-v6 clean four-peer network game

Passed on 2026-09-28 in the local Node 22 runner. Four independent human-seat
`P2PSession` instances played a default ten-point game with real beacon, deck,
hand and steal proofs. RandomBots chose legal moves using only their own seat's
private state. This is the clean-network row of the
[bounded acceptance policy](../p2p-acceptance-policy.md), not the eight fault rows
or a browser transport check.

## Result

- Protocol v6, verified genesis, seed 42, game index 0, scenario 1.
- Finished at certified head 641, turn 104.
- All four human sessions obtained complete successful independent audits with
  the same final head and no misconduct findings.
- Final entry hash: `d8034528af0b004772dabb88481ba6c79641f3b722cc2e844af943cf05e512ab`.
- Public state hash: `905a1631fac51212f2e8721eabb7c751e694420690437750eb61ad4c28b56e39`.
- Elapsed time was 773.9 seconds, within the predeclared 900-second limit. The last
  logged preterminal entry was 640 at 380.8 seconds. The runner performs final
  audits synchronously in the same process; the later interval is not separately
  profiled. Other focused tests and a native browser check ran concurrently, so
  this is functional evidence, not an isolated performance benchmark.

Each session's audit received master reveals through the protocol. The runner
requires `ok`, `complete`, an exact final head, matching certified histories and
no honest-player misconduct findings. It does not use the fixture's testing-only
`mastersForAudit()` accessor to complete these audits.

## Reproduction and provenance

```sh
pnpm exec tsc -b tools/sim
node tools/sim/dist/index.js net --security verified --scenario 1 \
  --seeds 1 --seed 42 --start-index 0 --parallel 1 --max-elapsed-ms 900000
```

The actual local invocation called `runNetworkGame` with those game parameters
and wrote a progress event every twenty certified revisions. It used compiled
modules loaded at process start. HEAD at launch was
`cdbb20462e4871aebdb7eb01372ce9cc179637f4`, with the uncommitted verified simulator
and fixture additions captured in the
[source hash manifest](verified-network-clean-v6-source.sha256). During the run,
only the scenario-6 simulator branch, unused non-voter helper and separate tests
changed among those recorded sources. The result therefore establishes the
clean-game path on the captured build, not an unchanged final checkout or
scenario-6 behavior. CI must pin the completed implementation commit.

The [public result](verified-network-clean-v6-result.json) and
[progress log](verified-network-clean-v6-run.log) are retained. No private keys,
master secrets, hands or plaintext card assignments are included.
