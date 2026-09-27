# Certified escrow-custody void design review

Review only the attached source excerpts and the proposed change. This is a source-only security review. No production secrets, user saves, SDP, or browser state are included. Tools and MCP are disabled. Return at most five concrete findings, ordered by severity. Cite a supplied file and line for each finding; distinguish a proven defect from an unanswered product decision.

The observed test constructs a current-version signed genesis where seat 0's Feldman escrow and `masterPub` use the same scalar, while its signed beacon tip was derived from another scalar. A four-human certified offline marker and old-quorum recovery authorization precede all three original holders' authenticated share releases. The recoverer reconstructs the scalar behind `masterPub`; `produceRecoveryCheckFromShares` returns `master-beacon-tip` before writing or signing a check. Activation without that recoverer's check fails. The game remains pending because no certified public void/fault exists.

Proposed minimum:

1. Add a `recovery-void` membership change accepted only while its exact certified recovery authorization remains pending. Bind the statement to genesis digest, current certified parent, authorization ref, affected dealer seat, and one reconstructed 32-byte scalar. Do not accept a caller-declared error code as proof.
2. Deterministic replay first checks bounded syntax, exact pending authorization, affected seat, and scalar·G equal to the dealer's signed `masterPub`; a wrong scalar or absent authorization fails without attributing misconduct. Then `verifyRevealedMaster` must fail specifically on a signed derived beacon, encryption, shuffle, or lock key. Malformed deck context, missing history, and local replay failure are not owner violations.
3. The current remaining human voter set certifies this entry. It preserves engine state, records a protocol terminal void ref and dealer/reason in replayed public state, and disallows later gameplay, activation, transfer, or new membership while preserving read-only sync/export. A session reports void separately from an engine winner and does not call a successful full-game audit.
4. The scalar becomes public only in the certified entry after old-quorum recovery authorization. This extends exposure beyond the recoverers. Decide whether the signed takeover policy and certified authorization permit that disclosure. Objective verification of HKDF-derived-key inconsistency cannot use only a hash or recoverer claim; a zero-knowledge alternative would be substantially larger.

Check replay determinism and snapshot binding, exact parent and voter-set transitions, key exposure and all affected seats, forged-master attribution, cheap checks before key derivation, inability to propose an uncertified local stop as a public void, and terminal session/UI behavior. Identify the smallest safer alternative if this proposal violates the existing privacy contract.

## docs/07-fair-randomness-hidden-info.md
Lines 215-228:
```text
215: - A seat with a logged `CHEAT_PROOF` gets its result marked "cheating detected" in the local history, whatever happens later in the game. Remaining humans can also vote to end the game early.
216: - The UI shows a running fairness indicator ("All 214 moves verified") instead of waiting for a verdict at the end.
217: 
218: ## 7. Key escrow (Feldman-verified Shamir)
219: 
220: - Games starting with two or three humans do not distribute escrow shares. Strict agreement requires every voter in those games, so absent-seat takeover is unavailable; a two-human threshold of one would expose the whole hand to the opponent from genesis.
221: - Games starting with at least four humans split each `masterSecret` with Shamir over the ristretto255 scalar field, threshold `t = (number of other original human seats)`. Recovery requires all those shares, or their authorized recovered equivalents. This threshold can be stricter than the ordering quorum, so a withholding holder can still stall recovery.
222: - **Verifiable at distribution** (Feldman VSS): the dealer publishes exactly `t` coefficient commitments `F_k = c_k·G` for `k = 0 … t−1`, with `F_0 = masterPub`. Each share is sealed to its recipient (as in §5). The verifier requires the expected threshold, master public key and recipient index from the ceremony. The recipient checks these parameters and `share·G == Σ_k j^k·F_k`, then ACKs with a signature over `H(share)`. Genesis retains the sealed ciphertexts, Feldman commitments and share hashes. A previously departed holder's recovered encryption key can open its shares during a later authorized takeover.
223: - A bad share is detected before the recipient ACKs or consents to genesis. The recipient durably retains the dealer-signed sealed share and its ECDH proof, retires the ceremony, and publishes the complaint. A retry starts with fresh secrets. After local genesis consent, a signature cannot be revoked by local abort: retain any late authenticated disclosure for agreed disposition and pause normal start instead of erasing the promise. Recovery permanently exposes shares, so a local client never manufactures a complaint for a correctly opened or previously ACKed share.
224: - Feldman guarantees that recovery produces the secret behind `masterPub`. It can't prove that the seat derived its beacon chain and deck keys from that secret, because HKDF can't be proven cheaply. So on recovery the reconstructed secret must also reproduce the seat's published beacon tip, lock public keys and encryption key. A mismatch is a violation by the departed seat. The game can't continue fairly without those keys, so it ends, is marked void, and the seat is flagged. This is the one check that can't run per move; it only matters when that seat has left.
225: - Honest holders release shares only after verifying stage 10's recovery-authorization certificate from the old voter set. The authorization freezes the departed seat and names its bot host and keys. A second committed entry verifies recovery before activating the bot. Neither timeout nor a local online list authorizes disclosure.
226: - Recovery permanently exposes the departed seat's hand to recoverers and weakens the collusion threshold for other seats by exposing its keys. Share withholding can leave one recoverer informed while others wait. A returning human does not regain secrecy. Disclose these limits before the lobby enables takeover.
227: 
228: ## 8. End-of-game reveal
```
Lines 272-290:
```text
272: | Cheat                                    | Caught                                                        |
273: | ---------------------------------------- | ------------------------------------------------------------- |
274: | Wrong beacon preimage                    | Immediately                                                   |
275: | Withheld reveal or proof                 | Stall; authorized recovery preserves outcome, otherwise pause |
276: | Duplicate points in shuffle              | Immediately                                                   |
277: | Substituted or re-keyed card in shuffle  | Immediately (shuffle proof / locking DLEQ)                    |
278: | Wrong partial unlock                     | Immediately (DLEQ)                                            |
279: | Claiming a card not held when playing    | Immediately (DLEQ)                                            |
280: | Giving the wrong card in a steal         | Immediately (index proof)                                     |
281: | Sealed steal opening doesn't match       | Recipient check and dispute before transfer commitment        |
282: | False dispute                            | Immediately (shared-point DLEQ and decrypted opening)         |
283: | Lying in count reveal                    | Immediately (Schnorr opening)                                 |
284: | Spending unowned resources within bounds | Immediately (range proof)                                     |
285: | Bad escrow share                         | In the genesis ceremony (Feldman)                             |
286: | Escrowed secret doesn't match used keys  | At recovery, or at the end-of-game reveal                     |
287: 
288: ## Acceptance criteria
289: 
290: - [ ] P2P games over memnet with real crypto pass the stage-06 chaos suite (200 seeds per scenario in CI).
```

