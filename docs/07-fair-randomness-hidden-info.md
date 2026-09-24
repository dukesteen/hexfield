# 07 — Fair Randomness & Hidden Information

## Goal

Replace the stub randomness from stage 06 with cryptographic protocols so that no peer (including the sequencer) can predict or bias random outcomes or see cards it shouldn't:

1. **Randomness beacon**: dice, starting seat, steal index, balanced-dice draws, and any public random choice.
2. **Deck protocol** (mental poker): hidden draws (dev cards; later progress cards, fog tiles, fish tokens…).
3. **Hidden transfers**: robber steals, with private delivery.
4. **Hand commitments + end-of-game audit**: everything the public bounds can't prove.
5. **Key escrow**: a permanently departed player's secrets can be recovered so the game can continue.

All code lives in `@cp2p/crypto` (primitives, pure and deterministic given inputs) and in `@cp2p/protocol` (orchestration/sub-protocols).

## Prerequisites

Stage 06 is complete.

## Threat model recap

Honest-but-possibly-cheating players who may run modified clients. We guarantee:

- **Unpredictability and unbiasability** of public randomness, provided at least one participant is honest.
- **Confidentiality** of hidden cards, unless _all_ other players collude (and via escrow recovery, which by definition needs all remaining players).
- **Detection**, not prevention, of lies about hidden hands: immediately where the bounds allow, and always at the audit.

Aborting (refusing to reveal) can't bias outcomes. It only stalls, which triggers timeout handling (stage 10).

## 1. Per-seat master secret

- At game creation, each seat generates a 32-byte `masterSecret` (CSPRNG). **Every** secret the seat uses in the game is derived from it with HKDF-SHA256 using distinct labels: beacon chain seed, deck keys, commitment salts, per-card lock keys.
- This makes escrow (§6) a single 32-byte secret, and makes the audit simple: reveal `masterSecret` and everyone can re-derive and check everything.
- Store it in the seat's private state (IndexedDB, stage 10).

## 2. Randomness beacon (hash chains)

### Setup (during the genesis ceremony, stage 09)

- Each seat derives a chain seed `x_L = HKDF(master, "beacon")` and computes `x_{i} = H(x_{i+1})` down to `x_0`, with `L = 4096` (enough for very long games; if a game ever exhausts it, run a "chain extension" round where each seat commits a fresh chain tip, signed and logged).
- Genesis contains each seat's tip `x_0`.

### Each beacon round k (k = 1, 2, …)

- Each **participating** seat reveals `x_k` via `SYS_CONTRIB { round: "beacon:k", data: x_k }`. Anyone verifies `H(x_k) == x_{k-1}` (the previously revealed value, or the tip).
- Output: `R_k = SHA-256("cp2p/beacon" ‖ gameId ‖ k ‖ x_k^{seat0} ‖ … ‖ x_k^{seatN})`, in seat order.
- Participating seats = all human seats **not** marked as abandoned (stage 10). Bot seats have **no** beacon chain and don't participate. One honest human participant is enough for unbiasability.
- Evidence for the `system` entry: the list of reveals. Every peer verifies each preimage and recomputes the output.

### Derivation of outcomes from `R_k`

- `uniformInt(R, label, n)`: HKDF-expand `R` with `label` to 8 bytes, then rejection-sample to avoid modulo bias (expand again with a counter if rejected).
- Dice 2d6: `d1 = uniformInt(R, "d1", 6) + 1`, `d2 = uniformInt(R, "d2", 6) + 1`.
- Starting seat, steal index, balanced dice: `uniformInt` with their own labels.
- The engine's `random` pending names the request type. Map each request to a derivation function in a `randomDerivations` registry that modules can extend.

### Security notes

- Each value was committed at genesis (a hash-chain link), so nobody can choose it after seeing others' values.
- A seat that has seen everyone else's reveal can compute the result before revealing. It can only refuse to reveal, which stalls. The stall policy: after `revealTimeout` (default 10 s online, or when a seat is offline), the seat is handled by stage 10's takeover rules. Once a seat is abandoned and its escrowed master secret recovered, the others can compute its chain values themselves. **The outcome is therefore still fixed.** This removes any abort-bias entirely: important property, test it.

## 3. Deck protocol (mental poker on ristretto255)

Use `@noble/curves` ristretto255 (prime-order group, no cofactor issues). Notation: `G` generator, scalars mod `ℓ`.

### Card encoding

- Each distinct card _identity_ (e.g. `knight#3`; every physical card gets a unique identity even if the types match) maps to a point `P_c = hashToRistretto("cp2p/card/" ‖ deckId ‖ identity)`.
- The mapping table is public, and decoding is a lookup.

### Phase A — Shuffle (at genesis ceremony, or whenever a deck is created/reshuffled)

