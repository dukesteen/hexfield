# 07 — Fair Randomness & Hidden Information

## Goal

Replace the stub randomness from stage 06 with cryptographic protocols so that no peer (including the sequencer) can predict or bias random outcomes or see cards it shouldn't:

1. **Randomness beacon**: dice, starting seat, steal index, balanced-dice draws, and any public random choice.
2. **Deck protocol** (mental poker with verifiable shuffles): hidden draws (dev cards; later progress cards, fog tiles, fish tokens…).
3. **Committed hands**: every seat's hidden resources are held as public homomorphic commitments, so every spend, reveal and transfer is proven **on the move that makes it**.
4. **Hidden transfers**: robber steals, with a proof that the right card moved and encrypted delivery through the log.
5. **Key escrow**: an eligible departed player's secrets can be recovered after certified authorization, if all required share holders cooperate.
6. **End-of-game reveal**: available secrets are published after the game for the omniscient replay and a defence-in-depth re-check. Missing secrets leave the audit incomplete.

All code lives in `@cp2p/crypto` (primitives, pure and deterministic given inputs) and in `@cp2p/protocol` (orchestration/sub-protocols).

## Prerequisites

Stage 06 is complete.

## Threat model recap

Honest-but-possibly-cheating players who may run modified clients. We guarantee:

- **Unpredictability and unbiasability** of post-genesis public randomness, provided at least one independent human participant is honest. A refusal can stall a fixed outcome but cannot select a replacement. Public board selection happens before consent to genesis; aborted setup attempts can select among public layouts.
- **Confidentiality** of hidden cards against the other independent human devices, unless all required escrow holders collude or certified recovery reveals a seat's secrets. A bot host already knows its bots' secrets; bot seats do not add independent privacy protection.
- **Per-move detection** of lies about hidden information. Every input that touches hidden information carries a proof, and every peer verifies it before it votes for the entry. An input with a missing or bad proof is never applied, so a cheat can't change the game state; the cheater is identified on the move it tried (§6). Nobody has to wait for the end of the game to know whether it was fair.
- The single exception is whether a seat's escrowed master secret matches the keys it actually used. That can only be checked by reconstructing the secret, which happens at takeover or at the end-of-game reveal (§8).

Aborting (refusing to reveal or to prove) can't bias outcomes. It only stalls, which triggers timeout handling (stage 10).

### Certified context and execution

Before setup, all participants sign a frozen manifest containing config, roster, per-game public keys and a fresh ceremony nonce. Its hash is `ceremonyId`. Setup proofs bind this ID, their phase, actors and full statement. Final genesis commits to the complete ordered setup transcript, including encrypted shares and receipts. Setup artifacts cannot depend on the final genesis digest, because that digest includes those artifacts. An aborted attempt uses fresh secrets, voting keys and nonce.

After genesis, proof contexts bind its full digest, the certified membership epoch, a fixed operation parent, operation kind and ordinal, participants, key versions and the exact public statement. The certified request freezes beacon participants and index, deck position and unlock order. An existing engine command creating a pending request can be this anchor; an extra empty entry is not required. Later controls or membership changes preserve the operation. Recovery supplies the missing contribution to that operation. No early beacon reveals, rerolls or reuse of a consumed round are allowed.

Typed crypto and `CHEAT_PROOF` entries can preserve engine state while advancing protocol state. A pure `CryptoContext` is folded from certified history and included in replay-verified snapshots. Owner proofs are prepared before command signing. Certified evidence is available to private-state application; provisional decryption never changes the visible committed hand. Outgoing contributions, receipts and choices persist before transmission, and retries resend their exact bytes.

Run the online protocol, engine and crypto together in a dedicated worker. The main thread bridges WebRTC bytes and exposes a `GameSession` proxy to Zustand. Verification stays synchronous inside the protocol worker; a peer cannot supply a trusted `verified` flag. Check signatures, context, shape and expected dimensions before expensive group work. Bound pending proof tasks and bytes so they cannot starve voting and heartbeat processing. Any verification cache keys the complete canonical context, statement and proof and has a size limit.

## 1. Per-seat master secret

