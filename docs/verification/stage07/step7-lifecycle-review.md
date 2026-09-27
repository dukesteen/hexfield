# Escrow lifecycle review: approval, reservation, retirement and disclosure

These findings come from reading the supplied source only. I did not execute anything.

## Verdict

The prior fixes hold against source, and so do the new regressions you asked about:

- **N1:** the dispute DLEQ seed is now derived privately from `scalarToBytes(x)` and the complete envelope binding, and it is cleared afterwards. No caller-supplied seed remains.
- **N3:** `verifyEscrowShareDispute` parses a detached genesis once. It reads the holder and `ceremonyId` from that copy and returns a typed `bad-share` or `false-complaint` verdict only after the holder signature, envelope and DLEQ checks pass. The inherited-`find` test discriminates, because a raw `genesis.seats.find` would throw into the catch-all.
- **Reduced-degree test:** it now builds `[M, 12G, 𝟙]` with a matching degree-1 share, a fresh seal and proof over the deficient binding, and a new signature. Removing the `nonIdentity` loop would let the fresh proof verify and the test would fail. It discriminates.
- **Padding-bit test:** `last ^ 1` always flips one of the two padding bits of the 43rd character. Both the codec throw and the manifest rejection are exercised.
- **Signature before disclosure, copied point plus proof, root decode boundary:** all hold as described.

For the lifecycle itself:

- CAS reservation and the abort-versus-reservation race are correct for a single device-global blob.
- Retirement is idempotent.
- Malformed IDs are rejected before any read or write.
- Both reserve and retire validate schema and size before writing.

There are four defects in the new wrapper. The first undermines the property C1 was meant to establish.

## L1. Dealing authenticates the supplied manifest, not the local pin (medium–high)

**Where:** `prepareEscrowDistribution` calls `verifyEscrowManifestApprovals(checked.value, …)`, which requires approvals from the humans listed in the supplied genesis. It never compares that genesis to the local frozen manifest. The dealer check is `dealer?.publicKey === identity.peerId`, which ignores `kind`.

**Trace (human victim D, seat 0, master M):**

1. The attacker builds a five-seat manifest Y:
   - seat 0 is `{kind:'bot', publicKey: D.peerId, botHost: A1, masterPub: M·G}`;
   - seats 1 to 4 are attacker humans A1 to A4 with attacker encryption keys.
2. D is no longer a human in Y, so D's approval is not required. A1 to A4 sign their own approvals, and `verifyEscrowManifestApprovals` passes.
3. The master and dealer-key checks pass, because the retained master and D's key really match seat 0.
4. The roster excludes the host A1. The holders are A2 to A4 and the threshold is 3.
5. All three shares are sealed to attacker keys. The attacker interpolates M.

A real bot dealer is simpler to attack: just substitute an attacker human as `botHost`.

**Mitigation today:** the reservation limits the damage. If Y reserves M first, the real ceremony X can never deal M, so X stalls and must abort. But during that window the attacker can derive D's X-attempt encryption key and deck and beacon secrets, and decrypt every share other dealers seal to D. Only the caller's discipline stops this; the API does not.

**Minimal fix:** add a `localFrozenManifest` input to `prepareEscrowDistribution`. Require `deckCeremonyId(local) === deckCeremonyId(candidate)` before generating anything, as `prepareEscrowManifestApproval` already does. `deckCeremonyId` covers seats (kind, botHost, encryption keys) and masters, so this single equality closes both variants.

**Regression:** the relabelled five-seat Y above with valid attacker approvals.

- Before the fix, it returns three envelopes, and attacker-opened shares give `recoverSecret(…) === 71n`.
- After the fix, it returns `escrow-manifest-conflict` and no registry write occurs.
- Add the bot-host substitution case as well.

## L2. Registry sizing: permanent growth, and a full registry blocks abort (medium)

**Growth:**

- Every reservation keeps full base64 envelopes forever. That includes retired reservations and completed games, and there is no completion transition.
- An estimate of the canonical envelope: body about 1.45 KB, stored as roughly 1.95 KB of base64.
- A six-human dealer therefore costs about 10 KB per reservation and a four-human dealer about 6 KB.
- 16 MiB holds roughly 1,600 to 2,900 dealt masters over the device's lifetime. Hosted bots and every aborted retry each add one.
- Separately, the schema caps `retiredCeremonies` at 50,000.

**Cliff:** reservation and retirement share the same limits. At the limit:

- `retireCeremonyAttempt` fails with `escrow-registry-size` or `escrow-registry-record`;
- `verifyAndRetireEscrowShareDispute` then never returns a verdict;
- so an authenticated disclosure can never be published, and every later ceremony on the device stalls.

**Cost:** every operation decodes, re-encodes and compares the whole blob (about four full passes over up to 16 MiB), with up to 64 CAS retries. This runs synchronously in the protocol worker, which the stage document says must not starve voting or heartbeat processing.

**Minimal fix:**

