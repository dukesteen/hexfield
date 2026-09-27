# Transfer worker and routing review

Read-only security and correctness review of the attached pinned source. Tools disabled. Do not request secrets or actual user data. Return concrete findings with file and line, severity, attack/failure trace, and minimal correction. Distinguish proved issues from assumptions. Also report no blocking findings if applicable.

Scope: the new online worker transfer RPCs, bounded request accounting, temporary transfer-data channel, verified device-route export, WebRTC frozen roster updates and chat route selection. Protocol v4 core, signed transfer membership, immutable private outbox/import, destination credential/stage/promotion cryptography already have separate reviews. Do not redesign consensus. Public bootstrap is independently verified in the worker, with a 16 MiB raw-byte bound. The destination participant owns fresh replacement keys; it creates no voter before its exact certified activation is atomically promoted. P2PSession source methods validate current owned human authority, exact current head for owner intent, affected bot custody and session retirement, detach entropy and suppress late private output. Those source/destination leaves are being verified separately and are not attached in this review.

Check these invariants:
- Main sees only public evidence, display state, signed offers/readiness and destination-sealed private packets. It cannot obtain signing/master/encryption keys via new RPCs.
- A pending destination cannot attach the game transport or submit a gameplay command. Promotion returns a gameId; ordinary resume must be opened in a new worker.
- Shutdown stops import/readiness and source private output, drains accepted work, wipes owned entropy and closes storage. Heavy bootstrap admission preserves control capacity and has a bounded separate pending slot.
- Worker route lists come only from certified replay. Pending offers or bad certificates never expand active device/chat membership. Old routes can carry bounded public catch-up only, never game commands or chat. The WebRTC roster setter is connection admission, not a certificate verifier.
- A separate authenticated transfer channel transports only fixed artifact kinds. It uses scope binding, bounded assembly, digest checking, one acknowledged chunk at a time, deadlines and disposal. It is not yet wired to a temporary signaling room or UI. Do not count that acknowledged missing caller as an implementation bug, but identify anything that would make the eventual caller unsafe or nonfunctional.
- Fresh/restore lifecycle, reentrancy during route callbacks, source retirement and network backpressure must remain correct.

Evidence: genuine worker-mediated destination authorization/import/restart/activation test passed; channel/client/runtime 18 tests passed; certified route test covers rejected certificate, pending destination denial, new route and old public catch-up. Full browser handoff and final v4 game acceptance remain pending. No claim of completed milestone is being made.


## apps/web/src/session/online-worker-messages.ts

```text
1: import type { CommandShape, GameEvent, LegalCommandSet, PrivateState, Seat } from '@cp2p/engine';
2: import type {
3:   Genesis,
4:   LobbyFreezeAgreement,
5:   LobbyState,
6:   RecoveryApprovalPreview,
7:   SeatTransferAuthorization,
8:   SessionUpdate,
9:   TransferPrivateEnvelope,
10: } from '@cp2p/protocol';
11: import type { OnlineInvite } from './online-invite.js';
12: import type { OnlineDeviceRoutes } from './online-game-transport.js';
13: import type { OnlineStartupSnapshot } from './online-startup.js';
14: import type { ExpectedOnlineTransferGame } from './online-transfer-bootstrap.js';
15: import type {
16:   OnlineTransferDestination,
17:   OnlineTransferDestinationSnapshot,
18: } from './online-transfer-destination.js';
19: 
20: export const ONLINE_WORKER_PROTOCOL = 'cp2p-online-worker-v1' as const;
21: export const MAX_ONLINE_WORKER_REQUEST_BYTES = 1_048_576;
22: export const MAX_ONLINE_WORKER_PENDING_REQUESTS = 16;
23: export const MAX_ONLINE_WORKER_SNAPSHOT_BYTES = 16 * 1024 * 1024;
24: 
25: export interface OnlineWorkerHead {
26:   readonly seq: number;
27:   readonly hash: string;
28: }
29: 
30: export type OnlineWorkerRequestBody =
31:   | {
32:       readonly kind: 'initializeTransfer';
33:       readonly self: string;
34:       readonly attemptId: string;
35:       readonly mode: 'new' | 'resume';
36:       readonly expected: ExpectedOnlineTransferGame;
37:       readonly bootstrapBytes?: Uint8Array;
38:     }
39:   | { readonly kind: 'transferSnapshot' }
40:   | { readonly kind: 'prepareTransferOffer'; readonly seat: Seat; readonly mode: 'live' | 'return' }
41:   | { readonly kind: 'refreshTransferBootstrap'; readonly bootstrapBytes: Uint8Array }
42:   | { readonly kind: 'importTransferPacket'; readonly packet: TransferPrivateEnvelope }
43:   | { readonly kind: 'prepareTransferReadiness' }
44:   | { readonly kind: 'observeTransferActivation'; readonly bootstrapBytes: Uint8Array }
45:   | { readonly kind: 'exportTransferBootstrap' }
46:   | {
47:       readonly kind: 'authorizeLiveTransfer';
48:       readonly offer: unknown;
49:       readonly head: OnlineWorkerHead;
50:     }
51:   | { readonly kind: 'submitTransfer'; readonly change: unknown; readonly head: OnlineWorkerHead }
52:   | { readonly kind: 'prepareTransferPrivate'; readonly authorization: OnlineWorkerHead }
53:   | {
54:       readonly kind: 'initialize';
55:       readonly self: string;
56:       readonly mode: 'fresh';
57:       readonly invite: OnlineInvite;
58:     }
59:   | {
60:       readonly kind: 'initialize';
61:       readonly self: string;
62:       readonly mode: 'resume';
63:       readonly gameId: string;
64:     }
65:   | {
66:       readonly kind: 'attachTransport';
67:       readonly self: string;
68:       readonly peers: readonly string[];
69:       readonly port: MessagePort;
70:     }
71:   | { readonly kind: 'pinFreeze'; readonly state: LobbyState }
72:   | { readonly kind: 'startCeremony'; readonly agreement: LobbyFreezeAgreement }
73:   | { readonly kind: 'retryStart' }
74:   | {
75:       readonly kind: 'validate';
76:       readonly seat: Seat;
77:       readonly head: OnlineWorkerHead;
78:       readonly command: CommandShape;
79:     }
80:   | {
81:       readonly kind: 'submit';
82:       readonly seat: Seat;
83:       readonly head: OnlineWorkerHead;
84:       readonly command: CommandShape;
85:     }
86:   | {
87:       readonly kind: 'setPrivateVisible';
88:       readonly visible: boolean;
89:       readonly visibilityToken: number;
90:     }
91:   | { readonly kind: 'exportSave' }
92:   | { readonly kind: 'retryAudit' }
93:   | { readonly kind: 'ackSession'; readonly snapshotId: number }
94:   | { readonly kind: 'approveRecoveryAuthorization'; readonly change: unknown }
95:   | { readonly kind: 'clearRecoveryApproval' }
96:   | {
97:       readonly kind: 'requestTakeover';
98:       readonly departedSeat: Seat;
99:       readonly botLevel: 'easy' | 'medium' | 'hard';
100:     }
101:   | { readonly kind: 'cancelPending'; readonly seat: Seat }
102:   | { readonly kind: 'shutdown' };
103: 
104: export interface OnlineWorkerRequest {
105:   readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
106:   readonly generation: string;
107:   readonly id: number;
108:   readonly body: OnlineWorkerRequestBody;
109: }
110: 
111: export interface OnlineWorkerResumeInfo {
112:   readonly gameId: string;
113:   readonly genesisDigest: string;
114:   readonly agreement: LobbyFreezeAgreement;
115:   readonly genesis: Genesis;
116:   /** Active human device routes derived from this device's certified journal. */
117:   readonly peers: readonly string[];
118: }
119: 
120: export interface OnlineWorkerInitialization {
121:   readonly self: string;
122:   readonly invite: OnlineInvite;
123:   readonly resume: OnlineWorkerResumeInfo | null;
124: }
125: 
126: export interface OnlineWorkerReplyByKind {
127:   initializeTransfer: OnlineTransferDestinationSnapshot;
128:   transferSnapshot: OnlineTransferDestinationSnapshot;
129:   prepareTransferOffer: SeatTransferAuthorization;
130:   refreshTransferBootstrap: OnlineTransferDestinationSnapshot;
131:   importTransferPacket: OnlineTransferDestinationSnapshot;
132:   prepareTransferReadiness: Awaited<ReturnType<OnlineTransferDestination['prepareReadiness']>>;
133:   observeTransferActivation: string;
134:   exportTransferBootstrap: Uint8Array;
135:   authorizeLiveTransfer: SeatTransferAuthorization;
136:   submitTransfer: void;
137:   prepareTransferPrivate: TransferPrivateEnvelope;
138:   initialize: OnlineWorkerInitialization;
139:   attachTransport: void;
140:   pinFreeze: { readonly freezeHash: string };
141:   startCeremony: void;
142:   retryStart: void;
143:   validate: void;
144:   submit: void;
145:   setPrivateVisible: void;
146:   exportSave: unknown;
147:   retryAudit: boolean;
148:   ackSession: void;
149:   approveRecoveryAuthorization: RecoveryApprovalPreview;
150:   clearRecoveryApproval: void;
151:   requestTakeover: void;
152:   cancelPending: boolean;
153:   shutdown: void;
154: }
155: 
156: export type OnlineWorkerReply = {
157:   [K in keyof OnlineWorkerReplyByKind]: {
158:     readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
159:     readonly generation: string;
160:     readonly id: number;
161:     readonly kind: K;
162:     readonly result:
163:       | { readonly ok: true; readonly value: OnlineWorkerReplyByKind[K] }
164:       | {
165:           readonly ok: false;
166:           readonly error: {
167:             readonly code: string;
168:             readonly message: string;
169:             readonly savedVersion?: number;
170:           };
171:         };
172:   };
173: }[keyof OnlineWorkerReplyByKind];
174: 
175: /** A complete public snapshot. `events` is full history, unlike `update.events`. */
176: export interface OnlineWorkerSessionSnapshot {
177:   readonly committedHead: OnlineWorkerHead;
178:   readonly update: SessionUpdate;
179:   readonly events: readonly GameEvent[];
180:   readonly localHumanSeat: Seat;
181:   readonly privateState: PrivateState | null;
182:   readonly legal: LegalCommandSet | null;
183:   readonly controllableSeats: readonly Seat[];
184:   readonly visibilityToken: number;
185: }
186: 
187: export type OnlineWorkerEvent =
188:   | {
189:       readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
190:       readonly generation: string;
191:       readonly kind: 'deviceRoutes';
192:       readonly routes: OnlineDeviceRoutes;
193:     }
194:   | {
195:       readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
196:       readonly generation: string;
197:       readonly kind: 'startup';
198:       readonly snapshot: OnlineStartupSnapshot | null;
199:     }
200:   | {
201:       readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
202:       readonly generation: string;
203:       readonly kind: 'gameReady';
204:       readonly game: { readonly gameId: string; readonly genesis: Genesis; readonly seat: Seat };
205:     }
206:   | {
207:       readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
208:       readonly generation: string;
209:       readonly kind: 'session';
210:       readonly snapshotId: number;
211:       readonly snapshot: OnlineWorkerSessionSnapshot;
212:     }
213:   | {
214:       readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
215:       readonly generation: string;
216:       readonly kind: 'fatal';
217:       readonly error: { readonly code: string; readonly message: string };
218:     };
```


## apps/web/src/session/online-worker-request-size.ts

```text
1: import { canonicalEncode } from '@cp2p/codec';
2: import {
3:   MAX_ONLINE_WORKER_REQUEST_BYTES,
4:   MAX_ONLINE_WORKER_SNAPSHOT_BYTES,
5: } from './online-worker-messages.js';
6: import type { OnlineWorkerRequestBody } from './online-worker-messages.js';
7: 
8: /** One bounded public bootstrap has a separate slot so it cannot starve control messages. */
9: export function onlineWorkerRequestSize(body: OnlineWorkerRequestBody): {
10:   bytes: number;
11:   bootstrap: boolean;
12: } {
13:   const bootstrap =
14:     body.kind === 'initializeTransfer' ||
15:     body.kind === 'refreshTransferBootstrap' ||
16:     body.kind === 'observeTransferActivation';
17:   if (bootstrap) {
18:     const payload = body.bootstrapBytes;
19:     if (
20:       (payload !== undefined &&
21:         (!(payload instanceof Uint8Array) ||
22:           payload.byteLength > MAX_ONLINE_WORKER_SNAPSHOT_BYTES)) ||
23:       (payload === undefined && body.kind !== 'initializeTransfer')
24:     )
25:       throw new RangeError('Transfer bootstrap exceeds the worker request limit');
26:     const metadata = { ...body, bootstrapBytes: null };
27:     const metadataBytes = canonicalEncode(metadata).byteLength;
28:     if (metadataBytes > 65_536) throw new RangeError('Transfer request metadata exceeds its limit');
29:     // MessagePort clones this byte array directly. Do not base64-encode the
30:     // already bounded public artifact merely to account for its memory budget.
31:     return { bytes: metadataBytes + (payload?.byteLength ?? 0), bootstrap: true };
32:   }
33:   const bytes = canonicalEncode(
34:     body.kind === 'attachTransport' ? { ...body, port: null } : body,
35:   ).byteLength;
36:   if (bytes > MAX_ONLINE_WORKER_REQUEST_BYTES)
37:     throw new RangeError('Worker request exceeds its size limit');
38:   return { bytes, bootstrap: false };
39: }
```


## apps/web/src/session/online-worker-runtime.ts

```text
1: import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
2: import { createBaseEngine, success } from '@cp2p/engine';
3: import { verifyLobbyFreezeAgreement } from '@cp2p/protocol';
4: import type { ProtocolClock, SessionUpdate, Unsubscribe } from '@cp2p/protocol';
5: import { IndexedDbByteStore } from '@cp2p/storage';
6: import { loadOnlineIdentity } from './online-credentials.js';
7: import type { DisposableOnlineIdentity } from './online-credentials.js';
8: import { validateOnlineInvite } from './online-invite.js';
9: import type { OnlineInvite } from './online-invite.js';
10: import { loadOnlineGameRecord } from './online-game-records.js';
11: import type { SavedOnlineGameRecord } from './online-game-records.js';
12: import { loadActiveOnlineResume } from './online-resume-binding.js';
13: import { OnlineStartup, pinOnlineFreeze } from './online-startup.js';
14: import { encodeOnlineTransferBootstrap } from './online-transfer-bootstrap.js';
15: import { OnlineTransferDestination } from './online-transfer-destination.js';
16: import { browserEntropy, randomSeed } from './random.js';
17: import { createWorkerDeviceTransport } from './online-worker-transport.js';
18: import { onlineWorkerRequestSize } from './online-worker-request-size.js';
19: import {
20:   MAX_ONLINE_WORKER_REQUEST_BYTES,
21:   MAX_ONLINE_WORKER_PENDING_REQUESTS,
22:   MAX_ONLINE_WORKER_SNAPSHOT_BYTES,
23:   ONLINE_WORKER_PROTOCOL,
24: } from './online-worker-messages.js';
25: import type {
26:   OnlineWorkerEvent,
27:   OnlineWorkerReply,
28:   OnlineWorkerReplyByKind,
29:   OnlineWorkerRequest,
30:   OnlineWorkerRequestBody,
31:   OnlineWorkerSessionSnapshot,
32: } from './online-worker-messages.js';
33: 
34: type WorkerTransport = ReturnType<typeof createWorkerDeviceTransport>;
35: type WorkerStore = Pick<
36:   IndexedDbByteStore,
37:   'load' | 'putIfAbsent' | 'compareAndSwap' | 'withCeremonyLock' | 'close'
38: >;
39: 
40: export interface OnlineWorkerRuntimeOptions {
41:   readonly emit: (event: OnlineWorkerEvent) => void;
42:   readonly store?: WorkerStore;
43:   readonly clock?: ProtocolClock;
44: }
45: 
46: function workerClock(): ProtocolClock {
47:   const epoch = Date.now();
48:   const started = performance.now();
49:   return {
50:     now: () => epoch + performance.now() - started,
51:     setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
52:     clearTimeout: (handle) => {
53:       if (typeof handle === 'number') globalThis.clearTimeout(handle);
54:     },
55:   };
56: }
57: 
58: function copyPublic<T>(value: T): T {
59:   // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Canonical encoding detaches only public evidence and snapshots.
60:   return canonicalDecode(canonicalEncode(value)) as T;
61: }
62: 
63: function errorResult(error: unknown): {
64:   ok: false;
65:   error: { code: string; message: string; savedVersion?: number };
66: } {
67:   const code =
68:     typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
69:       ? error.code
70:       : 'online-worker';
71:   const message = error instanceof Error ? error.message : 'Online worker request failed';
72:   const savedVersion =
73:     typeof error === 'object' &&
74:     error !== null &&
75:     'savedVersion' in error &&
76:     typeof error.savedVersion === 'number'
77:       ? error.savedVersion
78:       : undefined;
79:   return {
80:     ok: false,
81:     error: savedVersion === undefined ? { code, message } : { code, message, savedVersion },
82:   };
83: }
84: 
85: /** Owns one room's certified online ceremony and session, never exposing its keys to main. */
86: export class OnlineWorkerRuntime {
87:   private readonly store: WorkerStore;
88:   private readonly clock: ProtocolClock;
89:   private readonly emit: (event: OnlineWorkerEvent) => void;
90:   private generation: string | null = null;
91:   private lastId = 0;
92:   private pending = 0;
93:   private pendingBytes = 0;
94:   private pendingBootstrap = false;
95:   private work: Promise<void> = Promise.resolve();
96:   private readonly sessionWork = new Set<Promise<unknown>>();
97:   private identity: DisposableOnlineIdentity | null = null;
98:   private invite: OnlineInvite | null = null;
99:   private resume: SavedOnlineGameRecord | null = null;
100:   private transport: WorkerTransport | null = null;
101:   private startup: OnlineStartup | null = null;
102:   private destination: OnlineTransferDestination | null = null;
103:   private sessionUnsubscribe: Unsubscribe | null = null;
104:   private startupUnsubscribe: Unsubscribe | null = null;
105:   private gameAnnounced = false;
106:   private lastUpdate: SessionUpdate | null = null;
107:   private pinnedFreezeHash: string | null = null;
108:   private visible = true;
109:   private visibilityToken = 0;
110:   private lastSnapshotId = 0;
111:   private unackedSnapshotId: number | null = null;
112:   private queuedSnapshot: OnlineWorkerSessionSnapshot | null = null;
113:   private closed = false;
114:   private closing: Promise<void> | null = null;
115: 
116:   constructor(options: OnlineWorkerRuntimeOptions) {
117:     this.store = options.store ?? new IndexedDbByteStore();
118:     this.clock = options.clock ?? workerClock();
119:     this.emit = options.emit;
120:   }
121: 
122:   /** Request IDs are one-way and generation-scoped; shutdown bypasses queued work. */
123:   handle(request: OnlineWorkerRequest): Promise<OnlineWorkerReply> {
124:     if (
125:       request.protocol !== ONLINE_WORKER_PROTOCOL ||
126:       !Number.isSafeInteger(request.id) ||
127:       request.id <= this.lastId ||
128:       typeof request.generation !== 'string' ||
129:       request.generation.length < 1 ||
130:       request.generation.length > 256 ||
131:       (this.generation !== null && request.generation !== this.generation)
132:     )
133:       return Promise.resolve(this.reply(request, errorResult(new Error('Stale worker request'))));
134:     if (this.generation === null) this.generation = request.generation;
135:     this.lastId = request.id;
136:     if (request.body.kind === 'shutdown') {
137:       return this.close().then(
138:         () => this.reply(request, success(undefined)),
139:         (error: unknown) => this.reply(request, errorResult(error)),
140:       );
141:     }
142:     let bytes: number;
143:     let bootstrap: boolean;
144:     try {
145:       ({ bytes, bootstrap } = onlineWorkerRequestSize(request.body));
146:     } catch {
147:       return Promise.resolve(
148:         this.reply(request, errorResult(new Error('Malformed worker request'))),
149:       );
150:     }
151:     const control =
152:       request.body.kind === 'ackSession' ||
153:       request.body.kind === 'setPrivateVisible' ||
154:       request.body.kind === 'cancelPending';
155:     const countLimit = control
156:       ? MAX_ONLINE_WORKER_PENDING_REQUESTS
157:       : MAX_ONLINE_WORKER_PENDING_REQUESTS - 4;
158:     const byteLimit = control
159:       ? MAX_ONLINE_WORKER_REQUEST_BYTES
160:       : MAX_ONLINE_WORKER_REQUEST_BYTES - 65_536;
161:     if (
162:       this.closed ||
163:       this.pending >= countLimit ||
164:       (bootstrap ? this.pendingBootstrap : this.pendingBytes + bytes > byteLimit)
165:     )
166:       return Promise.resolve(
167:         this.reply(request, errorResult(new Error('Worker is closed or busy'))),
168:       );
169:     this.pending += 1;
170:     if (bootstrap) this.pendingBootstrap = true;
171:     else this.pendingBytes += bytes;
172:     const lifecycle = [
173:       'initialize',
174:       'initializeTransfer',
175:       'prepareTransferOffer',
176:       'refreshTransferBootstrap',
177:       'importTransferPacket',
178:       'prepareTransferReadiness',
179:       'observeTransferActivation',
180:       'transferSnapshot',
181:       'attachTransport',
182:       'pinFreeze',
183:       'startCeremony',
184:       'retryStart',
185:     ].includes(request.body.kind);
186:     const operation = async () => {
187:       if (this.closed) throw new Error('Worker is closed');
188:       return this.dispatch(request.body);
189:     };
190:     const result = lifecycle ? this.work.then(operation) : Promise.resolve().then(operation);
191:     if (lifecycle)
192:       this.work = result.then(
193:         () => undefined,
194:         () => undefined,
195:       );
196:     else {
197:       this.sessionWork.add(result);
198:       void result.finally(() => this.sessionWork.delete(result)).catch(() => undefined);
199:     }
200:     return result
201:       .then(
202:         (value) => this.reply(request, success(value)),
203:         (error: unknown) => this.reply(request, errorResult(error)),
204:       )
205:       .finally(() => {
206:         this.pending -= 1;
207:         if (bootstrap) this.pendingBootstrap = false;
208:         else this.pendingBytes -= bytes;
209:       });
210:   }
211: 
212:   private reply(
213:     request: OnlineWorkerRequest,
214:     result:
215:       | { ok: true; value: unknown }
216:       | { ok: false; error: { code: string; message: string; savedVersion?: number } },
217:   ): OnlineWorkerReply {
218:     const reply = {
219:       protocol: ONLINE_WORKER_PROTOCOL,
220:       generation: request.generation,
221:       id: request.id,
222:       kind: request.body.kind,
223:       result,
224:     };
225:     // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dispatch fixes the response value for each request kind.
226:     return reply as OnlineWorkerReply;
227:   }
228: 
229:   private async dispatch(body: OnlineWorkerRequestBody): Promise<unknown> {
230:     switch (body.kind) {
231:       case 'initializeTransfer':
232:         return this.initializeTransfer(body);
233:       case 'transferSnapshot':
234:         return this.requireDestination().snapshot();
235:       case 'prepareTransferOffer':
236:         return this.transferResult(this.requireDestination().prepareOffer(body));
237:       case 'refreshTransferBootstrap':
238:         await this.transferResult(this.requireDestination().refreshBootstrap(body.bootstrapBytes));
239:         return this.requireDestination().snapshot();
240:       case 'importTransferPacket':
241:         await this.transferResult(this.requireDestination().importPacket(body.packet));
242:         return this.requireDestination().snapshot();
243:       case 'prepareTransferReadiness':
244:         return this.transferResult(this.requireDestination().prepareReadiness());
245:       case 'observeTransferActivation':
246:         return this.transferResult(
247:           this.requireDestination().observeActivation(body.bootstrapBytes),
248:         );
249:       case 'exportTransferBootstrap': {
250:         const session = this.requireSession();
251:         const gameId = this.requireStartup().game()?.gameId;
252:         if (!gameId) throw new Error('Online game is not active');
253:         const start = await loadOnlineGameRecord(this.store, gameId);
254:         if (!start || this.closed) throw new Error('Public online start is unavailable');
255:         const result = encodeOnlineTransferBootstrap({
256:           start,
257:           entries: session.exportSave().entries,
258:         });
259:         if (!result.ok)
260:           throw Object.assign(new Error(result.error.message), { code: result.error.code });
261:         return result.value;
262:       }
263:       case 'authorizeLiveTransfer': {
264:         const result = await this.transferResult(
265:           this.requireSession().authorizeLiveTransfer(body.offer, body.head),
266:         );
267:         if (!result.ok)
268:           throw Object.assign(new Error(result.error.message), { code: result.error.code });
269:         return result.value;
270:       }
271:       case 'submitTransfer': {
272:         this.requireHead(body.head);
273:         const result = await this.transferResult(this.requireSession().submitTransfer(body.change));
274:         if (!result.ok)
275:           throw Object.assign(new Error(result.error.message), { code: result.error.code });
276:         return undefined;
277:       }
278:       case 'prepareTransferPrivate': {
279:         const entropy = randomSeed(browserEntropy);
280:         let nonce: Uint8Array | undefined;
281:         try {
282:           nonce = randomSeed(browserEntropy);
283:           const result = await this.transferResult(
284:             this.requireSession().prepareTransferPrivate(body.authorization, entropy, nonce),
285:           );
286:           if (!result.ok)
287:             throw Object.assign(new Error(result.error.message), { code: result.error.code });
288:           return result.value;
289:         } finally {
290:           entropy.fill(0);
291:           nonce?.fill(0);
292:         }
293:       }
294:       case 'initialize':
295:         return this.initialize(body);
296:       case 'attachTransport':
297:         return this.attachTransport(body);
298:       case 'pinFreeze':
299:         return this.pinFreeze(body.state);
300:       case 'startCeremony':
301:         return this.startCeremony(body.agreement);
302:       case 'retryStart': {
303:         const retried = await this.requireStartup().retryFailed();
304:         if (!retried.ok) throw new Error(retried.error.message);
305:         return undefined;
306:       }
307:       case 'validate':
308:       case 'submit': {
309:         const session = this.requireSession();
310:         this.requireHead(body.head);
311:         if (body.seat !== this.requireStartup().game()?.seat)
312:           throw new Error('Only the local human seat accepts UI commands');
313:         const result =
314:           body.kind === 'validate'
315:             ? session.validate(body.seat, body.command)
316:             : await session.submit(body.seat, body.command, { expectedRevision: body.head.seq });
317:         if (!result.ok)
318:           throw Object.assign(new Error(result.error.message), { code: result.error.code });
319:         return undefined;
320:       }
321:       case 'setPrivateVisible':
322:         if (
323:           !Number.isSafeInteger(body.visibilityToken) ||
324:           body.visibilityToken <= this.visibilityToken
325:         )
326:           throw new Error('Private visibility token must increase');
327:         this.visibilityToken = body.visibilityToken;
328:         this.visible = body.visible;
329:         this.publishSession();
330:         return undefined;
331:       case 'exportSave': {
332:         const history = this.requireSession().exportSave();
333:         if (canonicalEncode(history).byteLength > MAX_ONLINE_WORKER_SNAPSHOT_BYTES)
334:           throw new Error('Certified history exceeds the worker export limit');
335:         return history;
336:       }
337:       case 'retryAudit':
338:         return this.requireSession().retryAudit();
339:       case 'ackSession':
340:         if (body.snapshotId !== this.unackedSnapshotId)
341:           throw new Error('Session snapshot acknowledgement is stale');
342:         this.unackedSnapshotId = null;
343:         if (this.queuedSnapshot) {
344:           const next = this.queuedSnapshot;
345:           this.queuedSnapshot = null;
346:           this.sendSessionSnapshot(next);
347:         }
348:         return undefined;
349:       case 'approveRecoveryAuthorization': {
350:         const result = await this.requireSession().approveRecoveryAuthorization(body.change);
351:         if (!result.ok)
352:           throw Object.assign(new Error(result.error.message), { code: result.error.code });
353:         return result.value;
354:       }
355:       case 'clearRecoveryApproval':
356:         this.requireSession().clearRecoveryApproval();
357:         return undefined;
358:       case 'requestTakeover': {
359:         const result = await this.requireSession().requestTakeover(
360:           body.departedSeat,
361:           body.botLevel,
362:         );
363:         if (!result.ok)
364:           throw Object.assign(new Error(result.error.message), { code: result.error.code });
365:         return undefined;
366:       }
367:       case 'cancelPending':
368:         if (body.seat !== this.requireStartup().game()?.seat)
369:           throw new Error('Only the local human seat can cancel a UI command');
370:         return this.requireSession().cancelPending(body.seat);
371:       case 'shutdown':
372:         return undefined;
373:     }
374:     return undefined;
375:   }
376: 
377:   private async initialize(
378:     body: Extract<OnlineWorkerRequestBody, { kind: 'initialize' }>,
379:   ): Promise<OnlineWorkerReplyByKind['initialize']> {
380:     if (this.identity || this.transport || this.startup)
381:       throw new Error('Worker already initialized');
382:     const identity = await loadOnlineIdentity(this.store);
383:     if (this.closed) {
384:       identity.dispose();
385:       throw new Error('Worker closed while loading identity');
386:     }
387:     if (identity.peerId !== body.self) {
388:       identity.dispose();
389:       throw new Error('Stored device identity differs from authenticated transport');
390:     }
391:     let resume: SavedOnlineGameRecord | null = null;
392:     let resumePeers: readonly string[] = [];
393:     let invite: OnlineInvite;
394:     try {
395:       if (body.mode === 'resume') {
396:         resume = await loadOnlineGameRecord(this.store, body.gameId);
397:         if (!resume) throw new Error('Saved online game is missing');
398:         invite = validateOnlineInvite(resume.invite);
399:         const active = await loadActiveOnlineResume({
400:           store: this.store,
401:           record: resume,
402:           devicePeer: body.self,
403:           engine: createBaseEngine(),
404:         });
405:         resumePeers = active.peers;
406:       } else invite = validateOnlineInvite(body.invite);
407:       if (this.closed) throw new Error('Worker closed while loading saved game');
408:       this.identity = identity;
409:       this.invite = copyPublic(invite);
410:       this.resume = resume;
411:       return {
412:         self: identity.peerId,
413:         invite: copyPublic(invite),
414:         resume: resume
415:           ? {
416:               gameId: resume.gameId,
417:               genesisDigest: resume.genesisDigest,
418:               agreement: copyPublic(resume.agreement),
419:               genesis: copyPublic(resume.result.genesis),
420:               peers: [...resumePeers],
421:             }
422:           : null,
423:       };
424:     } catch (error) {
425:       identity.dispose();
426:       throw error;
427:     }
428:   }
429: 
430:   private async initializeTransfer(
431:     body: Extract<OnlineWorkerRequestBody, { kind: 'initializeTransfer' }>,
432:   ): Promise<OnlineWorkerReplyByKind['initializeTransfer']> {
433:     if (this.identity || this.transport || this.startup || this.destination)
434:       throw new Error('Worker already initialized');
435:     if (!(this.store instanceof IndexedDbByteStore))
436:       throw new Error('Transfer promotion requires the atomic IndexedDB store');
437:     const identity = await loadOnlineIdentity(this.store);
438:     let destination: OnlineTransferDestination | undefined;
439:     try {
440:       if (this.closed || identity.peerId !== body.self)
441:         throw new Error('Transfer device identity is unavailable or differs');
442:       destination = await OnlineTransferDestination.create({
443:         attemptId: body.attemptId,
444:         mode: body.mode,
445:         expected: body.expected,
446:         identity,
447:         store: this.store,
448:         ...(body.bootstrapBytes === undefined ? {} : { bootstrapBytes: body.bootstrapBytes }),
449:       });
450:       if (this.closed) throw new Error('Worker closed during transfer initialization');
451:       this.identity = identity;
452:       this.destination = destination;
453:       return destination.snapshot();
454:     } catch (error) {
455:       try {
456:         await destination?.close();
457:       } finally {
458:         identity.dispose();
459:       }
460:       throw error;
461:     }
462:   }
463: 
464:   private requireDestination(): OnlineTransferDestination {
465:     if (!this.destination || this.closed) throw new Error('Transfer destination is not active');
466:     return this.destination;
467:   }
468: 
469:   private async transferResult<T>(operation: Promise<T>): Promise<T> {
470:     const result = await operation;
471:     if (this.closed) throw new Error('Worker closed during transfer operation');
472:     return result;
473:   }
474: 
475:   private attachTransport(
476:     body: Extract<OnlineWorkerRequestBody, { kind: 'attachTransport' }>,
477:   ): void {
478:     if (!this.identity || !this.invite || this.transport || !this.generation)
479:       throw new Error('Worker transport cannot attach before initialization');
480:     if (body.self !== this.identity.peerId) throw new Error('Worker transport identity differs');
481:     this.transport = createWorkerDeviceTransport({
482:       self: body.self,
483:       peers: body.peers,
484:       port: body.port,
485:       generation: this.generation,
486:       onFailure: (error) => this.fatal(error, 'online-worker-transport'),
487:     });
488:     if (this.resume) this.openStartup({ resume: this.resume });
489:   }
490: 
491:   private async pinFreeze(
492:     state: Extract<OnlineWorkerRequestBody, { kind: 'pinFreeze' }>['state'],
493:   ): Promise<{ freezeHash: string }> {
494:     if (!this.identity || !this.invite || this.resume || this.startup)
495:       throw new Error('Fresh freeze is unavailable in this worker');
496:     if (state.lobbyId !== this.invite.roomId) throw new Error('Freeze belongs to a different room');
497:     const freezeHash = await pinOnlineFreeze(this.store, this.identity.peerId, state);
498:     if (this.closed) throw new Error('Worker closed during freeze pin');
499:     this.pinnedFreezeHash = freezeHash;
500:     return { freezeHash };
501:   }
502: 
503:   private startCeremony(
504:     agreement: Extract<OnlineWorkerRequestBody, { kind: 'startCeremony' }>['agreement'],
505:   ): void {
506:     if (!this.identity || !this.invite || !this.transport || this.resume || this.startup)
507:       throw new Error('Fresh ceremony cannot start yet');
508:     const checked = verifyLobbyFreezeAgreement(agreement);
509:     if (!checked.ok) throw new Error(checked.error.message);
510:     if (
511:       checked.value.state.lobbyId !== this.invite.roomId ||
512:       toHex(hashValue(checked.value.state)) !== this.pinnedFreezeHash
513:     )
514:       throw new Error('Signed agreement differs from the local durable freeze pin');
515:     this.openStartup({ approved: checked.value });
516:   }
517: 
518:   private openStartup(
519:     mode:
520:       | { resume: SavedOnlineGameRecord }
521:       | { approved: Extract<OnlineWorkerRequestBody, { kind: 'startCeremony' }>['agreement'] },
522:   ): void {
523:     if (!this.identity || !this.invite || !this.transport) throw new Error('Worker is not ready');
524:     const startup = new OnlineStartup({
525:       invite: this.invite,
526:       identity: this.identity,
527:       transport: this.transport,
528:       store: this.store,
529:       clock: this.clock,
530:       engine: createBaseEngine(),
531:       onGameFatal: (error) => this.fatal(error, 'game-writer-lost'),
532:       onDeviceRoutes: (routes) => {
533:         if (this.closed || !this.generation) return;
534:         this.emit({
535:           protocol: ONLINE_WORKER_PROTOCOL,
536:           generation: this.generation,
537:           kind: 'deviceRoutes',
538:           routes: copyPublic(routes),
539:         });
540:       },
541:       ...mode,
542:     });
543:     this.startup = startup;
544:     this.startupUnsubscribe = startup.subscribe(() => this.publishStartup());
545:     this.publishStartup();
546:   }
547: 
548:   private publishStartup(): void {
549:     if (!this.generation || !this.startup || this.closed) return;
550:     const snapshot = this.startup.snapshot();
551:     if (snapshot?.phase === 'halted') this.transport?.stopOutput();
552:     this.emit({
553:       protocol: ONLINE_WORKER_PROTOCOL,
554:       generation: this.generation,
555:       kind: 'startup',
556:       snapshot,
557:     });
558:     const game = this.startup.game();
559:     if (!game || this.gameAnnounced) return;
560:     this.gameAnnounced = true;
561:     this.emit({
562:       protocol: ONLINE_WORKER_PROTOCOL,
563:       generation: this.generation,
564:       kind: 'gameReady',
565:       game: { gameId: game.gameId, genesis: copyPublic(game.genesis), seat: game.seat },
566:     });
567:     this.sessionUnsubscribe = game.session.subscribe((update) => {
568:       this.lastUpdate = update;
569:       this.publishSession();
570:     });
571:   }
572: 
573:   private publishSession(): void {
574:     if (!this.generation || this.closed) return;
575:     const game = this.startup?.game();
576:     if (!game || !this.lastUpdate) return;
577:     const session = game.session;
578:     const privateState = this.visible ? session.getPrivate(game.seat) : null;
579:     const snapshot: OnlineWorkerSessionSnapshot = {
580:       committedHead: session.getCommittedHead(),
581:       update: this.lastUpdate,
582:       events: session.getEvents(),
583:       localHumanSeat: game.seat,
584:       privateState: privateState
585:         ? {
586:             seat: game.seat,
587:             hand: { ...privateState.hand },
588:             slots: { ...privateState.slots },
589:             ext: {},
590:           }
591:         : null,
592:       legal: privateState ? session.getLegalCommands(game.seat) : null,
593:       controllableSeats: session.controllableSeats().includes(game.seat) ? [game.seat] : [],
594:       visibilityToken: this.visibilityToken,
595:     };
596:     const encoded = canonicalEncode(snapshot);
597:     if (encoded.byteLength > MAX_ONLINE_WORKER_SNAPSHOT_BYTES) {
598:       this.fatal(
599:         new Error('Session snapshot exceeds the worker output limit'),
600:         'online-worker-output',
601:       );
602:       return;
603:     }
604:     // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Canonical decoding detaches the bounded public snapshot.
605:     const detached = canonicalDecode(encoded) as OnlineWorkerSessionSnapshot;
606:     if (this.unackedSnapshotId !== null) this.queuedSnapshot = detached;
607:     else this.sendSessionSnapshot(detached);
608:   }
609: 
610:   private sendSessionSnapshot(snapshot: OnlineWorkerSessionSnapshot): void {
611:     if (!this.generation || this.closed) return;
612:     const snapshotId = ++this.lastSnapshotId;
613:     this.unackedSnapshotId = snapshotId;
614:     this.emit({
615:       protocol: ONLINE_WORKER_PROTOCOL,
616:       generation: this.generation,
617:       kind: 'session',
618:       snapshotId,
619:       snapshot,
620:     });
621:   }
622: 
623:   private requireStartup(): OnlineStartup {
624:     if (!this.startup) throw new Error('Online startup is not active');
625:     return this.startup;
626:   }
627: 
628:   private requireSession() {
629:     const game = this.requireStartup().game();
630:     if (!game || this.closed) throw new Error('Online game is not active');
631:     return game.session;
632:   }
633: 
634:   private requireHead(head: { seq: number; hash: string }): void {
635:     const current = this.requireSession().getCommittedHead();
636:     if (current.seq !== head.seq || current.hash !== head.hash)
637:       throw Object.assign(new Error('Certified head changed'), { code: 'stale-head' });
638:   }
639: 
640:   private fatal(error: Error, code: string): void {
641:     if (this.closed) return;
642:     this.stopOutput();
643:     if (this.generation)
644:       this.emit({
645:         protocol: ONLINE_WORKER_PROTOCOL,
646:         generation: this.generation,
647:         kind: 'fatal',
648:         error: { code, message: error.message },
649:       });
650:     // oxlint-disable-next-line promise/no-promise-in-callback -- Fatal transport/lease callbacks must start cleanup without blocking their caller.
651:     void this.close().catch(() => undefined);
652:   }
653: 
654:   private stopOutput(): void {
655:     this.transport?.stopOutput();
656:     this.startup?.game()?.session.dispose();
657:   }
658: 
659:   close(): Promise<void> {
660:     if (this.closing) return this.closing;
661:     this.closed = true;
662:     this.stopOutput();
663:     const destinationClosing = this.destination?.close();
664:     // Closing immediately stops pending import/readiness work before storage is drained.
665:     void destinationClosing?.catch(() => undefined);
666:     this.closing = (async () => {
667:       await this.work;
668:       await Promise.allSettled(this.sessionWork);
669:       this.sessionUnsubscribe?.();
670:       this.startupUnsubscribe?.();
671:       try {
672:         await this.startup?.close();
673:       } finally {
674:         try {
675:           await destinationClosing;
676:         } finally {
677:           this.transport?.close();
678:           this.identity?.dispose();
679:           await this.store.close();
680:         }
681:       }
682:     })();
683:     return this.closing;
684:   }
685: }
```


## apps/web/src/session/online-worker-client.ts

```text
1: import { failure } from '@cp2p/engine';
2: import type { Result } from '@cp2p/engine';
3: import type { Unsubscribe } from '@cp2p/protocol';
4: import {
5:   MAX_ONLINE_WORKER_PENDING_REQUESTS,
6:   MAX_ONLINE_WORKER_REQUEST_BYTES,
7:   ONLINE_WORKER_PROTOCOL,
8: } from './online-worker-messages.js';
9: import type {
10:   OnlineWorkerEvent,
11:   OnlineWorkerReplyByKind,
12:   OnlineWorkerRequest,
13:   OnlineWorkerRequestBody,
14: } from './online-worker-messages.js';
15: import { onlineWorkerRequestSize } from './online-worker-request-size.js';
16: 
17: export interface OnlineProtocolWorkerPort {
18:   postMessage(message: OnlineWorkerRequest, transfer: Transferable[]): void;
19:   addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
20:   addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
21:   removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
22:   removeEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
23:   terminate(): void;
24: }
25: 
26: interface PendingRequest {
27:   kind: OnlineWorkerRequestBody['kind'];
28:   bytes: number;
29:   bootstrap: boolean;
30:   timer: ReturnType<typeof setTimeout>;
31:   finish(result: Result<unknown>): void;
32: }
33: 
34: function object(value: unknown): value is Record<string, unknown> {
35:   return typeof value === 'object' && value !== null && !Array.isArray(value);
36: }
37: 
38: function isResult(value: unknown): value is Result<unknown> {
39:   return (
40:     object(value) &&
41:     (value.ok === true ||
42:       (value.ok === false &&
43:         object(value.error) &&
44:         typeof value.error.code === 'string' &&
45:         typeof value.error.message === 'string'))
46:   );
47: }
48: 
49: function transfers(body: OnlineWorkerRequestBody): Transferable[] {
50:   return body.kind === 'attachTransport' ? [body.port] : [];
51: }
52: 
53: function isEvent(
54:   value: Record<string, unknown>,
55: ): value is Record<string, unknown> & OnlineWorkerEvent {
56:   switch (value.kind) {
57:     case 'deviceRoutes': {
58:       const routes = value.routes;
59:       if (
60:         !object(routes) ||
61:         !object(routes.head) ||
62:         !Number.isSafeInteger(routes.head.seq) ||
63:         typeof routes.head.seq !== 'number' ||
64:         routes.head.seq < 0 ||
65:         typeof routes.head.hash !== 'string' ||
66:         !/^[0-9a-f]{64}$/.test(routes.head.hash) ||
67:         !Array.isArray(routes.activeDevices) ||
68:         !Array.isArray(routes.catchupDevices)
69:       )
70:         return false;
71:       const peers = [...routes.activeDevices, ...routes.catchupDevices];
72:       return (
73:         routes.activeDevices.length > 0 &&
74:         peers.length <= 6 &&
75:         new Set(peers).size === peers.length &&
76:         peers.every((peer) => typeof peer === 'string' && /^[A-Za-z0-9_-]{43}$/.test(peer))
77:       );
78:     }
79:     case 'startup':
80:       return (
81:         value.snapshot === null ||
82:         (object(value.snapshot) && typeof value.snapshot.phase === 'string')
83:       );
84:     case 'gameReady':
85:       return (
86:         object(value.game) &&
87:         typeof value.game.gameId === 'string' &&
88:         object(value.game.genesis) &&
89:         Number.isInteger(value.game.seat)
90:       );
91:     case 'session': {
92:       const snapshot = value.snapshot;
93:       return (
94:         Number.isSafeInteger(value.snapshotId) &&
95:         object(snapshot) &&
96:         object(snapshot.update) &&
97:         object(snapshot.update.state) &&
98:         object(snapshot.update.status) &&
99:         Array.isArray(snapshot.update.pending) &&
100:         Array.isArray(snapshot.update.timers) &&
101:         Array.isArray(snapshot.update.events) &&
102:         object(snapshot.committedHead) &&
103:         Number.isSafeInteger(snapshot.committedHead.seq) &&
104:         snapshot.update.revision === snapshot.committedHead.seq &&
105:         typeof snapshot.committedHead.hash === 'string' &&
106:         Array.isArray(snapshot.events) &&
107:         Array.isArray(snapshot.controllableSeats) &&
108:         Number.isSafeInteger(snapshot.visibilityToken) &&
109:         Number.isInteger(snapshot.localHumanSeat)
110:       );
111:     }
112:     case 'fatal':
113:       return (
114:         object(value.error) &&
115:         typeof value.error.code === 'string' &&
116:         typeof value.error.message === 'string'
117:       );
118:     default:
119:       return false;
120:   }
121: }
122: 
123: /** Only display data and commands cross this channel. Keys stay in the worker. */
124: export class OnlineWorkerClient {
125:   readonly generation: string;
126:   private readonly worker: OnlineProtocolWorkerPort;
127:   private readonly listeners = new Set<(event: OnlineWorkerEvent) => void>();
128:   private readonly failures = new Set<(error: Error) => void>();
129:   private readonly pending = new Map<number, PendingRequest>();
130:   private pendingBytes = 0;
131:   private pendingBootstrap = false;
132:   private nextId = 0;
133:   private stopped = false;
134:   private closing: Promise<void> | null = null;
135:   private fatalError: Error | null = null;
136: 
137:   constructor(options: { worker?: OnlineProtocolWorkerPort; generation?: string } = {}) {
138:     this.generation = options.generation ?? crypto.randomUUID();
139:     this.worker =
140:       options.worker ??
141:       new Worker(new URL('./online-protocol-worker.ts', import.meta.url), { type: 'module' });
142:     this.worker.addEventListener('message', this.receive);
143:     this.worker.addEventListener('error', this.workerFailed);
144:     this.worker.addEventListener('messageerror', this.workerFailed);
145:   }
146: 
147:   request<K extends OnlineWorkerRequestBody['kind']>(
148:     body: Extract<OnlineWorkerRequestBody, { kind: K }>,
149:     options: { timeoutMs?: number } = {},
150:   ): Promise<Result<OnlineWorkerReplyByKind[K]>> {
151:     if (this.stopped || (this.closing && body.kind !== 'shutdown'))
152:       return Promise.resolve(failure('online-worker-closed', 'The online worker is unavailable'));
153:     let bytes: number;
154:     let bootstrap: boolean;
155:     try {
156:       ({ bytes, bootstrap } = onlineWorkerRequestSize(body));
157:     } catch (error) {
158:       if (error instanceof RangeError)
159:         return Promise.resolve(failure('online-worker-busy', 'Worker request exceeds its limit'));
160:       return Promise.resolve(failure('online-worker-request', 'The worker request is malformed'));
161:     }
162:     const shutdown = body.kind === 'shutdown';
163:     const control =
164:       body.kind === 'ackSession' ||
165:       body.kind === 'setPrivateVisible' ||
166:       body.kind === 'cancelPending';
167:     const countLimit = control
168:       ? MAX_ONLINE_WORKER_PENDING_REQUESTS
169:       : MAX_ONLINE_WORKER_PENDING_REQUESTS - 4;
170:     const byteLimit = control
171:       ? MAX_ONLINE_WORKER_REQUEST_BYTES
172:       : MAX_ONLINE_WORKER_REQUEST_BYTES - 65_536;
173:     if (
174:       !shutdown &&
175:       (this.pending.size >= countLimit ||
176:         (bootstrap ? this.pendingBootstrap : this.pendingBytes + bytes > byteLimit))
177:     )
178:       return Promise.resolve(failure('online-worker-busy', 'Too many online requests are pending'));
179:     const id = ++this.nextId;
180:     return new Promise((resolve) => {
181:       const timer = setTimeout(
182:         () => this.fail(new Error('The online worker stopped responding')),
183:         options.timeoutMs ?? 120_000,
184:       );
185:       this.pending.set(id, {
186:         kind: body.kind,
187:         bytes,
188:         bootstrap,
189:         timer,
190:         finish: (result) => {
191:           // The matched request ID and kind bind the reply to this method's result type.
192:           // oxlint-disable-next-line typescript/no-unsafe-type-assertion
193:           resolve(result as Result<OnlineWorkerReplyByKind[K]>);
194:         },
195:       });
196:       if (bootstrap) this.pendingBootstrap = true;
197:       else this.pendingBytes += bytes;
198:       try {
199:         this.worker.postMessage(
200:           { protocol: ONLINE_WORKER_PROTOCOL, generation: this.generation, id, body },
201:           transfers(body),
202:         );
203:       } catch {
204:         this.fail(new Error('Could not communicate with the online worker'));
205:       }
206:     });
207:   }
208: 
209:   subscribe(listener: (event: OnlineWorkerEvent) => void): Unsubscribe {
210:     this.listeners.add(listener);
211:     return () => this.listeners.delete(listener);
212:   }
213: 
214:   onFailure(listener: (error: Error) => void): Unsubscribe {
215:     this.failures.add(listener);
216:     if (this.fatalError) listener(this.fatalError);
217:     return () => this.failures.delete(listener);
218:   }
219: 
220:   fail(error: Error): void {
221:     if (this.stopped) return;
222:     this.fatalError = error;
223:     // Stop the network bridge before terminating the signer or resolving pending UI work.
224:     for (const listener of this.failures) {
225:       try {
226:         listener(error);
227:       } catch {
228:         /* Other owners must still stop output. */
229:       }
230:     }
231:     this.terminate();
232:   }
233: 
234:   shutdown(): Promise<void> {
235:     if (this.closing) return this.closing;
236:     if (this.stopped) return Promise.resolve();
237:     this.closing = Promise.resolve().then(async () => {
238:       const result = await this.request({ kind: 'shutdown' }, { timeoutMs: 10_000 });
239:       this.terminate();
240:       if (!result.ok) throw new Error(result.error.message);
241:       return undefined;
242:     });
243:     return this.closing;
244:   }
245: 
246:   private readonly workerFailed = () =>
247:     this.fail(new Error('The online worker failed. Reopen the saved game to reconnect.'));
248: 
249:   private readonly receive = (event: MessageEvent<unknown>) => {
250:     if (this.stopped) return;
251:     const message = event.data;
252:     if (!object(message) || message.protocol !== ONLINE_WORKER_PROTOCOL) {
253:       this.fail(new Error('Malformed online worker response'));
254:       return;
255:     }
256:     if (message.generation !== this.generation) return;
257:     if ('id' in message) {
258:       if (typeof message.id !== 'number' || !Number.isSafeInteger(message.id)) {
259:         this.fail(new Error('Malformed online worker request ID'));
260:         return;
261:       }
262:       const pending = this.pending.get(message.id);
263:       if (!pending) return;
264:       if (message.kind !== pending.kind || !isResult(message.result)) {
265:         this.fail(new Error('Online worker reply does not match its request'));
266:         return;
267:       }
268:       this.pending.delete(message.id);
269:       if (pending.bootstrap) this.pendingBootstrap = false;
270:       else this.pendingBytes -= pending.bytes;
271:       clearTimeout(pending.timer);
272:       pending.finish(message.result);
273:       return;
274:     }
275:     if (this.closing) return;
276:     if (!isEvent(message)) {
277:       this.fail(new Error('Malformed online worker update'));
278:       return;
279:     }
280:     if (message.kind === 'fatal') {
281:       this.fail(new Error(message.error.message));
282:       return;
283:     }
284:     for (const listener of this.listeners) {
285:       try {
286:         listener(message);
287:       } catch {
288:         this.fail(new Error('Could not apply the online worker update'));
289:       }
290:     }
291:     if (message.kind === 'session' && !this.stopped) {
292:       void this.request({ kind: 'ackSession', snapshotId: message.snapshotId }).then((result) => {
293:         if (!result.ok && !this.stopped && !this.closing)
294:           this.fail(new Error(result.error.message));
295:         return undefined;
296:       });
297:     }
298:   };
299: 
300:   private terminate(): void {
301:     if (this.stopped) return;
302:     this.stopped = true;
303:     this.worker.removeEventListener('message', this.receive);
304:     this.worker.removeEventListener('error', this.workerFailed);
305:     this.worker.removeEventListener('messageerror', this.workerFailed);
306:     this.worker.terminate();
307:     for (const pending of this.pending.values()) {
308:       clearTimeout(pending.timer);
309:       pending.finish(
310:         failure('online-worker-closed', this.fatalError?.message ?? 'The online worker is closed'),
311:       );
312:     }
313:     this.pending.clear();
314:     this.pendingBytes = 0;
315:     this.pendingBootstrap = false;
316:     this.listeners.clear();
317:     this.failures.clear();
318:   }
319: }
```


## apps/web/src/session/online-worker-runtime.test.ts

```text
1: import { hashValue, toHex } from '@cp2p/codec';
2: import { BASE_VERSION } from '@cp2p/engine';
3: import { success } from '@cp2p/engine';
4: import type { LobbyState } from '@cp2p/protocol';
5: import { MemoryEscrowLifecycleStore } from '@cp2p/protocol/testing';
6: import { expect, test } from 'vitest';
7: import { loadOrCreateOnlineIdentity } from './online-credentials.js';
8: import { ONLINE_WORKER_PROTOCOL } from './online-worker-messages.js';
9: import type {
10:   OnlineWorkerEvent,
11:   OnlineWorkerRequest,
12:   OnlineWorkerRequestBody,
13: } from './online-worker-messages.js';
14: import { OnlineWorkerRuntime } from './online-worker-runtime.js';
15: 
16: function request(
17:   id: number,
18:   body: OnlineWorkerRequestBody,
19:   generation = 'room-one',
20: ): OnlineWorkerRequest {
21:   return { protocol: ONLINE_WORKER_PROTOCOL, generation, id, body };
22: }
23: 
24: function update(revision: number) {
25:   return {
26:     revision,
27:     state: { public: true },
28:     events: [],
29:     pending: [],
30:     timers: [],
31:     status: { kind: 'running' },
32:   };
33: }
34: 
35: test('transfer bootstrap has one bounded slot and shutdown stops the destination before draining', async () => {
36:   let storeClosed = false;
37:   let destinationClosed = false;
38:   const store = Object.assign(new MemoryEscrowLifecycleStore(), {
39:     close: async () => {
40:       storeClosed = true;
41:     },
42:   });
43:   const worker = new OnlineWorkerRuntime({ store, emit: () => undefined });
44:   let release!: () => void;
45:   const blocked = new Promise<void>((resolve) => {
46:     release = resolve;
47:   });
48:   let started!: () => void;
49:   const entered = new Promise<void>((resolve) => {
50:     started = resolve;
51:   });
52:   Reflect.set(worker, 'destination', {
53:     async refreshBootstrap() {
54:       started();
55:       await blocked;
56:     },
57:     snapshot: () => ({ phase: 'prepared' }),
58:     async close() {
59:       destinationClosed = true;
60:       release();
61:     },
62:   });
63:   const body = {
64:     kind: 'refreshTransferBootstrap' as const,
65:     bootstrapBytes: new Uint8Array(2 * 1024 * 1024),
66:   };
67:   try {
68:     const first = worker.handle(request(1, body));
69:     await entered;
70:     expect((await worker.handle(request(2, body))).result).toMatchObject({ ok: false });
71:     expect(
72:       (
73:         await worker.handle(
74:           request(3, {
75:             kind: 'setPrivateVisible',
76:             visible: false,
77:             visibilityToken: 1,
78:           }),
79:         )
80:       ).result,
81:     ).toMatchObject({ ok: true });
82:     const closing = worker.handle(request(4, { kind: 'shutdown' }));
83:     expect(destinationClosed).toBe(true);
84:     expect((await first).result).toMatchObject({ ok: false });
85:     expect((await closing).result).toMatchObject({ ok: true });
86:     expect(storeClosed).toBe(true);
87:   } finally {
88:     release();
89:     await worker.close();
90:   }
91: });
92: 
93: test('source transfer RPC rejects stale submission and wipes worker-generated entropy after shutdown', async () => {
94:   const store = Object.assign(new MemoryEscrowLifecycleStore(), { close: async () => undefined });
95:   const worker = new OnlineWorkerRuntime({ store, emit: () => undefined });
96:   const head = { seq: 3, hash: 'a'.repeat(64) };
97:   const seeds: Uint8Array[] = [];
98:   let submitted = false;
99:   let release!: () => void;
100:   const blocked = new Promise<void>((resolve) => {
101:     release = resolve;
102:   });
103:   let started!: () => void;
104:   const entered = new Promise<void>((resolve) => {
105:     started = resolve;
106:   });
107:   const session = {
108:     getCommittedHead: () => head,
109:     submitTransfer: async () => {
110:       submitted = true;
111:       return success(undefined);
112:     },
113:     async prepareTransferPrivate(authorization: unknown, entropy: Uint8Array, nonce: Uint8Array) {
114:       expect(authorization).toEqual(head);
115:       seeds.push(entropy, nonce);
116:       expect(entropy).toHaveLength(32);
117:       expect(nonce).toHaveLength(32);
118:       expect(entropy).not.toEqual(nonce);
119:       started();
120:       await blocked;
121:       return success({ sealed: 'packet' });
122:     },
123:     dispose: () => release(),
124:   };
125:   Reflect.set(worker, 'startup', {
126:     game: () => ({ session, seat: 0 }),
127:     close: async () => undefined,
128:   });
129:   try {
130:     expect(
131:       (
132:         await worker.handle(
133:           request(1, {
134:             kind: 'submitTransfer',
135:             head: { ...head, seq: 2 },
136:             change: {},
137:           }),
138:         )
139:       ).result,
140:     ).toMatchObject({ ok: false, error: { code: 'stale-head' } });
141:     expect(submitted).toBe(false);
142:     const sealing = worker.handle(
143:       request(2, { kind: 'prepareTransferPrivate', authorization: head }),
144:     );
145:     await entered;
146:     const closing = worker.handle(request(3, { kind: 'shutdown' }));
147:     expect((await sealing).result).toMatchObject({ ok: false });
148:     expect((await closing).result).toMatchObject({ ok: true });
149:     for (const seed of seeds) expect(seed.every((byte) => byte === 0)).toBe(true);
150:   } finally {
151:     release();
152:     await worker.close();
153:   }
154: });
155: 
156: test('worker loads the durable device identity and refuses replayed or changed generations', async () => {
157:   const store = Object.assign(new MemoryEscrowLifecycleStore(), { close: async () => undefined });
158:   const identity = await loadOrCreateOnlineIdentity(store, (length) =>
159:     new Uint8Array(length).fill(9),
160:   );
161:   const invite = { roomId: 'workertest', hostPeer: identity.peerId, serverUrl: '' };
162:   const events: OnlineWorkerEvent[] = [];
163:   const worker = new OnlineWorkerRuntime({ store, emit: (event) => events.push(event) });
164:   try {
165:     const initialized = await worker.handle(
166:       request(1, { kind: 'initialize', mode: 'fresh', self: identity.peerId, invite }),
167:     );
168:     expect(initialized.result).toEqual({
169:       ok: true,
170:       value: { self: identity.peerId, invite, resume: null },
171:     });
172:     expect((await worker.handle(request(1, { kind: 'exportSave' }))).result).toMatchObject({
173:       ok: false,
174:     });
175:     expect(
176:       (await worker.handle(request(2, { kind: 'exportSave' }, 'another-room'))).result,
177:     ).toMatchObject({ ok: false });
178:     expect((await worker.handle(request(2, { kind: 'exportSave' }))).result).toMatchObject({
179:       ok: false,
180:     });
181:     expect(events).toEqual([]);
182:   } finally {
183:     await worker.close();
184:     identity.dispose();
185:   }
186: });
187: 
188: test('freeze pin is byte-exact before an ACK and cannot be replaced by a changed lobby state', async () => {
189:   const store = Object.assign(new MemoryEscrowLifecycleStore(), { close: async () => undefined });
190:   const identity = await loadOrCreateOnlineIdentity(store, (length) =>
191:     new Uint8Array(length).fill(7),
192:   );
193:   const invite = { roomId: 'pinworkert', hostPeer: identity.peerId, serverUrl: '' };
194:   const worker = new OnlineWorkerRuntime({ store, emit: () => undefined });
195:   const state: LobbyState = {
196:     lobbyId: invite.roomId,
197:     hostPeer: identity.peerId,
198:     hostEpoch: 0,
199:     version: 1,
200:     name: 'Pinned room',
201:     seats: [
202:       { seat: 0, kind: 'human', peer: identity.peerId, name: 'A', colour: 'blue', ready: true },
203:       { seat: 1, kind: 'open', colour: 'orange', ready: false },
204:     ],
205:     spectators: [],
206:     config: {
207:       modules: [{ id: 'base', version: BASE_VERSION }],
208:       seats: [0, 1],
209:       options: { base: { mapLayout: 'random', vpTarget: 3 } },
210:     },
211:     seedMode: { kind: 'joint' },
212:     takeover: { mode: 'vote', afterSeconds: 120 },
213:     status: 'starting',
214:     ceremonyNonce: 'a'.repeat(43),
215:   };
216:   try {
217:     expect(
218:       (
219:         await worker.handle(
220:           request(1, { kind: 'initialize', mode: 'fresh', self: identity.peerId, invite }),
221:         )
222:       ).result.ok,
223:     ).toBe(true);
224:     const first = await worker.handle(request(2, { kind: 'pinFreeze', state }));
225:     expect(first.result).toEqual({ ok: true, value: { freezeHash: toHex(hashValue(state)) } });
226:     const persisted = await store.load(`online-freeze/${identity.peerId}/${state.ceremonyNonce}`);
227:     expect(persisted).not.toBeNull();
228:     expect(
229:       (await worker.handle(request(3, { kind: 'pinFreeze', state: { ...state, name: 'Changed' } })))
230:         .result,
231:     ).toMatchObject({ ok: false });
232:     expect(await store.load(`online-freeze/${identity.peerId}/${state.ceremonyNonce}`)).toEqual(
233:       persisted,
234:     );
235:   } finally {
236:     await worker.close();
237:     identity.dispose();
238:   }
239: });
240: 
241: test('pending submit permits control; shutdown suppresses disposal updates and drains storage', async () => {
242:   let storeClosed = false;
243:   const store = Object.assign(new MemoryEscrowLifecycleStore(), {
244:     close: async () => {
245:       storeClosed = true;
246:     },
247:   });
248:   const identity = await loadOrCreateOnlineIdentity(store, (length) =>
249:     new Uint8Array(length).fill(5),
250:   );
251:   const invite = { roomId: 'workgameaa', hostPeer: identity.peerId, serverUrl: '' };
252:   const events: OnlineWorkerEvent[] = [];
253:   const worker = new OnlineWorkerRuntime({ store, emit: (event) => events.push(event) });
254:   let finishSubmit!: () => void;
255:   const submitted = new Promise<void>((resolve) => {
256:     finishSubmit = resolve;
257:   });
258:   const head = { seq: 0, hash: 'a'.repeat(64) };
259:   const listeners: ((value: unknown) => void)[] = [];
260:   let botPrivateReads = 0;
261:   const session = {
262:     getCommittedHead: () => head,
263:     subscribe(callback: (value: unknown) => void) {
264:       listeners.push(callback);
265:       callback(update(0));
266:       return () => {
267:         listeners.length = 0;
268:       };
269:     },
270:     getPrivate(seat: number) {
271:       if (seat !== 0) {
272:         botPrivateReads += 1;
273:         throw new Error('Bot private state escaped');
274:       }
275:       return { seat: 0, hand: { brick: 1 }, slots: {}, ext: { hidden: 'never-send' } };
276:     },
277:     getLegalCommands: () => ({ commands: [], templates: [] }),
278:     getEvents: () => [],
279:     controllableSeats: () => [0, 2],
280:     async submit() {
281:       await submitted;
282:       return success(undefined);
283:     },
284:     cancelPending: () => true,
285:     dispose() {
286:       listeners[0]?.(update(3));
287:       finishSubmit();
288:     },
289:   };
290:   try {
291:     expect(
292:       (
293:         await worker.handle(
294:           request(1, { kind: 'initialize', mode: 'fresh', self: identity.peerId, invite }),
295:         )
296:       ).result.ok,
297:     ).toBe(true);
298:     Reflect.set(worker, 'startup', {
299:       snapshot: () => ({
300:         phase: 'playing',
301:         awaitingSeats: [],
302:         locallyConsented: true,
303:         error: null,
304:         gameId: 'test',
305:       }),
306:       game: () => ({ gameId: 'test', genesis: { public: true }, seat: 0, session }),
307:       close: async () => undefined,
308:     });
309:     const publish: unknown = Reflect.get(worker, 'publishStartup');
310:     if (typeof publish !== 'function') throw new Error('Missing worker publication method');
311:     Reflect.apply(publish, worker, []);
312:     const first = events.filter((event) => event.kind === 'session');
313:     expect(first).toHaveLength(1);
314:     expect(first[0]?.snapshot.privateState).toEqual({
315:       seat: 0,
316:       hand: { brick: 1 },
317:       slots: {},
318:       ext: {},
319:     });
320:     expect(first[0]?.snapshot.controllableSeats).toEqual([0]);
321:     expect(botPrivateReads).toBe(0);
322:     const listener = listeners[0];
323:     if (!listener) throw new Error('Missing session subscription');
324:     listener(update(1));
325:     listener(update(2));
326:     expect(events.filter((event) => event.kind === 'session')).toHaveLength(1);
327: 
328:     const pending = worker.handle(
329:       request(2, { kind: 'submit', seat: 0, head, command: { type: 'END_TURN' } }),
330:     );
331:     await Promise.resolve();
332:     expect((await worker.handle(request(3, { kind: 'cancelPending', seat: 0 }))).result).toEqual({
333:       ok: true,
334:       value: true,
335:     });
336:     expect(
337:       (
338:         await worker.handle(
339:           request(4, { kind: 'setPrivateVisible', visible: false, visibilityToken: 1 }),
340:         )
341:       ).result.ok,
342:     ).toBe(true);
343:     expect((await worker.handle(request(5, { kind: 'cancelPending', seat: 2 }))).result.ok).toBe(
344:       false,
345:     );
346:     expect(
347:       (
348:         await worker.handle(
349:           request(6, {
350:             kind: 'submit',
351:             seat: 0,
352:             head: { ...head, hash: 'b'.repeat(64) },
353:             command: { type: 'END_TURN' },
354:           }),
355:         )
356:       ).result,
357:     ).toMatchObject({ ok: false, error: { code: 'stale-head' } });
358:     expect((await worker.handle(request(7, { kind: 'ackSession', snapshotId: 1 }))).result.ok).toBe(
359:       true,
360:     );
361:     const snapshots = events.filter((event) => event.kind === 'session');
362:     expect(snapshots).toHaveLength(2);
363:     expect(snapshots[1]?.snapshot.privateState).toBeNull();
364:     expect(snapshots[1]?.snapshot.visibilityToken).toBe(1);
365:     expect((await worker.handle(request(8, { kind: 'ackSession', snapshotId: 2 }))).result.ok).toBe(
366:       true,
367:     );
368:     const beforeShutdown = events.length;
369:     expect((await worker.handle(request(9, { kind: 'shutdown' }))).result.ok).toBe(true);
370:     expect((await pending).result.ok).toBe(true);
371:     expect(events).toHaveLength(beforeShutdown);
372:     expect(storeClosed).toBe(true);
373:   } finally {
374:     finishSubmit();
375:     await worker.close();
376:     identity.dispose();
377:   }
378: });
```


## apps/web/src/session/online-worker-client.test.ts

```text
1: import { afterEach, describe, expect, test, vi } from 'vitest';
2: import { ONLINE_WORKER_PROTOCOL } from './online-worker-messages.js';
3: import type { OnlineWorkerRequest } from './online-worker-messages.js';
4: import { OnlineWorkerClient } from './online-worker-client.js';
5: import type { OnlineProtocolWorkerPort } from './online-worker-client.js';
6: 
7: class FakeWorker implements OnlineProtocolWorkerPort {
8:   readonly requests: OnlineWorkerRequest[] = [];
9:   terminated = false;
10:   private readonly messageListeners = new Set<unknown>();
11:   private readonly errorListeners = new Set<unknown>();
12: 
13:   postMessage(message: OnlineWorkerRequest, _transfer: Transferable[]): void {
14:     if (this.terminated) throw new Error('worker terminated');
15:     this.requests.push(message);
16:   }
17: 
18:   addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
19:   addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
20:   addEventListener(type: 'message' | 'error' | 'messageerror', listener: unknown): void {
21:     if (type === 'message') this.messageListeners.add(listener);
22:     else this.errorListeners.add(listener);
23:   }
24: 
25:   removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
26:   removeEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
27:   removeEventListener(type: 'message' | 'error' | 'messageerror', listener: unknown): void {
28:     if (type === 'message') this.messageListeners.delete(listener);
29:     else this.errorListeners.delete(listener);
30:   }
31: 
32:   terminate(): void {
33:     this.terminated = true;
34:   }
35: 
36:   emit(data: unknown): void {
37:     for (const listener of this.messageListeners)
38:       if (typeof listener === 'function')
39:         Reflect.apply(listener, undefined, [new MessageEvent('message', { data })]);
40:   }
41: 
42:   emitFailure(): void {
43:     for (const listener of this.errorListeners)
44:       if (typeof listener === 'function') Reflect.apply(listener, undefined, [new Event('error')]);
45:   }
46: 
47:   reply(request: OnlineWorkerRequest, result: unknown, kind = request.body.kind): void {
48:     this.emit({
49:       protocol: ONLINE_WORKER_PROTOCOL,
50:       generation: request.generation,
51:       id: request.id,
52:       kind,
53:       result,
54:     });
55:   }
56: }
57: 
58: function createClient(worker: FakeWorker, generation = 'worker-generation') {
59:   return new OnlineWorkerClient({ worker, generation });
60: }
61: 
62: function expectOk(result: unknown): void {
63:   expect(result).toMatchObject({ ok: true });
64: }
65: 
66: afterEach(() => {
67:   vi.useRealTimers();
68: });
69: 
70: describe('OnlineWorkerClient', () => {
71:   test('forwards bounded certified route events and rejects duplicate active/catch-up devices', () => {
72:     const worker = new FakeWorker();
73:     const client = createClient(worker);
74:     const seen: string[] = [];
75:     client.subscribe((event) => seen.push(event.kind));
76:     const routes = {
77:       head: { seq: 12, hash: 'a'.repeat(64) },
78:       activeDevices: ['A'.repeat(43), 'B'.repeat(43)],
79:       catchupDevices: ['C'.repeat(43)],
80:     };
81:     const event = {
82:       protocol: ONLINE_WORKER_PROTOCOL,
83:       generation: client.generation,
84:       kind: 'deviceRoutes',
85:       routes,
86:     };
87:     worker.emit(event);
88:     expect(seen).toEqual(['deviceRoutes']);
89:     expect(worker.terminated).toBe(false);
90:     worker.emit({ ...event, routes: { ...routes, catchupDevices: ['A'.repeat(43)] } });
91:     expect(seen).toEqual(['deviceRoutes']);
92:     expect(worker.terminated).toBe(true);
93:   });
94: 
95:   test('permits one large public bootstrap without consuming the control byte reserve', async () => {
96:     const worker = new FakeWorker();
97:     const client = createClient(worker);
98:     try {
99:       const body = {
100:         kind: 'refreshTransferBootstrap' as const,
101:         bootstrapBytes: new Uint8Array(2 * 1024 * 1024),
102:       };
103:       const first = client.request(body);
104:       expect(worker.requests).toHaveLength(1);
105:       await expect(client.request(body)).resolves.toMatchObject({
106:         ok: false,
107:         error: { code: 'online-worker-busy' },
108:       });
109:       const control = client.request({
110:         kind: 'setPrivateVisible',
111:         visible: false,
112:         visibilityToken: 1,
113:       });
114:       expect(worker.requests).toHaveLength(2);
115:       for (const request of worker.requests) worker.reply(request, { ok: true, value: undefined });
116:       expectOk(await first);
117:       expectOk(await control);
118:       const retry = client.request(body);
119:       const posted = worker.requests.at(-1);
120:       if (!posted) throw new Error('Missing retry');
121:       worker.reply(posted, { ok: true, value: undefined });
122:       expectOk(await retry);
123:       await expect(
124:         client.request({
125:           kind: 'refreshTransferBootstrap',
126:           bootstrapBytes: new Uint8Array(16 * 1024 * 1024 + 1),
127:         }),
128:       ).resolves.toMatchObject({ ok: false, error: { code: 'online-worker-busy' } });
129:       expect(worker.requests).toHaveLength(3);
130:     } finally {
131:       client.fail(new Error('test complete'));
132:     }
133:   });
134: 
135:   test('bounds pending ordinary request count and total canonical bytes', async () => {
136:     const worker = new FakeWorker();
137:     const client = createClient(worker);
138:     const requests = Array.from({ length: 12 }, () => client.request({ kind: 'retryStart' }));
139:     const control = client.request({ kind: 'ackSession', snapshotId: 9 });
140:     await expect(client.request({ kind: 'retryStart' })).resolves.toMatchObject({
141:       ok: false,
142:       error: { code: 'online-worker-busy' },
143:     });
144:     expect(worker.requests).toHaveLength(13);
145:     worker.requests.forEach((request) => worker.reply(request, { ok: true, value: undefined }));
146:     for (const result of await Promise.all(requests)) expectOk(result);
147:     expectOk(await control);
148:     client.fail(new Error('test complete'));
149:   });
150: 
151:   test('enforces aggregate request bytes and single-request size before posting', async () => {
152:     const worker = new FakeWorker();
153:     const client = createClient(worker);
154:     const payload = 'x'.repeat(600_000);
155:     const first = client.request({ kind: 'approveRecoveryAuthorization', change: { payload } });
156:     const second = await client.request({
157:       kind: 'approveRecoveryAuthorization',
158:       change: { payload },
159:     });
160:     expect(second).toMatchObject({ ok: false, error: { code: 'online-worker-busy' } });
161:     expect(worker.requests).toHaveLength(1);
162:     const firstRequest = worker.requests[0];
163:     if (!firstRequest) throw new Error('Expected the bounded request');
164:     worker.reply(firstRequest, { ok: true, value: { amendment: null } });
165:     expect(await first).toMatchObject({ ok: true });
166: 
167:     const tooLarge = await client.request({
168:       kind: 'approveRecoveryAuthorization',
169:       change: { payload: 'y'.repeat(1_100_000) },
170:     });
171:     expect(tooLarge).toMatchObject({ ok: false, error: { code: 'online-worker-busy' } });
172:     expect(worker.requests).toHaveLength(1);
173:     client.fail(new Error('test complete'));
174:   });
175: 
176:   test('ignores another generation and fails closed on a reply with the wrong kind', async () => {
177:     const worker = new FakeWorker();
178:     const client = createClient(worker);
179:     const request = client.request({ kind: 'retryStart' });
180:     const pending = worker.requests[0];
181:     if (!pending) throw new Error('Expected a posted request');
182:     worker.emit({
183:       protocol: ONLINE_WORKER_PROTOCOL,
184:       generation: 'old-generation',
185:       id: pending.id,
186:       kind: 'retryStart',
187:       result: { ok: true, value: undefined },
188:     });
189:     expect(worker.terminated).toBe(false);
190:     worker.reply(pending, { ok: true, value: undefined }, 'shutdown');
191:     await expect(request).resolves.toMatchObject({
192:       ok: false,
193:       error: { code: 'online-worker-closed' },
194:     });
195:     expect(worker.terminated).toBe(true);
196:   });
197: 
198:   test('acknowledges each session snapshot by its snapshotId', async () => {
199:     const worker = new FakeWorker();
200:     const client = createClient(worker);
201:     const applied: string[] = [];
202:     client.subscribe((event) => applied.push(event.kind));
203:     worker.emit({
204:       protocol: ONLINE_WORKER_PROTOCOL,
205:       generation: 'worker-generation',
206:       kind: 'session',
207:       snapshotId: 17,
208:       snapshot: {
209:         committedHead: { seq: 0, hash: 'head-0' },
210:         update: { revision: 0, state: {}, status: {}, pending: [], timers: [], events: [] },
211:         events: [],
212:         controllableSeats: [0],
213:         visibilityToken: 0,
214:         localHumanSeat: 0,
215:       },
216:     });
217:     const acknowledgement = worker.requests[0];
218:     if (!acknowledgement || acknowledgement.body.kind !== 'ackSession')
219:       throw new Error('Expected a session snapshot acknowledgement');
220:     expect(acknowledgement.body.snapshotId).toBe(17);
221:     expect(applied).toEqual(['session']);
222:     worker.reply(acknowledgement, { ok: true, value: undefined });
223:     client.fail(new Error('test complete'));
224:   });
225: 
226:   test('notifies failure listeners before termination and fails every pending request', async () => {
227:     const worker = new FakeWorker();
228:     const client = createClient(worker);
229:     const observed: boolean[] = [];
230:     client.onFailure(() => observed.push(worker.terminated));
231:     const first = client.request({ kind: 'retryStart' });
232:     const second = client.request({ kind: 'exportSave' });
233:     worker.emitFailure();
234: 
235:     expect(observed).toEqual([false]);
236:     expect(worker.terminated).toBe(true);
237:     await expect(first).resolves.toMatchObject({
238:       ok: false,
239:       error: { code: 'online-worker-closed' },
240:     });
241:     await expect(second).resolves.toMatchObject({
242:       ok: false,
243:       error: { code: 'online-worker-closed' },
244:     });
245:   });
246: 
247:   test('shutdown drains only its RPC and enforces its ten-second timeout', async () => {
248:     const worker = new FakeWorker();
249:     const client = createClient(worker);
250:     const regular = client.request({ kind: 'retryStart' });
251:     const shutdown = client.shutdown();
252:     await Promise.resolve();
253:     await Promise.resolve();
254:     const shutdownRequest = worker.requests.find((request) => request.body.kind === 'shutdown');
255:     if (!shutdownRequest) throw new Error('Expected the shutdown request');
256:     const regularRequest = worker.requests.find((request) => request.body.kind === 'retryStart');
257:     if (!regularRequest) throw new Error('Expected the in-flight request');
258:     worker.reply(regularRequest, { ok: true, value: undefined });
259:     expectOk(await regular);
260:     worker.emit({
261:       protocol: ONLINE_WORKER_PROTOCOL,
262:       generation: 'worker-generation',
263:       kind: 'session',
264:       snapshotId: 17,
265:       snapshot: {
266:         committedHead: { seq: 0, hash: 'head-0' },
267:         update: { revision: 0, state: {}, status: {}, pending: [], timers: [], events: [] },
268:         events: [],
269:         controllableSeats: [0],
270:         visibilityToken: 0,
271:         localHumanSeat: 0,
272:       },
273:     });
274:     expect(worker.requests.map((request) => request.body.kind)).toEqual(['retryStart', 'shutdown']);
275:     worker.reply(shutdownRequest, { ok: true, value: undefined });
276:     await shutdown;
277:     expect(worker.terminated).toBe(true);
278: 
279:     vi.useFakeTimers();
280:     const timeoutWorker = new FakeWorker();
281:     const timeoutClient = createClient(timeoutWorker);
282:     const timeout = timeoutClient.shutdown();
283:     await Promise.resolve();
284:     await Promise.resolve();
285:     expect(timeoutWorker.requests[0]?.body.kind).toBe('shutdown');
286:     const timeoutOutcome = timeout.then(
287:       () => ({ kind: 'resolved' as const }),
288:       (error: unknown) => ({ kind: 'rejected' as const, error }),
289:     );
290:     await vi.advanceTimersByTimeAsync(10_000);
291:     const outcome = await timeoutOutcome;
292:     expect(outcome.kind).toBe('rejected');
293:     const timeoutError = outcome.kind === 'rejected' ? outcome.error : new Error('did not timeout');
294:     expect(String(timeoutError)).toContain('stopped responding');
295:     expect(timeoutWorker.terminated).toBe(true);
296:   });
297: 
298:   test('an already queued snapshot ACK failure cannot interrupt graceful shutdown', async () => {
299:     const worker = new FakeWorker();
300:     const client = createClient(worker);
301:     worker.emit({
302:       protocol: ONLINE_WORKER_PROTOCOL,
303:       generation: 'worker-generation',
304:       kind: 'session',
305:       snapshotId: 21,
306:       snapshot: {
307:         committedHead: { seq: 0, hash: 'head-0' },
308:         update: { revision: 0, state: {}, status: {}, pending: [], timers: [], events: [] },
309:         events: [],
310:         controllableSeats: [0],
311:         visibilityToken: 0,
312:         localHumanSeat: 0,
313:       },
314:     });
315:     const ack = worker.requests[0];
316:     if (!ack || ack.body.kind !== 'ackSession') throw new Error('Expected queued ACK');
317:     const shutdown = client.shutdown();
318:     await Promise.resolve();
319:     await Promise.resolve();
320:     const stop = worker.requests.find((request) => request.body.kind === 'shutdown');
321:     if (!stop) throw new Error('Expected shutdown RPC');
322:     worker.reply(ack, { ok: false, error: { code: 'closed', message: 'already stopping' } });
323:     expect(worker.terminated).toBe(false);
324:     worker.reply(stop, { ok: true, value: undefined });
325:     await shutdown;
326:     expect(worker.terminated).toBe(true);
327:   });
328: 
329:   test('does not queue a snapshot ACK when an update listener starts shutdown', async () => {
330:     const worker = new FakeWorker();
331:     const client = createClient(worker);
332:     let shutdown: Promise<void> | undefined;
333:     client.subscribe(() => {
334:       shutdown = client.shutdown();
335:     });
336:     worker.emit({
337:       protocol: ONLINE_WORKER_PROTOCOL,
338:       generation: 'worker-generation',
339:       kind: 'session',
340:       snapshotId: 22,
341:       snapshot: {
342:         committedHead: { seq: 0, hash: 'head-0' },
343:         update: { revision: 0, state: {}, status: {}, pending: [], timers: [], events: [] },
344:         events: [],
345:         controllableSeats: [0],
346:         visibilityToken: 0,
347:         localHumanSeat: 0,
348:       },
349:     });
350:     await Promise.resolve();
351:     await Promise.resolve();
352:     expect(worker.requests.map((request) => request.body.kind)).toEqual(['shutdown']);
353:     const stop = worker.requests[0];
354:     if (!stop) throw new Error('Expected shutdown RPC');
355:     worker.reply(stop, { ok: true, value: undefined });
356:     await shutdown;
357:     expect(worker.terminated).toBe(true);
358:   });
359: });
```


## apps/web/src/session/online-worker-transfer.test.ts

```text
1: import { toBase64Url } from '@cp2p/codec';
2: import { scalarToBytes, signObject } from '@cp2p/crypto';
3: import { createBaseEngine } from '@cp2p/engine';
4: import type { Result } from '@cp2p/engine';
5: import {
6:   advanceRecoveryFixture,
7:   certifyRecoveryFixtureEntry,
8:   createRecoveryFixture,
9:   recoveryFixtureKey,
10:   signRecoveryFixtureEntry,
11:   TRANSFER_OWNER_GAME_DOMAIN,
12:   transferEntryRef,
13: } from '@cp2p/protocol/testing';
14: import {
15:   genesisDigest,
16:   MemoryProtocolJournal,
17:   prepareTransferPrivate,
18:   validateGenesisOnlineStart,
19:   validateDeckCeremony,
20:   validateGenesisEntry,
21:   verifyGameSeatBindings,
22:   verifyLobbyFreezeAgreement,
23: } from '@cp2p/protocol';
24: import {
25:   IDBCursor,
26:   IDBDatabase,
27:   IDBFactory,
28:   IDBIndex,
29:   IDBKeyRange,
30:   IDBObjectStore,
31:   IDBRequest,
32:   IDBTransaction,
33: } from 'fake-indexeddb';
34: import { afterEach, expect, test, vi } from 'vitest';
35: import { IndexedDbByteStore } from '@cp2p/storage';
36: import { loadOrCreateOnlineIdentity } from './online-credentials.js';
37: import { loadOnlineGameRecord } from './online-game-records.js';
38: import { encodeOnlineTransferBootstrap } from './online-transfer-bootstrap.js';
39: import { ONLINE_WORKER_PROTOCOL } from './online-worker-messages.js';
40: import type { OnlineWorkerRequestBody } from './online-worker-messages.js';
41: import { OnlineWorkerRuntime } from './online-worker-runtime.js';
42: 
43: function value<T>(result: Result<T>): T {
44:   if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
45:   return result.value;
46: }
47: 
48: function installFactory(): void {
49:   vi.stubGlobal('indexedDB', new IDBFactory());
50:   for (const [name, item] of Object.entries({
51:     IDBCursor,
52:     IDBDatabase,
53:     IDBIndex,
54:     IDBKeyRange,
55:     IDBObjectStore,
56:     IDBRequest,
57:     IDBTransaction,
58:   }))
59:     vi.stubGlobal(name, item);
60:   vi.stubGlobal('navigator', {
61:     locks: {
62:       async request<T>(
63:         name: string,
64:         optionsOrCallback: LockOptions | LockGrantedCallback<T>,
65:         callbackMaybe?: LockGrantedCallback<T>,
66:       ) {
67:         const callback =
68:           typeof optionsOrCallback === 'function' ? optionsOrCallback : callbackMaybe;
69:         if (!callback) throw new TypeError('Lock callback is missing');
70:         return callback({ name, mode: 'exclusive' });
71:       },
72:     },
73:   });
74: }
75: 
76: function request(id: number, generation: string, body: OnlineWorkerRequestBody) {
77:   return { protocol: ONLINE_WORKER_PROTOCOL, generation, id, body } as const;
78: }
79: 
80: function lockableStore(): IndexedDbByteStore {
81:   return new IndexedDbByteStore({ lockProvider: async (_name, task) => task() });
82: }
83: 
84: afterEach(() => vi.unstubAllGlobals());
85: 
86: test('worker destination resumes exact staged transfer before promotion, then promotes for normal game lookup', async () => {
87:   installFactory();
88:   const fixture = createRecoveryFixture({ masterBackedBeacon: true, lobbyId: 'transferqa' });
89:   const start = value(validateGenesisOnlineStart(fixture.genesis));
90:   const agreement = start.bindings.agreement;
91:   const record = {
92:     gameId: fixture.genesis.gameId,
93:     genesisDigest: genesisDigest(fixture.genesis),
94:     invite: {
95:       roomId: agreement.state.lobbyId,
96:       hostPeer: agreement.state.hostPeer,
97:       serverUrl: '',
98:     },
99:     agreement,
100:     result: {
101:       entry: fixture.genesisEntry,
102:       genesis: fixture.genesis,
103:       transcripts: fixture.deck.transcripts,
104:       bindings: start.bindings.bindings,
105:     },
106:   };
107:   expect(verifyLobbyFreezeAgreement(record.agreement).ok).toBe(true);
108:   expect(verifyGameSeatBindings(record.agreement, record.result.bindings).ok).toBe(true);
109:   const deckCheck = validateDeckCeremony(fixture.genesis, fixture.deck.transcripts);
110:   expect(
111:     validateGenesisEntry(fixture.genesisEntry, createBaseEngine(), {
112:       verifyCommitments: () => deckCheck,
113:     }).ok,
114:   ).toBe(true);
115: 
116:   const bootstrapEntries = [...fixture.deckEntries];
117:   const bootstrap = value(
118:     encodeOnlineTransferBootstrap({ start: record, entries: bootstrapEntries }),
119:   );
120:   const attemptId = toBase64Url(new Uint8Array(32).fill(5));
121:   const expected = { gameId: record.gameId, genesisDigest: record.genesisDigest };
122:   const credentialStore = lockableStore();
123:   const identity = await loadOrCreateOnlineIdentity(credentialStore, (length) =>
124:     new Uint8Array(length).fill(111),
125:   );
126:   const self = identity.peerId;
127:   identity.dispose();
128:   await credentialStore.close();
129: 
130:   const firstStore = lockableStore();
131:   const firstEvents: unknown[] = [];
132:   const firstWorker = new OnlineWorkerRuntime({
133:     store: firstStore,
134:     emit: (event) => firstEvents.push(event),
135:   });
136:   const firstGeneration = 'transfer-worker-before-restart';
137:   let firstId = 0;
138:   const firstRequest = (body: OnlineWorkerRequestBody) =>
139:     firstWorker.handle(request(++firstId, firstGeneration, body));
140:   const initialized = await firstRequest({
141:     kind: 'initializeTransfer',
142:     self,
143:     attemptId,
144:     mode: 'new',
145:     expected,
146:     bootstrapBytes: bootstrap,
147:   });
148:   if (initialized.kind !== 'initializeTransfer' || !initialized.result.ok)
149:     throw new Error('Worker did not initialize the transfer destination');
150:   expect(initialized.result.value.phase).toBe('prepared');
151:   const offerReply = await firstRequest({
152:     kind: 'prepareTransferOffer',
153:     seat: 0,
154:     mode: 'live',
155:   });
156:   if (offerReply.kind !== 'prepareTransferOffer' || !offerReply.result.ok)
157:     throw new Error('Worker did not prepare transfer credentials');
158:   const authorization = {
159:     ...offerReply.result.value,
160:     ownerIntent: {
161:       signer: 'current-game' as const,
162:       sig: signObject(
163:         TRANSFER_OWNER_GAME_DOMAIN,
164:         offerReply.result.value.statement,
165:         recoveryFixtureKey(fixture, 0),
166:       ),
167:     },
168:   };
169:   const authorizedEntry = signRecoveryFixtureEntry(
170:     fixture,
171:     fixture.ready,
172:     { kind: 'membership', change: authorization },
173:     fixture.ready.log.head.stateHash,
174:   );
175:   const authorizedCertificate = certifyRecoveryFixtureEntry(
176:     fixture,
177:     fixture.ready,
178:     authorizedEntry,
179:     [0, 1, 2, 3],
180:   );
181:   const authorized = advanceRecoveryFixture(fixture.ready, authorizedCertificate);
182:   bootstrapEntries.push(authorizedCertificate);
183:   const authorizedBootstrap = value(
184:     encodeOnlineTransferBootstrap({ start: record, entries: bootstrapEntries }),
185:   );
186:   const refreshed = await firstRequest({
187:     kind: 'refreshTransferBootstrap',
188:     bootstrapBytes: authorizedBootstrap,
189:   });
190:   if (refreshed.kind !== 'refreshTransferBootstrap' || !refreshed.result.ok)
191:     throw new Error('Worker did not accept the certified authorization prefix');
192: 
193:   const sourceJournal = new MemoryProtocolJournal();
194:   expect(await sourceJournal.initialize(fixture.genesisEntry, Uint8Array.of(1))).toBe(true);
195:   for (const certified of fixture.deckEntries)
196:     // oxlint-disable-next-line no-await-in-loop -- Reproduce the exact contiguous source journal.
197:     expect(await sourceJournal.commit(certified.entry.seq, 0, certified, Uint8Array.of(1))).toBe(
198:       true,
199:     );
200:   expect(
201:     await sourceJournal.commit(
202:       authorizedCertificate.entry.seq,
203:       0,
204:       authorizedCertificate,
205:       Uint8Array.of(1),
206:     ),
207:   ).toBe(true);
208:   const packet = value(
209:     await prepareTransferPrivate({
210:       journal: sourceJournal,
211:       engine: fixture.source.engine,
212:       policy: fixture.policy,
213:       authorization: transferEntryRef(authorizedEntry),
214:       sourceSeat: 0,
215:       sourceKind: 'current-controller',
216:       signingKey: recoveryFixtureKey(fixture, 0),
217:       entropy: new Uint8Array(32).fill(31),
218:       nonce: new Uint8Array(32).fill(32),
219:       masters: [{ seat: 0, master: scalarToBytes(17n) }],
220:       outbox: firstStore,
221:     }),
222:   );
223:   const imported = await firstRequest({ kind: 'importTransferPacket', packet });
224:   if (imported.kind !== 'importTransferPacket' || !imported.result.ok)
225:     throw new Error('Worker did not import the authenticated transfer packet');
226:   expect(imported.result.value.phase).toBe('imported');
227:   const readinessReply = await firstRequest({ kind: 'prepareTransferReadiness' });
228:   if (readinessReply.kind !== 'prepareTransferReadiness' || !readinessReply.result.ok)
229:     throw new Error('Worker did not persist transfer readiness');
230:   expect(readinessReply.result.value).toMatchObject({
231:     kind: 'transfer-activate',
232:     statement: { authorization: transferEntryRef(authorizedEntry) },
233:   });
234:   const stagedSnapshot = await firstRequest({ kind: 'transferSnapshot' });
235:   expect(stagedSnapshot).toMatchObject({
236:     kind: 'transferSnapshot',
237:     result: { ok: true, value: { phase: 'ready' } },
238:   });
239:   expect(
240:     firstEvents.some(
241:       (event) =>
242:         typeof event === 'object' &&
243:         event !== null &&
244:         'kind' in event &&
245:         (event.kind === 'gameReady' || event.kind === 'session'),
246:     ),
247:   ).toBe(false);
248:   await expect(loadOnlineGameRecord(firstStore, record.gameId)).resolves.toBeNull();
249:   const channel = new MessageChannel();
250:   const attach = await firstRequest({
251:     kind: 'attachTransport',
252:     self,
253:     peers: [],
254:     port: channel.port1,
255:   });
256:   expect(attach).toMatchObject({
257:     kind: 'attachTransport',
258:     result: { ok: false },
259:   });
260:   const gameplay = await firstRequest({
261:     kind: 'validate',
262:     seat: 0,
263:     head: transferEntryRef(fixture.ready.log.head),
264:     command: { type: 'NOOP' },
265:   });
266:   expect(gameplay).toMatchObject({ kind: 'validate', result: { ok: false } });
267:   channel.port1.close();
268:   channel.port2.close();
269:   await firstRequest({ kind: 'shutdown' });
270: 
271:   const resumedStore = lockableStore();
272:   const resumedEvents: unknown[] = [];
273:   const resumedWorker = new OnlineWorkerRuntime({
274:     store: resumedStore,
275:     emit: (event) => resumedEvents.push(event),
276:   });
277:   const resumedReply = await resumedWorker.handle(
278:     request(1, 'transfer-worker-after-restart', {
279:       kind: 'initializeTransfer',
280:       self,
281:       attemptId,
282:       mode: 'resume',
283:       expected,
284:     }),
285:   );
286:   if (resumedReply.kind !== 'initializeTransfer' || !resumedReply.result.ok)
287:     throw new Error('Worker did not resume the staged destination');
288:   expect(resumedReply.result.value.phase).toBe('ready');
289:   expect(
290:     resumedEvents.some(
291:       (event) =>
292:         typeof event === 'object' &&
293:         event !== null &&
294:         'kind' in event &&
295:         (event.kind === 'gameReady' || event.kind === 'session'),
296:     ),
297:   ).toBe(false);
298: 
299:   const activation = readinessReply.result.value;
300:   const activationEntry = signRecoveryFixtureEntry(
301:     fixture,
302:     authorized,
303:     { kind: 'membership', change: activation },
304:     authorized.log.head.stateHash,
305:   );
306:   const activationCertificate = certifyRecoveryFixtureEntry(
307:     fixture,
308:     authorized,
309:     activationEntry,
310:     [0, 1, 2, 3],
311:   );
312:   advanceRecoveryFixture(authorized, activationCertificate);
313:   bootstrapEntries.push(activationCertificate);
314:   const activatedBootstrap = value(
315:     encodeOnlineTransferBootstrap({ start: record, entries: bootstrapEntries }),
316:   );
317:   const observed = await resumedWorker.handle(
318:     request(2, 'transfer-worker-after-restart', {
319:       kind: 'observeTransferActivation',
320:       bootstrapBytes: activatedBootstrap,
321:     }),
322:   );
323:   if (observed.kind !== 'observeTransferActivation' || !observed.result.ok)
324:     throw new Error('Worker did not promote the certified activation');
325:   expect(observed.result.value).toBe(record.gameId);
326:   expect(
327:     resumedEvents.some(
328:       (event) =>
329:         typeof event === 'object' &&
330:         event !== null &&
331:         'kind' in event &&
332:         (event.kind === 'gameReady' || event.kind === 'session'),
333:     ),
334:   ).toBe(false);
335:   const publicStore = lockableStore();
336:   await expect(loadOnlineGameRecord(publicStore, record.gameId)).resolves.toMatchObject({
337:     gameId: record.gameId,
338:     genesisDigest: record.genesisDigest,
339:   });
340:   await publicStore.close();
341:   await resumedWorker.handle(request(3, 'transfer-worker-after-restart', { kind: 'shutdown' }));
342:   bootstrap.fill(0);
343:   authorizedBootstrap.fill(0);
344:   activatedBootstrap.fill(0);
345: }, 90_000);
```


## apps/web/src/session/online-game-transport.ts

```text
1: import { fromBase64Url, hashValue, toHex } from '@cp2p/codec';
2: import { failure, success } from '@cp2p/engine';
3: import type { Engine, Result } from '@cp2p/engine';
4: import { MAX_MESSAGE_BYTES as MAX_WEBRTC_MESSAGE_BYTES } from '@cp2p/p2p';
5: import {
6:   genesisDigest,
7:   advanceContext,
8:   decodeProtocolMessage,
9:   encodeProtocolMessage,
10:   entryHash,
11:   MAX_MESSAGE_BYTES as MAX_PROTOCOL_MESSAGE_BYTES,
12:   replayCertifiedPrefix,
13:   validateCertifiedEntry,
14:   verifyGameSeatBindings,
15:   validateGenesisOnlineStart,
16: } from '@cp2p/protocol';
17: import type {
18:   LobbyFreezeAgreement,
19:   CertifiedEntry,
20:   PeerId,
21:   ProposalContext,
22:   ReplayPolicy,
23:   SignedGameSeatBinding,
24:   Transport,
25:   Unsubscribe,
26:   ValidatedGenesis,
27: } from '@cp2p/protocol';
28: 
29: const MAGIC = new Uint8Array([0x43, 0x50, 0x32, 0x47]); // CP2G
30: const FRAME_VERSION = 1;
31: const DIGEST_BYTES = 32;
32: const HEADER_BYTES = MAGIC.length + 1 + DIGEST_BYTES;
33: const RETIRED_GRACE_HEIGHTS = 128;
34: const MAX_RETIRED_ROUTES = 6;
35: 
36: interface RetiringRoute {
37:   readonly device: PeerId;
38:   readonly game: PeerId;
39:   readonly atSeq: number;
40:   readonly hint: Uint8Array;
41:   hinted: boolean;
42: }
43: 
44: function retireRemovedRoutes(
45:   prior: ReadonlyMap<PeerId, PeerId>,
46:   current: ReadonlyMap<PeerId, PeerId>,
47:   certified: CertifiedEntry,
48:   retired: Map<PeerId, RetiringRoute>,
49: ): Result<void> {
50:   if (certified.entry.payload.kind === 'membership')
51:     for (const [device, game] of prior) {
52:       if (current.get(device) === game) continue;
53:       const hint = encodeProtocolMessage({
54:         t: 'COMMIT',
55:         certified: { entry: certified.entry, certificate: certified.certificate },
56:       });
57:       if (!hint.ok) return hint;
58:       retired.set(game, {
59:         device,
60:         game,
61:         atSeq: certified.entry.seq,
62:         hint: hint.value,
63:         hinted: false,
64:       });
65:     }
66:   for (const [game, route] of retired)
67:     if (certified.entry.seq - route.atSeq > RETIRED_GRACE_HEIGHTS) retired.delete(game);
68:   while (retired.size > MAX_RETIRED_ROUTES) {
69:     const oldest = retired.keys().next().value;
70:     if (oldest === undefined) break;
71:     retired.delete(oldest);
72:   }
73:   return success(undefined);
74: }
75: 
76: export interface OnlineGameTransport extends Transport {
77:   /** Advances routing only from a verified extension of this transport's certified history. */
78:   advanceCertifiedHistory(entries: readonly CertifiedEntry[]): Result<void>;
79:   /** Connection admission only; current game-key authorization remains in this transport. */
80:   deviceRoutes(): OnlineDeviceRoutes | null;
81:   /** Leaves the authenticated device links and their other subscribers alive. */
82:   dispose(): void;
83: }
84: 
85: export interface OnlineDeviceRoutes {
86:   readonly head: { readonly seq: number; readonly hash: string };
87:   readonly activeDevices: readonly PeerId[];
88:   readonly catchupDevices: readonly PeerId[];
89: }
90: 
91: export interface OnlineGameTransportOptions {
92:   readonly deviceTransport: Transport;
93:   /** Output of certified genesis admission, never a caller-supplied draft. */
94:   readonly validatedGenesis: ValidatedGenesis;
95:   readonly agreement: LobbyFreezeAgreement;
96:   readonly bindings: readonly SignedGameSeatBinding[];
97:   /** Required on restore or when the device joined after genesis. */
98:   readonly certifiedHistory?: {
99:     readonly genesisEntry: unknown;
100:     readonly entries: readonly CertifiedEntry[];
101:     readonly engine: Engine;
102:     readonly policy: ReplayPolicy;
103:   };
104: }
105: 
106: function sameValue(left: unknown, right: unknown): boolean {
107:   return toHex(hashValue(left)) === toHex(hashValue(right));
108: }
109: 
110: /** Projects a certified genesis onto the device consent and fresh game-key roster. */
111: export function createOnlineGameTransport(
112:   options: OnlineGameTransportOptions,
113: ): Result<OnlineGameTransport> {
114:   const checked = verifyGameSeatBindings(options.agreement, options.bindings);
115:   if (!checked.ok) return checked;
116:   const { genesis } = options.validatedGenesis;
117:   const { agreement, genesisSeats, masters } = checked.value;
118:   try {
119:     const certified = validateGenesisOnlineStart(genesis);
120:     if (
121:       !certified.ok ||
122:       !sameValue(agreement, certified.value.bindings.agreement) ||
123:       !sameValue(checked.value.bindings, certified.value.bindings.bindings)
124:     )
125:       return failure(
126:         'online-transport-genesis',
127:         'Device routing differs from the certified online start',
128:       );
129:     if (
130:       genesis.security !== 'verified' ||
131:       genesis.ceremonyNonce !== agreement.state.ceremonyNonce ||
132:       !sameValue(genesis.config, agreement.state.config) ||
133:       !sameValue(genesis.seats, genesisSeats) ||
134:       !sameValue(genesis.commitments.masters, masters)
135:     )
136:       return failure(
137:         'online-transport-genesis',
138:         'Game keys differ from the certified frozen roster',
139:       );
140:     const digest = fromBase64Url(genesisDigest(genesis));
141:     if (digest.byteLength !== DIGEST_BYTES)
142:       return failure('online-transport-genesis', 'Genesis digest is invalid');
143:     const deviceToGame = new Map<PeerId, PeerId>();
144:     const gameToDevice = new Map<PeerId, PeerId>();
145:     for (const frozen of agreement.state.seats) {
146:       if (frozen.kind !== 'human') continue;
147:       const game = genesisSeats.find((seat) => seat.seat === frozen.seat);
148:       if (!game || game.kind !== 'human')
149:         return failure('online-transport-genesis', 'Human game-key roster is incomplete');
150:       deviceToGame.set(frozen.peer, game.publicKey);
151:       gameToDevice.set(game.publicKey, frozen.peer);
152:     }
153:     let certifiedContext: ProposalContext | null = null;
154:     let certifiedHashes: string[] = [];
155:     const retiring = new Map<PeerId, RetiringRoute>();
156:     if (options.certifiedHistory) {
157:       const history = options.certifiedHistory;
158:       let priorRoutes = new Map(deviceToGame);
159:       const replayed = replayCertifiedPrefix(
160:         history.genesisEntry,
161:         history.entries,
162:         history.engine,
163:         history.policy,
164:         (entry, next) => {
165:           const routes = projectCertifiedRoutes(next);
166:           if (!routes.ok) return routes;
167:           const retained = retireRemovedRoutes(
168:             priorRoutes,
169:             routes.value.deviceToGame,
170:             entry,
171:             retiring,
172:           );
173:           if (retained.ok) priorRoutes = routes.value.deviceToGame;
174:           return retained;
175:         },
176:       );
177:       if (!replayed.ok) return replayed;
178:       if (!sameValue(replayed.value.context.log.genesis, genesis))
179:         return failure('online-transport-history', 'Certified history belongs to another genesis');
180:       const routes = projectCertifiedRoutes(replayed.value.context);
181:       if (!routes.ok) return routes;
182:       deviceToGame.clear();
183:       gameToDevice.clear();
184:       for (const [device, game] of routes.value.deviceToGame) deviceToGame.set(device, game);
185:       for (const [game, device] of routes.value.gameToDevice) gameToDevice.set(game, device);
186:       certifiedContext = replayed.value.context;
187:       certifiedHashes = replayed.value.entries.map(({ entry }) => entryHash(entry));
188:     }
189:     const self = deviceToGame.get(options.deviceTransport.self);
190:     if (!self) return failure('online-transport-self', 'Device has no frozen human game seat');
191:     return success(
192:       new GameKeyTransport(
193:         options.deviceTransport,
194:         self,
195:         digest,
196:         deviceToGame,
197:         gameToDevice,
198:         certifiedContext,
199:         certifiedHashes,
200:         retiring,
201:         options.certifiedHistory
202:           ? {
203:               genesisEntry: options.certifiedHistory.genesisEntry,
204:               engine: options.certifiedHistory.engine,
205:               policy: {
206:                 genesis: { ...options.certifiedHistory.policy.genesis },
207:                 entry: { ...options.certifiedHistory.policy.entry },
208:               },
209:             }
210:           : null,
211:       ),
212:     );
213:   } catch {
214:     return failure('online-transport-genesis', 'Certified genesis projection is invalid');
215:   }
216: }
217: 
218: function projectCertifiedRoutes(context: ProposalContext): Result<{
219:   deviceToGame: Map<PeerId, PeerId>;
220:   gameToDevice: Map<PeerId, PeerId>;
221: }> {
222:   const authority = context.log.authority;
223:   const transfer = context.log.transfer;
224:   if (!authority || !transfer)
225:     return failure('online-transport-history', 'Certified authority or device routes are missing');
226:   const deviceToGame = new Map<PeerId, PeerId>();
227:   const gameToDevice = new Map<PeerId, PeerId>();
228:   for (const controller of authority.controllers) {
229:     if (controller.kind !== 'human' || controller.status !== 'active') continue;
230:     const device = transfer.routes.find(({ seat }) => seat === controller.seat)?.devicePeer;
231:     if (!device || deviceToGame.has(device) || gameToDevice.has(controller.publicKey))
232:       return failure('online-transport-history', 'Certified human device routes are incomplete');
233:     deviceToGame.set(device, controller.publicKey);
234:     gameToDevice.set(controller.publicKey, device);
235:   }
236:   return success({ deviceToGame, gameToDevice });
237: }
238: 
239: class GameKeyTransport implements OnlineGameTransport {
240:   private readonly messageListeners = new Set<(from: PeerId, message: Uint8Array) => void>();
241:   private readonly peerListeners = new Set<(peer: PeerId, online: boolean) => void>();
242:   private readonly offMessage: Unsubscribe;
243:   private readonly offPeer: Unsubscribe;
244:   private disposed = false;
245: 
246:   constructor(
247:     private readonly device: Transport,
248:     readonly self: PeerId,
249:     private readonly digest: Uint8Array,
250:     private deviceToGame: ReadonlyMap<PeerId, PeerId>,
251:     private gameToDevice: ReadonlyMap<PeerId, PeerId>,
252:     private context: ProposalContext | null,
253:     private certifiedHashes: string[],
254:     private retiring: Map<PeerId, RetiringRoute>,
255:     private readonly verifier: {
256:       readonly genesisEntry: unknown;
257:       readonly engine: Engine;
258:       readonly policy: ReplayPolicy;
259:     } | null,
260:   ) {
261:     this.offMessage = device.onMessage((from, bytes) => this.receive(from, bytes));
262:     this.offPeer = device.onPeerChange((peer, online) => {
263:       for (const route of this.retiring.values())
264:         if (route.device === peer) {
265:           if (online) this.hintRetiring(route);
266:           else route.hinted = false;
267:         }
268:       const game = this.deviceToGame.get(peer);
269:       if (!this.disposed && game && game !== this.self)
270:         for (const listener of this.peerListeners) {
271:           try {
272:             listener(game, online);
273:           } catch {
274:             /* A view cannot interrupt other game or device subscribers. */
275:           }
276:         }
277:     });
278:     for (const route of this.retiring.values())
279:       if (device.peers().includes(route.device)) this.hintRetiring(route);
280:   }
281: 
282:   advanceCertifiedHistory(entries: readonly CertifiedEntry[]): Result<void> {
283:     if (this.disposed) return failure('online-transport-retired', 'Game transport is disposed');
284:     if (!this.context || !this.verifier)
285:       return failure('online-transport-history', 'Certified genesis history was not installed');
286:     let hashes: string[];
287:     try {
288:       hashes = entries.map(({ entry }) => entryHash(entry));
289:     } catch {
290:       return failure('online-transport-history', 'Certified history contains an invalid entry');
291:     }
292:     if (
293:       hashes.length < this.certifiedHashes.length ||
294:       this.certifiedHashes.some((hash, index) => hashes[index] !== hash)
295:     )
296:       return failure('online-transport-history', 'Certified history does not extend this prefix');
297:     if (hashes.length === this.certifiedHashes.length) return success(undefined);
298:     let next = this.context;
299:     let priorRoutes = new Map(this.deviceToGame);
300:     const retiring = new Map(this.retiring);
301:     for (let index = this.certifiedHashes.length; index < entries.length; index++) {
302:       const certified = entries[index];
303:       if (!certified) return failure('online-transport-history', 'Certified entry is missing');
304:       // Historical accusations need a resolver over their exact certified ancestry.
305:       const kind = certified.entry?.payload?.kind;
306:       if (kind === 'control' || kind === 'cheat-proof') {
307:         const replayed = replayCertifiedPrefix(
308:           this.verifier.genesisEntry,
309:           entries.slice(0, index),
310:           this.verifier.engine,
311:           this.verifier.policy,
312:         );
313:         if (!replayed.ok) return replayed;
314:         next = replayed.value.context;
315:       }
316:       const checked = validateCertifiedEntry(certified, next);
317:       if (!checked.ok) return checked;
318:       const advanced = advanceContext(next, checked.value);
319:       if (!advanced.ok) return advanced;
320:       next = advanced.value;
321:       const nextRoutes = projectCertifiedRoutes(next);
322:       if (!nextRoutes.ok) return nextRoutes;
323:       const retained = retireRemovedRoutes(
324:         priorRoutes,
325:         nextRoutes.value.deviceToGame,
326:         certified,
327:         retiring,
328:       );
329:       if (!retained.ok) return retained;
330:       priorRoutes = nextRoutes.value.deviceToGame;
331:     }
332:     const routes = projectCertifiedRoutes(next);
333:     if (!routes.ok) return routes;
334:     const newSelf = routes.value.deviceToGame.get(this.device.self);
335:     if (newSelf !== this.self) {
336:       this.dispose();
337:       return failure('online-transport-retired', 'Local game key was retired by certified history');
338:     }
339:     const online = new Set(this.device.peers());
340:     const previous = new Set(this.peers());
341:     const current = new Set(
342:       [...routes.value.gameToDevice]
343:         .filter(([, device]) => online.has(device))
344:         .map(([game]) => game),
345:     );
346:     this.context = next;
347:     this.certifiedHashes = hashes;
348:     this.deviceToGame = routes.value.deviceToGame;
349:     this.gameToDevice = routes.value.gameToDevice;
350:     this.retiring = retiring;
351:     for (const peer of previous) if (!current.has(peer)) this.notifyPeer(peer, false);
352:     for (const peer of current)
353:       if (!previous.has(peer) && peer !== this.self) this.notifyPeer(peer, true);
354:     for (const route of this.retiring.values())
355:       if (online.has(route.device)) this.hintRetiring(route);
356:     return success(undefined);
357:   }
358: 
359:   deviceRoutes(): OnlineDeviceRoutes | null {
360:     if (!this.context || this.disposed) return null;
361:     const activeDevices = [...this.deviceToGame.keys()].toSorted();
362:     const catchupDevices = [
363:       ...new Set(
364:         [...this.retiring.values()]
365:           .toSorted(
366:             (left, right) => right.atSeq - left.atSeq || left.device.localeCompare(right.device),
367:           )
368:           .map((route) => route.device),
369:       ),
370:     ]
371:       .filter((device) => !this.deviceToGame.has(device))
372:       .slice(0, Math.max(0, 6 - activeDevices.length));
373:     return {
374:       head: { seq: this.context.log.head.seq, hash: entryHash(this.context.log.head) },
375:       activeDevices,
376:       catchupDevices,
377:     };
378:   }
379: 
380:   private hintRetiring(route: RetiringRoute): void {
381:     if (this.disposed || route.hinted) return;
382:     try {
383:       this.device.send(route.device, this.frame(route.hint));
384:       route.hinted = true;
385:     } catch {
386:       // Retry on the next authenticated link event or retired peer request.
387:     }
388:   }
389: 
390:   private notifyPeer(peer: PeerId, online: boolean): void {
391:     for (const listener of this.peerListeners) {
392:       try {
393:         listener(peer, online);
394:       } catch {
395:         /* A view cannot interrupt other game or device subscribers. */
396:       }
397:     }
398:   }
399: 
400:   peers(): PeerId[] {
401:     if (this.disposed) return [];
402:     return this.device
403:       .peers()
404:       .map((peer) => this.deviceToGame.get(peer))
405:       .filter((peer): peer is PeerId => peer !== undefined && peer !== this.self)
406:       .toSorted();
407:   }
408: 
409:   send(to: PeerId, message: Uint8Array): void {
410:     this.assertActive();
411:     const devicePeer = this.gameToDevice.get(to);
412:     if (devicePeer && to !== this.self) {
413:       this.device.send(devicePeer, this.frame(message));
414:       return;
415:     }
416:     const retired = this.retiring.get(to);
417:     if (!retired || !this.device.peers().includes(retired.device))
418:       throw new Error('Game peer is not a remote human');
419:     const decoded = decodeProtocolMessage(message);
420:     if (!decoded.ok || decoded.value.t !== 'SYNC_RES')
421:       throw new Error('Retired game peer accepts certified sync responses only');
422:     this.device.send(retired.device, this.frame(message));
423:   }
424: 
425:   broadcast(message: Uint8Array): void {
426:     this.assertActive();
427:     let firstError: unknown = null;
428:     for (const peer of this.peers()) {
429:       try {
430:         this.send(peer, message);
431:       } catch (error) {
432:         firstError ??= error;
433:       }
434:     }
435:     if (firstError) throw firstError;
436:   }
437: 
438:   onMessage(listener: (from: PeerId, message: Uint8Array) => void): Unsubscribe {
439:     if (this.disposed) return () => undefined;
440:     this.messageListeners.add(listener);
441:     return () => this.messageListeners.delete(listener);
442:   }
443: 
444:   onPeerChange(listener: (peer: PeerId, online: boolean) => void): Unsubscribe {
445:     if (this.disposed) return () => undefined;
446:     this.peerListeners.add(listener);
447:     return () => this.peerListeners.delete(listener);
448:   }
449: 
450:   disconnect(peer: PeerId): void {
451:     this.assertActive();
452:     const devicePeer = this.gameToDevice.get(peer);
453:     if (!devicePeer || peer === this.self) throw new Error('Game peer is not a remote human');
454:     this.device.disconnect(devicePeer);
455:   }
456: 
457:   dispose(): void {
458:     if (this.disposed) return;
459:     this.disposed = true;
460:     this.offMessage();
461:     this.offPeer();
462:     this.messageListeners.clear();
463:     this.peerListeners.clear();
464:     this.retiring.clear();
465:   }
466: 
467:   private assertActive(): void {
468:     if (this.disposed) throw new Error('Game transport is disposed');
469:   }
470: 
471:   private frame(message: Uint8Array): Uint8Array {
472:     if (
473:       !(message instanceof Uint8Array) ||
474:       message.byteLength > MAX_PROTOCOL_MESSAGE_BYTES ||
475:       message.byteLength + HEADER_BYTES > MAX_WEBRTC_MESSAGE_BYTES
476:     )
477:       throw new RangeError('Gameplay packet exceeds the transport limit');
478:     const frame = new Uint8Array(HEADER_BYTES + message.byteLength);
479:     frame.set(MAGIC);
480:     frame[MAGIC.length] = FRAME_VERSION;
481:     frame.set(this.digest, MAGIC.length + 1);
482:     frame.set(message, HEADER_BYTES);
483:     return frame;
484:   }
485: 
486:   private receive(from: PeerId, bytes: Uint8Array): void {
487:     if (this.disposed) return;
488:     const gamePeer = this.deviceToGame.get(from);
489:     if (
490:       !(bytes instanceof Uint8Array) ||
491:       bytes.byteLength < HEADER_BYTES ||
492:       bytes.byteLength > HEADER_BYTES + MAX_PROTOCOL_MESSAGE_BYTES ||
493:       bytes.byteLength > MAX_WEBRTC_MESSAGE_BYTES ||
494:       MAGIC.some((byte, index) => bytes[index] !== byte) ||
495:       bytes[MAGIC.length] !== FRAME_VERSION ||
496:       this.digest.some((byte, index) => bytes[MAGIC.length + 1 + index] !== byte)
497:     )
498:       return;
499:     if (!gamePeer) {
500:       const retired = [...this.retiring.values()].find((route) => route.device === from);
501:       if (!retired) return;
502:       const decoded = decodeProtocolMessage(bytes.slice(HEADER_BYTES));
503:       if (!decoded.ok || decoded.value.t !== 'SYNC_REQ') return;
504:       this.hintRetiring(retired);
505:       for (const listener of this.messageListeners) {
506:         try {
507:           listener(retired.game, bytes.slice(HEADER_BYTES));
508:         } catch {
509:           /* A view cannot interrupt certified catch-up or other subscribers. */
510:         }
511:       }
512:       return;
513:     }
514:     if (gamePeer === this.self) return;
515:     for (const listener of this.messageListeners) {
516:       try {
517:         listener(gamePeer, bytes.slice(HEADER_BYTES));
518:       } catch {
519:         /* A view cannot interrupt other game or device subscribers. */
520:       }
521:     }
522:   }
523: }
```


## apps/web/src/session/online-game-transport.test.ts

```text
1: import { canonicalEncode, hashValue, toBase64Url, toHex } from '@cp2p/codec';
2: import {
3:   G,
4:   encodePoint,
5:   identityFromSecret,
6:   scalePoint,
7:   scalarToBytes,
8:   signObject,
9: } from '@cp2p/crypto';
10: import { BASE_VERSION, createBaseEngine, ENGINE_VERSION } from '@cp2p/engine';
11: import type { Result, Seat } from '@cp2p/engine';
12: import { MAX_MESSAGE_BYTES as MAX_WEBRTC_MESSAGE_BYTES } from '@cp2p/p2p';
13: import {
14:   createConsensusState,
15:   decodeProtocolMessage,
16:   encodeProtocolMessage,
17:   MemoryProtocolJournal,
18:   genesisId,
19:   genesisDigest,
20:   LobbyController,
21:   MAX_MESSAGE_BYTES as MAX_PROTOCOL_MESSAGE_BYTES,
22:   PROTOCOL_VERSION,
23:   signGameSeatBinding,
24:   validateGenesisOnlineStart,
25:   verifyGameSeatBindings,
26: } from '@cp2p/protocol';
27: import type {
28:   Genesis,
29:   GenesisBody,
30:   LobbyFreezeAgreement,
31:   PeerId,
32:   ValidatedGenesis,
33: } from '@cp2p/protocol';
34: import {
35:   advanceRecoveryFixture,
36:   certifyRecoveryFixtureEntry,
37:   createMemnet,
38:   MemoryEscrowLifecycleStore,
39:   createRecoveryFixture,
40:   recoveryFixtureKey,
41:   signRecoveryFixtureEntry,
42:   TRANSFER_DESTINATION_CHECK_DOMAIN,
43:   TRANSFER_DEVICE_DOMAIN,
44:   TRANSFER_GAME_KEY_DOMAIN,
45:   TRANSFER_OWNER_GAME_DOMAIN,
46:   transferCheckDigest,
47:   transferEntryRef,
48: } from '@cp2p/protocol/testing';
49: import { expect, test } from 'vitest';
50: import { createOnlineGameTransport } from './online-game-transport.js';
51: import { openOnlineGame } from './online-game.js';
52: 
53: function value<T>(result: Result<T>): T {
54:   if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
55:   return result.value;
56: }
57: 
58: function required<T>(item: T | null | undefined): T {
59:   if (item === null || item === undefined) throw new Error('Missing game transport fixture value');
60:   return item;
61: }
62: 
63: function fixture() {
64:   const seed = toBase64Url(new Uint8Array(32).fill(7));
65:   const deviceKeys = [1, 2, 3].map((byte) => new Uint8Array(32).fill(byte));
66:   const devices = deviceKeys.map((key) => identityFromSecret(key).peerId);
67:   const net = createMemnet({ peers: devices });
68:   const host = value(
69:     LobbyController.createHost({
70:       lobbyId: 'game_transport',
71:       name: 'Online game',
72:       hostName: 'Avery',
73:       config: {
74:         modules: [{ id: 'base', version: BASE_VERSION }],
75:         seats: [0, 1, 2, 3],
76:         options: { base: { mapLayout: 'random', vpTarget: 3 } },
77:       },
78:       transport: net.transport(required(devices[0])),
79:       clock: net.clock,
80:       secretKey: required(deviceKeys[0]),
81:       seedMode: { kind: 'fixed', seed },
82:     }),
83:   );
84:   const guest = value(
85:     LobbyController.join({
86:       lobbyId: 'game_transport',
87:       hostPeer: required(devices[0]),
88:       transport: net.transport(required(devices[1])),
89:       clock: net.clock,
90:       secretKey: required(deviceKeys[1]),
91:     }),
92:   );
93:   const spectator = value(
94:     LobbyController.join({
95:       lobbyId: 'game_transport',
96:       hostPeer: required(devices[0]),
97:       transport: net.transport(required(devices[2])),
98:       clock: net.clock,
99:       secretKey: required(deviceKeys[2]),
100:     }),
101:   );
102:   const flush = () => net.clock.advanceBy(0);
103:   flush();
104:   value(spectator.request({ kind: 'spectate' }));
105:   flush();
106:   value(guest.request({ kind: 'takeSeat', seat: 1 }));
107:   flush();
108:   value(host.setBot(2, 'easy'));
109:   flush();
110:   value(host.setBot(3, 'easy', required(devices[1])));
111:   flush();
112:   value(host.request({ kind: 'setReady', ready: true }));
113:   flush();
114:   value(guest.request({ kind: 'setReady', ready: true }));
115:   flush();
116:   value(host.start(toBase64Url(new Uint8Array(32).fill(91))));
117:   flush();
118:   value(host.ackFreeze());
119:   value(guest.ackFreeze());
120:   flush();
121:   const agreement = required(host.freezeAgreement());
122:   const seats: Seat[] = [0, 1, 2, 3];
123:   const bindings = seats.map((seat) => {
124:     const owner = seat === 3 ? 1 : seat === 2 ? 0 : seat;
125:     return value(
126:       signGameSeatBinding({
127:         agreement,
128:         seat,
129:         deviceSecretKey: required(deviceKeys[owner]),
130:         gamePeer: identityFromSecret(new Uint8Array(32).fill(11 + seat)).peerId,
131:         masterPub: encodePoint(scalePoint(G, BigInt(17 + seat))),
132:         encryptionKey: encodePoint(scalePoint(G, BigInt(37 + seat))),
133:       }),
134:     );
135:   });
136:   const verified = value(verifyGameSeatBindings(agreement, bindings));
137:   const body: GenesisBody = {
138:     protocolVersion: PROTOCOL_VERSION,
139:     engineVersion: ENGINE_VERSION,
140:     config: agreement.state.config,
141:     seats: [...verified.genesisSeats],
142:     genesisSeed: seed,
143:     ceremonyNonce: required(agreement.state.ceremonyNonce),
144:     security: 'verified',
145:     takeover: agreement.state.takeover,
146:     commitments: {
147:       masters: verified.masters,
148:       onlineStart: {
149:         protocol: 'online-start-v1',
150:         agreement,
151:         bindings,
152:         seed: { protocol: 'genesis-seed-v1', kind: 'fixed', seed },
153:       },
154:     },
155:     createdAt: 1,
156:   };
157:   value(validateGenesisOnlineStart(body));
158:   const genesis: Genesis = { ...body, gameId: genesisId(body), signatures: [] };
159:   // These tests isolate routing after admission; production supplies validateGenesis's output.
160:   const validatedGenesis: ValidatedGenesis = {
161:     genesis,
162:     state: createBaseEngine().createGame(body.config, new Uint8Array(32).fill(7)),
163:   };
164:   return {
165:     net,
166:     host,
167:     guest,
168:     spectator,
169:     agreement,
170:     bindings,
171:     validatedGenesis,
172:     devices,
173:     gameKeys: bindings.map((binding) => binding.body.gamePeer),
174:     open(device: PeerId, admitted = validatedGenesis) {
175:       return value(
176:         createOnlineGameTransport({
177:           deviceTransport: net.transport(device),
178:           validatedGenesis: admitted,
179:           agreement,
180:           bindings,
181:         }),
182:       );
183:     },
184:     flush,
185:     dispose() {
186:       spectator.dispose();
187:       guest.dispose();
188:       host.dispose();
189:       net.dispose();
190:     },
191:   };
192: }
193: 
194: test('routes only frozen human game keys and isolates gameplay from lobby, ceremony, and wrong-game frames', () => {
195:   const room = fixture();
196:   const left = room.open(required(room.devices[0]));
197:   const right = room.open(required(room.devices[1]));
198:   try {
199:     expect(left.self).toBe(room.gameKeys[0]);
200:     expect(left.peers()).toEqual([room.gameKeys[1]]);
201:     const received: [PeerId, number[]][] = [];
202:     right.onMessage((from, bytes) => {
203:       received.push([from, [...bytes]]);
204:       bytes[0] = 255;
205:     });
206:     right.onMessage((from, bytes) => received.push([from, [...bytes]]));
207:     const payload = new Uint8Array([5, 6]);
208:     left.send(required(room.gameKeys[1]), payload);
209:     payload[0] = 99;
210:     room.flush();
211:     expect(received).toEqual([
212:       [required(room.gameKeys[0]), [5, 6]],
213:       [required(room.gameKeys[0]), [5, 6]],
214:     ]);
215:     const sentToSpectator: Uint8Array[] = [];
216:     const frames: Uint8Array[] = [];
217:     room.net.transport(required(room.devices[1])).onMessage((from, bytes) => {
218:       if (from === room.devices[0] && bytes[0] === 0x43 && bytes[1] === 0x50)
219:         frames.push(bytes.slice());
220:     });
221:     room.net
222:       .transport(required(room.devices[2]))
223:       .onMessage((_from, bytes) => sentToSpectator.push(bytes));
224:     left.broadcast(new Uint8Array([7]));
225:     room.flush();
226:     expect(sentToSpectator).toEqual([]);
227:     const captured = required(frames.at(-1));
228:     room.net.transport(required(room.devices[2])).send(required(room.devices[1]), captured);
229:     const wrongChannel = captured.slice();
230:     wrongChannel[0] = required(wrongChannel[0]) ^ 1;
231:     room.net.transport(required(room.devices[0])).send(required(room.devices[1]), wrongChannel);
232:     const wrongVersion = captured.slice();
233:     wrongVersion[4] = required(wrongVersion[4]) ^ 1;
234:     room.net.transport(required(room.devices[0])).send(required(room.devices[1]), wrongVersion);
235:     room.flush();
236:     expect(received).toHaveLength(4);
237:     expect(() => left.send(required(room.gameKeys[2]), new Uint8Array([1]))).toThrow(
238:       /remote human/,
239:     );
240:     expect(() => left.send(required(room.devices[2]), new Uint8Array([1]))).toThrow(/remote human/);
241:     room.net
242:       .transport(required(room.devices[0]))
243:       .send(required(room.devices[1]), new Uint8Array([1]));
244:     room.flush();
245:     expect(received).toHaveLength(4);
246:     const otherBody = { ...room.validatedGenesis.genesis, createdAt: 2 };
247:     const other = room.open(required(room.devices[0]), {
248:       ...room.validatedGenesis,
249:       genesis: { ...otherBody, gameId: genesisId(otherBody) },
250:     });
251:     try {
252:       other.send(required(room.gameKeys[1]), new Uint8Array([8]));
253:       room.flush();
254:       expect(received).toHaveLength(4);
255:     } finally {
256:       other.dispose();
257:     }
258:   } finally {
259:     right.dispose();
260:     left.dispose();
261:     room.dispose();
262:   }
263: });
264: 
265: test('rejects forged binding and every mismatched certified genesis projection', () => {
266:   const room = fixture();
267:   try {
268:     const options = {
269:       deviceTransport: room.net.transport(required(room.devices[0])),
270:       agreement: room.agreement,
271:       bindings: room.bindings,
272:       validatedGenesis: room.validatedGenesis,
273:     };
274:     const first = required(room.bindings[0]);
275:     expect(
276:       createOnlineGameTransport({
277:         ...options,
278:         bindings: [{ ...first, sig: required(room.bindings[1]).sig }, ...room.bindings.slice(1)],
279:       }),
280:     ).toMatchObject({ ok: false, error: { code: 'online-binding-signature' } });
281:     for (const genesis of [
282:       { ...room.validatedGenesis.genesis, ceremonyNonce: 'other' },
283:       { ...room.validatedGenesis.genesis, seats: room.validatedGenesis.genesis.seats.toReversed() },
284:       { ...room.validatedGenesis.genesis, commitments: { masters: [] } },
285:       {
286:         ...room.validatedGenesis.genesis,
287:         config: {
288:           ...room.validatedGenesis.genesis.config,
289:           seats: room.validatedGenesis.genesis.config.seats.slice(1),
290:         },
291:       },
292:       { ...room.validatedGenesis.genesis, security: 'stub' as const },
293:     ])
294:       expect(
295:         createOnlineGameTransport({
296:           ...options,
297:           validatedGenesis: { ...room.validatedGenesis, genesis },
298:         }),
299:       ).toMatchObject({ ok: false, error: { code: 'online-transport-genesis' } });
300:     expect(
301:       createOnlineGameTransport({
302:         ...options,
303:         deviceTransport: room.net.transport(required(room.devices[2])),
304:       }),
305:     ).toMatchObject({ ok: false, error: { code: 'online-transport-self' } });
306:   } finally {
307:     room.dispose();
308:   }
309: });
310: 
311: test('certified activation retires the old route and restores only the new device and game key', async () => {
312:   const data = createRecoveryFixture({ masterBackedBeacon: true });
313:   const start = value(validateGenesisOnlineStart(data.genesis)).bindings;
314:   const oldGame = required(data.genesis.seats[0]).publicKey;
315:   const oldDevice = required(
316:     start.agreement.state.seats.find((seat) => seat.seat === 0 && seat.kind === 'human'),
317:   );
318:   if (oldDevice.kind !== 'human') throw new Error('Missing old device');
319:   const newDevice = identityFromSecret(new Uint8Array(32).fill(111));
320:   const newGame = identityFromSecret(new Uint8Array(32).fill(112));
321:   const devices = [
322:     ...start.agreement.state.seats
323:       .filter((seat): seat is Extract<typeof seat, { kind: 'human' }> => seat.kind === 'human')
324:       .map((seat) => seat.peer),
325:     newDevice.peerId,
326:   ];
327:   const net = createMemnet({ peers: devices });
328:   const history = {
329:     genesisEntry: data.genesisEntry,
330:     entries: data.deckEntries,
331:     engine: data.source.engine,
332:     policy: data.policy,
333:   };
334:   const validatedGenesis: ValidatedGenesis = {
335:     genesis: data.genesis,
336:     state: data.beforeSetup.log.state,
337:   };
338:   const open = (device: PeerId, entries = data.deckEntries) =>
339:     value(
340:       createOnlineGameTransport({
341:         deviceTransport: net.transport(device),
342:         validatedGenesis,
343:         agreement: start.agreement,
344:         bindings: start.bindings,
345:         certifiedHistory: { ...history, entries },
346:       }),
347:     );
348:   const old = open(oldDevice.peer);
349:   const survivorDevice = required(
350:     start.agreement.state.seats.find((seat) => seat.seat === 1 && seat.kind === 'human'),
351:   );
352:   if (survivorDevice.kind !== 'human') throw new Error('Missing survivor device');
353:   const survivor = open(survivorDevice.peer);
354:   try {
355:     const parent = data.ready;
356:     const controller = required(parent.log.authority?.controllers.find(({ seat }) => seat === 0));
357:     const statement = {
358:       protocol: 'seat-transfer-v1' as const,
359:       genesisDigest: genesisDigest(data.genesis),
360:       anchor: transferEntryRef(parent.log.head),
361:       validUntilSeq: parent.log.head.seq + 64,
362:       mode: 'live' as const,
363:       seat: 0 as const,
364:       currentController: {
365:         publicKey: controller.publicKey,
366:         kind: controller.kind,
367:         activatedAt: controller.activatedAt,
368:         hostSeat: controller.hostSeat,
369:       },
370:       recovery: null,
371:       nextEpoch: parent.membership.epoch + 1,
372:       destination: {
373:         devicePeer: newDevice.peerId,
374:         gamePeer: newGame.peerId,
375:         transferEncryptionKey: encodePoint(scalePoint(G, 147n)),
376:       },
377:       replacements: [
378:         {
379:           seat: 0 as const,
380:           oldPublicKey: oldGame,
381:           newPublicKey: newGame.peerId,
382:           newHostSeat: 0 as const,
383:         },
384:       ],
385:     };
386:     const authorization = {
387:       kind: 'transfer-authorize' as const,
388:       statement,
389:       destinationDeviceSig: signObject(TRANSFER_DEVICE_DOMAIN, statement, newDevice.secretKey),
390:       destinationGameSig: signObject(TRANSFER_GAME_KEY_DOMAIN, statement, newGame.secretKey),
391:       replacementKeySigs: [],
392:       ownerIntent: {
393:         signer: 'current-game' as const,
394:         sig: signObject(TRANSFER_OWNER_GAME_DOMAIN, statement, recoveryFixtureKey(data, 0)),
395:       },
396:     };
397:     const authorizedEntry = signRecoveryFixtureEntry(
398:       data,
399:       parent,
400:       { kind: 'membership', change: authorization },
401:       parent.log.head.stateHash,
402:     );
403:     const authorizedCertificate = certifyRecoveryFixtureEntry(
404:       data,
405:       parent,
406:       authorizedEntry,
407:       [0, 1, 2, 3],
408:     );
409:     const authorized = advanceRecoveryFixture(parent, authorizedCertificate);
410:     const throughAuthorization = [...data.deckEntries, authorizedCertificate];
411:     expect(old.self).toBe(oldGame);
412:     expect(survivor.advanceCertifiedHistory(throughAuthorization).ok).toBe(true);
413:     expect(survivor.deviceRoutes()?.activeDevices).toContain(oldDevice.peer);
414:     expect(survivor.deviceRoutes()?.activeDevices).not.toContain(newDevice.peerId);
415:     const authorizedRoutes = survivor.deviceRoutes();
416:     const activationStatement = {
417:       protocol: 'seat-transfer-activation-v1' as const,
418:       genesisDigest: statement.genesisDigest,
419:       authorization: transferEntryRef(authorizedEntry),
420:       parent: transferEntryRef(authorized.log.head),
421:       nextEpoch: statement.nextEpoch,
422:       destinationDevice: newDevice.peerId,
423:       destinationGame: newGame.peerId,
424:       replacements: statement.replacements,
425:       checkDigest: transferCheckDigest(authorized.log, transferEntryRef(authorizedEntry)),
426:     };
427:     const activationEntry = signRecoveryFixtureEntry(
428:       data,
429:       authorized,
430:       {
431:         kind: 'membership',
432:         change: {
433:           kind: 'transfer-activate',
434:           statement: activationStatement,
435:           destinationCheck: signObject(
436:             TRANSFER_DESTINATION_CHECK_DOMAIN,
437:             activationStatement,
438:             newGame.secretKey,
439:           ),
440:           replacementChecks: [],
441:         },
442:       },
443:       authorized.log.head.stateHash,
444:     );
445:     const activationCertificate = certifyRecoveryFixtureEntry(
446:       data,
447:       authorized,
448:       activationEntry,
449:       [0, 1, 2, 3],
450:     );
451:     expect(
452:       survivor.advanceCertifiedHistory([
453:         ...throughAuthorization,
454:         { ...activationCertificate, certificate: [] },
455:       ]),
456:     ).toMatchObject({ ok: false });
457:     expect(survivor.peers()).toContain(oldGame);
458:     expect(survivor.deviceRoutes()).toEqual(authorizedRoutes);
459:     const throughActivation = [...throughAuthorization, activationCertificate];
460:     const staleInbox: string[] = [];
461:     const retiredInbox: string[] = [];
462:     const rawHints: string[] = [];
463:     net.transport(oldDevice.peer).onMessage((from, frame) => {
464:       if (from !== survivorDevice.peer || frame[0] !== 0x43 || frame[1] !== 0x50) return;
465:       const message = decodeProtocolMessage(frame.slice(4 + 1 + 32));
466:       if (message.ok) rawHints.push(message.value.t);
467:     });
468:     survivor.onMessage((_from, bytes) => {
469:       const message = decodeProtocolMessage(bytes);
470:       if (message.ok) retiredInbox.push(message.value.t);
471:     });
472:     net.disconnect(oldDevice.peer, survivorDevice.peer);
473:     expect(survivor.advanceCertifiedHistory(throughActivation).ok).toBe(true);
474:     expect(survivor.deviceRoutes()).toMatchObject({
475:       head: transferEntryRef(activationEntry),
476:       catchupDevices: [oldDevice.peer],
477:     });
478:     expect(survivor.deviceRoutes()?.activeDevices).toContain(newDevice.peerId);
479:     expect(survivor.deviceRoutes()?.activeDevices).not.toContain(oldDevice.peer);
480:     expect(survivor.peers()).not.toContain(oldGame);
481:     net.connect(oldDevice.peer, survivorDevice.peer);
482:     net.clock.advanceBy(0);
483:     expect(rawHints).toEqual(['COMMIT']);
484:     // The device receives the one-shot hint before the stale replica subscribes.
485:     old.onMessage((_from, bytes) => {
486:       const message = decodeProtocolMessage(bytes);
487:       if (message.ok) staleInbox.push(message.value.t);
488:     });
489:     expect(staleInbox).toEqual([]);
490:     expect(() => survivor.send(oldGame, value(encodeProtocolMessage({ t: 'PING', n: 1 })))).toThrow(
491:       /certified sync responses only/,
492:     );
493:     old.send(
494:       survivor.self,
495:       value(
496:         encodeProtocolMessage({
497:           t: 'SYNC_REQ',
498:           genesisDigest: statement.genesisDigest,
499:           fromSeq: authorizedEntry.seq,
500:         }),
501:       ),
502:     );
503:     old.send(survivor.self, value(encodeProtocolMessage({ t: 'PING', n: 2 })));
504:     net.clock.advanceBy(0);
505:     expect(retiredInbox).toEqual(['SYNC_REQ']);
506:     expect(rawHints.filter((kind) => kind === 'COMMIT')).toHaveLength(1);
507:     survivor.send(
508:       oldGame,
509:       value(
510:         encodeProtocolMessage({
511:           t: 'SYNC_RES',
512:           genesisDigest: statement.genesisDigest,
513:           entries: [authorizedCertificate, activationCertificate],
514:           more: false,
515:         }),
516:       ),
517:     );
518:     net.clock.advanceBy(0);
519:     expect(staleInbox).toContain('SYNC_RES');
520:     expect(survivor.peers()).not.toContain(oldGame);
521:     expect(old.advanceCertifiedHistory(throughActivation)).toMatchObject({
522:       ok: false,
523:       error: { code: 'online-transport-retired' },
524:     });
525:     expect(() => old.send(survivor.self, new Uint8Array([1]))).toThrow(/disposed/);
526:     const reopenedOld = open(oldDevice.peer, data.deckEntries);
527:     const restoredInbox: string[] = [];
528:     reopenedOld.onMessage((_from, bytes) => {
529:       const message = decodeProtocolMessage(bytes);
530:       if (message.ok) restoredInbox.push(message.value.t);
531:     });
532:     const reopenedSurvivor = open(survivorDevice.peer, throughActivation);
533:     const restoredRequests: string[] = [];
534:     reopenedSurvivor.onMessage((_from, bytes) => {
535:       const message = decodeProtocolMessage(bytes);
536:       if (message.ok) restoredRequests.push(message.value.t);
537:     });
538:     try {
539:       net.clock.advanceBy(0);
540:       expect(restoredInbox).toContain('COMMIT');
541:       reopenedOld.send(
542:         reopenedSurvivor.self,
543:         value(
544:           encodeProtocolMessage({
545:             t: 'SYNC_REQ',
546:             genesisDigest: statement.genesisDigest,
547:             fromSeq: authorizedEntry.seq,
548:           }),
549:         ),
550:       );
551:       net.clock.advanceBy(0);
552:       expect(restoredRequests).toEqual(['SYNC_REQ']);
553:       expect(reopenedSurvivor.peers()).not.toContain(oldGame);
554:     } finally {
555:       reopenedSurvivor.dispose();
556:       reopenedOld.dispose();
557:     }
558:     // Use the browser game factory with fresh destination safety, not genesis
559:     // credentials. The IndexedDB promotion transaction has separate storage tests.
560:     const journal = Object.assign(new MemoryProtocolJournal(), { close: async () => undefined });
561:     expect(
562:       await journal.initialize(
563:         data.genesisEntry,
564:         canonicalEncode(value(createConsensusState(data.beforeSetup, 0))),
565:       ),
566:     ).toBe(true);
567:     let restoredContext = data.beforeSetup;
568:     for (const certified of throughActivation) {
569:       restoredContext = advanceRecoveryFixture(restoredContext, certified);
570:       expect(
571:         // oxlint-disable-next-line no-await-in-loop -- Preserve contiguous certified history in this destination journal.
572:         await journal.commit(
573:           certified.entry.seq,
574:           0,
575:           certified,
576:           canonicalEncode(value(createConsensusState(restoredContext, 0))),
577:         ),
578:       ).toBe(true);
579:     }
580:     const input = {
581:       entry: data.genesisEntry,
582:       transcripts: data.deck.transcripts,
583:       agreement: start.agreement,
584:       bindings: start.bindings,
585:       material: [
586:         {
587:           seat: 0 as const,
588:           kind: 'human' as const,
589:           peerId: newGame.peerId,
590:           signingKey: newGame.secretKey,
591:           master: scalarToBytes(17n),
592:         },
593:       ],
594:       deviceTransport: net.transport(newDevice.peerId),
595:       store: new MemoryEscrowLifecycleStore(),
596:       clock: net.clock,
597:       engine: data.source.engine,
598:       journalMode: 'restore-only' as const,
599:     };
600:     const runtime = {
601:       acquireLease: async () => ({
602:         lockName: 'transfer-factory-test',
603:         run: async <T>(task: () => T | PromiseLike<T>): Promise<T> => task(),
604:         close: async () => undefined,
605:       }),
606:       createJournal: () => journal,
607:       auditRunner: () => {
608:         throw new Error('No terminal audit expected');
609:       },
610:     };
611:     const restored = await openOnlineGame(input, runtime);
612:     try {
613:       expect(restored.seat).toBe(0);
614:       expect(restored.session.getCommittedHead()).toMatchObject({ seq: activationEntry.seq });
615:       expect(restored.session.getPrivate(0)?.seat).toBe(0);
616:       expect(restored.session.getPrivate(1)).toBeNull();
617:       expect(restored.session.exportSave().entries).toEqual(throughActivation);
618:     } finally {
619:       await restored.close();
620:     }
621:     await expect(
622:       openOnlineGame(
623:         {
624:           ...input,
625:           material: [
626:             {
627:               ...required(input.material[0]),
628:               peerId: oldGame,
629:               signingKey: recoveryFixtureKey(data, 0),
630:             },
631:           ],
632:           deviceTransport: net.transport(oldDevice.peer),
633:         },
634:         runtime,
635:       ),
636:     ).rejects.toThrow(/Device has no|no longer controls/);
637:     input.material[0]?.master.fill(0);
638:     // Deliver the real session's queued startup announcement before probing one frame.
639:     net.clock.advanceBy(0);
640:     const replacement = open(newDevice.peerId, throughActivation);
641:     try {
642:       expect(replacement.self).toBe(newGame.peerId);
643:       expect(replacement.peers()).toContain(survivor.self);
644:       expect(survivor.peers()).toContain(newGame.peerId);
645:       expect(survivor.peers()).not.toContain(oldGame);
646:       const messages: PeerId[] = [];
647:       survivor.onMessage((from) => messages.push(from));
648:       replacement.send(survivor.self, new Uint8Array([2]));
649:       net.clock.advanceBy(0);
650:       expect(messages).toEqual([newGame.peerId]);
651:       expect(survivor.advanceCertifiedHistory(data.deckEntries)).toMatchObject({ ok: false });
652:     } finally {
653:       replacement.dispose();
654:     }
655:   } finally {
656:     survivor.dispose();
657:     old.dispose();
658:     net.dispose();
659:   }
660: }, 30_000);
661: 
662: test('rejects a separately signed device roster that claims the same public game keys', () => {
663:   const room = fixture();
664:   const sybilKeys = [41, 42].map((byte) => new Uint8Array(32).fill(byte));
665:   const sybils = sybilKeys.map((key) => identityFromSecret(key).peerId);
666:   const sybilNet = createMemnet({ peers: sybils });
667:   try {
668:     const state: LobbyFreezeAgreement['state'] = {
669:       ...room.agreement.state,
670:       hostPeer: required(sybils[0]),
671:       seats: room.agreement.state.seats.map((seat) => {
672:         if (seat.kind === 'human') return { ...seat, peer: required(sybils[seat.seat]) };
673:         if (seat.kind === 'bot')
674:           return { ...seat, botHost: required(sybils[seat.seat === 3 ? 1 : 0]) };
675:         return seat;
676:       }),
677:     };
678:     const stateHash = toHex(hashValue(state));
679:     const agreement: LobbyFreezeAgreement = {
680:       state,
681:       acks: [0, 1].map((seat) => {
682:         const body = {
683:           lobbyId: state.lobbyId,
684:           hostEpoch: state.hostEpoch,
685:           ceremonyNonce: required(state.ceremonyNonce),
686:           stateHash,
687:           peer: required(sybils[seat]),
688:         };
689:         return {
690:           body,
691:           sig: signObject('lobby-freeze-ack', body, required(sybilKeys[seat])),
692:         };
693:       }),
694:     };
695:     const bindings = room.bindings.map((binding) =>
696:       value(
697:         signGameSeatBinding({
698:           agreement,
699:           seat: binding.body.seat,
700:           deviceSecretKey: required(
701:             sybilKeys[binding.body.seat === 1 || binding.body.seat === 3 ? 1 : 0],
702:           ),
703:           gamePeer: binding.body.gamePeer,
704:           masterPub: binding.body.masterPub,
705:           encryptionKey: binding.body.encryptionKey,
706:         }),
707:       ),
708:     );
709:     expect(value(verifyGameSeatBindings(agreement, bindings)).genesisSeats).toEqual(
710:       room.validatedGenesis.genesis.seats,
711:     );
712:     expect(
713:       createOnlineGameTransport({
714:         deviceTransport: sybilNet.transport(required(sybils[0])),
715:         validatedGenesis: room.validatedGenesis,
716:         agreement,
717:         bindings,
718:       }),
719:     ).toMatchObject({ ok: false, error: { code: 'online-transport-genesis' } });
720:   } finally {
721:     sybilNet.dispose();
722:     room.dispose();
723:   }
724: });
725: 
726: test('one throwing gameplay listener cannot starve peers or other device subscribers', () => {
727:   const room = fixture();
728:   const left = room.open(required(room.devices[0]));
729:   const right = room.open(required(room.devices[1]));
730:   try {
731:     let delivered = 0;
732:     let raw = 0;
733:     right.onMessage(() => {
734:       throw new Error('broken view');
735:     });
736:     right.onMessage(() => delivered++);
737:     room.net.transport(required(room.devices[1])).onMessage(() => raw++);
738:     left.send(required(room.gameKeys[1]), new Uint8Array([9]));
739:     room.flush();
740:     expect(delivered).toBe(1);
741:     expect(raw).toBe(1);
742: 
743:     let peerChanges = 0;
744:     right.onPeerChange(() => {
745:       throw new Error('broken view');
746:     });
747:     right.onPeerChange(() => peerChanges++);
748:     room.net.disconnect(required(room.devices[0]), required(room.devices[1]));
749:     room.net.connect(required(room.devices[0]), required(room.devices[1]));
750:     expect(peerChanges).toBe(2);
751:   } finally {
752:     right.dispose();
753:     left.dispose();
754:     room.dispose();
755:   }
756: });
757: 
758: test('enforces message bounds, maps reconnects, and disposal keeps device transport alive', () => {
759:   const room = fixture();
760:   const left = room.open(required(room.devices[0]));
761:   const right = room.open(required(room.devices[1]));
762:   try {
763:     expect(MAX_PROTOCOL_MESSAGE_BYTES).toBeLessThan(MAX_WEBRTC_MESSAGE_BYTES);
764:     expect(() =>
765:       left.send(required(room.gameKeys[1]), new Uint8Array(MAX_PROTOCOL_MESSAGE_BYTES + 1)),
766:     ).toThrow(/transport limit/);
767:     const changes: string[] = [];
768:     left.onPeerChange((peer, online) => changes.push(`${peer}:${online}`));
769:     room.net.disconnect(required(room.devices[0]), required(room.devices[1]));
770:     expect(left.peers()).toEqual([]);
771:     room.net.connect(required(room.devices[0]), required(room.devices[1]));
772:     expect(left.peers()).toEqual([room.gameKeys[1]]);
773:     expect(changes).toEqual([`${room.gameKeys[1]}:false`, `${room.gameKeys[1]}:true`]);
774:     let gameplay = 0;
775:     let raw = 0;
776:     left.onMessage(() => gameplay++);
777:     room.net.transport(required(room.devices[0])).onMessage((_from, bytes) => {
778:       if (bytes[0] === 0x43 && bytes[1] === 0x50) raw++;
779:     });
780:     left.dispose();
781:     right.send(required(room.gameKeys[0]), new Uint8Array([3]));
782:     room.flush();
783:     expect(gameplay).toBe(0);
784:     expect(raw).toBe(1);
785:     expect(() => left.send(required(room.gameKeys[1]), new Uint8Array([1]))).toThrow(/disposed/);
786:   } finally {
787:     right.dispose();
788:     left.dispose();
789:     room.dispose();
790:   }
791: });
```


## apps/web/src/session/online-game.ts

```text
1: import { canonicalDecode, canonicalEncode, toBase64Url } from '@cp2p/codec';
2: import { G, encodePoint, identityFromSecret, scalarFromBytes, scalePoint } from '@cp2p/crypto';
3: import { RandomBot } from '@cp2p/bots';
4: import { success } from '@cp2p/engine';
5: import type { Engine, Seat } from '@cp2p/engine';
6: import {
7:   createBeaconSecretSource,
8:   createDeckSecretSource,
9:   createHandSecretSource,
10:   createStealSecretSource,
11:   deckCeremonyId,
12:   decksReady,
13:   genesisDigest,
14:   entryHash,
15:   initialProposalContext,
16:   replayCertifiedPrefix,
17:   transferChangeSchema,
18:   validateTransferOwnedMaterial,
19:   P2PSession,
20:   validateDeckCeremony,
21:   validateGenesisOnlineStart,
22:   VerifiedSessionDriver,
23: } from '@cp2p/protocol';
24: import type {
25:   BeaconSecretProvider,
26:   BeaconSecretSource,
27:   DeckSourceFactory,
28:   EscrowCeremonyStore,
29:   Genesis,
30:   LobbyFreezeAgreement,
31:   LogEntry,
32:   LogContext,
33:   CertifiedEntry,
34:   ProtocolClock,
35:   ProtocolJournal,
36:   ReplayPolicy,
37:   GameSession,
38:   SessionAuditRunner,
39:   SignedDeckPass,
40:   SignedGameSeatBinding,
41:   Transport,
42: } from '@cp2p/protocol';
43: import { acquireActiveGameWriterLease, IndexedDbProtocolJournal } from '@cp2p/storage';
44: import type { GameWriterLease } from '@cp2p/storage';
45: import * as v from 'valibot';
46: import type { OwnedSeatMaterial } from './online-credentials.js';
47: import { createOnlineGameTransport } from './online-game-transport.js';
48: import type { OnlineDeviceRoutes, OnlineGameTransport } from './online-game-transport.js';
49: import { createOnlineGameCandidateStore } from './online-game-candidates.js';
50: import { createSessionAuditRunner } from './audit-worker-client.js';
51: import { browserEntropy, randomIndex, randomSeed } from './random.js';
52: 
53: type OnlineJournal = ProtocolJournal & { close(): Promise<void> };
54: 
55: export interface OnlineGameRuntime {
56:   readonly acquireLease?: typeof acquireActiveGameWriterLease;
57:   readonly createJournal?: (
58:     gameId: string,
59:     keyBinding: { recordKey: string; bytes: Uint8Array },
60:   ) => OnlineJournal;
61:   readonly auditRunner?: SessionAuditRunner;
62: }
63: 
64: export interface OnlineGameInput {
65:   readonly entry: LogEntry;
66:   readonly transcripts: readonly { deckId: string; passes: readonly SignedDeckPass[] }[];
67:   readonly agreement: LobbyFreezeAgreement;
68:   readonly bindings: readonly SignedGameSeatBinding[];
69:   readonly material: readonly OwnedSeatMaterial[];
70:   readonly deviceTransport: Transport;
71:   readonly store: EscrowCeremonyStore;
72:   readonly clock: ProtocolClock;
73:   readonly engine: Engine;
74:   readonly botDelayMs?: number;
75:   readonly signal?: AbortSignal;
76:   /** Immediate fatal fence for an unexpectedly lost exclusive game writer. */
77:   readonly onFatal?: (error: Error) => void;
78:   readonly onDeviceRoutes?: (routes: OnlineDeviceRoutes) => void;
79:   /** Resume preserves history; the built-in journal may initialize only an atomically proven unused slot. */
80:   readonly journalMode?: 'fresh-or-restore' | 'restore-only';
81: }
82: 
83: export interface OnlineGame<T extends GameSession = P2PSession> {
84:   readonly gameId: string;
85:   readonly genesis: Genesis;
86:   readonly seat: Seat;
87:   readonly session: T;
88:   close(): Promise<void>;
89: }
90: 
91: /** Opens only an authenticated, fully verified ceremony result under an exclusive game writer. */
92: export async function openOnlineGame(
93:   supplied: OnlineGameInput,
94:   runtime: OnlineGameRuntime = {},
95: ): Promise<OnlineGame> {
96:   // Retain detached public evidence across asynchronous lease and storage work.
97:   const input = {
98:     ...supplied,
99:     entry: copyEvidence(supplied.entry),
100:     transcripts: copyEvidence(supplied.transcripts),
101:     agreement: copyEvidence(supplied.agreement),
102:     bindings: copyEvidence(supplied.bindings),
103:   };
104:   const material = input.material.map((item) => ({
105:     ...item,
106:     signingKey: new Uint8Array(item.signingKey),
107:     master: new Uint8Array(item.master),
108:   }));
109:   let journal: OnlineJournal | null = null;
110:   let lease: GameWriterLease | null = null;
111:   let transport: OnlineGameTransport | null = null;
112:   let session: P2PSession | null = null;
113:   let leaseLost = false;
114:   const providers = new Map<Seat, BeaconSecretProvider>();
115:   const checkCancelled = () => {
116:     if (input.signal?.aborted || leaseLost)
117:       throw new DOMException('Online game opening was cancelled', 'AbortError');
118:   };
119:   const stopOutput = () => transport?.dispose();
120:   input.signal?.addEventListener('abort', stopOutput, { once: true });
121:   const cleanup = async () => {
122:     input.signal?.removeEventListener('abort', stopOutput);
123:     try {
124:       session?.dispose();
125:       await session?.flush();
126:     } finally {
127:       transport?.dispose();
128:       for (const provider of providers.values()) provider.dispose();
129:       for (const item of material) {
130:         item.signingKey.fill(0);
131:         item.master.fill(0);
132:       }
133:       try {
134:         await journal?.close();
135:       } finally {
136:         await lease?.close();
137:       }
138:     }
139:   };
140:   try {
141:     checkCancelled();
142:     const policy: ReplayPolicy = {
143:       genesis: {
144:         verifyCommitments(genesis) {
145:           const decks = validateDeckCeremony(genesis, input.transcripts);
146:           return decks.ok ? success(undefined) : decks;
147:         },
148:       },
149:       entry: {},
150:     };
151:     const checked = initialProposalContext(input.entry, input.engine, policy);
152:     if (!checked.ok) throw new Error(checked.error.message);
153:     const { genesis, state, crypto } = checked.value.log;
154:     const startup = validateGenesisOnlineStart(genesis);
155:     if (!startup.ok) throw new Error(startup.error.message);
156:     if (!crypto) throw new Error('Verified game commitments are missing');
157:     const humans = material.filter((seat) => seat.kind === 'human');
158:     const local = humans[0];
159:     if (humans.length !== 1 || !local) throw new Error('Stored material needs one human seat');
160:     lease = await (runtime.acquireLease ?? acquireActiveGameWriterLease)(genesis.gameId, {
161:       onLost(error) {
162:         leaseLost = true;
163:         transport?.dispose();
164:         session?.dispose();
165:         try {
166:           input.onFatal?.(error);
167:         } catch {
168:           // Reporting failure cannot restore authority or resume output.
169:         }
170:       },
171:     });
172:     checkCancelled();
173:     if (!lease) throw new Error('This game is already active in another tab');
174:     const digest = genesisDigest(genesis);
175:     const keyBinding = {
176:       recordKey: `online-game/${digest}/keys`,
177:       bytes: canonicalEncode({
178:         protocol: 'online-game-keys-v1',
179:         genesisDigest: digest,
180:         devicePeer: input.deviceTransport.self,
181:         humanSeat: local.seat,
182:         seats: material,
183:       }),
184:     };
185:     try {
186:       journal = runtime.createJournal
187:         ? runtime.createJournal(genesis.gameId, keyBinding)
188:         : new IndexedDbProtocolJournal(genesis.gameId, { keyBinding });
189:     } finally {
190:       keyBinding.bytes.fill(0);
191:     }
192:     const saved = await journal.load();
193:     checkCancelled();
194:     if (saved && entryHash(saved.genesis) !== entryHash(input.entry))
195:       throw new Error('Stored game history differs from the certified online start');
196:     let installed: LogContext | null =
197:       checked.value.log.authority?.controllers.find((seat) => seat.seat === local.seat)
198:         ?.publicKey === local.peerId
199:         ? checked.value.log
200:         : null;
201:     let priorKey = checked.value.log.authority?.controllers.find(
202:       (seat) => seat.seat === local.seat,
203:     )?.publicKey;
204:     const replayed = saved
205:       ? replayCertifiedPrefix(
206:           saved.genesis,
207:           saved.entries,
208:           input.engine,
209:           policy,
210:           (_entry, next) => {
211:             const key = next.log.authority?.controllers.find(
212:               (seat) => seat.seat === local.seat,
213:             )?.publicKey;
214:             if (key !== priorKey && key === local.peerId) installed = next.log;
215:             priorKey = key;
216:             return success(undefined);
217:           },
218:         )
219:       : success({ context: checked.value });
220:     if (!replayed.ok) throw new Error(replayed.error.message);
221:     const current = replayed.value.context.log;
222:     if (!installed) throw new Error('Stored game key has no certified owning generation');
223:     // The durable binding contains exactly the seats installed with this human
224:     // key. Later recovery adds separately persisted bots; a return can retire one.
225:     if (current.crypto && decksReady(current.crypto.decks)) {
226:       const ownedMaterial = validateTransferOwnedMaterial(
227:         {
228:           protocol: 'online-game-keys-v1',
229:           genesisDigest: digest,
230:           devicePeer: input.deviceTransport.self,
231:           humanSeat: local.seat,
232:           seats: material,
233:         },
234:         { ...installed, crypto: current.crypto },
235:       );
236:       if (!ownedMaterial.ok) throw new Error(ownedMaterial.error.message);
237:       for (const seat of ownedMaterial.value.seats) {
238:         seat.signingKey.fill(0);
239:         seat.master.fill(0);
240:       }
241:     } else {
242:       // Before certified deck setup only the original frozen owners can open.
243:       // Driver/source checks below validate the available deck and beacon data.
244:       const owned = genesis.seats.filter(
245:         (seat) =>
246:           seat.seat === local.seat || (seat.kind === 'bot' && seat.botHost === local.peerId),
247:       );
248:       if (
249:         installed.head.seq !== 0 ||
250:         material.length !== owned.length ||
251:         material.some(
252:           (item, index) =>
253:             item.seat !== owned[index]?.seat ||
254:             item.kind !== owned[index]?.kind ||
255:             item.peerId !== owned[index]?.publicKey,
256:         )
257:       )
258:         throw new Error('Stored game keys differ from the frozen device-owned seats');
259:       for (const item of material) {
260:         const identity = identityFromSecret(item.signingKey);
261:         try {
262:           if (
263:             identity.peerId !== item.peerId ||
264:             encodePoint(scalePoint(G, scalarFromBytes(item.master, { nonzero: true }))) !==
265:               startup.value.bindings.masters.find((entry) => entry.seat === item.seat)?.masterPub
266:           )
267:             throw new Error('Stored game secrets do not match the certified identity');
268:         } finally {
269:           identity.secretKey.fill(0);
270:         }
271:       }
272:     }
273:     const projection = createOnlineGameTransport({
274:       deviceTransport: input.deviceTransport,
275:       validatedGenesis: { genesis, state },
276:       agreement: input.agreement,
277:       bindings: input.bindings,
278:       certifiedHistory: {
279:         genesisEntry: input.entry,
280:         entries: saved?.entries ?? [],
281:         engine: input.engine,
282:         policy,
283:       },
284:     });
285:     if (!projection.ok) throw new Error(projection.error.message);
286:     transport = projection.value;
287:     const human = current.authority?.controllers.find(
288:       (seat) => seat.seat === local.seat && seat.kind === 'human' && seat.status === 'active',
289:     );
290:     if (!human || human.publicKey !== local.peerId || transport.self !== local.peerId)
291:       throw new Error('The stored human key no longer controls this seat');
292:     const activeMaterial = material.filter((item) =>
293:       current.authority?.controllers.some(
294:         (seat) =>
295:           seat.seat === item.seat &&
296:           seat.kind === item.kind &&
297:           seat.status === 'active' &&
298:           seat.hostSeat === human.seat &&
299:           seat.publicKey === item.peerId,
300:       ),
301:     );
302:     const ownedMaterial = new Map(activeMaterial.map((item) => [item.seat, item]));
303:     // The journal retains the exact installing-generation binding. Working
304:     // secrets belong only to the seats still controlled at the restored head.
305:     for (const item of material) {
306:       if (ownedMaterial.has(item.seat)) continue;
307:       item.signingKey.fill(0);
308:       item.master.fill(0);
309:     }
310:     const masterFor = (seat: Seat) => {
311:       const entry = ownedMaterial.get(seat);
312:       if (!entry) throw new Error('Cannot derive secrets for another device');
313:       return entry.master;
314:     };
315:     const deckSource: DeckSourceFactory = (deckId, seat) => {
316:       const definition = crypto.decks.decks.find(
317:         (deck) => deck.commitment.definition.deckId === deckId,
318:       )?.commitment.definition;
319:       if (!definition) throw new Error('Unknown verified deck');
320:       return createDeckSecretSource(masterFor(seat), definition, seat);
321:     };
322:     const stealSource = (seat: Seat) => {
323:       const owner = genesis.seats.find((item) => item.seat === seat);
324:       if (!owner) throw new Error("Cannot derive another device's encryption key");
325:       return createStealSecretSource(masterFor(seat), genesis.ceremonyNonce, seat, owner.publicKey);
326:     };
327:     const chain = crypto.beacon.chains.find((item) => item.seat === human.seat);
328:     if (!chain) throw new Error('Missing human beacon commitment');
329:     const beacon = createBeaconSecretSource(
330:       local.master,
331:       { ceremonyId: deckCeremonyId(genesis), seat: human.seat },
332:       chain.length,
333:     );
334:     providers.set(human.seat, beacon);
335:     if (toBase64Url(beacon.initialCommitment.tip) !== chain.tip)
336:       throw new Error('Stored master differs from the frozen beacon chain');
337:     const beaconSources = new Map<Seat, BeaconSecretSource>();
338:     for (const item of activeMaterial) {
339:       if (item.kind !== 'bot') continue;
340:       const originalChain = crypto.beacon.chains.find((candidate) => candidate.seat === item.seat);
341:       if (!originalChain) {
342:         if (genesis.seats.find((seat) => seat.seat === item.seat)?.kind === 'bot') continue;
343:         throw new Error('Missing hosted-seat beacon commitment');
344:       }
345:       const provider = createBeaconSecretSource(
346:         item.master,
347:         { ceremonyId: deckCeremonyId(genesis), seat: item.seat },
348:         originalChain.length,
349:       );
350:       providers.set(item.seat, provider);
351:       if (toBase64Url(provider.initialCommitment.tip) !== originalChain.tip)
352:         throw new Error('Hosted master differs from the frozen beacon chain');
353:       beaconSources.set(item.seat, provider.source);
354:     }
355:     const bot = new RandomBot();
356:     const botKeys = new Map(
357:       activeMaterial
358:         .filter((item) => item.kind === 'bot')
359:         .map((item) => [item.seat, item.signingKey]),
360:     );
361:     const options = {
362:       genesisEntry: input.entry,
363:       engine: input.engine,
364:       policy,
365:       seat: human.seat,
366:       secretKey: local.signingKey,
367:       transport,
368:       clock: input.clock,
369:       journal,
370:       onMembershipCommitted(entries: readonly CertifiedEntry[]) {
371:         const routed = projection.value.advanceCertifiedHistory(entries);
372:         const payload = entries.at(-1)?.entry.payload;
373:         const transfer =
374:           payload?.kind === 'membership' ? v.safeParse(transferChangeSchema, payload.change) : null;
375:         const replacements =
376:           transfer?.success && transfer.output.kind === 'transfer-activate'
377:             ? transfer.output.statement.replacements
378:             : [];
379:         const retired = !routed.ok && routed.error.code === 'online-transport-retired';
380:         if (routed.ok) {
381:           const routes = projection.value.deviceRoutes();
382:           if (routes) input.onDeviceRoutes?.(routes);
383:         }
384:         for (const item of material) {
385:           if (
386:             !retired &&
387:             !replacements.some(
388:               (replacement) =>
389:                 replacement.seat === item.seat && replacement.oldPublicKey === item.peerId,
390:             )
391:           )
392:             continue;
393:           item.signingKey.fill(0);
394:           item.master.fill(0);
395:           ownedMaterial.delete(item.seat);
396:           providers.get(item.seat)?.dispose();
397:           providers.delete(item.seat);
398:         }
399:         // The final commit was sent with the old route. Retirement disposes this
400:         // immutable signer/transport; the destination opens a fresh instance.
401:         return retired ? success(undefined) : routed;
402:       },
403:       botKeys,
404:       botDelayMs: input.botDelayMs ?? 800,
405:       decideBot: (
406:         view: Parameters<RandomBot['decide']>[0],
407:         pending: Parameters<RandomBot['decide']>[1],
408:       ) => bot.decide(view, pending, { int: (max) => randomIndex(browserEntropy, max) }),
409:       beaconSource: beacon.source,
410:       beaconSources,
411:       beaconContributions: input.store,
412:       deckSetupPasses: input.transcripts.flatMap(({ deckId, passes }) =>
413:         passes.map((pass) => ({ deckId, pass })),
414:       ),
415:       createDeckSource: deckSource,
416:       deckContributions: input.store,
417:       countContributionStore: input.store,
418:       stealDeliveryStore: input.store,
419:       cheatCandidateStore: createOnlineGameCandidateStore(input.store, digest),
420:       recoveryStore: input.store,
421:       transferPrivateOutbox: input.store,
422:       transferPrivateImportStore: input.store,
423:       recoveryParticipant: {
424:         store: input.store,
425:         privateEntropy: () => randomSeed(browserEntropy),
426:         encryptionSecret: () => {
427:           const source = stealSource(human.seat);
428:           try {
429:             return source.encryptionSecret();
430:           } finally {
431:             source.dispose();
432:           }
433:         },
434:       },
435:       createDriver: (
436:         engine: Engine,
437:         approved: Genesis,
438:         _clock: ProtocolClock,
439:         seats: readonly Seat[],
440:       ) =>
441:         new VerifiedSessionDriver(
442:           engine,
443:           approved,
444:           seats,
445:           deckSource,
446:           (seat) => createHandSecretSource(masterFor(seat), digest, seat),
447:           stealSource,
448:         ),
449:       masterReveal: {
450:         store: input.store,
451:         async loadOwnedMaster(seat: Seat) {
452:           const item = ownedMaterial.get(seat);
453:           return item ? new Uint8Array(item.master) : null;
454:         },
455:       },
456:       auditRunner: runtime.auditRunner ?? createSessionAuditRunner(),
457:     };
458:     // The built-in journal returns null only when genesis, entries, safety and
459:     // its bound voting-key record are all absent in one IndexedDB transaction.
460:     // Injected journals have no equivalent proof and must remain restore-only.
461:     if (input.journalMode === 'restore-only' && !saved && runtime.createJournal)
462:       throw new Error('The certified online game journal is missing');
463:     const opened = await lease.run(() => {
464:       checkCancelled();
465:       return saved ? P2PSession.restore(options) : P2PSession.create(options);
466:     });
467:     if (!opened.ok) throw new Error(opened.error.message);
468:     session = opened.value;
469:     checkCancelled();
470:     const routes = projection.value.deviceRoutes();
471:     if (routes) input.onDeviceRoutes?.(routes);
472:     let closing: Promise<void> | null = null;
473:     return {
474:       gameId: genesis.gameId,
475:       genesis,
476:       seat: human.seat,
477:       session,
478:       close() {
479:         closing ??= Promise.resolve().then(cleanup);
480:         return closing;
481:       },
482:     };
483:   } catch (error) {
484:     await cleanup();
485:     throw error;
486:   }
487: }
488: 
489: function copyEvidence<T>(value: T): T {
490:   // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The same canonical value is detached here and validated before use.
491:   return canonicalDecode(canonicalEncode(value)) as T;
492: }
```


## apps/web/src/session/online-startup.ts

```text
1: import {
2:   canonicalDecode,
3:   canonicalEncode,
4:   fromBase64Url,
5:   hashValue,
6:   toBase64Url,
7:   toHex,
8: } from '@cp2p/codec';
9: import { failure, success } from '@cp2p/engine';
10: import type { Engine, Result } from '@cp2p/engine';
11: import { OnlineCeremony, genesisDigest, verifyLobbyFreezeAgreement } from '@cp2p/protocol';
12: import type {
13:   EscrowCeremonyStore,
14:   LobbyController,
15:   LobbyFreezeAgreement,
16:   OnlineCeremonyProgress,
17:   LobbyState,
18:   ProtocolClock,
19:   Transport,
20:   Unsubscribe,
21: } from '@cp2p/protocol';
22: import { loadCeremonyMaterial, prepareCeremonyMaterial } from './online-credentials.js';
23: import type { DisposableOnlineIdentity, OwnedCeremonyMaterial } from './online-credentials.js';
24: import { openOnlineGame } from './online-game.js';
25: import type { OnlineGame, OnlineGameRuntime } from './online-game.js';
26: import type { OnlineDeviceRoutes } from './online-game-transport.js';
27: import type { OnlineInvite } from './online-invite.js';
28: import { assertSupportedOnlineGameVersion, saveOnlineGameRecord } from './online-game-records.js';
29: import type { SavedOnlineGameRecord } from './online-game-records.js';
30: import { loadActiveOnlineResume } from './online-resume-binding.js';
31: 
32: export interface OnlineStartupSnapshot {
33:   readonly phase: OnlineCeremonyProgress['phase'] | 'freezing' | 'opening' | 'playing' | 'halted';
34:   readonly awaitingSeats: readonly number[];
35:   readonly locallyConsented: boolean;
36:   readonly error: string | null;
37:   readonly gameId: string | null;
38: }
39: 
40: interface OnlineStartupBase {
41:   readonly invite: OnlineInvite;
42:   readonly identity: DisposableOnlineIdentity;
43:   readonly transport: Transport;
44:   readonly store: EscrowCeremonyStore;
45:   readonly clock: ProtocolClock;
46:   readonly engine: Engine;
47:   readonly gameRuntime?: OnlineGameRuntime;
48:   readonly onGameFatal?: (error: Error) => void;
49:   readonly onDeviceRoutes?: (routes: OnlineDeviceRoutes) => void;
50: }
51: 
52: export type OnlineStartupOptions = OnlineStartupBase &
53:   (
54:     | {
55:         readonly lobby: LobbyController;
56:         /** Removes unseated connections and freezes discovery before key disclosure. */
57:         readonly freezePeers: (peers: readonly string[]) => void;
58:         readonly resume?: never;
59:         readonly approved?: never;
60:       }
61:     | {
62:         readonly resume: SavedOnlineGameRecord;
63:         readonly lobby?: never;
64:         readonly freezePeers?: never;
65:         readonly approved?: never;
66:       }
67:     | {
68:         /** The worker receives this only after the main lobby formed every signed ACK. */
69:         readonly approved: LobbyFreezeAgreement;
70:         readonly lobby?: never;
71:         readonly freezePeers?: never;
72:         readonly resume?: never;
73:       }
74:   );
75: 
76: /** Owns the immutable transition from device-key lobby consent to a game-key session. */
77: export class OnlineStartup {
78:   private readonly listeners = new Set<() => void>();
79:   private readonly unsubscribers: Unsubscribe[] = [];
80:   private current: OnlineStartupSnapshot | null = null;
81:   private approved: LobbyFreezeAgreement | null = null;
82:   private material: Pick<OwnedCeremonyMaterial, 'keys' | 'dispose'> | null = null;
83:   private ceremony: OnlineCeremony | null = null;
84:   private activeGame: OnlineGame | null = null;
85:   private work: Promise<void> | null = null;
86:   private retry: unknown = null;
87:   private closed = false;
88:   private closing: Promise<void> | null = null;
89:   private activationAttempted = false;
90:   private revoked = false;
91:   private stoppingGame: Promise<void> | null = null;
92:   private readonly abort = new AbortController();
93:   private readonly resume: SavedOnlineGameRecord | null;
94:   private readonly invite: OnlineInvite;
95: 
96:   constructor(private readonly options: OnlineStartupOptions) {
97:     this.invite = copyEvidence(options.invite);
98:     if (options.resume) {
99:       assertSupportedOnlineGameVersion(options.resume.result.genesis);
100:       if (options.resume.result.entry.payload.kind === 'genesis')
101:         assertSupportedOnlineGameVersion(options.resume.result.entry.payload.genesis);
102:     }
103:     this.resume = options.resume ? copyEvidence(options.resume) : null;
104:     if (this.resume) {
105:       const checked = verifyLobbyFreezeAgreement(this.resume.agreement);
106:       if (
107:         !checked.ok ||
108:         genesisDigest(this.resume.result.genesis) !== this.resume.genesisDigest ||
109:         this.resume.result.genesis.gameId !== this.resume.gameId ||
110:         !sameBytes(canonicalEncode(this.resume.invite), canonicalEncode(this.invite))
111:       )
112:         throw new Error('Saved online game does not match its signed agreement');
113:       this.approved = checked.value;
114:       this.current = {
115:         phase: 'opening',
116:         awaitingSeats: [],
117:         locallyConsented: true,
118:         error: null,
119:         gameId: this.resume.gameId,
120:       };
121:     } else if (options.approved) {
122:       const checked = verifyLobbyFreezeAgreement(options.approved);
123:       if (!checked.ok || checked.value.state.lobbyId !== this.invite.roomId)
124:         throw new Error('Approved online start has an invalid signed agreement');
125:       this.approved = checked.value;
126:       this.current = {
127:         phase: 'frozen',
128:         awaitingSeats: [],
129:         locallyConsented: true,
130:         error: null,
131:         gameId: null,
132:       };
133:     }
134:     if (options.lobby) this.unsubscribers.push(options.lobby.onChange(() => this.observe()));
135:     this.unsubscribers.push(options.transport.onPeerChange(() => this.observe()));
136:     this.observe();
137:   }
138: 
139:   snapshot(): OnlineStartupSnapshot | null {
140:     return this.current
141:       ? { ...this.current, awaitingSeats: [...this.current.awaitingSeats] }
142:       : null;
143:   }
144: 
145:   agreement(): LobbyFreezeAgreement | null {
146:     // The verifier returns detached data; callers never receive the retained snapshot.
147:     if (!this.approved) return null;
148:     const checked = verifyLobbyFreezeAgreement(this.approved);
149:     return checked.ok ? checked.value : null;
150:   }
151: 
152:   game(): OnlineGame | null {
153:     return this.activeGame;
154:   }
155: 
156:   subscribe(listener: () => void): Unsubscribe {
157:     this.listeners.add(listener);
158:     return () => {
159:       this.listeners.delete(listener);
160:     };
161:   }
162: 
163:   begin(): Result<void> {
164:     if (!this.options.lobby)
165:       return failure('online-start-resume', 'A saved game cannot start a new lobby ceremony');
166:     if (this.closed || this.approved || this.current)
167:       return failure('online-start-active', 'An online start is already active');
168:     const bytes = new Uint8Array(32);
169:     globalThis.crypto.getRandomValues(bytes);
170:     return this.options.lobby.start(toBase64Url(bytes));
171:   }
172: 
173:   /** Retry this exact attempt after storage or writer contention, never a new freeze. */
174:   async retryFailed(): Promise<Result<void>> {
175:     if (
176:       this.closed ||
177:       this.revoked ||
178:       this.activeGame ||
179:       this.work ||
180:       this.current?.phase !== 'error'
181:     )
182:       return failure('online-start-retry', 'There is no failed start ready to retry');
183:     if (this.ceremony && !this.ceremony.result()) {
184:       this.ceremony.dispose();
185:       await this.ceremony.flush();
186:       this.ceremony = null;
187:     }
188:     if (this.closed) return failure('online-start-closed', 'The room is closed');
189:     this.activationAttempted = false;
190:     this.update({
191:       phase: 'frozen',
192:       awaitingSeats: [],
193:       locallyConsented: this.current.locallyConsented,
194:       error: null,
195:       gameId: this.current.gameId,
196:     });
197:     this.observe();
198:     return success(undefined);
199:   }
200: 
201:   /** Closing stops output immediately, then drains writes before the room releases its lock. */
202:   close(): Promise<void> {
203:     if (this.closing) return this.closing;
204:     this.closed = true;
205:     this.abort.abort();
206:     if (this.retry !== null) this.options.clock.clearTimeout(this.retry);
207:     this.retry = null;
208:     for (const unsubscribe of this.unsubscribers) unsubscribe();
209:     this.ceremony?.dispose();
210:     this.listeners.clear();
211:     this.closing = Promise.resolve().then(() => this.releaseResources());
212:     return this.closing;
213:   }
214: 
215:   private async releaseResources(): Promise<void> {
216:     try {
217:       await this.work;
218:       await this.ceremony?.flush();
219:       await this.stoppingGame;
220:       await this.activeGame?.close();
221:     } finally {
222:       this.material?.dispose();
223:       this.material = null;
224:     }
225:   }
226: 
227:   private update(value: OnlineStartupSnapshot): void {
228:     if (this.closed) return;
229:     this.current = value;
230:     for (const listener of this.listeners) {
231:       try {
232:         listener();
233:       } catch {
234:         /* A view cannot interrupt the durable start. */
235:       }
236:     }
237:   }
238: 
239:   private fail(error: unknown): void {
240:     if (this.revoked) return;
241:     this.update({
242:       phase: 'error',
243:       awaitingSeats: [],
244:       locallyConsented: this.ceremony?.snapshot().locallyConsented ?? Boolean(this.resume),
245:       error: error instanceof Error ? error.message : 'Online startup failed',
246:       gameId: this.resume?.gameId ?? this.current?.gameId ?? null,
247:     });
248:   }
249: 
250:   private observe(): void {
251:     if (
252:       this.closed ||
253:       this.revoked ||
254:       this.work ||
255:       this.activeGame ||
256:       this.current?.phase === 'error'
257:     )
258:       return;
259:     this.work = Promise.resolve()
260:       .then(() => this.advance())
261:       .catch((error: unknown) => this.fail(error))
262:       .finally(() => {
263:         this.work = null;
264:         if (this.closed || this.revoked || this.activeGame || this.current?.phase === 'error')
265:           return;
266:         if (this.retry === null) {
267:           this.retry = this.options.clock.setTimeout(() => {
268:             this.retry = null;
269:             this.observe();
270:           }, 1_000);
271:         }
272:       });
273:   }
274: 
275:   private async advance(): Promise<void> {
276:     if (this.closed || this.revoked) return;
277:     if (!this.approved) {
278:       const lobby = this.options.lobby;
279:       if (!lobby) throw new Error('Saved game has no verified freeze agreement');
280:       const state = lobby.state();
281:       if (!state || state.status !== 'starting') return;
282:       if (
283:         !state.seats.some(
284:           (seat) => seat.kind === 'human' && seat.peer === this.options.identity.peerId,
285:         )
286:       )
287:         return;
288:       this.update({
289:         phase: 'freezing',
290:         awaitingSeats: [],
291:         locallyConsented: false,
292:         error: null,
293:         gameId: null,
294:       });
295:       const freezeHash = toHex(hashValue(state));
296:       await this.pin(`online-freeze/${this.options.identity.peerId}/${state.ceremonyNonce}`, {
297:         protocol: 'online-freeze-pin-v1',
298:         freezeHash,
299:       });
300:       if (this.closed) return;
301:       const current = lobby.state();
302:       if (!current || toHex(hashValue(current)) !== freezeHash) return;
303:       // Exact ACK retries also let the host retransmit a dropped all-human agreement.
304:       const acknowledged = lobby.ackFreeze();
305:       if (!acknowledged.ok) return;
306:       const agreement = lobby.freezeAgreement();
307:       if (!agreement) return;
308:       const checked = verifyLobbyFreezeAgreement(agreement);
309:       if (!checked.ok) throw new Error(checked.error.message);
310:       const approved = checked.value;
311:       if (toHex(hashValue(approved.state)) !== freezeHash)
312:         throw new Error('Lobby changed after the locally pinned freeze');
313:       await this.pin(`online-start/${freezeHash}/agreement`, {
314:         protocol: 'online-browser-start-v1',
315:         invite: this.invite,
316:         agreement: approved,
317:       });
318:       if (this.closed) return;
319:       const freezePeers = this.options.freezePeers;
320:       if (!freezePeers) throw new Error('Fresh online start has no roster freeze');
321:       freezePeers(
322:         approved.state.seats.flatMap((seat) => (seat.kind === 'human' ? [seat.peer] : [])),
323:       );
324:       this.approved = approved;
325:     }
326:     if (this.resume && !this.ceremony) {
327:       const active = await loadActiveOnlineResume({
328:         store: this.options.store,
329:         record: this.resume,
330:         devicePeer: this.options.identity.peerId,
331:         engine: this.options.engine,
332:         includeMaterial: true,
333:         ...(this.options.gameRuntime?.createJournal
334:           ? { createJournal: this.options.gameRuntime.createJournal }
335:           : {}),
336:       });
337:       if (this.closed) {
338:         active.material?.dispose();
339:         return;
340:       }
341:       const original = this.resume.result.genesis.seats.some(
342:         (seat) =>
343:           seat.seat === active.humanSeat &&
344:           seat.kind === 'human' &&
345:           seat.publicKey === active.gamePeer &&
346:           this.approved?.state.seats.some(
347:             (frozen) =>
348:               frozen.seat === seat.seat &&
349:               frozen.kind === 'human' &&
350:               frozen.peer === this.options.identity.peerId,
351:           ),
352:       );
353:       if (!original) {
354:         if (!active.material) throw new Error('Transferred device has no active owned binding');
355:         this.material?.dispose();
356:         this.material = active.material;
357:         await this.openTransferredResume();
358:         return;
359:       }
360:       active.material?.dispose();
361:     }
362:     if (!this.ceremony) {
363:       const approved = this.approved;
364:       if (!this.resume && this.options.approved) {
365:         const freezeHash = toHex(hashValue(approved.state));
366:         await this.requirePin(
367:           `online-freeze/${this.options.identity.peerId}/${approved.state.ceremonyNonce}`,
368:           { protocol: 'online-freeze-pin-v1', freezeHash },
369:         );
370:         await this.pin(`online-start/${freezeHash}/agreement`, {
371:           protocol: 'online-browser-start-v1',
372:           invite: this.invite,
373:           agreement: approved,
374:         });
375:       }
376:       if (this.resume) {
377:         const freezeHash = toHex(hashValue(approved.state));
378:         await this.requirePin(
379:           `online-freeze/${this.options.identity.peerId}/${approved.state.ceremonyNonce}`,
380:           {
381:             protocol: 'online-freeze-pin-v1',
382:             freezeHash,
383:           },
384:         );
385:         await this.requirePin(`online-start/${freezeHash}/agreement`, {
386:           protocol: 'online-browser-start-v1',
387:           invite: this.invite,
388:           agreement: approved,
389:         });
390:         await this.requirePin(`online-game/${this.resume.genesisDigest}/start`, {
391:           protocol: 'online-browser-game-v1',
392:           invite: this.invite,
393:           agreement: approved,
394:           result: this.resume.result,
395:         });
396:       }
397:       const nonce = approved.state.ceremonyNonce;
398:       if (!nonce) throw new Error('Frozen lobby has no ceremony nonce');
399:       const layout = approved.state.seats.map((seat) => {
400:         if (seat.kind === 'open') throw new Error('Frozen lobby still contains an open seat');
401:         return seat.kind === 'human'
402:           ? { seat: seat.seat, kind: seat.kind, devicePeerId: seat.peer }
403:           : { seat: seat.seat, kind: seat.kind, botHost: seat.botHost };
404:       });
405:       this.material?.dispose();
406:       this.material = null;
407:       const materialInput = {
408:         store: this.options.store,
409:         identity: this.options.identity,
410:         ceremonyNonce: fromBase64Url(nonce),
411:         layout,
412:       };
413:       this.material = this.resume
414:         ? await loadCeremonyMaterial(materialInput)
415:         : await prepareCeremonyMaterial(materialInput);
416:       if (this.closed) return;
417:       const created = OnlineCeremony.create({
418:         agreement: approved,
419:         transport: this.options.transport,
420:         clock: this.options.clock,
421:         deviceSigningKey: this.options.identity.secretKey,
422:         ownedSeats: this.material.keys,
423:         store: this.options.store,
424:         engine: this.options.engine,
425:         ...(this.resume ? { restoreResult: this.resume.result } : {}),
426:         ...(!this.resume && approved.state.hostPeer === this.options.identity.peerId
427:           ? { hostCreatedAt: Math.floor(this.options.clock.now()) }
428:           : {}),
429:       });
430:       if (!created.ok) throw new Error(created.error.message);
431:       this.ceremony = created.value;
432:       this.unsubscribers.push(
433:         this.ceremony.onChange((progress) => {
434:           if (progress.locallyConsented && progress.error === 'online-ceremony-disputed') {
435:             this.haltDisputedGame();
436:             return;
437:           }
438:           if (this.revoked) return;
439:           if (this.activeGame || this.activationAttempted) return;
440:           this.update({ ...progress, gameId: this.resume?.gameId ?? null });
441:           this.observe();
442:         }),
443:       );
444:       const started = await this.ceremony.start();
445:       if (!started.ok) throw new Error(started.error.message);
446:       await this.ceremony.flush();
447:     }
448:     const result = this.ceremony.result();
449:     if (this.closed || this.revoked || !result || this.activationAttempted) return;
450:     if (this.resume && !sameBytes(canonicalEncode(result), canonicalEncode(this.resume.result)))
451:       throw new Error('Restored ceremony differs from the saved certified game');
452:     if (!this.material) throw new Error('Owned game material is unavailable');
453:     this.activationAttempted = true;
454:     this.update({
455:       phase: 'opening',
456:       awaitingSeats: [],
457:       locallyConsented: true,
458:       error: null,
459:       gameId: result.genesis.gameId,
460:     });
461:     if (!this.resume)
462:       await saveOnlineGameRecord(this.options.store, {
463:         invite: this.invite,
464:         agreement: this.approved,
465:         result,
466:       });
467:     if (this.closed || this.revoked) return;
468:     const game = await openOnlineGame(
469:       {
470:         ...result,
471:         agreement: this.approved,
472:         material: this.material.keys,
473:         deviceTransport: this.options.transport,
474:         store: this.options.store,
475:         clock: this.options.clock,
476:         engine: this.options.engine,
477:         signal: this.abort.signal,
478:         ...(this.options.onGameFatal ? { onFatal: this.options.onGameFatal } : {}),
479:         ...(this.options.onDeviceRoutes ? { onDeviceRoutes: this.options.onDeviceRoutes } : {}),
480:         ...(this.resume ? { journalMode: 'restore-only' as const } : {}),
481:       },
482:       this.options.gameRuntime,
483:     );
484:     if (this.closed || this.revoked) {
485:       await game.close();
486:       return;
487:     }
488:     this.activeGame = game;
489:     this.material.dispose();
490:     this.material = null;
491:     this.update({
492:       phase: 'playing',
493:       awaitingSeats: [],
494:       locallyConsented: true,
495:       error: null,
496:       gameId: game.gameId,
497:     });
498:   }
499: 
500:   private async openTransferredResume(): Promise<void> {
501:     const resume = this.resume;
502:     const material = this.material;
503:     const agreement = this.approved;
504:     if (!resume || !material || !agreement || this.closed || this.revoked)
505:       throw new Error('Transferred resume is incomplete');
506:     this.activationAttempted = true;
507:     this.update({
508:       phase: 'opening',
509:       awaitingSeats: [],
510:       locallyConsented: true,
511:       error: null,
512:       gameId: resume.gameId,
513:     });
514:     const game = await openOnlineGame(
515:       {
516:         ...resume.result,
517:         agreement,
518:         material: material.keys,
519:         deviceTransport: this.options.transport,
520:         store: this.options.store,
521:         clock: this.options.clock,
522:         engine: this.options.engine,
523:         signal: this.abort.signal,
524:         journalMode: 'restore-only',
525:         ...(this.options.onGameFatal ? { onFatal: this.options.onGameFatal } : {}),
526:         ...(this.options.onDeviceRoutes ? { onDeviceRoutes: this.options.onDeviceRoutes } : {}),
527:       },
528:       this.options.gameRuntime,
529:     ).finally(() => {
530:       material.dispose();
531:       if (this.material === material) this.material = null;
532:     });
533:     if (this.closed || this.revoked) {
534:       await game.close();
535:       return;
536:     }
537:     this.activeGame = game;
538:     this.update({
539:       phase: 'playing',
540:       awaitingSeats: [],
541:       locallyConsented: true,
542:       error: null,
543:       gameId: resume.gameId,
544:     });
545:   }
546: 
547:   private haltDisputedGame(): void {
548:     if (this.closed || this.revoked) return;
549:     this.revoked = true;
550:     // The coordinator has authenticated a secret disclosure, including after genesis.
551:     // Stop game output synchronously; preserve its public board and durable evidence.
552:     this.abort.abort();
553:     this.activeGame?.session.dispose();
554:     this.stoppingGame = this.activeGame?.close() ?? null;
555:     // close() will surface cleanup errors to the room owner after draining its work.
556:     void this.stoppingGame?.catch(() => undefined);
557:     if (this.retry !== null) this.options.clock.clearTimeout(this.retry);
558:     this.retry = null;
559:     this.update({
560:       phase: 'halted',
561:       awaitingSeats: [],
562:       locallyConsented: true,
563:       error: 'online-ceremony-disputed',
564:       gameId: this.activeGame?.gameId ?? this.current?.gameId ?? null,
565:     });
566:   }
567: 
568:   private async pin(id: string, value: unknown): Promise<void> {
569:     const bytes = canonicalEncode(value);
570:     const stored = this.options.store;
571:     await stored.withCeremonyLock(id, async () => {
572:       if (await stored.putIfAbsent(id, bytes)) return;
573:       const existing = await stored.load(id);
574:       if (
575:         !existing ||
576:         existing.length !== bytes.length ||
577:         existing.some((byte, index) => byte !== bytes[index])
578:       )
579:         throw new Error('Stored online start differs from the approved game');
580:     });
581:   }
582: 
583:   private async requirePin(id: string, value: unknown): Promise<void> {
584:     const bytes = canonicalEncode(value);
585:     const existing = await this.options.store.load(id);
586:     if (!existing || !sameBytes(existing, bytes))
587:       throw new Error('Saved online consent or game record is missing or differs');
588:   }
589: }
590: 
591: /** The worker durably pins the exact lobby state before the device signs its freeze ACK. */
592: export async function pinOnlineFreeze(
593:   store: EscrowCeremonyStore,
594:   self: string,
595:   supplied: LobbyState,
596: ): Promise<string> {
597:   const state = copyEvidence(supplied);
598:   if (
599:     state.status !== 'starting' ||
600:     !state.ceremonyNonce ||
601:     !state.seats.some((seat) => seat.kind === 'human' && seat.peer === self)
602:   )
603:     throw new Error('Only a seated human can pin a starting lobby');
604:   const freezeHash = toHex(hashValue(state));
605:   const id = `online-freeze/${self}/${state.ceremonyNonce}`;
606:   const bytes = canonicalEncode({ protocol: 'online-freeze-pin-v1', freezeHash });
607:   await store.withCeremonyLock(id, async () => {
608:     if (await store.putIfAbsent(id, bytes)) return;
609:     const existing = await store.load(id);
610:     if (!existing || !sameBytes(existing, bytes))
611:       throw new Error('Stored online freeze differs from this lobby state');
612:   });
613:   return freezeHash;
614: }
615: 
616: function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
617:   return left.length === right.length && left.every((byte, index) => byte === right[index]);
618: }
619: 
620: function copyEvidence<T>(value: T): T {
621:   // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Canonical data is detached and checked before use.
622:   return canonicalDecode(canonicalEncode(value)) as T;
623: }
```


## apps/web/src/session/online-worker-startup.ts

```text
1: import { hashValue, toBase64Url, toHex } from '@cp2p/codec';
2: import { failure, success } from '@cp2p/engine';
3: import type {
4:   GameSession,
5:   LobbyController,
6:   LobbyFreezeAgreement,
7:   ProtocolClock,
8:   Transport,
9:   Unsubscribe,
10: } from '@cp2p/protocol';
11: import type { OnlineGame } from './online-game.js';
12: import type { OnlineDeviceRoutes } from './online-game-transport.js';
13: import type { OnlineInvite } from './online-invite.js';
14: import type { OnlineStartupSnapshot } from './online-startup.js';
15: import { OnlineWorkerClient } from './online-worker-client.js';
16: import type {
17:   OnlineWorkerEvent,
18:   OnlineWorkerInitialization,
19:   OnlineWorkerResumeInfo,
20: } from './online-worker-messages.js';
21: import { OnlineWorkerSession } from './online-worker-session.js';
22: import { createMainThreadTransportBridge } from './online-worker-transport.js';
23: 
24: interface WorkerStartupOptions {
25:   invite: OnlineInvite;
26:   self: string;
27:   transport: Transport;
28:   clock: ProtocolClock;
29:   lobby?: LobbyController;
30:   freezePeers?: (peers: readonly string[]) => void;
31:   onDeviceRoutes?: (routes: OnlineDeviceRoutes) => void;
32:   resume?: OnlineWorkerResumeInfo;
33:   client?: OnlineWorkerClient;
34:   initialization?: OnlineWorkerInitialization;
35:   createClient?: () => OnlineWorkerClient;
36: }
37: 
38: /** The UI pins consent through the worker before ACKing; certified work stays there. */
39: export class OnlineWorkerStartup {
40:   private readonly listeners = new Set<() => void>();
41:   private readonly unsubscribers: Unsubscribe[] = [];
42:   private client: OnlineWorkerClient | null = null;
43:   private bridge: ReturnType<typeof createMainThreadTransportBridge> | null = null;
44:   private attached: Promise<void> | null = null;
45:   private approved: LobbyFreezeAgreement | null;
46:   private current: OnlineStartupSnapshot | null;
47:   private activeGame: OnlineGame<GameSession> | null = null;
48:   private gameInfo: Extract<OnlineWorkerEvent, { kind: 'gameReady' }>['game'] | null = null;
49:   private work: Promise<void> | null = null;
50:   private retry: unknown = null;
51:   private closed = false;
52:   private closing: Promise<void> | null = null;
53: 
54:   constructor(private readonly options: WorkerStartupOptions) {
55:     this.approved = options.resume?.agreement ?? null;
56:     this.current = options.resume
57:       ? {
58:           phase: 'opening',
59:           awaitingSeats: [],
60:           locallyConsented: true,
61:           error: null,
62:           gameId: options.resume.gameId,
63:         }
64:       : null;
65:     if (options.client) this.connectClient(options.client);
66:     if (options.lobby) this.unsubscribers.push(options.lobby.onChange(() => this.observe()));
67:     this.unsubscribers.push(options.transport.onPeerChange(() => this.observe()));
68:     this.observe();
69:   }
70: 
71:   snapshot() {
72:     return this.current;
73:   }
74:   agreement() {
75:     return this.approved;
76:   }
77:   game() {
78:     return this.activeGame;
79:   }
80: 
81:   subscribe(listener: () => void) {
82:     this.listeners.add(listener);
83:     return () => this.listeners.delete(listener);
84:   }
85: 
86:   begin() {
87:     if (this.closed || !this.options.lobby || this.current)
88:       return failure('online-start-active', 'An online start is already active');
89:     return this.options.lobby.start(toBase64Url(crypto.getRandomValues(new Uint8Array(32))));
90:   }
91: 
92:   async retryFailed() {
93:     if (this.closed || this.activeGame || this.work || this.current?.phase !== 'error')
94:       return failure('online-start-retry', 'There is no failed start ready to retry');
95:     if (this.approved && this.client) {
96:       const result = await this.client.request({ kind: 'retryStart' });
97:       if (!result.ok) return result;
98:     }
99:     this.update({
100:       phase: this.approved ? 'opening' : 'freezing',
101:       awaitingSeats: [],
102:       locallyConsented: this.approved !== null,
103:       error: null,
104:       gameId: this.current.gameId,
105:     });
106:     this.observe();
107:     return success(undefined);
108:   }
109: 
110:   close(): Promise<void> {
111:     if (this.closing) return this.closing;
112:     this.closed = true;
113:     this.bridge?.stopOutput();
114:     if (this.retry !== null) this.options.clock.clearTimeout(this.retry);
115:     this.retry = null;
116:     for (const unsubscribe of this.unsubscribers) unsubscribe();
117:     this.closing = (async () => {
118:       try {
119:         await this.client?.shutdown();
120:       } finally {
121:         this.bridge?.close();
122:       }
123:     })();
124:     this.activeGame?.session.dispose();
125:     this.listeners.clear();
126:     return this.closing;
127:   }
128: 
129:   private update(snapshot: OnlineStartupSnapshot): void {
130:     if (this.closed) return;
131:     this.current = snapshot;
132:     for (const listener of this.listeners) {
133:       try {
134:         listener();
135:       } catch {
136:         /* Keep lifecycle independent of UI listeners. */
137:       }
138:     }
139:   }
140: 
141:   private fail(error: Error, halted = false): void {
142:     if (this.closed) return;
143:     this.bridge?.stopOutput();
144:     if (this.activeGame?.session instanceof OnlineWorkerSession)
145:       this.activeGame.session.fail(error);
146:     this.update({
147:       phase: halted ? 'halted' : 'error',
148:       awaitingSeats: [],
149:       locallyConsented: this.approved !== null,
150:       error: error.message,
151:       gameId: this.activeGame?.gameId ?? this.options.resume?.gameId ?? null,
152:     });
153:   }
154: 
155:   private connectClient(client: OnlineWorkerClient): void {
156:     this.client = client;
157:     this.unsubscribers.push(
158:       client.subscribe((event) => this.receive(event)),
159:       client.onFailure((error) => this.fail(error, true)),
160:     );
161:   }
162: 
163:   private inactive(): boolean {
164:     return this.closed || this.current?.phase === 'halted';
165:   }
166: 
167:   private receive(event: OnlineWorkerEvent): void {
168:     if (this.inactive()) return;
169:     if (event.kind === 'deviceRoutes') {
170:       this.options.onDeviceRoutes?.(event.routes);
171:     } else if (event.kind === 'startup') {
172:       if (event.snapshot?.phase === 'halted') {
173:         this.fail(new Error(event.snapshot.error ?? 'Online game stopped'), true);
174:         // Block output immediately, then allow the worker to drain durable writes and its lease.
175:         void this.client?.shutdown().catch(() => undefined);
176:       } else if (event.snapshot) this.update(event.snapshot);
177:     } else if (event.kind === 'gameReady') {
178:       this.gameInfo = event.game;
179:     } else if (event.kind === 'session') {
180:       if (!this.gameInfo || !this.client)
181:         throw new Error('Worker published a session before admitting the game');
182:       if (event.snapshot.localHumanSeat !== this.gameInfo.seat)
183:         throw new Error('Worker display seat differs from the admitted game');
184:       if (this.activeGame?.session instanceof OnlineWorkerSession)
185:         this.activeGame.session.accept(event.snapshot);
186:       else {
187:         const session = new OnlineWorkerSession(this.client, event.snapshot, () => {
188:           void this.close().catch(() => undefined);
189:         });
190:         this.activeGame = { ...this.gameInfo, session, close: () => this.close() };
191:         this.update({
192:           phase: 'playing',
193:           awaitingSeats: [],
194:           locallyConsented: true,
195:           error: null,
196:           gameId: this.gameInfo.gameId,
197:         });
198:       }
199:     }
200:   }
201: 
202:   private ensureAttached(): Promise<void> {
203:     if (this.attached) return this.attached;
204:     this.attached = (async () => {
205:       if (!this.client)
206:         this.connectClient(this.options.createClient?.() ?? new OnlineWorkerClient());
207:       const client = this.client;
208:       if (!client) throw new Error('Online worker is unavailable');
209:       if (!this.options.initialization) {
210:         const result = await client.request({
211:           kind: 'initialize',
212:           mode: 'fresh',
213:           self: this.options.self,
214:           invite: this.options.invite,
215:         });
216:         if (!result.ok) throw new Error(result.error.message);
217:         if (result.value.self !== this.options.self)
218:           throw new Error('Online worker device identity differs');
219:       }
220:       if (this.inactive()) return;
221:       const channel = new MessageChannel();
222:       this.bridge = createMainThreadTransportBridge({
223:         transport: this.options.transport,
224:         port: channel.port1,
225:         generation: client.generation,
226:         onFailure: (error) => client.fail(error),
227:       });
228:       const attached = await client.request({
229:         kind: 'attachTransport',
230:         self: this.options.self,
231:         peers: this.options.transport.peers(),
232:         port: channel.port2,
233:       });
234:       if (!attached.ok) throw new Error(attached.error.message);
235:     })().catch((error: unknown) => {
236:       const cause = error instanceof Error ? error : new Error('Could not attach online worker');
237:       this.client?.fail(cause);
238:       throw cause;
239:     });
240:     return this.attached;
241:   }
242: 
243:   private observe(): void {
244:     if (
245:       this.closed ||
246:       this.work ||
247:       this.activeGame ||
248:       this.current?.phase === 'error' ||
249:       this.current?.phase === 'halted'
250:     )
251:       return;
252:     this.work = this.advance()
253:       .catch((error: unknown) => {
254:         if (!this.closed && this.current?.phase !== 'halted')
255:           this.update({
256:             phase: 'error',
257:             awaitingSeats: [],
258:             locallyConsented: this.approved !== null,
259:             error: error instanceof Error ? error.message : 'Online startup failed',
260:             gameId: this.options.resume?.gameId ?? null,
261:           });
262:       })
263:       .finally(() => {
264:         this.work = null;
265:         if (
266:           this.closed ||
267:           this.approved ||
268:           this.activeGame ||
269:           this.current?.phase === 'error' ||
270:           this.current?.phase === 'halted'
271:         )
272:           return;
273:         if (this.retry === null)
274:           this.retry = this.options.clock.setTimeout(() => {
275:             this.retry = null;
276:             this.observe();
277:           }, 1_000);
278:       });
279:   }
280: 
281:   private async advance(): Promise<void> {
282:     if (this.options.resume) {
283:       await this.ensureAttached();
284:       return;
285:     }
286:     const lobby = this.options.lobby;
287:     const state = lobby?.state();
288:     if (
289:       !state ||
290:       state.status !== 'starting' ||
291:       this.approved ||
292:       !state.seats.some((seat) => seat.kind === 'human' && seat.peer === this.options.self)
293:     )
294:       return;
295:     this.update({
296:       phase: 'freezing',
297:       awaitingSeats: [],
298:       locallyConsented: false,
299:       error: null,
300:       gameId: null,
301:     });
302:     await this.ensureAttached();
303:     if (this.inactive() || !this.client || !lobby) return;
304:     const pinned = await this.client.request({ kind: 'pinFreeze', state });
305:     if (!pinned.ok) throw new Error(pinned.error.message);
306:     if (this.inactive()) return;
307:     const current = lobby.state();
308:     if (!current || toHex(hashValue(current)) !== pinned.value.freezeHash) return;
309:     const acknowledged = lobby.ackFreeze();
310:     if (!acknowledged.ok) return;
311:     const agreement = lobby.freezeAgreement();
312:     if (!agreement) return;
313:     if (toHex(hashValue(agreement.state)) !== pinned.value.freezeHash) {
314:       const error = new Error('Lobby changed after pinned consent');
315:       this.client.fail(error);
316:       throw error;
317:     }
318:     // Freeze authenticated device discovery before the worker discloses ceremony material.
319:     if (!this.options.freezePeers) {
320:       const error = new Error('Fresh online start has no roster freeze');
321:       this.client.fail(error);
322:       throw error;
323:     }
324:     try {
325:       this.options.freezePeers(
326:         agreement.state.seats.flatMap((seat) => (seat.kind === 'human' ? [seat.peer] : [])),
327:       );
328:     } catch (error) {
329:       const cause = error instanceof Error ? error : new Error('Could not freeze device roster');
330:       this.client.fail(cause);
331:       throw cause;
332:     }
333:     this.approved = agreement;
334:     const started = await this.client.request({ kind: 'startCeremony', agreement });
335:     if (!started.ok) {
336:       const error = new Error(started.error.message);
337:       this.client.fail(error);
338:       throw error;
339:     }
340:   }
341: }
```


## apps/web/src/session/online-room.ts

```text
1: import { hashValue, toHex } from '@cp2p/codec';
2: import { failure, success } from '@cp2p/engine';
3: import type { GameConfig, Result } from '@cp2p/engine';
4: import {
5:   answerManualOffer,
6:   createManualOffer,
7:   MeshRelaySignalingAdapter,
8:   readManualLobbyOffer,
9:   ServerSignalingAdapter,
10:   WebRtcTransport,
11: } from '@cp2p/p2p';
12: import type { ManualBridge, ManualOffer, WebRtcPeerStats } from '@cp2p/p2p';
13: import type { ServerSignalingOptions, WebRtcTransportOptions } from '@cp2p/p2p';
14: import { genesisDigest, LobbyController } from '@cp2p/protocol';
15: import type {
16:   LobbyDiagnostic,
17:   LobbyFreezeAgreement,
18:   LobbyState,
19:   PeerId,
20:   ProtocolClock,
21:   Unsubscribe,
22:   EscrowCeremonyStore,
23:   GameSession,
24: } from '@cp2p/protocol';
25: import { acquireGameWriterLease, IndexedDbByteStore } from '@cp2p/storage';
26: import type { GameWriterLease } from '@cp2p/storage';
27: import { loadOnlineIdentity, loadOrCreateOnlineIdentity } from './online-credentials.js';
28: import type { DisposableOnlineIdentity } from './online-credentials.js';
29: import { createRoomId, validateOnlineInvite } from './online-invite.js';
30: import type { OnlineInvite } from './online-invite.js';
31: import { OnlineWorkerStartup } from './online-worker-startup.js';
32: import { OnlineWorkerClient } from './online-worker-client.js';
33: import type { OnlineProtocolWorkerPort } from './online-worker-client.js';
34: import type {
35:   OnlineWorkerInitialization,
36:   OnlineWorkerResumeInfo,
37: } from './online-worker-messages.js';
38: import { UnsupportedOnlineGameVersionError } from './online-game-records.js';
39: import type { OnlineStartupSnapshot } from './online-startup.js';
40: import type { OnlineGame } from './online-game.js';
41: import {
42:   createOnlineLobbyTransport,
43:   createOnlineNonChatTransport,
44: } from './online-lobby-transport.js';
45: import { OnlineChat } from './online-chat.js';
46: import type { ChatContent, ChatSnapshot } from './online-chat.js';
47: import { planPregameRoster } from './online-room-roster.js';
48: 
49: export type OpenOnlineRoom =
50:   | {
51:       readonly kind: 'host';
52:       readonly serverUrl: string;
53:       readonly name: string;
54:       readonly hostName: string;
55:       readonly config: GameConfig;
56:     }
57:   | { readonly kind: 'join'; readonly invite: OnlineInvite }
58:   | { readonly kind: 'manual-join'; readonly offerCode: string }
59:   | { readonly kind: 'resume'; readonly gameId: string };
60: 
61: type SignalingStatus = Parameters<NonNullable<ServerSignalingOptions['onStatus']>>[0];
62: 
63: export interface OnlineRoomSnapshot {
64:   readonly invite: OnlineInvite;
65:   readonly self: PeerId;
66:   readonly signaling: SignalingStatus;
67:   readonly manual: ManualSnapshot;
68:   readonly peers: readonly PeerId[];
69:   readonly lobby: LobbyState | null;
70:   readonly agreement: LobbyFreezeAgreement | null;
71:   readonly diagnostic: LobbyDiagnostic | null;
72:   readonly connectionError: string | null;
73:   readonly startup: OnlineStartupSnapshot | null;
74:   readonly chat?: ChatSnapshot;
75:   readonly closed: boolean;
76: }
77: 
78: export interface ManualSnapshot {
79:   readonly phase: 'idle' | 'offering' | 'answering' | 'connected' | 'error';
80:   readonly code: string | null;
81:   readonly peer: PeerId | null;
82:   readonly gatheringComplete: boolean | null;
83:   readonly error: string | null;
84: }
85: 
86: const idleManual: ManualSnapshot = {
87:   phase: 'idle',
88:   code: null,
89:   peer: null,
90:   gatheringComplete: null,
91:   error: null,
92: };
93: 
94: function humanChatPeers(state: LobbyState): PeerId[] {
95:   return state.seats.flatMap((seat) => (seat.kind === 'human' ? [seat.peer] : []));
96: }
97: 
98: export interface OnlineRoomRuntime {
99:   readonly store?: EscrowCeremonyStore;
100:   readonly clock?: ProtocolClock;
101:   readonly socketFactory?: ServerSignalingOptions['socketFactory'];
102:   readonly rtcFactory?: WebRtcTransportOptions['rtcFactory'];
103:   readonly manualRtcFactory?: () => RTCPeerConnection;
104:   readonly iceServers?: readonly RTCIceServer[];
105:   readonly iceTransportPolicy?: RTCIceTransportPolicy;
106:   readonly acquireLease?: typeof acquireGameWriterLease;
107:   readonly workerFactory?: () => OnlineProtocolWorkerPort;
108: }
109: 
110: function createBrowserClock(): ProtocolClock {
111:   const epoch = Date.now();
112:   const started = performance.now();
113:   return {
114:     now: () => epoch + performance.now() - started,
115:     setTimeout: (callback, delay) => window.setTimeout(callback, delay),
116:     clearTimeout: (handle) => {
117:       if (typeof handle === 'number') window.clearTimeout(handle);
118:     },
119:   };
120: }
121: 
122: function freezePublic(part: unknown): void {
123:   if (!part || typeof part !== 'object' || ArrayBuffer.isView(part)) return;
124:   for (const child of Object.values(part)) freezePublic(child);
125:   Object.freeze(part);
126: }
127: 
128: function detachedSnapshot(value: OnlineRoomSnapshot): OnlineRoomSnapshot {
129:   const detached = structuredClone(value);
130:   freezePublic(detached);
131:   return detached;
132: }
133: 
134: /** Owns the browser resources for one lobby, including its exclusive device lease. */
135: export class OnlineRoom {
136:   readonly lobby: LobbyController | null;
137:   private readonly unsubscribers: Unsubscribe[] = [];
138:   private readonly listeners = new Set<() => void>();
139:   private readonly serverCandidates = new Map<PeerId, true>();
140:   private readonly manualCandidates = new Map<PeerId, ManualBridge>();
141:   private manualRetryPeer: PeerId | null = null;
142:   private snapshot: OnlineRoomSnapshot;
143:   private closing: Promise<void> | null = null;
144:   private readonly startup: OnlineWorkerStartup;
145:   private readonly chat: OnlineChat;
146:   private chatAllowedPeers: readonly PeerId[] = [];
147:   private readonly resumedChatState: LobbyState | null;
148:   private readonly resumedPeers: readonly PeerId[] | null;
149:   private activeGamePeers: readonly PeerId[] | null = null;
150:   private chatSwitching = false;
151:   private chatSwitchFailed = false;
152:   private manualOffer: ManualOffer | null = null;
153:   private manualBridge: ManualBridge | null = null;
154:   private unsubscribeManualBridgeClose: Unsubscribe | null = null;
155:   private manualAccepting: {
156:     readonly code: string;
157:     readonly promise: Promise<Result<PeerId>>;
158:   } | null = null;
159:   private manualGeneration = 0;
160:   private frozenRoster = false;
161: 
162:   private constructor(
163:     readonly invite: OnlineInvite,
164:     private readonly identity: DisposableOnlineIdentity,
165:     private readonly lease: GameWriterLease,
166:     private readonly transport: WebRtcTransport,
167:     private readonly signaling: ServerSignalingAdapter | null,
168:     private readonly relay: MeshRelaySignalingAdapter,
169:     controller: LobbyController | null,
170:     resume: OnlineWorkerResumeInfo | null,
171:     private readonly ownedStore: IndexedDbByteStore | null,
172:     store: EscrowCeremonyStore,
173:     private readonly clock: ProtocolClock,
174:     private readonly manualRtcFactory: () => RTCPeerConnection,
175:     createWorkerClient: () => OnlineWorkerClient,
176:     worker: { client: OnlineWorkerClient; initialization: OnlineWorkerInitialization } | null,
177:   ) {
178:     this.lobby = controller;
179:     this.resumedChatState = resume?.agreement.state ?? null;
180:     this.resumedPeers = resume?.peers ?? null;
181:     const initialState = this.resumedChatState ?? controller?.state();
182:     this.chatAllowedPeers = resume
183:       ? [...resume.peers]
184:       : initialState
185:         ? [...humanChatPeers(initialState), ...initialState.spectators]
186:         : [];
187:     this.chat = new OnlineChat({
188:       transport,
189:       clock,
190:       store,
191:       secretKey: identity.secretKey,
192:       scope: resume
193:         ? { kind: 'game', roomId: invite.roomId, genesisDigest: resume.genesisDigest }
194:         : { kind: 'lobby', roomId: invite.roomId },
195:       allowedSenders: () => this.chatAllowedPeers,
196:     });
197:     this.snapshot = detachedSnapshot({
198:       invite: { ...invite },
199:       self: identity.peerId,
200:       signaling: { state: 'connecting' },
201:       manual: idleManual,
202:       peers: [],
203:       lobby: null,
204:       agreement: null,
205:       diagnostic: null,
206:       connectionError: null,
207:       startup: null,
208:       chat: this.chat.snapshot(),
209:       closed: false,
210:     });
211:     const common = {
212:       invite,
213:       self: identity.peerId,
214:       transport: createOnlineNonChatTransport(transport),
215:       clock,
216:       createClient: createWorkerClient,
217:       onDeviceRoutes: (routes: import('./online-game-transport.js').OnlineDeviceRoutes) => {
218:         if (this.closing || this.snapshot.closed) return;
219:         transport.updateCertifiedRoster(routes);
220:         this.activeGamePeers = [...routes.activeDevices];
221:         this.refresh();
222:       },
223:       ...worker,
224:     };
225:     this.startup = new OnlineWorkerStartup(
226:       resume
227:         ? { ...common, resume }
228:         : {
229:             ...common,
230:             lobby: requiredLobby(controller),
231:             freezePeers: (peers) => {
232:               transport.updatePreGameRoster(peers);
233:               transport.freezeRoster();
234:               this.frozenRoster = true;
235:             },
236:           },
237:     );
238:     this.unsubscribers.push(
239:       this.startup.subscribe(() => this.refresh()),
240:       this.chat.subscribe(() => this.refresh()),
241:       transport.onPeerChange((peer, online) => {
242:         if (
243:           online &&
244:           this.snapshot.manual.peer === peer &&
245:           this.snapshot.manual.phase === 'answering'
246:         )
247:           this.update({ manual: { ...this.snapshot.manual, phase: 'connected', code: null } });
248:         this.refresh();
249:       }),
250:       transport.onDiagnostic((_peer, reason) => this.update({ connectionError: reason })),
251:     );
252:     if (controller) {
253:       this.unsubscribers.push(
254:         controller.onChange(() => this.refresh()),
255:         controller.onDiagnostic(() => this.refresh()),
256:         ...(signaling ? [signaling.onRoomPeers((peers) => this.discover(peers))] : []),
257:       );
258:     }
259:     void this.chat.start().catch(() => this.refresh());
260:     this.refresh();
261:   }
262: 
263:   static async open(request: OpenOnlineRoom, runtime: OnlineRoomRuntime = {}): Promise<OnlineRoom> {
264:     const ownedStore = runtime.store ? null : new IndexedDbByteStore();
265:     const store = runtime.store ?? ownedStore;
266:     if (!store) throw new Error('Online storage is unavailable');
267:     let identity: DisposableOnlineIdentity | null = null;
268:     let lease: GameWriterLease | null = null;
269:     let signaling: ServerSignalingAdapter | null = null;
270:     let relay: MeshRelaySignalingAdapter | null = null;
271:     let transport: WebRtcTransport | null = null;
272:     let controller: LobbyController | null = null;
273:     let room: OnlineRoom | null = null;
274:     let worker: { client: OnlineWorkerClient; initialization: OnlineWorkerInitialization } | null =
275:       null;
276:     let workerClient: OnlineWorkerClient | null = null;
277:     const createWorkerClient = () =>
278:       new OnlineWorkerClient(runtime.workerFactory ? { worker: runtime.workerFactory() } : {});
279:     try {
280:       identity =
281:         request.kind === 'resume'
282:           ? await loadOnlineIdentity(store)
283:           : await loadOrCreateOnlineIdentity(store);
284:       if (request.kind === 'resume') {
285:         workerClient = createWorkerClient();
286:         const initialized = await workerClient.request({
287:           kind: 'initialize',
288:           mode: 'resume',
289:           self: identity.peerId,
290:           gameId: request.gameId,
291:         });
292:         if (!initialized.ok) {
293:           if (
294:             initialized.error.code === 'unsupported-version' &&
295:             'savedVersion' in initialized.error &&
296:             typeof initialized.error.savedVersion === 'number'
297:           )
298:             throw new UnsupportedOnlineGameVersionError(initialized.error.savedVersion);
299:           throw new Error(initialized.error.message);
300:         }
301:         if (initialized.value.self !== identity.peerId)
302:           throw new Error('Saved online game device identity differs');
303:         worker = { client: workerClient, initialization: initialized.value };
304:       }
305:       const resume = worker?.initialization.resume ?? null;
306:       let inviteSource: OnlineInvite;
307:       if (request.kind === 'resume') {
308:         if (!resume || !worker) throw new Error('Saved online game is missing');
309:         inviteSource = worker.initialization.invite;
310:       } else if (request.kind === 'join') inviteSource = request.invite;
311:       else if (request.kind === 'manual-join') {
312:         const hint = await readManualLobbyOffer(request.offerCode);
313:         if (hint.to) throw new Error('A reconnect code requires the saved room on this device');
314:         inviteSource = { roomId: hint.roomId, hostPeer: hint.from, serverUrl: '' };
315:       } else
316:         inviteSource = {
317:           roomId: createRoomId(),
318:           hostPeer: identity.peerId,
319:           serverUrl: request.serverUrl,
320:         };
321:       const invite = validateOnlineInvite(inviteSource);
322:       const frozenPeers = resume?.peers;
323:       if (resume && !frozenPeers?.includes(identity.peerId))
324:         throw new Error('This device does not own a human seat in the saved game');
325:       const scope = `lobby:${invite.roomId}`;
326:       const leaseId = `lobby-${toHex(hashValue({ server: invite.serverUrl, room: invite.roomId }))}`;
327:       lease = await (runtime.acquireLease ?? acquireGameWriterLease)(leaseId, identity.peerId);
328:       if (!lease) throw new Error('This lobby is already open in another tab');
329:       const clock = runtime.clock ?? createBrowserClock();
330:       let status: SignalingStatus = { state: 'connecting' };
331:       signaling = invite.serverUrl
332:         ? new ServerSignalingAdapter({
333:             serverUrl: invite.serverUrl,
334:             roomId: invite.roomId,
335:             self: identity.peerId,
336:             secretKey: identity.secretKey,
337:             clock,
338:             ...(runtime.socketFactory ? { socketFactory: runtime.socketFactory } : {}),
339:             onStatus(value) {
340:               status = value;
341:               room?.update({ signaling: value });
342:             },
343:           })
344:         : null;
345:       relay = new MeshRelaySignalingAdapter(identity.peerId, scope, clock, signaling);
346:       transport = new WebRtcTransport({
347:         self: identity.peerId,
348:         secretKey: identity.secretKey,
349:         roster: frozenPeers ?? [...new Set([identity.peerId, invite.hostPeer])],
350:         scope,
351:         clock,
352:         adapter: relay,
353:         rtcFactory: runtime.rtcFactory ?? ((_peer, config) => new RTCPeerConnection(config)),
354:         iceServers: runtime.iceServers ?? [],
355:         iceTransportPolicy: runtime.iceTransportPolicy ?? 'all',
356:       });
357:       relay.attachTransport(transport);
358:       if (resume) transport.freezeRoster();
359:       else {
360:         const common = {
361:           lobbyId: invite.roomId,
362:           transport: createOnlineLobbyTransport(transport),
363:           clock,
364:           secretKey: identity.secretKey,
365:         };
366:         const created =
367:           request.kind === 'host'
368:             ? LobbyController.createHost({
369:                 ...common,
370:                 name: request.name,
371:                 hostName: request.hostName,
372:                 config: request.config,
373:                 takeover: { mode: 'vote', afterSeconds: 'never' },
374:               })
375:             : LobbyController.join({ ...common, hostPeer: invite.hostPeer });
376:         if (!created.ok) throw new Error(created.error.message);
377:         controller = created.value;
378:       }
379:       room = new OnlineRoom(
380:         invite,
381:         identity,
382:         lease,
383:         transport,
384:         signaling,
385:         relay,
386:         controller,
387:         resume,
388:         ownedStore,
389:         store,
390:         clock,
391:         runtime.manualRtcFactory ??
392:           (() =>
393:             new RTCPeerConnection({
394:               iceServers: [...(runtime.iceServers ?? [])],
395:               iceTransportPolicy: runtime.iceTransportPolicy ?? 'all',
396:             })),
397:         createWorkerClient,
398:         worker,
399:       );
400:       room.update({ signaling: status });
401:       if (request.kind === 'manual-join') {
402:         const answered = await room.answerManualOffer(request.offerCode);
403:         if (!answered.ok) throw new Error(answered.error.message);
404:       } else if (signaling || request.kind === 'host') transport.start();
405:       return room;
406:     } catch (error) {
407:       if (room) {
408:         await room.close();
409:         throw error;
410:       }
411:       try {
412:         await workerClient?.shutdown();
413:       } finally {
414:         controller?.dispose();
415:         try {
416:           if (transport) transport.dispose();
417:           else if (relay) relay.close();
418:           else signaling?.close();
419:         } finally {
420:           identity?.dispose();
421:           try {
422:             await lease?.close();
423:           } finally {
424:             await ownedStore?.close();
425:           }
426:         }
427:       }
428:       throw error;
429:     }
430:   }
431: 
432:   getSnapshot = (): OnlineRoomSnapshot => this.snapshot;
433: 
434:   startGame = () => this.startup.begin();
435: 
436:   retryStart = () => this.startup.retryFailed();
437: 
438:   getGame = (): OnlineGame<GameSession> | null => this.startup.game();
439: 
440:   sendChat = (content: ChatContent): Promise<Result<void>> => {
441:     if (this.startup.game() && this.chat.scopeKind() !== 'game')
442:       return Promise.resolve(failure('chat-transition', 'Game chat is still opening'));
443:     return this.chat.send(content);
444:   };
445: 
446:   muteChat = (peer: PeerId, muted: boolean): Promise<Result<void>> =>
447:     this.chat.setMuted(peer, muted);
448: 
449:   getPeerStats = (): Promise<readonly WebRtcPeerStats[]> => this.transport.peerStats();
450: 
451:   /** One signed offer, reusable byte-for-byte until cancelled or answered. */
452:   async startManualInvitation(
453:     to?: PeerId,
454:   ): Promise<Result<{ code: string; gatheringComplete: boolean }>> {
455:     if (this.manualOffer && this.snapshot.manual.peer === (to ?? null) && this.snapshot.manual.code)
456:       return success({
457:         code: this.snapshot.manual.code,
458:         gatheringComplete: this.manualOffer.gatheringComplete,
459:       });
460:     if (
461:       this.snapshot.closed ||
462:       this.manualOffer ||
463:       this.snapshot.manual.phase === 'offering' ||
464:       this.snapshot.manual.phase === 'answering'
465:     )
466:       return failure('manual-busy', 'A manual invitation is already active');
467:     const state = this.lobby?.state();
468:     const allowed = to
469:       ? this.transport.roster().includes(to) && to !== this.identity.peerId
470:       : !!state &&
471:         state.status === 'open' &&
472:         state.hostPeer === this.identity.peerId &&
473:         !this.startup.agreement();
474:     if (!allowed) return failure('manual-roster', 'Manual invitation target is not permitted');
475:     const generation = ++this.manualGeneration;
476:     this.update({
477:       manual: {
478:         phase: 'offering',
479:         code: null,
480:         peer: to ?? null,
481:         gatheringComplete: null,
482:         error: null,
483:       },
484:     });
485:     try {
486:       const offer = await createManualOffer({
487:         self: this.identity.peerId,
488:         secretKey: this.identity.secretKey,
489:         scope: `lobby:${this.invite.roomId}`,
490:         clock: this.clock,
491:         rtcFactory: this.manualRtcFactory,
492:         ...(to ? { to } : {}),
493:       });
494:       if (this.snapshot.closed || generation !== this.manualGeneration) {
495:         offer.close();
496:         return failure('manual-cancelled', 'Manual invitation was cancelled');
497:       }
498:       this.manualOffer = offer;
499:       this.update({
500:         manual: {
501:           phase: 'offering',
502:           code: offer.code,
503:           peer: to ?? null,
504:           gatheringComplete: offer.gatheringComplete,
505:           error: null,
506:         },
507:       });
508:       return success({ code: offer.code, gatheringComplete: offer.gatheringComplete });
509:     } catch (error) {
510:       const message = error instanceof Error ? error.message : 'Manual invitation failed';
511:       if (generation === this.manualGeneration)
512:         this.update({
513:           manual: {
514:             phase: 'error',
515:             code: null,
516:             peer: to ?? null,
517:             gatheringComplete: null,
518:             error: message,
519:           },
520:         });
521:       return failure('manual-offer', message);
522:     }
523:   }
524: 
525:   acceptManualAnswer(code: string): Promise<Result<PeerId>> {
526:     const pending = this.manualAccepting;
527:     if (pending)
528:       return pending.code === code
529:         ? pending.promise
530:         : Promise.resolve(failure('manual-busy', 'A different manual answer is already active'));
531:     const attempt = { code, promise: this.acceptManualAnswerOnce(code) };
532:     this.manualAccepting = attempt;
533:     void attempt.promise.finally(() => {
534:       if (this.manualAccepting === attempt) this.manualAccepting = null;
535:     });
536:     return attempt.promise;
537:   }
538: 
539:   private async acceptManualAnswerOnce(code: string): Promise<Result<PeerId>> {
540:     const offer = this.manualOffer;
541:     if (!offer || this.snapshot.closed)
542:       return failure('manual-offer-missing', 'No manual invitation is active');
543:     const generation = this.manualGeneration;
544:     let bridge: ManualBridge | null = null;
545:     let attached = false;
546:     try {
547:       bridge = await offer.acceptAnswer(code);
548:       if (this.snapshot.closed || offer !== this.manualOffer) {
549:         bridge.close();
550:         return failure('manual-cancelled', 'Manual invitation was cancelled');
551:       }
552:       const peer = bridge.peer;
553:       if (!this.transport.roster().includes(peer)) {
554:         const state = this.lobby?.state();
555:         if (
556:           !state ||
557:           state.hostPeer !== this.identity.peerId ||
558:           state.status !== 'open' ||
559:           this.startup.agreement()
560:         ) {
561:           this.cancelManualInvitation();
562:           return failure('manual-roster', 'This room cannot admit another device');
563:         }
564:         this.relay.addBridge(bridge);
565:         attached = true;
566:         try {
567:           this.manualCandidates.set(peer, bridge);
568:           this.refresh();
569:           if (!this.transport.roster().includes(peer))
570:             throw new Error('This room has no connection slot for another device');
571:           this.manualRetryPeer = peer;
572:         } catch (error) {
573:           this.manualCandidates.delete(peer);
574:           this.relay.removeBridge(peer);
575:           throw error;
576:         }
577:       } else {
578:         this.relay.addBridge(bridge);
579:         attached = true;
580:         this.manualCandidates.set(peer, bridge);
581:         this.manualRetryPeer = peer;
582:       }
583:       this.manualOffer = null;
584:       this.update({
585:         manual: {
586:           phase: this.transport.peers().includes(peer) ? 'connected' : 'answering',
587:           code: null,
588:           peer,
589:           gatheringComplete: offer.gatheringComplete,
590:           error: null,
591:         },
592:       });
593:       this.observeManualBridge(bridge, generation);
594:       this.transport.start();
595:       this.transport.connect(peer);
596:       return success(peer);
597:     } catch (error) {
598:       if (bridge) {
599:         if (attached) this.relay.removeBridge(bridge.peer);
600:         else bridge.close();
601:       }
602:       const message = error instanceof Error ? error.message : 'Manual answer failed';
603:       if (!this.snapshot.closed && generation === this.manualGeneration)
604:         this.update({ manual: { ...this.snapshot.manual, phase: 'error', error: message } });
605:       return failure('manual-answer', message);
606:     }
607:   }
608: 
609:   async answerManualOffer(
610:     code: string,
611:   ): Promise<Result<{ code: string; peer: PeerId; gatheringComplete: boolean }>> {
612:     if (this.snapshot.closed || this.snapshot.manual.phase === 'answering' || this.manualOffer)
613:       return failure('manual-busy', 'Manual answer is already active');
614:     const generation = ++this.manualGeneration;
615:     let bridge: ManualBridge | null = null;
616:     let attached = false;
617:     this.update({
618:       manual: { phase: 'answering', code: null, peer: null, gatheringComplete: null, error: null },
619:     });
620:     try {
621:       const answer = await answerManualOffer(
622:         {
623:           self: this.identity.peerId,
624:           secretKey: this.identity.secretKey,
625:           scope: `lobby:${this.invite.roomId}`,
626:           clock: this.clock,
627:           rtcFactory: this.manualRtcFactory,
628:         },
629:         code,
630:       );
631:       bridge = answer.bridge;
632:       if (
633:         this.snapshot.closed ||
634:         generation !== this.manualGeneration ||
635:         !this.transport.roster().includes(answer.peer)
636:       ) {
637:         answer.bridge.close();
638:         if (!this.snapshot.closed && generation === this.manualGeneration)
639:           this.update({
640:             manual: {
641:               phase: 'error',
642:               code: null,
643:               peer: null,
644:               gatheringComplete: null,
645:               error: 'Manual offer is outside the room roster',
646:             },
647:           });
648:         return failure('manual-roster', 'Manual offer is outside the room roster');
649:       }
650:       this.relay.addBridge(answer.bridge);
651:       attached = true;
652:       this.manualCandidates.set(answer.peer, answer.bridge);
653:       this.update({
654:         manual: {
655:           phase: this.transport.peers().includes(answer.peer) ? 'connected' : 'answering',
656:           code: this.transport.peers().includes(answer.peer) ? null : answer.code,
657:           peer: answer.peer,
658:           gatheringComplete: answer.gatheringComplete,
659:           error: null,
660:         },
661:       });
662:       this.observeManualBridge(answer.bridge, generation);
663:       this.transport.start();
664:       this.transport.connect(answer.peer);
665:       return success({
666:         code: answer.code,
667:         peer: answer.peer,
668:         gatheringComplete: answer.gatheringComplete,
669:       });
670:     } catch (error) {
671:       if (bridge) {
672:         if (attached) this.relay.removeBridge(bridge.peer);
673:         else bridge.close();
674:       }
675:       const message = error instanceof Error ? error.message : 'Manual offer could not be answered';
676:       if (generation === this.manualGeneration)
677:         this.update({
678:           manual: {
679:             phase: 'error',
680:             code: null,
681:             peer: null,
682:             gatheringComplete: null,
683:             error: message,
684:           },
685:         });
686:       return failure('manual-answer', message);
687:     }
688:   }
689: 
690:   cancelManualInvitation(): void {
691:     ++this.manualGeneration;
692:     this.manualAccepting = null;
693:     this.manualOffer?.close();
694:     this.manualOffer = null;
695:     if (
696:       this.manualBridge &&
697:       this.snapshot.manual.phase === 'answering' &&
698:       !this.transport.peers().includes(this.manualBridge.peer)
699:     )
700:       this.relay.removeBridge(this.manualBridge.peer);
701:     this.unsubscribeManualBridgeClose?.();
702:     this.unsubscribeManualBridgeClose = null;
703:     this.manualBridge = null;
704:     if (!this.snapshot.closed && !this.closing) {
705:       this.refresh();
706:       this.update({ manual: idleManual });
707:     }
708:   }
709: 
710:   private observeManualBridge(bridge: ManualBridge, generation: number): void {
711:     this.unsubscribeManualBridgeClose?.();
712:     this.manualBridge = bridge;
713:     this.unsubscribeManualBridgeClose = bridge.onClose(() => {
714:       if (this.manualCandidates.get(bridge.peer) === bridge) {
715:         this.manualCandidates.delete(bridge.peer);
716:         this.refresh();
717:       }
718:       if (this.manualBridge !== bridge) return;
719:       this.manualBridge = null;
720:       this.unsubscribeManualBridgeClose = null;
721:       const manual = this.snapshot.manual;
722:       if (
723:         this.snapshot.closed ||
724:         generation !== this.manualGeneration ||
725:         manual.phase !== 'answering' ||
726:         manual.peer !== bridge.peer ||
727:         this.transport.peers().includes(bridge.peer)
728:       )
729:         return;
730:       this.update({
731:         manual: {
732:           phase: 'error',
733:           code: null,
734:           peer: null,
735:           gatheringComplete: null,
736:           error: 'Manual bootstrap connection closed before the game connection was ready',
737:         },
738:       });
739:     });
740:   }
741: 
742:   subscribe = (listener: () => void): Unsubscribe => {
743:     this.listeners.add(listener);
744:     return () => {
745:       this.listeners.delete(listener);
746:     };
747:   };
748: 
749:   close(): Promise<void> {
750:     if (this.closing) return this.closing;
751:     // Publish the promise before notifying views, which may call close again.
752:     this.closing = Promise.resolve().then(() => this.releaseResources());
753:     void this.startup.close().catch(() => undefined);
754:     this.cancelManualInvitation();
755:     this.chat.dispose();
756:     this.update({ closed: true });
757:     for (const unsubscribe of this.unsubscribers) unsubscribe();
758:     this.listeners.clear();
759:     this.serverCandidates.clear();
760:     this.manualCandidates.clear();
761:     this.manualRetryPeer = null;
762:     return this.closing;
763:   }
764: 
765:   private async releaseResources(): Promise<void> {
766:     try {
767:       try {
768:         await this.startup.close();
769:         await this.chat.flush();
770:       } finally {
771:         try {
772:           this.lobby?.dispose();
773:         } finally {
774:           try {
775:             this.transport.dispose();
776:           } finally {
777:             this.identity.dispose();
778:           }
779:         }
780:       }
781:     } finally {
782:       try {
783:         await this.lease.close();
784:       } finally {
785:         await this.ownedStore?.close();
786:       }
787:     }
788:   }
789: 
790:   private discover(peers: readonly PeerId[] | null): void {
791:     const state = this.lobby?.state();
792:     if (
793:       this.snapshot.closed ||
794:       this.closing ||
795:       this.startup.agreement() ||
796:       (state && state.status !== 'open')
797:     )
798:       return;
799:     const current = new Set(peers ?? []);
800:     for (const peer of this.serverCandidates.keys())
801:       if (!current.has(peer)) this.serverCandidates.delete(peer);
802:     for (const peer of current) this.serverCandidates.set(peer, true);
803:     this.refresh();
804:   }
805: 
806:   private refresh(): void {
807:     if (this.snapshot.closed || this.closing) return;
808:     const agreement = this.startup.agreement() ?? this.lobby?.freezeAgreement() ?? null;
809:     const state = this.lobby?.state();
810:     const game = this.startup.game();
811:     const gameChat = this.chat.scopeKind() === 'game' || game !== null;
812:     const chatState = gameChat ? (agreement?.state ?? this.resumedChatState) : state;
813:     const currentGamePeers = this.activeGamePeers ?? this.resumedPeers;
814:     this.chatAllowedPeers =
815:       currentGamePeers && gameChat
816:         ? [...currentGamePeers]
817:         : chatState
818:           ? [...humanChatPeers(chatState), ...(gameChat || agreement ? [] : chatState.spectators)]
819:           : [];
820:     if (
821:       game &&
822:       !this.chatSwitching &&
823:       !this.chatSwitchFailed &&
824:       this.chat.scopeKind() === 'lobby' &&
825:       agreement
826:     ) {
827:       this.chatSwitching = true;
828:       void this.chat
829:         .enterGame(
830:           { kind: 'game', roomId: this.invite.roomId, genesisDigest: genesisDigest(game.genesis) },
831:           () => this.chatAllowedPeers,
832:         )
833:         .catch(() => {
834:           this.chatSwitchFailed = true;
835:         })
836:         .finally(() => {
837:           this.chatSwitching = false;
838:           this.refresh();
839:         });
840:     }
841:     if (this.lobby && !this.frozenRoster && !agreement && (!state || state.status === 'open'))
842:       this.syncPregameRoster(state ?? null);
843:     this.update({
844:       peers: this.transport.peers(),
845:       lobby: agreement?.state ?? state ?? null,
846:       agreement,
847:       startup: this.startup.snapshot(),
848:       chat: this.chat.snapshot(),
849:       diagnostic: this.lobby?.getDiagnostic() ?? null,
850:     });
851:   }
852: 
853:   private syncPregameRoster(state: LobbyState | null): void {
854:     for (const [peer, bridge] of this.manualCandidates)
855:       if (bridge.isClosed || !this.relay.hasBridge(peer)) this.manualCandidates.delete(peer);
856:     const roster = planPregameRoster({
857:       self: this.identity.peerId,
858:       host: state?.hostPeer ?? this.invite.hostPeer,
859:       seated: state?.seats.flatMap((seat) => (seat.kind === 'human' ? [seat.peer] : [])) ?? [],
860:       connected: this.transport.peers(),
861:       spectators: state?.spectators ?? [],
862:       transient: [
863:         ...[...this.manualCandidates.keys()].toReversed(),
864:         ...[...this.serverCandidates.keys()].toReversed(),
865:         ...(this.manualRetryPeer ? [this.manualRetryPeer] : []),
866:       ],
867:     });
868:     const current = this.transport.roster();
869:     if (current.length !== roster.length || roster.some((peer) => !current.includes(peer)))
870:       this.transport.updatePreGameRoster(roster);
871:     if (this.manualRetryPeer && !roster.includes(this.manualRetryPeer)) this.manualRetryPeer = null;
872:     for (const peer of this.manualCandidates.keys()) {
873:       if (roster.includes(peer)) continue;
874:       this.manualCandidates.delete(peer);
875:       this.relay.removeBridge(peer);
876:     }
877:   }
878: 
879:   private update(patch: Partial<OnlineRoomSnapshot>): void {
880:     this.snapshot = detachedSnapshot({ ...this.snapshot, ...patch });
881:     for (const listener of this.listeners) {
882:       try {
883:         listener();
884:       } catch {
885:         /* A view cannot interrupt network or lease cleanup. */
886:       }
887:     }
888:   }
889: }
890: 
891: function requiredLobby(value: LobbyController | null): LobbyController {
892:   if (!value) throw new Error('Fresh online room has no lobby controller');
893:   return value;
894: }
```


## apps/web/src/session/online-transfer-channel.ts

```text
1: import { canonicalDecode, canonicalEncode, sha256, toHex } from '@cp2p/codec';
2: import type { PeerId, ProtocolClock, Transport, Unsubscribe } from '@cp2p/protocol';
3: import * as v from 'valibot';
4: 
5: const MAGIC = Uint8Array.of(0x48, 0x58, 0x54, 1);
6: const CHUNK_BYTES = 32 * 1024;
7: const MAX_FRAME_BYTES = Math.ceil((CHUNK_BYTES * 4) / 3) + 1024;
8: const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
9: const MAX_TRANSFERS = 64;
10: const DEADLINE_MS = 120_000;
11: const kindSchema = v.picklist([
12:   'bootstrap',
13:   'offer',
14:   'authorized',
15:   'private',
16:   'readiness',
17:   'activated',
18:   'cancelled',
19:   'received',
20: ]);
21: const uint = (max: number) => v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(max));
22: const common = {
23:   scope: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/)),
24:   id: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_TRANSFERS)),
25:   index: uint(MAX_ARTIFACT_BYTES / CHUNK_BYTES - 1),
26: };
27: const ackSchema = v.strictObject({ ...common, type: v.literal('ack') });
28: const dataSchema = v.strictObject({
29:   ...common,
30:   type: v.literal('data'),
31:   kind: kindSchema,
32:   length: uint(MAX_ARTIFACT_BYTES),
33:   digest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
34:   bytes: v.custom<Uint8Array>(
35:     (value) => value instanceof Uint8Array && value.length <= CHUNK_BYTES,
36:   ),
37: });
38: const frameSchema = v.variant('type', [ackSchema, dataSchema]);
39: type DataFrame = v.InferOutput<typeof dataSchema>;
40: 
41: export interface OnlineTransferArtifact {
42:   readonly kind: v.InferOutput<typeof kindSchema>;
43:   readonly bytes: Uint8Array;
44: }
45: 
46: function artifactLimit(kind: OnlineTransferArtifact['kind']): number {
47:   return kind === 'bootstrap' || kind === 'authorized' || kind === 'activated'
48:     ? MAX_ARTIFACT_BYTES
49:     : 64 * 1024;
50: }
51: 
52: function encode(frame: v.InferOutput<typeof frameSchema>): Uint8Array {
53:   const body = canonicalEncode(frame);
54:   const bytes = new Uint8Array(MAGIC.length + body.length);
55:   bytes.set(MAGIC);
56:   bytes.set(body, MAGIC.length);
57:   return bytes;
58: }
59: 
60: interface Incoming {
61:   readonly first: DataFrame;
62:   readonly bytes: Uint8Array;
63:   readonly timer: unknown;
64:   nextIndex: number;
65: }
66: 
67: /** An isolated authenticated device link. Artifacts never enter the game transport. */
68: export class OnlineTransferChannel {
69:   private readonly off: Unsubscribe[];
70:   private incoming: Incoming | null = null;
71:   private lastReceived = 0;
72:   private nextId = 0;
73:   private sending = false;
74:   private closed = false;
75:   private awaiting: {
76:     id: number;
77:     index: number;
78:     resolve(): void;
79:     reject(error: Error): void;
80:   } | null = null;
81: 
82:   constructor(
83:     private readonly options: {
84:       readonly transport: Transport;
85:       readonly peer: PeerId;
86:       readonly scope: string;
87:       readonly clock: ProtocolClock;
88:       /** Receives owned public evidence or ciphertext. Must not block on user confirmation. */
89:       readonly onArtifact: (artifact: OnlineTransferArtifact) => void;
90:       readonly onError: (error: Error) => void;
91:     },
92:   ) {
93:     v.parse(common.scope, options.scope);
94:     if (options.peer === options.transport.self)
95:       throw new TypeError('A transfer requires a different destination device');
96:     this.off = [
97:       options.transport.onMessage((from, bytes) => {
98:         if (from === options.peer) this.receive(bytes);
99:       }),
100:       options.transport.onPeerChange((peer, online) => {
101:         if (peer === options.peer && !online) this.fail(new Error('Transfer connection closed'));
102:       }),
103:     ];
104:   }
105: 
106:   async send(artifact: OnlineTransferArtifact): Promise<void> {
107:     if (this.closed || this.sending) throw new Error('Transfer channel is closed or busy');
108:     v.parse(kindSchema, artifact.kind);
109:     if (
110:       !(artifact.bytes instanceof Uint8Array) ||
111:       artifact.bytes.length > artifactLimit(artifact.kind)
112:     )
113:       throw new RangeError('Transfer artifact exceeds its limit');
114:     if (!this.options.transport.peers().includes(this.options.peer))
115:       throw new Error('Transfer peer is not connected');
116:     if (this.nextId >= MAX_TRANSFERS) throw new Error('Transfer exchange limit reached');
117:     const bytes = new Uint8Array(artifact.bytes);
118:     const digest = toHex(sha256(bytes));
119:     const id = ++this.nextId;
120:     this.sending = true;
121:     const timer = this.options.clock.setTimeout(
122:       () => this.fail(new Error('Transfer delivery timed out')),
123:       DEADLINE_MS,
124:     );
125:     try {
126:       const count = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
127:       for (let index = 0; index < count; index += 1) {
128:         if (this.closed) throw new Error('Transfer channel is closed');
129:         const frame = encode({
130:           type: 'data',
131:           scope: this.options.scope,
132:           id,
133:           index,
134:           kind: artifact.kind,
135:           length: bytes.length,
136:           digest,
137:           bytes: bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES),
138:         });
139:         // oxlint-disable-next-line no-await-in-loop -- One acknowledged chunk bounds the underlying data-channel queue.
140:         await new Promise<void>((resolve, reject) => {
141:           this.awaiting = { id, index, resolve, reject };
142:           try {
143:             this.options.transport.send(this.options.peer, frame);
144:           } catch (error) {
145:             this.awaiting = null;
146:             reject(error);
147:           }
148:         });
149:       }
150:     } catch (error) {
151:       this.fail(error instanceof Error ? error : new Error('Transfer delivery failed'));
152:       throw error;
153:     } finally {
154:       this.options.clock.clearTimeout(timer);
155:       this.awaiting = null;
156:       this.sending = false;
157:       bytes.fill(0);
158:     }
159:   }
160: 
161:   private receive(bytes: Uint8Array): void {
162:     if (this.closed || !MAGIC.every((byte, index) => bytes[index] === byte)) return;
163:     try {
164:       if (bytes.length > MAX_FRAME_BYTES) throw new RangeError('Transfer frame is oversized');
165:       const frame = v.parse(frameSchema, canonicalDecode(bytes.subarray(MAGIC.length)));
166:       if (frame.scope !== this.options.scope) return;
167:       if (frame.type === 'ack') {
168:         if (this.awaiting?.id === frame.id && this.awaiting.index === frame.index) {
169:           const pending = this.awaiting;
170:           this.awaiting = null;
171:           pending.resolve();
172:         }
173:         return;
174:       }
175:       this.receiveData(frame);
176:     } catch {
177:       this.fail(new Error('Invalid transfer frame'));
178:     }
179:   }
180: 
181:   private receiveData(frame: DataFrame): void {
182:     if (frame.id <= this.lastReceived) return;
183:     const expectedSize = Math.min(CHUNK_BYTES, frame.length - frame.index * CHUNK_BYTES);
184:     if (
185:       frame.length > artifactLimit(frame.kind) ||
186:       expectedSize < 0 ||
187:       frame.bytes.length !== expectedSize
188:     )
189:       throw new Error('Transfer chunk length differs');
190:     if (!this.incoming) {
191:       if (frame.index !== 0) throw new Error('Transfer does not start with its first chunk');
192:       this.incoming = {
193:         first: { ...frame, bytes: new Uint8Array(0) },
194:         bytes: new Uint8Array(frame.length),
195:         nextIndex: 0,
196:         timer: this.options.clock.setTimeout(
197:           () => this.fail(new Error('Transfer receive timed out')),
198:           DEADLINE_MS,
199:         ),
200:       };
201:     }
202:     const incoming = this.incoming;
203:     const first = incoming.first;
204:     if (
205:       frame.id !== first.id ||
206:       frame.kind !== first.kind ||
207:       frame.length !== first.length ||
208:       frame.digest !== first.digest ||
209:       frame.index !== incoming.nextIndex
210:     )
211:       throw new Error('Transfer chunks do not match');
212:     incoming.bytes.set(frame.bytes, frame.index * CHUNK_BYTES);
213:     incoming.nextIndex += 1;
214:     const complete = incoming.nextIndex * CHUNK_BYTES >= frame.length;
215:     if (complete) {
216:       if (toHex(sha256(incoming.bytes)) !== first.digest)
217:         throw new Error('Transfer artifact digest differs');
218:       this.options.clock.clearTimeout(incoming.timer);
219:       this.incoming = null;
220:       this.lastReceived = frame.id;
221:     }
222:     this.options.transport.send(
223:       this.options.peer,
224:       encode({
225:         type: 'ack',
226:         scope: frame.scope,
227:         id: frame.id,
228:         index: frame.index,
229:       }),
230:     );
231:     if (complete) this.options.onArtifact({ kind: first.kind, bytes: incoming.bytes });
232:   }
233: 
234:   private fail(error: Error): void {
235:     if (this.closed) return;
236:     this.close(error);
237:     try {
238:       this.options.onError(error);
239:     } catch {
240:       /* A notification cannot interrupt channel cleanup. */
241:     }
242:   }
243: 
244:   close(error = new Error('Transfer channel closed')): void {
245:     if (this.closed) return;
246:     this.closed = true;
247:     for (const off of this.off) off();
248:     if (this.incoming) {
249:       this.options.clock.clearTimeout(this.incoming.timer);
250:       this.incoming.bytes.fill(0);
251:       this.incoming = null;
252:     }
253:     this.awaiting?.reject(error);
254:     this.awaiting = null;
255:   }
256: }
```


## apps/web/src/session/online-transfer-channel.test.ts

```text
1: import { canonicalDecode, canonicalEncode, toBase64Url } from '@cp2p/codec';
2: import type { Transport } from '@cp2p/protocol';
3: import { createMemnet } from '@cp2p/protocol/testing';
4: import { expect, test } from 'vitest';
5: import { OnlineTransferChannel } from './online-transfer-channel.js';
6: import type { OnlineTransferArtifact } from './online-transfer-channel.js';
7: 
8: const peers = [
9:   toBase64Url(new Uint8Array(32).fill(1)),
10:   toBase64Url(new Uint8Array(32).fill(2)),
11: ] as const;
12: const scope = toBase64Url(new Uint8Array(32).fill(3));
13: 
14: function forward(transport: Transport): Transport {
15:   return {
16:     self: transport.self,
17:     peers: () => transport.peers(),
18:     send: (peer, bytes) => transport.send(peer, bytes),
19:     broadcast: (bytes) => transport.broadcast(bytes),
20:     disconnect: (peer) => transport.disconnect(peer),
21:     onMessage: (listener) => transport.onMessage(listener),
22:     onPeerChange: (listener) => transport.onPeerChange(listener),
23:   };
24: }
25: 
26: test('large public bootstrap is delivered in acknowledged chunks without sharing mutable bytes', async () => {
27:   const network = createMemnet({ peers });
28:   const received: OnlineTransferArtifact[] = [];
29:   const errors: Error[] = [];
30:   const [a, b] = peers;
31:   let outstanding = 0;
32:   let maximum = 0;
33:   const transport = network.transport(a);
34:   const counted: Transport = {
35:     ...forward(transport),
36:     send(peer, bytes) {
37:       outstanding += 1;
38:       maximum = Math.max(maximum, outstanding);
39:       transport.send(peer, bytes);
40:     },
41:     onMessage(listener) {
42:       return transport.onMessage((peer, bytes) => {
43:         outstanding -= 1;
44:         listener(peer, bytes);
45:       });
46:     },
47:   };
48:   const source = new OnlineTransferChannel({
49:     transport: counted,
50:     peer: b,
51:     scope,
52:     clock: network.clock,
53:     onArtifact: () => undefined,
54:     onError: (error) => errors.push(error),
55:   });
56:   const destination = new OnlineTransferChannel({
57:     transport: network.transport(b),
58:     peer: a,
59:     scope,
60:     clock: network.clock,
61:     onArtifact: (artifact) => received.push(artifact),
62:     onError: (error) => errors.push(error),
63:   });
64:   try {
65:     const bytes = Uint8Array.from({ length: 1_100_000 }, (_, index) => index % 251);
66:     const original = new Uint8Array(bytes);
67:     const sending = source.send({ kind: 'bootstrap', bytes });
68:     bytes.fill(0);
69:     await expect(source.send({ kind: 'offer', bytes: Uint8Array.of(1) })).rejects.toThrow(/busy/);
70:     for (let chunk = 0; chunk < 40; chunk += 1) {
71:       network.clock.advanceBy(1);
72:       // oxlint-disable-next-line no-await-in-loop -- Release each acknowledged sender continuation.
73:       await Promise.resolve();
74:     }
75:     expect(errors).toEqual([]);
76:     expect(received).toHaveLength(1);
77:     await sending;
78:     expect(maximum).toBe(1);
79:     expect(received).toEqual([{ kind: 'bootstrap', bytes: original }]);
80:     expect(errors).toEqual([]);
81:     await expect(source.send({ kind: 'private', bytes: new Uint8Array(65_537) })).rejects.toThrow(
82:       /limit/,
83:     );
84:   } finally {
85:     source.close();
86:     destination.close();
87:     network.dispose();
88:   }
89: });
90: 
91: test('missing acknowledgements time out and a separate scope cannot acknowledge delivery', async () => {
92:   const network = createMemnet({ peers });
93:   const errors: Error[] = [];
94:   const [a, b] = peers;
95:   const source = new OnlineTransferChannel({
96:     transport: network.transport(a),
97:     peer: b,
98:     scope,
99:     clock: network.clock,
100:     onArtifact: () => undefined,
101:     onError: (error) => errors.push(error),
102:   });
103:   const destination = new OnlineTransferChannel({
104:     transport: network.transport(b),
105:     peer: a,
106:     scope: toBase64Url(new Uint8Array(32).fill(4)),
107:     clock: network.clock,
108:     onArtifact: () => {
109:       throw new Error('Wrong scope delivered');
110:     },
111:     onError: (error) => errors.push(error),
112:   });
113:   try {
114:     const sending = source.send({ kind: 'offer', bytes: Uint8Array.of(1) });
115:     const rejected = sending.catch((error: unknown) => error);
116:     network.clock.advanceBy(120_000);
117:     expect(await rejected).toEqual(new Error('Transfer delivery timed out'));
118:     expect(errors).toHaveLength(1);
119:     await expect(source.send({ kind: 'offer', bytes: Uint8Array.of(1) })).rejects.toThrow(/closed/);
120:   } finally {
121:     source.close();
122:     destination.close();
123:     network.dispose();
124:   }
125: });
126: 
127: test('tampered chunk data fails the digest check and never reaches its receiver', async () => {
128:   const network = createMemnet({ peers });
129:   const errors: Error[] = [];
130:   const received: OnlineTransferArtifact[] = [];
131:   const [a, b] = peers;
132:   const base = network.transport(a);
133:   const transport: Transport = {
134:     ...forward(base),
135:     send(peer, bytes) {
136:       const frame: unknown = canonicalDecode(bytes.subarray(4));
137:       if (
138:         typeof frame !== 'object' ||
139:         frame === null ||
140:         !('bytes' in frame) ||
141:         !(frame.bytes instanceof Uint8Array)
142:       )
143:         throw new Error('Missing chunk data');
144:       frame.bytes[0] = (frame.bytes[0] ?? 0) ^ 1;
145:       const body = canonicalEncode(frame);
146:       const changed = new Uint8Array(4 + body.length);
147:       changed.set(bytes.subarray(0, 4));
148:       changed.set(body, 4);
149:       base.send(peer, changed);
150:     },
151:   };
152:   const source = new OnlineTransferChannel({
153:     transport,
154:     peer: b,
155:     scope,
156:     clock: network.clock,
157:     onArtifact: () => undefined,
158:     onError: (error) => errors.push(error),
159:   });
160:   const destination = new OnlineTransferChannel({
161:     transport: network.transport(b),
162:     peer: a,
163:     scope,
164:     clock: network.clock,
165:     onArtifact: (artifact) => received.push(artifact),
166:     onError: (error) => errors.push(error),
167:   });
168:   try {
169:     const sending = source.send({ kind: 'offer', bytes: Uint8Array.of(1, 2, 3) });
170:     const rejected = sending.catch((error: unknown) => error);
171:     network.clock.advanceBy(0);
172:     expect(received).toEqual([]);
173:     expect(errors).toHaveLength(1);
174:     source.close();
175:     expect(await rejected).toEqual(new Error('Transfer channel closed'));
176:   } finally {
177:     source.close();
178:     destination.close();
179:     network.dispose();
180:   }
181: });
```


## packages/p2p/src/web-rtc-transport.ts

```text
1: import { toBase64Url } from '@cp2p/codec';
2: import { identityFromSecret, parsePeerId } from '@cp2p/crypto';
3: import type { PeerId, ProtocolClock, Transport, Unsubscribe } from '@cp2p/protocol';
4: import { PeerLink } from './peer-link.js';
5: import type { SignalBlob } from './signaling.js';
6: import { signSignalEnvelope, validAttemptId, verifySignalEnvelope } from './signaling-envelope.js';
7: import type { EnvelopeSignalingAdapter, SignedSignalEnvelope } from './signaling-envelope.js';
8: 
9: const RETIRED_LIMIT = 64;
10: const SESSION_HISTORY_LIMIT = 64;
11: const REMOVED_PEER_HISTORY_LIMIT = 64;
12: const ATTEMPT_TIMEOUT_MS = 30_000;
13: const MANUAL_ATTEMPT_TIMEOUT_MS = 5 * 60_000;
14: const EARLY_CANDIDATE_MS = 5_000;
15: const EARLY_CANDIDATE_LIMIT = 8;
16: const REPLACEMENT_INTERVAL_MS = 250;
17: const RETRY_MIN_MS = 250;
18: const RETRY_MAX_MS = 4_000;
19: 
20: interface LinkRecord {
21:   readonly link: PeerLink;
22:   readonly attemptId: string;
23:   readonly sessionId: string;
24:   readonly attemptSeq: number;
25:   readonly origin: PeerId;
26:   timeout: unknown;
27: }
28: 
29: interface EarlyCandidates {
30:   readonly attemptId: string;
31:   readonly sessionId: string;
32:   readonly attemptSeq: number;
33:   readonly blobs: SignalBlob[];
34:   readonly timeout: unknown;
35: }
36: 
37: interface DeferredOffer {
38:   readonly value: SignedSignalEnvelope;
39:   readonly timeout: unknown;
40: }
41: 
42: export type PeerCandidateRoute = 'host' | 'srflx' | 'relay' | 'unknown';
43: 
44: /** Address-free connection telemetry for a peer whose link authenticated locally. */
45: export interface WebRtcPeerStats {
46:   readonly peer: PeerId;
47:   readonly state: RTCPeerConnectionState;
48:   readonly rttMs: number | null;
49:   readonly route: PeerCandidateRoute;
50: }
51: 
52: interface StatsRecord {
53:   readonly id?: unknown;
54:   readonly type?: unknown;
55:   readonly selected?: unknown;
56:   readonly nominated?: unknown;
57:   readonly state?: unknown;
58:   readonly localCandidateId?: unknown;
59:   readonly currentRoundTripTime?: unknown;
60:   readonly selectedCandidatePairId?: unknown;
61:   readonly candidateType?: unknown;
62: }
63: 
64: function connectionStatsRouteAndRtt(report: RTCStatsReport): {
65:   readonly route: PeerCandidateRoute;
66:   readonly rttMs: number | null;
67: } {
68:   const records: StatsRecord[] = [];
69:   report.forEach((record) => records.push(record));
70:   const byId = new Map(
71:     records.flatMap((record) =>
72:       typeof record.id === 'string' ? [[record.id, record] as const] : [],
73:     ),
74:   );
75:   const selectedTransport = records.find(
76:     (record) => record.type === 'transport' && typeof record.selectedCandidatePairId === 'string',
77:   );
78:   const selectedPairId = selectedTransport?.selectedCandidatePairId;
79:   const selectedPair = typeof selectedPairId === 'string' ? byId.get(selectedPairId) : undefined;
80:   const pair =
81:     selectedPair ??
82:     records.find(
83:       (record) =>
84:         record.type === 'candidate-pair' &&
85:         (record.selected === true || (record.nominated === true && record.state === 'succeeded')),
86:     );
87:   if (!pair) return { route: 'unknown', rttMs: null };
88:   const localCandidate =
89:     typeof pair.localCandidateId === 'string' ? byId.get(pair.localCandidateId) : undefined;
90:   const route =
91:     localCandidate?.candidateType === 'host' ||
92:     localCandidate?.candidateType === 'srflx' ||
93:     localCandidate?.candidateType === 'relay'
94:       ? localCandidate.candidateType
95:       : 'unknown';
96:   const seconds = pair.currentRoundTripTime;
97:   return {
98:     route,
99:     rttMs:
100:       typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
101:         ? Math.round(seconds * 1_000)
102:         : null,
103:   };
104: }
105: 
106: export interface WebRtcTransportOptions {
107:   readonly self: PeerId;
108:   readonly secretKey: Uint8Array;
109:   readonly roster: readonly PeerId[];
110:   readonly scope: string;
111:   readonly adapter: EnvelopeSignalingAdapter;
112:   readonly clock: ProtocolClock;
113:   readonly rtcFactory: (peer: PeerId, configuration: RTCConfiguration) => RTCPeerConnection;
114:   readonly iceServers?: readonly RTCIceServer[];
115:   readonly iceTransportPolicy?: RTCIceTransportPolicy;
116:   /** Defaults to 30 s. Null selects a finite 5-minute manual deadline on both roles. */
117:   readonly attemptTimeoutMs?: number | null;
118:   readonly randomBytes?: (length: number) => Uint8Array;
119: }
120: 
121: export interface CertifiedRosterUpdate {
122:   readonly head: { readonly seq: number; readonly hash: string };
123:   readonly activeDevices: readonly PeerId[];
124:   readonly catchupDevices: readonly PeerId[];
125: }
126: 
127: /** Full-mesh Transport; only authenticated PeerLinks become visible to protocol callers. */
128: export class WebRtcTransport implements Transport {
129:   readonly self: PeerId;
130:   private readonly secretKey: Uint8Array;
131:   private readonly expected: Set<PeerId>;
132:   private readonly sessionId: string;
133:   private readonly links = new Map<PeerId, LinkRecord>();
134:   private readonly pendingLinks = new Map<PeerId, LinkRecord>();
135:   private readonly deferredOffers = new Map<PeerId, DeferredOffer>();
136:   private readonly online = new Set<PeerId>();
137:   private readonly retired = new Map<PeerId, Set<string>>();
138:   private readonly offerHighwater = new Map<PeerId, Map<string, number>>();
139:   private readonly earlyCandidates = new Map<PeerId, EarlyCandidates>();
140:   private readonly lastReplacement = new Map<PeerId, number>();
141:   private readonly retries = new Map<PeerId, unknown>();
142:   private readonly retryDelay = new Map<PeerId, number>();
143:   private readonly manualDisconnects = new Set<PeerId>();
144:   private readonly removedPeerHistory = new Set<PeerId>();
145:   private readonly messageListeners = new Set<(from: PeerId, bytes: Uint8Array) => void>();
146:   private readonly relayListeners = new Set<(from: PeerId, bytes: Uint8Array) => void>();
147:   private readonly peerListeners = new Set<(peer: PeerId, online: boolean) => void>();
148:   private readonly diagnosticListeners = new Set<
149:     (peer: PeerId, reason: string, security: boolean) => void
150:   >();
151:   private readonly unsubscribe: Unsubscribe;
152:   private generation = 0;
153:   private nextAttemptSeq = 0;
154:   private started = false;
155:   private rosterFrozen = false;
156:   private certifiedRoster: {
157:     readonly head: CertifiedRosterUpdate['head'];
158:     readonly activeDevices: ReadonlySet<PeerId>;
159:     readonly catchupDevices: ReadonlySet<PeerId>;
160:   } | null = null;
161:   private disposed = false;
162: 
163:   constructor(private readonly options: WebRtcTransportOptions) {
164:     this.self = options.self;
165:     if (
166:       !options.scope ||
167:       options.scope.length > 128 ||
168:       options.roster.length < 1 ||
169:       options.roster.length > 6 ||
170:       new Set(options.roster).size !== options.roster.length ||
171:       !options.roster.includes(options.self) ||
172:       (options.attemptTimeoutMs !== undefined &&
173:         options.attemptTimeoutMs !== null &&
174:         (!Number.isSafeInteger(options.attemptTimeoutMs) || options.attemptTimeoutMs < 1))
175:     )
176:       throw new TypeError('Invalid WebRTC mesh roster or scope');
177:     for (const peer of options.roster) parsePeerId(peer);
178:     const identity = identityFromSecret(options.secretKey);
179:     try {
180:       if (identity.peerId !== options.self) throw new TypeError('Mesh key does not match self');
181:     } finally {
182:       identity.secretKey.fill(0);
183:     }
184:     this.secretKey = options.secretKey.slice();
185:     try {
186:       this.sessionId = this.randomId();
187:     } catch (error) {
188:       this.secretKey.fill(0);
189:       throw error;
190:     }
191:     this.expected = new Set(options.roster.filter((peer) => peer !== options.self));
192:     try {
193:       this.unsubscribe = options.adapter.onSignal((from, value) => this.receive(from, value));
194:     } catch (error) {
195:       this.secretKey.fill(0);
196:       throw error;
197:     }
198:   }
199: 
200:   /** Begin signaling every roster link; manual callers may connect one peer at a time. */
201:   start(): void {
202:     if (this.disposed) throw new Error('WebRTC transport is disposed');
203:     this.started = true;
204:     for (const peer of this.expected) if (this.self < peer) this.connect(peer);
205:   }
206: 
207:   /** Explicit lobby selection. Server room snapshots never call this automatically. */
208:   updatePreGameRoster(roster: readonly PeerId[]): void {
209:     if (this.disposed) throw new Error('WebRTC transport is disposed');
210:     if (this.rosterFrozen) throw new Error('WebRTC roster is frozen');
211:     this.applyRoster(roster);
212:   }
213: 
214:   /**
215:    * Changes connection admission after lobby freeze. The caller must supply routes verified
216:    * against certified game history; this transport does not verify certificates or game packets.
217:    */
218:   updateCertifiedRoster(update: CertifiedRosterUpdate): void {
219:     if (this.disposed) throw new Error('WebRTC transport is disposed');
220:     if (!this.rosterFrozen) throw new Error('WebRTC roster is not frozen');
221:     const { head, activeDevices, catchupDevices } = update;
222:     if (
223:       !head ||
224:       !Number.isSafeInteger(head.seq) ||
225:       head.seq < 0 ||
226:       typeof head.hash !== 'string' ||
227:       !/^[0-9a-f]{64}$/.test(head.hash) ||
228:       !Array.isArray(activeDevices) ||
229:       !Array.isArray(catchupDevices) ||
230:       activeDevices.length < 1 ||
231:       activeDevices.length + catchupDevices.length > 6 ||
232:       ![...activeDevices, ...catchupDevices].includes(this.self) ||
233:       new Set([...activeDevices, ...catchupDevices]).size !==
234:         activeDevices.length + catchupDevices.length
235:     )
236:       throw new TypeError('Invalid certified WebRTC roster');
237:     const previous = this.certifiedRoster;
238:     const active = new Set(activeDevices);
239:     const catchup = new Set(catchupDevices);
240:     if (previous) {
241:       if (
242:         head.seq < previous.head.seq ||
243:         (head.seq === previous.head.seq && head.hash !== previous.head.hash)
244:       )
245:         throw new Error('Stale certified WebRTC roster');
246:       if (
247:         head.seq === previous.head.seq &&
248:         (active.size !== previous.activeDevices.size ||
249:           [...active].some((peer) => !previous.activeDevices.has(peer)) ||
250:           [...catchup].some((peer) => !previous.catchupDevices.has(peer)))
251:       )
252:         throw new Error('Conflicting certified WebRTC roster');
253:     }
254:     const roster = [...active, ...catchup];
255:     for (const peer of roster) parsePeerId(peer);
256:     // Link teardown notifies observers synchronously. Install the head before those callbacks
257:     // so a reentrant newer update cannot be overwritten by this one.
258:     this.certifiedRoster = {
259:       head: { seq: head.seq, hash: head.hash },
260:       activeDevices: active,
261:       catchupDevices: catchup,
262:     };
263:     this.applyRoster(roster);
264:   }
265: 
266:   private applyRoster(roster: readonly PeerId[]): void {
267:     if (
268:       !Array.isArray(roster) ||
269:       roster.length < 1 ||
270:       roster.length > 6 ||
271:       new Set(roster).size !== roster.length ||
272:       !roster.includes(this.self)
273:     )
274:       throw new TypeError('Invalid WebRTC mesh roster');
275:     for (const peer of roster) parsePeerId(peer);
276:     const next = new Set(roster.filter((peer) => peer !== this.self));
277:     const removed = [...this.expected].filter((peer) => !next.has(peer));
278:     const added = [...next].filter((peer) => !this.expected.has(peer));
279:     this.expected.clear();
280:     for (const peer of next) this.expected.add(peer);
281:     for (const peer of removed) {
282:       if (this.expected.has(peer)) continue;
283:       this.clearRetry(peer);
284:       this.clearEarly(peer);
285:       this.clearDeferred(peer);
286:       this.retirePending(peer);
287:       this.retireLink(peer);
288:       this.manualDisconnects.delete(peer);
289:       this.lastReplacement.delete(peer);
290:       this.retryDelay.delete(peer);
291:       this.removedPeerHistory.delete(peer);
292:       this.removedPeerHistory.add(peer);
293:     }
294:     for (const peer of added) {
295:       if (this.disposed) break;
296:       if (this.expected.has(peer) && this.started && this.self < peer) {
297:         try {
298:           this.connect(peer);
299:         } catch {
300:           this.scheduleRetry(peer);
301:         }
302:       }
303:     }
304:     this.trimRemovedPeerHistory();
305:   }
306: 
307:   roster(): readonly PeerId[] {
308:     return [this.self, ...this.expected].toSorted();
309:   }
310: 
311:   freezeRoster(): readonly PeerId[] {
312:     if (this.disposed) throw new Error('WebRTC transport is disposed');
313:     this.rosterFrozen = true;
314:     return this.roster();
315:   }
316: 
317:   connect(peer: PeerId): void {
318:     this.assertPeer(peer);
319:     this.manualDisconnects.delete(peer);
320:     this.clearRetry(peer);
321:     if (this.links.has(peer) || this.pendingLinks.has(peer)) return;
322:     if (this.nextAttemptSeq >= Number.MAX_SAFE_INTEGER)
323:       throw new Error('Signaling attempt sequence exhausted');
324:     this.startLink(
325:       peer,
326:       this.freshAttemptId(peer),
327:       this.self,
328:       this.sessionId,
329:       ++this.nextAttemptSeq,
330:     );
331:   }
332: 
333:   peers(): PeerId[] {
334:     return [...this.links]
335:       .filter(([, record]) => record.link.isAuthenticated)
336:       .map(([peer]) => peer)
337:       .toSorted();
338:   }
339: 
340:   /** Read selected ICE route and RTT for authenticated peers; candidate addresses are omitted. */
341:   async peerStats(): Promise<readonly WebRtcPeerStats[]> {
342:     const authenticated = [...this.links.entries()].filter(
343:       ([, record]) => record.link.isAuthenticated,
344:     );
345:     const values = await Promise.all(
346:       authenticated.map(async ([peer, record]): Promise<WebRtcPeerStats | null> => {
347:         const pc = record.link.pc;
348:         const state = pc.connectionState;
349:         let route: PeerCandidateRoute = 'unknown';
350:         let rttMs: number | null = null;
351:         try {
352:           ({ route, rttMs } = connectionStatsRouteAndRtt(await pc.getStats()));
353:         } catch {
354:           /* State remains useful when browser stats are unavailable. */
355:         }
356:         if (this.links.get(peer) !== record || !record.link.isAuthenticated) return null;
357:         return { peer, state, route, rttMs };
358:       }),
359:     );
360:     return values.filter((value): value is WebRtcPeerStats => value !== null);
361:   }
362: 
363:   send(to: PeerId, message: Uint8Array): void {
364:     const record = this.links.get(to);
365:     if (!record?.link.isAuthenticated) throw new Error('Peer is not authenticated');
366:     record.link.send(message);
367:   }
368: 
369:   /** Explicit bulk path for snapshot/sync integration; ordinary Transport traffic stays on game. */
370:   sendBulk(to: PeerId, message: Uint8Array): void {
371:     const record = this.links.get(to);
372:     if (!record?.link.isAuthenticated) throw new Error('Peer is not authenticated');
373:     record.link.send(message, 'bulk');
374:   }
375: 
376:   /** Reserved signaling control path; never delivered to gameplay listeners. */
377:   sendRelayFrame(to: PeerId, message: Uint8Array): void {
378:     this.sendBulk(to, message);
379:   }
380: 
381:   onRelayFrame(listener: (from: PeerId, bytes: Uint8Array) => void): Unsubscribe {
382:     if (this.disposed) return () => undefined;
383:     this.relayListeners.add(listener);
384:     return () => this.relayListeners.delete(listener);
385:   }
386: 
387:   broadcast(message: Uint8Array): void {
388:     let firstError: unknown = null;
389:     for (const peer of this.peers()) {
390:       try {
391:         this.send(peer, message);
392:       } catch (error) {
393:         firstError ??= error;
394:       }
395:     }
396:     if (firstError) throw firstError;
397:   }
398: 
399:   onMessage(listener: (from: PeerId, message: Uint8Array) => void): Unsubscribe {
400:     if (this.disposed) return () => undefined;
401:     this.messageListeners.add(listener);
402:     return () => {
403:       this.messageListeners.delete(listener);
404:     };
405:   }
406: 
407:   onPeerChange(listener: (peer: PeerId, online: boolean) => void): Unsubscribe {
408:     if (this.disposed) return () => undefined;
409:     this.peerListeners.add(listener);
410:     return () => {
411:       this.peerListeners.delete(listener);
412:     };
413:   }
414: 
415:   /** Reports local link failures; fingerprint failures stop automatic retries until connect(). */
416:   onDiagnostic(listener: (peer: PeerId, reason: string, security: boolean) => void): Unsubscribe {
417:     if (this.disposed) return () => undefined;
418:     this.diagnosticListeners.add(listener);
419:     return () => {
420:       this.diagnosticListeners.delete(listener);
421:     };
422:   }
423: 
424:   disconnect(peer: PeerId): void {
425:     this.assertPeer(peer);
426:     this.manualDisconnects.add(peer);
427:     this.clearRetry(peer);
428:     this.clearEarly(peer);
429:     this.clearDeferred(peer);
430:     this.retirePending(peer);
431:     this.retireLink(peer);
432:   }
433: 
434:   dispose(): void {
435:     if (this.disposed) return;
436:     this.disposed = true;
437:     try {
438:       try {
439:         this.unsubscribe();
440:       } catch {
441:         /* Continue closing owned resources. */
442:       }
443:       for (const peer of this.expected) {
444:         this.clearRetry(peer);
445:         this.clearEarly(peer);
446:         this.clearDeferred(peer);
447:         this.retirePending(peer);
448:         this.retireLink(peer);
449:       }
450:       this.options.adapter.close();
451:     } finally {
452:       this.secretKey.fill(0);
453:       this.messageListeners.clear();
454:       this.relayListeners.clear();
455:       this.peerListeners.clear();
456:       this.diagnosticListeners.clear();
457:     }
458:   }
459: 
460:   private receive(hint: PeerId, value: unknown): void {
461:     if (this.disposed) return;
462:     const signed = verifySignalEnvelope(value, this.options.scope, this.self, this.expected);
463:     if (!signed || signed.body.from !== hint) return;
464:     const { from, attemptId, sessionId, attemptSeq, blob } = signed.body;
465:     if (this.retired.get(from)?.has(attemptId) || this.manualDisconnects.has(from)) return;
466:     const primary = this.links.get(from);
467:     const pending = this.pendingLinks.get(from);
468:     let record = [primary, pending].find(
469:       (candidate) =>
470:         candidate?.attemptId === attemptId &&
471:         candidate.sessionId === sessionId &&
472:         candidate.attemptSeq === attemptSeq,
473:     );
474:     if (!record) {
475:       if (blob.kind === 'candidate') {
476:         this.bufferEarly(from, attemptId, sessionId, attemptSeq, blob);
477:         return;
478:       }
479:       const current = pending ?? primary;
480:       if (
481:         blob.description.type !== 'offer' ||
482:         (current && from !== current.origin && from > current.origin) ||
483:         !this.freshOffer(from, sessionId, attemptSeq)
484:       )
485:         return;
486:       const now = this.options.clock.now();
487:       const previous = this.lastReplacement.get(from);
488:       const replacing = current !== undefined;
489:       if (
490:         current &&
491:         from === current.origin &&
492:         previous !== undefined &&
493:         now - previous < REPLACEMENT_INTERVAL_MS
494:       ) {
495:         this.deferOffer(from, signed, previous + REPLACEMENT_INTERVAL_MS - now);
496:         return;
497:       }
498:       this.clearDeferred(from);
499:       this.retirePending(from);
500:       const keepPrimary = primary?.link.isAuthenticated || primary?.link.hasOpenedChannels;
501:       if (primary && !keepPrimary) this.retireLink(from);
502:       try {
503:         record = this.startLink(
504:           from,
505:           attemptId,
506:           from,
507:           sessionId,
508:           attemptSeq,
509:           keepPrimary ? 'pending' : 'primary',
510:         );
511:       } catch {
512:         return;
513:       }
514:       this.rememberOffer(from, sessionId, attemptSeq);
515:       if (replacing) this.lastReplacement.set(from, now);
516:     }
517:     if (!record) return;
518:     void record.link.receiveSignal(blob);
519:     if (blob.kind === 'description' && blob.description.type === 'offer') {
520:       const early = this.earlyCandidates.get(from);
521:       if (
522:         early?.attemptId === attemptId &&
523:         early.sessionId === sessionId &&
524:         early.attemptSeq === attemptSeq
525:       ) {
526:         this.clearEarly(from);
527:         for (const candidate of early.blobs) void record.link.receiveSignal(candidate);
528:       }
529:     }
530:   }
531: 
532:   private startLink(
533:     peer: PeerId,
534:     attemptId: string,
535:     origin: PeerId,
536:     sessionId: string,
537:     attemptSeq: number,
538:     slot: 'primary' | 'pending' = 'primary',
539:   ): LinkRecord {
540:     const generation = ++this.generation;
541:     let record: LinkRecord | null = null;
542:     const configuration: RTCConfiguration = {
543:       iceServers: [...(this.options.iceServers ?? [])],
544:       iceTransportPolicy: this.options.iceTransportPolicy ?? 'all',
545:     };
546:     const link = new PeerLink({
547:       self: this.self,
548:       peer,
549:       secretKey: this.secretKey,
550:       scope: this.options.scope,
551:       generation,
552:       offerMode: origin === peer ? 'answer-only' : 'auto',
553:       clock: this.options.clock,
554:       rtcFactory: () => this.options.rtcFactory(peer, configuration),
555:       ...(this.options.randomBytes ? { randomBytes: this.options.randomBytes } : {}),
556:       signal: (blob) => {
557:         if (!this.expected.has(peer) || this.disposed || this.manualDisconnects.has(peer))
558:           return Promise.reject(new Error('Peer is outside the active mesh roster'));
559:         return this.options.adapter.send(
560:           peer,
561:           signSignalEnvelope(
562:             {
563:               version: 1,
564:               scope: this.options.scope,
565:               from: this.self,
566:               to: peer,
567:               attemptId,
568:               sessionId,
569:               attemptSeq,
570:               blob,
571:             },
572:             this.secretKey,
573:           ),
574:         );
575:       },
576:       onMessage: (message) => {
577:         if (record && this.links.get(peer) === record && link.isAuthenticated) {
578:           const relay =
579:             message.length >= 5 &&
580:             message[0] === 0x48 &&
581:             message[1] === 0x58 &&
582:             message[2] === 0x52 &&
583:             message[3] === 0x31 &&
584:             message[4] === 0;
585:           for (const listener of relay ? this.relayListeners : this.messageListeners) {
586:             try {
587:               listener(peer, message.slice());
588:             } catch {
589:               /* Isolate observers. */
590:             }
591:           }
592:         }
593:       },
594:       onAuthenticated: () => {
595:         if (record && this.pendingLinks.get(peer) === record) {
596:           this.retireLink(peer);
597:           if (
598:             this.disposed ||
599:             this.manualDisconnects.has(peer) ||
600:             this.pendingLinks.get(peer) !== record ||
601:             !link.isAuthenticated
602:           )
603:             return;
604:           this.pendingLinks.delete(peer);
605:           this.links.set(peer, record);
606:         }
607:         if (record && this.links.get(peer) === record && !this.online.has(peer)) {
608:           this.clearAttemptTimeout(record);
609:           this.retryDelay.delete(peer);
610:           this.online.add(peer);
611:           for (const listener of this.peerListeners) {
612:             try {
613:               listener(peer, true);
614:             } catch {
615:               /* Isolate observers. */
616:             }
617:           }
618:         }
619:       },
620:       onDown: (reason) => {
621:         if (record) this.linkDown(peer, record, reason);
622:       },
623:     });
624:     record = { link, attemptId, sessionId, attemptSeq, origin, timeout: null };
625:     if (slot === 'pending') this.pendingLinks.set(peer, record);
626:     else this.links.set(peer, record);
627:     const timeoutMs =
628:       this.options.attemptTimeoutMs === null
629:         ? MANUAL_ATTEMPT_TIMEOUT_MS
630:         : (this.options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS);
631:     record.timeout = this.options.clock.setTimeout(() => {
632:       if (
633:         (this.links.get(peer) === record || this.pendingLinks.get(peer) === record) &&
634:         !link.isAuthenticated
635:       )
636:         link.close('attempt-timeout');
637:     }, timeoutMs);
638:     return record;
639:   }
640: 
641:   private linkDown(peer: PeerId, record: LinkRecord, reason: string): void {
642:     if (this.pendingLinks.get(peer) === record) {
643:       this.pendingLinks.delete(peer);
644:       this.clearAttemptTimeout(record);
645:       this.rememberRetired(peer, record.attemptId);
646:       this.emitDiagnostic(peer, reason);
647:       if (
648:         !this.links.has(peer) &&
649:         !this.disposed &&
650:         !this.manualDisconnects.has(peer) &&
651:         this.self < peer
652:       )
653:         this.scheduleRetry(peer);
654:       return;
655:     }
656:     if (this.links.get(peer) !== record) return;
657:     this.links.delete(peer);
658:     this.clearAttemptTimeout(record);
659:     this.rememberRetired(peer, record.attemptId);
660:     this.emitDown(peer);
661:     if (isSecurityReason(reason)) {
662:       this.manualDisconnects.add(peer);
663:       this.clearDeferred(peer);
664:       this.retirePending(peer);
665:     }
666:     this.emitDiagnostic(peer, reason);
667:     if (
668:       !this.disposed &&
669:       !this.manualDisconnects.has(peer) &&
670:       this.self < peer &&
671:       !this.pendingLinks.has(peer)
672:     )
673:       this.scheduleRetry(peer);
674:   }
675: 
676:   private emitDiagnostic(peer: PeerId, reason: string): void {
677:     for (const listener of this.diagnosticListeners) {
678:       try {
679:         listener(peer, reason, isSecurityReason(reason));
680:       } catch {
681:         /* Isolate observers. */
682:       }
683:     }
684:   }
685: 
686:   private retireLink(peer: PeerId): void {
687:     const record = this.links.get(peer);
688:     if (!record) return;
689:     this.links.delete(peer);
690:     this.clearAttemptTimeout(record);
691:     this.rememberRetired(peer, record.attemptId);
692:     record.link.close();
693:     this.emitDown(peer);
694:   }
695: 
696:   private retirePending(peer: PeerId): void {
697:     const record = this.pendingLinks.get(peer);
698:     if (!record) return;
699:     this.pendingLinks.delete(peer);
700:     this.clearAttemptTimeout(record);
701:     this.rememberRetired(peer, record.attemptId);
702:     record.link.close();
703:   }
704: 
705:   private emitDown(peer: PeerId): void {
706:     if (!this.online.delete(peer)) return;
707:     for (const listener of this.peerListeners) {
708:       try {
709:         listener(peer, false);
710:       } catch {
711:         /* Isolate observers. */
712:       }
713:     }
714:   }
715: 
716:   private rememberRetired(peer: PeerId, id: string): void {
717:     const seen = this.retired.get(peer) ?? new Set<string>();
718:     seen.add(id);
719:     if (seen.size > RETIRED_LIMIT) {
720:       const oldest = seen.values().next().value;
721:       if (oldest !== undefined) seen.delete(oldest);
722:     }
723:     this.retired.set(peer, seen);
724:   }
725: 
726:   private freshOffer(peer: PeerId, sessionId: string, seq: number): boolean {
727:     const seen = this.offerHighwater.get(peer)?.get(sessionId);
728:     return seen === undefined || seq > seen;
729:   }
730: 
731:   private rememberOffer(peer: PeerId, sessionId: string, seq: number): void {
732:     const seen = this.offerHighwater.get(peer) ?? new Map<string, number>();
733:     seen.delete(sessionId);
734:     seen.set(sessionId, seq);
735:     if (seen.size > SESSION_HISTORY_LIMIT) {
736:       const oldest = seen.keys().next().value;
737:       if (oldest !== undefined) seen.delete(oldest);
738:     }
739:     this.offerHighwater.set(peer, seen);
740:   }
741: 
742:   private bufferEarly(
743:     peer: PeerId,
744:     attemptId: string,
745:     sessionId: string,
746:     attemptSeq: number,
747:     blob: SignalBlob & { kind: 'candidate' },
748:   ): void {
749:     if (!this.freshOffer(peer, sessionId, attemptSeq)) return;
750:     let pending = this.earlyCandidates.get(peer);
751:     if (
752:       pending &&
753:       (pending.attemptId !== attemptId ||
754:         pending.sessionId !== sessionId ||
755:         pending.attemptSeq !== attemptSeq)
756:     ) {
757:       this.clearEarly(peer);
758:       pending = undefined;
759:     }
760:     if (!pending) {
761:       const timeout = this.options.clock.setTimeout(
762:         () => this.clearEarly(peer),
763:         EARLY_CANDIDATE_MS,
764:       );
765:       pending = { attemptId, sessionId, attemptSeq, blobs: [], timeout };
766:       this.earlyCandidates.set(peer, pending);
767:     }
768:     if (pending.blobs.length < EARLY_CANDIDATE_LIMIT) pending.blobs.push(blob);
769:   }
770: 
771:   private clearEarly(peer: PeerId): void {
772:     const pending = this.earlyCandidates.get(peer);
773:     if (!pending) return;
774:     this.options.clock.clearTimeout(pending.timeout);
775:     this.earlyCandidates.delete(peer);
776:   }
777: 
778:   private deferOffer(peer: PeerId, value: SignedSignalEnvelope, waitMs: number): void {
779:     const previous = this.deferredOffers.get(peer);
780:     if (
781:       previous &&
782:       previous.value.body.sessionId === value.body.sessionId &&
783:       previous.value.body.attemptSeq >= value.body.attemptSeq
784:     )
785:       return;
786:     this.clearDeferred(peer);
787:     const timeout = this.options.clock.setTimeout(
788:       () => {
789:         if (this.deferredOffers.get(peer)?.value !== value) return;
790:         this.deferredOffers.delete(peer);
791:         this.receive(peer, value);
792:       },
793:       Math.max(1, waitMs),
794:     );
795:     this.deferredOffers.set(peer, { value, timeout });
796:   }
797: 
798:   private clearDeferred(peer: PeerId): void {
799:     const deferred = this.deferredOffers.get(peer);
800:     if (!deferred) return;
801:     this.options.clock.clearTimeout(deferred.timeout);
802:     this.deferredOffers.delete(peer);
803:   }
804: 
805:   private randomId(): string {
806:     const bytes = (this.options.randomBytes ?? defaultRandomBytes)(16);
807:     if (!(bytes instanceof Uint8Array) || bytes.length !== 16)
808:       throw new TypeError('Attempt ID source must provide 16 bytes');
809:     const id = toBase64Url(bytes);
810:     bytes.fill(0);
811:     return id;
812:   }
813: 
814:   private freshAttemptId(peer: PeerId): string {
815:     for (let tries = 0; tries < 4; tries++) {
816:       const id = this.randomId();
817:       if (
818:         validAttemptId(id) &&
819:         !this.retired.get(peer)?.has(id) &&
820:         this.links.get(peer)?.attemptId !== id
821:       )
822:         return id;
823:     }
824:     throw new Error('Attempt ID source repeated a recent ID');
825:   }
826: 
827:   private scheduleRetry(peer: PeerId): void {
828:     if (!this.expected.has(peer) || this.disposed || this.retries.has(peer)) return;
829:     const delay = this.retryDelay.get(peer) ?? RETRY_MIN_MS;
830:     this.retryDelay.set(peer, Math.min(delay * 2, RETRY_MAX_MS));
831:     this.retries.set(
832:       peer,
833:       this.options.clock.setTimeout(() => {
834:         this.retries.delete(peer);
835:         if (
836:           !this.disposed &&
837:           this.expected.has(peer) &&
838:           !this.manualDisconnects.has(peer) &&
839:           !this.links.has(peer) &&
840:           !this.pendingLinks.has(peer)
841:         ) {
842:           try {
843:             this.connect(peer);
844:           } catch {
845:             this.scheduleRetry(peer);
846:           }
847:         }
848:       }, delay),
849:     );
850:   }
851: 
852:   private clearRetry(peer: PeerId): void {
853:     const timer = this.retries.get(peer);
854:     if (timer !== undefined) this.options.clock.clearTimeout(timer);
855:     this.retries.delete(peer);
856:   }
857: 
858:   private clearAttemptTimeout(record: LinkRecord): void {
859:     if (record.timeout !== null) this.options.clock.clearTimeout(record.timeout);
860:     record.timeout = null;
861:   }
862: 
863:   private assertPeer(peer: PeerId): void {
864:     if (this.disposed) throw new Error('WebRTC transport is disposed');
865:     if (!this.expected.has(peer)) throw new Error('Unknown mesh peer');
866:   }
867: 
868:   private trimRemovedPeerHistory(): void {
869:     while (this.removedPeerHistory.size > REMOVED_PEER_HISTORY_LIMIT) {
870:       const oldest = this.removedPeerHistory.values().next().value;
871:       if (oldest === undefined) return;
872:       this.removedPeerHistory.delete(oldest);
873:       if (!this.expected.has(oldest)) {
874:         this.retired.delete(oldest);
875:         this.offerHighwater.delete(oldest);
876:       }
877:     }
878:   }
879: }
880: 
881: function defaultRandomBytes(length: number): Uint8Array {
882:   const bytes = new Uint8Array(new ArrayBuffer(length));
883:   globalThis.crypto.getRandomValues(bytes);
884:   return bytes;
885: }
886: 
887: function isSecurityReason(reason: string): boolean {
888:   return reason === 'hello-binding' || reason === 'fingerprint-changed';
889: }
```


## packages/p2p/src/web-rtc-transport.test.ts

```text
1: import { identityFromSecret } from '@cp2p/crypto';
2: import { canonicalEncode, toBase64Url } from '@cp2p/codec';
3: import type { PeerId } from '@cp2p/protocol';
4: import { describe, expect, test } from 'vitest';
5: import { InProcessSignaling } from './in-process-signaling.js';
6: import { ManualBridge } from './manual-bootstrap.js';
7: import { MeshRelaySignalingAdapter } from './mesh-relay-signaling.js';
8: import { signSignalEnvelope, verifySignalEnvelope } from './signaling-envelope.js';
9: import type { SignedSignalEnvelope } from './signaling-envelope.js';
10: import { WebRtcTransport } from './web-rtc-transport.js';
11: import { VirtualClock } from '../../protocol/src/testing/virtual-clock.js';
12: 
13: type Listener = (event: {
14:   data?: unknown;
15:   candidate?: { toJSON(): RTCIceCandidateInit } | null;
16: }) => void;
17: 
18: class Channel {
19:   readonly listeners = new Map<string, Listener[]>();
20:   peer: Channel | null = null;
21:   readyState: RTCDataChannelState = 'connecting';
22:   bufferedAmount = 0;
23:   bufferedAmountLowThreshold = 0;
24:   binaryType: BinaryType = 'blob';
25:   constructor(readonly id: number) {}
26:   addEventListener(type: string, listener: Listener): void {
27:     const values = this.listeners.get(type) ?? [];
28:     values.push(listener);
29:     this.listeners.set(type, values);
30:   }
31:   removeEventListener(type: string, listener: Listener): void {
32:     this.listeners.set(
33:       type,
34:       (this.listeners.get(type) ?? []).filter((value) => value !== listener),
35:     );
36:   }
37:   emit(type: string, event: Parameters<Listener>[0] = {}): void {
38:     for (const listener of this.listeners.get(type) ?? []) listener(event);
39:   }
40:   send(value: string | ArrayBuffer): void {
41:     if (this.readyState !== 'open') throw new Error('Fake channel is closed');
42:     const copy = value instanceof ArrayBuffer ? value.slice(0) : value;
43:     queueMicrotask(() => this.peer?.emit('message', { data: copy }));
44:   }
45:   close(): void {
46:     if (this.readyState === 'closed') return;
47:     this.readyState = 'closed';
48:     this.emit('close');
49:     this.peer?.close();
50:   }
51:   open(): void {
52:     this.readyState = 'open';
53:     this.emit('open');
54:   }
55: }
56: 
57: function sdp(peer: PeerId, tag?: number): string {
58:   const byte = peer.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase();
59:   return `v=0\r\na=group:BUNDLE data\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:data\r\na=fingerprint:sha-256 ${Array(32).fill(byte).join(':')}\r\na=sctp-port:5000\r\n${tag === undefined ? '' : `a=x-attempt:${tag}\r\n`}`;
60: }
61: 
62: function attemptTag(description: RTCSessionDescriptionInit | null): string | null {
63:   return /^a=x-attempt:(\d+)$/m.exec(description?.sdp ?? '')?.[1] ?? null;
64: }
65: 
66: class Connection {
67:   readonly listeners = new Map<string, Listener[]>();
68:   readonly channels = new Map<number, Channel>();
69:   signalingState: RTCSignalingState = 'stable';
70:   connectionState: RTCPeerConnectionState = 'connected';
71:   localDescription: RTCSessionDescriptionInit | null;
72:   remoteDescription: RTCSessionDescriptionInit | null;
73:   currentLocalDescription: RTCSessionDescriptionInit | null;
74:   currentRemoteDescription: RTCSessionDescriptionInit | null;
75:   private remoteOffer = false;
76:   private localSet = false;
77:   private remoteSet = false;
78:   readonly candidates: (RTCIceCandidateInit | null)[] = [];
79:   statsRecords: readonly Readonly<Record<string, unknown>>[] = [];
80:   constructor(
81:     readonly self: PeerId,
82:     readonly peer: PeerId,
83:     private readonly fabric: Fabric,
84:     private readonly tag: number,
85:   ) {
86:     this.currentLocalDescription = this.localDescription = { type: 'offer', sdp: sdp(self) };
87:     this.currentRemoteDescription = this.remoteDescription = { type: 'answer', sdp: sdp(peer) };
88:   }
89:   createDataChannel(_name: string, options: RTCDataChannelInit): RTCDataChannel {
90:     const channel = new Channel(options.id ?? -1);
91:     this.channels.set(channel.id, channel);
92:     this.fabric.wire(this.self, this.peer);
93:     // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test fake implements PeerLink's RTC channel surface.
94:     return channel as unknown as RTCDataChannel;
95:   }
96:   addEventListener(type: string, listener: Listener): void {
97:     const values = this.listeners.get(type) ?? [];
98:     values.push(listener);
99:     this.listeners.set(type, values);
100:   }
101:   emit(type: string): void {
102:     for (const listener of this.listeners.get(type) ?? []) listener({});
103:   }
104:   async setLocalDescription(): Promise<void> {
105:     this.currentLocalDescription = this.localDescription = {
106:       type: this.remoteOffer ? 'answer' : 'offer',
107:       sdp: sdp(
108:         this.self,
109:         this.remoteOffer ? Number(attemptTag(this.currentRemoteDescription)) : this.tag,
110:       ),
111:     };
112:     this.signalingState = this.remoteOffer ? 'stable' : 'have-local-offer';
113:     this.localSet = true;
114:     this.emit('signalingstatechange');
115:     this.fabric.wire(this.self, this.peer);
116:   }
117:   async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
118:     this.remoteOffer = description.type === 'offer';
119:     this.currentRemoteDescription = this.remoteDescription = this.fabric.tamperRemoteFingerprint
120:       ? { ...description, sdp: sdp('CC', Number(attemptTag(description))) }
121:       : description;
122:     this.signalingState = this.remoteOffer ? 'have-remote-offer' : 'stable';
123:     this.remoteSet = true;
124:     this.emit('signalingstatechange');
125:     this.fabric.wire(this.self, this.peer);
126:   }
127:   async addIceCandidate(candidate: RTCIceCandidateInit | null): Promise<void> {
128:     this.candidates.push(candidate);
129:   }
130:   async getStats(): Promise<RTCStatsReport> {
131:     const report = new Map(
132:       this.statsRecords.map((record, index) => [
133:         typeof record.id === 'string' || typeof record.id === 'number'
134:           ? String(record.id)
135:           : String(index),
136:         record,
137:       ]),
138:     );
139:     return report;
140:   }
141:   restartIce(): void {
142:     this.emit('negotiationneeded');
143:   }
144:   close(): void {
145:     if (this.connectionState === 'closed') return;
146:     this.connectionState = 'closed';
147:     for (const channel of this.channels.values()) channel.close();
148:   }
149:   rtc(): RTCPeerConnection {
150:     // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test fake implements PeerLink's RTC connection surface.
151:     return this as unknown as RTCPeerConnection;
152:   }
153:   get negotiated(): boolean {
154:     return this.localSet && this.remoteSet;
155:   }
156:   get negotiationTag(): string | null {
157:     return attemptTag(this.currentLocalDescription);
158:   }
159: }
160: 
161: class Fabric {
162:   private readonly connections = new Map<string, Connection>();
163:   private nextTag = 1;
164:   tamperRemoteFingerprint = false;
165:   create(self: PeerId, peer: PeerId): RTCPeerConnection {
166:     const pc = new Connection(self, peer, this, this.nextTag++);
167:     this.connections.set(`${self}/${peer}`, pc);
168:     queueMicrotask(() => pc.emit('negotiationneeded'));
169:     return pc.rtc();
170:   }
171:   close(self: PeerId, peer: PeerId): void {
172:     this.connections.get(`${self}/${peer}`)?.close();
173:     this.connections.get(`${peer}/${self}`)?.close();
174:   }
175:   failOneSide(self: PeerId, peer: PeerId): void {
176:     const pc = this.connections.get(`${self}/${peer}`);
177:     if (!pc) throw new Error('Missing fake connection');
178:     for (const channel of pc.channels.values()) channel.peer = null;
179:     pc.connectionState = 'failed';
180:     pc.emit('connectionstatechange');
181:   }
182:   connection(self: PeerId, peer: PeerId): Connection | undefined {
183:     return this.connections.get(`${self}/${peer}`);
184:   }
185:   wire(self: PeerId, peer: PeerId): void {
186:     const left = this.connections.get(`${self}/${peer}`);
187:     const right = this.connections.get(`${peer}/${self}`);
188:     if (
189:       !left ||
190:       !right ||
191:       !left.negotiated ||
192:       !right.negotiated ||
193:       !left.negotiationTag ||
194:       left.negotiationTag !== right.negotiationTag ||
195:       left.connectionState === 'closed' ||
196:       right.connectionState === 'closed'
197:     )
198:       return;
199:     for (const id of [0, 1]) {
200:       const a = left.channels.get(id);
201:       const b = right.channels.get(id);
202:       if (!a || !b || a.peer || b.peer) continue;
203:       a.peer = b;
204:       b.peer = a;
205:       if (id === 1)
206:         queueMicrotask(() => {
207:           for (const channel of [
208:             left.channels.get(0),
209:             left.channels.get(1),
210:             right.channels.get(0),
211:             right.channels.get(1),
212:           ])
213:             channel?.open();
214:         });
215:     }
216:   }
217: }
218: 
219: async function settle(): Promise<void> {
220:   // oxlint-disable-next-line no-await-in-loop -- each turn drains the next signaling microtask.
221:   for (let index = 0; index < 30; index++) await Promise.resolve();
222: }
223: 
224: function member<T>(values: readonly T[], index: number): T {
225:   const value = values[index];
226:   if (value === undefined) throw new Error(`Missing test mesh member ${index}`);
227:   return value;
228: }
229: 
230: function mesh(
231:   count: number,
232:   descendingIds = false,
233:   manualDeadline = false,
234:   selfOnly = false,
235:   relay = false,
236:   tamperDescriptions = false,
237: ) {
238:   const identities = Array.from({ length: count }, (_, index) =>
239:     identityFromSecret(new Uint8Array(32).fill(index + 1)),
240:   );
241:   const roster = identities.map((identity) => identity.peerId);
242:   const signaling = new InProcessSignaling();
243:   const fabric = new Fabric();
244:   const clock = new VirtualClock();
245:   let tamperedDescriptions = 0;
246:   const adapters = identities.map((identity) => {
247:     const adapter = signaling.adapter(identity.peerId);
248:     if (!tamperDescriptions) return adapter;
249:     return {
250:       async send(to: PeerId, value: SignedSignalEnvelope): Promise<void> {
251:         if (value.body.blob.kind !== 'description') return adapter.send(to, value);
252:         tamperedDescriptions++;
253:         const description = value.body.blob.description;
254:         const fakeFingerprint = `a=fingerprint:sha-256 ${Array(32).fill('CC').join(':')}`;
255:         const forged: SignedSignalEnvelope = {
256:           ...value,
257:           body: {
258:             ...value.body,
259:             blob: {
260:               ...value.body.blob,
261:               description: {
262:                 ...description,
263:                 sdp: (description.sdp ?? '').replace(/a=fingerprint:[^\r\n]+/, fakeFingerprint),
264:               },
265:             },
266:           },
267:         };
268:         await adapter.send(to, forged);
269:       },
270:       onSignal: (listener: (from: PeerId, value: unknown) => void) => adapter.onSignal(listener),
271:       close: () => adapter.close(),
272:     };
273:   });
274:   const relayAdapters = relay
275:     ? identities.map(
276:         (identity, index) =>
277:           new MeshRelaySignalingAdapter(
278:             identity.peerId,
279:             'test-lobby',
280:             clock,
281:             member(adapters, index),
282:           ),
283:       )
284:     : [];
285:   const peers = identities.map((identity, index) => {
286:     let nextRandom = index + 1;
287:     return new WebRtcTransport({
288:       self: identity.peerId,
289:       secretKey: identity.secretKey,
290:       roster: selfOnly ? [identity.peerId] : roster,
291:       scope: 'test-lobby',
292:       adapter: relay ? member(relayAdapters, index) : member(adapters, index),
293:       clock,
294:       ...(manualDeadline ? { attemptTimeoutMs: null } : {}),
295:       rtcFactory: (peer) => fabric.create(identity.peerId, peer),
296:       randomBytes: (length) =>
297:         new Uint8Array(length).fill(descendingIds ? 255 - nextRandom++ : nextRandom++),
298:     });
299:   });
300:   if (relay) peers.forEach((peer, index) => member(relayAdapters, index).attachTransport(peer));
301:   return {
302:     identities,
303:     roster,
304:     signaling,
305:     adapters,
306:     relayAdapters,
307:     tamperedDescriptions: () => tamperedDescriptions,
308:     fabric,
309:     clock,
310:     peers,
311:     dispose: () => {
312:       for (const peer of peers) peer.dispose();
313:       signaling.dispose();
314:     },
315:   };
316: }
317: 
318: describe('authenticated WebRTC mesh', () => {
319:   test('exposes address-free selected route and RTT only for authenticated peers', async () => {
320:     const f = mesh(3);
321:     try {
322:       const [a, b, c] = f.roster;
323:       if (!a || !b || !c) throw new Error('Missing stats test peers');
324:       const aTransport = member(f.peers, f.roster.indexOf(a));
325:       const bTransport = member(f.peers, f.roster.indexOf(b));
326:       const cTransport = member(f.peers, f.roster.indexOf(c));
327:       expect(await aTransport.peerStats()).toEqual([]);
328:       aTransport.connect(b);
329:       await settle();
330:       const connection = f.fabric.connection(a, b);
331:       if (!connection) throw new Error('Missing stats test connection');
332:       connection.statsRecords = [
333:         { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' },
334:         {
335:           id: 'pair',
336:           type: 'candidate-pair',
337:           localCandidateId: 'local',
338:           state: 'succeeded',
339:           nominated: true,
340:           currentRoundTripTime: 0.0426,
341:         },
342:         {
343:           id: 'local',
344:           type: 'local-candidate',
345:           candidateType: 'relay',
346:           address: '192.0.2.44',
347:           usernameFragment: 'private',
348:         },
349:       ];
350:       expect(await aTransport.peerStats()).toEqual([
351:         { peer: b, state: 'connected', route: 'relay', rttMs: 43 },
352:       ]);
353:       expect(await cTransport.peerStats()).toEqual([]);
354:       expect(await bTransport.peerStats()).toEqual([
355:         { peer: a, state: 'connected', route: 'unknown', rttMs: null },
356:       ]);
357:     } finally {
358:       f.dispose();
359:     }
360:   });
361: 
362:   test('returns unknown route and RTT when browser statistics fail', async () => {
363:     const f = mesh(2);
364:     try {
365:       const [a, b] = f.roster;
366:       if (!a || !b) throw new Error('Missing stats test peers');
367:       const transport = member(f.peers, f.roster.indexOf(a));
368:       transport.connect(b);
369:       await settle();
370:       const connection = f.fabric.connection(a, b);
371:       if (!connection) throw new Error('Missing stats test connection');
372:       connection.getStats = async () => {
373:         throw new Error('stats unavailable');
374:       };
375:       expect(await transport.peerStats()).toEqual([
376:         { peer: b, state: 'connected', route: 'unknown', rttMs: null },
377:       ]);
378:     } finally {
379:       f.dispose();
380:     }
381:   });
382: 
383:   test('signed in-mesh signaling forms the missing link after the server disappears', async () => {
384:     const f = mesh(3, false, false, false, true);
385:     try {
386:       const a = member(f.roster, 0);
387:       const b = member(f.roster, 1);
388:       const c = member(f.roster, 2);
389:       member(f.peers, a < b ? 0 : 1).connect(a < b ? b : a);
390:       await settle();
391:       member(f.peers, b < c ? 1 : 2).connect(b < c ? c : b);
392:       await settle();
393:       expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 2, 1]);
394:       for (const adapter of f.adapters) adapter.close();
395:       const leaked: Uint8Array[] = [];
396:       for (const peer of f.peers) peer.onMessage((_from, bytes) => leaked.push(bytes));
397:       member(f.peers, 0).connect(c);
398:       await settle();
399:       expect(f.peers.map((peer) => peer.peers().length)).toEqual([2, 2, 2]);
400:       expect(member(f.peers, 0).peers()).toContain(c);
401:       expect(member(f.peers, 2).peers()).toContain(a);
402:       expect(leaked).toEqual([]);
403:       const temporaryChannel = new Channel(2);
404:       temporaryChannel.open();
405:       const temporaryPc = new EventTarget();
406:       let closedBridgePc = false;
407:       Object.assign(temporaryPc, {
408:         close: () => {
409:           closedBridgePc = true;
410:         },
411:       });
412:       const bridge = new ManualBridge(
413:         // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Route-only test PC.
414:         temporaryPc as unknown as RTCPeerConnection,
415:         // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Route-only test channel.
416:         temporaryChannel as unknown as RTCDataChannel,
417:         'test-lobby',
418:         a,
419:         b,
420:         f.clock,
421:       );
422:       member(f.relayAdapters, 0).addBridge(bridge);
423:       expect(closedBridgePc).toBe(false);
424:       const routeProof = signSignalEnvelope(
425:         {
426:           version: 1,
427:           scope: 'test-lobby',
428:           from: b,
429:           to: a,
430:           attemptId: toBase64Url(new Uint8Array(16).fill(79)),
431:           sessionId: toBase64Url(new Uint8Array(16).fill(80)),
432:           attemptSeq: 1,
433:           blob: { kind: 'candidate', generation: 0, revision: 1, candidate: null },
434:         },
435:         member(f.identities, 1).secretKey,
436:       );
437:       const routePayload = canonicalEncode({ v: 1, hops: 1, envelope: routeProof });
438:       const routeFrame = new Uint8Array(5 + routePayload.length);
439:       routeFrame.set([0x48, 0x58, 0x52, 0x31, 0]);
440:       routeFrame.set(routePayload, 5);
441:       member(f.peers, 1).sendRelayFrame(c, routeFrame);
442:       await settle();
443:       expect(member(f.relayAdapters, 0).hasBridge(b)).toBe(false);
444:       expect(closedBridgePc).toBe(true);
445:       const received: SignedSignalEnvelope[] = [];
446:       member(f.relayAdapters, 2).onSignal((_from, value) => {
447:         const signed = verifySignalEnvelope(value, 'test-lobby', c, new Set([a]));
448:         if (signed) received.push(signed);
449:       });
450:       const signal = signSignalEnvelope(
451:         {
452:           version: 1,
453:           scope: 'test-lobby',
454:           from: a,
455:           to: c,
456:           attemptId: toBase64Url(new Uint8Array(16).fill(88)),
457:           sessionId: toBase64Url(new Uint8Array(16).fill(89)),
458:           attemptSeq: 1,
459:           blob: { kind: 'candidate', generation: 0, revision: 1, candidate: null },
460:         },
461:         member(f.identities, 0).secretKey,
462:       );
463:       await member(f.relayAdapters, 0).send(c, signal);
464:       await member(f.relayAdapters, 0).send(c, signal);
465:       await settle();
466:       expect(received).toEqual([signal]);
467:       await expect(
468:         member(f.relayAdapters, 0).send(c, {
469:           ...signal,
470:           sig: member(f.identities, 1).peerId,
471:         }),
472:       ).rejects.toThrow('Invalid local signal');
473:       expect(leaked).toEqual([]);
474:     } finally {
475:       f.dispose();
476:     }
477:   });
478: 
479:   test('a bounded relay holds an early signal until the target authenticates with the host', async () => {
480:     const f = mesh(3, false, false, false, true);
481:     try {
482:       const [a, b, c] = f.roster;
483:       if (!a || !b || !c) throw new Error('Missing relay test peer');
484:       member(f.peers, a < b ? 0 : 1).connect(a < b ? b : a);
485:       await settle();
486:       expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 1, 0]);
487:       member(f.adapters, 0).close();
488:       member(f.peers, 0).connect(c);
489:       await settle();
490:       expect(member(f.peers, 0).peers()).not.toContain(c);
491:       member(f.peers, b < c ? 1 : 2).connect(b < c ? c : b);
492:       await settle();
493:       expect(f.peers.map((peer) => peer.peers().length)).toEqual([2, 2, 2]);
494:     } finally {
495:       f.dispose();
496:     }
497:   });
498:   test('can freeze a single-host game roster', () => {
499:     const f = mesh(2, false, false, true);
500:     try {
501:       const solo = member(f.peers, 0);
502:       const self = member(f.roster, 0);
503:       expect(solo.freezeRoster()).toEqual([self]);
504:       expect(() => solo.updatePreGameRoster(f.roster)).toThrow('frozen');
505:       expect(() => solo.connect(member(f.roster, 1))).toThrow('Unknown mesh peer');
506:     } finally {
507:       f.dispose();
508:     }
509:   });
510: 
511:   test('admits certified destination and catch-up devices after freeze, then retires catch-up', async () => {
512:     const f = mesh(3, false, false, true);
513:     try {
514:       const [a, b, c] = f.roster;
515:       if (!a || !b || !c) throw new Error('Missing test identity');
516:       const first = { seq: 1, hash: 'a'.repeat(64) };
517:       const second = { seq: 2, hash: 'b'.repeat(64) };
518:       const initial = [a, b];
519:       member(f.peers, 0).updatePreGameRoster(initial);
520:       member(f.peers, 1).updatePreGameRoster(initial);
521:       for (const peer of f.peers) {
522:         peer.freezeRoster();
523:         peer.start();
524:       }
525:       await settle();
526:       expect(member(f.peers, 0).peers()).toContain(b);
527:       expect(() => member(f.peers, 0).updatePreGameRoster([a, b, c])).toThrow('frozen');
528: 
529:       const includingRetired = {
530:         head: first,
531:         activeDevices: [a, c],
532:         catchupDevices: [b],
533:       };
534:       for (const peer of f.peers) peer.updateCertifiedRoster(includingRetired);
535:       await settle();
536:       expect(f.peers.map((peer) => peer.peers().length)).toEqual([2, 2, 2]);
537: 
538:       for (const peer of [member(f.peers, 0), member(f.peers, 2)])
539:         peer.updateCertifiedRoster({ ...includingRetired, catchupDevices: [] });
540:       expect(member(f.peers, 0).roster()).toEqual([a, c].toSorted());
541:       expect(member(f.peers, 0).peers()).not.toContain(b);
542:       expect(() => member(f.peers, 0).connect(b)).toThrow('Unknown mesh peer');
543:       expect(() => member(f.peers, 0).updateCertifiedRoster(includingRetired)).toThrow(
544:         'Conflicting',
545:       );
546:       expect(() =>
547:         member(f.peers, 0).updateCertifiedRoster({
548:           head: first,
549:           activeDevices: [a, b],
550:           catchupDevices: [],
551:         }),
552:       ).toThrow('Conflicting');
553:       expect(() =>
554:         member(f.peers, 0).updateCertifiedRoster({ ...includingRetired, head: second }),
555:       ).not.toThrow();
556:       expect(member(f.peers, 0).roster()).toEqual([a, b, c].toSorted());
557:     } finally {
558:       f.dispose();
559:     }
560:   });
561: 
562:   test('rejects stale, malformed and over-capacity certified rosters without changing admission', () => {
563:     const f = mesh(7, false, false, true);
564:     try {
565:       const self = member(f.roster, 0);
566:       const peer = member(f.peers, 0);
567:       const head = { seq: 4, hash: 'c'.repeat(64) };
568:       const activeDevices = [self, member(f.roster, 1)];
569:       const update = { head, activeDevices, catchupDevices: [] };
570:       expect(() => peer.updateCertifiedRoster(update)).toThrow('not frozen');
571:       peer.freezeRoster();
572:       peer.updateCertifiedRoster(update);
573:       const admitted = peer.roster();
574:       expect(() =>
575:         peer.updateCertifiedRoster({
576:           head: { seq: 3, hash: 'd'.repeat(64) },
577:           activeDevices,
578:           catchupDevices: [],
579:         }),
580:       ).toThrow('Stale');
581:       expect(() =>
582:         peer.updateCertifiedRoster({
583:           head: { seq: 4, hash: 'd'.repeat(64) },
584:           activeDevices,
585:           catchupDevices: [],
586:         }),
587:       ).toThrow('Stale');
588:       expect(() =>
589:         peer.updateCertifiedRoster({ head, activeDevices: [self, self], catchupDevices: [] }),
590:       ).toThrow('Invalid');
591:       expect(() =>
592:         peer.updateCertifiedRoster({ head, activeDevices: f.roster, catchupDevices: [] }),
593:       ).toThrow('Invalid');
594:       expect(() =>
595:         peer.updateCertifiedRoster({
596:           head: { seq: 5, hash: 'bad' },
597:           activeDevices,
598:           catchupDevices: [],
599:         }),
600:       ).toThrow('Invalid');
601:       expect(peer.roster()).toEqual(admitted);
602:     } finally {
603:       f.dispose();
604:     }
605:   });
606: 
607:   test('a newer certified update from a link-down observer wins over the update closing that link', async () => {
608:     const f = mesh(2);
609:     try {
610:       const [a, b] = f.roster;
611:       if (!a || !b) throw new Error('Missing test identity');
612:       for (const peer of f.peers) {
613:         peer.freezeRoster();
614:         peer.start();
615:       }
616:       await settle();
617:       const local = member(f.peers, 0);
618:       local.updateCertifiedRoster({
619:         head: { seq: 1, hash: 'a'.repeat(64) },
620:         activeDevices: [a, b],
621:         catchupDevices: [],
622:       });
623:       local.onPeerChange((_peer, online) => {
624:         if (!online)
625:           local.updateCertifiedRoster({
626:             head: { seq: 3, hash: 'c'.repeat(64) },
627:             activeDevices: [a, b],
628:             catchupDevices: [],
629:           });
630:       });
631:       expect(() =>
632:         local.updateCertifiedRoster({
633:           head: { seq: 2, hash: 'b'.repeat(64) },
634:           activeDevices: [a],
635:           catchupDevices: [],
636:         }),
637:       ).not.toThrow();
638:       expect(local.roster()).toEqual([a, b].toSorted());
639:       expect(() =>
640:         local.updateCertifiedRoster({
641:           head: { seq: 2, hash: 'b'.repeat(64) },
642:           activeDevices: [a],
643:           catchupDevices: [],
644:         }),
645:       ).toThrow('Stale');
646:     } finally {
647:       f.dispose();
648:     }
649:   });
650: 
651:   test('grows a one-peer lobby, preserves links, retires removed peers and freezes the roster', async () => {
652:     const f = mesh(3, false, false, true);
653:     try {
654:       const [a, b, c] = f.roster;
655:       if (!a || !b || !c) throw new Error('Missing test identity');
656:       expect(f.peers.map((peer) => peer.roster())).toEqual([[a], [b], [c]]);
657:       for (const peer of f.peers) peer.start();
658:       const initiator = a < b ? 0 : 1;
659:       const responder = 1 - initiator;
660:       const initiatorPeer = member(f.peers, initiator);
661:       const responderPeer = member(f.peers, responder);
662:       const initiatorId = member(f.roster, initiator);
663:       const responderId = member(f.roster, responder);
664:       const adapter = member(f.adapters, initiator);
665:       const originalSend = adapter.send.bind(adapter);
666:       const sent: SignedSignalEnvelope[] = [];
667:       adapter.send = async (to, envelope) => {
668:         sent.push(envelope);
669:         await originalSend(to, envelope);
670:       };
671:       responderPeer.updatePreGameRoster([a, b]);
672:       initiatorPeer.updatePreGameRoster([a, b]);
673:       await settle();
674:       expect([initiatorPeer.peers(), responderPeer.peers()]).toEqual([
675:         [responderId],
676:         [initiatorId],
677:       ]);
678:       const firstLink = f.fabric.connection(a, b);
679:       const oldOffer = sent.find(
680:         (item) =>
681:           item.body.blob.kind === 'description' && item.body.blob.description.type === 'offer',
682:       );
683:       if (!oldOffer) throw new Error('Missing first signed offer');
684: 
685:       initiatorPeer.updatePreGameRoster([initiatorId]);
686:       responderPeer.updatePreGameRoster([responderId]);
687:       expect(initiatorPeer.peers()).toEqual([]);
688:       expect(responderPeer.peers()).toEqual([]);
689:       expect(() => initiatorPeer.connect(responderId)).toThrow('Unknown mesh peer');
690:       responderPeer.updatePreGameRoster([a, b]);
691:       initiatorPeer.updatePreGameRoster([a, b]);
692:       await settle();
693:       const resumedLink = f.fabric.connection(a, b);
694:       expect(resumedLink).not.toBe(firstLink);
695:       await originalSend(responderId, oldOffer);
696:       await settle();
697:       expect(f.fabric.connection(a, b)).toBe(resumedLink);
698:       await settle();
699:       expect(initiatorPeer.peers()).toEqual([responderId]);
700:       expect(responderPeer.peers()).toEqual([initiatorId]);
701: 
702:       member(f.peers, 2).updatePreGameRoster([a, b, c]);
703:       member(f.peers, 0).updatePreGameRoster([a, b, c]);
704:       member(f.peers, 1).updatePreGameRoster([a, b, c]);
705:       await settle();
706:       expect(f.peers.map((peer) => peer.peers().length)).toEqual([2, 2, 2]);
707:       expect(f.fabric.connection(a, b)).not.toBe(firstLink);
708:       const retained = f.fabric.connection(a, b);
709:       member(f.peers, 0).updatePreGameRoster([a, b]);
710:       member(f.peers, 1).updatePreGameRoster([a, b]);
711:       member(f.peers, 2).updatePreGameRoster([c]);
712:       expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 1, 0]);
713:       expect(f.fabric.connection(a, b)).toBe(retained);
714:       const selected = member(f.peers, 0).roster();
715:       Reflect.set(selected, 0, 'corrupted');
716:       expect(member(f.peers, 0).roster()).toEqual([a, b].toSorted());
717:       expect(() => member(f.peers, 0).updatePreGameRoster([a, a])).toThrow('Invalid');
718:       expect(() => member(f.peers, 0).updatePreGameRoster([b])).toThrow('Invalid');
719:       expect(member(f.peers, 0).peers()).toEqual([b]);
720:       expect(member(f.peers, 0).freezeRoster()).toEqual([a, b].toSorted());
721:       expect(() => member(f.peers, 0).updatePreGameRoster([a, b, c])).toThrow('frozen');
722:       member(f.peers, 0).disconnect(b);
723:       member(f.peers, 0).connect(b);
724:       await settle();
725:       expect(member(f.peers, 0).roster()).toEqual([a, b].toSorted());
726:     } finally {
727:       f.dispose();
728:     }
729:   });
730: 
731:   test('signaling loss alone leaves an authenticated game channel in place', async () => {
732:     const f = mesh(2);
733:     try {
734:       for (const peer of f.peers) peer.start();
735:       await settle();
736:       const received: Uint8Array[] = [];
737:       member(f.peers, 1).onMessage((_from, bytes) => received.push(bytes));
738:       member(f.adapters, 0).close();
739:       expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 1]);
740:       member(f.peers, 0).send(member(f.roster, 1), new Uint8Array([9]));
741:       await settle();
742:       expect(received).toEqual([new Uint8Array([9])]);
743:     } finally {
744:       f.dispose();
745:     }
746:   });
747: 
748:   test('four peers form six links and deliver only authenticated Transport bytes', async () => {
749:     const f = mesh(4);
750:     try {
751:       const changes: [PeerId, boolean][] = [];
752:       const received: [PeerId, Uint8Array][] = [];
753:       member(f.peers, 0).onPeerChange((peer, online) => changes.push([peer, online]));
754:       member(f.peers, 3).onMessage((from, bytes) => received.push([from, bytes]));
755:       expect(() => member(f.peers, 0).send(member(f.roster, 3), new Uint8Array([1]))).toThrow(
756:         'Peer is not authenticated',
757:       );
758:       for (let left = 0; left < 4; left++)
759:         for (let right = left + 1; right < 4; right++) {
760:           member(f.peers, left).connect(member(f.roster, right));
761:           // oxlint-disable-next-line no-await-in-loop -- each pair authenticates before the next is opened.
762:           await settle();
763:         }
764:       expect(f.peers.map((peer) => peer.peers().length)).toEqual([3, 3, 3, 3]);
765:       expect(changes).toHaveLength(3);
766:       member(f.peers, 0).send(member(f.roster, 3), new Uint8Array([7, 8]));
767:       await settle();
768:       expect(received).toEqual([[f.roster[0], new Uint8Array([7, 8])]]);
769:     } finally {
770:       f.dispose();
771:     }
772:   });
773: 
774:   test('manual disconnect emits one down event and blocks stale replay', async () => {
775:     const f = mesh(2);
776:     try {
777:       const events: boolean[] = [];
778:       member(f.peers, 0).onPeerChange((_peer, online) => events.push(online));
779:       member(f.peers, 0).connect(member(f.roster, 1));
780:       await settle();
781:       expect(events).toEqual([true]);
782:       member(f.peers, 0).disconnect(member(f.roster, 1));
783:       expect(events).toEqual([true, false]);
784:       expect(member(f.peers, 0).peers()).toEqual([]);
785:       expect(() => member(f.peers, 0).send(member(f.roster, 1), new Uint8Array([1]))).toThrow(
786:         'Peer is not authenticated',
787:       );
788:       f.clock.advanceBy(5_000);
789:       expect(events).toEqual([true, false]);
790:     } finally {
791:       f.dispose();
792:     }
793:   });
794: 
795:   test('canonical initiator reconnects a lost pair once', async () => {
796:     const f = mesh(2);
797:     try {
798:       const events: boolean[] = [];
799:       member(f.peers, 0).onPeerChange((_peer, online) => events.push(online));
800:       for (const peer of f.peers) peer.start();
801:       await settle();
802:       expect(events).toEqual([true]);
803:       expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 1]);
804: 
805:       f.fabric.close(member(f.roster, 0), member(f.roster, 1));
806:       await settle();
807:       expect(events).toEqual([true, false]);
808:       f.clock.advanceBy(250);
809:       await settle();
810:       expect(events).toEqual([true, false, true]);
811:       expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 1]);
812:     } finally {
813:       f.dispose();
814:     }
815:   });
816: 
817:   test.each([false, true])(
818:     'a fresh attempt replaces a stale unanswered offer with descending IDs=%s',
819:     async (descendingIds) => {
820:       const f = mesh(2, descendingIds);
821:       try {
822:         const initiator = member(f.roster, 0) < member(f.roster, 1) ? 0 : 1;
823:         const responder = 1 - initiator;
824:         let firstAttempt: string | null = null;
825:         f.signaling.setDrop((_from, _to, envelope) => {
826:           if (
827:             envelope.body.blob.kind === 'description' &&
828:             envelope.body.blob.description.type === 'offer'
829:           )
830:             firstAttempt ??= envelope.body.attemptId;
831:           return (
832:             envelope.body.blob.kind === 'description' &&
833:             envelope.body.blob.description.type === 'answer' &&
834:             envelope.body.attemptId === firstAttempt
835:           );
836:         });
837:         for (const peer of f.peers) peer.start();
838:         await settle();
839:         expect(f.peers.map((peer) => peer.peers().length)).toEqual([0, 0]);
840:         f.fabric.failOneSide(member(f.roster, initiator), member(f.roster, responder));
841:         f.clock.advanceBy(250);
842:         await settle();
843:         expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 1]);
844:       } finally {
845:         f.dispose();
846:       }
847:     },
848:   );
849: 
850:   test('a signed offer replay from an unseen old session cannot retire an authenticated primary', async () => {
851:     const f = mesh(2);
852:     try {
853:       const initiator = member(f.roster, 0) < member(f.roster, 1) ? 0 : 1;
854:       const responder = 1 - initiator;
855:       const oldOffers: SignedSignalEnvelope[] = [];
856:       const throwaway = new WebRtcTransport({
857:         self: member(f.roster, initiator),
858:         secretKey: member(f.identities, initiator).secretKey,
859:         roster: f.roster,
860:         scope: 'test-lobby',
861:         clock: f.clock,
862:         adapter: {
863:           send: async (_to, envelope) => {
864:             oldOffers.push(envelope);
865:           },
866:           onSignal: () => () => undefined,
867:           close: () => undefined,
868:         },
869:         rtcFactory: (peer) => f.fabric.create(member(f.roster, initiator), peer),
870:         randomBytes: (length) => new Uint8Array(length).fill(47),
871:       });
872:       throwaway.connect(member(f.roster, responder));
873:       await settle();
874:       throwaway.dispose();
875:       const replay = oldOffers.find(
876:         (offer) =>
877:           offer.body.blob.kind === 'description' && offer.body.blob.description.type === 'offer',
878:       );
879:       if (!replay) throw new Error('Missing old signed offer');
880:       const events: boolean[] = [];
881:       const delivered: Uint8Array[] = [];
882:       member(f.peers, responder).onPeerChange((_peer, online) => events.push(online));
883:       member(f.peers, responder).onMessage((_peer, bytes) => delivered.push(bytes));
884:       for (const peer of f.peers) peer.start();
885:       await settle();
886:       expect(events).toEqual([true]);
887:       await member(f.adapters, initiator).send(member(f.roster, responder), replay);
888:       await settle();
889:       expect(events).toEqual([true]);
890:       expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 1]);
891:       member(f.peers, initiator).send(member(f.roster, responder), new Uint8Array([7]));
892:       await settle();
893:       expect(delivered).toEqual([new Uint8Array([7])]);
894:       for (let tick = 0; tick < 15; tick++) {
895:         f.clock.advanceBy(2_000);
896:         // oxlint-disable-next-line no-await-in-loop -- deliver the next fake heartbeat before advancing virtual time.
897:         await settle();
898:       }
899:       expect(events).toEqual([true]);
900:       expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 1]);
901:     } finally {
902:       f.dispose();
903:     }
904:   });
905: 
906:   test('the newest same-session offer inside the replacement interval is deferred, then applied', async () => {
907:     const f = mesh(2);
908:     try {
909:       const initiator = member(f.roster, 0) < member(f.roster, 1) ? 0 : 1;
910:       const responder = 1 - initiator;
911:       for (const peer of f.peers) peer.start();
912:       await settle();
913:       const makeOffer = (seq: number) =>
914:         signSignalEnvelope(
915:           {
916:             version: 1,
917:             scope: 'test-lobby',
918:             from: member(f.roster, initiator),
919:             to: member(f.roster, responder),
920:             attemptId: toBase64Url(new Uint8Array(16).fill(70 + seq)),
921:             sessionId: toBase64Url(new Uint8Array(16).fill(70)),
922:             attemptSeq: seq,
923:             blob: {
924:               kind: 'description',
925:               generation: 1,
926:               revision: 1,
927:               description: { type: 'offer', sdp: sdp(member(f.roster, initiator), 900 + seq) },
928:             },
929:           },
930:           member(f.identities, initiator).secretKey,
931:         );
932:       await member(f.adapters, initiator).send(member(f.roster, responder), makeOffer(1));
933:       await settle();
934:       const first = f.fabric.connection(member(f.roster, responder), member(f.roster, initiator));
935:       f.clock.advanceBy(100);
936:       await member(f.adapters, initiator).send(member(f.roster, responder), makeOffer(2));
937:       f.clock.advanceBy(20);
938:       await member(f.adapters, initiator).send(member(f.roster, responder), makeOffer(3));
939:       await settle();
940:       expect(f.fabric.connection(member(f.roster, responder), member(f.roster, initiator))).toBe(
941:         first,
942:       );
943:       f.clock.advanceBy(130);
944:       await settle();
945:       const applied = f.fabric.connection(member(f.roster, responder), member(f.roster, initiator));
946:       expect(applied).not.toBe(first);
947:       expect(applied?.currentRemoteDescription?.sdp).toContain('a=x-attempt:903');
948:       expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 1]);
949:     } finally {
950:       f.dispose();
951:     }
952:   });
953: 
954:   test('wrong socket hint, lower sequence and retired attempt cannot replace a live link', async () => {
955:     const f = mesh(2);
956:     try {
957:       const initiator = member(f.roster, 0) < member(f.roster, 1) ? 0 : 1;
958:       const responder = 1 - initiator;
959:       const offers: SignedSignalEnvelope[] = [];
960:       f.signaling.setDrop((_from, _to, envelope) => {
961:         if (
962:           envelope.body.blob.kind === 'description' &&
963:           envelope.body.blob.description.type === 'offer'
964:         )
965:           offers.push(envelope);
966:         return false;
967:       });
968:       for (const peer of f.peers) peer.start();
969:       await settle();
970:       const first = offers[0];
971:       if (!first) throw new Error('Missing first offer');
972:       f.fabric.close(member(f.roster, initiator), member(f.roster, responder));
973:       f.clock.advanceBy(250);
974:       await settle();
975:       const current = f.fabric.connection(member(f.roster, responder), member(f.roster, initiator));
976:       const sign = (body: typeof first.body) =>
977:         signSignalEnvelope(body, member(f.identities, initiator).secretKey);
978:       const wrongHint = sign({
979:         ...first.body,
980:         sessionId: toBase64Url(new Uint8Array(16).fill(90)),
981:         attemptId: toBase64Url(new Uint8Array(16).fill(91)),
982:         attemptSeq: 1,
983:       });
984:       await member(f.adapters, responder).send(member(f.roster, responder), wrongHint);
985:       const lowerSeq = sign({ ...first.body, attemptId: toBase64Url(new Uint8Array(16).fill(92)) });
986:       await member(f.adapters, initiator).send(member(f.roster, responder), lowerSeq);
987:       const retiredId = sign({ ...first.body, attemptSeq: 3 });
988:       await member(f.adapters, initiator).send(member(f.roster, responder), retiredId);
989:       await settle();
990:       expect(f.fabric.connection(member(f.roster, responder), member(f.roster, initiator))).toBe(
991:         current,
992:       );
993:       expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 1]);
994:     } finally {
995:       f.dispose();
996:     }
997:   });
998: 
999:   test('one-sided connection failure replaces a still-authenticated remote link', async () => {
1000:     const f = mesh(2);
1001:     try {
1002:       const initiator = member(f.roster, 0) < member(f.roster, 1) ? 0 : 1;
1003:       const responder = 1 - initiator;
1004:       const left: boolean[] = [];
1005:       const right: boolean[] = [];
1006:       member(f.peers, initiator).onPeerChange((_peer, online) => left.push(online));
1007:       member(f.peers, responder).onPeerChange((_peer, online) => right.push(online));
1008:       for (const peer of f.peers) peer.start();
1009:       await settle();
1010:       expect(left).toEqual([true]);
1011:       expect(right).toEqual([true]);
1012:       f.fabric.failOneSide(member(f.roster, initiator), member(f.roster, responder));
1013:       expect(left).toEqual([true, false]);
1014:       expect(right).toEqual([true]);
1015:       f.clock.advanceBy(250);
1016:       await settle();
1017:       expect(left).toEqual([true, false, true]);
1018:       expect(right).toEqual([true, false, true]);
1019:     } finally {
1020:       f.dispose();
1021:     }
1022:   });
1023: 
1024:   test('disconnect from the replacement down observer cannot resurrect its pending link', async () => {
1025:     const f = mesh(2);
1026:     try {
1027:       const initiator = member(f.roster, 0) < member(f.roster, 1) ? 0 : 1;
1028:       const responder = 1 - initiator;
1029:       const events: boolean[] = [];
1030:       member(f.peers, responder).onPeerChange((peer, online) => {
1031:         events.push(online);
1032:         if (!online) member(f.peers, responder).disconnect(peer);
1033:       });
1034:       for (const peer of f.peers) peer.start();
1035:       await settle();
1036:       expect(events).toEqual([true]);
1037:       f.fabric.failOneSide(member(f.roster, initiator), member(f.roster, responder));
1038:       f.clock.advanceBy(250);
1039:       await settle();
1040:       expect(events).toEqual([true, false]);
1041:       expect(member(f.peers, responder).peers()).toEqual([]);
1042:       expect(() =>
1043:         member(f.peers, responder).send(member(f.roster, initiator), new Uint8Array([1])),
1044:       ).toThrow('Peer is not authenticated');
1045:     } finally {
1046:       f.dispose();
1047:     }
1048:   });
1049: 
1050:   test('responder-only failure is noticed by initiator heartbeat and reconnects', async () => {
1051:     const f = mesh(2);
1052:     try {
1053:       const initiator = member(f.roster, 0) < member(f.roster, 1) ? 0 : 1;
1054:       const responder = 1 - initiator;
1055:       const events: boolean[] = [];
1056:       member(f.peers, initiator).onPeerChange((_peer, online) => events.push(online));
1057:       for (const peer of f.peers) peer.start();
1058:       await settle();
1059:       expect(events).toEqual([true]);
1060:       f.fabric.failOneSide(member(f.roster, responder), member(f.roster, initiator));
1061:       for (let tick = 0; tick < 4 && events.length === 1; tick++) {
1062:         f.clock.advanceBy(2_000);
1063:         // oxlint-disable-next-line no-await-in-loop -- model one heartbeat period at a time.
1064:         await settle();
1065:       }
1066:       expect(events).toEqual([true, false]);
1067:       f.clock.advanceBy(250);
1068:       await settle();
1069:       expect(events).toEqual([true, false, true]);
1070:     } finally {
1071:       f.dispose();
1072:     }
1073:   });
1074: 
1075:   test('verified candidates before their offer use one bounded early queue', async () => {
1076:     const f = mesh(2);
1077:     try {
1078:       const initiator = member(f.roster, 0) < member(f.roster, 1) ? 0 : 1;
1079:       const responder = 1 - initiator;
1080:       const offers: SignedSignalEnvelope[] = [];
1081:       f.signaling.setDrop((_from, _to, envelope) => {
1082:         if (
1083:           envelope.body.blob.kind === 'description' &&
1084:           envelope.body.blob.description.type === 'offer'
1085:         ) {
1086:           offers.push(envelope);
1087:           return true;
1088:         }
1089:         return false;
1090:       });
1091:       member(f.peers, initiator).connect(member(f.roster, responder));
1092:       await settle();
1093:       const offer = offers[0];
1094:       if (!offer) throw new Error('Missing signed offer');
1095:       const body = offer.body;
1096:       for (let index = 0; index < 12; index++) {
1097:         const candidate = signSignalEnvelope(
1098:           {
1099:             ...body,
1100:             blob: {
1101:               kind: 'candidate',
1102:               generation: body.blob.generation,
1103:               revision: 1,
1104:               candidate: { candidate: `candidate:${index}`, sdpMid: 'data' },
1105:             },
1106:           },
1107:           member(f.identities, initiator).secretKey,
1108:         );
1109:         // oxlint-disable-next-line no-await-in-loop -- preserve candidate arrival order.
1110:         await member(f.adapters, initiator).send(member(f.roster, responder), candidate);
1111:       }
1112:       f.signaling.setDrop(null);
1113:       await member(f.adapters, initiator).send(member(f.roster, responder), offer);
1114:       await settle();
1115:       expect(
1116:         f.fabric.connection(member(f.roster, responder), member(f.roster, initiator))?.candidates,
1117:       ).toHaveLength(8);
1118:       expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 1]);
1119:     } finally {
1120:       f.dispose();
1121:     }
1122:   });
1123: 
1124:   test('an unopened default attempt times out and retries without relying on peer clocks', async () => {
1125:     const f = mesh(2);
1126:     try {
1127:       let blocked = true;
1128:       f.signaling.setDrop(
1129:         (_from, _to, envelope) =>
1130:           blocked &&
1131:           envelope.body.blob.kind === 'description' &&
1132:           envelope.body.blob.description.type === 'offer',
1133:       );
1134:       for (const peer of f.peers) peer.start();
1135:       await settle();
1136:       expect(f.peers.map((peer) => peer.peers().length)).toEqual([0, 0]);
1137:       blocked = false;
1138:       f.clock.advanceBy(30_000);
1139:       f.clock.advanceBy(250);
1140:       await settle();
1141:       expect(f.peers.map((peer) => peer.peers().length)).toEqual([1, 1]);
1142:     } finally {
1143:       f.dispose();
1144:     }
1145:   });
1146: 
1147:   test('manual deadline remains finite and symmetric for initiator and answerer', async () => {
1148:     const f = mesh(2, false, true);
1149:     try {
1150:       const reasons: string[] = [];
1151:       for (const peer of f.peers) peer.onDiagnostic((_remote, reason) => reasons.push(reason));
1152:       f.signaling.setDrop(
1153:         (_from, _to, envelope) =>
1154:           envelope.body.blob.kind === 'description' &&
1155:           envelope.body.blob.description.type === 'answer',
1156:       );
1157:       for (const peer of f.peers) peer.start();
1158:       await settle();
1159:       f.clock.advanceBy(30_000);
1160:       expect(reasons).toEqual([]);
1161:       f.clock.advanceBy(270_000);
1162:       expect(reasons).toEqual(['attempt-timeout', 'attempt-timeout']);
1163:     } finally {
1164:       f.dispose();
1165:     }
1166:   });
1167: 
1168:   test('two-sided fingerprint substitution reports a security failure without redial', async () => {
1169:     const f = mesh(2);
1170:     try {
1171:       f.fabric.tamperRemoteFingerprint = true;
1172:       const diagnostics: { reason: string; security: boolean }[] = [];
1173:       for (const peer of f.peers)
1174:         peer.onDiagnostic((_remote, reason, security) => diagnostics.push({ reason, security }));
1175:       for (const peer of f.peers) peer.start();
1176:       await settle();
1177:       expect(diagnostics).toContainEqual({ reason: 'hello-binding', security: true });
1178:       expect(f.peers.map((peer) => peer.peers().length)).toEqual([0, 0]);
1179:       const count = diagnostics.length;
1180:       f.clock.advanceBy(10_000);
1181:       await settle();
1182:       expect(diagnostics).toHaveLength(count);
1183:     } finally {
1184:       f.dispose();
1185:     }
1186:   });
1187: 
1188:   test('a signaling adapter cannot swap DTLS fingerprints inside a signed offer', async () => {
1189:     const f = mesh(2, false, false, false, false, true);
1190:     try {
1191:       for (const peer of f.peers) peer.start();
1192:       await settle();
1193:       expect(f.tamperedDescriptions()).toBeGreaterThan(0);
1194:       expect(f.peers.map((peer) => peer.peers().length)).toEqual([0, 0]);
1195:     } finally {
1196:       f.dispose();
1197:     }
1198:   });
1199: });
```


## packages/protocol/src/transport.ts

```text
1: /** Ed25519 public key encoded as canonical, unpadded base64url. */
2: export type PeerId = string;
3: 
4: export type Unsubscribe = () => void;
5: 
6: /** Authenticated peer links. Packets may be lost while a link reconnects. */
7: export interface Transport {
8:   readonly self: PeerId;
9:   peers(): PeerId[];
10:   send(to: PeerId, message: Uint8Array): void;
11:   broadcast(message: Uint8Array): void;
12:   onMessage(listener: (from: PeerId, message: Uint8Array) => void): Unsubscribe;
13:   onPeerChange(listener: (peer: PeerId, online: boolean) => void): Unsubscribe;
14:   disconnect(peer: PeerId): void;
15: }
16: 
17: /** Injected monotonic clock; the protocol never depends on browser timers. */
18: export interface ProtocolClock {
19:   now(): number;
20:   setTimeout(callback: () => void, delayMs: number): unknown;
21:   clearTimeout(handle: unknown): void;
22: }
```