- At game creation, each seat samples `masterSecret` as a uniformly random nonzero ristretto255 scalar (CSPRNG rejection sampling, 32-byte canonical encoding) and publishes `masterPub = masterSecret·G` in its genesis commitments. Game cryptographic secrets are derived from it with HKDF-SHA256 using distinct labels and canonical context tuples: beacon chain seed, deck keys, Pedersen blindings, per-card lock keys and the in-log encryption key. Device identity and per-game voting keys are independent and are never escrowed.
- This makes escrow (§7) a single scalar that can be shared verifiably, and makes the end-of-game reveal (§8) simple: reveal `masterSecret` and everyone can re-derive and check everything.
- Each seat also publishes an **encryption public key** `E_i = deriveScalar(master, encryptionKey, context)·G`, used to seal private payloads inside public log entries (§5). Scalar derivation reduces 64 HKDF bytes modulo the group order and retries zero in a distinct counter domain. Wire scalars and group points have strict canonical encodings. Key scalars and key points must be nonzero; zero responses and identity Pedersen commitments are valid.
- Store the secret in the seat's private state (IndexedDB, stage 10).

## 2. Randomness beacon (hash chains)

### Setup (during the genesis ceremony, stage 09)

- Each seat derives a chain seed `x_L = HKDF(master, "beacon")` and computes `x_{i} = H(x_{i+1})` down to `x_0`, with `L = 4096` (enough for very long games; if a game ever exhausts it, run a "chain extension" round where each seat commits a fresh chain tip, signed and logged).
- Genesis contains each seat's tip `x_0`.

The source must reproduce the same chain after a crash, even if an extension tip
was generated before its outgoing record was persisted. `createBeaconSecretSource`
derives each seed from the retained canonical master scalar and
`{ ceremonyId, seat, chainEpoch, length }`, using `beaconSeed` for epoch zero and
`beaconExtension` thereafter. The ceremony, seat and configured length remain
unchanged on restore. Its default length is 4,096; it retains at most two derived
chains in memory. The master and chain buffers are cleared on disposal as a
best-effort memory cleanup, not a guarantee about JavaScript memory copies.

### Each beacon round k (k = 1, 2, …)

- Each **participating** seat reveals its next chain link through `SYS_CONTRIB { genesisDigest, contribution }`. A `beacon-reveal` contribution signs the operation ID, seat, chain index and preimage. Anyone verifies `H(x_k) == x_{k-1}` (the previously revealed value, or the tip).
- Output: `R_k = SHA-256(canonical(["cp2p/v1/beacon", operationContext, k, orderedReveals]))`, where each ordered reveal includes its participant ID. Use canonical tuples, never ambiguous concatenation. The operation context fixes the participant order and previous tips.
- Participating seats are the human seats eligible when the request is certified. That set remains frozen for the round, including a later departed participant whose contribution must be recovered. Subsequent rounds use the certified updated set. Bot seats have no beacon chain and do not participate. One independent honest human participant is enough for unbiasability.
- Evidence for the `system` entry: the list of reveals. Every peer verifies each preimage and recomputes the output.

The operation ID hashes the full frozen context, including each chain's epoch,
length, next index and previous tip. The global beacon round advances once per
completed request; an individual chain index restarts at one after extension.
If any chain is exhausted, those participants first sign `beacon-extension`
contributions containing their next chain epoch, length and tip. A certified
`beacon-extend` entry installs the tips while preserving engine state and the
original request anchor. No participant reveals the next round before that entry.

`CryptoContext` is derived by certified replay. It is included in checked
snapshots and the local voting context digest; `stateHash` continues to hash only
engine state. The entry payload carries the ordered beacon evidence. Starting
seat and dice results use proof protocol `beacon-v1` and built-in verification,
so a generic system-proof callback cannot approve a different result. For a hidden
steal, a state-preserving `beacon-fixed` entry records the index before the victim
prepares the transfer proof described in §5.

Each participant persists its signed outgoing contribution before transmission.
Retries and restoration reuse that record. The delivery cache admits one verified
contribution per expected seat for the current operation and does not replace it
from a delayed, duplicate or future packet. Only a certificate advances chain tips.

### Derivation of outcomes from `R_k`

