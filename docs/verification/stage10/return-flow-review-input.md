Review the following source-only patch for returning an original human after certified bot takeover. Do not use tools. Focus on concrete security or liveness defects, especially: retired original game-key provenance and secret wiping; signed invite mode/scope binding; source confirmation and private disclosure ordering; certified host-only return admission; stale/replayed return attempts; and same-device promotion. The protocol validator already requires the exact return lineage and signature, and a new game key is used after activation. Distinguish a blocking defect from an optional improvement. Cite file paths and exact relevant conditions. Do not assume any runtime keys or real game records are in this bundle.

=== PINNED SOURCE MANIFEST ===
c9004c21e3f0050f1aa3156a66f4bc07b89131350b26152a446d07fa5ea4eb99  apps/web/src/session/online-transfer-destination.ts
72f1a19508ca0c49af9124fce9fd37346b2f64f526e2dad399b42e504a43129e  apps/web/src/session/online-transfer-exchange.ts
2ae1b44a62d012556a4f2bc7658e4588bfab5cd8b9e7438ec2bb9fd9e7754bbb  apps/web/src/session/online-transfer-browser.ts
8d9db586fad7c02217450e3ab6dfc0c7893ac5fadae968ac33b7e4b2eb413c75  apps/web/src/session/online-transfer-link.ts
8af26beeb29b619f7e9d5158dad28aa1120893b27f66b9b2109366b4ad5d961d  apps/web/src/session/online-transfer-records.ts
643a461a7f3a3a20689a1335611f5c633151acc74a161542aed7963fa8c3702e  apps/web/src/session/online-room.ts
c0bb855829696f5e53c399b28a6901aebfdd062c79345d713e25fd2dff20cdef  apps/web/src/features/online/OnlineGameScreen.tsx
ce86b21bd46eb67cbf93da8982abaf0984ff9201f911f37ac4eb6919b3bd8916  packages/protocol/src/p2p-session.ts
c74544691e8d5735139da15040e5311ad461fbc83a06b2ce7b3b08b98970726d  packages/protocol/src/transfer-material.ts
d5f8624b5dba22e78a92961b265c78da31983d3b338017c32f15c209940d04ec  packages/protocol/src/transfer-membership.ts
74eeb2f9553a7f6d032c1297ae9a8e6262f1aaec3e50f48e7df9a9649c345b60  packages/protocol/src/transfer-readiness.ts

