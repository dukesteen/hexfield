# Stage 06 security review follow-up

Perform a read-only review of the same implementation files approved for the
initial review. Do not edit files, run commands, inspect credentials, or read
outside this list:

- docs/verification/stage06/strict-agreement-design.md
- docs/06-protocol-event-log.md
- packages/crypto/src/identity.ts
- packages/protocol/src/types.ts
- packages/protocol/src/schemas.ts
- packages/protocol/src/genesis.ts
- packages/protocol/src/log.ts
- packages/protocol/src/votes.ts
- packages/protocol/src/proposal.ts
- packages/protocol/src/control.ts
- packages/protocol/src/consensus.ts
- packages/protocol/src/consensus-controller.ts
- packages/protocol/src/safety-store.ts
- packages/protocol/src/journal.ts
- packages/protocol/src/replay.ts
- packages/protocol/src/messages.ts
- packages/protocol/src/replicated-log.ts
- packages/protocol/src/p2p-session.ts
- packages/protocol/src/consensus-adversarial.test.ts
- packages/protocol/src/consensus-review.test.ts
- packages/protocol/src/consensus-controller.test.ts
- packages/protocol/src/replicated-log.test.ts
- packages/protocol/src/testing/simulation-driver.ts
- tools/sim/src/net.ts
- tools/sim/src/net-adversary.ts

The original review found gaps around durable accusations and safety halts,
unbounded conflicting proposals, strikes for honest congestion, expensive replay
before authentication, unchecked local signatures inside larger signed objects,
and submission results after a transport failure. These are the main subjects
of this follow-up. Inspect the current implementation and tests rather than
assuming a fix is correct. Give concrete failing traces and file/line references
for remaining issues, ranked by severity. Say which reviewed paths are sound.

The fault model remains at most one Byzantine human, with quorum sizes
1,2,3,3,4,4 for one through six humans. Bots never vote. The sole-human case has
one authority. Excluding a proposer never reduces quorum or voting weight.
Both halves of a 2|2 partition must pause, and two-/three-human games require
every voter. A value hash excludes proposer, round and outer signature.

Review crash recovery around accepted accusations, a gameplay commit that wins
before an exclusion, a second proven offender at a later height, a conflicting
historical certificate, and resuming from durable state. Historical evidence
must use its certified parent and voter/proposer context, never payload-supplied
state. Check replay budgets and that continued sync requests require actual
certified progress. Unknown signatures by the local key inside certificates,
proposal justifications, accusations and entries must stop unsafe signing.

Scope boundaries are explicit. Stage 06 has an injected raw-key API and an
in-memory crash-persistent journal. First activation requires a fresh game key;
restore refuses a missing journal. Stage 10 will own nondeterministic per-game
keys atomically with IndexedDB safety records and prohibit old-key reinitializing
as recovery. This production ownership layer is not claimed here. Likewise,
simulation stub evidence binds its input and parent but does not prove private
facts or deadlines. Stage 07 must supply proof verification before commitment.
A publicly plausible but false stub input may fail its later private check;
the certified entry is not rolled back. Production excludes the stub driver.

A corrupted derived context that prevents revalidating stored proposals stops
the controller and preserves the journal. Fresh session restore performs
certified replay. In-place repair is implemented for authenticated certificate
validation failure, not every corrupt-cache path. Assess these stated boundaries
without treating later stages as already implemented. Identify a concrete
violation if the existing code fails within them.

The user reduced initial full-game acceptance to twenty games per scenario,
retaining targeted adversarial regressions. Do not treat test counts as proof of
protocol safety.
