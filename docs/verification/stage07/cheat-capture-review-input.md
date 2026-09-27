# Pinned cheat-capture source excerpts

Each excerpt names its original line range. Source hashes are in the manifest. No runtime identities, saves or secrets are included.

## packages/protocol/src/cheat-capture.ts

```ts
// lines 1-231
import type { Seat } from '@cp2p/engine';
import * as v from 'valibot';
import type { CheatClaim, CheatKind, RawSignedArtifact } from './cheat-types.js';
import { entryHash, genesisDigest } from './genesis.js';
import type { LogContext } from './log-types.js';
import {
  hashSchema,
  key32Schema,
  positiveIntegerSchema,
  seatSchema,
  signature64Schema,
} from './schema-values.js';
import { parseCanonical } from './validation.js';
import { decodeMessage } from './wire.js';

const signed = v.strictObject({ body: v.unknown(), sig: signature64Schema });
const signedList = v.pipe(v.array(signed), v.maxLength(6));
const unlocks = v.pipe(v.array(signed), v.minLength(1), v.maxLength(5));
const payloadSchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('command'), signed }),
  v.strictObject({
    kind: v.literal('crypto'),
    action: v.picklist(['beacon-fixed', 'deck-pass', 'steal-fixed', 'steal-dispute']),
    evidence: v.unknown(),
  }),
  v.strictObject({
    kind: v.literal('system'),
    input: v.unknown(),
    evidence: v.variant('protocol', [
      v.strictObject({
        kind: v.literal('proof'),
        protocol: v.literal('beacon-v1'),
        data: signedList,
      }),
      v.strictObject({
        kind: v.literal('proof'),
        protocol: v.literal('deck-draw-v1'),
        data: unlocks,
      }),
      v.strictObject({
        kind: v.literal('proof'),
        protocol: v.literal('monopoly-count-v1'),
        data: signed,
      }),
    ]),
  }),
]);

// This only extracts signed artifacts. It never admits a malformed wire message
// for gameplay, nor turns a rejected envelope into a finding by itself.
const rejectedMessageSchema = v.variant('t', [
  v.strictObject({ t: v.literal('SUBMIT'), cmd: signed }),
  v.strictObject({
    t: v.literal('SYS_CONTRIB'),
    genesisDigest: key32Schema,
    contribution: v.strictObject({ kind: v.literal('beacon-reveal'), signed }),
  }),
  v.strictObject({
    t: v.literal('DECK_CONTRIB'),
    genesisDigest: key32Schema,
    contribution: v.strictObject({
      kind: v.literal('deck-unlock'),
      operationId: hashSchema,
      unlocks,
    }),
  }),
  v.strictObject({
    t: v.literal('COUNT_CONTRIB'),
    genesisDigest: key32Schema,
    contribution: signed,
  }),
  v.strictObject({
    t: v.literal('STEAL_CONTRIB'),
    genesisDigest: key32Schema,
    contribution: signed,
  }),
  v.strictObject({
    t: v.literal('STEAL_RESPONSE'),
    genesisDigest: key32Schema,
    response: v.strictObject({ kind: v.literal('dispute'), value: signed }),
  }),
  v.strictObject({ t: v.literal('PROPOSAL'), proposal: signed }),
]);

function artifactSeat(artifact: RawSignedArtifact): Seat | null {
  const body = parseCanonical(artifact.body, v.objectWithRest({ seat: seatSchema }, v.unknown()));
  return body.ok ? body.value.seat : null;
}

function candidate(
  kind: Exclude<CheatKind, 'deck-unlock'>,
  artifact: RawSignedArtifact,
  context: LogContext,
  seat = artifactSeat(artifact),
): CheatClaim[] {
  return seat === null
    ? []
    : [
        {
          seat,
          evidence: {
            kind,
            artifact,
            at: { seq: context.head.seq, hash: entryHash(context.head) },
          },
        },
      ];
}

function unlockCandidates(items: RawSignedArtifact[], context: LogContext): CheatClaim[] {
  return items.flatMap((artifact, index) => {
    const seat = artifactSeat(artifact);
    return seat === null
      ? []
      : [
          {
            seat,
            evidence: {
              kind: 'deck-unlock' as const,
              artifact,
              prefix: items.slice(0, index),
              at: { seq: context.head.seq, hash: entryHash(context.head) },
            },
          },
        ];
  });
}

function payloadCandidates(value: unknown, context: LogContext): CheatClaim[] {
  const parsed = parseCanonical(value, payloadSchema);
  if (!parsed.ok) return [];
  const payload = parsed.value;
  if (payload.kind === 'command') return candidate('command-proof', payload.signed, context);
  if (payload.kind === 'system') {
    const evidence = payload.evidence;
    switch (evidence.protocol) {
      case 'beacon-v1':
        return evidence.data.flatMap((item) => candidate('beacon-reveal', item, context));
      case 'deck-draw-v1':
        return unlockCandidates(evidence.data, context);
      case 'monopoly-count-v1':
        return candidate('count-proof', evidence.data, context);
    }
  }
  if (payload.action === 'beacon-fixed') {
    const items = parseCanonical(payload.evidence, signedList);
    return items.ok ? items.value.flatMap((item) => candidate('beacon-reveal', item, context)) : [];
  }
  const artifact = parseCanonical(payload.evidence, signed);
  if (!artifact.ok) return [];
  switch (payload.action) {
    case 'deck-pass':
      return candidate('deck-pass', artifact.value, context);
    case 'steal-fixed':
      return candidate('steal-contribution', artifact.value, context);
    case 'steal-dispute':
      return candidate(
        'false-steal-dispute',
        artifact.value,
        context,
        context.crypto?.steal?.operation.thief.seat ?? null,
      );
  }
  return [];
}

/** Bounded, detached candidates only; every result still requires verifyCheatProof. */
export function rejectedProofCandidates(value: unknown, context: LogContext): CheatClaim[] {
  if (context.genesis.security !== 'verified' || !context.crypto) return [];
  const parsed = parseCanonical(value, rejectedMessageSchema);
  if (!parsed.ok) return [];
  const message = parsed.value;
  if ('genesisDigest' in message && message.genesisDigest !== genesisDigest(context.genesis))
    return [];
  switch (message.t) {
    case 'SUBMIT':
      return candidate('command-proof', message.cmd, context);
    case 'SYS_CONTRIB':
      return candidate('beacon-reveal', message.contribution.signed, context);
    case 'DECK_CONTRIB':
      return unlockCandidates(message.contribution.unlocks, context);
    case 'COUNT_CONTRIB':
      return candidate('count-proof', message.contribution, context);
    case 'STEAL_CONTRIB':
      return candidate('steal-contribution', message.contribution, context);
    case 'STEAL_RESPONSE':
      return candidate(
        'false-steal-dispute',
        message.response.value,
        context,
        context.crypto.steal?.operation.thief.seat ?? null,
      );
    case 'PROPOSAL': {
      const body = parseCanonical(
        message.proposal.body,
        v.objectWithRest(
          {
            genesisDigest: key32Schema,
            entry: v.objectWithRest(
              { seq: positiveIntegerSchema, prevHash: hashSchema, payload: v.unknown() },
              v.unknown(),
            ),
          },
          v.unknown(),
        ),
      );
      return body.ok &&
        body.value.genesisDigest === genesisDigest(context.genesis) &&
        body.value.entry.seq === context.head.seq + 1 &&
        body.value.entry.prevHash === entryHash(context.head)
        ? payloadCandidates(body.value.entry.payload, context)
        : [];
    }
  }
  return [];
}

/** Preserve malformed inner proofs without relaxing the normal wire decoder. */
export function rejectedWireProofCandidates(bytes: Uint8Array, context: LogContext): CheatClaim[] {
  const decoded = decodeMessage(bytes, rejectedMessageSchema);
  return decoded.ok ? rejectedProofCandidates(decoded.value, context) : [];
}

/** A valid delivery dispute attributes the victim only after it is certified. */
export function certifiedDeliveryClaim(context: LogContext): CheatClaim | null {
  const steal = context.crypto?.steal;
  return steal?.dispute
    ? (candidate('bad-steal-delivery', steal.dispute, context, steal.operation.victim.seat)[0] ??
        null)
    : null;
}
```

