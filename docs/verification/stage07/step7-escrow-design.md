# Master commitments and escrow distribution

Verified genesis now requires an ordered, distinct nonidentity `masterPub` for
every original seat in `commitments.masters`. The pre-genesis ceremony ID binds
these keys together with the config, roster, encryption keys and fresh nonce.
Dealer messages cannot depend on the final genesis digest because that digest
contains their transcript.

`commitments.escrow` contains each eligible dealer's ordered sealed shares and
holder acknowledgements. It is explicitly empty when there are fewer than four
original humans. Eligible human dealers exclude themselves; bot dealers exclude
their original host. Every other original human is a required holder, with
Feldman index `seat + 1` and threshold equal to the holder count. Bots never add
independent holders, and later membership cannot lower this threshold.

Each dealer signs a bounded share envelope. It binds the ceremony, original
dealer and holder identities, holder encryption key and index, master public
key, exact coefficient commitments, share hash, ciphertext and sender ephemeral
knowledge proof. The holder verifies the signature and fixed statement before
group work, verifies ephemeral knowledge before opening, checks the decrypted
payload hash and Feldman equation, then signs an ACK. The ACK includes the hash
of the complete signed envelope, so it cannot move to another ciphertext or
polynomial.

The aggregate verifier requires every eligible dealer and every required holder
exactly once, in original seat order. All shares from one dealer must use the
same coefficient commitments. A structural pass rejects wrong holder order,
thresholds and mixed polynomials before proof work. A private checked context is
then reused for all envelopes and ACKs, avoiding a full genesis parse per share.
Both `signVerifiedGenesis` and `validateGenesis`
run this verifier before optional application policy. A callback returning
success cannot bypass a missing or invalid transcript. An ACK authenticates the
holder's acceptance; it is not a public proof of the encrypted plaintext.
The per-envelope helpers also check the dealer's master against genesis, even
when a caller supplies an expected key. Every coefficient must be nonidentity,
matching honest generation and excluding a reduced-degree polynomial.

A holder can produce a signed bad-share complaint only after dealer signature,
binding and sender ephemeral-key knowledge verification. The complaint binds the
complete signed envelope and discloses the ECDH point with a DLEQ against the
holder's encryption key. Public verification authenticates the complaint and
decryption point, then uses the same payload/hash/Feldman checks as acceptance.
A correctly opened share produces a typed false-complaint verdict against its
holder. An invalid opening produces a bad-share verdict against its dealer.
Malformed data, an invalid signature or an unauthenticated point produce neither
verdict. Both authenticated disclosures expose a share. Before genesis consent they
require aborting the whole ceremony. After consent they are retained for an
agreed disposition; an already sent genesis signature cannot be revoked. Complaint proof randomness derives privately from the holder's
encryption secret and the exact signed envelope. It is never caller-supplied.

The distribution lifecycle requires signed approval of the frozen manifest from
every original human. Both approval and distribution compare the candidate with
the locally frozen manifest, including player roles and bot hosts, before any
share can be returned. Retry entropy derives from the retained master under a dedicated
label and the exact ceremony. A device-global atomic store reserves every master
for exactly one ceremony and retains the exact envelopes before returning them
for delivery. Competing ceremonies cannot both reserve the same master.

Abort atomically retires every local master in the ceremony and records a
permanent ceremony tombstone, including when abort races with the first
reservation. Verified bad-share and false-complaint evidence use this same
transition. Storage failure returns no successful retirement verdict. The
provided memory store is a test double. `IndexedDbByteStore` now provides
bounded atomic records shared across tabs, resolving writes only after the
transaction commits, and an exclusive Web Lock for ceremony critical sections. Retirement also tombstones masters that have not yet been
reserved and clears cached envelopes for retired masters. Admission reserves
storage for every active ceremony's abort. Retirement may consume its own
allocation while preserving space for other active ceremonies. The registry is
bounded; a full device must refuse new attempts before exposing any share.
The coordinator now validates the signed genesis and complete deck transcripts
before recording completion in the same CAS registry. Completion discards
cached envelopes and retains permanent master bindings. Never clear the
registry to retry a reserved or retired master.

`EscrowCeremony` pins the local frozen manifest and holds a device-wide lock
through durable checks and synchronous message enqueue. It retains an accepted
private share with its exact signed ACK before delivery. Genesis consent first
reserves an irreversible exact digest, and further aborts fail. Authenticated
post-consent disclosures are retained across restart; completion returns a
disputed result when they exist. Complaint publication retains the exact
outbound evidence and durably retires setup before enqueue. These methods are
building blocks for the future lobby driver, which is not wired yet.

Active masters must not be exported to another device during setup. A corrupt
registry fails closed; starting another attempt requires new keys, never reuse
of a key whose prior reservation cannot be established. Only public sealed
envelopes and ACKs enter genesis.

`verifyRevealedMaster` checks a disclosed canonical nonzero scalar against its
master commitment, original encryption key, initial human beacon tip, and every
shuffle and lock public key in the completed genesis decks. The supplied deck
ledger must match the genesis digest and committed final setup hashes. This is
the key-consistency check required for recovery. It neither authorizes secret
release nor replaces the full historical audit. Certified replay remains the
authority for genesis and ledger provenance.

`reconstructPrivateSeats` authenticates a complete certified prefix before
checking supplied master secrets. It verifies every owned human beacon link and
extension, rebuilds owned hands and dealt slots through the verified private
driver, and checks commitment openings after each entry. Failure disposes the
partial result. Its caller must already own or have authorization for the
supplied secrets; this function does not authorize recovery or audit the game.

Remaining integration includes the lobby and network delivery driver, the
old-quorum recovery-authorization certificate, authorized share release, a
second activation certificate, and end-game reveal/audit. A timeout alone must
never release a share. If a required holder withholds, recovery pauses. A
master/key mismatch after authorized reconstruction must void the game rather
than activate an unusable replacement seat. Context corruption and invalid
released shares must not be classified as a departed seat's master/key
violation. The next [recovery design](recovery-integration-design.md) separates
current controller authority from the original cryptographic commitments.