- `uniformInt(R, label, n, context)`: derive 8 bytes using the uniform-int HKDF domain and canonical label/context/counter tuple. Interpret them as an unsigned big-endian integer. Reject values at or above `2^64 - (2^64 mod n)`, then return the remainder modulo `n`; derive again with an incremented counter on rejection.
- Dice 2d6: `d1 = uniformInt(R, "d1", 6) + 1`, `d2 = uniformInt(R, "d2", 6) + 1`.
- Starting seat, steal index, balanced dice: `uniformInt` with their own labels.
- The engine's `random` pending names the request type. Map each request to a derivation function in a `randomDerivations` registry that modules can extend.

### Security notes

- Each value was committed at genesis (a hash-chain link), so nobody can choose it after seeing others' values.
- A seat that has seen everyone else's reveal can compute the result before revealing. It can only refuse to reveal, which stalls. The stall policy: after `revealTimeout` (default 10 s online, or when a seat is offline), the seat is handled by stage 10's takeover rules. Once a seat is abandoned and its escrowed master secret recovered, the others can compute its chain values themselves. **The outcome remains fixed.** A seat cannot obtain a different roll by refusing to reveal. When the required quorum or escrow holders are unavailable, the game pauses instead of rerolling; it cannot guarantee completion against an aborting peer.

## 3. Deck protocol (mental poker on ristretto255)

Use `@noble/curves` ristretto255 (prime-order group, no cofactor issues). Notation: `G` generator, scalars mod `ℓ`.

### Card encoding

- Each distinct card _identity_ (e.g. `knight#3`; every physical card gets a unique identity even if the types match) maps to `P_c = hashToPoint("card", { ceremonyId, deckId, deckEpoch, identity })`. Use the same canonical public mapping for every participant.
- The mapping table is public, and decoding is a lookup.

### Phase A — Shuffle (at genesis ceremony, or whenever a deck is created/reshuffled)

Every pass carries a proof, so a bad shuffle is rejected before any card is drawn.

1. The canonical deck list `[P_c1 … P_cm]` is public.
2. **Shuffle pass**, in seat order: each seat `i`
   - picks a **shuffle key** `a_i` (HKDF from master, label `deck:<deckId>:shuffle`) and a permutation `π_i` (derived from master),
   - publishes `A_i = a_i·G`, maps every point `X → a_i·X`, permutes by `π_i`, and publishes the resulting list (`SYS_CONTRIB`, logged),
   - attaches a **single-key shuffle proof** that the output is a permutation of `a_i·input` for the `a_i` behind `A_i` (see below).
   - Every peer verifies the proof and checks that the output has exactly m **distinct** points.
3. **Locking pass**, in seat order: each seat `i` removes its shuffle key and applies a **per-position lock key** `b_{i,j}` (HKDF, label `deck:<deckId>:lock:<j>`), i.e. position `j` becomes `(b_{i,j}/a_i)·X_j`. It publishes the list together with its **lock public keys** `B_{i,j} = b_{i,j}·G` and, per position, a DLEQ proof that `log_{X_j}(out_j) == log_{A_i}(B_{i,j})`. Since `B_{i,j} = (b_{i,j}/a_i)·A_i`, this proves the seat removed exactly `a_i` and applied exactly the lock behind `B_{i,j}`. Distinctness is checked again.
4. The final list is the encrypted deck `D[j] = (∏_i b_{i,j}) · P_{σ(j)}`. It's stored in the log. Together, the proofs guarantee that `σ` is a permutation of the canonical deck and that every lock layer matches a published lock key.

#### Single-key shuffle proof

The statement is: "`out = π(a·in)` for some permutation `π`, where `A = a·G`". Use a Fiat–Shamir cut-and-choose proof with `λ = 64` rounds (domain `cp2p/shuffle`):

- For each round the prover picks a fresh scalar `r` and permutation `ρ`, and commits to `R = r·G` and `Y = ρ(r·in)`.
- The challenge bits come from SHA-256 over the transcript (`gameId`, deck, seat, input, output, `A`, every `R` and `Y`).
- Bit 0: reveal `(r, ρ)`; the verifier recomputes `R` and `Y` from `in`.
- Bit 1: reveal `u = a·r⁻¹` and `τ = π∘ρ⁻¹`; the verifier checks `u·R == A` and `out == τ(u·Y)`.
- Neither opening reveals `a` or `π`. A cheating prover survives with probability `2^-λ` per attempt; 64 rounds make offline grinding impractical for a board game.
- Cost for m = 25 cards: about `λ·m` ≈ 1,600 scalar multiplications to prove, the same per shuffle to verify. It runs once per deck, in a worker, during the ceremony. A Bayer–Groth shuffle argument can replace it later if deck sizes or player counts make this too slow. Record both choices in DECISIONS.md.