1. The canonical deck list `[P_c1 … P_cm]` is public.
2. In seat order, each seat `i`:
   - picks a **shuffle key** `a_i` (HKDF from master, label `deck:<deckId>:shuffle`) and a permutation `π_i` (derived from master),
   - maps every point `X → a_i·X`, permutes by `π_i`, and publishes the resulting list (`SYS_CONTRIB`, logged).
   - Check: the output has exactly m **distinct** points (anyone can verify distinctness; this catches duplication cheats immediately).
3. **Locking pass**, in seat order: each seat `i` removes its shuffle key (`a_i^{-1}·X`) and applies a **per-position lock key** `b_{i,j}` (HKDF, label `deck:<deckId>:lock:<j>`) to position `j`. It publishes the list. Distinctness is checked again.
4. The final list is the encrypted deck `D[j] = (∏_i b_{i,j}) · P_{σ(j)}`. It's stored in the log.
5. Each seat also publishes, for each position, its **lock public key** `B_{i,j} = b_{i,j}·G`. (Used for the DLEQ proofs in Phase B; derive them all from master for compactness.)

### Phase B — Private draw of position j by seat d

1. Every seat `i ≠ d` removes its lock layer from `D[j]`, as a chain in seat order (skipping `d`). Starting from `Z_prev = D[j]`, each seat publishes `Z_i = b_{i,j}^{-1}·Z_prev` together with a **DLEQ proof** that `log_{Z_i}(Z_prev) == log_G(B_{i,j})`. That's Chaum–Pedersen, Fiat–Shamir with SHA-256 and domain `cp2p/dleq`. This proves the seat removed exactly its own lock layer. The layers commute (scalar multiplication), so the order doesn't matter, but a fixed seat order keeps the transcript canonical.
   - Latency: (players − 1) sequential hops. With ≤ 6 players and tiny messages this is fine (< 1 s). Pre-unlocking ahead of time isn't possible, because the drawer isn't known until the draw.
2. The last point `Z = b_{d,j}·P` is public. Only `d` can remove its layer: `P = b_{d,j}^{-1}·Z`, then look up the identity. **Only d learns the card.**
3. The public log records `CARD_DEALT { seat: d, deck, slotId, position: j }` with the unlock chain as evidence. The owner's private state records the identity.

### Phase C — Public reveal (playing the card)

The owner publishes `identity` plus a DLEQ proof that `Z == b_{d,j}·P_identity` relative to `B_{d,j}`. Everyone verifies before the engine accepts the `PLAY_DEV_CARD` command. (The protocol layer attaches the proof as command evidence. The engine only sees the verified identity.)

### Which position is drawn?

Positions are drawn in order `0, 1, 2…` (the deck is already jointly shuffled). No beacon is needed.

### Notes

- Using per-position lock keys prevents the linkage leak where a revealed card identifies other positions encrypted under the same key.
- An undetectable shuffle-substitution cheat is possible without a verifiable shuffle proof (a seat could apply different keys per position during the shuffle pass). It's detected at the audit, when all keys and permutations are re-derived from master secrets. We accept detection-at-audit. Record this in DECISIONS.md, with a note that a Bayer–Groth verifiable shuffle could be added later.

## 4. Hidden transfers: robber steal

1. The engine pending `stealIndex { thief, victim, handSize }` → beacon round → `idx = uniformInt(R, "steal", handSize)`.
2. The victim's client takes its hand as a **canonically sorted card list** (resource order, then commodities, etc.) and picks the card at `idx`. It sends `PRIVATE { to: thief, payload: { round, card, salt } }` directly, signed.
3. Public log: `STEAL_RESULT { thief, victim, resource: 'hidden', commitment: H(card ‖ salt) }` with the beacon evidence. The victim must also publish the commitment (in a `SYS_CONTRIB`), and the thief confirms it matches what they received. If the thief receives nothing or a mismatch within the timeout, they broadcast a signed `DISPUTE`. The victim's signed private message (or its absence) becomes evidence at the audit.
4. The engine applies `loseHidden` / `gainHidden`. Thief and victim each call `applyPrivate` with the card.

The same pattern is used for any "look at hand / take specific cards" effect in expansions (e.g. progress cards that take cards from a hand).

## 5. Hand commitments & the audit

### Hand commitment chain

- After every entry that changes a seat's private hand, the owner computes `C_n = H("hand" ‖ gameId ‖ seq ‖ canonical(hand) ‖ salt_n)`, with `salt_n = HKDF(master, "hand:" ‖ seq)`. It includes the latest `C_n` in its next ACK. (Cheap: the ACK already exists.)
- Peers store the commitments. These pin the owner's claimed hand at each step without revealing it.

### End-of-game audit (mandatory)