## docs/10-persistence-reconnection.md
Lines 73-96:
```text
73: 
74: ### 3.1 Trigger
75: 
76: - Configurable in genesis: `takeover: { afterSeconds: 120 (default) | never, mode: 'vote' | 'auto' }`.
77:   - `vote`: once the seat has been offline longer than `afterSeconds`, show "Replace Blue with a bot?" only when the current voter set can certify removal. Recovery needs the stage-07 escrow threshold as well as the consensus quorum.
78:   - `auto`: triggered automatically after the timeout.
79: - Games starting with two or three humans do not distribute recovery shares and cannot take over an absent human under strict agreement. They wait for that human to return. A normal live seat transfer can still be authorized while all required voters participate.
80: 
81: ### 3.2 Recovery
82: 
83: 1. Commit recovery authorization under the old voter set before honest holders release any shares. Freeze the departed seat and hosted bots. Holders verify that certificate, then release their shares to the authorized recoverers. The sealed original shares remain available in genesis, including shares held by previously recovered seats. Share withholding can still stall recovery.
84: 2. Each reconstructs `masterSecret` and verifies it against the genesis commitments (`masterPub`, beacon tip, lock pubkeys, encryption key). A mismatch ends the game as void (stage 07 §7).
85: 3. They derive the departed seat's private state by **replaying the log in the departed seat's private perspective**. Its hand can be reconstructed from:
86:    - public events,
87:    - dealt cards (unlock the chain with its lock keys),
88:    - stolen cards (as victim: from the sorted-hand/steal-index rule; as thief: by decrypting the sealed opening in the log with the recovered encryption key), plus the blindings of its committed hand (stage 07 §4), re-derived from the recovered secret and the sealed openings.
89: 4. Commit the verified recovery result under the new set before running the bot. Use the host and takeover keys named in the authorization entry; do not choose them from each peer's local online list. Command validation uses the certified current seat key.
90: 5. The beacon can now use the recovered chain for that seat. Other missing reveals or unavailable recovery shares can still pause play.
91: 
92: Authorization and share release are irreversible for privacy. Recoverers can inspect the bot's hand and its historical secrets. Recovered keys also weaken the collusion threshold for other seats. A returning human's hand does not become secret again.
93: 
94: ### 3.3 Membership handoff
95: 
96: Membership is fixed within each consensus height. The old voter set certifies a change using its current quorum; the new set and incremented epoch take effect only at the next height. Change one human seat at a time. Joining or replacement keys sign readiness over the full genesis digest, parent value hash, next epoch and proposed member list. They cannot vote before verifying the transition certificate. Protocol-control entries remain available while the engine waits on an offline seat's input or reveal. A four-to-three transition leaves a quorum of three and cannot tolerate a further absent voter.
```

## packages/protocol/src/recovery-types.ts
Lines 1-58:
```text
1: import type { Seat } from '@cp2p/engine';
2: import type { EntryRef } from './beacon-state.js';
3: import type { SeatSignature } from './types.js';
4: 
5: export interface RecoveryReadiness {
6:   readonly genesisDigest: string;
7:   readonly parent: EntryRef;
8:   readonly nextEpoch: number;
9:   readonly departedSeat: Seat;
10:   readonly hostSeat: Seat;
11:   readonly botLevel: 'easy' | 'medium' | 'hard';
12:   readonly replacements: readonly { readonly seat: Seat; readonly publicKey: string }[];
13:   /** Every remaining human privately verifies reconstruction before signing activation. */
14:   readonly recoverers: readonly { readonly seat: Seat; readonly publicKey: string }[];
15:   readonly previous: EntryRef | null;
16: }
17: 
18: export interface RecoveryAuthorization {
19:   readonly kind: 'recovery-authorize';
20:   readonly statement: RecoveryReadiness;
21:   readonly hostSig: string;
22:   readonly keySigs: readonly SeatSignature[];
23: }
24: 
25: export interface RecoveryActivationStatement {
26:   readonly genesisDigest: string;
27:   readonly parent: EntryRef;
28:   readonly nextEpoch: number;
29:   readonly authorization: EntryRef;
30:   /** Public digest of the activation parent; contains no master or private hand. */
31:   readonly checkDigest: string;
32: }
33: 
34: export interface RecoveryActivation {
35:   readonly kind: 'recovery-activate';
36:   readonly statement: RecoveryActivationStatement;
37:   readonly checks: readonly SeatSignature[];
38: }
39: 
40: export type RecoveryChange = RecoveryAuthorization | RecoveryActivation;
41: 
42: export interface AuthorizedRecovery {
43:   readonly entry: EntryRef;
44:   readonly statement: RecoveryReadiness;
45: }
46: 
47: /** Only replay installs these records. Amendments retain every earlier authorization. */
48: export interface RecoveryState {
49:   readonly authorizations: readonly AuthorizedRecovery[];
50:   readonly pending: EntryRef | null;
51:   /** Certified observation only; elapsed absence remains a local voting rule. */
52:   readonly offline: readonly { readonly seat: Seat; readonly since: EntryRef }[];
53:   readonly completed: readonly {
54:     readonly authorization: EntryRef;
55:     readonly activation: EntryRef;
56:     readonly checkDigest: string;
57:   }[];
58: }
```

