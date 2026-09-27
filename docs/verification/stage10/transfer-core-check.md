# Protocol v4 transfer core checkpoint

This is a local implementation checkpoint, not a deployment or Stage 10 acceptance.
The user waived protocol backward compatibility on 2026-09-27. Current builds
accept v4 only; earlier saves remain untouched and are reported as unsupported.

The replicated log now admits signed transfer authorization, cancellation and
activation through the same strict membership envelope as recovery. v4 uses
`MEMBERSHIP_SUBMIT`; the previous recovery-only wire variant is not retained.
Recovery authorization still requires each participating voter's explicit local
approval. Transfer authorization requires its certified owner/return and
destination signatures. Neither raw messages nor staged destination keys grant
voting authority.

The four-replica integration test uses genuine gossip, proposals and votes. It
certifies authorization, cancellation, a fresh authorization and activation;
checks all four heads agree; verifies authorization leaves the voters unchanged;
and verifies activation retires the original same-seat signer. Restoring the old
signer from its durable journal is refused. Forged owner intent, a cancelled old
anchor, and repeated activation are rejected. The destination restores a fresh
`P2PSession` under its certified current key, with only its owned private hand.
Membership routing runs after the final `COMMIT` broadcast, including retirement,
and before the replica offers next-height work.

The read-only Claude review is pinned by
`transfer-core-review-manifest.sha256`. Findings 1, 2, 3 and 5 are addressed in
[the membership disposition](transfer-core-review-membership-disposition.md).
Finding 4 is fixed: private master validation now accepts owned byte buffers,
without converting unrevealed masters to immutable base64 strings. Transfer and
recovery-private validation use that path. Successful and failed byte validation
leave the caller's buffers unchanged; temporary owned buffers are wiped.

Local checks:

- Wire and live recovery/transfer regression files: **27/27 passed**, 39.98 seconds.
- Master consistency and transfer-material validation: **13/13 passed**, 8.22 seconds.
- Transfer membership regression file after review fixes: **3/3 passed**.
- Protocol/web production typecheck and global test typecheck passed.
- Scoped root lint passed; dependency boundaries passed (721 modules).
- Existing saved-game/startup regressions: **12/12 passed**, including unsupported
  older saves and the game-wide writer lease.

The browser game factory now loads its durable journal under the game-wide writer
lease, validates stored material against its human key's certified installing
generation, and restores current routes and owned keys. Original master derivation
continues to use the original genesis encryption identity. A transferred key is
never used to derive a different original master secret.

Additional focused checks:

- Four-replica transfer plus fresh-session restore and post-commit hook: **1/1 passed**,
  14.8 seconds.
- Existing P2PSession restore/owned-key/setup checks: **7/7 passed**, 1.9 seconds.
- Browser game transport and transferred-seat factory restore: **6/6 passed**,
  10.0 seconds. This is a simulated transport test, not a WebRTC browser test.
- Original online startup retry and resume: **6/6 passed**, 37.5 seconds wall time.

The promoted-resume helper now independently verifies the binding-bound journal
and exports only the current public device roster over worker RPC. A real signed
activation fixture opens `OnlineStartup` and `P2PSession` with the promoted seat.
Missing binding or missing journal fails, including injected test storage. The
original pre-first-open retry is allowed only when both are absent.

Further focused checks:

- Storage staging, promotion and writer-lease tests: **33/33 passed**, 19.34 seconds.
- Private-transfer review regressions: **9/9 passed**, 23.34 seconds.
- Transport/factory and durable destination credentials: **13/13 passed**, 12.38
  seconds wall time, including Buffer ownership and primary-seat-first ordering.
- Promoted startup and existing resume/runtime suites: **13/13 passed**. The
  original resume test passed again after removing a test-storage exception,
  including missing-binding and missing-journal regressions.
- Recovered-human return: the focused real certified trace passed in 25.8 seconds.
  Supporting private replay, driver and recovered-host tests passed **20/20**.
- Fresh destination with a hosted genesis bot: **1/1 passed**, 11.97 seconds.
  The certified bot command uses its fresh key. Human beacon material remains
  required; a genesis bot has no beacon chain.

The opt-in default-ten-point acceptance test is now `beta-game.test.ts`, enabled
by `CP2P_BETA_GAME_ARTIFACT`, and follows the current protocol version. The earlier
v3 artifact remains historical evidence. That full-game test has not been rerun
for v4 at this checkpoint.

The ownership and resume reviews also found corrections at the browser/session
boundary. A restored host now wipes working material for a bot that has returned
to its human. Master and proof callbacks use current ownership. Beacon outbox
keys include the seat as well as operation and controller generation, so a host
and transferred bot cannot collide in their shared store. Retired controller
routes allow bounded certified-history catch-up only. Membership submission
settles after the final old-route commit and successful route update.

Latest local checks on 2026-09-27, using Node 22:

- Recovery, host transfer and subsequent human return through the real browser
  factory: **1/1 passed**, 8.4 seconds. Private access to the returned seat fails;
  the surviving host's own hand, master and proof sources remain usable.
- Bounded public bootstrap validation: **3/3 passed**.
- Durable destination credentials and promoted resume: **8/8 passed**, 11.95
  seconds wall time.
- IndexedDB journal ownership, including mutated Buffer inputs: **17/17 passed**,
  1.61 seconds wall time.
- Retired transport regression, including a commit notice lost before listener
  attachment: **1/1 passed**, 10.0 seconds.
- Final transfer-session and beacon files: **11/11 passed**. Automatic catch-up
  of a replaced human persists retired safety, releases its private hand and
  refuses a fresh open with the old key. Proposed destination keys get no
  certified-history route.
- The four-replica transfer test passed again with an injected routing failure.
  The certified entry persists, while the waiting submission reports an unknown
  outcome instead of false success.
- `pnpm check:static` passed. It includes production and test types, type-aware
  lint, formatting, dependency boundaries across 731 modules, 15 boundary
  fixtures, engine purity and translation-key checks.
- `pnpm build` and the source diff whitespace check passed. Stored review inputs
  and responses retain their original whitespace and follow the repository's
  formatter exclusions for those artifacts.

The final changed source and test files are pinned in
`transfer-core-postreview-manifest.sha256`. The last additions affect regression
tests only; production/test typechecks, scoped lint and formatting pass for them.

Transfer UI, worker/room destination admission and private packet orchestration
remain unfinished. Startup tests supply in-memory destination journals;
IndexedDB promotion has separate storage tests. No v4 transfer code is deployed.