## replicated-log.ts capture diff

```diff
diff --git a/packages/protocol/src/replicated-log.ts b/packages/protocol/src/replicated-log.ts
index 8e3d149..6325736 100644
--- a/packages/protocol/src/replicated-log.ts
+++ b/packages/protocol/src/replicated-log.ts
@@ -110,2 +110,3 @@ import {
 import type { CheatCandidateStore } from './cheat-candidates.js';
+import { certifiedDeliveryClaim, rejectedWireProofCandidates } from './cheat-capture.js';
 import * as v from 'valibot';
@@ -433,2 +434,3 @@ export class ReplicatedLog {
       if (!resumed.ok) return resumed;
+      await replica.captureCertifiedDelivery();
       return replica.offerAvailableInput();
@@ -1001,3 +1003,8 @@ export class ReplicatedLog {
         this.queuedMessages += 1;
-        void this.enqueue(() => this.receive(from, copy)).then((result) => {
+        void this.enqueue(async () => {
+          const result = await this.receive(from, copy);
+          if (!result.ok && !FATAL_CONTROLLER_ERRORS.has(result.error.code))
+            await this.captureRejectedProofs(from, copy);
+          return result;
+        }).then((result) => {
           this.queuedMessages -= 1;
@@ -1681,2 +1688,3 @@ export class ReplicatedLog {
         if (!received.ok) {
+          await this.captureRejectedProofs(from, bytes);
           if (
@@ -1760,3 +1768,11 @@ export class ReplicatedLog {
       case 'CHEAT_CLAIM': {
-        if (!authenticatedCheatSigner(message.claim, this.context.log.genesis))
+        if (
+          message.claim.evidence.at.seq === this.context.log.head.seq &&
+          !authenticatedCheatSigner(
+            message.claim,
+            this.context.log.genesis,
+            this.context.log.authority,
+            this.context.log.crypto?.epoch,
+          )
+        )
           return failure('cheat-signature', 'Cheat evidence has no authenticated genesis signer');
@@ -2922,11 +2938,44 @@ export class ReplicatedLog {
   private verifiedCheatClaim(claim: CheatClaim): Result<CheatFinding> {
-    if (!authenticatedCheatSigner(claim, this.context.log.genesis))
-      return failure('cheat-signature', 'Cheat evidence has no authenticated genesis signer');
     if (claim.evidence.at.seq > this.context.log.head.seq)
       return failure('cheat-future', 'Cheat evidence parent is not certified');
-    return claim.evidence.at.seq === this.context.log.head.seq &&
-      claim.evidence.at.hash === entryHash(this.context.log.head)
-      ? verifyCheatProof(claim, this.context.log)
-      : (this.context.verifyHistoricalCheat?.(claim) ??
-          failure('cheat-history', 'Certified evidence parent is unavailable'));
+    if (claim.evidence.at.seq < this.context.log.head.seq)
+      return (
+        this.context.verifyHistoricalCheat?.(claim) ??
+        failure('cheat-history', 'Certified evidence parent is unavailable')
+      );
+    if (
+      !authenticatedCheatSigner(
+        claim,
+        this.context.log.genesis,
+        this.context.log.authority,
+        this.context.log.crypto?.epoch,
+      )
+    )
+      return failure('cheat-signature', 'Cheat evidence has no authenticated current signer');
+    return verifyCheatProof(claim, this.context.log);
+  }
+
+  private async captureRejectedProofs(from: PeerId, bytes: Uint8Array): Promise<void> {
+    if (
+      this.disposed ||
+      this.context.log.genesis.security !== 'verified' ||
+      !this.context.membership.voters.some((voter) => voter.publicKey === from) ||
+      !this.admitExpensiveRequest(from, `capture/${toHex(hashValue(bytes))}`, 'cheat')
+    )
+      return;
+    for (const claim of rejectedWireProofCandidates(bytes, this.context.log)) {
+      // Retain before gossip; a candidate is still untrusted until the objective
+      // verifier checks its signature and proof against this certified parent.
+      // oxlint-disable-next-line no-await-in-loop -- Bounded candidates share one durable outbox.
+      const retained = await this.rememberCheatClaim(claim, true);
+      if (!retained.ok && retained.error.code.startsWith('cheat-store-'))
+        this.status({ kind: 'rejected', code: retained.error.code });
+    }
+  }
+
+  private async captureCertifiedDelivery(): Promise<void> {
+    const delivery = certifiedDeliveryClaim(this.context.log);
+    if (!delivery) return;
+    const retained = await this.rememberCheatClaim(delivery, true);
+    if (!retained.ok) this.status({ kind: 'rejected', code: retained.error.code });
   }
@@ -3303,3 +3352,6 @@ export class ReplicatedLog {
     this.requireSend(this.broadcast({ t: 'COMMIT', certified }));
-    void this.enqueue(() => this.offerAvailableInput());
+    void this.enqueue(async () => {
+      await this.captureCertifiedDelivery();
+      return this.offerAvailableInput();
+    });
   }
@@ -3404,2 +3456,3 @@ export class ReplicatedLog {
       if (!recovered.ok) return recovered;
+      await this.captureCertifiedDelivery();
       const offered = await this.offerAvailableInput(true);
```

