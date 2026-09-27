# Private-transfer review disposition

The review in `transfer-private-review-raw.md` covers the source pinned by
`transfer-private-review-manifest.sha256`. It found four low-severity issues.
These corrections are local and have not been deployed.

1. Import now parses the bounded envelope and verifies its claimed source
   signature before invoking certified replay. The first public replay captures
   the source-parent context, so import no longer performs a second public replay
   just to authenticate historical source authority. Private reconstruction still
   independently verifies its input. A self-signed stranger is not trusted as a
   controller; certified authority remains a separate required check.
2. Private input copies are made inside the cleanup scope and use `new Uint8Array`.
   A malformed later input returns a failure, and Node Buffer input cannot alias
   a copy that cleanup wipes.
3. Return preparation filters custody by the exact named recovery authorization
   before loading recovery-private records. It never seals unrelated custody.
   An authenticated prior import may contain several custody records in one
   ciphertext; its unwanted opened copies are erased after filtering.
4. Retransmission requires current source authority but can return a historically
   authenticated packet signed by the other lawful signer of that same seat.
   A surviving certified-device key can therefore resend the original game-key
   packet byte for byte. It does not produce a second ciphertext or expose a master.

The review's conditional recovery-overlap concern is prevented by
`recovery-transfer-pending` admission in `recovery-membership.ts`. Custody collection
now also requires an active departed bot, matching import validation. A prior
return import contains no recovery custody and is not loaded as a recoverer
credential. Recovered custody requires its original authorized key or the
certified chain of live-transfer successors.

All nine focused private-transfer tests pass, including early forged-signature
rejection, malformed later master cleanup, Node Buffer ownership, exact outbox
retry with the surviving device key, and named return-custody reads. A fixture
with multiple independently recovered roots was not added. The named-root
filter is checked before storage reads; this is narrower evidence than a full
multi-recovery game.

Per-seat private-state release was added after this review snapshot. A real
certified recovered-human return test verifies that the former host loses the
returned seat's private state while retaining its own hand. The follow-up review
also includes that release code and durable destination credential generation.
