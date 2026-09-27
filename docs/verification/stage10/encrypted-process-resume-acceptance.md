# Encrypted browser restart and public snapshot acceptance

Verified on 2026-09-27 in native Chrome against an isolated checkout of
`ace3f52`, protocol v6, with the snapshot-cache correction and extended
`online-resume.e2e.ts` test. The dedicated Vite server used port 5296 and `CI=1`;
local signaling used port 8909. The [source manifest](encrypted-resume-source-manifest.sha256)
pins both overlaid files. No shared development server was reused.

Both independent persistent browser profiles enabled local vault protection
before creating a two-human, three-point game. The test refreshed the higher-ID
responder, entered its passphrase and certified its next move. It closed both
browser processes, relaunched their original profiles in reverse order,
unlocked both, and verified the same seats and certified head before continuing.
Both players finished the game, completed independent clean audits, used Save
and leave, and saw one verified game in their own history.

The first completed run took 47.8 seconds and finished at head 94. Its
[public measurements](encrypted-process-resume-measurements.json) record 69
subsequent player commands and turn 14. It did not cross the snapshot interval.

A dedicated second check delayed optional building with legal End turn actions
until the hundredth commit. It then finished normally at head 110, turn 23,
after 79 player commands. It took 50.0 seconds and passed both audits and history
checks again. Both profiles retained snapshot 100. After closing the live
writers, the test read the native IndexedDB cache and checked its head hash and
public-state hash against the corresponding durable certified entry. See the
[game measurements](encrypted-snapshot-resume-measurements.json) and
[cache measurements](encrypted-snapshot-cache-measurements.json).

This caught a production integration error: supplying the vault-bound journal
factory disabled snapshot storage. Snapshot creation now checks whether the
actual journal is an IndexedDB journal, so vault-bound journals keep the same
public cache. The independent storage tests still cover full snapshot comparison
against certified replay, corruption, deletion and three-snapshot retention.

Refresh restored the local heads in 2,942 and 2,960 ms. The next moves were
confirmed by the other peer in 3,157 and 3,149 ms, including automated passphrase
entry and unlock. The strict three-second peer-ready target is therefore still
open for this encrypted flow. These are local two-Chrome samples, not mobile or
mixed-browser performance evidence.

The bounded test now retains enough resource-timing entries to find the actual
app-loaded registry after Settings and the game load. Its bot retries the
worker's documented `stale-head` and `stale-revision` responses by reading fresh
state, while keeping the time and move limits.

Run the snapshot variant alone:

```sh
CI=1 CP2P_ONLINE_RESUME_E2E=1 CP2P_ENCRYPTED_RESUME_E2E=1 CP2P_SNAPSHOT_RESUME_E2E=1 CI_BROWSER_SET=chromium PLAYWRIGHT_TEST_PORT=5296 pnpm --filter @cp2p/web exec playwright test tests/online-resume.e2e.ts --project=chromium --workers=1
```

Web/test typechecking and scoped lint passed in the isolated checkout. Browser
profiles were removed after their processes closed. Recorded JSON contains
public hashes and audit results, without keys or private hands.

A later repeat against the same isolated source completed the refresh, whole-
process restart, game, independent audits and history checks again. It restored
the local head in 2,651 ms and confirmed the next move on the peer in 2,796 ms;
see the [repeat measurements](encrypted-process-resume-repeat-measurements.json).
This sample meets three seconds, while the earlier 3,149/3,157 ms samples do not.
The measurements establish variability near the target, not a consistent latency
guarantee or mobile-network result.