### Phase B — Private draw of position j by seat d

1. Every seat `i ≠ d` removes its lock layer from `D[j]`, as a chain in seat order (skipping `d`). Starting from `Z_prev = D[j]`, each seat publishes `Z_i = b_{i,j}^{-1}·Z_prev` together with a **DLEQ proof** that `log_{Z_i}(Z_prev) == log_G(B_{i,j})`. That's Chaum–Pedersen, Fiat–Shamir with SHA-256 and domain `cp2p/dleq`. This proves the seat removed exactly its own lock layer. The layers commute (scalar multiplication), so the order doesn't matter, but a fixed seat order keeps the transcript canonical.
   - Latency: (players − 1) sequential hops. With ≤ 6 players and tiny messages this is fine (< 1 s). Pre-unlocking ahead of time isn't possible, because the drawer isn't known until the draw.
2. The last point `Z = b_{d,j}·P` is public. Only `d` can remove its layer: `P = b_{d,j}^{-1}·Z`, then look up the identity. **Only d learns the card.** Because Phase A is proven, the lookup always succeeds for an honest drawer.
3. The public log records `CARD_DEALT { seat: d, deck, slotId }`. Its proof evidence binds position `j` and the complete unlock chain to the certified request. The protocol derives `j` from the next unused deck position and checks it against the engine's public draw history; it is not a new engine input field. The owner's private state records the identity only after certification.

### Phase C — Public reveal (playing the card)

The owner publishes `identity` plus a DLEQ proof that `Z == b_{d,j}·P_identity` relative to `B_{d,j}`. Everyone verifies before the engine accepts the `PLAY_DEV_CARD` command. (The protocol layer attaches the proof as command evidence. The engine only sees the verified identity.) Victory-point cards revealed to claim a win use the same proof.

### Which position is drawn?

Positions are drawn in order `0, 1, 2…` (the deck is already jointly shuffled). No beacon is needed.

### Notes

- The pure setup and draw helpers validate proofs, not permission to start a draw. The coordinator must derive the operation from its own certified pending request and verified deck transcript before preparing an unlock. Accepting a peer-supplied operation based only on its shape would expose an arbitrary-point decryption service. Replay must compare the physical-card catalogue to the agreed module definition and consume positions once, in order.
- Persist one signed setup pass per deck definition, seat and phase. A competing predecessor under that key must fail instead of producing a second output with the same deterministic shuffle or lock secrets. For a draw, derive points and keys locally from verified setup. Every participant, including the drawer, reserves the deck position for the complete operation ID before returning or signing. Reusing the position for a different request fails. Retries verify and return the stored signed contribution after an immutable insert, including after a concurrent writer wins.
- Using per-position lock keys prevents the linkage leak where a revealed card identifies other positions encrypted under the same key.
- The shuffle and locking proofs close the substitution cheat (a seat applying different keys per position) at shuffle time, before any card is dealt.
- All deck keys, permutations and proof randomness bind the deck creation operation and epoch, including reshuffles. Reusing one Sigma commitment under another challenge can reveal its witness. Derive nonce material from the complete statement, context, role and round; retransmissions reproduce the exact proof. Helpers also separate standalone and composed proof modes internally. A composed opening and its ranges share a branch challenge; the CDS verifier hashes all ordered statements and first messages and checks that branch challenges sum to the resulting Fiat-Shamir challenge.
- Encode the shuffle proof compactly as exactly eight challenge bytes, MSB first, and 64 scalar/permutation responses. With `(σX)_j = X_{σ⁻¹(j)}`, bit 0 reconstructs `R=rG`, `Y_j=r·in_{ρ⁻¹(j)}`. Bit 1 reconstructs `R=u⁻¹A`, `Y_j=u⁻¹·out_{τ(j)}`. Hash the complete reconstructed transcript and compare all eight challenge bytes. This is equivalent to transmitting the commitments and retains the 64-bit soundness bound. Reject noncanonical or zero response scalars, non-bijections and duplicate or identity deck points. Certify bounded passes separately; do not put six unbounded proofs in one wire message. Measure worker performance before claiming the target is met.