## packages/protocol/src/recovery-membership.ts
Lines 1-57:
```text
1: import { hashValue, toHex } from '@cp2p/codec';
2: import { parsePeerId, verifyObject } from '@cp2p/crypto';
3: import { failure, success } from '@cp2p/engine';
4: import type { GameState, Input, Result, Seat } from '@cp2p/engine';
5: import * as v from 'valibot';
6: import { validateSeatAuthorities } from './authority.js';
7: import type { CarriedOperation, SeatAuthorities } from './authority-types.js';
8: import { beaconOperationId } from './beacon.js';
9: import { beaconExtensionOperationId } from './beacon-extension.js';
10: import { getBeaconExtensionOperation, getBeaconOperation } from './beacon-state.js';
11: import type { EntryRef } from './beacon-state.js';
12: import { countOperationId } from './count-reveal.js';
13: import type { CryptoContext } from './crypto-context.js';
14: import { deckDrawOperationId } from './deck-draw.js';
15: import { decksReady } from './deck-ledger.js';
16: import { deriveEscrowRosters } from './escrow-roster.js';
17: import { entryHash, genesisDigest } from './genesis.js';
18: import type { LogContext } from './log-types.js';
19: import { validateOfflineMarkers } from './recovery-presence.js';
20: import type {
21:   AuthorizedRecovery,
22:   RecoveryActivationStatement,
23:   RecoveryChange,
24:   RecoveryReadiness,
25:   RecoveryState,
26: } from './recovery-types.js';
27: import {
28:   hashSchema,
29:   key32Schema,
30:   nonnegativeIntegerSchema,
31:   seatSchema,
32:   signature64Schema,
33: } from './schema-values.js';
34: import { stealOperationId } from './steal-delivery.js';
35: import type { LogEntry, SeatSignature } from './types.js';
36: import { parseCanonical } from './validation.js';
37: import { quorumSize } from './votes.js';
38: 
39: export const RECOVERY_READINESS_DOMAIN = 'recovery-readiness';
40: export const RECOVERY_CHECK_DOMAIN = 'recovery-check';
41: const refSchema = v.strictObject({ seq: nonnegativeIntegerSchema, hash: hashSchema });
42: const membersSchema = v.pipe(
43:   v.array(v.strictObject({ seat: seatSchema, publicKey: key32Schema })),
44:   v.minLength(1),
45:   v.maxLength(6),
46: );
47: const signaturesSchema = v.pipe(
48:   v.array(v.strictObject({ seat: seatSchema, sig: signature64Schema })),
49:   v.minLength(1),
50:   v.maxLength(6),
51: );
52: export const recoveryReadinessSchema = v.strictObject({
53:   genesisDigest: key32Schema,
54:   parent: refSchema,
55:   nextEpoch: nonnegativeIntegerSchema,
56:   departedSeat: seatSchema,
57:   hostSeat: seatSchema,
```
Lines 196-253:
```text
196: }
197: 
198: /** Proposal derivation only. The parent's quorum certificate is required before installation. */
199: export function validateRecoveryTransition(
200:   change: unknown,
201:   entry: LogEntry,
202:   context: LogContext,
203:   crypto: CryptoContext | null,
204: ): Result<RecoveryTransition> {
205:   if (
206:     context.genesis.security !== 'verified' ||
207:     !crypto ||
208:     !context.authority ||
209:     !decksReady(crypto.decks)
210:   )
211:     return failure(
212:       'recovery-context',
213:       'Recovery requires verified authority and completed genesis decks',
214:     );
215:   if (context.state.result !== null)
216:     return failure('recovery-finished', 'A finished game cannot change controllers');
217:   if (context.transfer?.pending)
218:     return failure('recovery-transfer-pending', 'Cancel the certified transfer before recovery');
219:   const parsed = parseCanonical(change, recoveryChangeSchema);
220:   if (!parsed.ok) return parsed;
221:   const checked = validateSeatAuthorities(
222:     context.authority,
223:     genesisDigest(context.genesis),
224:     crypto.epoch,
225:     context.genesis.config.seats,
226:   );
227:   if (!checked.ok) return checked;
228:   const current = checked.value;
229:   const body = parsed.value.statement;
230:   if (
231:     body.genesisDigest !== current.genesisDigest ||
232:     !same(body.parent, ref(context.head)) ||
233:     body.nextEpoch !== current.epoch + 1 ||
234:     !Number.isSafeInteger(current.epoch + 1)
235:   )
236:     return failure(
237:       'recovery-parent',
238:       'Recovery statement differs from its certified parent or next epoch',
239:     );
240:   const history = context.recovery;
241:   if (!history) return failure('recovery-history', 'Certified recovery history is unavailable');
242:   const offline = validateOfflineMarkers(history, context);
243:   if (!offline.ok) return offline;
244:   const pending = history.pending
245:     ? history.authorizations.find((item) => same(item.entry, history.pending))
246:     : undefined;
247:   if (history.pending && !pending)
248:     return failure('recovery-history', 'Pending authorization is missing from replayed history');
249:   if (parsed.value.kind === 'recovery-authorize' && history.authorizations.length >= 256)
250:     return failure('recovery-history-limit', 'Recovery authorization history is full');
251:   const carried = carriedOperations(crypto);
252:   if (!carried.ok) return carried;
253:   const prepared = { ...context, crypto };
```
Lines 420-480:
```text
420:     return failure('recovery-activation', 'Only frozen seats can activate replacement keys');
421:   const authority = validateSeatAuthorities(
422:     {
423:       ...current,
424:       epoch: statement.nextEpoch,
425:       carriedOperations: carried,
426:       controllers: current.controllers.map((item) => {
427:         const replacement = replacements.find((candidate) => candidate.seat === item.seat);
428:         return replacement
429:           ? {
430:               ...item,
431:               publicKey: replacement.publicKey,
432:               hostSeat: pending.statement.hostSeat,
433:               status: 'active',
434:               kind: 'bot',
435:               activatedAt: ref(entry),
436:             }
437:           : item;
438:       }),
439:     },
440:     current.genesisDigest,
441:     statement.nextEpoch,
442:     context.genesis.config.seats,
443:   );
444:   if (!authority.ok) return authority;
445:   const input = {
446:     kind: 'system',
447:     type: 'SEAT_STATUS',
448:     seat: pending.statement.departedSeat,
449:     status: 'bot',
450:   } as const;
451:   const applied = context.engine.apply(context.state, input);
452:   if (!applied.ok) return applied;
453:   if (
454:     context.engine.checkInvariants(applied.value.state).length ||
455:     entry.stateHash !== toHex(hashValue(applied.value.state))
456:   )
457:     return failure(
458:       'recovery-state',
459:       'Activation state differs from the deterministic bot takeover',
460:     );
461:   return success({
462:     authority: authority.value,
463:     recovery: {
464:       ...history,
465:       pending: null,
466:       offline: history.offline.filter((marker) => marker.seat !== pending.statement.departedSeat),
467:       completed: [
468:         ...history.completed,
469:         {
470:           authorization: pending.entry,
471:           activation: ref(entry),
472:           checkDigest: statement.checkDigest,
473:         },
474:       ],
475:     },
476:     crypto: { ...context.crypto, epoch: statement.nextEpoch },
477:     state: applied.value.state,
478:     input,
479:   });
480: }
```

