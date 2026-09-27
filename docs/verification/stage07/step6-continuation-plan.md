# Stage 07 Step 6: live delivery and remaining integration

The pure `verifyCheatProof` classifier, protocol-only certified `cheat-proof` entry, and durable `CHEAT_CLAIM` delivery are implemented. Transport sender identity never names the offender; attribution comes from the signed artifact and the certified operation. A rejected wire message remains an ordinary rejection until the objective verifier proves misconduct at its certified parent.

## Implemented candidate path

`CHEAT_CLAIM` uses the strict claim schema and the normal 256 KiB canonical message limit. Ingress checks the genesis signer, certified-parent height, already-retained or certified `(seat, kind)`, and a dedicated per-peer gossip budget before expensive verification. Historical claims resolve only against certified replay; the resolver checks the exact parent hash before a cache lookup or replay. Historical cheat proposals use a separate work budget so bulk gossip cannot suppress a valid proposal. The current implementation replays a prefix synchronously on a historical cache miss; incremental work slicing is not present.

Verified startup requires a `CheatCandidateStore`. An objectively verified claim is written as canonical detached bytes before gossip or proposal. A store failure sends nothing. The first durable valid local candidate for a `(seat, kind)` is retained, with at most 48 pending pairs; consensus decides which valid claim becomes the first certified finding. Restore replays the journal, rechecks candidates, drops certified records, and quarantines malformed, future, or unverifiable auxiliary records with a status. A transport failure during restore gossip reports a status and does not halt voting. Restore sends one retained claim; every pulse retries one claim in rotating ID order. A certified `cheat-proof` journal commit removes its matching candidate. A store `loadAll` failure remains fail-closed.

`candidate()` gives a retained claim proposal priority even during frozen beacon, deck, count, or steal work. `offerAvailableInput` still prepares and retransmits every owned contribution while the claim waits; the cheat record does not satisfy any frozen obligation. Committing it preserves public game state, private hands, and command nonces, then the owed operation can advance on the next height. A human command bound to the old head requires renewed intent and a new signature.

## Remaining Step 6 work

- Capture the exact authenticated rejected artifact in `SUBMIT` and beacon/deck/count/steal contribution handlers. Only proof-specific failures with intact operation, role, statement, and certified parent may become claims; source, policy, stale, business-rule, and unsigned failures may not.
- Add Stage 06 `invalid-crypto` signed-proposal evidence for an elected sequencer. Authenticate the proposal and certified parent first, then reuse the objective proof classifier without changing quorum or the one-exclusion limit.
- Expose detached replay-derived findings and accepted engine-input count through `P2PSession` and session updates. Render certified per-seat flags, history, and final fairness annotation without leaking uncommitted private openings.
- Consider incremental historical replay and a bounded durable-store operation timeout if real storage measurements show synchronous replay or a hung auxiliary delete can delay voting. Neither is implemented in this slice.

The live regression covers a failed candidate write before gossip, exact retry after a dropped/throwing send and restart, quarantining a future auxiliary record, nonproposer beacon contribution retransmission while holding a claim, one-claim-per-pulse rotation, separate gossip/proposal budgets, direct live historical resolution before and after an owed deck pass, and that deck pass advancing unchanged engine state. Automatic local capture, sequencer accusation, and UI checks await their integration slices.
