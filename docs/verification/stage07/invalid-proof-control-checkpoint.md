# Invalid-proof proposer consequences

Protocol version 5 adds objective proposer evidence for signed system and crypto entries containing an attributable bad proof. Invalid commands keep their existing evidence kind. The runtime replays the certified parent before retaining an accusation, persists it before gossip, and only a certified control entry excludes a proposer. Exclusion never removes voting weight.

The validator requires the elected proposer’s entry and proposal signatures, the exact parent and membership epoch, rejection by normal entry validation, and a separately verified bad-proof finding. A valid entry, stale operation, forged contributor signature, damaged local parent, or failed local verifier cannot establish this proof. The contributor may differ from the proposer. Contributor cheat findings and proposer exclusion remain separate records.

The shared proof extractor is now explicitly consensus-critical. Deck entries wrap their signed pass as `{deckId, pass}`; the previous capture path missed this wrapper. Extraction now follows it. Base-game validation still processes the first pending committed deck. Multi-deck expansion is outside this check.

The protocol version was bumped from 4 to 5 because evidence admission changed. Lobby/genesis admission rejects mixed versions. No compatibility shim reinterprets older saved games under the new evidence rules.

## Independent review

Claude reviewed bounded source packets with tools, MCP connections, customizations and session persistence disabled. The initial packet included `control.ts`, `cheat-capture.ts`, `cheat-proof.ts`, `control-proof.test.ts`, and a description of runtime/consensus changes. The follow-up included corrected control/capture, beacon/replay source and the consensus proposal path. No game secrets or credentials were sent. The raw responses are preserved in [the first review](invalid-proof-control-review-raw.md) and [the follow-up](invalid-proof-control-review-followup-raw.md).

| Review          | Input SHA-256                                                      | Raw response SHA-256                                               |
| --------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| review          | `114fcba4159debe6e970caaa10aa278e390ba04b762e7881967f39e2d07a8b48` | `690eb08aca0172c2eaf654f0ea8a08b4d3e0c5d5c235fdbfd37a435af5e64b93` |
| review-followup | `6a039d94c48d73c8a27a0c008b5a12e4cd98e72da44f829d2747c60b408b0206` | `50cfb0e4933fd9975215ff65af83923295a9dbccbfbd0134c6f99646c52e2ffa` |

The first review required normal entry rejection in addition to a bad artifact, an explicit consensus version boundary, and restriction to system/crypto payloads. Those changes were made. The follow-up reports no concrete exploit in the supplied code and confirms these findings resolved.

The remaining cautions are validation determinism and full operation-binding coverage. The live proposer validates before recording or broadcasting its signed proposal. Beacon validation checks the frozen participant index and operation ID before it can report a bad chain link; negative tests cover earlier/later valid links. Historical accusation verification rebuilds the certified parent, authority and epoch in `replayCertifiedPrefix`. The existing cheat verifier tests exercise command, beacon, deck, count, hidden transfer and delivery-dispute classification; this slice adds a live beacon-proposal accusation and restart trace. It does not complete the full cheating/network matrix or every proof kind through live proposer exclusion.

## Verification

The focused protocol group passes 56 tests across control, consensus, replica, capture, proof classification and certified cheat replay. A separate group passes genesis, lobby and transfer checks, 19 additional cases. Type-aware lint passes on all nine changed protocol files, and dependency checks pass.

An existing replica test expected a sync request while its transport reported no connected peers. It now declares the peer it injects messages from; production no-peer sync behavior is unchanged. The test continues to verify replay-work bounds, progress under hostile traffic and durable refusal after conflicting certified history.