## packages/protocol/src/recovery-release.ts
Lines 370-422:
```text
370:   context: LogContext,
371:   dealerSeat: Seat,
372:   recipientSeat: Seat,
373:   encryptionSecret: bigint,
374: ): Result<Uint8Array> {
375:   try {
376:     const escrow = validateGenesisEscrow(context.genesis);
377:     if (!escrow.ok) return escrow;
378:     const dealer = escrow.value.find((item) => item.dealerSeat === dealerSeat);
379:     if (
380:       !dealer ||
381:       releases.length !== dealer.shares.length ||
382:       releases.length < 1 ||
383:       releases.length > 5
384:     )
385:       return failure('recovery-release-threshold', 'Every original holder share is required');
386:     const opened = [];
387:     for (const release of releases) {
388:       const share = openRecoveryRelease(release, context, recipientSeat, encryptionSecret);
389:       if (!share.ok) return share;
390:       if (share.value.dealerSeat !== dealerSeat)
391:         return failure(
392:           'recovery-release-dealer',
393:           'Recovery cannot mix shares from different dealers',
394:         );
395:       opened.push(share.value);
396:     }
397:     const expected = dealer.shares
398:       .map((item) => item.envelope.body.holder.index)
399:       .toSorted((a, b) => a - b);
400:     if (
401:       !same(
402:         opened.map((item) => item.index).toSorted((a, b) => a - b),
403:         expected,
404:       )
405:     )
406:       return failure('recovery-release-threshold', 'Missing or duplicated original holder indices');
407:     const envelope = dealer.shares[0]?.envelope;
408:     if (!envelope) return failure('recovery-release-threshold', 'Original escrow is missing');
409:     const secret = recoverSecret(opened, envelope.body.threshold);
410:     if (encodePoint(scalePoint(G, secret)) !== envelope.body.masterPub)
411:       return failure(
412:         'recovery-release-master',
413:         'Recovered scalar differs from the committed master',
414:       );
415:     return success(scalarToBytes(secret));
416:   } catch {
417:     return failure(
418:       'recovery-release-reconstruction',
419:       'Could not reconstruct the authorized master',
420:     );
421:   }
422: }
```