## packages/protocol/src/replicated-log.ts

```ts
// lines 990-1021
          return;
        }
        const peerQueued = this.queuedByPeer.get(from) ?? 0;
        if (
          peerQueued >= MAX_QUEUED_MESSAGES_PER_PEER ||
          this.queuedMessages >= MAX_QUEUED_MESSAGES_TOTAL
        ) {
          // Congestion does not prove peer misconduct. Honest retransmission bursts
          // may exceed the bounded queue while a certified batch is replaying.
          return;
        }
        const copy = bytes.slice();
        this.queuedByPeer.set(from, peerQueued + 1);
        this.queuedMessages += 1;
        void this.enqueue(async () => {
          const result = await this.receive(from, copy);
          if (!result.ok && !FATAL_CONTROLLER_ERRORS.has(result.error.code))
            await this.captureRejectedProofs(from, copy);
          return result;
        }).then((result) => {
          this.queuedMessages -= 1;
          const remaining = (this.queuedByPeer.get(from) ?? 1) - 1;
          if (remaining === 0) this.queuedByPeer.delete(from);
          else this.queuedByPeer.set(from, remaining);
          if (
            !result.ok &&
            (result.error.code === 'invalid-envelope' ||
              result.error.code === 'invalid-encoding' ||
              result.error.code === 'message-too-large' ||
              result.error.code === 'command-proof-invalid' ||
              result.error.code.endsWith('-signature'))
          )
// lines 1070-1105
    key: string,
    category: 'repair' | 'trade' | 'cheat' | 'historical-cheat' | 'reveal' = 'repair',
  ): boolean {
    const now = this.options.clock.now();
    let budgets = this.expensiveByPeer;
    let limit = EXPENSIVE_REQUESTS_PER_WINDOW;
    switch (category) {
      case 'repair':
        break;
      case 'trade':
        budgets = this.tradeProofWorkByPeer;
        limit = TRADE_PROOF_REQUESTS_PER_WINDOW;
        break;
      case 'reveal':
        budgets = this.revealWorkByPeer;
        limit = REVEAL_REQUESTS_PER_WINDOW;
        break;
      case 'cheat':
        budgets = this.cheatWorkByPeer;
        break;
      case 'historical-cheat':
        budgets = this.historicalCheatWorkByPeer;
        break;
    }
    let budget = budgets.get(peer);
    if (
      !budget ||
      now < budget.startedAt ||
      now - budget.startedAt >= EXPENSIVE_REQUEST_WINDOW_MS
    ) {
      budget = { startedAt: now, seen: new Set() };
      budgets.set(peer, budget);
    }
    if (budget.seen.has(key) || budget.seen.size >= limit) return false;
    budget.seen.add(key);
    return true;
// lines 2983-3078
  private async rememberCheatClaim(value: unknown, gossip: boolean): Promise<Result<void>> {
    const store = this.options.cheatCandidateStore;
    if (!store)
      return failure('cheat-store-required', 'Cheat claims need a durable candidate store');
    const encoded = encodeCheatCandidate(value);
    if (!encoded.ok) return encoded;
    const { claim, bytes } = encoded.value;
    const id = cheatCandidateId(claim);
    if (
      this.context.log.crypto?.cheats.some(
        (finding) => finding.seat === claim.seat && finding.kind === claim.evidence.kind,
      )
    )
      return success(undefined);
    if (this.cheatCandidates.has(id)) return success(undefined);
    if (this.cheatCandidates.size >= 48)
      return failure('cheat-capacity', 'The bounded candidate queue is full');
    const finding = this.verifiedCheatClaim(claim);
    if (!finding.ok) return finding;
    let retained = claim;
    try {
      if (!(await store.putIfAbsent(id, bytes))) {
        const winner = (await store.loadAll()).find((record) => record.id === id);
        if (!winner) return failure('cheat-store-record', 'Winning cheat candidate is missing');
        const loaded = decodeCheatCandidate(winner.bytes);
        if (!loaded.ok || cheatCandidateId(loaded.value) !== id)
          return failure('cheat-store-record', 'Winning cheat candidate is corrupt');
        const checked = this.verifiedCheatClaim(loaded.value);
        if (!checked.ok) return checked;
        retained = loaded.value;
      }
    } catch {
      return failure('cheat-store-write', 'Could not persist the cheat candidate');
    }
    this.cheatCandidates.set(id, retained);
    if (gossip) {
      const sent = this.broadcast({ t: 'CHEAT_CLAIM', claim: retained });
      if (!sent.ok) return sent;
    }
    return this.offerAvailableInput();
  }

  private async recoverCheatCandidates(): Promise<Result<void>> {
    const store = this.options.cheatCandidateStore;
    if (!store) return success(undefined);
    let records: readonly { id: string; bytes: Uint8Array }[];
    try {
      records = await store.loadAll();
    } catch {
      return failure('cheat-store-read', 'Could not load retained cheat candidates');
    }
    if (records.length > 48) this.status({ kind: 'rejected', code: 'cheat-store-capacity' });
    for (const record of records.slice(0, 48)) {
      const loaded = decodeCheatCandidate(record.bytes);
      if (!loaded.ok || cheatCandidateId(loaded.value) !== record.id) {
        this.status({ kind: 'rejected', code: 'cheat-store-record' });
        try {
          // oxlint-disable-next-line no-await-in-loop -- Quarantine each invalid auxiliary record before proceeding.
          await store.delete(record.id);
        } catch {
          this.status({ kind: 'rejected', code: 'cheat-store-delete' });
        }
        continue;
      }
      const claim = loaded.value;
      if (
        this.context.log.crypto?.cheats.some(
          (finding) => finding.seat === claim.seat && finding.kind === claim.evidence.kind,
        )
      ) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- Every stale record must be removed before replay resumes.
          await store.delete(record.id);
        } catch {
          this.status({ kind: 'rejected', code: 'cheat-store-delete' });
        }
        continue;
      }
      const checked = this.verifiedCheatClaim(claim);
      if (!checked.ok || this.cheatCandidates.has(record.id)) {
        this.status({ kind: 'rejected', code: 'cheat-store-record' });
        try {
          // oxlint-disable-next-line no-await-in-loop -- Quarantine each invalid auxiliary record before proceeding.
          await store.delete(record.id);
        } catch {
          this.status({ kind: 'rejected', code: 'cheat-store-delete' });
        }
        continue;
      }
      this.cheatCandidates.set(record.id, claim);
    }
    return success(undefined);
  }

  private broadcastNextCheatClaim(): void {
    const claims = [...this.cheatCandidates.entries()].toSorted(([left], [right]) =>
```

