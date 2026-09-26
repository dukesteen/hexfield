# Deck reservation correction review

Review the attached files read-only. Do not use tools, edit files or contact
external services. All project Claude reviews are authorized. There are no
credentials or real game secrets in this packet.

This is a narrow final check of the follow-up finding. It is not Stage 07
acceptance. The first review and its follow-up are included with the current
response, implementation and tests.

Please check that the reservation key now matches the scope used to derive
position secrets, so two valid final locked setups under the same definition
cannot bypass it. Inspect the real conflicting-setup regression, pre-write
signer validation, CAS handling and copied inputs. Check that the forged shuffle
test now demonstrates that no permutation can answer the opposite challenge for
its false commitment. State whether each follow-up finding is addressed or give
a concrete remaining failure within the documented helper contracts.

Certified setup authority, genesis catalogue/roster checks, certified pending,
drawer reservation before decoding, one-time replicated consumption, and owned
slot verification still require coordinator integration. The source/outbox must
share durable storage lifecycle. The helper accepts trusted local secret-source
implementations bound to the corresponding deck definition. These are explicit
remaining integration requirements, not claims of implemented live P2P draws.

No proof algorithm or soundness parameter changed during this correction.