1. When retiring, set `envelopes: []` on the retired reservations. They can never be returned again, because `validateReservationWinner` rejects any status other than `active` first.
2. Reserve only if the encoded result leaves a fixed headroom, for example 64 KiB and at least 1,000 free tombstone slots. Retirement may use the full limit. Abort can then always commit.
3. Add a `completeEscrowCeremony` transition after certification that drops envelopes. It has no caller yet.

**Longer term:** use one record per master and per ceremony in a multi-key IndexedDB transaction instead of one whole blob.

**Regressions:**

- With a registry near the headroom, reserve is refused with `escrow-registry-size`, and retiring that ceremony still succeeds.
- A retired reservation's persisted `envelopes` is empty.

## L3. Retirement tombstones any ceremony a caller names (low–medium, integration-dependent)

`retireEscrowCeremony` accepts any key32. `verifyAndRetireEscrowShareDispute` retires whatever genesis it is handed, and an attacker can make a valid dispute for a manifest they control entirely. A peer that can get the coordinator to verify such a dispute can:

- add one tombstone per call until the 50,000 cap is reached, which by L2 disables abort; and
- force a full registry rewrite on each call.

**Fix:** have both entry points take `localFrozenManifest`, and reject when its `ceremonyId` differs before verifying or writing anything.

## L4. Retirement is keyed by ceremony, so unreserved local masters stay reservable (low)

The requirement is that abort "atomically retires every local dealing master". A master that appears in the aborted manifest but has not been reserved yet only gets the ceremony tombstone. It can still be reserved for a new ceremony with a different ID.

The stage document already forbids reusing a master, but nothing here enforces that, and the local pin is built from app state.

**Fix:** once retirement takes the manifest (L3), in the same CAS insert `{status:'retired', envelopes: []}` for every master in the manifest that has no reservation. Masters that already belong to another ceremony stay untouched.

**Regression:**

1. Retire X before any reservation.
2. Build Y with the same master and a new nonce.
3. `prepareEscrowDistribution(Y)` must fail with `escrow-master-reserved`.

## L5. Nothing downstream reads the tombstone (integration gate, required before online dealing)

The registry is consulted only by `prepareEscrowDistribution`. Nothing else checks it:

- `acceptEscrowShare` and ACK signing;
- `signVerifiedGenesis` (it is pure);
- `prepareGenesisConsent` (`genesis-outbox.ts` was not supplied).

**Trace:**

1. A dealer wins the reservation and returns its envelopes.
2. A false complaint is verified and the ceremony is retired.
3. The complainer ACKs anyway, other holders ACK, and humans consent.
4. Genesis is certified with one share already public.

**Stale restore:** there is a related window in `reserveOrRestore`. The restore branch reads an active reservation and returns its envelopes with no write. It can therefore return after a tombstone commits. The "unusable afterward" guarantee holds only as of that read.

**Fix:** add an internal `isEscrowCeremonyRetired(ceremonyId, store)`. Require that it returns false at three points: in the genesis-consent outbox, in the holder ACK outbox, and at send time in the delivery layer.

## Weak or missing regressions

- **N1 private seed:**
  - The determinism and separation test would also pass if the seed came from public context alone.
  - Add a known-answer test: recompute the proof with `deriveBytes(scalarToBytes(x), proofRandomness, {...binding, sharedPoint, role:'escrow-dispute'})` and assert it is equal.
  - Also assert it differs from the proof produced with a seed derived from public context only.
- **Competing reservations:** also assert that the loser's code is `escrow-master-reserved` and that the registry holds exactly one reservation.
- **Retire failures:** add a store whose CAS throws during retirement. `verifyAndRetireEscrowShareDispute` must then return failure and no verdict. Also cover retirement on a `bad-share` verdict, not only on `false-complaint`.
- **Retained bytes:**
  - Tampered retained envelopes should fail with `escrow-reservation-conflict`.
  - Non-canonical registry bytes should fail closed with no write.
- **Still missing from the earlier reviews:**
  - a non-empty escrow list with fewer than four humans is rejected (the code rejects it; there is no test);
  - `validateGenesis` rejects one corrupted ACK inside an otherwise complete transcript;
  - a genesis with at least four humans plus a bot, carrying escrow and decks, is accepted end-to-end.

## Minor points

- **`MemoryEscrowLifecycleStore` location:** it lives in a production module. Move it to `testing/` so it cannot be wired up by accident. `index.ts` correctly exports none of the `escrow-*` modules.
- **Retired ceremonies still cost full generation:** `prepareEscrowDistribution` does all Feldman, seal and signature work before it checks the tombstone. Check the tombstone first.
- **Corrupt registry has no recovery path:** a corrupt registry permanently fails every reservation and retirement. Failing closed is correct, but it needs a documented operator path.
- **Disputes after genesis:** a `false-complaint` verdict can be produced at any time, including after genesis. The integration must only admit disputes before certification.
- **Reservation is device-local:** masters must not be synced or exported before certification, or a second device could reserve the same master for another ceremony.

## Future integration, not defects in this slice