## packages/protocol/src/cheat-proof.ts

```ts
// lines 98-128
/** Cheap historical gate; the full verifier checks the signer’s frozen role. */
export function authenticatedCheatSigner(
  claim: CheatClaim,
  genesis: Genesis,
  authority?: SeatAuthorities,
  epoch = authority?.epoch ?? 0,
): boolean {
  const domain =
    claim.evidence.kind === 'command-proof'
      ? 'cmd'
      : claim.evidence.kind === 'beacon-reveal'
        ? 'beacon-reveal'
        : claim.evidence.kind === 'deck-pass'
          ? 'deck-pass'
          : claim.evidence.kind === 'deck-unlock'
            ? 'deck-unlock'
            : claim.evidence.kind === 'count-proof'
              ? 'monopoly-count'
              : claim.evidence.kind === 'steal-contribution'
                ? 'steal-contribution'
                : 'steal-dispute';
  const seats =
    claim.evidence.kind === 'bad-steal-delivery'
      ? genesis.seats
      : genesis.seats.filter((seat) => seat.seat === claim.seat);
  return seats.some(({ seat }) => {
    const signer = resolveArtifactSigner(authority, genesis, epoch, seat);
    return signer.ok && authenticated(claim.evidence.artifact, domain, signer.value.publicKey);
  });
}

// lines 175-207
/** Verify against the certified parent named by `at`; historical callers replay to it first. */
export function verifyCheatProof(value: unknown, context: LogContext): Result<CheatFinding> {
  const parsed = parseCanonical(value, cheatClaimSchema);
  if (!parsed.ok) return parsed;
  const claim = parsed.value;
  const { evidence } = claim;
  if (
    evidence.at.seq !== context.head.seq ||
    evidence.at.hash !== entryHash(context.head) ||
    toHex(hashValue(context.state)) !== context.head.stateHash ||
    context.engine.checkInvariants(context.state).length !== 0 ||
    context.genesis.security !== 'verified' ||
    !context.crypto
  )
    return unproven();
  const crypto = context.crypto;
  const artifact = evidence.artifact;
  let offender: Seat | null = null;
  try {
    if (evidence.kind === 'command-proof') {
      const result = badCommandProof(artifact, context);
      if (result.ok) offender = result.value;
    } else if (evidence.kind === 'beacon-reveal') {
      const operation = getBeaconOperation(crypto.beacon);
      const route = operationRoute(artifact);
      if (
        operation.ok &&
        route.ok &&
        route.value.operationId === beaconOperationId(operation.value) &&
        frozenAtParent(operation.value, context, 'beacon', route.value.operationId)
      ) {
        const owner = operation.value.participants.find((item) => item.seat === route.value.seat);
        const signer = owner && currentSigner(context, owner.seat);
// lines 220-247
          (item) => item.seat === route.value.seat,
        );
        if (
          owner &&
          authenticated(artifact, 'deck-pass', owner.publicKey) &&
          owner.seat ===
            deck.setup.definition.participants[
              deck.nextPass % deck.setup.definition.participants.length
            ]?.seat &&
          deckPassHash(artifact) === deck.commitment.passHashes[deck.nextPass]
        ) {
          const applied = applyDeckPass(deck.setup, artifact);
          if (!applied.ok && ['deck-shuffle-proof', 'deck-lock-proof'].includes(applied.error.code))
            offender = owner.seat;
        }
      }
    } else if (evidence.kind === 'deck-unlock') {
      const operation = crypto.decks.active;
      const route = operationRoute(artifact);
      if (
        operation &&
        route.ok &&
        route.value.operationId === deckDrawOperationId(operation) &&
        frozenAtParent(operation, context, 'deck', route.value.operationId) &&
        evidence.prefix.length < operation.participants.length
      ) {
        const owner = operation.participants.filter((item) => item.seat !== operation.seat)[
          evidence.prefix.length
// lines 320-375
            offender = owner.seat;
          else {
            const checked = verifyStealContribution(artifact, pending.operation, signer.value);
            if (
              !checked.ok &&
              ['steal-ephemeral-proof', 'steal-transfer-proof', 'invalid-envelope'].includes(
                checked.error.code,
              )
            )
              offender = owner.seat;
          }
        }
      }
    } else {
      const pending = crypto.steal;
      if (
        pending?.fixed &&
        frozenAtParent(pending.operation, context, 'steal', stealOperationId(pending.operation))
      ) {
        const shaped = parseCanonical(artifact, signedStealDisputeSchema);
        const signer = currentSigner(context, pending.operation.thief.seat);
        if (
          !shaped.ok ||
          toHex(hashValue(shaped.value.body.binding)) !==
            toHex(hashValue(stealReceiptBinding(pending.fixed))) ||
          !signer.ok ||
          !authenticated(artifact, 'steal-dispute', signer.value.publicKey) ||
          (crypto.epoch > 0 && !pending.fixed.signer)
        )
          return unproven();
        if (
          !verifyStealContribution(
            pending.fixed.contribution,
            pending.operation,
            pending.fixed.signer,
          ).ok
        )
          return unproven();
        if (evidence.kind === 'bad-steal-delivery') {
          if (
            pending.dispute &&
            toHex(hashValue(pending.dispute)) === toHex(hashValue(artifact)) &&
            verifyStealDispute(artifact, pending.fixed, signer.value).ok
          )
            offender = pending.operation.victim.seat;
        } else if (!pending.dispute) {
          const checked = verifyStealDispute(artifact, pending.fixed, signer.value);
          if (!checked.ok && checked.error.code === 'steal-good-delivery')
            offender = pending.operation.thief.seat;
        }
      }
    }
  } catch {
    return unproven();
  }
  if (offender === null || offender !== claim.seat) return unproven();
```