## 4. Committed hands

The engine keeps tracking public **bounds** (stage 02) and validates against them as before. The protocol layer adds a committed hand for every seat, which closes the gap the bounds can't: a spend or reveal that the bounds allow but the true hand doesn't.

### Representation

- A second generator `H = hashToRistretto("cp2p/pedersen/H")` (nothing-up-my-sleeve; nobody knows `log_G(H)`).
- For every seat and every hidden card type `r` (the five resources in the base game; commodities etc. are added by modules), every peer stores a Pedersen commitment `C_r = n_r·G + s_r·H`. The owner alone knows the blinding `s_r`.
- At genesis every hand is empty: `C_r = 0` with `s_r = 0`.
- The commitments are protocol state derived deterministically from the log. Every peer computes the same vectors, so they need no extra messages.

### Updates

- **Public gains and losses** (production, bank and player trades, builds, dev-card purchases, public discards, Year of Plenty, monopoly payouts): every peer adds or subtracts `k·G` from the affected `C_r`. Blindings don't change, so this is free.
- **Hidden transfers** (steals): the transfer is a vector of commitments with a proof (§5). Every peer subtracts it from the victim and adds it to the thief.

Use deterministic engine-owned resource and card-slot effects, separate from UI events, to update these commitments. Preserve ordered gross debits and credits; normalized bounds and net deltas do not identify actual transfers. Effects include hook-adjusted build costs, bank-shortage-adjusted production, setup grants, trades, discards, development-card purchases and effects, slot deals and reveals. Count reveals require an opening proof even when the count is zero. For a player trade, check affordability for both owners at the current parent. Certified offer/acceptance authorizes the terms; collect an additional owner-signed proof only for a debit its current public minimum cannot establish. Bind that proof to the parent, offer, terms, both seats and commitments. A parent change requires reevaluation. Timeout discards with uncertain hands require the owner or recovered bot's valid input.

### Proofs attached to inputs

| Situation                                                     | Proof, attached as input evidence by the owner                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| A public loss of `k` of type `r` the bounds can't guarantee   | Range proof that `C_r − k·G` commits to a value in `[0, 2^κ)`                          |
| A count reveal (monopoly victim, any "how many X" effect)     | The claimed count `n`, plus a Schnorr proof of knowledge of `s` with `C_r − n·G = s·H` |
| A hidden give (steal victim; expansion "take a card" effects) | One-hot transfer proof (§5)                                                            |

- The engine already knows when bounds prove a loss is affordable (`min[r] ≥ k`). Only then is the range proof skipped. In a game with no hidden transfers, bounds are always exact and no range proofs are sent.
- Range proofs: bit decomposition with `κ = 6` bits (per-type counts never exceed 24, even with 5–6 player bank sizes). The owner commits to each bit and proves each commits to 0 or 1 (a Cramer–Damgård–Schoenmakers OR proof); the verifier checks that the weighted bit commitments sum to the target. About 1 KB per range proof. Bulletproofs are unnecessary at this size.
- Because the value is capped at `2^κ − 1`, an overspend (which would wrap around mod `ℓ`) can't pass.
- All completed proofs are non-interactive, using Fiat–Shamir with SHA-256 and distinct proof domains. They bind the full certified context described above. Peer-supplied range widths and vector lengths cannot control verifier work; the validated module and operation determine them.

## 5. Hidden transfers: robber steal