## packages/protocol/src/recovery-check.ts
Lines 44-109:
```text
44: export async function produceRecoveryCheckFromShares(
45:   input: Omit<RecoveryCheckInput, 'secrets'> & {
46:     readonly releases: readonly unknown[];
47:     readonly recipientEncryptionSecret: bigint;
48:   },
49: ): Promise<Result<ProducedRecoveryCheck>> {
50:   const { journal, engine, policy, store, localSeat, recipientEncryptionSecret } = input;
51:   const secrets: { seat: Seat; master: Uint8Array }[] = [];
52:   let signingKey: Uint8Array | undefined;
53:   try {
54:     if (!Array.isArray(input.releases) || input.releases.length < 1 || input.releases.length > 30)
55:       return failure('recovery-check-shares', 'Recovery requires a bounded set of original shares');
56:     const releases = input.releases.map((release) =>
57:       v.parse(recoveryReleaseSchema, canonicalDecode(canonicalEncode(release))),
58:     );
59:     signingKey = input.signingKey.slice();
60:     const record = await journal.load();
61:     if (!record || !journalParent(record))
62:       return failure('recovery-check-journal', 'Certified journal or safety height is missing');
63:     const replayed = replayCertifiedPrefix(record.genesis, record.entries, engine, policy);
64:     if (!replayed.ok) return replayed;
65:     const context = replayed.value.context.log;
66:     const authorization = context.recovery?.authorizations.at(-1);
67:     if (
68:       !authorization ||
69:       !context.recovery?.pending ||
70:       !sameRef(authorization.entry, context.recovery.pending)
71:     )
72:       return failure(
73:         'recovery-check-pending',
74:         'Latest certified recovery authorization is unavailable',
75:       );
76:     const affected = authorization.statement.replacements.map(({ seat }) => seat);
77:     if (releases.some(({ body }) => !affected.includes(body.dealerSeat)))
78:       return failure('recovery-check-shares', 'A release belongs to an unaffected seat');
79:     for (const seat of affected) {
80:       const recovered = recoverAuthorizedMaster(
81:         releases.filter(({ body }) => body.dealerSeat === seat),
82:         context,
83:         seat,
84:         localSeat,
85:         recipientEncryptionSecret,
86:       );
87:       if (!recovered.ok) return recovered;
88:       secrets.push({ seat, master: recovered.value });
89:     }
90:     return await produceRecoveryCheck({
91:       journal,
92:       engine,
93:       policy,
94:       store,
95:       localSeat,
96:       signingKey,
97:       secrets,
98:     });
99:   } catch {
100:     return failure('recovery-check-shares', 'Could not recover the authorized shares');
101:   } finally {
102:     signingKey?.fill(0);
103:     for (const { master } of secrets) master.fill(0);
104:   }
105: }
106: 
107: function journalParent(record: JournalRecord): { seq: number; hash: string } | null {
108:   const head = record.entries.at(-1)?.entry ?? record.genesis;
109:   if (
```
Lines 135-242:
```text
135:   input: RecoveryCheckInput,
136: ): Promise<Result<ProducedRecoveryCheck>> {
137:   if (!(input.signingKey instanceof Uint8Array) || input.signingKey.length !== 32)
138:     return failure('recovery-check-key', 'Current controller signing key is missing');
139:   if (
140:     !Array.isArray(input.secrets) ||
141:     input.secrets.some(({ master }) => !(master instanceof Uint8Array) || master.length !== 32)
142:   )
143:     return failure('recovery-check-secrets', 'Affected master secrets are malformed');
144: 
145:   // Caller-owned buffers may change while the journal and store await I/O.
146:   const { journal, store, engine, policy, localSeat } = input;
147:   const signingKey = input.signingKey.slice();
148:   const secrets = input.secrets.map(({ seat, master }) => ({ seat, master: master.slice() }));
149:   let reconstructed: ReconstructedPrivateSeats | undefined;
150:   let retained = false;
151:   try {
152:     const record = await journal.load();
153:     const parent = record && journalParent(record);
154:     if (!record || !parent)
155:       return failure('recovery-check-journal', 'Certified journal or safety height is missing');
156:     const genesisHash = entryHash(record.genesis);
157:     const replayed = replayCertifiedPrefix(record.genesis, record.entries, engine, policy);
158:     if (!replayed.ok) return replayed;
159:     const context = replayed.value.context.log;
160:     if (!sameRef(parent, { seq: context.head.seq, hash: entryHash(context.head) }))
161:       return failure('recovery-check-journal', 'Certified replay differs from the durable journal');
162: 
163:     const history = context.recovery;
164:     const authorization = history?.authorizations.at(-1);
165:     const authority = context.authority;
166:     if (
167:       !history?.pending ||
168:       !authorization ||
169:       !sameRef(history.pending, authorization.entry) ||
170:       !authority ||
171:       !context.crypto ||
172:       authority.epoch !== context.crypto.epoch ||
173:       authorization.statement.nextEpoch !== authority.epoch ||
174:       !Number.isSafeInteger(authority.epoch + 1)
175:     )
176:       return failure(
177:         'recovery-check-pending',
178:         'Latest certified recovery authorization is unavailable',
179:       );
180: 
181:     const recoverers = authority.controllers
182:       .filter((item) => item.kind === 'human' && item.status === 'active')
183:       .map(({ seat, publicKey }) => ({ seat, publicKey }));
184:     const expected = authorization.statement.recoverers;
185:     const local = recoverers.find(({ seat }) => seat === localSeat);
186:     if (
187:       !local ||
188:       recoverers.length !== expected.length ||
189:       recoverers.some(
190:         (item, index) =>
191:           item.seat !== expected[index]?.seat || item.publicKey !== expected[index].publicKey,
192:       )
193:     )
194:       return failure(
195:         'recovery-check-recoverer',
196:         'Local controller is not an exact active recoverer',
197:       );
198: 
199:     const affected = authorization.statement.replacements.map(({ seat }) => seat);
200:     if (
201:       secrets.length !== affected.length ||
202:       new Set(secrets.map(({ seat }) => seat)).size !== affected.length ||
203:       secrets.some(({ seat }) => !affected.includes(seat))
204:     )
205:       return failure('recovery-check-secrets', 'Supply every affected master exactly once');
206: 
207:     const identity = identityFromSecret(signingKey);
208:     try {
209:       if (identity.peerId !== local.publicKey)
210:         return failure('recovery-check-key', 'Signing key is not the current local controller');
211:     } finally {
212:       identity.secretKey.fill(0);
213:     }
214: 
215:     const rebuilt = reconstructPrivateSeats({
216:       genesisEntry: record.genesis,
217:       entries: record.entries,
218:       engine,
219:       policy,
220:       secrets,
221:     });
222:     if (!rebuilt.ok) return rebuilt;
223:     reconstructed = rebuilt.value;
224:     if (
225:       !sameRef(parent, {
226:         seq: reconstructed.context.log.head.seq,
227:         hash: entryHash(reconstructed.context.log.head),
228:       })
229:     )
230:       return failure(
231:         'recovery-check-replay',
232:         'Private reconstruction used a different certified parent',
233:       );
234: 
235:     const retainedSecrets = await persistRecoveryPrivate(
236:       context,
237:       authorization.entry,
238:       localSeat,
239:       secrets.toSorted((a, b) => a.seat - b.seat),
240:       store,
241:     );
242:     if (!retainedSecrets.ok) return retainedSecrets;
```