## packages/protocol/src/replay.ts

```ts
// lines 99-149
  const historical = new Map<number, ProposalContext>();
  const cheatHistorical = new Map<number, ProposalContext>();
  const controllerTimeline = [
    {
      atSeq: 0,
      authority: initial.value.log.authority,
      epoch: initial.value.log.crypto?.epoch ?? initial.value.log.authority?.epoch ?? 0,
    },
  ];
  let context: ProposalContext = {
    ...initial.value,
    verifyHistoricalCheat: (claim) => {
      const atSeq = claim.evidence.at.seq;
      if (atSeq > certified.length)
        return failure('cheat-history', 'Certified evidence parent is unavailable');
      const parentEntry = atSeq === 0 ? initial.value.log.head : certified[atSeq - 1]?.entry;
      if (!parentEntry || claim.evidence.at.hash !== entryHash(parentEntry))
        return failure('cheat-history', 'Certified evidence parent hash does not match');
      const parentAuthority = controllerTimeline.findLast((item) => item.atSeq <= atSeq);
      if (
        !parentAuthority ||
        !authenticatedCheatSigner(
          claim,
          initial.value.log.genesis,
          parentAuthority.authority,
          parentAuthority.epoch,
        )
      )
        return failure('cheat-signature', 'Cheat evidence has no authenticated controller');
      const key = toHex(hashValue({ domain: 'cp2p/v1/cheat-claim-cache', claim }));
      const previous = verifiedFindings.get(key);
      if (previous) return success(previous);
      let parent = cheatHistorical.get(atSeq);
      if (!parent) {
        const replayed = replayCertifiedPrefixWithCache(
          genesisEntry,
          certified.slice(0, atSeq),
          engine,
          policy,
          verifiedFindings,
        );
        if (!replayed.ok) return replayed;
        parent = replayed.value.context;
      }
      cheatHistorical.delete(atSeq);
      cheatHistorical.set(atSeq, parent);
      if (cheatHistorical.size > MAX_HISTORICAL_CONTEXTS) {
        const oldest = cheatHistorical.keys().next().value;
        if (oldest !== undefined) cheatHistorical.delete(oldest);
      }
      return verifyCheatProof(claim, parent.log);
```