1. The engine pending `stealIndex { thief, victim, handSize }` → beacon round → `idx = uniformInt(R, "steal", handSize)`.
2. The victim takes its hand as a **canonically sorted card list** (resource order, then commodities, etc.) and picks the card at `idx`. Its type is `r*`. For each type `r`, the prefix `p_r` is the number of cards sorted before type `r`. The public commitment to `p_r` is `P_r = Σ_{r' < r} C_{r'}`, which every peer can compute.
3. The victim publishes a `SYS_CONTRIB { round: "steal:<seq>" }` with:
   - **the transfer** `T_r = e_r·G + t_r·H` for every type `r`, where `e` is one-hot at `r*` and the blindings `t_r` are fresh (HKDF from master),
   - **a one-hot proof**: an OR proof that each `T_r` commits to 0 or 1, plus a Schnorr proof that `Σ T_r − G` commits to 0,
   - **an index proof**: a CDS OR over the types `r` of the statement "`T` is one-hot at `r` **and** `idx − p_r ∈ [0, 2^κ)` **and** `p_r + n_r − 1 − idx ∈ [0, 2^κ)`". The range statements are on commitments every peer derives from `P_r`, `C_r` and the public `idx`. The victim proves the true branch and simulates the others, so the proof doesn't reveal `r*`. It shows that the card moved is exactly the one at the beacon-chosen index, and that the victim actually held it,
   - **a sealed opening** for the thief: `(r*, t_1 … t_m)` encrypted to the thief's key `E_thief` (ephemeral ristretto ECDH, key and keystream from HKDF, domain `cp2p/seal`). Integrity comes from the thief checking the opening against `T`, so no AEAD is needed.
4. Every peer verifies both public proofs, then certifies an engine-state-preserving `STEAL_FIXED` entry containing the signed contribution. This fixes the beacon index, `T`, ciphertext and key versions even if the victim sent conflicting network messages. No resources move yet.
5. The thief provisionally decrypts and checks that `(r*, t)` opens that exact `T`. It signs a receipt bound to the operation, fixed entry, contribution and ciphertext hashes. A receipt must not depend on the final result entry's hash. Only the public proofs plus a matching receipt permit certification of `STEAL_RESULT { thief, victim, resource: 'hidden' }`. At that point commitments and engine hands change, and both owners apply their private effects.
6. **Bad delivery**: before the result commits, the thief can publish its ECDH shared point `K` with a DLEQ tying it to the certified ephemeral point and recipient key. Everyone decrypts and checks the opening. An authenticated bad opening is victim evidence and blocks the result. An invalid DLEQ, or a valid DLEQ revealing a good opening, is not a valid complaint. The dispute reveals the stolen type publicly. A refusing recipient stalls the fixed operation; recovery must continue it without choosing another index or transfer. A dishonest recipient can knowingly acknowledge unusable bytes, harming its own private state; public transfer proofs do not prove ciphertext correctness. A private-state failure after commitment halts that client and never rolls back certified history.

For the index proof, derive `L_r = idx·G − P_r` and `U_r = P_r + C_r − (idx+1)·G`. A branch proves an opening of `T_r − G` to `H` and two bit-decomposed ranges. The opening and both ranges share the branch challenge; every bit OR splits that same challenge. Simulate false branches and make all branch challenges sum to one Fiat–Shamir challenge over the full statement and first messages. Do not nest independent Fiat–Shamir range proofs under an outer OR. The separate bit and sum proofs establish that the same `T` is one-hot. Bind both proofs to the identical commitments, index, context and sealed payload hash. Six bits suffice because each true-branch distance is at most `n_r−1`, even when the prefix or total exceeds 63.

The same pattern is used for any "look at hand / take specific cards" effect in expansions (e.g. Master Merchant, Wedding, Spy): the victim seals the relevant openings (or card identities, for deck cards) to the actor, and every hidden move comes with a one-hot transfer proof.

## 6. Handling a detected cheat

Proof verification runs in the protocol layer as part of validating an entry (stage 06), before the engine sees the input and before the peer votes.

- **Bad proof in a seat's own signed input or contribution**: the input is dropped and never applied, so the game state stays honest. The signed message is self-contained evidence. Any peer broadcasts `CHEAT_PROOF { seat, kind, evidence }`, and the sequencer logs it as a `system` entry after every peer has verified it. The UI immediately shows "Blue sent an invalid <kind> proof" and marks the seat in the game history. The seat still owes a valid input. If it doesn't provide one within the normal timeout, stage 10's takeover rules apply.
- **Bad proof accepted by the sequencer**: the sequencer signed an invalid entry, which is stage 06 misbehaviour evidence (`ACCUSE` and re-election), in addition to the `CHEAT_PROOF` against the seat.
- A seat with a logged `CHEAT_PROOF` gets its result marked "cheating detected" in the local history, whatever happens later in the game. Remaining humans can also vote to end the game early.
- The UI shows a running fairness indicator ("All 214 moves verified") instead of waiting for a verdict at the end.

## 7. Key escrow (Feldman-verified Shamir)

