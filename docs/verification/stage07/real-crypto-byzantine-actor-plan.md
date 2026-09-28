# Real-crypto non-voting player endpoint

Scenario 6 in `tools/sim/src/net.ts` injects an objectively invalid signed proposal from seat 0. Three honest peers must certify its proposer exclusion. The original seat-0 session halts and is disposed. A test-only `VerifiedNonVoterActor` then continues that player's commands and private protocol contributions. The actor is exported only through `@cp2p/protocol/testing`.

Exclusion removes proposer eligibility, not the seat or its authority. All four genesis voters remain configured and every later certificate must contain the three honest voters at the original epoch. The actor has no replica, consensus controller or writable safety journal. Its outbound allowlist excludes proposals, votes and commits.

## Private state and signatures

The actor receives one already-scoped `sessionOptions(0)` value. Its driver, hand openings, deck keys, beacon source, contribution stores and terminal master loader belong only to seat 0. It replays independently validated certified entries and applies each one to its private driver. Its head hash must match the honest peer before the runner selects an action.

One command reserves the current parent and nonce before any asynchronous trade proof request. Retries reuse that signed command. A competing command at the same parent is refused. This reservation is in memory; actor recreation is outside this test helper's contract. The runner handles automatic victory claims only when the engine says the actor's private cards actually permit one.

## Contribution delivery

The actor uses the existing beacon, deck, count, steal and trade proof verifiers and durable fixture outboxes. Publication is serialized. Identical artifacts are sent at most once per 250 milliseconds of protocol time. Deck unlocks retain the exact prefix used to prepare their proof across asynchronous work. Head changes invalidate unfinished work.

Trade proof responses require the authenticated requester's peer and reuse a bounded per-head cache. The terminal master coordinator reads the actor's validated history through a read-only journal adapter. The actor can publish only its own master, after a certified terminal result. Honest auditors receive masters through the protocol; they do not use the fixture's separate test-only master accessor.

## Acceptance

The focused actor test checks strict replay of fixture-assembled exclusion and command certificates from seats 1, 2 and 3, signature reuse, detached snapshots, caller mutation isolation and the outbound constraint. These certificates are assembled by the test and do not prove live honest voting.

The full runner additionally requires the signed invalid command to stay out of history, the certified exclusion to contain its exact signed evidence, later entries to retain the three-of-four quorum, an actual actor command to commit, and the actor to publish its own terminal master. All remaining sessions must finish with matching histories and complete successful independent audits. The clean four-human game has passed; scenario 6 and the other fault games remain open until their full runs pass.