These are unchanged from your stated scope: network delivery with private-share persistence before ACK, complaint publication, the browser-backed lifecycle store (a cross-tab IndexedDB read-write transaction implementing CAS), authorized release, replacement and activation, beacon-extension checks (C3), private-hand reconstruction (C4), typed recovery failure classification (C5), re-verification of released shares (C6), and the full audit.

<invoke name="Write">
<parameter name="file_path">/Users/duke/.claude/plans/escrow-lifecycle-and-splendid-hamster.md</parameter>
<parameter name="content"># Escrow lifecycle fixes (L1–L5)

## Context

The read-only review of `packages/protocol/src/escrow-lifecycle.ts` confirmed the N1/N3 dispute fixes and the new discriminating tests. It found four defects in the lifecycle wrapper and one integration gate:

- L1: dealing trusts the supplied manifest's human list rather than the local pin, so relabelling the dealer's seat as a bot bypasses unanimous approval.
- L2: the registry grows permanently, and a full registry blocks abort.
- L3: retirement accepts any ceremony.
- L4: unreserved local masters survive abort.
- L5: nothing downstream reads the tombstone.

## Changes (all in `packages/protocol/src/escrow-lifecycle.ts` unless noted)

1. **L1:** add `localFrozenManifest: GenesisBody` to `prepareEscrowDistribution`.
   - Run `checkedManifest` on it.
   - Require `deckCeremonyId(local) === deckCeremonyId(candidate)`, failing with `escrow-manifest-conflict` before key derivation or generation. Reuse the pattern already in `prepareEscrowManifestApproval`.
2. **L3 + L4:** change `retireEscrowCeremony(ceremonyId, store)` to `retireEscrowCeremony(localFrozenManifest, store)`.
   - Derive `ceremonyId` from the manifest.
   - In the same CAS, insert `{status:'retired', envelopes: []}` for every manifest `masterPub` that has no reservation.
   - `verifyAndRetireEscrowShareDispute` takes `localFrozenManifest` and rejects a genesis whose `ceremonyId` differs, before verifying the dispute.
3. **L2:**
   - Retirement sets `envelopes: []` on retired reservations.
   - Reservation requires the encoded registry to stay at or below `MAX_REGISTRY_BYTES − RETIREMENT_HEADROOM` (64 KiB), and the tombstone count to stay at or below 49,000. Retirement may use the full limits.
   - Add `completeEscrowCeremony(localFrozenManifest, store)`, which drops envelopes after certification. It has no caller yet.
   - Check the tombstone before `createEscrowShareEnvelopes` so retired ceremonies skip crypto work.
4. **L5:** add an internal `isEscrowCeremonyRetired(ceremonyId, store)`. Document that the genesis-consent outbox, the holder ACK outbox and send-time delivery must require it to be false. Wiring it in is integration work (`genesis-outbox.ts`).
5. Move `MemoryEscrowLifecycleStore` to `packages/protocol/src/testing/`.

## Tests (`escrow-lifecycle.test.ts`, `escrow-dispute.test.ts`)

- **L1:**
  - A five-seat manifest in which seat 0 is D's key relabelled as a bot hosted by attacker human A1, and seats 1 to 4 are attacker humans with valid attacker approvals. Expect `escrow-manifest-conflict` and no registry write.
  - A bot dealer whose host is substituted.
- **L4:** retire X before any reservation, then build Y with the same master and a new nonce. Expect `escrow-master-reserved`.
- **L3:** `verifyAndRetireEscrowShareDispute` with a valid dispute over a non-local genesis. Expect failure and an unchanged registry.
- **L2:**
  - A registry near the headroom: reserve fails with `escrow-registry-size`, and retiring that ceremony succeeds.
  - Retired reservations persist with an empty `envelopes`.
- **Retirement failures:**
  - A store whose CAS throws during retirement: `verifyAndRetire` returns failure and no verdict.
  - Retirement on a `bad-share` verdict.
- **Retained bytes:**
  - Tampered retained envelopes: `escrow-reservation-conflict`.
  - Non-canonical registry bytes: fail closed with no write.
- **Competing reservations:** assert the loser's code is `escrow-master-reserved` and the registry holds exactly one reservation.
- **N1 known-answer test:** the proof equals one recomputed with `deriveBytes(scalarToBytes(x), proofRandomness, {...binding, sharedPoint, role:'escrow-dispute'})`, and differs from one built on a seed derived from public context only.
- **Still-missing aggregate tests (`genesis-escrow.test.ts`):**
  - a non-empty escrow list with fewer than four humans is rejected;
  - `validateGenesis` rejects one corrupted ACK in an otherwise complete transcript;
  - a genesis with at least four humans plus a bot, carrying escrow and decks, is accepted end-to-end.

## Verification

- Run `pnpm --filter @cp2p/protocol test` and `pnpm --filter @cp2p/protocol typecheck`.
- Confirm that each L1 and L4 regression fails on the current source before the fix and passes after it.
- Confirm that `index.ts` still exports no `escrow-*` symbols.
</parameter>

</invoke>
<invoke name="ExitPlanMode">
</invoke>
