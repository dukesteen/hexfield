# Startup foundation review disposition

Reviewed on 2026-09-27. The user authorized Claude reviews. The
[manifest](startup-foundation-review-manifest.json) identifies the source sent to
Claude, with tools disabled. Its [response](startup-foundation-review-response.md)
covers the startup foundation, not the complete browser coordinator or release.

| Finding                                                                 | Disposition and evidence                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1: caller-provided device routing could differ from certified genesis  | Fixed. The game transport requires the agreement and bindings to equal `genesis.commitments.onlineStart`. A separately signed alternate device roster claiming the same public game keys is rejected.                                                                                                                                                                                           |
| M2: a restarted browser could ACK a reused nonce for a different freeze | Reproduced before the fix. `OnlineStartup` now durably pins device/nonce to the exact freeze hash before ACK, then rechecks the live lobby state after storage. The retained-nonce regression passes. Secret derivation alone is not the protection here.                                                                                                                                       |
| L1: unsupported versions could receive verified genesis consent         | Reproduced using matching v1 deck proofs. `signVerifiedGenesis` rejects protocol/engine version mismatches before signing. All 11 genesis tests pass. The online coordinator constructs its draft from the locally approved config; this correction does not claim a general refactoring of all engine preflight checks into the signing helper.                                                |
| L2: journal writes did not recheck the voting-key record                | Fixed. Safety writes and commits check the exact key binding in their own IndexedDB write transaction. Missing or replaced bindings prevent advancement.                                                                                                                                                                                                                                        |
| L3: one throwing game-transport listener could starve other subscribers | Fixed. Message and peer-change callbacks are isolated per listener. A throwing-listener regression preserves delivery to the remaining subscribers.                                                                                                                                                                                                                                             |
| L4: agreement ACK order can have multiple accepted encodings            | Retained helper behavior. `verifyLobbyFreezeAgreement` deliberately accepts input order and returns seat-sorted, detached ACKs. `OnlineCeremony.create` stores that normalized agreement in its final draft. Humans consent to one exact genesis digest. The review identifies no conflicting-certificate attack; this is not a claim that arbitrary external genesis ACK ordering is rejected. |
| L5: repeated journal initialization did not compare genesis entries     | Fixed. Identical entry retries still return `false`; different signed genesis bytes throw.                                                                                                                                                                                                                                                                                                      |

Journal close is also terminal and idempotent. It drains pending operations,
closes the database connection and wipes its cloned key-binding bytes without
mutating the caller's buffer. All 14 focused journal tests pass. The game wrapper's
five focused tests, the real two-human startup/first certified move, and three
startup retry/close/disclosure traces pass. Production and test typechecks and scoped lint
and formatting passed at that checkpoint.

The key record bound atomically to the game journal is separate from ceremony
material persisted before key disclosure. Both records must agree with the
certified game. The browser retains the ceremony for final-genesis retransmission;
reducing that retained object to public retry data remains follow-up work.

Browser refresh/rejoin, public signaling deployment, manual signaling, current
v2 recovered-game acceptance and complete coordinator review remain open.
This review does not complete milestones C or D.
