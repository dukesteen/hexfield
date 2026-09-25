# Stage 06 final security regression review

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

The simulation harness is being updated separately and is outside this pass.
Review the current fixes for the previous review's concrete traces. Do not expand
scope into Stage 07 cryptographic proofs, Stage 08 WebRTC, or Stage 10 key storage.
The raw-key API and simulation-only private driver remain explicitly scoped.

Check these paths, with concrete failing traces and file/line references if any:

1. P2PSession.restore now delegates historical-control validation to certified
   replay and reconstructs private consequences in order through its callback.
2. Validated objective evidence naming the local seat must terminal-halt before
   further voting, whether received as ACCUSE, proposal, COMMIT, repair or restored
   state. Invalid signatures must not cause an unauthenticated self-halt.
3. Two distinct proven offenders must halt regardless of whether the first proof
   was local or certified, including after restart and certified-value repair.
4. Accepted submissions disposed before a known result report outcome unknown.
   A pre-admission rejection remains a rejection. A failed send is not cancellation.
5. Historical evidence uses a bounded cache of certified parent contexts, allowing
   alternating old heights without replay on every transition.
6. The adapter authenticates evidence before spending its historical replay budget.
7. A conflicting, authenticated old-height certificate must terminal-halt even if
   its proposed value fails deterministic validation.
8. Sync hints and responses are bounded and require certified progress for continued
   catch-up. Check that limits do not permanently starve legitimate peers.
9. Restore serializes proof recovery before attaching incoming transport.
10. Restart retransmits the newest rounds first, avoiding repeated loss of current
    messages when a bounded incoming queue drops the tail of a burst.

The fault model remains at most one Byzantine human, quorum sizes 1,2,3,3,4,4 for
one through six humans, fixed voters within a height, and no votes from bots.
Exclusion removes proposer eligibility only. With two or three humans a missing
required voter pauses agreement. A sole human is a single authority. A certified
value is never rolled back to hide a private-driver error. The production build
excludes the simulation UI and stub driver.

Distinguish a reproduced or fully specified defect from an unverified risk. Do
not claim the stage is accepted based on static review. Report any remaining
blocking issue first, then summarize the reviewed paths and limits briefly.
