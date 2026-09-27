# Certified recovery integration

This is the next implementation design, not an implemented or accepted feature.
The existing public replay rejects membership entries. Escrow distribution and
master consistency checks alone do not permit recovery or release.

## Authority and state

Add a replay-derived membership record alongside the current vote context. It
contains the current controller signing key and host for every seat, the human
voter list, epoch, pending recoveries and completed recoveries. Genesis supplies
the initial record. Immutable genesis encryption keys, master commitments,
Feldman rosters and deck keys stay separate from controller signing keys. A
recovered master must never reproduce a voting or command signing key.

One recovery authorization changes one human controller and every bot it hosts.
It names the affected seats in sorted order, the replacement host from the
remaining human voters, fresh per-seat command keys and the next voter list.
The new keys sign readiness over the full genesis digest, certified parent hash,
next epoch, complete affected-seat list and replacement configuration. The host
also signs that statement. Before emitting readiness, the host atomically stores
the fresh private keys with that exact statement and retains them through restart.
Every key must be distinct from all used game keys.
Only a valid old-set commit certificate makes this change effective, at the next
height. Timeouts and connection status are user-intent triggers, never evidence
that permits secret disclosure or reduces the quorum.

A pending authorization can be amended by a new certificate under the current
voter set with fresh readiness and durably retained replacement keys. It may
change the host but cannot restore the departed key, erase disclosure or reduce
the original escrow threshold. Honest holders use the latest certified amendment
and never send a new release to a superseded recipient. Previously disclosed
shares cannot be recalled. If the current quorum is unavailable, amendment waits.

Automatic absent-human removal is available only if the remaining voters can
meet the old quorum. Two and three humans cannot remove an absent voter. Four
humans need the other three signatures; the resulting set needs all three for
further commitments. Original escrow eligibility and holder thresholds never
change. A controller may host several bots, but those bots add no voters.

The authorization freezes command and contribution authority for all affected
seats. It does not activate their replacement keys yet. Nonces, private resource
commitments, deck positions, beacon chains and operation identifiers remain
unchanged. Protocol control and recovery entries remain available while an
engine input or secret contribution is pending. A certificate is validated under
the parent voter set, then the new membership and epoch are installed atomically
with the committed entry and next-height safety record.

The first implementation admits recovery only after all fixed genesis deck
passes are certified. An interrupted pre-play deck setup must resume from its
retained transcript before recovery. Membership validation must bypass ordinary
draw/beacon pending guards once setup is complete, without answering the pending
input or changing its frozen data.

## Frozen operations across epochs

The current count and steal validators compare each frozen operation epoch with
the current crypto epoch and resolve signing keys from genesis. Both assumptions
must be removed before accepting an authorization entry. A simple less-than
epoch check is insufficient. Replay must retain the exact certified freeze
record and its original participants, anchor and operation hash. A membership
change can preserve that record but cannot replace it. New operations use the
current epoch and controller record.

For an existing operation, separate the immutable cryptographic statement from
the current contributor's signature authority. Proof statements, deterministic
randomness, ciphertexts, deck indices, recipient encryption keys and already
certified artifacts stay unchanged. Signatures on newly submitted artifacts use
the activated controller key from the current certified membership. Existing
certified original signatures remain valid historical evidence. Uncertified
messages from the departed controller cannot enter the log after its freeze.
The new controller can acknowledge an already certified sealed delivery with the
original recipient encryption secret. A fixed transfer must not be regenerated.

Every admission path, proof verifier, trade request, historical accusation,
private driver and replay uses the same authority resolver. Historical evidence
resolves authority at its certified parent, never the latest roster. Transport
device identity is mapped to per-game keys; a signaling peer ID is not itself a
voting key.

## Release and reconstruction

The holder's release API accepts a locally validated certified prefix, not an
arbitrary approval callback, standalone roster or claimed timeout. It replays to
the authorization entry, verifies its old-set certificate and readiness, checks
the named recipients and local share binding, and persists the exact encrypted
release before returning bytes for delivery. Release envelopes bind the full
genesis digest, authorization entry hash, affected seat, original holder index,
recipient identity and original sealed-share hash. Only named recoverers receive
shares. Current certificate validation must also establish ancestry from the
holder's durable head; a conflicting or regressing history cannot authorize it.

Released shares must match the original sealed payload hash and Feldman
commitments. A released bogus share is a recoverer/holder failure, not proof that
the dealer used the wrong master. Duplicate holders cannot count twice, and all
original required indices are needed. A previously recovered holder's original
encryption key also opens its shares for other dealers. That privacy loss is
unavoidable: a coalition containing that key now needs every remaining original
holder other than the recovered holder to reconstruct another dealer. Honest
release policy must still require the new dealer's own authorization; possession
of recovered keys is never consensus authority for a second departure.

Reconstruction first verifies the scalar against masterPub, then derives the
original encryption, deck and initial beacon keys. Replay additionally verifies
every committed beacon extension and reconstructs the private state through
the existing verified private driver, including blindings, dealt slots and both
directions of steals. The final public commitment openings and invariants must
match the activation parent. If the parent advances during recovery, catch up
before offering activation. The master or private hand must not be written into
a public activation entry.

An activation certificate under the remaining voter set names the authorization
hash and public recovered-state check digest, bound to the activation parent's
hash and state. The digest does not depend on the activation entry or its derived
post-state. Honest recoverers vote only after
performing the same key and private replay checks. Activation changes the engine
seat status to bot, installs the previously named command keys and host, and
allows continuation of the original pending operation. A failed key derivation
from a correctly reconstructed committed master produces a certified void
result with attributable evidence. Missing shares, corrupt local context and
invalid release messages only pause recovery and do not blame the dealer.

## Storage and tests

Persist ownership transitions and their certificates before sending any votes
or derived contributions. A retired local controller must never resume signing
from an older private record. Restore replays membership and checks durable
voting safety before constructing the active signer. Browser writers need an
exclusive lease with fencing, not a best-effort BroadcastChannel convention.
Returning humans need a fresh-key transfer certified by the current voter set;
possessing an old master or restored command key does not restore authority.

Required focused traces include old three-of-four authorization and new
three-of-three activation; rejection of two-of-three removal; no release for a
proposal, timeout, wrong branch or forged certificate; restart at authorization,
release and activation; pending beacon/count/draw/steal preservation; departure
of a bot host; stale original signatures; wrong fresh-key readiness; corrupted
share versus committed-master mismatch; and private replay to a changed
activation parent. A complete recovered-bot game and audit remain acceptance
requirements beyond these focused traces.