## packages/protocol/src/genesis-secrets.ts
Lines 25-135:
```text
25: 
26: /**
27:  * Check a recovered/revealed master against the original public keys and chain.
28:  * Call only after authorized disclosure. This function neither authorizes it nor
29:  * authenticates genesis/certificates; callers must supply their certified genesis.
30:  * It does not constitute the full historical game audit.
31:  */
32: export function verifyRevealedMaster(
33:   value: GenesisBody,
34:   ledger: DeckLedger,
35:   seat: Seat,
36:   suppliedMaster: unknown,
37: ): Result<void> {
38:   const body = parseCanonical(value, bodySchema);
39:   if (!body.ok) return body;
40:   const genesis = body.value;
41:   if (genesis.security !== 'verified')
42:     return failure('master-security', 'Only verified games have recoverable masters');
43:   const masters = validateGenesisMasters(genesis);
44:   if (!masters.ok) return masters;
45:   const owner = genesis.seats.find((item) => item.seat === seat);
46:   const commitment = masters.value.find((item) => item.seat === seat);
47:   if (!owner || !commitment)
48:     return failure('master-reveal', 'Master reveal has an invalid seat or scalar encoding');
49:   let master: Uint8Array | undefined;
50:   try {
51:     // Private import paths pass bytes directly. Do not create an unwipeable
52:     // base64 string for a master that has not been publicly revealed.
53:     if (suppliedMaster instanceof Uint8Array) {
54:       if (suppliedMaster.byteLength !== 32)
55:         return failure('master-reveal', 'Master must contain exactly 32 bytes');
56:       master = new Uint8Array(suppliedMaster);
57:     } else {
58:       const parsed = parseCanonical(suppliedMaster, key32Schema);
59:       if (!parsed.ok)
60:         return failure('master-reveal', 'Master reveal has an invalid scalar encoding');
61:       master = fromBase64Url(parsed.value);
62:     }
63:     const scalar = scalarFromBytes(master, { nonzero: true });
64:     if (encodePoint(scalePoint(G, scalar)) !== commitment.masterPub)
65:       return failure('master-public-key', 'Revealed master does not match its commitment');
66:     const encryption = createStealSecretSource(
67:       master,
68:       genesis.ceremonyNonce,
69:       seat,
70:       owner.publicKey,
71:     );
72:     try {
73:       if (encodePoint(scalePoint(G, encryption.encryptionSecret())) !== owner.encryptionKey)
74:         return failure('master-encryption-key', 'Master does not reproduce the encryption key');
75:     } finally {
76:       encryption.dispose();
77:     }
78: 
79:     const beacon = initializeBeaconState({
80:       ...genesis,
81:       gameId: genesisId(genesis),
82:       signatures: [],
83:     });
84:     if (!beacon.ok) return beacon;
85:     const chain = beacon.value.chains.find((item) => item.seat === seat);
86:     if (chain) {
87:       const source = createBeaconSecretSource(
88:         master,
89:         { ceremonyId: deckCeremonyId(genesis), seat },
90:         chain.length,
91:       );
92:       try {
93:         if (toBase64Url(source.initialCommitment.tip) !== chain.tip)
94:           return failure('master-beacon-tip', 'Master does not reproduce the initial beacon tip');
95:       } finally {
96:         source.dispose();
97:       }
98:     }
99: 
100:     const expected = validateDeckGenesisCommitments(genesis);
101:     if (!expected.ok) return expected;
102:     const checked = validateDeckLedger(ledger);
103:     if (!checked.ok) return checked;
104:     if (
105:       checked.value.genesisDigest !== genesisDigest(genesis) ||
106:       !same(
107:         checked.value.decks.map((deck) => deck.commitment),
108:         expected.value,
109:       )
110:     )
111:       return failure('master-deck-context', 'Locked decks differ from the certified genesis');
112:     for (const deck of checked.value.decks) {
113:       if (deck.nextPass !== deck.commitment.passHashes.length)
114:         return failure('master-deck-pending', 'Master checks require completed deck setup');
115:       const index = deck.setup.definition.participants.findIndex((item) => item.seat === seat);
116:       if (index < 0)
117:         return failure('master-deck-context', 'Original seat is missing from a genesis deck');
118:       const source = createDeckSecretSource(master, deck.setup.definition, seat);
119:       try {
120:         if (encodePoint(scalePoint(G, source.shuffle())) !== deck.setup.shuffleKeys[index])
121:           return failure('master-shuffle-key', 'Master does not reproduce a deck shuffle key');
122:         const keys = deck.setup.lockKeys[index];
123:         if (
124:           !keys ||
125:           deck.setup.definition.cards.some(
126:             (_, position) => encodePoint(scalePoint(G, source.lock(position))) !== keys[position],
127:           )
128:         )
129:           return failure('master-lock-key', 'Master does not reproduce every deck lock key');
130:       } finally {
131:         source.dispose();
132:       }
133:     }
134:     return success(undefined);
135:   } catch {
```