## packages/protocol/src/cheat-candidates.ts

```ts
// lines 33-59
export function cheatCandidateId(claim: CheatClaim): string {
  return `cheat/${claim.seat}/${claim.evidence.kind}`;
}

export function cheatClaimHash(claim: CheatClaim): string {
  return toHex(hashValue({ domain: 'cp2p/v1/cheat-claim', claim }));
}

export function encodeCheatCandidate(
  value: unknown,
): Result<{ claim: CheatClaim; bytes: Uint8Array }> {
  const parsed = parseCanonical(value, cheatClaimSchema);
  if (!parsed.ok) return parsed;
  const bytes = canonicalEncode(parsed.value);
  return bytes.byteLength <= MAX_MESSAGE_BYTES
    ? success({ claim: parsed.value, bytes })
    : failure('cheat-candidate-size', 'Cheat candidate exceeds the wire limit');
}

export function decodeCheatCandidate(bytes: Uint8Array): Result<CheatClaim> {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_MESSAGE_BYTES)
      return failure('cheat-candidate-record', 'Stored cheat candidate exceeds its byte limit');
    return parseCanonical(canonicalDecode(bytes), cheatClaimSchema);
  } catch {
    return failure('cheat-candidate-record', 'Stored cheat candidate is not canonical data');
  }
```