- Games starting with two or three humans do not distribute escrow shares. Strict agreement requires every voter in those games, so absent-seat takeover is unavailable; a two-human threshold of one would expose the whole hand to the opponent from genesis.
- Games starting with at least four humans split each `masterSecret` with Shamir over the ristretto255 scalar field, threshold `t = (number of other original human seats)`. Recovery requires all those shares, or their authorized recovered equivalents. This threshold can be stricter than the ordering quorum, so a withholding holder can still stall recovery.
- **Verifiable at distribution** (Feldman VSS): the dealer publishes exactly `t` coefficient commitments `F_k = c_k·G` for `k = 0 … t−1`, with `F_0 = masterPub`. Each share is sealed to its recipient (as in §5). The verifier requires the expected threshold, master public key and recipient index from the ceremony. The recipient checks these parameters and `share·G == Σ_k j^k·F_k`, then ACKs with a signature over `H(share)`. Genesis retains the sealed ciphertexts, Feldman commitments and share hashes. A previously departed holder's recovered encryption key can open its shares during a later authorized takeover.
- A bad share is detected in the ceremony. The recipient publishes the dealer-signed sealed share and its ECDH proof, the ceremony aborts, and it restarts with fresh secrets. Revealing the share is harmless because the game never started.
- Feldman guarantees that recovery produces the secret behind `masterPub`. It can't prove that the seat derived its beacon chain and deck keys from that secret, because HKDF can't be proven cheaply. So on recovery the reconstructed secret must also reproduce the seat's published beacon tip, lock public keys and encryption key. A mismatch is a violation by the departed seat. The game can't continue fairly without those keys, so it ends, is marked void, and the seat is flagged. This is the one check that can't run per move; it only matters when that seat has left.
- Honest holders release shares only after verifying stage 10's recovery-authorization certificate from the old voter set. The authorization freezes the departed seat and names its bot host and keys. A second committed entry verifies recovery before activating the bot. Neither timeout nor a local online list authorizes disclosure.
- Recovery permanently exposes the departed seat's hand to recoverers and weakens the collusion threshold for other seats by exposing its keys. Share withholding can leave one recoverer informed while others wait. A returning human does not regain secrecy. Disclose these limits before the lobby enables takeover.

## 8. End-of-game reveal

Every hidden action was already verified when it happened, so this step doesn't decide whether the game was fair. It exists for the replay and as a safety net.

1. When `result` is set, every seat broadcasts its `masterSecret` (`SYS_CONTRIB { round: 'reveal' }`). Escrow-recovered secrets are used for absent seats.
2. Every peer checks each secret against `masterPub`, beacon tip, lock public keys and encryption key. This is the per-seat escrow-consistency check from §7, run for the seats that stayed.
3. Every peer runs `audit(log, masterSecrets)` in a worker: it replays the full game in **omniscient mode** (`LocalGame`), with every hidden value reconstructed (dealt cards from the deck transcript, stolen cards from the sealed openings), and checks the private-hand invariants. This re-check should always pass. A violation it finds that the per-move checks missed is a bug in a verifier, so the audit report is filed as a diagnostic as well as shown.
4. The result records completeness, missing secrets and `AuditReport { ok: boolean, violations: { seat, seq, kind, detail }[] }`, combined with any `CHEAT_PROOF` entries from the game. `ok` is true only for a complete successful audit. Withheld secrets without available authorized recovery leave the audit incomplete. The reveal/audit coordinator continues after the engine result is set.
5. The reveal also enables the **full replay with all cards visible** after the game (stage 17).

## 9. Bots and secrets

- A bot seat's master secret is generated by its host and follows the same escrow eligibility as humans. Recovery after host departure requires the same certified authorization and share threshold.
- Bot masters are independent. Share holders are the other original human devices, excluding the bot host, and recovery needs all of them. Additional bot seats do not add holders. Multiple absent holders can prevent recovery even when ordering still has a quorum; pause in that case. Recovery authorization freezes and removes the old controller before disclosure, and a second certificate activates the recovered controller with fresh voting keys.
- The bot's hand is known to its host's device, and after takeover to its recoverers. The host's UI must not display it; this is an honest-client guarantee only. Disclose in the lobby: "Bots are hosted by <name>" and disclose the additional exposure for recovered seats.
- Bot inputs carry the same proofs as human inputs.

