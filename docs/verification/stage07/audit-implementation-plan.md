# Remaining end-of-game audit implementation

This is a plan for Stage 07 section 8, not acceptance evidence. No audit or reveal
coordinator exists at this checkpoint.

## Certified public history

Replay the entire supplied certified prefix with `replayCertifiedPrefix`, using
the mandatory built-in proof validators. Record the first certified entry whose
resulting engine state has a result. That entry identifies the finished game for
reveal messages; later certified control or cheat entries can still add findings.
The audit must verify those later entries too.

An unfinished game cannot publish masters or receive a successful final audit.
Corrupt or uncertified history is a history failure, not evidence that a named
player supplied a bad secret.

## Masters and completeness

Require one usable original master per genesis seat. Validate each against its
original master commitment, encryption key, beacon tip and deck keys. Track
missing seats separately from violations. Missing secrets make the audit
incomplete. Recovery may supply only secrets already retained under certified
authorization.

A supplied scalar that does not match the original master commitment is bad
input; it does not establish misconduct by that original owner. A master that
matches the commitment but cannot reproduce the owner's authenticated genesis
keys establishes an inconsistent secret commitment. Preserve that distinction
in reports and in any subsequent certified cheat or void-game flow.

## Independent omniscient replay

Add a recorded-input LocalGame mode that starts at untouched genesis and applies
exactly one recorded engine input at a time. It must retain the existing atomic
rollback, true-hand bounds and module private-invariant checks. It must not
automatically generate random, reveal or victory inputs between recorded inputs.
Normal local play must retain its current automatic behavior.

For every certified entry, reconstruct its private input data and apply the exact
engine input through this all-seat LocalGame. A private card deal uses the certified
receipt and original deck source. A steal uses its fixed contribution and the
original thief encryption secret; independently compare the selected resource to
the victim's omniscient hand and frozen random index. Check the public state hash
after every entry, including entries without an engine input, and compare the
terminal result. Stop a failed private trajectory before it produces cascading
false findings.

Use `reconstructPrivateSeats` as an additional commitment and historical beacon
cross-check. It is not a replacement for the independent all-seat LocalGame
invariant pass. The audit must retain exact certified sequence numbers when
reporting failures and must not put raw secrets in diagnostic messages.

## Reveal delivery and UI integration

Add a bounded side-band reveal message bound to the genesis digest and first
result entry. It must run after normal gameplay stops and also after restoring a
finished journal. Prepare and persist exact outgoing reveals only after verifying
the durable terminal history; do not reuse a pre-result callback as disclosure
authority. Authenticate senders before expensive secret checks, retain at most
one accepted secret per original seat and retry exact saved packets.

Run the audit in a worker once enough verified data is available. Store the report
beside the replay, keyed to its certified terminal identity. Keep the certified
engine result unchanged. Report completeness, missing seats, bounded violations
with sequence/seat information, and certified cheat findings. An honest complete
replay can pass its invariant checks even when the log contains a caught, rejected
cheating attempt; the UI must display that finding separately.

Verification must include completed honest and recovered games, an incomplete
reveal set, invalid master input, an authenticated inconsistent master, modified
private draw/steal data, corrupted certificates, retries and restart after result.
The existing recovery setup trace does not satisfy these full-game requirements.