## packages/protocol/src/cheat-capture.test.ts

```ts
// lines 36-58
  test('retains malformed command, count, and unlock proof bytes while gameplay decoding stays strict', () => {
    const commandBody = {
      seat: 0,
      command: { type: 'BUILD_ROAD' },
      evidence: { protocol: 'command-proofs-v1', data: { hands: 'malformed' } },
    };
    const command = signed('cmd', commandBody);
    const commandBytes = wire({ t: 'SUBMIT', cmd: command });
    expect(decodeProtocolMessage(commandBytes).ok).toBe(false);
    const commandClaims = rejectedProofCandidates({ t: 'SUBMIT', cmd: command }, context);
    expect(commandClaims).toHaveLength(1);
    expect(commandClaims[0]?.evidence).toMatchObject({ kind: 'command-proof', artifact: command });

    const count = signed(
      'monopoly-count',
      {
        operationId: 'a'.repeat(64),
        seat: 1,
        count: 2,
        proof: { malformed: true },
      },
      1,
    );
// lines 89-105
  test('enforces the wire size and signed-artifact count bounds', () => {
    const oversized = wire({
      t: 'SUBMIT',
      cmd: { body: { seat: 0, value: 'x'.repeat(MAX_MESSAGE_BYTES) }, sig: 'x'.repeat(86) },
    });
    expect(oversized.byteLength).toBeGreaterThan(MAX_MESSAGE_BYTES);
    expect(rejectedWireProofCandidates(oversized, context)).toEqual([]);

    const unlocks = Array.from({ length: 6 }, (_, seat) => signed('deck-unlock', { seat }));
    expect(
      rejectedProofCandidates(
        {
          t: 'DECK_CONTRIB',
          genesisDigest: digest,
          contribution: { kind: 'deck-unlock', operationId: 'c'.repeat(64), unlocks },
        },
        context,
// lines 124-151
  test('rejects contributions from another genesis and proposals not extending this parent', () => {
    const count = signed('monopoly-count', { seat: 0 });
    expect(
      rejectedProofCandidates(
        {
          t: 'COUNT_CONTRIB',
          genesisDigest: toBase64Url(new Uint8Array(32).fill(99)),
          contribution: count,
        },
        context,
      ),
    ).toEqual([]);

    const payload = { kind: 'command', signed: signed('cmd', { seat: 0 }) };
    const proposal = (overrides: { genesisDigest?: string; prevHash?: string }) => ({
      t: 'PROPOSAL',
      proposal: {
        body: {
          genesisDigest: overrides.genesisDigest ?? digest,
          entry: {
            seq: context.head.seq + 1,
            prevHash: overrides.prevHash ?? entryHash(context.head),
            payload,
          },
        },
        sig: signed('proposal', {}).sig,
      },
    });
// lines 162-195
  test('keeps unlock candidates in prefix order and requires verification after capture', () => {
    const unlocks = [0, 1, 0].map((seat, index) =>
      signed('deck-unlock', { seat, step: index, proof: { malformed: index } }),
    );
    const claims = rejectedProofCandidates(
      {
        t: 'DECK_CONTRIB',
        genesisDigest: digest,
        contribution: { kind: 'deck-unlock', operationId: 'd'.repeat(64), unlocks },
      },
      context,
    );
    expect(claims).toHaveLength(3);
    for (const [index, claim] of claims.entries()) {
      expect(claim?.evidence).toMatchObject({
        kind: 'deck-unlock',
        artifact: unlocks[index],
        prefix: unlocks.slice(0, index),
        at: { seq: context.head.seq, hash: entryHash(context.head) },
      });
    }

    const commandBody = {
      gameId: context.genesis.gameId,
      genesisDigest: digest,
      seat: 0,
      nonce: 1,
      headSeq: context.head.seq,
      headHash: entryHash(context.head),
      command: { type: 'BUY_DEV_CARD' },
      evidence: { protocol: 'command-proofs-v1', data: { malformed: true } },
    };
    const forged = signed('cmd', commandBody, 1);
    const candidate = required(rejectedProofCandidates({ t: 'SUBMIT', cmd: forged }, context)[0]);
```

