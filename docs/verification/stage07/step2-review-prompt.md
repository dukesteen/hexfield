# Stage 07 beacon integration review

Review the attached source and tests for concrete security and correctness defects.
This is read-only. Do not run tools, write code, open other files or use external
services. The user has authorized future Claude reviews of this project. This
packet contains project source, design and public test fixtures, with no actual
game secrets or credentials.

The accepted Stage 06 protocol provides certified history and durable two-phase
voting under at most one Byzantine human voter. Human counts 1–6 require quorum
1, 2, 3, 3, 4, 4. Bots do not vote. This packet adds Stage 07 Step 2, the hash-chain
beacon. Deck, resource commitment, steal transfer, recovery and browser persistence
are later work; do not infer full Stage 07 acceptance from these tests.

Review these boundaries in particular:

- Signed genesis commits ordered human chain tips. Replay freezes each engine
  random request with its certified anchor, membership epoch and participant
  positions. Later proposer controls preserve that request and anchor.
- Signed contributions bind the whole operation. Each reveal must be the next
  preimage. Outcome derivation uses canonical ordered values, excluding signature
  bytes, with separate labels and unbiased integer sampling.
- Public randomness is verified inside log validation, before engine application.
  A generic proof callback cannot approve a different dice or starting-seat result.
  Engine stateHash excludes protocol metadata; certified entry hashes and the
  replay-derived voting context bind CryptoContext instead.
- Exhausted chains require a certified extension before any next-round reveal.
  An index fixed for a hidden steal consumes one beacon round in a state-preserving
  entry. The subsequent private transfer protocol is deliberately not implemented
  yet, so that pending operation currently stalls.
- A durable immutable local outbox writes a signed contribution before sending it.
  Restarts reuse it; corruption fails closed; competing inserts use the persisted
  winner. The secret provider supplies only this human's links and must retain
  its chain secrets. The memory store is a test adapter, not browser persistence.
- The delivery inbox holds at most one verified contribution per expected seat
  for the current operation. Stale/future messages cannot replace it. Duplicates
  do not trigger another consensus write. Periodic retransmission survives a
  temporary send failure.
- Private application receives full certified evidence, including entries without
  engine inputs, and receives detached data during live operation and replay.
  Custom random derivation callbacks cannot mutate certified input state.

The network tests use real signed beacon tips and reveals. They explicitly stand
in for later deck/escrow genesis checks. Public setup/roll commands have no hidden
resource proof. The log tests include actual certificates, control insertion and
extension replay. The direct fixed-steal validator test uses a trusted synthetic
parent after creating a real engine steal request; it is not a complete crypto game.

Report confirmed issues with an attack or failure trace and affected functions.
Distinguish a missing later-stage feature from a flaw in this implemented slice.
Check tests for assertions that would pass with the claimed guard removed. Do not
write replacement implementation code. State any important review limitation.
