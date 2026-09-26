# Stage 07 beacon review response

The authorized [read-only Claude review](step2-review.md) found no trace that
substitutes or biases a public beacon outcome. It identified a chain-secret
lifecycle gap and test gaps. This response separates those findings from later
work and documented trust assumptions. Stage 07 is not accepted.

## Extension secret lifecycle

Accepted. Persisting a signed extension tip alone is insufficient if the secret
provider chooses a different chain after a crash. The provider contract now
requires deterministic chains from the retained master secret, ceremony context,
configured length and chain epoch. A built-in source implements that derivation
with separate initial/extension HKDF labels, bounded caching and disposal. Restarting it
reconstructs the same tip and links. It validates the canonical nonzero master,
ceremony digest, seat, epoch, index and length.

The regression interrupts persistence after extension generation, recreates the
source, applies the verified extension transition and verifies the next reveal
from another fresh source. Full certification is covered separately by the
replica extension test. A local derivation/signing failure also has its own error
code instead of being reported as a storage failure. Browser persistence remains
Stage 10 work. Callers must retain the master, ceremony context and chain length
on restore rather than depend on a future application default. The length is also
available in the signed genesis commitments.

## Test coverage

The duplicate test in the original packet was too weak. Before receiving the
review, it was replaced with a stronger scenario: all reveals are present, votes
are missing, and repeated/future contributions must cause no additional
derivation, voting-store write or outgoing message. The same test checks stale
messages after commitment.

Additional negative tests cover protocol-label mismatch, the wrong fixed-result
kind, ambiguous random requests, and the pending-operation barrier before generic callbacks.
Registered extension outcomes must also answer the frozen `pending.systemType`;
a wrong-type regression failed before that guard was added. The exact-byte
outbox test also forbids another call to the secret source; deterministic
signatures alone would not prove reuse. The extension crash test exercises the
secret lifecycle that signature equality cannot establish.

## Qualified findings

- Custom derivations are trusted local module code, as is the engine itself.
  Network messages cannot register or replace them. Matching module versions and
  wiring derivations from the signed configuration belong to module/setup
  integration. This checkpoint supplies only the base registry in normal use.
- The two-to-four-seat limit matches `baseModule.modifyConfig`. Five/six-seat
  rules are later module work. Balanced dice reset at six or fewer cards inside
  `rollDice.apply`, before the engine creates its random pending, so the minimum
  pending deck length of seven matches the engine.
- A storage exception deliberately halts local signing. It may require restore
  even if the exception was transient. The retained record still controls retries;
  storage failure cannot authorize a new choice. Network send failures on the
  beacon path are retried automatically.
- A participant can choose a publicly known or copied chain, or a short chain.
  This weakens its own contribution but cannot cancel another honest participant's
  unknown contribution because the seed hashes ordered values. The protocol
  supports bounded lengths from one to 65,536; the built-in source defaults to
  4,096. Withholding can already stall a game, so a minimum length would not
  establish liveness against a malicious participant.
- The existing vote/command retransmission path can halt on a transport exception.
  The new retry guarantee concerns beacon contributions. Broader transport
  reconnection behavior remains work for the networking/recovery stages.

The review omitted some engine and Stage 06 files and did not execute tests.
The coordinator checked the engine bounds above directly. The final local check
and source fingerprint are recorded separately in [local checks](step2-local-checks.md).

## Completed follow-up

The [follow-up review](step2-followup-review.md) confirms that deterministic
extensions address the original crash/restart trace under the provider contract.
Its remaining findings led to explicit retained-length documentation and a
length-separation test. Registered hidden-index outcomes now also require
`STEAL_RESULT`, closing the wrong-result-kind gap. That regression failed before
the guard was added.

The source-error code has a regression that also checks no contribution is written.
Its message now covers unavailable or disposed sources without falsely claiming
a key mismatch. The crash regression now disposes the restarted provider before
creating the next reveal, and this report distinguishes its pure extension
transition from the separate certified-network test.

The coordinator checked the duplicate-message wiring omitted from the follow-up
packet and ran a [mutation check](step2-duplicate-mutation.json). Removing the
inbox duplicate guard makes the strengthened regression fail on extra derivation
calls. The source was restored byte-for-byte before final checks.

These follow-up changes were checked locally after the second review. No third
external review is claimed. Broader module wiring, browser storage and later
cryptographic protocols remain unfinished.