## packages/protocol/src/beacon-replica.test.ts

```ts
// lines 385-417
      };
      const bad: ProtocolMessage = {
        t: 'SYS_CONTRIB',
        genesisDigest: before.membership.genesisDigest,
        contribution: {
          kind: 'beacon-reveal',
          signed: {
            body,
            sig: signObject(
              'beacon-reveal',
              body,
              required(fixture.simulation.identities.get(offender.seat)).secretKey,
            ),
          },
        },
      };
      required(transports[1]).inject(required(peers[0]), bad);
      await settle([first, second], network.clock);
      for (const replica of [first, second]) {
        const after = replica.getContext();
        expect(after.log.head.seq).toBe(before.log.head.seq + 1);
        expect(after.log.head.payload.kind).toBe('cheat-proof');
        expect(after.log.head.stateHash).toBe(before.log.head.stateHash);
        expect(after.log.state).toEqual(before.log.state);
        expect(after.log.crypto?.beacon).toEqual(before.log.crypto.beacon);
        expect(after.log.crypto?.cheats).toMatchObject([
          { seat: offender.seat, kind: 'beacon-reveal', at: { seq: before.log.head.seq } },
        ]);
        expect(replica.getEntries().at(-1)?.certificate).toHaveLength(2);
      }
      expect(required(sent[1]).some((message) => message.t === 'CHEAT_CLAIM')).toBe(true);
      required(transports[1]).inject(required(peers[0]), bad);
      await settle([first, second], network.clock);
```

## packages/protocol/src/cheat-schema.ts

```ts
// lines 1-40
import * as v from 'valibot';
import {
  hashSchema,
  nonnegativeIntegerSchema,
  seatSchema,
  signature64Schema,
} from './schema-values.js';

const refSchema = v.strictObject({ seq: nonnegativeIntegerSchema, hash: hashSchema });
const signedSchema = v.strictObject({ body: v.unknown(), sig: signature64Schema });
const base = { at: refSchema, artifact: signedSchema };

export const cheatClaimSchema = v.strictObject({
  seat: seatSchema,
  evidence: v.variant('kind', [
    v.strictObject({ kind: v.literal('command-proof'), ...base }),
    v.strictObject({ kind: v.literal('beacon-reveal'), ...base }),
    v.strictObject({ kind: v.literal('deck-pass'), ...base }),
    v.strictObject({
      kind: v.literal('deck-unlock'),
      ...base,
      prefix: v.pipe(v.array(v.unknown()), v.maxLength(5)),
    }),
    v.strictObject({ kind: v.literal('count-proof'), ...base }),
    v.strictObject({ kind: v.literal('steal-contribution'), ...base }),
    v.strictObject({ kind: v.literal('bad-steal-delivery'), ...base }),
    v.strictObject({ kind: v.literal('false-steal-dispute'), ...base }),
  ]),
});
```

## packages/protocol/src/wire.ts

```ts
// lines 25-55
      : failure('invalid-envelope', 'Protocol value does not match its schema');
  } catch {
    return failure('invalid-envelope', 'Protocol value does not match its schema');
  }
}

/** Decode canonical wire bytes, apply the caller's schema, and return detached data. */
export function decodeMessage<T>(
  bytes: Uint8Array,
  schema: v.GenericSchema<unknown, T>,
): Result<T> {
  if (!(bytes instanceof Uint8Array))
    return failure('invalid-encoding', 'Protocol message must be a Uint8Array');
  if (bytes.byteLength > MAX_MESSAGE_BYTES)
    return failure('message-too-large', 'Protocol message exceeds 256 KiB');

  let value: unknown;
  try {
    value = canonicalDecode(bytes);
  } catch {
    return failure('invalid-encoding', 'Protocol message is not canonical UTF-8 JSON');
  }

  try {
    const parsed = v.safeParse(schema, value);
    return parsed.success
      ? success(parsed.output)
      : failure('invalid-envelope', 'Protocol message does not match its schema');
  } catch {
    return failure('invalid-envelope', 'Protocol message does not match its schema');
  }
```