## packages/protocol/src/log.ts
Lines 145-275:
```text
145:     return failure('sequencer-signature', 'Entry signature does not match the sequencer');
146:   const signer = resolveArtifactSigner(
147:     context.authority,
148:     context.genesis,
149:     context.crypto?.epoch ?? context.authority?.epoch ?? 0,
150:     sequencer.seat,
151:   );
152:   if (!signer.ok) return signer;
153:   if (!verifyObject('entry', entryBody(entry), entry.sig, parsePeerId(signer.value.publicKey)))
154:     return failure('sequencer-signature', 'Entry signature does not match the sequencer');
155:   if (
156:     context.recovery?.pending &&
157:     !['membership', 'control', 'cheat-proof'].includes(entry.payload.kind)
158:   )
159:     return failure('recovery-pending', 'Finish the certified takeover before resuming gameplay');
160:   try {
161:     const transition = validateCryptoTransition(
162:       context.genesis,
163:       context.crypto,
164:       context.engine,
165:       context.state,
166:       entry,
167:       policy.randomDerivations,
168:       context.authority,
169:     );
170:     if (!transition.ok) return transition;
171:     if (entry.payload.kind === 'membership') {
172:       const change = parseMembershipChange(entry.payload.change);
173:       if (!change.ok) return change;
174:       if (change.value.kind === 'seat-offline' || change.value.kind === 'seat-online') {
175:         const presence = validateSeatPresenceTransition(
176:           change.value,
177:           entry,
178:           context,
179:           transition.value.crypto,
180:         );
181:         if (!presence.ok) return presence;
182:         if (!context.transfer)
183:           return failure('transfer-history', 'Certified transfer routes are unavailable');
184:         return success({
185:           ...presence.value,
186:           transfer: {
187:             ...context.transfer,
188:             intentBarrier: { seq: entry.seq, hash: entryHash(entry) },
189:           },
190:           entry,
191:           hash: entryHash(entry),
192:           events: [],
193:           lastNonces: new Map(context.lastNonces),
194:         });
195:       }
196:       if (
197:         change.value.kind === 'transfer-authorize' ||
198:         change.value.kind === 'transfer-activate' ||
199:         change.value.kind === 'transfer-cancel'
200:       ) {
201:         const transferred = validateTransferTransition(
202:           change.value,
203:           entry,
204:           context,
205:           transition.value.crypto,
206:         );
207:         if (!transferred.ok) return transferred;
208:         if (!context.recovery)
209:           return failure('recovery-history', 'Certified recovery history is unavailable');
210:         const transferredSeats =
211:           change.value.kind === 'transfer-activate'
212:             ? change.value.statement.replacements.map((replacement) => replacement.seat)
213:             : [];
214:         const recovery =
215:           transferredSeats.length > 0
216:             ? {
217:                 ...context.recovery,
218:                 offline: context.recovery.offline.filter(
219:                   (marker) => !transferredSeats.includes(marker.seat),
220:                 ),
221:               }
222:             : context.recovery;
223:         return success({
224:           ...transferred.value,
225:           recovery,
226:           entry,
227:           hash: entryHash(entry),
228:           events: [],
229:           lastNonces: new Map(context.lastNonces),
230:         });
231:       }
232:       const recovered = validateRecoveryTransition(
233:         change.value,
234:         entry,
235:         context,
236:         transition.value.crypto,
237:       );
238:       if (!recovered.ok) return recovered;
239:       if (!context.transfer)
240:         return failure('transfer-history', 'Certified transfer routes are unavailable');
241:       const transfer = advanceTransferRecovery(
242:         context.transfer,
243:         context,
244:         entry,
245:         change.value,
246:         recovered.value.recovery,
247:       );
248:       if (!transfer.ok) return transfer;
249:       return success({
250:         ...recovered.value,
251:         transfer: transfer.value,
252:         entry,
253:         hash: entryHash(entry),
254:         events: [],
255:         lastNonces: new Map(context.lastNonces),
256:       });
257:     }
258:     if (entry.payload.kind === 'cheat-proof') {
259:       const priorHash = toHex(hashValue(context.state));
260:       if (priorHash !== context.head.stateHash || entry.stateHash !== priorHash)
261:         return failure('cheat-state', 'Cheat records must preserve the certified public state');
262:       const claim = entry.payload.claim;
263:       if (
264:         claim.evidence.at.seq >= context.head.seq &&
265:         !(
266:           claim.evidence.at.seq === context.head.seq &&
267:           claim.evidence.at.hash === entryHash(context.head)
268:         )
269:       )
270:         return failure('cheat-history', 'Cheat evidence parent is not in this certified context');
271:       const finding =
272:         claim.evidence.at.seq === context.head.seq &&
273:         claim.evidence.at.hash === entryHash(context.head)
274:           ? verifyCheatProof(claim, context)
275:           : (policy.verifyHistoricalCheat?.(claim) ??
```

## packages/protocol/src/p2p-session.ts
Lines 177-195:
```text
177:   } | null = null;
178:   private auditedHead: string | null = null;
179: 
180:   private constructor(
181:     private readonly options: P2PSessionOptions,
182:     private context: ProposalContext,
183:     private readonly driver: SessionDriver,
184:     private readonly genesisEntry: LogEntry,
185:   ) {
186:     this.keys.set(options.seat, new Uint8Array(options.secretKey));
187:     for (const [seat, key] of options.botKeys ?? []) this.keys.set(seat, new Uint8Array(key));
188:     if (context.log.state.result) this.status = { kind: 'complete' };
189:   }
190: 
191:   /**
192:    * First activation of a newly established game key only. The key owner must
193:    * retain it with this journal and use restore for every subsequent opening.
194:    * An empty replacement journal does not authorize reuse of an old raw key.
195:    */
```
Lines 1593-1610:
```text
1593:       intent.finishWait?.(failure('trade-proof-parent', 'The certified parent changed'));
1594:     this.clearAutomaticRetry();
1595:     this.clearBotTimer();
1596:     this.automaticParent = null;
1597:     this.automaticRetryDelay = 250;
1598:     if (this.protocolStatus?.kind === 'halted' || this.protocolStatus?.kind === 'rejected')
1599:       this.protocolStatus = null;
1600:     this.events.push(...entry.events);
1601:     this.status = next.log.state.result ? { kind: 'complete' } : { kind: 'running' };
1602:     this.schedulePrivateTimeout();
1603:     return success(undefined);
1604:   }
1605: 
1606:   private maybeAutomatic(): void {
1607:     if (
1608:       this.automaticScheduled ||
1609:       !this.replica ||
1610:       this.status.kind !== 'running' ||
```

## packages/protocol/src/audit-types.ts
Lines 1-37:
```text
1: import type { Seat } from '@cp2p/engine';
2: import type { CheatFinding } from './cheat-types.js';
3: 
4: export interface AuditEntryRef {
5:   readonly seq: number;
6:   readonly hash: string;
7: }
8: 
9: /** An authenticated inconsistency. A null seat makes no accusation about an owner. */
10: export interface AuditViolation {
11:   readonly seq: number;
12:   readonly seat: Seat | null;
13:   readonly kind: string;
14:   readonly detail: string;
15: }
16: 
17: /** Problems with supplied reveals are not findings against the original owner. */
18: export interface AuditInputError {
19:   readonly seat: Seat | null;
20:   readonly kind: string;
21: }
22: 
23: export interface AuditReport {
24:   readonly ok: boolean;
25:   readonly complete: boolean;
26:   readonly missingSeats: readonly Seat[];
27:   readonly violations: readonly AuditViolation[];
28:   readonly inputErrors: readonly AuditInputError[];
29:   readonly cheatFindings: readonly CheatFinding[];
30:   readonly terminal: AuditEntryRef | null;
31:   readonly finalHead: AuditEntryRef | null;
32:   readonly historyError: { readonly code: string } | null;
33:   /** Local reconstruction or engine failure, without attributing misconduct. */
34:   readonly auditError: { readonly seq: number; readonly code: string } | null;
35:   /** Hidden VP card counts, disclosed only after a complete successful audit. */
36:   readonly finalHiddenVictoryPoints: Partial<Record<Seat, number>> | null;
37: }
```