1. When `result` is set, every seat broadcasts its `masterSecret` (`SYS_CONTRIB { round: 'audit' }`). Escrow-recovered secrets are used for absent seats.
2. Every peer runs `audit(log, masterSecrets)`:
   - re-derives every beacon chain value and checks it against the reveals,
   - re-derives every shuffle key, permutation and lock key, and checks the whole deck-protocol transcript (Phase A outputs, Phase B chains),
   - re-plays the full game in **omniscient mode** (`LocalGame`), with every hidden value reconstructed:
     - dealt cards from the deck transcript,
     - stolen cards from the sorted hand plus the steal index,
     - the commitment preimages.
   - checks every hand commitment `C_n` against the reconstructed hands,
   - checks that every spend was affordable from the true hand, every monopoly/count reveal was truthful, and every private message matches its commitment.
3. The result is `AuditReport { ok: boolean, violations: { seat, seq, kind, detail }[] }`. The UI shows "Verified fair game ✓", or flags the cheating seat and marks the result invalid in the local history.
4. The audit also enables the **full replay with all cards visible** after the game (stage 17).

## 6. Key escrow (Shamir secret sharing)

- During the genesis ceremony, each human seat splits `masterSecret` with Shamir over GF(2^8) (byte-wise), threshold `t = (number of other human seats)`. In other words, _all_ remaining human players together can recover it. For 2 human players, t = 1 (the opponent alone can recover: an inherent limit, disclosed in the UI as "2-player games: your secrets are escrowed with your opponent").
- Shares are sent via `PRIVATE` to each other seat. Each recipient ACKs with a signature over `H(share)`, and the genesis includes the list of share hashes for each seat.
- **Verifiability**: on recovery, the reconstructed master secret must reproduce the seat's published beacon tip and lock public keys. If it doesn't, try other share combinations and identify the bad share by its hash. Bad shares are audit violations.
- Recovery is triggered only by the stage-10 "abandon seat" decision (unanimous among the remaining online humans, or timeout policy). After recovery, the abandoned seat's secrets are known to all remaining peers. The seat's hand becomes effectively public to them, and the seat is played by a bot hosted by the sequencer.

## 7. Bots and secrets

- A bot seat's master secret is generated by its host and escrowed like a human's. The host holds it; if the host leaves, the others recover it.
- The bot's hand is known to its host's device. The host's UI must not display it; this is an honest-client guarantee only. Disclose in the lobby: "Bots are hosted by <name>".

## 8. Local mode compatibility

`LocalRandomSource` stays for hotseat/offline games: it answers pendings directly with plain values (`STEAL_RESULT.resource` known, `CARD_DEALT.card` present). The engine code paths for `hidden` vs known values are both covered by tests already (stage 03).

## Steps

1. Crypto primitives: HKDF labels registry, hash chains, `uniformInt`, Shamir GF(256), ristretto helpers, DLEQ prove/verify. Known-answer tests for each. Property tests: Shamir any-t-of-n recovers, fewer fails; DLEQ rejects wrong keys.
2. Beacon sub-protocol in protocol + evidence verification + derivation registry.
3. Deck protocol Phases A/B/C + evidence verification. Performance test: shuffle of 25 cards among 6 seats < 200 ms total compute in Chromium; the full draw round-trip on memnet with 50 ms links < 1 s.
4. Steal protocol with private delivery and disputes.
5. Hand commitment chain in ACKs.
6. Audit engine + UI report.
7. Escrow distribution at genesis and recovery flow (the recovery trigger is wired in stage 10; test it here directly).
8. Replace stubs in `P2PSession`. Re-run the entire stage-06 chaos suite with real crypto.
9. Cheater test suite: a "malicious client" test harness that can:
   - claim a different dealt card,
   - send a wrong steal card,
   - lie in a monopoly reveal,
   - spend resources it doesn't have (within bounds),
   - duplicate or substitute points in a shuffle,
   - send bad escrow shares,
   - withhold a beacon reveal.

   Each must be rejected immediately or flagged by the audit, as listed in the table below.

| Cheat                                    | Caught                                     |
| ---------------------------------------- | ------------------------------------------ |
| Wrong beacon preimage                    | Immediately                                |
| Withheld reveal                          | Stall → takeover → recovered, same outcome |
| Duplicate points in shuffle              | Immediately                                |
| Substituted card via shuffle keys        | Audit                                      |
| Wrong partial unlock                     | Immediately (DLEQ)                         |
| Claiming a card not held when playing    | Immediately (DLEQ)                         |
| Lying about stolen card                  | Audit (+ dispute evidence)                 |
| Lying in count reveal                    | Immediately if outside bounds, else audit  |
| Spending unowned resources within bounds | Audit                                      |
| Bad escrow share                         | At recovery/audit                          |

## Acceptance criteria

- [ ] P2P games over memnet with real crypto pass the stage-06 chaos suite (200 seeds per scenario in CI).
- [ ] Every row in the cheat table is covered by a passing test.
- [ ] Every completed honest game produces `AuditReport.ok === true` (1,000 simulated games).
- [ ] Dice outcomes from the beacon pass a chi-square test over 100k rounds.
- [ ] Escrow recovery works after a seat departs mid-game, and the recovered seat continues as a bot.
