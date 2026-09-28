# Delayed-message acceptance on the final clone build

One complete real-crypto scenario 2 game passed locally on 28 September 2026 at commit `21553e304bfe36f3a5005898c5fe6b0aba7dcccf`, protocol v6, Node 22.23.3. The command used seed 42, game index 0, one worker and the unchanged 900,000 ms limit:

```sh
node tools/sim/dist/index.js net --security verified --scenario 2 --seeds 1 --seed 42 --start-index 0 --parallel 1 --max-elapsed-ms 900000
```

The game finished in 620,931.586 ms with 104 turns and 641 certified inputs. The configured network latency was 225 ms with 175 ms jitter, giving the required 50–400 ms range. The network actually delivered 4,203 duplicate packets. Scenario 2 applies those conditions from startup; its generic `faultInjected` and `faultRecovered` switches remain false because there is no later fault transition to inject or heal.

All four independent audits completed successfully with no cheat findings and the same head:

- Sequence: 641
- Log hash: `d8034528af0b004772dabb88481ba6c79641f3b722cc2e844af943cf05e512ab`
- Final state hash: `905a1631fac51212f2e8721eabb7c751e694420690437750eb61ad4c28b56e39`

Each audit ran once and completed in about 35 seconds. No audit invocation remained pending. This is a simulated network with four genuine cryptographic participants, not a physical-device or browser measurement.

The runner reported source fingerprint `135cef2e5df2188864d308888c90505adee91f0537efdf45fd5bb7dc022bb0d4` and unchanged source. An outer manifest independently matched 952 tracked source/config and compiled JavaScript files before and after the run. The final production build and dependency-boundary checks passed before launch. No other local test, build or browser benchmark ran concurrently.

The earlier [CI scenario 2 timeout](verified-ci-followup-36416940673.md) remains recorded. This local pass uses a different machine and newer reviewed serialization code; it does not establish a like-for-like speedup over that CI run. Together with the previously recorded six scenarios and scenario 5, it supplies the eighth of nine bounded real-crypto scenario results. Scenario 6 remains open until its terminal audits complete.

[Raw result, source manifests and build/check logs](verified-latency-local-2026-09-28.tar.gz), SHA-256 `4bf0b16ca98f34b9312d1623f758bad3be12d714cfd57c4527dcf7f81fc2413f`.
