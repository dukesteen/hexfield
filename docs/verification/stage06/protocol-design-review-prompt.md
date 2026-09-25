# Stage 06 protocol design review

Review the current working-tree `docs/00-architecture.md` and `docs/06-protocol-event-log.md`, plus stage 10's membership/election requirements. Read files only. Do not edit files, run commands, use network tools, or inspect credentials. These repository files are approved for this review.

We are implementing milestones C and D in stage order. Stage 06 is currently a scaffold. We must preserve all requested behavior and cannot replace the requested protocol with a toy central authority. Before implementation, identify concrete contradictions and safety requirements in the design. Give counterexample message schedules where possible, and recommend the smallest sound correction. Distinguish crash-fault guarantees, detection of invalid/censored entries, and arbitrary Byzantine consensus. Do not write implementation code.

Questions:

1. `gameId` is a hash of genesis without signatures, but genesis also contains `gameId`. Define a nonrecursive hash body, genesis signature scope, and seq-0 validation.
2. ACKs and COMMIT are shown unsigned. We need signed, game-bound ACKs and transferable quorum certificates. What must elections, sync and snapshots carry so a peer cannot fabricate another peer's vote or commit?
3. Voting only on the candidate's known committed prefix can erase a majority-ACKed entry if the old leader saw the certificate but voters have not learned it yet. What log/vote/lock rules preserve every commit across term changes and restarts?
4. Majority ACKs with 2–4 humans and malicious voters do not generally provide Byzantine consensus. E.g. three voters, an equivocating voter joins two different 2-of-3 quorums. Does the stated guarantee require changing quorum rules or explicitly restricting the fault model? Which of the plan's majority partition/takeover guarantees would be incompatible with arbitrary Byzantine safety? Do not silently weaken the safety claim.
5. A signed invalid entry needs a validated parent and election context before it is admissible accusation evidence. Missing ancestors, stale terms and slow timeout clocks are not proof of cheating. Define the distinction.
6. Stage 06 uses stub system evidence. How should stub mode be explicitly bound to genesis and excluded from a secure online game in later stages?

Return a short implementation checklist and any decision requiring the user's choice. We can implement the independent identity/signing primitives while resolving protocol issues.
