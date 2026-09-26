# Trade proof delivery design review

Read-only review of the attached exact files. Do not use tools or external files.
This design is not implemented. Review safety, privacy, crash/retry behavior and
whether the proposed changes fit the existing validation path without excess
complexity. All secrets in fixtures are deterministic test data.

The engine already treats a certified accepted offer or a certified counter-offer
as consent to exact terms. Preserve that behavior; this delivery step must not add
a second user approval. Only a debit that public minimum balances cannot establish
needs its owner's private hand proof. Check the proposed standing-consent privacy
boundary, context/nonce/parent binding, signed request and response, durable retries,
nonblocking session integration, stale-parent cancellation and restored intents.

The proposal uses command-proofs-v2 only when another owner's proof is present.
Assess whether signed owner responses in certified evidence are necessary and
sufficient, including when one host owns both seats. Commands with no external
owner proof retain existing encoding. The shared validator must enforce the same
rules during admission, voting and replay. Never trust a peer-supplied proof plan.

Stage 07 has reviewed beacon, deck and hand-ledger machinery, Monopoly delivery,
and hidden-steal delivery. Escrow and browser storage are later work. Trade proof
delivery must not introduce an encryption or shared-secret disclosure operation.

Return concrete findings with severity and a failing trace, plus decisions needed
before implementation. Separate mandatory safety fixes from optional simplification.
Do not request features outside this scope or repeat already accepted engine rules.