## packages/protocol/src/recovery-custody-mismatch.test.ts
Lines 50-172:
```text
50:   if (!owner) throw new Error('Missing original holder');
51:   const source = createStealSecretSource(
52:     scalarToBytes(BigInt(17 + seat)),
53:     fixture.genesis.ceremonyNonce,
54:     seat,
55:     owner.publicKey,
56:   );
57:   try {
58:     return source.encryptionSecret();
59:   } finally {
60:     source.dispose();
61:   }
62: }
63: 
64: test('certified shares expose a dealer master inconsistent with its signed beacon key before any activation check', async () => {
65:   // The dealer escrowed the master behind its signed masterPub, but derived its
66:   // signed beacon tip from another scalar. Feldman verification alone cannot
67:   // catch this at genesis.
68:   const fixture = createRecoveryFixture({
69:     masterBackedBeacon: true,
70:     misderivedBeaconSeat: 0,
71:   });
72:   const replacement = recoveryFixtureReplacement(84);
73:   try {
74:     const change = signRecoveryFixtureAuthorization(
75:       fixture,
76:       recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId),
77:       replacement.secretKey,
78:     );
79:     const entry = signRecoveryFixtureEntry(
80:       fixture,
81:       fixture.ready,
82:       { kind: 'membership', change },
83:       fixture.ready.log.head.stateHash,
84:     );
85:     const uncertified = certifyRecoveryFixtureEntry(fixture, fixture.ready, entry, [1, 2]);
86:     expect(validateCertifiedEntry(uncertified, fixture.ready).ok).toBe(false);
87:     const beforeAuthorization = await journal(fixture, fixture.deckEntries);
88:     const deniedStore = new MemoryGenesisConsentStore();
89:     const deniedWrite = vi.spyOn(deniedStore, 'putIfAbsent');
90:     expect(
91:       await prepareRecoveryRelease({
92:         journal: beforeAuthorization,
93:         engine: fixture.source.engine,
94:         policy: fixture.policy,
95:         genesisDigest: genesisDigest(fixture.genesis),
96:         dealerSeat: 0,
97:         holderSeat: 1,
98:         recipientSeat: 1,
99:         holderEncryptionSecret: holderEncryptionSecret(fixture, 1),
100:         holderSigningKey: recoveryFixtureKey(fixture, 1),
101:         entropy: new Uint8Array(32).fill(105),
102:         store: deniedStore,
103:       }),
104:     ).toMatchObject({ ok: false, error: { code: 'recovery-release-unauthorized' } });
105:     expect(deniedWrite).not.toHaveBeenCalled();
106: 
107:     const authorization = certifyRecoveryFixtureEntry(fixture, fixture.ready, entry, [1, 2, 3]);
108:     const authorized = advanceRecoveryFixture(fixture.ready, authorization);
109:     const local = await journal(fixture, [...fixture.deckEntries, authorization]);
110:     const releases = await Promise.all(
111:       ([1, 2, 3] as const).map(async (holderSeat) =>
112:         value(
113:           await prepareRecoveryRelease({
114:             journal: local,
115:             engine: fixture.source.engine,
116:             policy: fixture.policy,
117:             genesisDigest: genesisDigest(fixture.genesis),
118:             dealerSeat: 0,
119:             holderSeat,
120:             recipientSeat: 1,
121:             holderEncryptionSecret: holderEncryptionSecret(fixture, holderSeat),
122:             holderSigningKey: recoveryFixtureKey(fixture, holderSeat),
123:             entropy: new Uint8Array(32).fill(104 + holderSeat),
124:             store: new MemoryGenesisConsentStore(),
125:           }),
126:         ),
127:       ),
128:     );
129:     for (const release of releases) {
130:       expect(verifyRecoveryRelease(release, authorized.log).ok).toBe(true);
131:       expect(
132:         openRecoveryRelease(release, authorized.log, 1, holderEncryptionSecret(fixture, 1)).ok,
133:       ).toBe(true);
134:     }
135:     const master = value(
136:       recoverAuthorizedMaster(releases, authorized.log, 0, 1, holderEncryptionSecret(fixture, 1)),
137:     );
138:     expect(master).toEqual(scalarToBytes(17n));
139:     master.fill(0);
140: 
141:     const checks = new MemoryGenesisConsentStore();
142:     const checkWrite = vi.spyOn(checks, 'putIfAbsent');
143:     expect(
144:       await produceRecoveryCheckFromShares({
145:         journal: local,
146:         engine: fixture.source.engine,
147:         policy: fixture.policy,
148:         store: checks,
149:         localSeat: 1,
150:         signingKey: recoveryFixtureKey(fixture, 1),
151:         recipientEncryptionSecret: holderEncryptionSecret(fixture, 1),
152:         releases,
153:       }),
154:     ).toMatchObject({ ok: false, error: { code: 'master-beacon-tip' } });
155:     expect(checkWrite).not.toHaveBeenCalled();
156: 
157:     // An honest recoverer cannot provide its mandatory check, so this
158:     // otherwise signed activation lacks the required new-quorum evidence.
159:     const activation = signRecoveryFixtureActivation(fixture, authorized, authorization.entry);
160:     const attempted = signRecoveryFixtureEntry(
161:       fixture,
162:       authorized,
163:       { kind: 'membership', change: { ...activation, checks: activation.checks.slice(1) } },
164:       authorized.log.head.stateHash,
165:     );
166:     const certified = certifyRecoveryFixtureEntry(fixture, authorized, attempted, [1, 2, 3]);
167:     expect(validateCertifiedEntry(certified, authorized).ok).toBe(false);
168:     expect(authorized.log.recovery?.pending).not.toBeNull();
169:   } finally {
170:     replacement.secretKey.fill(0);
171:   }
172: }, 30_000);
```