=== CURRENT PATCH ===
diff --git a/apps/web/src/features/online/OnlineGameScreen.tsx b/apps/web/src/features/online/OnlineGameScreen.tsx
index ecc86cd..5b76d07 100644
--- a/apps/web/src/features/online/OnlineGameScreen.tsx
+++ b/apps/web/src/features/online/OnlineGameScreen.tsx
@@ -172,6 +172,7 @@ function OnlineGameInstance({
   const snapshot = useSyncExternalStore(room.subscribe, room.getSnapshot, room.getSnapshot);
   const audit = useSessionStore((store) => store.audit);
   const status = useSessionStore((store) => store.status);
+  const headHash = useSessionStore((store) => store.fairness?.head.hash ?? null);
   const recoveryCandidate = useSessionStore((store) => store.recoveryCandidate);
   const { mutate: requestPersistentStorage } = useRequestPersistentStorage();
   const [attached, setAttached] = useState(false);
@@ -188,6 +189,24 @@ function OnlineGameInstance({
     if (voided) setVoidOpen(true);
   }, [voided]);
   const [transferBrowser, setTransferBrowser] = useState<OnlineTransferBrowser | null>(null);
+  const [returnSeats, setReturnSeats] = useState<readonly Seat[]>([]);
+  useEffect(() => {
+    let active = true;
+    if (!room.returnableSeats) return undefined;
+    void room.returnableSeats().then(
+      (seats) => {
+        if (active) setReturnSeats(seats);
+        return undefined;
+      },
+      () => {
+        if (active) setReturnSeats([]);
+        return undefined;
+      },
+    );
+    return () => {
+      active = false;
+    };
+  }, [room, headHash]);
   const sourceTransfer = useSourceTransfer(room);
   const transfer = useSyncExternalStore(
     (listener) => transferBrowser?.subscribe(listener) ?? (() => undefined),
@@ -359,10 +378,10 @@ function OnlineGameInstance({
       setBusy(false);
     }
   };
-  const openTransfer = async () => {
+  const openTransfer = async (target?: { readonly seat: Seat; readonly mode: 'return' }) => {
     setTransferOpen(true);
     try {
-      setTransferBrowser(await sourceTransfer.mutateAsync());
+      setTransferBrowser(await sourceTransfer.mutateAsync(target));
     } catch {
       // The mutation error is shown in the open dialog.
     }
@@ -444,6 +463,19 @@ function OnlineGameInstance({
                   {t('lobby:transferSourceTitle')}
                 </button>
               )}
+              {room.startTransfer &&
+                !halted &&
+                !voided &&
+                returnSeats.map((seat) => (
+                  <button
+                    key={seat}
+                    className="button button-quiet"
+                    type="button"
+                    onClick={() => void openTransfer({ seat, mode: 'return' })}
+                  >
+                    {t('lobby:transferReturnSourceTitle', { seat: seat + 1 })}
+                  </button>
+                ))}
             </>
           }
           sessionNotice={
@@ -562,12 +594,17 @@ function OnlineGameInstance({
       <dialog
         ref={transferDialog}
         className="app-dialog online-transfer-dialog"
-        aria-label={t('lobby:transferSourceTitle')}
+        aria-label={t(
+          transfer?.invite.body.mode === 'return'
+            ? 'lobby:transferReturnTitle'
+            : 'lobby:transferSourceTitle',
+        )}
         onCancel={() => setTransferOpen(false)}
       >
         {transfer && transferInvite ? (
           <TransferPanel
             role="source"
+            mode={transfer.invite.body.mode}
             invitationUrl={transferInvite}
             selfDevice={transfer.selfDevice}
             candidates={transfer.candidates}
diff --git a/apps/web/src/session/online-room.ts b/apps/web/src/session/online-room.ts
index 30b6d0e..bde4ccb 100644
--- a/apps/web/src/session/online-room.ts
+++ b/apps/web/src/session/online-room.ts
@@ -1,6 +1,6 @@
 import { hashValue, toHex } from '@cp2p/codec';
 import { failure, success } from '@cp2p/engine';
-import type { GameConfig, Result } from '@cp2p/engine';
+import type { GameConfig, Result, Seat } from '@cp2p/engine';
 import {
   answerManualOffer,
   createManualOffer,
@@ -822,11 +822,25 @@ export class OnlineRoom {
     };
   };
 
+  returnableSeats = async (): Promise<readonly Seat[]> => {
+    if (this.closing || !this.startup.game()) return [];
+    const result = await this.startup.transferClient().request({ kind: 'transferStatus' });
+    if (!result.ok) throw new Error(result.error.message);
+    return result.value.returnableSeats;
+  };
+
   startTransfer = (
     network: Pick<OnlineTransferLinkOptions, 'iceServers' | 'iceTransportPolicy'>,
+    target?: { readonly seat: Seat; readonly mode: 'live' | 'return' },
   ): Promise<OnlineTransferBrowser> => {
+    const game = this.startup.game();
+    if (this.closing || !game) return Promise.reject(new Error('Online game is unavailable'));
+    const seat = target?.seat ?? game.seat;
+    const mode = target?.mode ?? 'live';
     if (this.transfer && !this.transfer.getSnapshot().closed) {
       const snapshot = this.transfer.getSnapshot();
+      if (snapshot.invite.body.seat !== seat || snapshot.invite.body.mode !== mode)
+        return Promise.reject(new Error('Another transfer attempt is already open'));
       if (
         (snapshot.phase !== 'cancelled' && snapshot.phase !== 'cancelled-awaiting-receipt') ||
         snapshot.busy
@@ -835,19 +849,30 @@ export class OnlineRoom {
       void this.transfer.close();
     }
     if (this.transferOpening) return this.transferOpening;
-    const game = this.startup.game();
-    if (this.closing || !game) return Promise.reject(new Error('Online game is unavailable'));
-    this.transferOpening = OnlineTransferBrowser.openSource({
-      identity: this.identity,
-      store: this.store,
-      clock: this.clock,
-      worker: this.startup.transferClient(),
-      gameId: game.gameId,
-      genesisDigest: genesisDigest(game.genesis),
-      seat: game.seat,
-      serverUrl: this.invite.serverUrl,
-      network,
-    })
+    if (mode === 'live' && seat !== game.seat)
+      return Promise.reject(new Error('Live transfer must move this device’s active human'));
+    if (
+      mode === 'return' &&
+      (!game.genesis.seats.some((item) => item.seat === seat && item.kind === 'human') ||
+        game.session.getState().seats.find((item) => item.seat === seat)?.status !== 'bot')
+    )
+      return Promise.reject(new Error('Return target is not a recovered human seat'));
+    this.transferOpening = (async () => {
+      if (mode === 'return' && !(await this.returnableSeats()).includes(seat))
+        throw new Error('This device is not the certified host of that recovered seat');
+      return OnlineTransferBrowser.openSource({
+        identity: this.identity,
+        store: this.store,
+        clock: this.clock,
+        worker: this.startup.transferClient(),
+        gameId: game.gameId,
+        genesisDigest: genesisDigest(game.genesis),
+        seat,
+        mode,
+        serverUrl: this.invite.serverUrl,
+        network,
+      });
+    })()
       .then(async (transfer) => {
         if (this.closing) {
           await transfer.close();
diff --git a/apps/web/src/session/online-transfer-browser.ts b/apps/web/src/session/online-transfer-browser.ts
index 316531a..1630cbb 100644
--- a/apps/web/src/session/online-transfer-browser.ts
+++ b/apps/web/src/session/online-transfer-browser.ts
@@ -96,6 +96,7 @@ export class OnlineTransferBrowser {
       readonly gameId: string;
       readonly genesisDigest: string;
       readonly seat: Seat;
+      readonly mode?: 'live' | 'return';
       readonly serverUrl: string;
     },
   ): Promise<OnlineTransferBrowser> {
@@ -119,12 +120,17 @@ export class OnlineTransferBrowser {
         gameId: options.gameId,
         genesisDigest: options.genesisDigest,
         seat: options.seat,
+        mode: options.mode ?? 'live',
         serverUrl: options.serverUrl,
         attemptId: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
       });
       await saveCurrentTransferInvite(options.store, options.identity.peerId, invite);
     }
-    if (invite.body.genesisDigest !== options.genesisDigest || invite.body.seat !== options.seat)
+    if (
+      invite.body.genesisDigest !== options.genesisDigest ||
+      invite.body.seat !== options.seat ||
+      invite.body.mode !== (options.mode ?? 'live')
+    )
       throw new Error('Saved transfer invitation differs from this game and seat');
     const progress = await new OnlineTransferRecordStore(
       options.store,
@@ -374,6 +380,7 @@ export class OnlineTransferBrowser {
     const record = this.#record;
     if (!record) throw new Error('Transfer destination has not been selected');
     const common = {
+      mode: this.#snapshot.invite.body.mode,
       worker: this.options.worker,
       channel: {
         send: async (artifact: Parameters<OnlineTransferChannel['send']>[0]) => {
diff --git a/apps/web/src/session/online-transfer-destination.ts b/apps/web/src/session/online-transfer-destination.ts
index 29b52eb..608b11a 100644
--- a/apps/web/src/session/online-transfer-destination.ts
+++ b/apps/web/src/session/online-transfer-destination.ts
@@ -1,22 +1,26 @@
 import { canonicalDecode, canonicalEncode, sha256, toHex } from '@cp2p/codec';
 import { identityFromSecret, signObject } from '@cp2p/crypto';
-import { createBaseEngine } from '@cp2p/engine';
+import { createBaseEngine, success } from '@cp2p/engine';
 import type { Seat } from '@cp2p/engine';
 import {
   genesisDigest,
   importTransferPrivate,
+  initialProposalContext,
   replayCertifiedPrefix,
   restoreRetiredSafety,
   transferCheckDigest,
   transferEntryRef,
   TRANSFER_BOT_CHECK_DOMAIN,
   TRANSFER_DESTINATION_CHECK_DOMAIN,
+  TRANSFER_RETURN_INTENT_DOMAIN,
   transferAuthorizationStatementSchema,
   transferChangeSchema,
   transferPrivateEnvelopeSchema,
   validateDeckCeremony,
+  validateRetiredTransferBinding,
 } from '@cp2p/protocol';
 import type {
+  LogContext,
   ReplayPolicy,
   SeatTransferAuthorization,
   SeatTransferAuthorizationStatement,
@@ -41,6 +45,7 @@ import {
 
 const PROTOCOL = 'online-transfer-destination-v1';
 const MAX_REFRESHES = 8;
+const MAX_RETIRED_BINDING_BYTES = 16 * 1024;
 const token = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));
 const ref = v.strictObject({
   seq: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
@@ -131,6 +136,12 @@ function equal(left: Uint8Array, right: Uint8Array): boolean {
   return left.length === right.length && left.every((byte, index) => byte === right[index]);
 }
 
+function wipePrivate(value: unknown): void {
+  if (value instanceof Uint8Array) value.fill(0);
+  else if (Array.isArray(value)) value.forEach(wipePrivate);
+  else if (value && typeof value === 'object') Object.values(value).forEach(wipePrivate);
+}
+
 function wipeStage(stage: import('@cp2p/storage').TransferImportRecord | null): void {
   stage?.bindingBytes.fill(0);
   stage?.sealedPackage.fill(0);
@@ -786,6 +797,11 @@ export class OnlineTransferDestination {
           await this.#replace((current) => ({ ...current, scope: v.parse(scopeSchema, scope) }));
           this.#phase = 'offered';
         }
+        if (scope.mode === 'return')
+          return {
+            ...credentials.authorization,
+            returnIntent: await this.#returnIntent(credentials.authorization.statement),
+          };
         return credentials.authorization;
       } finally {
         credentials.dispose();
@@ -793,6 +809,74 @@ export class OnlineTransferDestination {
     });
   }
 
+  async #returnIntent(statement: SeatTransferAuthorizationStatement): Promise<{
+    signer: 'last-human-game-key';
+    sig: string;
+  }> {
+    const current = this.#bootstrap.replay.context.log;
+    const root = current.transfer?.returnRoots
+      .toReversed()
+      .find((item) => item.departedSeat === statement.seat);
+    if (
+      !root?.activation ||
+      root.lastHumanDevice !== this.#options.identity.peerId ||
+      statement.mode !== 'return'
+    )
+      throw new TypeError('Return requires the certified former human device');
+    const bytes = await this.#options.store.load(
+      `online-game/${this.#options.expected.genesisDigest}/keys`,
+    );
+    if (!bytes) throw new TypeError('Former human game binding is unavailable');
+    let decoded: unknown;
+    let owned: import('@cp2p/protocol').TransferOwnedMaterial | null = null;
+    try {
+      if (bytes.length > MAX_RETIRED_BINDING_BYTES)
+        throw new TypeError('Former human game binding is oversized');
+      decoded = canonicalDecode(bytes);
+      const initial = initialProposalContext(
+        this.#bootstrap.record.result.entry,
+        createBaseEngine(),
+        policyFor(this.#bootstrap),
+      );
+      if (!initial.ok) throw new TypeError(initial.error.message);
+      const humanSeat = statement.seat;
+      const controllerKey = (context: LogContext) =>
+        context.authority?.controllers.find((item) => item.seat === humanSeat)?.publicKey;
+      let installed: LogContext | null =
+        controllerKey(initial.value.log) === root.lastHumanGameKey ? initial.value.log : null;
+      let previous = controllerKey(initial.value.log);
+      const replayed = replayCertifiedPrefix(
+        this.#bootstrap.record.result.entry,
+        this.#bootstrap.entries,
+        createBaseEngine(),
+        policyFor(this.#bootstrap),
+        (_entry, next) => {
+          const key = controllerKey(next.log);
+          if (key !== previous && key === root.lastHumanGameKey) installed = next.log;
+          previous = key;
+          return success(undefined);
+        },
+      );
+      if (!replayed.ok || !installed)
+        throw new TypeError('Former human key lacks a certified installed generation');
+      this.#ensureActive();
+      const checked = validateRetiredTransferBinding(decoded, installed, current);
+      if (!checked.ok) throw new TypeError(checked.error.message);
+      owned = checked.value;
+      const human = owned.seats.find((seat) => seat.seat === humanSeat && seat.kind === 'human');
+      if (owned.devicePeer !== root.lastHumanDevice || human?.peerId !== root.lastHumanGameKey)
+        throw new TypeError('Former human binding differs from certified return lineage');
+      return {
+        signer: 'last-human-game-key',
+        sig: signObject(TRANSFER_RETURN_INTENT_DOMAIN, statement, human.signingKey),
+      };
+    } finally {
+      wipePrivate(owned);
+      wipePrivate(decoded);
+      bytes.fill(0);
+    }
+  }
+
   refreshBootstrap(bytes: Uint8Array): Promise<void> {
     return this.#run(async () => {
       if (this.#phase === 'promoted' || this.#phase === 'cancelled')
diff --git a/apps/web/src/session/online-transfer-exchange.ts b/apps/web/src/session/online-transfer-exchange.ts
index 1779749..09f1c9d 100644
--- a/apps/web/src/session/online-transfer-exchange.ts
+++ b/apps/web/src/session/online-transfer-exchange.ts
@@ -38,6 +38,8 @@ export interface TransferExchangeChannel {
 export type { OnlineTransferExchangeRecord } from './online-transfer-records.js';
 
 interface CommonOptions {
+  /** Signed temporary invitation mode; omitted only by older direct unit fixtures. */
+  readonly mode?: 'live' | 'return';
   readonly worker: TransferExchangeWorker;
   readonly channel: TransferExchangeChannel;
   readonly record: OnlineTransferExchangeRecord;
@@ -258,10 +260,12 @@ export class SourceTransferExchange extends Exchange {
       const offer = parsedChange(artifact.bytes);
       if (
         offer.kind !== 'transfer-authorize' ||
-        offer.statement.mode !== 'live' ||
+        offer.statement.mode !== (this.options.mode ?? 'live') ||
         offer.ownerIntent !== undefined ||
-        offer.returnIntent !== undefined ||
         offer.humanApprovals !== undefined ||
+        (offer.statement.mode === 'live'
+          ? offer.returnIntent !== undefined
+          : offer.returnIntent?.signer !== 'last-human-game-key') ||
         offer.statement.seat !== this.record.seat ||
         offer.statement.genesisDigest !== this.record.genesisDigest ||
         offer.statement.destination.devicePeer !== this.record.destinationDevice
@@ -327,13 +331,16 @@ export class SourceTransferExchange extends Exchange {
       if (!this.record.approved) {
         const status = value(await this.options.worker.request({ kind: 'transferStatus' }));
         if (status.pending) throw new TypeError('Another transfer is pending');
-        const approved = value(
-          await this.options.worker.request({
-            kind: 'authorizeLiveTransfer',
-            offer,
-            head: status.head,
-          }),
-        );
+        const approved =
+          offer.statement.mode === 'live'
+            ? value(
+                await this.options.worker.request({
+                  kind: 'authorizeLiveTransfer',
+                  offer,
+                  head: status.head,
+                }),
+              )
+            : offer;
         if (!equal(approved.statement, offer.statement))
           throw new TypeError('Source authorization changed the signed destination offer');
         await this.save({ ...this.record, approved });
@@ -723,7 +730,7 @@ export class DestinationTransferExchange extends Exchange {
       await this.options.worker.request({
         kind: 'prepareTransferOffer',
         seat: this.record.seat,
-        mode: 'live',
+        mode: this.options.mode ?? 'live',
       }),
     );
     if (
diff --git a/apps/web/src/session/online-transfer-link.ts b/apps/web/src/session/online-transfer-link.ts
index a4e903f..cdf4e94 100644
--- a/apps/web/src/session/online-transfer-link.ts
+++ b/apps/web/src/session/online-transfer-link.ts
@@ -16,8 +16,8 @@ import { createRoomId } from './online-invite.js';
 import { OnlineTransferChannel } from './online-transfer-channel.js';
 import type { OnlineTransferArtifact } from './online-transfer-channel.js';
 
-const INVITE_PROTOCOL = 'cp2p/online-transfer-invite/v4';
-const INVITE_DOMAIN = 'online-transfer-invite-v4';
+const INVITE_PROTOCOL = 'cp2p/online-transfer-invite/v6';
+const INVITE_DOMAIN = 'online-transfer-invite-v6';
 const SCOPE_DOMAIN = 'cp2p/online-transfer-channel/v1';
 const MAX_CODE_BYTES = 2_048;
 const token = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));
@@ -27,6 +27,7 @@ const bodySchema = v.strictObject({
   attemptId: token,
   gameId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22}$/)),
   seat: v.picklist([0, 1, 2, 3, 4, 5] as const),
+  mode: v.picklist(['live', 'return']),
   genesisDigest: token,
   sourceDevice: token,
   serverUrl: v.pipe(v.string(), v.maxLength(512)),
@@ -67,6 +68,7 @@ export function createTransferInvite(input: {
   readonly attemptId: string;
   readonly gameId: string;
   readonly seat: Seat;
+  readonly mode?: 'live' | 'return';
   readonly genesisDigest: string;
   readonly serverUrl: string;
   readonly identity: DisposableOnlineIdentity;
@@ -86,6 +88,7 @@ export function createTransferInvite(input: {
     attemptId: input.attemptId,
     gameId: input.gameId,
     seat: input.seat,
+    mode: input.mode ?? 'live',
     genesisDigest: input.genesisDigest,
     sourceDevice: input.identity.peerId,
     serverUrl: serverOrigin(input.serverUrl),
diff --git a/apps/web/src/session/online-transfer-records.ts b/apps/web/src/session/online-transfer-records.ts
index ac223af..2ae04d1 100644
--- a/apps/web/src/session/online-transfer-records.ts
+++ b/apps/web/src/session/online-transfer-records.ts
@@ -201,6 +201,8 @@ export class OnlineTransferRecordStore {
       record.attemptId !== body.attemptId ||
       record.gameId !== body.gameId ||
       record.seat !== body.seat ||
+      (record.offer !== null && record.offer.statement.mode !== body.mode) ||
+      (record.approved !== null && record.approved.statement.mode !== body.mode) ||
       record.genesisDigest !== body.genesisDigest ||
       record.sourceDevice !== body.sourceDevice ||
       (this.role === 'destination' && record.destinationDevice !== this.self)
diff --git a/packages/protocol/src/p2p-session.ts b/packages/protocol/src/p2p-session.ts
index 39f9840..3a953ce 100644
--- a/packages/protocol/src/p2p-session.ts
+++ b/packages/protocol/src/p2p-session.ts
@@ -804,6 +804,8 @@ export class P2PSession implements GameSession<CertifiedHistory> {
     statement?: unknown,
   ): {
     head: EntryRef;
+    /** Recovered original humans currently hosted by this local human controller. */
+    returnableSeats: readonly Seat[];
     pending: AuthorizedTransfer | null;
     matchedAuthorization: AuthorizedTransfer | null;
     expiredBeforeCertification: boolean;
@@ -858,6 +860,25 @@ export class P2PSession implements GameSession<CertifiedHistory> {
       throw new Error('Certified pending transfer authorization is unavailable');
     return {
       head: { seq: log.head.seq, hash: entryHash(log.head) },
+      returnableSeats:
+        log.authority?.controllers
+          .filter(
+            (controller) =>
+              controller.kind === 'bot' &&
+              controller.status === 'active' &&
+              controller.hostSeat === this.options.seat &&
+              log.genesis.seats.some(
+                (original) => original.seat === controller.seat && original.kind === 'human',
+              ) &&
+              transfer.returnRoots.some(
+                (root) =>
+                  root.departedSeat === controller.seat &&
+                  root.activation !== null &&
+                  root.finalAuthorization !== null,
+              ),
+          )
+          .map((controller) => controller.seat)
+          .toSorted((left, right) => left - right) ?? [],
       pending: pending ? copyCanonical(pending) : null,
       matchedAuthorization: matchedAuthorization ? copyCanonical(matchedAuthorization) : null,
       expiredBeforeCertification:

=== packages/protocol/src/transfer-material.ts:160-215 ===
160:       publicKey: seat.newPublicKey,
161:     })),
162:   });
163: }
164: 
165: /**
166:  * Check an old local binding before erasing it. Its controller context is the
167:  * certified generation that installed that key, while the later master context
168:  * supplies completed deck commitments. Later recovery-owned slots need not be
169:  * in this original binding. This result never authorizes an active destination.
170:  */
171: export function validateRetiredTransferBinding(
172:   value: unknown,
173:   controllerContext: LogContext,
174:   masterContext: LogContext,
175: ): Result<TransferOwnedMaterial> {
176:   const parsed = v.safeParse(materialSchema, value);
177:   if (!parsed.success)
178:     return failure('transfer-material-schema', 'Private import has an invalid bounded shape');
179:   if (
180:     genesisDigest(controllerContext.genesis) !== genesisDigest(masterContext.genesis) ||
181:     controllerContext.head.seq > masterContext.head.seq
182:   )
183:     return failure('transfer-material-history', 'Old binding belongs to another certified history');
184:   const human = controllerContext.authority?.controllers.find(
185:     (seat) => seat.seat === parsed.output.humanSeat,
186:   );
187:   const route = controllerContext.transfer?.routes.find((seat) => seat.seat === human?.seat);
188:   if (!human || human.kind !== 'human' || human.status !== 'active' || !route?.devicePeer)
189:     return failure('transfer-material-authority', 'Old binding has no certified human generation');
190:   const listed = new Set(parsed.output.seats.map((seat) => seat.seat));
191:   return validateMaterial(value, masterContext, {
192:     humanSeat: human.seat,
193:     devicePeer: route.devicePeer,
194:     seats:
195:       controllerContext.authority?.controllers.filter(
196:         (seat) => seat.status === 'active' && seat.hostSeat === human.seat && listed.has(seat.seat),
197:       ) ?? [],
198:   });
199: }

=== packages/protocol/src/transfer-membership.ts:135-185 ===
135:     change.ownerIntent ||
136:     Boolean(change.returnIntent) === Boolean(change.humanApprovals)
137:   )
138:     return failure('transfer-return', 'Recovered return needs one valid identity path');
139:   // A prior recovery root is permanently stale once this seat is recovered
140:   // again. Roots are appended only from certified recovery transitions, so
141:   // the last root for this seat is the current return lineage.
142:   const root = transfer.returnRoots
143:     .toReversed()
144:     .find((item) => item.departedSeat === statement.seat);
145:   if (
146:     !root ||
147:     root.activation === null ||
148:     !same(root.finalAuthorization, statement.recovery?.authorization) ||
149:     !same(root.activation, statement.recovery?.activation)
150:   )
151:     return failure('transfer-return-history', 'Certified recovery ancestry is unavailable');
152:   const eligible = root.affectedSeats.flatMap((seat) => {
153:     const item = authority.controllers.find((candidate) => candidate.seat === seat);
154:     return item?.kind === 'bot' && item.status === 'active' && item.hostSeat === controller.hostSeat
155:       ? [item]
156:       : [];
157:   });
158:   if (eligible[0]?.seat !== statement.seat)
159:     return failure(
160:       'transfer-return-roster',
161:       'Returned seat is not the first eligible recovered seat',
162:     );
163:   if (change.returnIntent) {
164:     if (
165:       !signed(
166:         TRANSFER_RETURN_INTENT_DOMAIN,
167:         statement,
168:         change.returnIntent.sig,
169:         root.lastHumanGameKey,
170:       )
171:     )
172:       return failure('transfer-return-intent', 'Last certified human key did not authorize return');
173:   } else if (
174:     !signedByAll(
175:       TRANSFER_HUMAN_APPROVAL_DOMAIN,
176:       statement,
177:       change.humanApprovals ?? [],
178:       members(authority),
179:     )
180:   )
181:     return failure('transfer-return-approval', 'Every current human must approve key-loss return');
182:   return success(eligible);
183: }
184: 
185: function validateFreshKeys(

=== packages/protocol/src/transfer-readiness.ts:1-35 ===
1: import { hashValue, toHex } from '@cp2p/codec';
2: import { failure, success } from '@cp2p/engine';
3: import type { Result } from '@cp2p/engine';
4: import * as v from 'valibot';
5: import type { EntryRef } from './beacon-state.js';
6: import { entryHash, genesisDigest } from './genesis.js';
7: import { validateGenesisOnlineStart } from './genesis-online-start.js';
8: import type { LogContext } from './log-types.js';
9: import {
10:   hashSchema,
11:   key32Schema,
12:   nonnegativeIntegerSchema,
13:   seatSchema,
14:   signature64Schema,
15: } from './schema-values.js';
16: import type { TransferState } from './transfer-types.js';
17: import type { Genesis, LogEntry } from './types.js';
18: 
19: export const TRANSFER_DEVICE_DOMAIN = 'seat-transfer-device-v1';
20: export const TRANSFER_GAME_KEY_DOMAIN = 'seat-transfer-game-key-v1';
21: export const TRANSFER_BOT_KEY_DOMAIN = 'seat-transfer-bot-key-v1';
22: export const TRANSFER_OWNER_GAME_DOMAIN = 'seat-transfer-owner-game-v1';
23: export const TRANSFER_OWNER_DEVICE_DOMAIN = 'seat-transfer-owner-device-v1';
24: export const TRANSFER_RETURN_INTENT_DOMAIN = 'seat-transfer-return-intent-v1';
25: export const TRANSFER_HUMAN_APPROVAL_DOMAIN = 'seat-transfer-human-approval-v1';
26: export const TRANSFER_DESTINATION_CHECK_DOMAIN = 'seat-transfer-dest-check-v1';
27: export const TRANSFER_BOT_CHECK_DOMAIN = 'seat-transfer-bot-check-v1';
28: 
29: export const transferRefSchema = v.strictObject({
30:   seq: nonnegativeIntegerSchema,
31:   hash: hashSchema,
32: });
33: export const transferReplacementSchema = v.strictObject({
34:   seat: seatSchema,
35:   oldPublicKey: key32Schema,

=== apps/web/src/session/online-transfer-destination.ts:725-860 ===
725:       authorization,
726:       outcome: this.#locator.outcome
727:         ? {
728:             authorization: { ...this.#locator.outcome.authorization },
729:             entry: { ...this.#locator.outcome.entry },
730:             outcome: this.#locator.outcome.outcome,
731:           }
732:         : null,
733:     };
734:   }
735: 
736:   prepareOffer(input: {
737:     readonly seat: Seat;
738:     readonly mode: TransferMode;
739:   }): Promise<SeatTransferAuthorization> {
740:     return this.#run(async () => {
741:       await this.#checkImportedCheckpoint(this.#bootstrap);
742:       if (this.#locator.importedSeat !== undefined && input.seat !== this.#locator.importedSeat)
743:         throw new TypeError('Transfer offer differs from imported full-save seat');
744:       if (this.#phase === 'promoted' || this.#phase === 'cancelled')
745:         throw new TypeError('Finalized transfer cannot prepare another offer');
746:       const scope: OnlineTransferCredentialScope =
747:         this.#locator.scope === null
748:           ? deriveScope(
749:               this.#bootstrap,
750:               this.#options.attemptId,
751:               this.#options.identity.peerId,
752:               input.seat,
753:               input.mode,
754:             )
755:           : this.#locator.scope;
756:       if (scope.seat !== input.seat || scope.mode !== input.mode)
757:         throw new TypeError('Transfer attempt is reserved for another seat or mode');
758:       const context = this.#bootstrap.replay.context.log;
759:       const pending = context.transfer?.pending;
760:       if (pending) {
761:         const outcome = await this.#imports.readOutcome(this.#options.expected.gameId, pending);
762:         if (outcome.kind !== 'missing')
763:           throw new TypeError('Transfer authorization was already finalized locally');
764:       }
765:       if (pending) {
766:         const approved = context.transfer?.authorizations.find((item) =>
767:           sameRef(item.entry, pending),
768:         );
769:         if (!approved) throw new TypeError('Certified transfer authorization is missing');
770:       } else if (
771:         !context.transfer?.recentHeads.some((item) => sameRef(item, scope.anchor)) ||
772:         context.head.seq > scope.validUntilSeq
773:       ) {
774:         throw new TypeError('Reserved transfer parent is no longer eligible');
775:       }
776:       this.#ensureActive();
777:       if (this.#locator.scope !== null) {
778:         const prior = await this.#options.store.load(credentialKey(scope));
779:         if (!prior) throw new TypeError('Reserved transfer credentials are missing');
780:         prior.fill(0);
781:       }
782:       const credentials = await prepareOnlineTransferCredentials({
783:         store: this.#options.store,
784:         identity: this.#options.identity,
785:         scope,
786:       });
787:       try {
788:         this.#ensureActive();
789:         if (pending) {
790:           const approved = context.transfer?.authorizations.find((item) =>
791:             sameRef(item.entry, pending),
792:           );
793:           if (!approved || !sameCanonical(approved.statement, credentials.authorization.statement))
794:             throw new TypeError('Certified authorization differs from reserved credentials');
795:         }
796:         if (this.#locator.scope === null) {
797:           await this.#replace((current) => ({ ...current, scope: v.parse(scopeSchema, scope) }));
798:           this.#phase = 'offered';
799:         }
800:         if (scope.mode === 'return')
801:           return {
802:             ...credentials.authorization,
803:             returnIntent: await this.#returnIntent(credentials.authorization.statement),
804:           };
805:         return credentials.authorization;
806:       } finally {
807:         credentials.dispose();
808:       }
809:     });
810:   }
811: 
812:   async #returnIntent(statement: SeatTransferAuthorizationStatement): Promise<{
813:     signer: 'last-human-game-key';
814:     sig: string;
815:   }> {
816:     const current = this.#bootstrap.replay.context.log;
817:     const root = current.transfer?.returnRoots
818:       .toReversed()
819:       .find((item) => item.departedSeat === statement.seat);
820:     if (
821:       !root?.activation ||
822:       root.lastHumanDevice !== this.#options.identity.peerId ||
823:       statement.mode !== 'return'
824:     )
825:       throw new TypeError('Return requires the certified former human device');
826:     const bytes = await this.#options.store.load(
827:       `online-game/${this.#options.expected.genesisDigest}/keys`,
828:     );
829:     if (!bytes) throw new TypeError('Former human game binding is unavailable');
830:     let decoded: unknown;
831:     let owned: import('@cp2p/protocol').TransferOwnedMaterial | null = null;
832:     try {
833:       if (bytes.length > MAX_RETIRED_BINDING_BYTES)
834:         throw new TypeError('Former human game binding is oversized');
835:       decoded = canonicalDecode(bytes);
836:       const initial = initialProposalContext(
837:         this.#bootstrap.record.result.entry,
838:         createBaseEngine(),
839:         policyFor(this.#bootstrap),
840:       );
841:       if (!initial.ok) throw new TypeError(initial.error.message);
842:       const humanSeat = statement.seat;
843:       const controllerKey = (context: LogContext) =>
844:         context.authority?.controllers.find((item) => item.seat === humanSeat)?.publicKey;
845:       let installed: LogContext | null =
846:         controllerKey(initial.value.log) === root.lastHumanGameKey ? initial.value.log : null;
847:       let previous = controllerKey(initial.value.log);
848:       const replayed = replayCertifiedPrefix(
849:         this.#bootstrap.record.result.entry,
850:         this.#bootstrap.entries,
851:         createBaseEngine(),
852:         policyFor(this.#bootstrap),
853:         (_entry, next) => {
854:           const key = controllerKey(next.log);
855:           if (key !== previous && key === root.lastHumanGameKey) installed = next.log;
856:           previous = key;
857:           return success(undefined);
858:         },
859:       );
860:       if (!replayed.ok || !installed)

=== apps/web/src/session/online-transfer-exchange.ts:225-390 ===
225:       if (this.record.approved) await this.retryNow();
226:     });
227:   }
228: 
229:   protected async handle(artifact: OnlineTransferArtifact): Promise<void> {
230:     if (artifact.kind === 'received') {
231:       const receipt = v.parse(receiptSchema, canonicalDecode(artifact.bytes));
232:       if (
233:         receipt.destinationDevice !== this.record.destinationDevice ||
234:         !this.record.authorization ||
235:         !sameRef(receipt.authorization, this.record.authorization)
236:       )
237:         throw new TypeError('Transfer receipt belongs to another destination or authorization');
238:       const status = value(
239:         await this.options.worker.request({
240:           kind: 'transferStatus',
241:           authorization: receipt.authorization,
242:         }),
243:       );
244:       if (
245:         !status.outcome ||
246:         status.outcome.outcome !== receipt.outcome ||
247:         !sameRef(status.outcome.entry, receipt.entry)
248:       )
249:         throw new TypeError('Transfer receipt has no matching certified outcome');
250:       this.setPhase(receipt.outcome);
251:       return;
252:     }
253:     if (
254:       this.phase === 'activated' ||
255:       this.phase === 'cancelled' ||
256:       this.phase === 'cancelled-awaiting-receipt'
257:     )
258:       return;
259:     if (artifact.kind === 'offer') {
260:       const offer = parsedChange(artifact.bytes);
261:       if (
262:         offer.kind !== 'transfer-authorize' ||
263:         offer.statement.mode !== (this.options.mode ?? 'live') ||
264:         offer.ownerIntent !== undefined ||
265:         offer.humanApprovals !== undefined ||
266:         (offer.statement.mode === 'live'
267:           ? offer.returnIntent !== undefined
268:           : offer.returnIntent?.signer !== 'last-human-game-key') ||
269:         offer.statement.seat !== this.record.seat ||
270:         offer.statement.genesisDigest !== this.record.genesisDigest ||
271:         offer.statement.destination.devicePeer !== this.record.destinationDevice
272:       )
273:         throw new TypeError('Transfer offer differs from the selected source and destination');
274:       if (this.record.offer && !equal(this.record.offer, offer))
275:         throw new TypeError('Transfer destination changed its signed offer');
276:       if (!this.record.offer) {
277:         verifyOfferKeys(offer);
278:         await this.save({ ...this.record, offer });
279:       }
280:       if (!this.record.approved) this.setPhase('awaiting-confirmation');
281:       else await this.retryNow();
282:       return;
283:     }
284:     if (artifact.kind !== 'readiness') throw new TypeError('Unexpected source transfer artifact');
285:     if (this.record.cancelRequested) {
286:       await this.cancelNow();
287:       return;
288:     }
289:     const readiness = parsedChange(artifact.bytes);
290:     const authorization = this.record.authorization;
291:     const approved = this.record.approved;
292:     if (
293:       readiness.kind !== 'transfer-activate' ||
294:       !authorization ||
295:       !approved ||
296:       !sameRef(readiness.statement.authorization, authorization) ||
297:       readiness.statement.destinationDevice !== this.record.destinationDevice ||
298:       readiness.statement.destinationGame !== approved.statement.destination.gamePeer
299:     )
300:       throw new TypeError('Readiness differs from this certified transfer');
301:     const status = value(
302:       await this.options.worker.request({ kind: 'transferStatus', authorization }),
303:     );
304:     if (status.outcome) {
305:       await this.deliverOutcome(status.outcome);
306:       return;
307:     }
308:     if (!status.pending || !sameRef(status.pending.entry, authorization))
309:       throw new TypeError('Transfer authorization is no longer pending');
310:     if (!sameRef(readiness.statement.parent, status.head)) {
311:       await this.sendBootstrap('authorized');
312:       this.setPhase('awaiting-readiness');
313:       return;
314:     }
315:     this.setPhase('awaiting-certification');
316:     value(
317:       await this.options.worker.request({
318:         kind: 'submitTransfer',
319:         change: readiness,
320:         head: status.head,
321:       }),
322:     );
323:     await this.retryNow();
324:   }
325: 
326:   confirm(): Promise<void> {
327:     return this.run(async () => {
328:       if (this.record.cancelRequested) throw new TypeError('Transfer cancellation was requested');
329:       const offer = this.record.offer;
330:       if (!offer) throw new TypeError('No signed destination offer awaits confirmation');
331:       if (!this.record.approved) {
332:         const status = value(await this.options.worker.request({ kind: 'transferStatus' }));
333:         if (status.pending) throw new TypeError('Another transfer is pending');
334:         const approved =
335:           offer.statement.mode === 'live'
336:             ? value(
337:                 await this.options.worker.request({
338:                   kind: 'authorizeLiveTransfer',
339:                   offer,
340:                   head: status.head,
341:                 }),
342:               )
343:             : offer;
344:         if (!equal(approved.statement, offer.statement))
345:           throw new TypeError('Source authorization changed the signed destination offer');
346:         await this.save({ ...this.record, approved });
347:       }
348:       await this.retryNow();
349:     });
350:   }
351: 
352:   retry(): Promise<void> {
353:     return this.run(() => this.retryNow());
354:   }
355: 
356:   private async retryNow(): Promise<void> {
357:     if (this.phase === 'activated' || this.phase === 'cancelled') return;
358:     if (this.record.cancelRequested) {
359:       await this.cancelNow();
360:       return;
361:     }
362:     const approved = this.record.approved;
363:     if (!approved) {
364:       if (this.record.offer) this.setPhase('awaiting-confirmation');
365:       else await this.sendBootstrap('bootstrap');
366:       return;
367:     }
368:     let authorization = this.record.authorization;
369:     let status = value(
370:       await this.options.worker.request({
371:         kind: 'transferStatus',
372:         statement: approved.statement,
373:         ...(authorization ? { authorization } : {}),
374:       }),
375:     );
376:     if (!authorization && status.matchedAuthorization)
377:       authorization = status.matchedAuthorization.entry;
378:     if (authorization && !this.record.authorization)
379:       await this.save({ ...this.record, authorization });
380:     if (authorization && status.outcome) {
381:       await this.deliverOutcome(status.outcome);
382:       return;
383:     }
384:     if (status.expiredBeforeCertification) {
385:       this.setPhase('cancelled');
386:       return;
387:     }
388:     if (!authorization) {
389:       if (status.pending && equal(status.pending.statement, approved.statement)) {
390:         authorization = status.pending.entry;