## 10. Local mode compatibility

`LocalRandomSource` stays for hotseat/offline games: it answers pendings directly with plain values (`STEAL_RESULT.resource` known, `CARD_DEALT.card` present). No commitments or proofs are produced. The engine code paths for `hidden` vs known values are both covered by tests already (stage 03).

## Steps

1. Crypto primitives: HKDF labels registry, hash chains, `uniformInt`, ristretto helpers, DLEQ prove/verify, Schnorr, CDS OR composition, bit-decomposition range proofs, the single-key shuffle proof, sealing (ECDH + HKDF keystream), Shamir over the scalar field with Feldman commitments. Known-answer tests for each. Property tests: Shamir any-t-of-n recovers, fewer fails; Feldman rejects a tampered share; DLEQ rejects wrong keys; range proofs reject every value outside `[0, 2^κ)`; the shuffle proof rejects a substituted or re-keyed position.
2. Beacon sub-protocol in protocol + evidence verification + derivation registry.
3. Deck protocol Phases A/B/C with shuffle and locking proofs + evidence verification. Performance tests: shuffle of 25 cards among 6 seats, including proving and verifying every pass, < 3 s total in a Chromium worker; the full draw round-trip on memnet with 50 ms links < 1 s.
4. Committed hands: commitment vectors as protocol state, public updates, range and count-reveal proofs as input evidence, and the "bounds already prove it" skip.
5. Steal protocol with one-hot and index proofs, sealed delivery and disputes. Performance test: proving and verifying a steal with 8 card types < 300 ms in Chromium.
6. Cheat handling: `CHEAT_PROOF` entries, sequencer accusation, UI flags and the fairness indicator.
7. Escrow distribution at genesis (with Feldman verification) and recovery flow (the recovery trigger is wired in stage 10; test it here directly).
8. End-of-game reveal, audit re-check + UI report.
9. Replace stubs in `P2PSession`. Re-run the entire stage-06 chaos suite with real crypto.
10. Cheater test suite: a "malicious client" test harness that can:
    - claim a different dealt card,
    - send a wrong steal card, or a sealed opening that doesn't match,
    - raise a false dispute,
    - lie in a monopoly reveal,
    - spend resources it doesn't have (within bounds),
    - duplicate, substitute or re-key points in a shuffle or locking pass,
    - send bad escrow shares, or escrow a secret that doesn't match its keys,
    - withhold a beacon reveal.

    Each must be rejected at the time listed in the table below, and never later.

| Cheat                                    | Caught                                                        |
| ---------------------------------------- | ------------------------------------------------------------- |
| Wrong beacon preimage                    | Immediately                                                   |
| Withheld reveal or proof                 | Stall; authorized recovery preserves outcome, otherwise pause |
| Duplicate points in shuffle              | Immediately                                                   |
| Substituted or re-keyed card in shuffle  | Immediately (shuffle proof / locking DLEQ)                    |
| Wrong partial unlock                     | Immediately (DLEQ)                                            |
| Claiming a card not held when playing    | Immediately (DLEQ)                                            |
| Giving the wrong card in a steal         | Immediately (index proof)                                     |
| Sealed steal opening doesn't match       | Recipient check and dispute before transfer commitment        |
| False dispute                            | Immediately (shared-point DLEQ and decrypted opening)         |
| Lying in count reveal                    | Immediately (Schnorr opening)                                 |
| Spending unowned resources within bounds | Immediately (range proof)                                     |
| Bad escrow share                         | In the genesis ceremony (Feldman)                             |
| Escrowed secret doesn't match used keys  | At recovery, or at the end-of-game reveal                     |

## Acceptance criteria

- [ ] P2P games over memnet with real crypto pass the stage-06 chaos suite (200 seeds per scenario in CI).
- [ ] Every row in the cheat table is covered by a passing test that checks the cheat is caught at the listed time.
- [ ] Every completed honest game has no `CHEAT_PROOF` entries and produces `AuditReport.ok === true` (1,000 simulated games).
- [ ] Dice outcomes from the beacon pass a chi-square test over 100k rounds.
- [ ] Escrow recovery works after a seat departs mid-game, and the recovered seat continues as a bot.
- [ ] Shuffle and steal proofs meet the performance targets in Steps 3 and 5.
