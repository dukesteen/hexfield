# Transfer browser coordinator review

Read-only correctness and security review of the attached pinned source and tests. Tools are disabled. Return concrete findings with file/line, severity, failure trace and a minimal correction. Separate proved issues from assumptions. Do not request secrets, actual user data, or unrelated files.

The signed protocol v4 transfer core already has separate reviews. Review the new browser coordinator, public progress records, temporary signaling/WebRTC link, worker importer and exchange together. The UI is being connected separately; a missing route or button is not a finding for this packet. No backwards compatibility is required.

Check these requirements:

- The source explicitly chooses one authenticated destination and confirms its signed offer before authority changes or private disclosure. Public retry records cannot replace an approved statement or destination after reload.
- A staged destination has no game transport or voter. Private material is handled only in its worker. Promotion needs the exact verified certified activation and durable import, then importer shutdown before ordinary resume.
- Old and new devices cannot both vote. Source retirement does not prematurely kill the separate channel or prevent final public certificate export/status checks.
- Browser retry and reconnect are idempotent across partial delivery, lost final receipts, reload, and cancellation. The source only reports completion after a receipt naming a matching certified outcome. Failure is not cancellation.
- Storage failure, writer contention, lease loss, close, replaced links, repeated artifacts and out-of-order callbacks cannot leak workers/keys, silently replace authority, or permanently strand a completed handoff.
- Work and messages remain bounded; duplicate delivery cannot cause unbounded work or change the chosen transfer.

Focused tests pass for real worker import/restart/promotion, public record pins, query cleanup, link reconnect, delayed old-link callbacks, and lost-final-receipt retry. A native three-browser test is being prepared and is not yet evidence. Look for gaps the existing tests miss. Do not redesign consensus or treat a smaller test as proof of complete milestone acceptance.

The source intentionally retains historical durable credentials needed for certified return/recovery; every resumed signer verifies current authority. The existing strict-agreement rule requires all voters in two-/three-human games and permits a four-human quorum of three. Signaling carries opaque data and provides no authority.


## File: apps/web/src/session/online-transfer-browser.ts

1: import { toBase64Url } from '@cp2p/codec';
2: import type { Seat } from '@cp2p/engine';
3: import type { EscrowCeremonyStore, ProtocolClock, Unsubscribe } from '@cp2p/protocol';
4: import type { DisposableOnlineIdentity } from './online-credentials.js';
5: import {
6:   createTransferInvite,
7:   decodeTransferInvite,
8:   encodeTransferInvite,
9:   OnlineTransferLink,
10: } from './online-transfer-link.js';
11: import type { OnlineTransferInvite, OnlineTransferLinkOptions } from './online-transfer-link.js';
12: import type { OnlineTransferChannel } from './online-transfer-channel.js';
13: import { DestinationTransferExchange, SourceTransferExchange } from './online-transfer-exchange.js';
14: import type { TransferExchangePhase } from './online-transfer-exchange.js';
15: import {
16:   loadCurrentTransferInvite,
17:   OnlineTransferRecordStore,
18:   saveCurrentTransferInvite,
19: } from './online-transfer-records.js';
20: import type { OnlineTransferExchangeRecord } from './online-transfer-records.js';
21: import type { OnlineWorkerClient } from './online-worker-client.js';
22: 
23: export interface OnlineTransferBrowserSnapshot {
24:   readonly role: 'source' | 'destination';
25:   readonly invite: OnlineTransferInvite;
26:   readonly selfDevice: string;
27:   readonly candidates: readonly string[];
28:   readonly selectedDevice: string | null;
29:   readonly phase: TransferExchangePhase;
30:   readonly busy: boolean;
31:   readonly error: string | null;
32:   readonly promotedGameId: string | null;
33:   readonly closed: boolean;
34: }
35: 
36: interface BrowserOptions {
37:   readonly identity: DisposableOnlineIdentity;
38:   readonly store: EscrowCeremonyStore;
39:   readonly worker: OnlineWorkerClient;
40:   readonly clock: ProtocolClock;
41:   readonly network: Pick<
42:     OnlineTransferLinkOptions,
43:     'iceServers' | 'iceTransportPolicy' | 'rtcFactory' | 'socketFactory'
44:   >;
45: }
46: 
47: /** Owns the temporary transfer link. Its supplied identity and source game remain caller-owned. */
48: export class OnlineTransferBrowser {
49:   readonly #listeners = new Set<() => void>();
50:   readonly #records: OnlineTransferRecordStore;
51:   #record: OnlineTransferExchangeRecord | null;
52:   #snapshot: OnlineTransferBrowserSnapshot;
53:   #link: OnlineTransferLink | null = null;
54:   #channel: OnlineTransferChannel | null = null;
55:   #exchange: SourceTransferExchange | DestinationTransferExchange | null = null;
56:   #linkSelected = false;
57:   #linkGeneration = 0;
58:   #pending = 0;
59:   #closing: Promise<void> | null = null;
60: 
61:   private constructor(
62:     private readonly options: BrowserOptions,
63:     invite: OnlineTransferInvite,
64:     role: 'source' | 'destination',
65:     record: OnlineTransferExchangeRecord | null,
66:   ) {
67:     const pinnedInvite = decodeTransferInvite(encodeTransferInvite(invite));
68:     Object.freeze(pinnedInvite.body);
69:     Object.freeze(pinnedInvite);
70:     this.#records = new OnlineTransferRecordStore(
71:       options.store,
72:       options.identity.peerId,
73:       pinnedInvite,
74:       role,
75:     );
76:     this.#record = record;
77:     this.#snapshot = Object.freeze({
78:       role,
79:       invite: pinnedInvite,
80:       selfDevice: options.identity.peerId,
81:       candidates: Object.freeze([]),
82:       selectedDevice:
83:         role === 'source' ? (record?.destinationDevice ?? null) : invite.body.sourceDevice,
84:       phase: 'connecting',
85:       busy: false,
86:       error: null,
87:       promotedGameId: null,
88:       closed: false,
89:     });
90:   }
91: 
92:   static async openSource(
93:     options: BrowserOptions & {
94:       readonly gameId: string;
95:       readonly genesisDigest: string;
96:       readonly seat: Seat;
97:       readonly serverUrl: string;
98:     },
99:   ): Promise<OnlineTransferBrowser> {
100:     let invite = await loadCurrentTransferInvite(
101:       options.store,
102:       options.identity.peerId,
103:       options.gameId,
104:     );
105:     if (invite) {
106:       const records = new OnlineTransferRecordStore(
107:         options.store,
108:         options.identity.peerId,
109:         invite,
110:         'source',
111:       );
112:       if ((await records.load()).finished) invite = null;
113:     }
114:     if (!invite) {
115:       invite = createTransferInvite({
116:         identity: options.identity,
117:         gameId: options.gameId,
118:         genesisDigest: options.genesisDigest,
119:         seat: options.seat,
120:         serverUrl: options.serverUrl,
121:         attemptId: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
122:       });
123:       await saveCurrentTransferInvite(options.store, options.identity.peerId, invite);
124:     }
125:     if (invite.body.genesisDigest !== options.genesisDigest || invite.body.seat !== options.seat)
126:       throw new Error('Saved transfer invitation differs from this game and seat');
127:     const progress = await new OnlineTransferRecordStore(
128:       options.store,
129:       options.identity.peerId,
130:       invite,
131:       'source',
132:     ).load();
133:     const browser = new OnlineTransferBrowser(options, invite, 'source', progress.record);
134:     browser.#connect();
135:     return browser;
136:   }
137: 
138:   static async openDestination(
139:     options: BrowserOptions & { readonly invite: OnlineTransferInvite },
140:   ): Promise<OnlineTransferBrowser> {
141:     const records = new OnlineTransferRecordStore(
142:       options.store,
143:       options.identity.peerId,
144:       options.invite,
145:       'destination',
146:     );
147:     const progress = await records.load();
148:     const browser = new OnlineTransferBrowser(
149:       options,
150:       options.invite,
151:       'destination',
152:       progress.record,
153:     );
154:     if (!browser.#record) {
155:       browser.#record = browser.#emptyRecord(options.identity.peerId);
156:       await records.save(browser.#record);
157:     }
158:     try {
159:       browser.#connect();
160:     } catch (error) {
161:       await browser.close().catch(() => undefined);
162:       throw error;
163:     }
164:     return browser;
165:   }
166: 
167:   getSnapshot = (): OnlineTransferBrowserSnapshot => this.#snapshot;
168:   subscribe = (listener: () => void): Unsubscribe => {
169:     this.#listeners.add(listener);
170:     return () => this.#listeners.delete(listener);
171:   };
172: 
173:   selectDevice(peer: string): Promise<void> {
174:     return this.#perform(async () => {
175:       if (
176:         this.#snapshot.role !== 'source' ||
177:         this.#record ||
178:         !this.#link?.candidates().includes(peer)
179:       )
180:         throw new Error('Choose a connected destination for this transfer');
181:       const record = this.#emptyRecord(peer);
182:       await this.#records.save(record);
183:       this.#record = record;
184:       this.#update({ selectedDevice: peer });
185:       this.#selectKnownDestination();
186:     });
187:   }
188: 
189:   confirm(): Promise<void> {
190:     return this.#perform(async () => {
191:       if (!(this.#exchange instanceof SourceTransferExchange))
192:         throw new Error('Destination is not ready');
193:       await this.#exchange.confirm();
194:     });
195:   }
196: 
197:   cancel(): Promise<void> {
198:     return this.#perform(async () => {
199:       if (this.#snapshot.role !== 'source') {
200:         // The destination cannot unilaterally cancel a certified handoff.
201:         await this.close();
202:         return;
203:       }
204:       if (this.#exchange instanceof SourceTransferExchange) await this.#exchange.cancel();
205:       else if (!this.#record?.approved) this.#update({ phase: 'cancelled' });
206:       else throw new Error('Reconnect before cancelling the approved transfer');
207:       if (this.#snapshot.phase === 'cancelled') this.#link?.close();
208:     });
209:   }
210: 
211:   retry(): Promise<void> {
212:     return this.#perform(async () => {
213:       this.#update({ error: null });
214:       if (!this.#channel) this.#connect();
215:       else await this.#exchange?.retry();
216:     });
217:   }
218: 
219:   close(): Promise<void> {
220:     if (this.#closing) return this.#closing;
221:     this.#update({ closed: true });
222:     this.#linkGeneration += 1;
223:     this.#link?.close();
224:     this.#channel = null;
225:     this.#exchange?.close();
226:     this.#closing =
227:       this.#snapshot.role === 'destination' ? this.options.worker.shutdown() : Promise.resolve();
228:     this.#listeners.clear();
229:     return this.#closing;
230:   }
231: 
232:   #emptyRecord(destinationDevice: string): OnlineTransferExchangeRecord {
233:     const { body } = this.#snapshot.invite;
234:     return {
235:       protocol: 'online-transfer-exchange-v1',
236:       role: this.#snapshot.role,
237:       attemptId: body.attemptId,
238:       gameId: body.gameId,
239:       genesisDigest: body.genesisDigest,
240:       sourceDevice: body.sourceDevice,
241:       destinationDevice,
242:       seat: body.seat,
243:       offer: null,
244:       approved: null,
245:       authorization: null,
246:     };
247:   }
248: 
249:   #connect(): void {
250:     if (this.#snapshot.closed) throw new Error('Transfer is closed');
251:     const generation = ++this.#linkGeneration;
252:     const current = () => !this.#snapshot.closed && generation === this.#linkGeneration;
253:     this.#link?.close();
254:     this.#channel = null;
255:     this.#linkSelected = false;
256:     const options: OnlineTransferLinkOptions = {
257:       ...this.options.network,
258:       identity: this.options.identity,
259:       clock: this.options.clock,
260:       invite: this.#snapshot.invite,
261:       onChannel: (channel) => {
262:         if (!current()) return;
263:         this.#channel = channel;
264:         void this.#perform(async () => {
265:           this.#ensureExchange();
266:           if (this.#exchange instanceof SourceTransferExchange) await this.#exchange.start();
267:         }).catch(() => undefined);
268:       },
269:       onArtifact: (artifact) => {
270:         if (!current()) return;
271:         void this.#perform(async () => {
272:           this.#ensureExchange();
273:           await this.#exchange?.receive(artifact);
274:         }).catch(() => undefined);
275:       },
276:       onError: (error) => {
277:         if (!current()) return;
278:         this.#channel = null;
279:         this.#update({ error: error.message });
280:       },
281:     };
282:     this.#link =
283:       this.#snapshot.role === 'source'
284:         ? OnlineTransferLink.openSource(options)
285:         : OnlineTransferLink.openDestination(options);
286:     if (this.#snapshot.role === 'source')
287:       this.#link.onCandidates((peers) => {
288:         if (!current()) return;
289:         this.#update({ candidates: peers });
290:         this.#selectKnownDestination();
291:       });
292:   }
293: 
294:   #selectKnownDestination(): void {
295:     const peer = this.#record?.destinationDevice;
296:     if (!this.#linkSelected && peer && this.#link?.candidates().includes(peer)) {
297:       this.#link.selectDestination(peer);
298:       this.#linkSelected = true;
299:     }
300:   }
301: 
302:   #ensureExchange(): void {
303:     if (this.#exchange) return;
304:     const record = this.#record;
305:     if (!record) throw new Error('Transfer destination has not been selected');
306:     const common = {
307:       worker: this.options.worker,
308:       channel: {
309:         send: async (artifact: Parameters<OnlineTransferChannel['send']>[0]) => {
310:           if (!this.#channel) throw new Error('Transfer connection is unavailable');
311:           await this.#channel.send(artifact);
312:         },
313:       },
314:       savePublicRecord: async (next: OnlineTransferExchangeRecord) => {
315:         await this.#records.save(next);
316:         this.#record = next;
317:       },
318:       onChange: (phase: TransferExchangePhase) => this.#update({ phase }),
319:     };
320:     this.#exchange =
321:       record.role === 'source'
322:         ? new SourceTransferExchange({ ...common, record: { ...record, role: 'source' } })
323:         : new DestinationTransferExchange({
324:             ...common,
325:             record: { ...record, role: 'destination' },
326:             expected: { gameId: record.gameId, genesisDigest: record.genesisDigest },
327:             shutdownWorker: () => this.options.worker.shutdown(),
328:             onPromoted: (gameId) => {
329:               this.#update({ promotedGameId: gameId });
330:             },
331:           });
332:   }
333: 
334:   async #perform(task: () => Promise<void>): Promise<void> {
335:     if (this.#snapshot.closed) throw new Error('Transfer is closed');
336:     this.#pending += 1;
337:     this.#update({ busy: true, error: null });
338:     try {
339:       await task();
340:       if (this.#snapshot.phase === 'activated' || this.#snapshot.phase === 'cancelled')
341:         await this.#records.finish();
342:     } catch (error) {
343:       this.#update({ error: error instanceof Error ? error.message : 'Transfer failed' });
344:       throw error;
345:     } finally {
346:       this.#pending -= 1;
347:       this.#update({ busy: this.#pending > 0 });
348:     }
349:   }
350: 
351:   #update(patch: Partial<OnlineTransferBrowserSnapshot>): void {
352:     if (this.#snapshot.closed) return;
353:     this.#snapshot = Object.freeze({
354:       ...this.#snapshot,
355:       ...patch,
356:       ...(patch.candidates ? { candidates: Object.freeze([...patch.candidates]) } : {}),
357:     });
358:     for (const listener of this.#listeners) {
359:       try {
360:         listener();
361:       } catch {
362:         /* A view cannot interrupt transfer work. */
363:       }
364:     }
365:   }
366: }

## File: apps/web/src/session/online-transfer-exchange.ts

1: import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
2: import type { Result } from '@cp2p/engine';
3: import { transferChangeSchema, transferPrivateEnvelopeSchema } from '@cp2p/protocol';
4: import type { TransferPrivateEnvelope } from '@cp2p/protocol';
5: import * as v from 'valibot';
6: import type { OnlineTransferArtifact } from './online-transfer-channel.js';
7: import type { ExpectedOnlineTransferGame } from './online-transfer-bootstrap.js';
8: import type { OnlineTransferExchangeRecord } from './online-transfer-records.js';
9: import type { OnlineTransferDestinationSnapshot } from './online-transfer-destination.js';
10: import type {
11:   OnlineWorkerHead,
12:   OnlineWorkerReplyByKind,
13:   OnlineWorkerRequestBody,
14: } from './online-worker-messages.js';
15: 
16: const MAX_QUEUED_ARTIFACTS = 2;
17: const MAX_QUEUED_BYTES = 17 * 1024 * 1024;
18: 
19: export interface TransferExchangeWorker {
20:   request<K extends OnlineWorkerRequestBody['kind']>(
21:     body: Extract<OnlineWorkerRequestBody, { kind: K }>,
22:   ): Promise<Result<OnlineWorkerReplyByKind[K]>>;
23: }
24: 
25: export interface TransferExchangeChannel {
26:   send(artifact: OnlineTransferArtifact): Promise<void>;
27: }
28: 
29: /** Public retry cursor. The destination's keys and import remain in its separate worker store. */
30: export type { OnlineTransferExchangeRecord } from './online-transfer-records.js';
31: 
32: interface CommonOptions {
33:   readonly worker: TransferExchangeWorker;
34:   readonly channel: TransferExchangeChannel;
35:   readonly record: OnlineTransferExchangeRecord;
36:   /** Must durably replace the public cursor before the dependent packet is sent. */
37:   readonly savePublicRecord: (record: OnlineTransferExchangeRecord) => Promise<void>;
38:   readonly onChange?: (phase: TransferExchangePhase) => void;
39: }
40: 
41: export type TransferExchangePhase =
42:   | 'connecting'
43:   | 'awaiting-confirmation'
44:   | 'awaiting-authorization'
45:   | 'awaiting-private'
46:   | 'awaiting-readiness'
47:   | 'awaiting-certification'
48:   | 'awaiting-receipt'
49:   | 'activated'
50:   | 'cancelled';
51: 
52: const refSchema = v.strictObject({
53:   seq: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
54:   hash: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
55: });
56: const receiptSchema = v.strictObject({
57:   protocol: v.literal('online-transfer-received-v1'),
58:   destinationDevice: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/)),
59:   authorization: refSchema,
60:   outcome: v.picklist(['activated', 'cancelled']),
61:   entry: refSchema,
62: });
63: 
64: function value<T>(result: Result<T>): T {
65:   if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
66:   return result.value;
67: }
68: 
69: function equal(left: unknown, right: unknown): boolean {
70:   const first = canonicalEncode(left);
71:   const second = canonicalEncode(right);
72:   try {
73:     return first.length === second.length && first.every((byte, index) => byte === second[index]);
74:   } finally {
75:     first.fill(0);
76:     second.fill(0);
77:   }
78: }
79: 
80: function sameRef(left: OnlineWorkerHead, right: OnlineWorkerHead): boolean {
81:   return left.seq === right.seq && left.hash === right.hash;
82: }
83: 
84: function detached<T>(publicValue: T): T {
85:   // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Public canonical evidence is detached before retention or callback delivery.
86:   return canonicalDecode(canonicalEncode(publicValue)) as T;
87: }
88: 
89: function parsedChange(bytes: Uint8Array) {
90:   if (bytes.length > 64 * 1024) throw new RangeError('Transfer evidence is oversized');
91:   return v.parse(transferChangeSchema, canonicalDecode(bytes));
92: }
93: 
94: abstract class Exchange {
95:   protected record: OnlineTransferExchangeRecord;
96:   protected phase: TransferExchangePhase = 'connecting';
97:   protected closed = false;
98:   protected readonly options: CommonOptions;
99:   private queue: Promise<unknown> = Promise.resolve();
100:   private queuedArtifacts = 0;
101:   private queuedBytes = 0;
102: 
103:   protected constructor(options: CommonOptions, role: OnlineTransferExchangeRecord['role']) {
104:     if (options.record.role !== role || options.record.protocol !== 'online-transfer-exchange-v1')
105:       throw new TypeError('Transfer exchange record has the wrong role or version');
106:     this.options = options;
107:     this.record = detached(options.record);
108:   }
109: 
110:   snapshot(): {
111:     readonly phase: TransferExchangePhase;
112:     readonly record: OnlineTransferExchangeRecord;
113:   } {
114:     return { phase: this.phase, record: detached(this.record) };
115:   }
116: 
117:   protected setPhase(phase: TransferExchangePhase): void {
118:     if (this.closed) return;
119:     this.phase = phase;
120:     try {
121:       this.options.onChange?.(phase);
122:     } catch {
123:       // A view cannot interrupt certified transfer work.
124:     }
125:   }
126: 
127:   protected async save(next: OnlineTransferExchangeRecord): Promise<void> {
128:     this.ensureOpen();
129:     const copy = detached(next);
130:     await this.options.savePublicRecord(detached(copy));
131:     this.ensureOpen();
132:     this.record = copy;
133:   }
134: 
135:   protected ensureOpen(): void {
136:     if (this.closed) throw new Error('Transfer exchange is closed');
137:   }
138: 
139:   protected run<T>(task: () => Promise<T>): Promise<T> {
140:     const next = this.queue.then(async () => {
141:       this.ensureOpen();
142:       return task();
143:     });
144:     this.queue = next.catch(() => undefined);
145:     return next;
146:   }
147: 
148:   receive(artifact: OnlineTransferArtifact): Promise<void> {
149:     if (this.closed) return Promise.reject(new Error('Transfer exchange is closed'));
150:     const bytes = artifact.bytes;
151:     if (!(bytes instanceof Uint8Array))
152:       return Promise.reject(new TypeError('Transfer artifact bytes are malformed'));
153:     if (
154:       this.queuedArtifacts >= MAX_QUEUED_ARTIFACTS ||
155:       this.queuedBytes + bytes.length > MAX_QUEUED_BYTES
156:     )
157:       return Promise.reject(new RangeError('Transfer artifact queue is full'));
158:     const copy = new Uint8Array(bytes);
159:     this.queuedArtifacts += 1;
160:     this.queuedBytes += copy.length;
161:     return this.run(() => this.handle({ kind: artifact.kind, bytes: copy })).finally(() => {
162:       this.queuedArtifacts -= 1;
163:       this.queuedBytes -= copy.length;
164:       copy.fill(0);
165:     });
166:   }
167: 
168:   protected abstract handle(artifact: OnlineTransferArtifact): Promise<void>;
169: 
170:   close(): void {
171:     this.closed = true;
172:   }
173: }
174: 
175: export interface SourceTransferExchangeOptions extends CommonOptions {
176:   readonly record: OnlineTransferExchangeRecord & { readonly role: 'source' };
177: }
178: 
179: /** The source cannot sign, submit, or disclose until the human calls confirm(). */
180: export class SourceTransferExchange extends Exchange {
181:   constructor(options: SourceTransferExchangeOptions) {
182:     super(options, 'source');
183:     if (this.record.approved && !this.record.offer)
184:       throw new TypeError('Approved source record has no destination offer');
185:   }
186: 
187:   start(): Promise<void> {
188:     return this.run(() => this.sendBootstrap('bootstrap'));
189:   }
190: 
191:   protected async handle(artifact: OnlineTransferArtifact): Promise<void> {
192:     if (artifact.kind === 'received') {
193:       const receipt = v.parse(receiptSchema, canonicalDecode(artifact.bytes));
194:       if (
195:         receipt.destinationDevice !== this.record.destinationDevice ||
196:         !this.record.authorization ||
197:         !sameRef(receipt.authorization, this.record.authorization)
198:       )
199:         throw new TypeError('Transfer receipt belongs to another destination or authorization');
200:       const status = value(
201:         await this.options.worker.request({
202:           kind: 'transferStatus',
203:           authorization: receipt.authorization,
204:         }),
205:       );
206:       if (
207:         !status.outcome ||
208:         status.outcome.outcome !== receipt.outcome ||
209:         !sameRef(status.outcome.entry, receipt.entry)
210:       )
211:         throw new TypeError('Transfer receipt has no matching certified outcome');
212:       this.setPhase(receipt.outcome);
213:       return;
214:     }
215:     if (artifact.kind === 'offer') {
216:       const offer = parsedChange(artifact.bytes);
217:       if (
218:         offer.kind !== 'transfer-authorize' ||
219:         offer.statement.mode !== 'live' ||
220:         offer.ownerIntent !== undefined ||
221:         offer.returnIntent !== undefined ||
222:         offer.humanApprovals !== undefined ||
223:         offer.statement.seat !== this.record.seat ||
224:         offer.statement.genesisDigest !== this.record.genesisDigest ||
225:         offer.statement.destination.devicePeer !== this.record.destinationDevice
226:       )
227:         throw new TypeError('Transfer offer differs from the selected source and destination');
228:       if (this.record.offer && !equal(this.record.offer, offer))
229:         throw new TypeError('Transfer destination changed its signed offer');
230:       if (!this.record.offer) await this.save({ ...this.record, offer });
231:       if (!this.record.approved) this.setPhase('awaiting-confirmation');
232:       return;
233:     }
234:     if (artifact.kind !== 'readiness') throw new TypeError('Unexpected source transfer artifact');
235:     const readiness = parsedChange(artifact.bytes);
236:     const authorization = this.record.authorization;
237:     const approved = this.record.approved;
238:     if (
239:       readiness.kind !== 'transfer-activate' ||
240:       !authorization ||
241:       !approved ||
242:       !sameRef(readiness.statement.authorization, authorization) ||
243:       readiness.statement.destinationDevice !== this.record.destinationDevice ||
244:       readiness.statement.destinationGame !== approved.statement.destination.gamePeer
245:     )
246:       throw new TypeError('Readiness differs from this certified transfer');
247:     const status = value(
248:       await this.options.worker.request({ kind: 'transferStatus', authorization }),
249:     );
250:     if (status.outcome) {
251:       await this.deliverOutcome(status.outcome);
252:       return;
253:     }
254:     if (!status.pending || !sameRef(status.pending.entry, authorization))
255:       throw new TypeError('Transfer authorization is no longer pending');
256:     if (!sameRef(readiness.statement.parent, status.head)) {
257:       await this.sendBootstrap('authorized');
258:       this.setPhase('awaiting-readiness');
259:       return;
260:     }
261:     this.setPhase('awaiting-certification');
262:     value(
263:       await this.options.worker.request({
264:         kind: 'submitTransfer',
265:         change: readiness,
266:         head: status.head,
267:       }),
268:     );
269:     await this.retryNow();
270:   }
271: 
272:   confirm(): Promise<void> {
273:     return this.run(async () => {
274:       const offer = this.record.offer;
275:       if (!offer) throw new TypeError('No signed destination offer awaits confirmation');
276:       if (!this.record.approved) {
277:         const status = value(await this.options.worker.request({ kind: 'transferStatus' }));
278:         if (status.pending) throw new TypeError('Another transfer is pending');
279:         const approved = value(
280:           await this.options.worker.request({
281:             kind: 'authorizeLiveTransfer',
282:             offer,
283:             head: status.head,
284:           }),
285:         );
286:         if (!equal(approved.statement, offer.statement))
287:           throw new TypeError('Source authorization changed the signed destination offer');
288:         await this.save({ ...this.record, approved });
289:       }
290:       await this.retryNow();
291:     });
292:   }
293: 
294:   retry(): Promise<void> {
295:     return this.run(() => this.retryNow());
296:   }
297: 
298:   private async retryNow(): Promise<void> {
299:     const approved = this.record.approved;
300:     if (!approved) {
301:       if (this.record.offer) this.setPhase('awaiting-confirmation');
302:       else await this.sendBootstrap('bootstrap');
303:       return;
304:     }
305:     let authorization = this.record.authorization;
306:     let status = value(
307:       await this.options.worker.request({
308:         kind: 'transferStatus',
309:         ...(authorization ? { authorization } : {}),
310:       }),
311:     );
312:     if (authorization && status.outcome) {
313:       await this.deliverOutcome(status.outcome);
314:       return;
315:     }
316:     if (!authorization) {
317:       if (status.pending && equal(status.pending.statement, approved.statement)) {
318:         authorization = status.pending.entry;
319:       } else {
320:         if (status.pending) throw new TypeError('Another transfer was certified');
321:         this.setPhase('awaiting-authorization');
322:         value(
323:           await this.options.worker.request({
324:             kind: 'submitTransfer',
325:             change: approved,
326:             head: status.head,
327:           }),
328:         );
329:         status = value(await this.options.worker.request({ kind: 'transferStatus' }));
330:         authorization = status.pending?.entry ?? null;
331:       }
332:       if (!authorization || !status.pending || !equal(status.pending.statement, approved.statement))
333:         throw new TypeError('Signed authorization was not certified exactly');
334:       await this.save({ ...this.record, authorization });
335:     }
336:     if (!status.pending || !sameRef(status.pending.entry, authorization))
337:       throw new TypeError('Certified transfer authorization disappeared');
338:     await this.sendBootstrap('authorized');
339:     const packet = value(
340:       await this.options.worker.request({
341:         kind: 'prepareTransferPrivate',
342:         authorization,
343:       }),
344:     );
345:     this.ensureOpen();
346:     if (
347:       packet.destinationDevice !== this.record.destinationDevice ||
348:       !sameRef(packet.authorization, authorization)
349:     )
350:       throw new TypeError('Prepared private packet differs from certified destination');
351:     await this.options.channel.send({ kind: 'private', bytes: canonicalEncode(packet) });
352:     this.setPhase('awaiting-readiness');
353:   }
354: 
355:   private async sendBootstrap(kind: 'bootstrap' | 'authorized'): Promise<void> {
356:     const bytes = value(await this.options.worker.request({ kind: 'exportTransferBootstrap' }));
357:     this.ensureOpen();
358:     await this.options.channel.send({ kind, bytes });
359:   }
360: 
361:   private async deliverOutcome(outcome: {
362:     readonly authorization: OnlineWorkerHead;
363:     readonly outcome: 'activated' | 'cancelled';
364:     readonly entry: OnlineWorkerHead;
365:   }): Promise<void> {
366:     if (!this.record.authorization || !sameRef(outcome.authorization, this.record.authorization))
367:       throw new TypeError('Certified outcome belongs to another authorization');
368:     const parent = value(
369:       await this.options.worker.request({
370:         kind: 'exportTransferBootstrap',
371:         throughSeq: outcome.entry.seq - 1,
372:       }),
373:     );
374:     this.ensureOpen();
375:     await this.options.channel.send({ kind: 'authorized', bytes: parent });
376:     const final = value(
377:       await this.options.worker.request({
378:         kind: 'exportTransferBootstrap',
379:         throughSeq: outcome.entry.seq,
380:       }),
381:     );
382:     this.ensureOpen();
383:     await this.options.channel.send({ kind: outcome.outcome, bytes: final });
384:     this.setPhase('awaiting-receipt');
385:   }
386: 
387:   cancel(): Promise<void> {
388:     return this.run(async () => {
389:       let authorization = this.record.authorization;
390:       if (!authorization) {
391:         if (!this.record.approved) {
392:           this.setPhase('cancelled');
393:           this.close();
394:           return;
395:         }
396:         const current = value(await this.options.worker.request({ kind: 'transferStatus' }));
397:         if (!current.pending || !equal(current.pending.statement, this.record.approved.statement))
398:           throw new TypeError(
399:             'Approved transfer outcome is uncertain; cancellation needs its certified ref',
400:           );
401:         authorization = current.pending.entry;
402:         await this.save({ ...this.record, authorization });
403:       }
404:       const status = value(
405:         await this.options.worker.request({ kind: 'transferStatus', authorization }),
406:       );
407:       if (status.outcome) {
408:         await this.deliverOutcome(status.outcome);
409:         return;
410:       }
411:       if (!status.pending || !sameRef(status.pending.entry, authorization))
412:         throw new TypeError('Certified authorization is no longer pending');
413:       value(
414:         await this.options.worker.request({
415:           kind: 'submitTransfer',
416:           head: status.head,
417:           change: {
418:             kind: 'transfer-cancel',
419:             genesisDigest: this.record.genesisDigest,
420:             authorization,
421:             parent: status.head,
422:           },
423:         }),
424:       );
425:       const finalized = value(
426:         await this.options.worker.request({ kind: 'transferStatus', authorization }),
427:       );
428:       if (!finalized.outcome)
429:         throw new TypeError('Transfer cancellation has not certified an exact outcome');
430:       await this.deliverOutcome(finalized.outcome);
431:     });
432:   }
433: }
434: 
435: export interface DestinationTransferExchangeOptions extends CommonOptions {
436:   readonly record: OnlineTransferExchangeRecord & { readonly role: 'destination' };
437:   readonly expected: ExpectedOnlineTransferGame;
438:   readonly onPromoted: (gameId: string) => void | Promise<void>;
439:   readonly shutdownWorker: () => Promise<void>;
440: }
441: 
442: /** Destination checks and stores every private consequence inside its isolated worker. */
443: export class DestinationTransferExchange extends Exchange {
444:   private readonly destination: DestinationTransferExchangeOptions;
445:   private initialized = false;
446:   private terminal: OnlineTransferDestinationSnapshot | null = null;
447:   private promotionNotified = false;
448: 
449:   constructor(options: DestinationTransferExchangeOptions) {
450:     super(options, 'destination');
451:     if (
452:       options.expected.gameId !== this.record.gameId ||
453:       options.expected.genesisDigest !== this.record.genesisDigest
454:     )
455:       throw new TypeError('Destination expected game differs from transfer record');
456:     this.destination = options;
457:   }
458: 
459:   protected async handle(artifact: OnlineTransferArtifact): Promise<void> {
460:     if (this.terminal) {
461:       if (
462:         artifact.kind === 'bootstrap' ||
463:         artifact.kind === 'authorized' ||
464:         artifact.kind === 'activated' ||
465:         artifact.kind === 'cancelled'
466:       ) {
467:         await this.completeTerminal();
468:         return;
469:       }
470:       throw new TypeError('Finalized destination cannot accept more transfer material');
471:     }
472:     if (artifact.kind === 'bootstrap') {
473:       if (this.initialized) {
474:         const snapshot = value(
475:           await this.options.worker.request({
476:             kind: 'refreshTransferBootstrap',
477:             bootstrapBytes: artifact.bytes,
478:           }),
479:         );
480:         if (snapshot.phase === 'imported' || snapshot.phase === 'ready') {
481:           const readiness = value(
482:             await this.options.worker.request({ kind: 'prepareTransferReadiness' }),
483:           );
484:           await this.options.channel.send({ kind: 'readiness', bytes: canonicalEncode(readiness) });
485:         }
486:         return;
487:       }
488:       const opened = value(
489:         await this.options.worker.request({
490:           kind: 'initializeTransfer',
491:           self: this.record.destinationDevice,
492:           attemptId: this.record.attemptId,
493:           mode: 'open',
494:           expected: this.destination.expected,
495:           bootstrapBytes: artifact.bytes,
496:         }),
497:       );
498:       this.ensureOpen();
499:       this.initialized = true;
500:       if (opened.phase === 'promoted') {
501:         await this.pinOutcome(opened, 'activated');
502:         await this.destination.shutdownWorker();
503:         this.ensureOpen();
504:         this.terminal = detached(opened);
505:         await this.completeTerminal();
506:         return;
507:       }
508:       if (opened.phase === 'cancelled') {
509:         await this.pinOutcome(opened, 'cancelled');
510:         await this.destination.shutdownWorker();
511:         this.ensureOpen();
512:         this.terminal = detached(opened);
513:         await this.completeTerminal();
514:         return;
515:       }
516:       const offer = value(
517:         await this.options.worker.request({
518:           kind: 'prepareTransferOffer',
519:           seat: this.record.seat,
520:           mode: 'live',
521:         }),
522:       );
523:       if (
524:         offer.statement.destination.devicePeer !== this.record.destinationDevice ||
525:         offer.statement.genesisDigest !== this.record.genesisDigest ||
526:         offer.statement.seat !== this.record.seat ||
527:         (this.record.offer && !equal(this.record.offer, offer))
528:       )
529:         throw new TypeError('Destination worker prepared another signed transfer offer');
530:       if (!this.record.offer) await this.save({ ...this.record, offer });
531:       this.ensureOpen();
532:       await this.options.channel.send({ kind: 'offer', bytes: canonicalEncode(offer) });
533:       if (opened.phase === 'imported' || opened.phase === 'ready') {
534:         const readiness = value(
535:           await this.options.worker.request({ kind: 'prepareTransferReadiness' }),
536:         );
537:         await this.options.channel.send({ kind: 'readiness', bytes: canonicalEncode(readiness) });
538:         this.setPhase('awaiting-certification');
539:       } else this.setPhase('awaiting-authorization');
540:       return;
541:     }
542:     if (!this.initialized) throw new TypeError('Destination has no verified initial bootstrap');
543:     if (artifact.kind === 'authorized') {
544:       const snapshot = value(
545:         await this.options.worker.request({
546:           kind: 'refreshTransferBootstrap',
547:           bootstrapBytes: artifact.bytes,
548:         }),
549:       );
550:       this.ensureOpen();
551:       if (snapshot.authorization && !this.record.authorization)
552:         await this.save({ ...this.record, authorization: snapshot.authorization });
553:       if (snapshot.phase === 'imported' || snapshot.phase === 'ready') {
554:         const readiness = value(
555:           await this.options.worker.request({ kind: 'prepareTransferReadiness' }),
556:         );
557:         await this.options.channel.send({ kind: 'readiness', bytes: canonicalEncode(readiness) });
558:         this.setPhase('awaiting-certification');
559:       } else this.setPhase('awaiting-private');
560:       return;
561:     }
562:     if (artifact.kind === 'private') {
563:       if (artifact.bytes.length > 64 * 1024) throw new RangeError('Private packet is oversized');
564:       const packet: TransferPrivateEnvelope = v.parse(
565:         transferPrivateEnvelopeSchema,
566:         canonicalDecode(artifact.bytes),
567:       );
568:       if (packet.destinationDevice !== this.record.destinationDevice)
569:         throw new TypeError('Private packet addresses another destination');
570:       const snapshot = value(
571:         await this.options.worker.request({ kind: 'importTransferPacket', packet }),
572:       );
573:       if (!snapshot.authorization) throw new TypeError('Authenticated import has no authorization');
574:       if (!sameRef(packet.authorization, snapshot.authorization))
575:         throw new TypeError('Private packet differs from staged authorization');
576:       if (this.record.authorization && !sameRef(this.record.authorization, snapshot.authorization))
577:         throw new TypeError('Transfer authorization changed after import');
578:       if (!this.record.authorization)
579:         await this.save({ ...this.record, authorization: snapshot.authorization });
580:       const readiness = value(
581:         await this.options.worker.request({ kind: 'prepareTransferReadiness' }),
582:       );
583:       this.ensureOpen();
584:       await this.options.channel.send({ kind: 'readiness', bytes: canonicalEncode(readiness) });
585:       this.setPhase('awaiting-certification');
586:       return;
587:     }
588:     if (artifact.kind === 'activated') {
589:       const observed = value(
590:         await this.options.worker.request({
591:           kind: 'observeTransferActivation',
592:           bootstrapBytes: artifact.bytes,
593:         }),
594:       );
595:       await this.pinOutcome(observed.snapshot, 'activated');
596:       await this.destination.shutdownWorker();
597:       this.ensureOpen();
598:       this.terminal = detached(observed.snapshot);
599:       await this.completeTerminal();
600:       return;
601:     }
602:     if (artifact.kind === 'cancelled') {
603:       const observed = value(
604:         await this.options.worker.request({
605:           kind: 'observeTransferCancellation',
606:           bootstrapBytes: artifact.bytes,
607:         }),
608:       );
609:       await this.pinOutcome(observed, 'cancelled');
610:       await this.destination.shutdownWorker();
611:       this.ensureOpen();
612:       this.terminal = detached(observed);
613:       await this.completeTerminal();
614:       return;
615:     }
616:     throw new TypeError('Unexpected destination transfer artifact');
617:   }
618: 
619:   retry(): Promise<void> {
620:     return this.run(async () => {
621:       if (this.terminal) {
622:         await this.completeTerminal();
623:         return;
624:       }
625:       if (!this.initialized) return;
626:       const snapshot = value(await this.options.worker.request({ kind: 'transferSnapshot' }));
627:       const offer = this.record.offer;
628:       if (!offer) throw new TypeError('Destination signed offer is not retained');
629:       if (snapshot.phase === 'offered') {
630:         await this.options.channel.send({ kind: 'offer', bytes: canonicalEncode(offer) });
631:       } else if (snapshot.phase === 'imported' || snapshot.phase === 'ready') {
632:         const readiness = value(
633:           await this.options.worker.request({ kind: 'prepareTransferReadiness' }),
634:         );
635:         await this.options.channel.send({ kind: 'readiness', bytes: canonicalEncode(readiness) });
636:       }
637:     });
638:   }
639: 
640:   /** A lost receipt must be retryable after the importer has already shut down. */
641:   private async completeTerminal(): Promise<void> {
642:     const snapshot = this.terminal;
643:     const outcome = snapshot?.outcome?.outcome;
644:     if (!snapshot || !outcome) throw new TypeError('Finalized transfer outcome is missing');
645:     await this.sendReceipt(snapshot, outcome);
646:     this.ensureOpen();
647:     this.setPhase(outcome);
648:     if (outcome === 'activated' && !this.promotionNotified) {
649:       await this.destination.onPromoted(this.record.gameId);
650:       this.promotionNotified = true;
651:     }
652:   }
653: 
654:   private async pinOutcome(
655:     snapshot: OnlineTransferDestinationSnapshot,
656:     outcome: 'activated' | 'cancelled',
657:   ): Promise<void> {
658:     const certified = snapshot.outcome;
659:     if (
660:       !certified ||
661:       certified.outcome !== outcome ||
662:       !sameRef(certified.entry, snapshot.head) ||
663:       (this.record.authorization && !sameRef(this.record.authorization, certified.authorization))
664:     )
665:       throw new TypeError('Destination did not verify this exact certified outcome');
666:     if (!this.record.authorization)
667:       await this.save({ ...this.record, authorization: certified.authorization });
668:   }
669: 
670:   private async sendReceipt(
671:     snapshot: OnlineTransferDestinationSnapshot,
672:     outcome: 'activated' | 'cancelled',
673:   ): Promise<void> {
674:     const certified = snapshot.outcome;
675:     if (
676:       !certified ||
677:       certified.outcome !== outcome ||
678:       !this.record.authorization ||
679:       !sameRef(certified.authorization, this.record.authorization) ||
680:       !sameRef(certified.entry, snapshot.head)
681:     )
682:       throw new TypeError('Observed transfer has no matching certified final head');
683:     this.ensureOpen();
684:     await this.options.channel.send({
685:       kind: 'received',
686:       bytes: canonicalEncode({
687:         protocol: 'online-transfer-received-v1',
688:         destinationDevice: this.record.destinationDevice,
689:         authorization: certified.authorization,
690:         outcome,
691:         entry: certified.entry,
692:       }),
693:     });
694:   }
695: 
696:   override close(): void {
697:     if (this.closed) return;
698:     super.close();
699:     void this.destination.shutdownWorker().catch(() => undefined);
700:   }
701: }

## File: apps/web/src/session/online-transfer-records.ts

1: import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
2: import { parsePeerId } from '@cp2p/crypto';
3: import { transferChangeSchema } from '@cp2p/protocol';
4: import type { EscrowCeremonyStore, SeatTransferAuthorization } from '@cp2p/protocol';
5: import type { Seat } from '@cp2p/engine';
6: import * as v from 'valibot';
7: import { decodeTransferInvite, encodeTransferInvite } from './online-transfer-link.js';
8: import type { OnlineTransferInvite } from './online-transfer-link.js';
9: 
10: type TransferRecordStorage = Pick<
11:   EscrowCeremonyStore,
12:   'load' | 'putIfAbsent' | 'compareAndSwap' | 'withCeremonyLock'
13: >;
14: 
15: const MAX_BYTES = 65_536;
16: const token = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));
17: const ref = v.strictObject({
18:   seq: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
19:   hash: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
20: });
21: const recordSchema = v.strictObject({
22:   protocol: v.literal('online-transfer-exchange-v1'),
23:   role: v.picklist(['source', 'destination']),
24:   attemptId: token,
25:   gameId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22}$/)),
26:   genesisDigest: token,
27:   sourceDevice: token,
28:   destinationDevice: token,
29:   seat: v.picklist([0, 1, 2, 3, 4, 5] as const),
30:   offer: v.nullable(v.unknown()),
31:   approved: v.nullable(v.unknown()),
32:   authorization: v.nullable(ref),
33: });
34: const envelopeSchema = v.strictObject({
35:   protocol: v.literal('online-transfer-ui-v1'),
36:   invite: v.pipe(v.string(), v.maxLength(2731)),
37:   role: v.picklist(['source', 'destination']),
38:   self: token,
39:   record: v.nullable(recordSchema),
40:   finished: v.boolean(),
41: });
42: 
43: /** Public decisions only. Private imports and voting permission remain worker-owned. */
44: export interface OnlineTransferExchangeRecord {
45:   readonly protocol: 'online-transfer-exchange-v1';
46:   readonly role: 'source' | 'destination';
47:   readonly attemptId: string;
48:   readonly gameId: string;
49:   readonly genesisDigest: string;
50:   readonly sourceDevice: string;
51:   readonly destinationDevice: string;
52:   readonly seat: Seat;
53:   readonly offer: SeatTransferAuthorization | null;
54:   readonly approved: SeatTransferAuthorization | null;
55:   readonly authorization: { readonly seq: number; readonly hash: string } | null;
56: }
57: 
58: function same(left: unknown, right: unknown): boolean {
59:   const a = canonicalEncode(left);
60:   const b = canonicalEncode(right);
61:   return a.length === b.length && a.every((byte, index) => byte === b[index]);
62: }
63: 
64: function authorization(value: unknown): SeatTransferAuthorization | null {
65:   if (value === null) return null;
66:   const parsed = v.parse(transferChangeSchema, value);
67:   if (parsed.kind !== 'transfer-authorize') throw new TypeError('Expected transfer authorization');
68:   return parsed;
69: }
70: 
71: function checkedRecord(raw: unknown): OnlineTransferExchangeRecord {
72:   const value = v.parse(recordSchema, raw);
73:   const offer = authorization(value.offer);
74:   const approved = authorization(value.approved);
75:   parsePeerId(value.sourceDevice);
76:   parsePeerId(value.destinationDevice);
77:   if (value.sourceDevice === value.destinationDevice)
78:     throw new TypeError('Transfer devices must differ');
79:   for (const entry of [offer, approved]) {
80:     if (!entry) continue;
81:     const statement = entry.statement;
82:     if (
83:       statement.genesisDigest !== value.genesisDigest ||
84:       statement.seat !== value.seat ||
85:       statement.destination.devicePeer !== value.destinationDevice
86:     )
87:       throw new TypeError('Transfer decision differs from its pinned game, seat or device');
88:   }
89:   if (approved && (!offer || !same(approved.statement, offer.statement)))
90:     throw new TypeError('Transfer approval differs from its chosen offer');
91:   if (value.authorization && !offer)
92:     throw new TypeError('Certified transfer reference requires the chosen offer');
93:   return { ...value, offer, approved };
94: }
95: 
96: /** Durable browser progress is a locator, never evidence of certified activation. */
97: export class OnlineTransferRecordStore {
98:   readonly #code: string;
99:   readonly #key: string;
100:   readonly #invite: OnlineTransferInvite;
101: 
102:   constructor(
103:     private readonly store: TransferRecordStorage,
104:     private readonly self: string,
105:     invite: OnlineTransferInvite,
106:     private readonly role: 'source' | 'destination',
107:   ) {
108:     parsePeerId(self);
109:     this.#code = encodeTransferInvite(invite);
110:     this.#invite = decodeTransferInvite(this.#code);
111:     if ((role === 'source') !== (self === invite.body.sourceDevice))
112:       throw new TypeError('Transfer record role differs from the invitation');
113:     this.#key = `online-transfer-ui/${self}/${invite.body.attemptId}`;
114:   }
115: 
116:   async load(): Promise<{ record: OnlineTransferExchangeRecord | null; finished: boolean }> {
117:     const bytes = await this.store.load(this.#key);
118:     if (!bytes) return { record: null, finished: false };
119:     return this.#read(bytes);
120:   }
121: 
122:   async save(record: OnlineTransferExchangeRecord): Promise<void> {
123:     const next = checkedRecord(record);
124:     this.#checkScope(next);
125:     await this.#update((prior) => {
126:       if (prior.finished) throw new Error('Transfer browser attempt is finished');
127:       const previous = prior.record;
128:       if (previous) {
129:         const pins = [
130:           'protocol',
131:           'role',
132:           'attemptId',
133:           'gameId',
134:           'genesisDigest',
135:           'sourceDevice',
136:           'destinationDevice',
137:           'seat',
138:         ] as const;
139:         if (pins.some((key) => previous[key] !== next[key]))
140:           throw new Error('Transfer browser attempt cannot change its pinned destination');
141:         for (const key of ['offer', 'approved', 'authorization'] as const)
142:           if (previous[key] !== null && !same(previous[key], next[key]))
143:             throw new Error('Transfer browser decision cannot be replaced');
144:       }
145:       return { record: next, finished: false };
146:     });
147:   }
148: 
149:   /** Only called after the exchange reports a certified outcome or cancels before approval. */
150:   finish(): Promise<void> {
151:     return this.#update((prior) => ({ ...prior, finished: true }));
152:   }
153: 
154:   async #update(
155:     update: (prior: { record: OnlineTransferExchangeRecord | null; finished: boolean }) => {
156:       record: OnlineTransferExchangeRecord | null;
157:       finished: boolean;
158:     },
159:   ): Promise<void> {
160:     await this.store.withCeremonyLock(this.#key, async () => {
161:       const before = await this.store.load(this.#key);
162:       const prior = before ? this.#read(before) : { record: null, finished: false };
163:       const next = update(prior);
164:       const bytes = canonicalEncode({
165:         protocol: 'online-transfer-ui-v1',
166:         invite: this.#code,
167:         self: this.self,
168:         role: this.role,
169:         ...next,
170:       });
171:       if (bytes.length > MAX_BYTES) throw new RangeError('Transfer browser record is oversized');
172:       const stored = before
173:         ? await this.store.compareAndSwap(this.#key, before, bytes)
174:         : await this.store.putIfAbsent(this.#key, bytes);
175:       if (!stored) throw new Error('Transfer browser record changed in another tab');
176:     });
177:   }
178: 
179:   #checkScope(record: OnlineTransferExchangeRecord): void {
180:     const body = this.#invite.body;
181:     if (
182:       record.role !== this.role ||
183:       record.attemptId !== body.attemptId ||
184:       record.gameId !== body.gameId ||
185:       record.seat !== body.seat ||
186:       record.genesisDigest !== body.genesisDigest ||
187:       record.sourceDevice !== body.sourceDevice ||
188:       (this.role === 'destination' && record.destinationDevice !== this.self)
189:     )
190:       throw new TypeError('Transfer browser record belongs to another invitation');
191:   }
192: 
193:   #read(bytes: Uint8Array): { record: OnlineTransferExchangeRecord | null; finished: boolean } {
194:     if (bytes.length > MAX_BYTES) throw new RangeError('Transfer browser record is oversized');
195:     const value = v.parse(envelopeSchema, canonicalDecode(bytes));
196:     if (value.invite !== this.#code || value.self !== this.self || value.role !== this.role)
197:       throw new TypeError('Stored transfer belongs to another invitation');
198:     const record = value.record ? checkedRecord(value.record) : null;
199:     if (record) this.#checkScope(record);
200:     return { record, finished: value.finished };
201:   }
202: }
203: 
204: /** One recoverable source invitation per game, with explicit replacement after completion. */
205: export async function saveCurrentTransferInvite(
206:   store: TransferRecordStorage,
207:   self: string,
208:   invite: OnlineTransferInvite,
209: ): Promise<void> {
210:   const records = new OnlineTransferRecordStore(store, self, invite, 'source');
211:   const key = `online-transfer-current/${self}/${invite.body.gameId}`;
212:   const encoded = canonicalEncode(encodeTransferInvite(invite));
213:   await store.withCeremonyLock(key, async () => {
214:     const prior = await store.load(key);
215:     if (prior) {
216:       if (prior.length > 4096) throw new RangeError('Stored transfer invitation is oversized');
217:       if (same(canonicalDecode(prior), encodeTransferInvite(invite))) return;
218:       const previous = await loadCurrentTransferInvite(store, self, invite.body.gameId);
219:       if (!previous) throw new Error('Current transfer invitation disappeared');
220:       const progress = await new OnlineTransferRecordStore(store, self, previous, 'source').load();
221:       if (!progress.finished) throw new Error('A transfer is already in progress');
222:     }
223:     if ((await records.load()).finished) throw new Error('Transfer invitation is already finished');
224:     const stored = prior
225:       ? await store.compareAndSwap(key, prior, encoded)
226:       : await store.putIfAbsent(key, encoded);
227:     if (!stored) throw new Error('Current transfer changed in another tab');
228:   });
229: }
230: 
231: export async function loadCurrentTransferInvite(
232:   store: TransferRecordStorage,
233:   self: string,
234:   gameId: string,
235: ): Promise<OnlineTransferInvite | null> {
236:   parsePeerId(self);
237:   if (!/^[A-Za-z0-9_-]{22}$/.test(gameId)) throw new TypeError('Invalid transfer game');
238:   const bytes = await store.load(`online-transfer-current/${self}/${gameId}`);
239:   if (!bytes) return null;
240:   if (bytes.length > 4096) throw new RangeError('Stored transfer invitation is oversized');
241:   const code = canonicalDecode(bytes);
242:   if (typeof code !== 'string') throw new TypeError('Stored transfer invitation is malformed');
243:   const invite = decodeTransferInvite(code);
244:   if (invite.body.gameId !== gameId || invite.body.sourceDevice !== self)
245:     throw new TypeError('Stored transfer invitation belongs to another game or device');
246:   return invite;
247: }

## File: apps/web/src/session/online-transfer-link.ts

1: import {
2:   canonicalDecode,
3:   canonicalEncode,
4:   fromBase64Url,
5:   hashValue,
6:   toBase64Url,
7: } from '@cp2p/codec';
8: import { identityFromSecret, parsePeerId, signObject, verifyObject } from '@cp2p/crypto';
9: import { ServerSignalingAdapter, WebRtcTransport } from '@cp2p/p2p';
10: import type { ServerSignalingOptions, WebRtcTransportOptions } from '@cp2p/p2p';
11: import type { PeerId, ProtocolClock, Unsubscribe } from '@cp2p/protocol';
12: import type { Seat } from '@cp2p/engine';
13: import * as v from 'valibot';
14: import type { DisposableOnlineIdentity } from './online-credentials.js';
15: import { createRoomId } from './online-invite.js';
16: import { OnlineTransferChannel } from './online-transfer-channel.js';
17: import type { OnlineTransferArtifact } from './online-transfer-channel.js';
18: 
19: const INVITE_PROTOCOL = 'cp2p/online-transfer-invite/v4';
20: const INVITE_DOMAIN = 'online-transfer-invite-v4';
21: const SCOPE_DOMAIN = 'cp2p/online-transfer-channel/v1';
22: const MAX_CODE_BYTES = 2_048;
23: const token = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));
24: const bodySchema = v.strictObject({
25:   protocol: v.literal(INVITE_PROTOCOL),
26:   roomId: v.pipe(v.string(), v.regex(/^[a-z2-7]{10}$/)),
27:   attemptId: token,
28:   gameId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22}$/)),
29:   seat: v.picklist([0, 1, 2, 3, 4, 5] as const),
30:   genesisDigest: token,
31:   sourceDevice: token,
32:   serverUrl: v.pipe(v.string(), v.maxLength(512)),
33: });
34: const inviteSchema = v.strictObject({
35:   body: bodySchema,
36:   sig: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{86}$/)),
37: });
38: 
39: export type OnlineTransferInvite = v.InferOutput<typeof inviteSchema>;
40: 
41: function serverOrigin(value: string): string {
42:   const url = new URL(value);
43:   if (
44:     !['ws:', 'wss:'].includes(url.protocol) ||
45:     url.username ||
46:     url.password ||
47:     url.pathname !== '/' ||
48:     url.search ||
49:     url.hash ||
50:     url.href !== url.origin + '/'
51:   )
52:     throw new TypeError('Transfer requires a signaling server origin');
53:   return url.origin;
54: }
55: 
56: function verifiedInvite(value: unknown): OnlineTransferInvite {
57:   const invite = v.parse(inviteSchema, value);
58:   parsePeerId(invite.body.sourceDevice);
59:   if (serverOrigin(invite.body.serverUrl) !== invite.body.serverUrl)
60:     throw new TypeError('Transfer signaling server URL is not canonical');
61:   if (!verifyObject(INVITE_DOMAIN, invite.body, invite.sig, parsePeerId(invite.body.sourceDevice)))
62:     throw new TypeError('Transfer invitation signature is invalid');
63:   return invite;
64: }
65: 
66: export function createTransferInvite(input: {
67:   readonly attemptId: string;
68:   readonly gameId: string;
69:   readonly seat: Seat;
70:   readonly genesisDigest: string;
71:   readonly serverUrl: string;
72:   readonly identity: DisposableOnlineIdentity;
73:   readonly roomId?: string;
74: }): OnlineTransferInvite {
75:   const source = identityFromSecret(input.identity.secretKey);
76:   try {
77:     if (source.peerId !== input.identity.peerId)
78:       throw new TypeError('Transfer source device key does not match identity');
79:   } finally {
80:     source.secretKey.fill(0);
81:     source.publicKey.fill(0);
82:   }
83:   const body = v.parse(bodySchema, {
84:     protocol: INVITE_PROTOCOL,
85:     roomId: input.roomId ?? createRoomId(),
86:     attemptId: input.attemptId,
87:     gameId: input.gameId,
88:     seat: input.seat,
89:     genesisDigest: input.genesisDigest,
90:     sourceDevice: input.identity.peerId,
91:     serverUrl: serverOrigin(input.serverUrl),
92:   });
93:   return verifiedInvite({ body, sig: signObject(INVITE_DOMAIN, body, input.identity.secretKey) });
94: }
95: 
96: export function encodeTransferInvite(invite: OnlineTransferInvite): string {
97:   const bytes = canonicalEncode(verifiedInvite(invite));
98:   try {
99:     if (bytes.length > MAX_CODE_BYTES) throw new RangeError('Transfer invitation is oversized');
100:     return toBase64Url(bytes);
101:   } finally {
102:     bytes.fill(0);
103:   }
104: }
105: 
106: export function decodeTransferInvite(code: string): OnlineTransferInvite {
107:   if (!/^[A-Za-z0-9_-]{1,2731}$/.test(code))
108:     throw new TypeError('Transfer invitation code is malformed');
109:   const bytes = fromBase64Url(code);
110:   try {
111:     if (bytes.length > MAX_CODE_BYTES) throw new RangeError('Transfer invitation is oversized');
112:     const invite = verifiedInvite(canonicalDecode(bytes));
113:     const canonical = canonicalEncode(invite);
114:     try {
115:       if (
116:         canonical.length !== bytes.length ||
117:         canonical.some((byte, index) => byte !== bytes[index])
118:       )
119:         throw new TypeError('Transfer invitation is not canonical');
120:     } finally {
121:       canonical.fill(0);
122:     }
123:     return invite;
124:   } finally {
125:     bytes.fill(0);
126:   }
127: }
128: 
129: export function createTransferInviteUrl(appUrl: string, invite: OnlineTransferInvite): string {
130:   const url = new URL(appUrl);
131:   if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
132:     throw new TypeError('Invalid transfer app URL');
133:   url.search = '';
134:   url.hash = `/transfer/${encodeTransferInvite(invite)}`;
135:   return url.href;
136: }
137: 
138: export function parseTransferInviteUrl(value: string): OnlineTransferInvite {
139:   if (value.length > 4_096) throw new RangeError('Transfer invitation URL is oversized');
140:   const url = new URL(value);
141:   if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search)
142:     throw new TypeError('Invalid transfer app URL');
143:   const path = url.hash.slice(1);
144:   if (!path.startsWith('/transfer/')) throw new TypeError('Not a transfer invitation URL');
145:   return decodeTransferInvite(path.slice('/transfer/'.length));
146: }
147: 
148: export function transferChannelScope(
149:   invite: OnlineTransferInvite,
150:   destinationDevice: PeerId,
151: ): string {
152:   const checked = verifiedInvite(invite);
153:   parsePeerId(destinationDevice);
154:   if (destinationDevice === checked.body.sourceDevice)
155:     throw new TypeError('Transfer destination must be another device');
156:   return toBase64Url(
157:     hashValue({
158:       domain: SCOPE_DOMAIN,
159:       attemptId: checked.body.attemptId,
160:       genesisDigest: checked.body.genesisDigest,
161:       sourceDevice: checked.body.sourceDevice,
162:       destinationDevice,
163:     }),
164:   );
165: }
166: 
167: export interface OnlineTransferLinkOptions {
168:   readonly invite: OnlineTransferInvite;
169:   readonly identity: DisposableOnlineIdentity;
170:   readonly clock: ProtocolClock;
171:   readonly onChannel: (channel: OnlineTransferChannel) => void;
172:   readonly onArtifact: (artifact: OnlineTransferArtifact) => void;
173:   readonly onError: (error: Error) => void;
174:   readonly socketFactory?: ServerSignalingOptions['socketFactory'];
175:   readonly rtcFactory?: WebRtcTransportOptions['rtcFactory'];
176:   readonly iceServers?: readonly RTCIceServer[];
177:   readonly iceTransportPolicy?: RTCIceTransportPolicy;
178:   /** Deterministic test seams; production constructs the real signaling and RTC transport. */
179:   readonly signalingFactory?: (options: ServerSignalingOptions) => ServerSignalingAdapter;
180:   readonly transportFactory?: (options: WebRtcTransportOptions) => WebRtcTransport;
181: }
182: 
183: /** A separate signaling room and two-device authenticated link; game routing is untouched. */
184: export class OnlineTransferLink {
185:   readonly #source: boolean;
186:   readonly #invite: OnlineTransferInvite;
187:   readonly #self: PeerId;
188:   readonly #signaling: ServerSignalingAdapter;
189:   readonly #transport: WebRtcTransport;
190:   readonly #options: OnlineTransferLinkOptions;
191:   readonly #off: Unsubscribe[] = [];
192:   readonly #candidateListeners = new Set<(peers: readonly PeerId[]) => void>();
193:   #candidates: readonly PeerId[] = [];
194:   #selected: PeerId | null = null;
195:   #channel: OnlineTransferChannel | null = null;
196:   #channelGeneration = 0;
197:   #closed = false;
198: 
199:   private constructor(options: OnlineTransferLinkOptions, source: boolean) {
200:     this.#options = options;
201:     this.#source = source;
202:     this.#invite = verifiedInvite(options.invite);
203:     this.#self = options.identity.peerId;
204:     const derived = identityFromSecret(options.identity.secretKey);
205:     try {
206:       if (derived.peerId !== this.#self)
207:         throw new TypeError('Transfer device key does not match identity');
208:     } finally {
209:       derived.secretKey.fill(0);
210:       derived.publicKey.fill(0);
211:     }
212:     if (source !== (this.#self === this.#invite.body.sourceDevice))
213:       throw new TypeError('Transfer link role differs from signed source device');
214:     const initialRoster = source ? [this.#self] : [this.#self, this.#invite.body.sourceDevice];
215:     const signalingOptions: ServerSignalingOptions = {
216:       serverUrl: this.#invite.body.serverUrl,
217:       roomId: this.#invite.body.roomId,
218:       self: this.#self,
219:       secretKey: options.identity.secretKey,
220:       clock: options.clock,
221:       ...(options.socketFactory ? { socketFactory: options.socketFactory } : {}),
222:     };
223:     this.#signaling = (options.signalingFactory ?? ((value) => new ServerSignalingAdapter(value)))(
224:       signalingOptions,
225:     );
226:     try {
227:       this.#transport = (options.transportFactory ?? ((value) => new WebRtcTransport(value)))({
228:         self: this.#self,
229:         secretKey: options.identity.secretKey,
230:         roster: initialRoster,
231:         scope: `transfer:${this.#invite.body.roomId}:${this.#invite.body.attemptId}`,
232:         adapter: this.#signaling,
233:         clock: options.clock,
234:         rtcFactory: options.rtcFactory ?? ((_peer, config) => new RTCPeerConnection(config)),
235:         ...(options.iceServers ? { iceServers: options.iceServers } : {}),
236:         ...(options.iceTransportPolicy ? { iceTransportPolicy: options.iceTransportPolicy } : {}),
237:       });
238:     } catch (error) {
239:       this.#signaling.close();
240:       throw error;
241:     }
242:     try {
243:       this.#off.push(
244:         this.#transport.onPeerChange((peer, online) => this.#peerChanged(peer, online)),
245:       );
246:       if (source) {
247:         this.#off.push(this.#signaling.onRoomPeers((peers) => this.#discovered(peers)));
248:         this.#transport.start();
249:       } else {
250:         this.#selected = this.#invite.body.sourceDevice;
251:         this.#transport.freezeRoster();
252:         this.#transport.start();
253:         this.#transport.connect(this.#selected);
254:       }
255:     } catch (error) {
256:       this.close();
257:       throw error;
258:     }
259:   }
260: 
261:   static openSource(options: OnlineTransferLinkOptions): OnlineTransferLink {
262:     return new OnlineTransferLink(options, true);
263:   }
264: 
265:   static openDestination(options: OnlineTransferLinkOptions): OnlineTransferLink {
266:     return new OnlineTransferLink(options, false);
267:   }
268: 
269:   candidates(): readonly PeerId[] {
270:     return this.#candidates.slice();
271:   }
272: 
273:   onCandidates(listener: (peers: readonly PeerId[]) => void): Unsubscribe {
274:     if (this.#closed) return () => undefined;
275:     this.#candidateListeners.add(listener);
276:     try {
277:       listener(this.candidates());
278:     } catch {
279:       /* Isolate UI observers. */
280:     }
281:     return () => this.#candidateListeners.delete(listener);
282:   }
283: 
284:   selectDestination(peer: PeerId): void {
285:     if (this.#closed || !this.#source || this.#selected)
286:       throw new TypeError('Transfer source cannot select a destination');
287:     parsePeerId(peer);
288:     if (!this.#candidates.includes(peer))
289:       throw new TypeError('Destination is not present in the transfer signaling room');
290:     this.#selected = peer;
291:     try {
292:       this.#transport.updatePreGameRoster([this.#self, peer]);
293:       this.#transport.freezeRoster();
294:       this.#transport.connect(peer);
295:     } catch (error) {
296:       this.close();
297:       throw error;
298:     }
299:   }
300: 
301:   #discovered(peers: readonly PeerId[] | null): void {
302:     if (this.#closed) return;
303:     this.#candidates = (peers ?? []).filter((peer) => peer !== this.#self).slice(0, 7);
304:     for (const listener of this.#candidateListeners) {
305:       try {
306:         listener(this.candidates());
307:       } catch {
308:         /* Isolate UI observers. */
309:       }
310:     }
311:   }
312: 
313:   #peerChanged(peer: PeerId, online: boolean): void {
314:     if (this.#closed || peer !== this.#selected) return;
315:     if (!online) {
316:       this.#channelGeneration += 1;
317:       this.#channel?.close();
318:       this.#channel = null;
319:       this.#options.onError(new Error('Transfer connection closed'));
320:       return;
321:     }
322:     if (this.#channel) return;
323:     const generation = ++this.#channelGeneration;
324:     const current = () => !this.#closed && generation === this.#channelGeneration;
325:     try {
326:       const channel = new OnlineTransferChannel({
327:         transport: this.#transport,
328:         peer,
329:         scope: transferChannelScope(this.#invite, this.#source ? peer : this.#self),
330:         clock: this.#options.clock,
331:         onArtifact: (artifact) => {
332:           if (current()) this.#options.onArtifact(artifact);
333:         },
334:         onError: (error) => {
335:           if (current()) {
336:             this.#channel = null;
337:             this.#options.onError(error);
338:           }
339:         },
340:       });
341:       this.#channel = channel;
342:       this.#options.onChannel(channel);
343:     } catch (error) {
344:       this.#channel?.close();
345:       this.#channel = null;
346:       this.#options.onError(error instanceof Error ? error : new Error('Transfer channel failed'));
347:     }
348:   }
349: 
350:   close(): void {
351:     if (this.#closed) return;
352:     this.#closed = true;
353:     this.#channel?.close();
354:     this.#channel = null;
355:     for (const off of this.#off) off();
356:     this.#off.length = 0;
357:     this.#candidateListeners.clear();
358:     this.#transport.dispose();
359:     this.#signaling.close();
360:   }
361: }

## File: apps/web/src/session/online-transfer-channel.ts

1: import { canonicalDecode, canonicalEncode, sha256, toHex } from '@cp2p/codec';
2: import type { PeerId, ProtocolClock, Transport, Unsubscribe } from '@cp2p/protocol';
3: import * as v from 'valibot';
4: 
5: const MAGIC = Uint8Array.of(0x48, 0x58, 0x54, 1);
6: const CHUNK_BYTES = 32 * 1024;
7: const MAX_FRAME_BYTES = Math.ceil((CHUNK_BYTES * 4) / 3) + 1024;
8: const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
9: const MAX_TRANSFERS = 64;
10: const CHUNK_IDLE_MS = 30_000;
11: const RETRY_MS = 5_000;
12: const MAX_CHUNK_ATTEMPTS = 6;
13: const kindSchema = v.picklist([
14:   'bootstrap',
15:   'offer',
16:   'authorized',
17:   'private',
18:   'readiness',
19:   'activated',
20:   'cancelled',
21:   'received',
22: ]);
23: const uint = (max: number) => v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(max));
24: const common = {
25:   scope: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/)),
26:   id: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_TRANSFERS)),
27:   index: uint(MAX_ARTIFACT_BYTES / CHUNK_BYTES - 1),
28: };
29: const ackSchema = v.strictObject({ ...common, type: v.literal('ack') });
30: const dataSchema = v.strictObject({
31:   ...common,
32:   type: v.literal('data'),
33:   kind: kindSchema,
34:   length: uint(MAX_ARTIFACT_BYTES),
35:   digest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
36:   bytes: v.custom<Uint8Array>(
37:     (value) => value instanceof Uint8Array && value.length <= CHUNK_BYTES,
38:   ),
39: });
40: const frameSchema = v.variant('type', [ackSchema, dataSchema]);
41: type DataFrame = v.InferOutput<typeof dataSchema>;
42: 
43: export interface OnlineTransferArtifact {
44:   readonly kind: v.InferOutput<typeof kindSchema>;
45:   readonly bytes: Uint8Array;
46: }
47: 
48: function artifactLimit(kind: OnlineTransferArtifact['kind']): number {
49:   return kind === 'bootstrap' ||
50:     kind === 'authorized' ||
51:     kind === 'activated' ||
52:     kind === 'cancelled'
53:     ? MAX_ARTIFACT_BYTES
54:     : 64 * 1024;
55: }
56: 
57: function encode(frame: v.InferOutput<typeof frameSchema>): Uint8Array {
58:   const body = canonicalEncode(frame);
59:   const bytes = new Uint8Array(MAGIC.length + body.length);
60:   bytes.set(MAGIC);
61:   bytes.set(body, MAGIC.length);
62:   return bytes;
63: }
64: 
65: interface Incoming {
66:   readonly first: DataFrame;
67:   readonly bytes: Uint8Array;
68:   timer: unknown;
69:   nextIndex: number;
70: }
71: 
72: interface CompletedChunk {
73:   readonly id: number;
74:   readonly kind: DataFrame['kind'];
75:   readonly length: number;
76:   readonly digest: string;
77:   readonly index: number;
78:   readonly bytes: Uint8Array;
79: }
80: 
81: interface AwaitingAck {
82:   readonly id: number;
83:   readonly index: number;
84:   readonly frame: Uint8Array;
85:   readonly resolve: () => void;
86:   readonly reject: (error: Error) => void;
87:   attempts: number;
88:   idleTimer: unknown;
89:   retryTimer: unknown;
90: }
91: 
92: /** An isolated authenticated device link. Artifacts never enter the game transport. */
93: export class OnlineTransferChannel {
94:   private readonly off: Unsubscribe[];
95:   private incoming: Incoming | null = null;
96:   private completed: CompletedChunk | null = null;
97:   private lastReceived = 0;
98:   private nextId = 0;
99:   private sending = false;
100:   private closed = false;
101:   private awaiting: AwaitingAck | null = null;
102: 
103:   constructor(
104:     private readonly options: {
105:       readonly transport: Transport;
106:       readonly peer: PeerId;
107:       readonly scope: string;
108:       readonly clock: ProtocolClock;
109:       /** Receives owned public evidence or ciphertext. Must not block on user confirmation. */
110:       readonly onArtifact: (artifact: OnlineTransferArtifact) => void;
111:       readonly onError: (error: Error) => void;
112:     },
113:   ) {
114:     v.parse(common.scope, options.scope);
115:     if (options.peer === options.transport.self)
116:       throw new TypeError('A transfer requires a different destination device');
117:     this.off = [
118:       options.transport.onMessage((from, bytes) => {
119:         if (from === options.peer) this.receive(bytes);
120:       }),
121:       options.transport.onPeerChange((peer, online) => {
122:         if (peer === options.peer && !online) this.fail(new Error('Transfer connection closed'));
123:       }),
124:     ];
125:   }
126: 
127:   async send(artifact: OnlineTransferArtifact): Promise<void> {
128:     if (this.closed || this.sending) throw new Error('Transfer channel is closed or busy');
129:     v.parse(kindSchema, artifact.kind);
130:     if (
131:       !(artifact.bytes instanceof Uint8Array) ||
132:       artifact.bytes.length > artifactLimit(artifact.kind)
133:     )
134:       throw new RangeError('Transfer artifact exceeds its limit');
135:     if (!this.options.transport.peers().includes(this.options.peer))
136:       throw new Error('Transfer peer is not connected');
137:     if (this.nextId >= MAX_TRANSFERS) throw new Error('Transfer exchange limit reached');
138:     const bytes = new Uint8Array(artifact.bytes);
139:     const digest = toHex(sha256(bytes));
140:     const id = ++this.nextId;
141:     this.sending = true;
142:     try {
143:       const count = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
144:       for (let index = 0; index < count; index += 1) {
145:         if (this.closed) throw new Error('Transfer channel is closed');
146:         const frame = encode({
147:           type: 'data',
148:           scope: this.options.scope,
149:           id,
150:           index,
151:           kind: artifact.kind,
152:           length: bytes.length,
153:           digest,
154:           bytes: bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES),
155:         });
156:         // oxlint-disable-next-line no-await-in-loop -- One acknowledged chunk bounds the underlying data-channel queue.
157:         await new Promise<void>((resolve, reject) => {
158:           const pending: AwaitingAck = {
159:             id,
160:             index,
161:             frame,
162:             resolve,
163:             reject,
164:             attempts: 0,
165:             idleTimer: undefined,
166:             retryTimer: undefined,
167:           };
168:           this.awaiting = pending;
169:           pending.idleTimer = this.options.clock.setTimeout(
170:             () => this.fail(new Error('Transfer delivery timed out')),
171:             CHUNK_IDLE_MS,
172:           );
173:           this.transmit(pending);
174:         });
175:       }
176:     } catch (error) {
177:       this.fail(error instanceof Error ? error : new Error('Transfer delivery failed'));
178:       throw error;
179:     } finally {
180:       if (this.awaiting) this.clearAwaitingTimers(this.awaiting);
181:       this.awaiting = null;
182:       this.sending = false;
183:       bytes.fill(0);
184:     }
185:   }
186: 
187:   private receive(bytes: Uint8Array): void {
188:     if (this.closed || !MAGIC.every((byte, index) => bytes[index] === byte)) return;
189:     try {
190:       if (bytes.length > MAX_FRAME_BYTES) throw new RangeError('Transfer frame is oversized');
191:       const frame = v.parse(frameSchema, canonicalDecode(bytes.subarray(MAGIC.length)));
192:       if (frame.scope !== this.options.scope) return;
193:       if (frame.type === 'ack') {
194:         if (this.awaiting?.id === frame.id && this.awaiting.index === frame.index) {
195:           const pending = this.awaiting;
196:           this.awaiting = null;
197:           this.clearAwaitingTimers(pending);
198:           pending.resolve();
199:         }
200:         return;
201:       }
202:       this.receiveData(frame);
203:     } catch {
204:       this.fail(new Error('Invalid transfer frame'));
205:     }
206:   }
207: 
208:   private receiveData(frame: DataFrame): void {
209:     const expectedSize = Math.min(CHUNK_BYTES, frame.length - frame.index * CHUNK_BYTES);
210:     if (
211:       frame.length > artifactLimit(frame.kind) ||
212:       expectedSize < 0 ||
213:       frame.bytes.length !== expectedSize
214:     )
215:       throw new Error('Transfer chunk length differs');
216:     if (frame.id <= this.lastReceived) {
217:       this.acknowledgeCompletedDuplicate(frame);
218:       return;
219:     }
220:     if (!this.incoming) {
221:       if (frame.index !== 0) throw new Error('Transfer does not start with its first chunk');
222:       this.incoming = {
223:         first: { ...frame, bytes: new Uint8Array(0) },
224:         bytes: new Uint8Array(frame.length),
225:         nextIndex: 0,
226:         timer: undefined,
227:       };
228:       this.resetIncomingTimer(this.incoming);
229:     }
230:     const incoming = this.incoming;
231:     const first = incoming.first;
232:     if (
233:       frame.id !== first.id ||
234:       frame.kind !== first.kind ||
235:       frame.length !== first.length ||
236:       frame.digest !== first.digest
237:     )
238:       throw new Error('Transfer chunks do not match');
239:     if (frame.index < incoming.nextIndex) {
240:       if (!this.chunkMatches(incoming.bytes, frame))
241:         throw new Error('Transfer duplicate chunk differs');
242:       this.sendAck(frame);
243:       return;
244:     }
245:     if (frame.index !== incoming.nextIndex) throw new Error('Transfer chunks do not match');
246:     incoming.bytes.set(frame.bytes, frame.index * CHUNK_BYTES);
247:     incoming.nextIndex += 1;
248:     this.resetIncomingTimer(incoming);
249:     const complete = incoming.nextIndex * CHUNK_BYTES >= frame.length;
250:     if (complete) {
251:       if (toHex(sha256(incoming.bytes)) !== first.digest)
252:         throw new Error('Transfer artifact digest differs');
253:       this.options.clock.clearTimeout(incoming.timer);
254:       const start = frame.index * CHUNK_BYTES;
255:       this.completed = {
256:         id: frame.id,
257:         kind: first.kind,
258:         length: first.length,
259:         digest: first.digest,
260:         index: frame.index,
261:         bytes: new Uint8Array(incoming.bytes.subarray(start, start + frame.bytes.length)),
262:       };
263:       this.incoming = null;
264:       this.lastReceived = frame.id;
265:     }
266:     this.sendAck(frame);
267:     if (complete) this.options.onArtifact({ kind: first.kind, bytes: incoming.bytes });
268:   }
269: 
270:   private transmit(pending: AwaitingAck): void {
271:     if (this.closed || this.awaiting !== pending) return;
272:     try {
273:       this.options.transport.send(this.options.peer, pending.frame);
274:       pending.attempts += 1;
275:       if (this.awaiting === pending && pending.attempts < MAX_CHUNK_ATTEMPTS) {
276:         pending.retryTimer = this.options.clock.setTimeout(() => {
277:           pending.retryTimer = undefined;
278:           this.transmit(pending);
279:         }, RETRY_MS);
280:       }
281:     } catch (error) {
282:       this.fail(error instanceof Error ? error : new Error('Transfer send failed'));
283:     }
284:   }
285: 
286:   private clearAwaitingTimers(pending: AwaitingAck): void {
287:     this.options.clock.clearTimeout(pending.idleTimer);
288:     this.options.clock.clearTimeout(pending.retryTimer);
289:     pending.idleTimer = undefined;
290:     pending.retryTimer = undefined;
291:   }
292: 
293:   private resetIncomingTimer(incoming: Incoming): void {
294:     this.options.clock.clearTimeout(incoming.timer);
295:     incoming.timer = this.options.clock.setTimeout(
296:       () => this.fail(new Error('Transfer receive timed out')),
297:       CHUNK_IDLE_MS,
298:     );
299:   }
300: 
301:   private chunkMatches(buffer: Uint8Array, frame: DataFrame): boolean {
302:     const offset = frame.index * CHUNK_BYTES;
303:     if (frame.bytes.length !== Math.min(CHUNK_BYTES, buffer.length - offset)) return false;
304:     return frame.bytes.every((byte, index) => byte === buffer[offset + index]);
305:   }
306: 
307:   private acknowledgeCompletedDuplicate(frame: DataFrame): void {
308:     const completed = this.completed;
309:     if (!completed || frame.id !== completed.id) return;
310:     if (
311:       frame.kind !== completed.kind ||
312:       frame.length !== completed.length ||
313:       frame.digest !== completed.digest ||
314:       frame.index !== completed.index ||
315:       !frame.bytes.every((byte, index) => byte === completed.bytes[index]) ||
316:       frame.bytes.length !== completed.bytes.length
317:     )
318:       throw new Error('Completed transfer duplicate differs');
319:     this.sendAck(frame);
320:   }
321: 
322:   private sendAck(frame: DataFrame): void {
323:     this.options.transport.send(
324:       this.options.peer,
325:       encode({ type: 'ack', scope: frame.scope, id: frame.id, index: frame.index }),
326:     );
327:   }
328: 
329:   private fail(error: Error): void {
330:     if (this.closed) return;
331:     this.close(error);
332:     try {
333:       this.options.onError(error);
334:     } catch {
335:       /* A notification cannot interrupt channel cleanup. */
336:     }
337:   }
338: 
339:   close(error = new Error('Transfer channel closed')): void {
340:     if (this.closed) return;
341:     this.closed = true;
342:     for (const off of this.off) off();
343:     if (this.incoming) {
344:       this.options.clock.clearTimeout(this.incoming.timer);
345:       this.incoming.bytes.fill(0);
346:       this.incoming = null;
347:     }
348:     this.awaiting?.reject(error);
349:     if (this.awaiting) this.clearAwaitingTimers(this.awaiting);
350:     this.awaiting = null;
351:     this.completed?.bytes.fill(0);
352:     this.completed = null;
353:   }
354: }

## File: apps/web/src/session/online-transfer-destination.ts

1: import { canonicalDecode, canonicalEncode, sha256, toHex } from '@cp2p/codec';
2: import { identityFromSecret, signObject } from '@cp2p/crypto';
3: import { createBaseEngine } from '@cp2p/engine';
4: import type { Seat } from '@cp2p/engine';
5: import {
6:   genesisDigest,
7:   importTransferPrivate,
8:   replayCertifiedPrefix,
9:   restoreRetiredSafety,
10:   transferCheckDigest,
11:   transferEntryRef,
12:   TRANSFER_BOT_CHECK_DOMAIN,
13:   TRANSFER_DESTINATION_CHECK_DOMAIN,
14:   transferAuthorizationStatementSchema,
15:   transferChangeSchema,
16:   transferPrivateEnvelopeSchema,
17:   validateDeckCeremony,
18: } from '@cp2p/protocol';
19: import type {
20:   ReplayPolicy,
21:   SeatTransferAuthorization,
22:   SeatTransferAuthorizationStatement,
23:   TransferPrivateEnvelope,
24: } from '@cp2p/protocol';
25: import { IndexedDbByteStore, IndexedDbProtocolJournal, TransferImportStore } from '@cp2p/storage';
26: import * as v from 'valibot';
27: import type { DisposableOnlineIdentity } from './online-credentials.js';
28: import { saveOnlineGameRecord } from './online-game-records.js';
29: import {
30:   prepareOnlineTransferCredentials,
31:   type OnlineTransferCredentialScope,
32: } from './online-transfer-credentials.js';
33: import { loadActiveOnlineResume } from './online-resume-binding.js';
34: import {
35:   validateOnlineTransferBootstrap,
36:   type ExpectedOnlineTransferGame,
37:   type VerifiedOnlineTransferBootstrap,
38: } from './online-transfer-bootstrap.js';
39: 
40: const PROTOCOL = 'online-transfer-destination-v1';
41: const MAX_REFRESHES = 8;
42: const token = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));
43: const ref = v.strictObject({
44:   seq: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
45:   hash: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
46: });
47: const seatSchema = v.picklist([0, 1, 2, 3, 4, 5] as const);
48: const scopeSchema = v.strictObject({
49:   attemptId: token,
50:   genesisDigest: token,
51:   anchor: ref,
52:   validUntilSeq: v.pipe(
53:     v.number(),
54:     v.integer(),
55:     v.minValue(0),
56:     v.maxValue(Number.MAX_SAFE_INTEGER),
57:   ),
58:   mode: v.picklist(['live', 'return']),
59:   seat: seatSchema,
60:   currentController: transferAuthorizationStatementSchema.entries.currentController,
61:   recovery: transferAuthorizationStatementSchema.entries.recovery,
62:   nextEpoch: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
63:   devicePeer: token,
64:   replacements: v.pipe(
65:     v.array(
66:       v.strictObject({
67:         seat: seatSchema,
68:         oldPublicKey: token,
69:         newHostSeat: seatSchema,
70:       }),
71:     ),
72:     v.minLength(1),
73:     v.maxLength(6),
74:   ),
75: });
76: const locatorSchema = v.strictObject({
77:   protocol: v.literal(PROTOCOL),
78:   attemptId: token,
79:   gameId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22}$/)),
80:   genesisDigest: token,
81:   devicePeer: token,
82:   bootstrapKey: v.string(),
83:   refreshes: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_REFRESHES)),
84:   scope: v.nullable(scopeSchema),
85:   stageKey: v.nullable(v.string()),
86:   authorization: v.nullable(ref),
87:   finalBootstrapKey: v.nullable(v.string()),
88:   outcome: v.nullable(
89:     v.strictObject({
90:       authorization: ref,
91:       entry: ref,
92:       outcome: v.picklist(['activated', 'cancelled']),
93:     }),
94:   ),
95: });
96: 
97: type Locator = v.InferOutput<typeof locatorSchema>;
98: type TransferMode = SeatTransferAuthorizationStatement['mode'];
99: 
100: export interface OnlineTransferDestinationOptions {
101:   readonly attemptId: string;
102:   readonly mode: 'new' | 'resume' | 'open';
103:   readonly expected: ExpectedOnlineTransferGame;
104:   readonly identity: DisposableOnlineIdentity;
105:   readonly store: IndexedDbByteStore;
106:   readonly bootstrapBytes?: Uint8Array;
107:   readonly importStore?: TransferImportStore;
108:   /** Worker lifetime; abort prevents output after an asynchronous bootstrap step. */
109:   readonly signal?: AbortSignal;
110: }
111: 
112: export interface OnlineTransferDestinationSnapshot {
113:   readonly phase: 'prepared' | 'offered' | 'imported' | 'ready' | 'promoted' | 'cancelled';
114:   readonly gameId: string;
115:   readonly head: { readonly seq: number; readonly hash: string };
116:   readonly authorization: { readonly seq: number; readonly hash: string } | null;
117:   readonly outcome: {
118:     readonly authorization: { readonly seq: number; readonly hash: string };
119:     readonly entry: { readonly seq: number; readonly hash: string };
120:     readonly outcome: 'activated' | 'cancelled';
121:   } | null;
122: }
123: 
124: function equal(left: Uint8Array, right: Uint8Array): boolean {
125:   return left.length === right.length && left.every((byte, index) => byte === right[index]);
126: }
127: 
128: function wipeStage(stage: import('@cp2p/storage').TransferImportRecord | null): void {
129:   stage?.bindingBytes.fill(0);
130:   stage?.sealedPackage.fill(0);
131:   stage?.privateReplayBytes.fill(0);
132: }
133: 
134: function sameCanonical(left: unknown, right: unknown): boolean {
135:   const first = canonicalEncode(left);
136:   const second = canonicalEncode(right);
137:   try {
138:     return equal(first, second);
139:   } finally {
140:     first.fill(0);
141:     second.fill(0);
142:   }
143: }
144: 
145: function sameRef(
146:   left: { readonly seq: number; readonly hash: string },
147:   right: { readonly seq: number; readonly hash: string },
148: ): boolean {
149:   return left.seq === right.seq && left.hash === right.hash;
150: }
151: 
152: function policyFor(bootstrap: VerifiedOnlineTransferBootstrap): ReplayPolicy {
153:   return {
154:     genesis: {
155:       verifyCommitments(genesis) {
156:         return validateDeckCeremony(genesis, bootstrap.record.result.transcripts);
157:       },
158:     },
159:     entry: {},
160:   };
161: }
162: 
163: function verified(bytes: Uint8Array, expected: ExpectedOnlineTransferGame) {
164:   const result = validateOnlineTransferBootstrap(bytes, expected);
165:   if (!result.ok) throw new TypeError(`Invalid certified transfer bootstrap: ${result.error.code}`);
166:   return result.value;
167: }
168: 
169: function locatorKey(expected: ExpectedOnlineTransferGame, attemptId: string): string {
170:   return `online-transfer/destination/${expected.genesisDigest}/${attemptId}`;
171: }
172: 
173: function bootstrapKey(bytes: Uint8Array, attemptId: string): string {
174:   const digest = sha256(bytes);
175:   try {
176:     return `online-transfer/bootstrap/${attemptId}/${toHex(digest)}`;
177:   } finally {
178:     digest.fill(0);
179:   }
180: }
181: 
182: function credentialKey(scope: OnlineTransferCredentialScope): string {
183:   return `online-transfer-credentials/v1/${scope.genesisDigest}/${scope.devicePeer}/${scope.seat}/${scope.attemptId}`;
184: }
185: 
186: function parseLocator(bytes: Uint8Array, key: string): Locator {
187:   if (bytes.length > 16 * 1024) throw new TypeError('Transfer attempt locator is oversized');
188:   const parsed = v.parse(locatorSchema, canonicalDecode(bytes));
189:   const canonical = canonicalEncode(parsed);
190:   try {
191:     if (!equal(canonical, bytes) || !parsed.bootstrapKey.startsWith('online-transfer/bootstrap/'))
192:       throw new TypeError('Transfer attempt locator is not canonical');
193:     if (!key.endsWith(`/${parsed.attemptId}`))
194:       throw new TypeError('Transfer attempt locator is misplaced');
195:     return parsed;
196:   } finally {
197:     canonical.fill(0);
198:   }
199: }
200: 
201: function deriveScope(
202:   bootstrap: VerifiedOnlineTransferBootstrap,
203:   attemptId: string,
204:   devicePeer: string,
205:   seat: Seat,
206:   mode: TransferMode,
207: ): OnlineTransferCredentialScope {
208:   const context = bootstrap.replay.context.log;
209:   const authority = context.authority;
210:   const transfer = context.transfer;
211:   const controller = authority?.controllers.find((item) => item.seat === seat);
212:   if (
213:     !authority ||
214:     !transfer ||
215:     transfer.pending ||
216:     context.recovery?.pending ||
217:     context.state.result !== null ||
218:     !controller ||
219:     controller.status !== 'active'
220:   )
221:     throw new TypeError('Transfer offer requires an active certified parent');
222:   let controllers: typeof authority.controllers;
223:   let recovery: OnlineTransferCredentialScope['recovery'] = null;
224:   if (mode === 'live') {
225:     if (controller.kind !== 'human') throw new TypeError('Live transfer requires a human seat');
226:     controllers = [
227:       controller,
228:       ...authority.controllers.filter(
229:         (item) => item.kind === 'bot' && item.status === 'active' && item.hostSeat === seat,
230:       ),
231:     ];
232:   } else {
233:     const root = transfer.returnRoots.toReversed().find((item) => item.departedSeat === seat);
234:     if (
235:       controller.kind !== 'bot' ||
236:       !root?.activation ||
237:       !root.finalAuthorization ||
238:       !root.affectedSeats.includes(seat)
239:     )
240:       throw new TypeError('Return offer requires a certified recovery lineage');
241:     controllers = root.affectedSeats.flatMap((affected) => {
242:       const item = authority.controllers.find((candidate) => candidate.seat === affected);
243:       return item?.kind === 'bot' &&
244:         item.status === 'active' &&
245:         item.hostSeat === controller.hostSeat
246:         ? [item]
247:         : [];
248:     });
249:     if (controllers[0]?.seat !== seat)
250:       throw new TypeError('Returned seat is not the first eligible recovered seat');
251:     recovery = { authorization: root.finalAuthorization, activation: root.activation };
252:   }
253:   if (controllers.length === 0 || controllers.length > 6)
254:     throw new TypeError('Transfer replacement roster is unsupported');
255:   const anchor = transferEntryRef(context.head);
256:   return {
257:     attemptId,
258:     genesisDigest: genesisDigest(context.genesis),
259:     anchor,
260:     validUntilSeq: anchor.seq + 64,
261:     mode,
262:     seat,
263:     currentController: {
264:       publicKey: controller.publicKey,
265:       kind: controller.kind,
266:       activatedAt: controller.activatedAt,
267:       hostSeat: controller.hostSeat,
268:     },
269:     recovery,
270:     nextEpoch: authority.epoch + 1,
271:     devicePeer,
272:     replacements: controllers.map((item) => ({
273:       seat: item.seat,
274:       oldPublicKey: item.publicKey,
275:       newHostSeat: seat,
276:     })),
277:   };
278: }
279: 
280: /** A destination-side worker participant. Public methods never return private material. */
281: export class OnlineTransferDestination {
282:   readonly #options: OnlineTransferDestinationOptions;
283:   readonly #key: string;
284:   readonly #imports: TransferImportStore;
285:   #locator: Locator;
286:   #bootstrap: VerifiedOnlineTransferBootstrap;
287:   #closed = false;
288:   #phase: OnlineTransferDestinationSnapshot['phase'];
289:   #queue: Promise<unknown> = Promise.resolve();
290: 
291:   private constructor(
292:     options: OnlineTransferDestinationOptions,
293:     key: string,
294:     locator: Locator,
295:     bootstrap: VerifiedOnlineTransferBootstrap,
296:   ) {
297:     this.#options = options;
298:     this.#key = key;
299:     this.#locator = locator;
300:     this.#bootstrap = bootstrap;
301:     this.#imports = options.importStore ?? new TransferImportStore(options.store);
302:     this.#phase = locator.stageKey ? 'imported' : locator.scope ? 'offered' : 'prepared';
303:   }
304: 
305:   static async create(
306:     options: OnlineTransferDestinationOptions,
307:   ): Promise<OnlineTransferDestination> {
308:     const ensureActive = () => {
309:       if (options.signal?.aborted) throw new TypeError('Transfer destination was cancelled');
310:     };
311:     ensureActive();
312:     const key = locatorKey(options.expected, options.attemptId);
313:     const identity = identityFromSecret(new Uint8Array(options.identity.secretKey));
314:     try {
315:       if (identity.peerId !== options.identity.peerId)
316:         throw new TypeError('Transfer device identity is inconsistent');
317:     } finally {
318:       identity.secretKey.fill(0);
319:       identity.publicKey.fill(0);
320:     }
321:     let locator: Locator;
322:     if (options.mode === 'new' || options.mode === 'open') {
323:       const existing = await options.store.load(key);
324:       ensureActive();
325:       if (existing) {
326:         existing.fill(0);
327:         if (options.mode === 'new')
328:           throw new TypeError('Transfer attempt already exists; resume it explicitly');
329:       } else {
330:         if (!options.bootstrapBytes)
331:           throw new TypeError('New transfer requires certified bootstrap');
332:         verified(options.bootstrapBytes, options.expected);
333:         const image = new Uint8Array(options.bootstrapBytes);
334:         const imageKey = bootstrapKey(image, options.attemptId);
335:         try {
336:           ensureActive();
337:           await options.store.withCeremonyLock(key, async () => {
338:             ensureActive();
339:             const raced = await options.store.load(key);
340:             if (raced) {
341:               raced.fill(0);
342:               if (options.mode === 'new')
343:                 throw new TypeError('Transfer attempt already exists; resume it explicitly');
344:               return;
345:             }
346:             if (!(await options.store.putIfAbsent(imageKey, image))) {
347:               ensureActive();
348:               const prior = await options.store.load(imageKey);
349:               try {
350:                 if (!prior || !equal(prior, image))
351:                   throw new TypeError('Transfer bootstrap hash collision');
352:               } finally {
353:                 prior?.fill(0);
354:               }
355:             }
356:             const record: Locator = {
357:               protocol: PROTOCOL,
358:               attemptId: options.attemptId,
359:               gameId: options.expected.gameId,
360:               genesisDigest: options.expected.genesisDigest,
361:               devicePeer: options.identity.peerId,
362:               bootstrapKey: imageKey,
363:               refreshes: 0,
364:               scope: null,
365:               stageKey: null,
366:               authorization: null,
367:               finalBootstrapKey: null,
368:               outcome: null,
369:             };
370:             const bytes = canonicalEncode(record);
371:             try {
372:               ensureActive();
373:               if (!(await options.store.putIfAbsent(key, bytes)))
374:                 throw new TypeError('Transfer attempt changed during creation');
375:             } finally {
376:               bytes.fill(0);
377:             }
378:           });
379:         } finally {
380:           image.fill(0);
381:         }
382:       }
383:     } else if (options.bootstrapBytes) {
384:       throw new TypeError(
385:         'Resume loads its exact durable bootstrap; no supplied replacement is allowed',
386:       );
387:     }
388:     const saved = await options.store.load(key);
389:     ensureActive();
390:     if (!saved) throw new TypeError('Transfer attempt is absent');
391:     try {
392:       locator = parseLocator(saved, key);
393:     } finally {
394:       saved.fill(0);
395:     }
396:     if (
397:       locator.gameId !== options.expected.gameId ||
398:       locator.genesisDigest !== options.expected.genesisDigest ||
399:       locator.devicePeer !== options.identity.peerId ||
400:       locator.attemptId !== options.attemptId
401:     )
402:       throw new TypeError('Transfer attempt belongs to another game or device');
403:     const bootstrapBytes = await options.store.load(locator.bootstrapKey);
404:     ensureActive();
405:     if (!bootstrapBytes) throw new TypeError('Transfer attempt bootstrap is missing');
406:     try {
407:       if (locator.bootstrapKey !== bootstrapKey(bootstrapBytes, options.attemptId))
408:         throw new TypeError('Transfer attempt bootstrap key differs from its bytes');
409:       const participant = new OnlineTransferDestination(
410:         options,
411:         key,
412:         locator,
413:         verified(bootstrapBytes, options.expected),
414:       );
415:       if (locator.scope) {
416:         const credentials = await participant.#reservedCredentials(locator.scope);
417:         credentials.dispose();
418:       }
419:       await participant.#restorePhase();
420:       ensureActive();
421:       return participant;
422:     } finally {
423:       bootstrapBytes.fill(0);
424:     }
425:   }
426: 
427:   async #restorePhase(): Promise<void> {
428:     const authorization =
429:       this.#locator.authorization ??
430:       this.#locator.outcome?.authorization ??
431:       this.#bootstrap.replay.context.log.transfer?.pending;
432:     if (!authorization) return;
433:     const outcome = await this.#imports.readOutcome(this.#options.expected.gameId, authorization);
434:     if (outcome.kind !== 'missing') {
435:       let final = this.#bootstrap;
436:       if (this.#locator.finalBootstrapKey) {
437:         const bytes = await this.#options.store.load(this.#locator.finalBootstrapKey);
438:         if (!bytes) throw new TypeError('Final certified transfer bootstrap is missing');
439:         try {
440:           if (bootstrapKey(bytes, this.#options.attemptId) !== this.#locator.finalBootstrapKey)
441:             throw new TypeError('Final certified transfer bootstrap key is invalid');
442:           final = verified(bytes, this.#options.expected);
443:         } finally {
444:           bytes.fill(0);
445:         }
446:       } else if (!this.#locator.outcome) {
447:         throw new TypeError('Durable transfer outcome has no certified final bootstrap');
448:       }
449:       const kind = outcome.kind === 'promoted' ? 'activated' : 'cancelled';
450:       const entry = this.#finalEntry(final, authorization, kind, this.#locator.outcome !== null);
451:       if (outcome.kind === 'promoted') {
452:         if (!sameRef(outcome.activation, entry))
453:           throw new TypeError('Promoted outcome differs from certified activation');
454:         const active = await loadActiveOnlineResume({
455:           store: this.#options.store,
456:           record: final.record,
457:           engine: createBaseEngine(),
458:           devicePeer: this.#options.identity.peerId,
459:         });
460:         const expectedGame = this.#locator.scope?.replacements[0]?.seat;
461:         if (active.humanSeat !== expectedGame)
462:           throw new TypeError('Promoted destination seat differs from reserved transfer');
463:         const journal = new IndexedDbProtocolJournal(this.#options.expected.gameId);
464:         try {
465:           const saved = await journal.load();
466:           if (!saved?.entries.some((item) => sameRef(transferEntryRef(item.entry), entry)))
467:             throw new TypeError('Promoted activation is absent from the bound certified journal');
468:         } finally {
469:           await journal.close();
470:         }
471:       }
472:       if (this.#locator.outcome) {
473:         if (
474:           this.#locator.outcome.outcome !== kind ||
475:           !sameRef(this.#locator.outcome.authorization, authorization) ||
476:           !sameRef(this.#locator.outcome.entry, entry)
477:         )
478:           throw new TypeError('Stored transfer outcome differs from certified final entry');
479:         this.#bootstrap = final;
480:         this.#phase = kind === 'activated' ? 'promoted' : 'cancelled';
481:       } else {
482:         await this.#finish(final, authorization, entry, kind);
483:       }
484:       return;
485:     }
486:     if (this.#locator.outcome)
487:       throw new TypeError('Certified transfer outcome lost its durable final marker');
488:     if (outcome.kind === 'missing' && !this.#locator.authorization) return;
489:     if (!this.#locator.stageKey) throw new TypeError('Transfer authorization has no staged import');
490:     const stage = await this.#imports.load(this.#locator.stageKey);
491:     if (!stage) throw new TypeError('Transfer attempt points to an absent stage');
492:     try {
493:       if (!sameRef(stage.authorization, authorization))
494:         throw new TypeError('Transfer attempt points to a different authorization');
495:       this.#phase = (await this.#imports.loadReadiness(this.#locator.stageKey))
496:         ? 'ready'
497:         : 'imported';
498:     } finally {
499:       wipeStage(stage);
500:     }
501:   }
502: 
503:   #run<T>(task: () => Promise<T>): Promise<T> {
504:     const next = this.#queue.then(async () => {
505:       this.#ensureActive();
506:       return task();
507:     });
508:     this.#queue = next.catch(() => undefined);
509:     return next;
510:   }
511: 
512:   #ensureActive(): void {
513:     if (this.#closed || this.#options.signal?.aborted)
514:       throw new TypeError('Transfer destination is closed');
515:   }
516: 
517:   async #reservedCredentials(scope: OnlineTransferCredentialScope) {
518:     const saved = await this.#options.store.load(credentialKey(scope));
519:     if (!saved) throw new TypeError('Reserved transfer credentials are missing');
520:     saved.fill(0);
521:     this.#ensureActive();
522:     const credentials = await prepareOnlineTransferCredentials({
523:       store: this.#options.store,
524:       identity: this.#options.identity,
525:       scope,
526:     });
527:     try {
528:       this.#ensureActive();
529:       return credentials;
530:     } catch (error) {
531:       credentials.dispose();
532:       throw error;
533:     }
534:   }
535: 
536:   async #replace(update: (current: Locator) => Locator): Promise<void> {
537:     this.#ensureActive();
538:     await this.#options.store.withCeremonyLock(this.#key, async () => {
539:       this.#ensureActive();
540:       const prior = await this.#options.store.load(this.#key);
541:       if (!prior) throw new TypeError('Transfer attempt was removed');
542:       try {
543:         const current = parseLocator(prior, this.#key);
544:         const expected = canonicalEncode(this.#locator);
545:         try {
546:           if (!equal(prior, expected))
547:             throw new TypeError('Transfer attempt changed in another worker');
548:         } finally {
549:           expected.fill(0);
550:         }
551:         const next = update(current);
552:         const bytes = canonicalEncode(next);
553:         try {
554:           this.#ensureActive();
555:           if (!(await this.#options.store.compareAndSwap(this.#key, prior, bytes)))
556:             throw new TypeError('Transfer attempt changed during update');
557:           this.#locator = next;
558:         } finally {
559:           bytes.fill(0);
560:         }
561:       } finally {
562:         prior.fill(0);
563:       }
564:     });
565:   }
566: 
567:   async #pinFinalBootstrap(bytes: Uint8Array): Promise<string> {
568:     const key = bootstrapKey(bytes, this.#options.attemptId);
569:     if (this.#locator.finalBootstrapKey && this.#locator.finalBootstrapKey !== key)
570:       throw new TypeError('Transfer attempt has another certified final entry');
571:     if (this.#locator.finalBootstrapKey === key) return key;
572:     const image = new Uint8Array(bytes);
573:     try {
574:       this.#ensureActive();
575:       if (!(await this.#options.store.putIfAbsent(key, image))) {
576:         const prior = await this.#options.store.load(key);
577:         try {
578:           if (!prior || !equal(prior, image))
579:             throw new TypeError('Final transfer bootstrap hash collision');
580:         } finally {
581:           prior?.fill(0);
582:         }
583:       }
584:       await this.#replace((current) => ({ ...current, finalBootstrapKey: key }));
585:       return key;
586:     } finally {
587:       image.fill(0);
588:     }
589:   }
590: 
591:   #finalEntry(
592:     next: VerifiedOnlineTransferBootstrap,
593:     authorization: { readonly seq: number; readonly hash: string },
594:     outcome: 'activated' | 'cancelled',
595:     alreadyCurrent = false,
596:   ): { seq: number; hash: string } {
597:     if (
598:       !alreadyCurrent &&
599:       (next.entries.length !== this.#bootstrap.entries.length + 1 ||
600:         this.#bootstrap.entries.some((entry, index) => !sameCanonical(entry, next.entries[index])))
601:     )
602:       throw new TypeError('Final transfer entry is not the exact certified child');
603:     const certified = next.entries.at(-1);
604:     if (!certified) throw new TypeError('Final transfer entry is missing');
605:     const previous = next.entries.at(-2)?.entry ?? next.record.result.entry;
606:     const change =
607:       certified.entry.payload.kind === 'membership'
608:         ? v.safeParse(transferChangeSchema, certified.entry.payload.change)
609:         : null;
610:     if (
611:       !change?.success ||
612:       (outcome === 'activated'
613:         ? change.output.kind !== 'transfer-activate' ||
614:           !sameRef(change.output.statement.authorization, authorization)
615:         : change.output.kind !== 'transfer-cancel' ||
616:           !sameRef(change.output.authorization, authorization) ||
617:           !sameRef(change.output.parent, transferEntryRef(previous)))
618:     )
619:       throw new TypeError('Final certified entry differs from this transfer authorization');
620:     return transferEntryRef(certified.entry);
621:   }
622: 
623:   async #finish(
624:     next: VerifiedOnlineTransferBootstrap,
625:     authorization: { readonly seq: number; readonly hash: string },
626:     entry: { readonly seq: number; readonly hash: string },
627:     outcome: 'activated' | 'cancelled',
628:   ): Promise<void> {
629:     const key = this.#locator.finalBootstrapKey;
630:     if (!key) throw new TypeError('Final certified bootstrap was not durably pinned');
631:     const result = { authorization: { ...authorization }, entry: { ...entry }, outcome };
632:     await this.#replace((current) => ({
633:       ...current,
634:       bootstrapKey: key,
635:       finalBootstrapKey: null,
636:       authorization,
637:       outcome: result,
638:     }));
639:     this.#bootstrap = next;
640:     this.#phase = outcome === 'activated' ? 'promoted' : 'cancelled';
641:   }
642: 
643:   snapshot(): OnlineTransferDestinationSnapshot {
644:     const head = transferEntryRef(this.#bootstrap.replay.context.log.head);
645:     const authorization = this.#locator.authorization;
646:     return {
647:       phase: this.#phase,
648:       gameId: this.#options.expected.gameId,
649:       head,
650:       authorization,
651:       outcome: this.#locator.outcome
652:         ? {
653:             authorization: { ...this.#locator.outcome.authorization },
654:             entry: { ...this.#locator.outcome.entry },
655:             outcome: this.#locator.outcome.outcome,
656:           }
657:         : null,
658:     };
659:   }
660: 
661:   prepareOffer(input: {
662:     readonly seat: Seat;
663:     readonly mode: TransferMode;
664:   }): Promise<SeatTransferAuthorization> {
665:     return this.#run(async () => {
666:       if (this.#phase === 'promoted' || this.#phase === 'cancelled')
667:         throw new TypeError('Finalized transfer cannot prepare another offer');
668:       const scope: OnlineTransferCredentialScope =
669:         this.#locator.scope === null
670:           ? deriveScope(
671:               this.#bootstrap,
672:               this.#options.attemptId,
673:               this.#options.identity.peerId,
674:               input.seat,
675:               input.mode,
676:             )
677:           : this.#locator.scope;
678:       if (scope.seat !== input.seat || scope.mode !== input.mode)
679:         throw new TypeError('Transfer attempt is reserved for another seat or mode');
680:       const context = this.#bootstrap.replay.context.log;
681:       const pending = context.transfer?.pending;
682:       if (pending) {
683:         const outcome = await this.#imports.readOutcome(this.#options.expected.gameId, pending);
684:         if (outcome.kind !== 'missing')
685:           throw new TypeError('Transfer authorization was already finalized locally');
686:       }
687:       if (pending) {
688:         const approved = context.transfer?.authorizations.find((item) =>
689:           sameRef(item.entry, pending),
690:         );
691:         if (!approved) throw new TypeError('Certified transfer authorization is missing');
692:       } else if (
693:         !context.transfer?.recentHeads.some((item) => sameRef(item, scope.anchor)) ||
694:         context.head.seq > scope.validUntilSeq
695:       ) {
696:         throw new TypeError('Reserved transfer parent is no longer eligible');
697:       }
698:       this.#ensureActive();
699:       if (this.#locator.scope !== null) {
700:         const prior = await this.#options.store.load(credentialKey(scope));
701:         if (!prior) throw new TypeError('Reserved transfer credentials are missing');
702:         prior.fill(0);
703:       }
704:       const credentials = await prepareOnlineTransferCredentials({
705:         store: this.#options.store,
706:         identity: this.#options.identity,
707:         scope,
708:       });
709:       try {
710:         this.#ensureActive();
711:         if (pending) {
712:           const approved = context.transfer?.authorizations.find((item) =>
713:             sameRef(item.entry, pending),
714:           );
715:           if (!approved || !sameCanonical(approved.statement, credentials.authorization.statement))
716:             throw new TypeError('Certified authorization differs from reserved credentials');
717:         }
718:         if (this.#locator.scope === null) {
719:           await this.#replace((current) => ({ ...current, scope: v.parse(scopeSchema, scope) }));
720:           this.#phase = 'offered';
721:         }
722:         return credentials.authorization;
723:       } finally {
724:         credentials.dispose();
725:       }
726:     });
727:   }
728: 
729:   refreshBootstrap(bytes: Uint8Array): Promise<void> {
730:     return this.#run(async () => {
731:       if (this.#phase === 'promoted' || this.#phase === 'cancelled')
732:         throw new TypeError('Finalized transfer cannot refresh its parent');
733:       const next = verified(bytes, this.#options.expected);
734:       this.#ensureActive();
735:       const oldEntries = this.#bootstrap.entries;
736:       if (
737:         next.entries.length < oldEntries.length ||
738:         oldEntries.some((entry, index) => {
739:           const newer = next.entries[index];
740:           return !newer || !sameCanonical(entry, newer);
741:         })
742:       )
743:         throw new TypeError('Transfer bootstrap does not extend the certified prefix');
744:       if (this.#locator.scope) {
745:         const scope = this.#locator.scope;
746:         const transfer = next.replay.context.log.transfer;
747:         const authorization = this.#bootstrap.replay.context.log.transfer?.pending;
748:         const pending = transfer?.pending;
749:         if (pending) {
750:           if (authorization && !sameRef(pending, authorization))
751:             throw new TypeError('Certified prefix changed the pending transfer authorization');
752:           const approved = transfer.authorizations.find((item) => sameRef(item.entry, pending));
753:           if (!approved) throw new TypeError('Certified transfer authorization is missing');
754:           const credentials = await this.#reservedCredentials(scope);
755:           try {
756:             if (!sameCanonical(approved.statement, credentials.authorization.statement))
757:               throw new TypeError('Certified authorization differs from reserved credentials');
758:           } finally {
759:             credentials.dispose();
760:           }
761:         } else if (
762:           !transfer?.recentHeads.some((item) => sameRef(item, scope.anchor)) ||
763:           next.replay.context.log.head.seq > scope.validUntilSeq
764:         ) {
765:           throw new TypeError('Certified prefix invalidated reserved transfer scope');
766:         }
767:       }
768:       if (next.entries.length === oldEntries.length) return;
769:       if (this.#locator.refreshes >= MAX_REFRESHES)
770:         throw new TypeError('Transfer bootstrap refresh budget exhausted');
771:       const image = new Uint8Array(bytes);
772:       const key = bootstrapKey(image, this.#options.attemptId);
773:       let nextStageKey: string | null = null;
774:       try {
775:         if (this.#locator.stageKey) {
776:           const oldStage = await this.#imports.load(this.#locator.stageKey);
777:           if (!oldStage) throw new TypeError('Staged transfer import is missing');
778:           try {
779:             const oldHead = transferEntryRef(this.#bootstrap.replay.context.log.head);
780:             if (
781:               !sameRef(oldStage.head, oldHead) ||
782:               !this.#locator.authorization ||
783:               !sameRef(oldStage.authorization, this.#locator.authorization)
784:             )
785:               throw new TypeError('Staged transfer does not match its certified parent');
786:             const packet = v.parse(
787:               transferPrivateEnvelopeSchema,
788:               canonicalDecode(oldStage.sealedPackage),
789:             );
790:             const scope = this.#locator.scope;
791:             if (!scope) throw new TypeError('Staged transfer scope is missing');
792:             const credentials = await this.#reservedCredentials(scope);
793:             try {
794:               nextStageKey = await this.#stagePacket(next, packet, credentials, scope);
795:             } finally {
796:               credentials.dispose();
797:             }
798:           } finally {
799:             wipeStage(oldStage);
800:           }
801:         }
802:         await this.#options.store.withCeremonyLock(this.#key, async () => {
803:           this.#ensureActive();
804:           if (!(await this.#options.store.putIfAbsent(key, image))) {
805:             const prior = await this.#options.store.load(key);
806:             try {
807:               if (!prior || !equal(prior, image)) throw new TypeError('Bootstrap hash collision');
808:             } finally {
809:               prior?.fill(0);
810:             }
811:           }
812:         });
813:         await this.#replace((current) => ({
814:           ...current,
815:           bootstrapKey: key,
816:           refreshes: current.refreshes + 1,
817:           stageKey: nextStageKey,
818:         }));
819:         this.#ensureActive();
820:         this.#bootstrap = next;
821:         if (nextStageKey) this.#phase = 'imported';
822:       } finally {
823:         image.fill(0);
824:       }
825:     });
826:   }
827: 
828:   importPacket(packet: TransferPrivateEnvelope): Promise<void> {
829:     return this.#run(async () => {
830:       if (this.#phase === 'promoted' || this.#phase === 'cancelled')
831:         throw new TypeError('Finalized transfer cannot import another packet');
832:       if (this.#locator.stageKey) {
833:         const stage = await this.#imports.load(this.#locator.stageKey);
834:         if (!stage) throw new TypeError('Staged transfer import is missing');
835:         const encoded = canonicalEncode(v.parse(transferPrivateEnvelopeSchema, packet));
836:         try {
837:           if (
838:             !this.#locator.authorization ||
839:             !sameRef(stage.authorization, this.#locator.authorization) ||
840:             !sameRef(stage.head, transferEntryRef(this.#bootstrap.replay.context.log.head)) ||
841:             !equal(stage.sealedPackage, encoded)
842:           )
843:             throw new TypeError('Private import differs from the durable staged packet');
844:           return;
845:         } finally {
846:           encoded.fill(0);
847:           wipeStage(stage);
848:         }
849:       }
850:       const scope = this.#locator.scope;
851:       if (!scope) throw new TypeError('Transfer offer has not reserved a scope');
852:       const credentials = await this.#reservedCredentials(scope);
853:       try {
854:         const key = await this.#stagePacket(this.#bootstrap, packet, credentials, scope);
855:         const authorization = this.#bootstrap.replay.context.log.transfer?.pending;
856:         if (!authorization) throw new TypeError('Private import authorization disappeared');
857:         await this.#replace((current) => ({ ...current, stageKey: key, authorization }));
858:         this.#phase = 'imported';
859:       } finally {
860:         credentials.dispose();
861:       }
862:     });
863:   }
864: 
865:   async #stagePacket(
866:     bootstrap: VerifiedOnlineTransferBootstrap,
867:     packet: TransferPrivateEnvelope,
868:     credentials: Awaited<ReturnType<typeof prepareOnlineTransferCredentials>>,
869:     scope: OnlineTransferCredentialScope,
870:   ): Promise<string> {
871:     const context = bootstrap.replay.context.log;
872:     const authorization = context.transfer?.pending;
873:     const approved = context.transfer?.authorizations.find((item) =>
874:       authorization ? sameRef(item.entry, authorization) : false,
875:     );
876:     if (!authorization || !approved)
877:       throw new TypeError('Private import requires a certified pending authorization');
878:     if (!sameCanonical(approved.statement, credentials.authorization.statement))
879:       throw new TypeError('Certified authorization differs from reserved credentials');
880:     const imported = await importTransferPrivate({
881:       genesisEntry: bootstrap.record.result.entry,
882:       entries: bootstrap.entries,
883:       engine: createBaseEngine(),
884:       policy: policyFor(bootstrap),
885:       authorization,
886:       packet,
887:       destinationEncryptionSecret: credentials.encryptionSecret,
888:       importStore: this.#options.store,
889:     });
890:     if (!imported.ok) throw new TypeError(`Authenticated import failed: ${imported.error.code}`);
891:     let binding: Uint8Array | undefined;
892:     let sealed: Uint8Array | undefined;
893:     let replayBytes: Uint8Array | undefined;
894:     try {
895:       this.#ensureActive();
896:       const seats = credentials.keys.map(({ seat, peerId, signingKey }) => {
897:         const master = imported.value.masters.find((item) => item.seat === seat)?.master;
898:         if (!master) throw new TypeError('Imported master is missing for a replacement seat');
899:         return {
900:           seat,
901:           kind: seat === scope.seat ? ('human' as const) : ('bot' as const),
902:           peerId,
903:           signingKey,
904:           master,
905:         };
906:       });
907:       binding = canonicalEncode({
908:         protocol: 'online-game-keys-v1',
909:         genesisDigest: scope.genesisDigest,
910:         devicePeer: scope.devicePeer,
911:         humanSeat: scope.seat,
912:         seats,
913:       });
914:       sealed = canonicalEncode(packet);
915:       replayBytes = canonicalEncode({
916:         protocol: 'online-transfer-private-replay-v1',
917:         authorization,
918:         parent: transferEntryRef(context.head),
919:         seats: seats.map(({ seat }) => ({ seat, state: imported.value.driver.privateState(seat) })),
920:       });
921:       this.#ensureActive();
922:       const key = await this.#imports.stage(
923:         {
924:           gameId: this.#options.expected.gameId,
925:           authorization,
926:           destinationGameKey: credentials.authorization.statement.destination.gamePeer,
927:           bindingBytes: binding,
928:           sealedPackage: sealed,
929:           privateReplayBytes: replayBytes,
930:           genesis: bootstrap.record.result.entry,
931:           entries: bootstrap.entries,
932:         },
933:         createBaseEngine(),
934:         policyFor(bootstrap),
935:       );
936:       this.#ensureActive();
937:       return key;
938:     } finally {
939:       binding?.fill(0);
940:       sealed?.fill(0);
941:       replayBytes?.fill(0);
942:       imported.value.dispose();
943:     }
944:   }
945: 
946:   prepareReadiness(): Promise<{
947:     readonly kind: 'transfer-activate';
948:     readonly statement: import('@cp2p/storage').TransferReadinessRecord['statement'];
949:     readonly destinationCheck: string;
950:     readonly replacementChecks: readonly { readonly seat: Seat; readonly sig: string }[];
951:   }> {
952:     return this.#run(async () => {
953:       if (this.#phase === 'promoted' || this.#phase === 'cancelled')
954:         throw new TypeError('Finalized transfer cannot sign readiness');
955:       const scope = this.#locator.scope;
956:       const stageKey = this.#locator.stageKey;
957:       const authorization = this.#locator.authorization;
958:       if (!scope || !stageKey || !authorization)
959:         throw new TypeError('Transfer import has not been durably staged');
960:       const stage = await this.#imports.load(stageKey);
961:       if (!stage) throw new TypeError('Staged transfer import is missing');
962:       try {
963:         const context = this.#bootstrap.replay.context.log;
964:         if (
965:           !sameRef(stage.head, transferEntryRef(context.head)) ||
966:           !sameRef(stage.authorization, authorization)
967:         )
968:           throw new TypeError('Readiness parent differs from the staged certified head');
969:         const approved = context.transfer?.authorizations.find((item) =>
970:           sameRef(item.entry, authorization),
971:         );
972:         if (
973:           !approved ||
974:           !sameRef(context.transfer?.pending ?? { seq: -1, hash: '' }, authorization)
975:         )
976:           throw new TypeError('Readiness authorization is no longer pending');
977:         const credentials = await this.#reservedCredentials(scope);
978:         try {
979:           const statement = {
980:             protocol: 'seat-transfer-activation-v1' as const,
981:             genesisDigest: scope.genesisDigest,
982:             authorization,
983:             parent: stage.head,
984:             nextEpoch: approved.statement.nextEpoch,
985:             destinationDevice: approved.statement.destination.devicePeer,
986:             destinationGame: approved.statement.destination.gamePeer,
987:             replacements: approved.statement.replacements.map((replacement) => ({
988:               ...replacement,
989:             })),
990:             checkDigest: transferCheckDigest(context, authorization),
991:           };
992:           const first = credentials.keys[0];
993:           if (!first) throw new TypeError('Destination game key is missing');
994:           const readiness = {
995:             protocol: 'seat-transfer-readiness-v1' as const,
996:             statement,
997:             destinationCheck: signObject(
998:               TRANSFER_DESTINATION_CHECK_DOMAIN,
999:               statement,
1000:               first.signingKey,
1001:             ),
1002:             replacementChecks: credentials.keys.slice(1).map(({ seat, signingKey }) => ({
1003:               seat,
1004:               sig: signObject(TRANSFER_BOT_CHECK_DOMAIN, statement, signingKey),
1005:             })),
1006:           };
1007:           await this.#imports.saveReadiness(stageKey, readiness);
1008:           this.#ensureActive();
1009:           this.#phase = 'ready';
1010:           return {
1011:             kind: 'transfer-activate',
1012:             statement,
1013:             destinationCheck: readiness.destinationCheck,
1014:             replacementChecks: readiness.replacementChecks,
1015:           };
1016:         } finally {
1017:           credentials.dispose();
1018:         }
1019:       } finally {
1020:         wipeStage(stage);
1021:       }
1022:     });
1023:   }
1024: 
1025:   observeActivation(bytes: Uint8Array): Promise<string> {
1026:     return this.#run(async () => {
1027:       if (this.#phase === 'promoted' && this.#locator.outcome?.outcome === 'activated') {
1028:         const repeated = verified(bytes, this.#options.expected);
1029:         if (
1030:           repeated.entries.length !== this.#bootstrap.entries.length ||
1031:           repeated.entries.some(
1032:             (item, index) => !sameCanonical(item, this.#bootstrap.entries[index]),
1033:           )
1034:         )
1035:           throw new TypeError('Repeated activation differs from certified final bootstrap');
1036:         return this.#options.expected.gameId;
1037:       }
1038:       const stageKey = this.#locator.stageKey;
1039:       const authorization = this.#locator.authorization;
1040:       if (!stageKey || !authorization) throw new TypeError('Transfer import is not staged');
1041:       const next = verified(bytes, this.#options.expected);
1042:       const outcome = await this.#imports.readOutcome(this.#options.expected.gameId, authorization);
1043:       if (outcome.kind === 'cancelled') {
1044:         this.#phase = 'cancelled';
1045:         throw new TypeError('Transfer authorization was cancelled');
1046:       }
1047:       const stage = await this.#imports.load(stageKey);
1048:       try {
1049:         const stagedEntries = stage?.entries ?? this.#bootstrap.entries;
1050:         if (
1051:           next.entries.length !== stagedEntries.length + 1 ||
1052:           stagedEntries.some(
1053:             (entry, index) =>
1054:               !next.entries[index] ||
1055:               !equal(canonicalEncode(entry), canonicalEncode(next.entries[index])),
1056:           )
1057:         )
1058:           throw new TypeError('Activation must be the exact certified child of staged import');
1059:         const activation = next.entries.at(-1);
1060:         if (!activation) throw new TypeError('Certified activation entry is missing');
1061:         const change =
1062:           activation.entry.payload.kind === 'membership'
1063:             ? v.safeParse(transferChangeSchema, activation.entry.payload.change)
1064:             : null;
1065:         if (
1066:           !change?.success ||
1067:           change.output.kind !== 'transfer-activate' ||
1068:           !sameRef(change.output.statement.authorization, authorization)
1069:         )
1070:           throw new TypeError('Certified child is not this transfer activation');
1071:         const activationRef = this.#finalEntry(next, authorization, 'activated');
1072:         await this.#pinFinalBootstrap(bytes);
1073:         if (outcome.kind === 'promoted') {
1074:           if (!sameRef(outcome.activation, activationRef))
1075:             throw new TypeError('Transfer was promoted with another activation');
1076:           const active = await loadActiveOnlineResume({
1077:             store: this.#options.store,
1078:             record: next.record,
1079:             engine: createBaseEngine(),
1080:             devicePeer: this.#options.identity.peerId,
1081:           });
1082:           if (active.gamePeer !== change.output.statement.destinationGame)
1083:             throw new TypeError('Promoted journal binding differs from certified destination');
1084:           const journal = new IndexedDbProtocolJournal(this.#options.expected.gameId);
1085:           try {
1086:             const saved = await journal.load();
1087:             if (
1088:               !saved?.entries.some((entry) =>
1089:                 sameRef(transferEntryRef(entry.entry), outcome.activation),
1090:               )
1091:             )
1092:               throw new TypeError('Promoted activation is absent from the bound certified journal');
1093:           } finally {
1094:             await journal.close();
1095:           }
1096:           await this.#finish(next, authorization, activationRef, 'activated');
1097:           return this.#options.expected.gameId;
1098:         }
1099:         if (!stage) throw new TypeError('Staged transfer import is missing');
1100:         // The public start is independently validated and indexed before any voter journal appears.
1101:         await saveOnlineGameRecord(this.#options.store, {
1102:           invite: next.record.invite,
1103:           agreement: next.record.agreement,
1104:           result: next.record.result,
1105:         });
1106:         this.#ensureActive();
1107:         const bindingKey = `online-game/${this.#options.expected.genesisDigest}/keys`;
1108:         const oldBinding = await this.#options.store.load(bindingKey);
1109:         let expectedActive: {
1110:           head: { seq: number; hash: string };
1111:           bindingBytes: Uint8Array;
1112:         } | null = null;
1113:         try {
1114:           if (oldBinding) {
1115:             if (oldBinding.length > 16 * 1024)
1116:               throw new TypeError('Existing game binding is oversized');
1117:             const oldJournal = new IndexedDbProtocolJournal(this.#options.expected.gameId, {
1118:               keyBinding: { recordKey: bindingKey, bytes: oldBinding },
1119:             });
1120:             try {
1121:               const saved = await oldJournal.load();
1122:               if (
1123:                 !saved ||
1124:                 !sameCanonical(saved.genesis, stage.genesis) ||
1125:                 saved.entries.length > next.entries.length ||
1126:                 saved.entries.some((entry, index) => !sameCanonical(entry, next.entries[index]))
1127:               )
1128:                 throw new TypeError('Existing journal is not a certified prefix of activation');
1129:               const replayed = replayCertifiedPrefix(
1130:                 saved.genesis,
1131:                 saved.entries,
1132:                 createBaseEngine(),
1133:                 policyFor(next),
1134:               );
1135:               if (!replayed.ok)
1136:                 throw new TypeError(`Existing journal did not replay: ${replayed.error.code}`);
1137:               const approved = next.replay.context.log.transfer?.authorizations.find((item) =>
1138:                 sameRef(item.entry, authorization),
1139:               );
1140:               const oldKey =
1141:                 approved?.statement.mode === 'live'
1142:                   ? approved.statement.currentController.publicKey
1143:                   : next.replay.context.log.transfer?.returnRoots
1144:                       .toReversed()
1145:                       .find((item) => item.departedSeat === approved?.statement.seat)
1146:                       ?.lastHumanGameKey;
1147:               if (!oldKey || !approved)
1148:                 throw new TypeError('Certified retired controller identity is unavailable');
1149:               let marker: unknown;
1150:               try {
1151:                 marker = canonicalDecode(saved.safety.bytes);
1152:               } catch {
1153:                 throw new TypeError('Existing journal is not retired');
1154:               } finally {
1155:                 saved.safety.bytes.fill(0);
1156:               }
1157:               const retired = restoreRetiredSafety(
1158:                 marker,
1159:                 replayed.value.context,
1160:                 approved.statement.seat,
1161:                 oldKey,
1162:               );
1163:               if (!retired.ok)
1164:                 throw new TypeError(`Existing journal is not retired: ${retired.error.code}`);
1165:               const prior = saved.entries.at(-1)?.entry ?? saved.genesis;
1166:               expectedActive = { head: transferEntryRef(prior), bindingBytes: oldBinding };
1167:             } finally {
1168:               await oldJournal.close();
1169:             }
1170:           }
1171:           const journal = new IndexedDbProtocolJournal(this.#options.expected.gameId, {
1172:             keyBinding: {
1173:               recordKey: bindingKey,
1174:               bytes: stage.bindingBytes,
1175:             },
1176:           });
1177:           try {
1178:             if (
1179:               !(await journal.promoteTransfer({
1180:                 stageKey,
1181:                 activation,
1182:                 engine: createBaseEngine(),
1183:                 policy: policyFor(next),
1184:                 expectedActive,
1185:               }))
1186:             )
1187:               throw new TypeError('Transfer promotion lost its durable race');
1188:           } finally {
1189:             await journal.close();
1190:           }
1191:         } finally {
1192:           oldBinding?.fill(0);
1193:         }
1194:         this.#ensureActive();
1195:         await this.#finish(next, authorization, activationRef, 'activated');
1196:         return this.#options.expected.gameId;
1197:       } finally {
1198:         wipeStage(stage);
1199:       }
1200:     });
1201:   }
1202: 
1203:   /** Certified cancellation closes every staged parent and leaves voting state untouched. */
1204:   observeCancellation(bytes: Uint8Array): Promise<void> {
1205:     return this.#run(async () => {
1206:       if (this.#phase === 'cancelled' && this.#locator.outcome?.outcome === 'cancelled') {
1207:         const repeated = verified(bytes, this.#options.expected);
1208:         if (
1209:           repeated.entries.length !== this.#bootstrap.entries.length ||
1210:           repeated.entries.some(
1211:             (item, index) => !sameCanonical(item, this.#bootstrap.entries[index]),
1212:           )
1213:         )
1214:           throw new TypeError('Repeated cancellation differs from certified final bootstrap');
1215:         return;
1216:       }
1217:       if (this.#phase === 'promoted')
1218:         throw new TypeError('Promoted transfer cannot be cancelled locally');
1219:       const scope = this.#locator.scope;
1220:       if (!scope) throw new TypeError('Transfer offer has no reserved credentials');
1221:       const prior = await this.#options.store.load(credentialKey(scope));
1222:       if (!prior) throw new TypeError('Transfer credentials are absent');
1223:       prior.fill(0);
1224:       const context = this.#bootstrap.replay.context.log;
1225:       const authorization = context.transfer?.pending;
1226:       const approved = context.transfer?.authorizations.find((item) =>
1227:         authorization ? sameRef(item.entry, authorization) : false,
1228:       );
1229:       if (!authorization || !approved)
1230:         throw new TypeError('Cancellation requires a certified pending authorization');
1231:       const credentials = await this.#reservedCredentials(scope);
1232:       try {
1233:         if (!sameCanonical(approved.statement, credentials.authorization.statement))
1234:           throw new TypeError('Cancellation authorization differs from reserved credentials');
1235:       } finally {
1236:         credentials.dispose();
1237:       }
1238:       const next = verified(bytes, this.#options.expected);
1239:       if (
1240:         next.entries.length !== this.#bootstrap.entries.length + 1 ||
1241:         this.#bootstrap.entries.some((entry, index) => !sameCanonical(entry, next.entries[index]))
1242:       )
1243:         throw new TypeError('Cancellation must be the exact certified child of the pending parent');
1244:       const cancelled = next.entries.at(-1);
1245:       if (!cancelled) throw new TypeError('Certified cancellation entry is missing');
1246:       const change =
1247:         cancelled.entry.payload.kind === 'membership'
1248:           ? v.safeParse(transferChangeSchema, cancelled.entry.payload.change)
1249:           : null;
1250:       if (
1251:         !change?.success ||
1252:         change.output.kind !== 'transfer-cancel' ||
1253:         !sameRef(change.output.authorization, authorization) ||
1254:         !sameRef(change.output.parent, transferEntryRef(context.head))
1255:       )
1256:         throw new TypeError('Certified child does not cancel this exact authorization');
1257:       const cancellationRef = this.#finalEntry(next, authorization, 'cancelled');
1258:       await this.#pinFinalBootstrap(bytes);
1259:       await this.#imports.cancelCertified({
1260:         gameId: this.#options.expected.gameId,
1261:         authorization,
1262:         genesis: next.record.result.entry,
1263:         entries: next.entries,
1264:         engine: createBaseEngine(),
1265:         policy: policyFor(next),
1266:       });
1267:       this.#ensureActive();
1268:       await this.#finish(next, authorization, cancellationRef, 'cancelled');
1269:     });
1270:   }
1271: 
1272:   async close(): Promise<void> {
1273:     this.#closed = true;
1274:     await this.#queue;
1275:   }
1276: }

## File: apps/web/src/session/online-worker-messages.ts

1: import type { CommandShape, GameEvent, LegalCommandSet, PrivateState, Seat } from '@cp2p/engine';
2: import type {
3:   Genesis,
4:   LobbyFreezeAgreement,
5:   LobbyState,
6:   P2PSession,
7:   RecoveryApprovalPreview,
8:   SeatTransferAuthorization,
9:   SessionUpdate,
10:   TransferPrivateEnvelope,
11: } from '@cp2p/protocol';
12: import type { OnlineInvite } from './online-invite.js';
13: import type { OnlineDeviceRoutes } from './online-game-transport.js';
14: import type { OnlineStartupSnapshot } from './online-startup.js';
15: import type { ExpectedOnlineTransferGame } from './online-transfer-bootstrap.js';
16: import type {
17:   OnlineTransferDestination,
18:   OnlineTransferDestinationSnapshot,
19: } from './online-transfer-destination.js';
20: 
21: export const ONLINE_WORKER_PROTOCOL = 'cp2p-online-worker-v1' as const;
22: export const MAX_ONLINE_WORKER_REQUEST_BYTES = 1_048_576;
23: export const MAX_ONLINE_WORKER_PENDING_REQUESTS = 16;
24: export const MAX_ONLINE_WORKER_SNAPSHOT_BYTES = 16 * 1024 * 1024;
25: 
26: export interface OnlineWorkerHead {
27:   readonly seq: number;
28:   readonly hash: string;
29: }
30: 
31: export type OnlineWorkerRequestBody =
32:   | {
33:       readonly kind: 'initializeTransfer';
34:       readonly self: string;
35:       readonly attemptId: string;
36:       readonly mode: 'new' | 'resume' | 'open';
37:       readonly expected: ExpectedOnlineTransferGame;
38:       readonly bootstrapBytes?: Uint8Array;
39:     }
40:   | { readonly kind: 'transferSnapshot' }
41:   | { readonly kind: 'prepareTransferOffer'; readonly seat: Seat; readonly mode: 'live' | 'return' }
42:   | { readonly kind: 'refreshTransferBootstrap'; readonly bootstrapBytes: Uint8Array }
43:   | { readonly kind: 'importTransferPacket'; readonly packet: TransferPrivateEnvelope }
44:   | { readonly kind: 'prepareTransferReadiness' }
45:   | { readonly kind: 'observeTransferActivation'; readonly bootstrapBytes: Uint8Array }
46:   | { readonly kind: 'observeTransferCancellation'; readonly bootstrapBytes: Uint8Array }
47:   | { readonly kind: 'exportTransferBootstrap'; readonly throughSeq?: number }
48:   | { readonly kind: 'transferStatus'; readonly authorization?: OnlineWorkerHead }
49:   | {
50:       readonly kind: 'authorizeLiveTransfer';
51:       readonly offer: unknown;
52:       readonly head: OnlineWorkerHead;
53:     }
54:   | { readonly kind: 'submitTransfer'; readonly change: unknown; readonly head: OnlineWorkerHead }
55:   | { readonly kind: 'prepareTransferPrivate'; readonly authorization: OnlineWorkerHead }
56:   | {
57:       readonly kind: 'initialize';
58:       readonly self: string;
59:       readonly mode: 'fresh';
60:       readonly invite: OnlineInvite;
61:     }
62:   | {
63:       readonly kind: 'initialize';
64:       readonly self: string;
65:       readonly mode: 'resume';
66:       readonly gameId: string;
67:     }
68:   | {
69:       readonly kind: 'attachTransport';
70:       readonly self: string;
71:       readonly peers: readonly string[];
72:       readonly port: MessagePort;
73:     }
74:   | { readonly kind: 'pinFreeze'; readonly state: LobbyState }
75:   | { readonly kind: 'startCeremony'; readonly agreement: LobbyFreezeAgreement }
76:   | { readonly kind: 'retryStart' }
77:   | {
78:       readonly kind: 'validate';
79:       readonly seat: Seat;
80:       readonly head: OnlineWorkerHead;
81:       readonly command: CommandShape;
82:     }
83:   | {
84:       readonly kind: 'submit';
85:       readonly seat: Seat;
86:       readonly head: OnlineWorkerHead;
87:       readonly command: CommandShape;
88:     }
89:   | {
90:       readonly kind: 'setPrivateVisible';
91:       readonly visible: boolean;
92:       readonly visibilityToken: number;
93:     }
94:   | { readonly kind: 'exportSave' }
95:   | { readonly kind: 'retryAudit' }
96:   | { readonly kind: 'ackSession'; readonly snapshotId: number }
97:   | { readonly kind: 'approveRecoveryAuthorization'; readonly change: unknown }
98:   | { readonly kind: 'clearRecoveryApproval' }
99:   | {
100:       readonly kind: 'requestTakeover';
101:       readonly departedSeat: Seat;
102:       readonly botLevel: 'easy' | 'medium' | 'hard';
103:     }
104:   | { readonly kind: 'cancelPending'; readonly seat: Seat }
105:   | { readonly kind: 'shutdown' };
106: 
107: export interface OnlineWorkerRequest {
108:   readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
109:   readonly generation: string;
110:   readonly id: number;
111:   readonly body: OnlineWorkerRequestBody;
112: }
113: 
114: export interface OnlineWorkerResumeInfo {
115:   readonly gameId: string;
116:   readonly genesisDigest: string;
117:   readonly agreement: LobbyFreezeAgreement;
118:   readonly genesis: Genesis;
119:   /** Active human device routes derived from this device's certified journal. */
120:   readonly peers: readonly string[];
121: }
122: 
123: export interface OnlineWorkerInitialization {
124:   readonly self: string;
125:   readonly invite: OnlineInvite;
126:   readonly resume: OnlineWorkerResumeInfo | null;
127: }
128: 
129: export interface OnlineWorkerReplyByKind {
130:   initializeTransfer: OnlineTransferDestinationSnapshot;
131:   transferSnapshot: OnlineTransferDestinationSnapshot;
132:   prepareTransferOffer: SeatTransferAuthorization;
133:   refreshTransferBootstrap: OnlineTransferDestinationSnapshot;
134:   importTransferPacket: OnlineTransferDestinationSnapshot;
135:   prepareTransferReadiness: Awaited<ReturnType<OnlineTransferDestination['prepareReadiness']>>;
136:   observeTransferActivation: {
137:     readonly gameId: string;
138:     readonly snapshot: OnlineTransferDestinationSnapshot;
139:   };
140:   observeTransferCancellation: OnlineTransferDestinationSnapshot;
141:   exportTransferBootstrap: Uint8Array;
142:   transferStatus: ReturnType<P2PSession['getTransferStatus']>;
143:   authorizeLiveTransfer: SeatTransferAuthorization;
144:   submitTransfer: void;
145:   prepareTransferPrivate: TransferPrivateEnvelope;
146:   initialize: OnlineWorkerInitialization;
147:   attachTransport: void;
148:   pinFreeze: { readonly freezeHash: string };
149:   startCeremony: void;
150:   retryStart: void;
151:   validate: void;
152:   submit: void;
153:   setPrivateVisible: void;
154:   exportSave: unknown;
155:   retryAudit: boolean;
156:   ackSession: void;
157:   approveRecoveryAuthorization: RecoveryApprovalPreview;
158:   clearRecoveryApproval: void;
159:   requestTakeover: void;
160:   cancelPending: boolean;
161:   shutdown: void;
162: }
163: 
164: export type OnlineWorkerReply = {
165:   [K in keyof OnlineWorkerReplyByKind]: {
166:     readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
167:     readonly generation: string;
168:     readonly id: number;
169:     readonly kind: K;
170:     readonly result:
171:       | { readonly ok: true; readonly value: OnlineWorkerReplyByKind[K] }
172:       | {
173:           readonly ok: false;
174:           readonly error: {
175:             readonly code: string;
176:             readonly message: string;
177:             readonly savedVersion?: number;
178:           };
179:         };
180:   };
181: }[keyof OnlineWorkerReplyByKind];
182: 
183: /** A complete public snapshot. `events` is full history, unlike `update.events`. */
184: export interface OnlineWorkerSessionSnapshot {
185:   readonly committedHead: OnlineWorkerHead;
186:   readonly update: SessionUpdate;
187:   readonly events: readonly GameEvent[];
188:   readonly localHumanSeat: Seat;
189:   readonly privateState: PrivateState | null;
190:   readonly legal: LegalCommandSet | null;
191:   readonly controllableSeats: readonly Seat[];
192:   readonly visibilityToken: number;
193: }
194: 
195: export type OnlineWorkerEvent =
196:   | {
197:       readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
198:       readonly generation: string;
199:       readonly kind: 'deviceRoutes';
200:       readonly routes: OnlineDeviceRoutes;
201:     }
202:   | {
203:       readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
204:       readonly generation: string;
205:       readonly kind: 'startup';
206:       readonly snapshot: OnlineStartupSnapshot | null;
207:     }
208:   | {
209:       readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
210:       readonly generation: string;
211:       readonly kind: 'gameReady';
212:       readonly game: { readonly gameId: string; readonly genesis: Genesis; readonly seat: Seat };
213:     }
214:   | {
215:       readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
216:       readonly generation: string;
217:       readonly kind: 'session';
218:       readonly snapshotId: number;
219:       readonly snapshot: OnlineWorkerSessionSnapshot;
220:     }
221:   | {
222:       readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
223:       readonly generation: string;
224:       readonly kind: 'fatal';
225:       readonly error: { readonly code: string; readonly message: string };
226:     };

## File: apps/web/src/queries/online-transfers.ts

1: import { useMutation } from '@tanstack/react-query';
2: import { acquireGameWriterLease, IndexedDbByteStore } from '@cp2p/storage';
3: import { loadOnlineConnectionSettings } from './network.js';
4: import { loadOrCreateOnlineIdentity } from '../session/online-credentials.js';
5: import { OnlineTransferBrowser } from '../session/online-transfer-browser.js';
6: import type { OnlineTransferInvite } from '../session/online-transfer-link.js';
7: import { OnlineWorkerClient } from '../session/online-worker-client.js';
8: import type { OnlineRoomHandleValue } from '../features/online/room-registry.js';
9: 
10: export function useSourceTransfer(room: OnlineRoomHandleValue) {
11:   return useMutation({
12:     mutationFn: async () => {
13:       if (!room.startTransfer) throw new Error('Device transfer is unavailable');
14:       return room.startTransfer(await loadOnlineConnectionSettings());
15:     },
16:   });
17: }
18: 
19: export interface DestinationTransferHandle {
20:   readonly browser: OnlineTransferBrowser;
21:   close(): Promise<void>;
22: }
23: 
24: /** An explicit user action opens the isolated importer; no game signer runs here. */
25: export async function openDestinationTransfer(
26:   invite: OnlineTransferInvite,
27: ): Promise<DestinationTransferHandle> {
28:   const network = await loadOnlineConnectionSettings();
29:   const store = new IndexedDbByteStore();
30:   let identity: Awaited<ReturnType<typeof loadOrCreateOnlineIdentity>> | null = null;
31:   let worker: OnlineWorkerClient | null = null;
32:   let lease: Awaited<ReturnType<typeof acquireGameWriterLease>> = null;
33:   let browser: OnlineTransferBrowser | null = null;
34:   let leaseLost = false;
35:   let closing: Promise<void> | null = null;
36:   const close = () => {
37:     if (closing) return closing;
38:     closing = (async () => {
39:       try {
40:         try {
41:           await browser?.close();
42:         } finally {
43:           await worker?.shutdown();
44:         }
45:       } finally {
46:         identity?.dispose();
47:         try {
48:           await lease?.close();
49:         } finally {
50:           await store.close();
51:         }
52:       }
53:     })();
54:     return closing;
55:   };
56:   try {
57:     identity = await loadOrCreateOnlineIdentity(store);
58:     lease = await acquireGameWriterLease(`transfer-${invite.body.attemptId}`, identity.peerId, {
59:       onLost: () => {
60:         leaseLost = true;
61:         void browser?.close().catch(() => undefined);
62:         worker?.fail(new Error('Transfer opened elsewhere'));
63:       },
64:     });
65:     if (!lease) throw new Error('This transfer is already open in another tab');
66:     if (leaseLost) throw new Error('Transfer opened elsewhere');
67:     worker = new OnlineWorkerClient();
68:     browser = await OnlineTransferBrowser.openDestination({
69:       invite,
70:       identity,
71:       store,
72:       worker,
73:       network,
74:       clock: {
75:         now: () => performance.now(),
76:         setTimeout: (callback, delay) => window.setTimeout(callback, delay),
77:         clearTimeout: (handle) => {
78:           if (typeof handle === 'number') window.clearTimeout(handle);
79:         },
80:       },
81:     });
82:     if (leaseLost) throw new Error('Transfer opened elsewhere');
83:     return { browser, close };
84:   } catch (error) {
85:     await close().catch(() => undefined);
86:     throw error;
87:   }
88: }
89: 
90: export function useDestinationTransfer() {
91:   return useMutation({ mutationFn: openDestinationTransfer });
92: }

## File: apps/web/src/session/online-transfer-exchange.test.ts

1: import { canonicalDecode, canonicalEncode, toBase64Url } from '@cp2p/codec';
2: import type { Result } from '@cp2p/engine';
3: import type { SeatTransferAuthorization, TransferPrivateEnvelope } from '@cp2p/protocol';
4: import { expect, test } from 'vitest';
5: import type { OnlineTransferArtifact } from './online-transfer-channel.js';
6: import { DestinationTransferExchange, SourceTransferExchange } from './online-transfer-exchange.js';
7: import type {
8:   OnlineTransferExchangeRecord,
9:   TransferExchangeWorker,
10: } from './online-transfer-exchange.js';
11: import type { OnlineWorkerReplyByKind, OnlineWorkerRequestBody } from './online-worker-messages.js';
12: 
13: const key = (byte: number) => toBase64Url(new Uint8Array(32).fill(byte));
14: const sig = toBase64Url(new Uint8Array(64).fill(9));
15: const head = (seq: number) => ({ seq, hash: seq.toString(16).padStart(64, '0') });
16: const sourceDevice = key(1);
17: const destinationDevice = key(2);
18: const destinationGame = key(3);
19: const digest = key(4);
20: const authorization = head(11);
21: const offer: SeatTransferAuthorization = {
22:   kind: 'transfer-authorize',
23:   statement: {
24:     protocol: 'seat-transfer-v1',
25:     genesisDigest: digest,
26:     anchor: head(10),
27:     validUntilSeq: 74,
28:     mode: 'live',
29:     seat: 0,
30:     currentController: {
31:       publicKey: key(5),
32:       kind: 'human',
33:       activatedAt: head(0),
34:       hostSeat: 0,
35:     },
36:     recovery: null,
37:     nextEpoch: 1,
38:     destination: {
39:       devicePeer: destinationDevice,
40:       gamePeer: destinationGame,
41:       transferEncryptionKey: key(6),
42:     },
43:     replacements: [
44:       { seat: 0, oldPublicKey: key(5), newPublicKey: destinationGame, newHostSeat: 0 },
45:     ],
46:   },
47:   destinationDeviceSig: sig,
48:   destinationGameSig: sig,
49:   replacementKeySigs: [],
50: };
51: const approved: SeatTransferAuthorization = {
52:   ...offer,
53:   ownerIntent: { signer: 'current-game', sig },
54: };
55: const readiness = {
56:   kind: 'transfer-activate' as const,
57:   statement: {
58:     protocol: 'seat-transfer-activation-v1' as const,
59:     genesisDigest: digest,
60:     authorization,
61:     parent: authorization,
62:     nextEpoch: 1,
63:     destinationDevice,
64:     destinationGame,
65:     replacements: offer.statement.replacements,
66:     checkDigest: 'a'.repeat(64),
67:   },
68:   destinationCheck: sig,
69:   replacementChecks: [],
70: };
71: const packet: TransferPrivateEnvelope = {
72:   protocol: 'seat-transfer-private-v1',
73:   genesisDigest: digest,
74:   authorization,
75:   sourceParent: authorization,
76:   sourceSeat: 0,
77:   sourceSigner: { kind: 'current-controller', publicKey: key(5) },
78:   destinationDevice,
79:   destinationGame,
80:   affectedSeats: [0],
81:   nonce: key(7),
82:   sealed: { ephemeral: key(8), ciphertext: 'a' },
83:   ciphertextHash: 'b'.repeat(64),
84:   sourceSig: sig,
85: };
86: 
87: function record(role: 'source' | 'destination'): OnlineTransferExchangeRecord {
88:   return {
89:     protocol: 'online-transfer-exchange-v1',
90:     role,
91:     attemptId: key(10),
92:     gameId: 'a'.repeat(22),
93:     genesisDigest: digest,
94:     sourceDevice,
95:     destinationDevice,
96:     seat: 0,
97:     offer: null,
98:     approved: null,
99:     authorization: null,
100:   };
101: }
102: 
103: function sourceRecord(): OnlineTransferExchangeRecord & { role: 'source' } {
104:   return { ...record('source'), role: 'source' };
105: }
106: 
107: function destinationRecord(): OnlineTransferExchangeRecord & { role: 'destination' } {
108:   return { ...record('destination'), role: 'destination' };
109: }
110: 
111: function required<T>(item: T | undefined): T {
112:   if (item === undefined) throw new Error('Expected exchange test value');
113:   return item;
114: }
115: 
116: function artifact(kind: OnlineTransferArtifact['kind'], value: unknown): OnlineTransferArtifact {
117:   return { kind, bytes: canonicalEncode(value) };
118: }
119: 
120: function worker(respond: (body: OnlineWorkerRequestBody) => unknown): TransferExchangeWorker {
121:   return {
122:     async request<K extends OnlineWorkerRequestBody['kind']>(
123:       body: Extract<OnlineWorkerRequestBody, { kind: K }>,
124:     ): Promise<Result<OnlineWorkerReplyByKind[K]>> {
125:       // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Test fake maps each request to its matching reply below.
126:       return { ok: true, value: respond(body) as OnlineWorkerReplyByKind[K] };
127:     },
128:   };
129: }
130: 
131: test('source waits for explicit consent, durably records approval, and retries exact certified outcome after retirement', async () => {
132:   const calls: string[] = [];
133:   const sent: OnlineTransferArtifact[] = [];
134:   const saved: OnlineTransferExchangeRecord[] = [];
135:   let pending = false;
136:   let activated = false;
137:   const source = new SourceTransferExchange({
138:     record: sourceRecord(),
139:     channel: {
140:       async send(item) {
141:         sent.push({ kind: item.kind, bytes: new Uint8Array(item.bytes) });
142:       },
143:     },
144:     worker: worker((body) => {
145:       calls.push(body.kind);
146:       // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- This fake rejects requests outside the source exchange API.
147:       switch (body.kind) {
148:         case 'transferStatus':
149:           return {
150:             head: pending ? (activated ? head(12) : authorization) : head(10),
151:             pending:
152:               pending && !activated ? { entry: authorization, statement: offer.statement } : null,
153:             outcome:
154:               activated && body.authorization
155:                 ? { authorization, outcome: 'activated', entry: head(12) }
156:                 : null,
157:           };
158:         case 'authorizeLiveTransfer':
159:           return approved;
160:         case 'submitTransfer':
161:           if (body.change && typeof body.change === 'object' && 'kind' in body.change) {
162:             if (body.change.kind === 'transfer-authorize') pending = true;
163:             if (body.change.kind === 'transfer-activate') activated = true;
164:           }
165:           return undefined;
166:         case 'exportTransferBootstrap':
167:           return Uint8Array.of(body.throughSeq ?? 99);
168:         case 'prepareTransferPrivate':
169:           return packet;
170:         default:
171:           throw new Error(`Unexpected source request ${body.kind}`);
172:       }
173:     }),
174:     async savePublicRecord(next) {
175:       saved.push(structuredClone(next));
176:     },
177:   });
178:   await source.start();
179:   await source.receive(artifact('offer', offer));
180:   expect(source.snapshot().phase).toBe('awaiting-confirmation');
181:   expect(calls).toEqual(['exportTransferBootstrap']);
182:   expect(saved.at(-1)?.offer).toEqual(offer);
183:   await source.confirm();
184:   expect(saved.at(-1)?.authorization).toEqual(authorization);
185:   expect(sent.map((item) => item.kind)).toEqual(['bootstrap', 'authorized', 'private']);
186:   expect(calls.indexOf('submitTransfer')).toBeGreaterThan(calls.indexOf('authorizeLiveTransfer'));
187:   await source.receive(artifact('readiness', readiness));
188:   expect(source.snapshot().phase).toBe('awaiting-receipt');
189:   expect(sent.slice(-2).map((item) => item.kind)).toEqual(['authorized', 'activated']);
190:   expect([...required(sent.at(-2)).bytes]).toEqual([11]);
191:   expect([...required(sent.at(-1)).bytes]).toEqual([12]);
192:   await expect(
193:     source.receive(
194:       artifact('received', {
195:         protocol: 'online-transfer-received-v1',
196:         destinationDevice,
197:         authorization,
198:         outcome: 'activated',
199:         entry: head(13),
200:       }),
201:     ),
202:   ).rejects.toThrow(/matching certified outcome/);
203:   expect(source.snapshot().phase).toBe('awaiting-receipt');
204:   await source.receive(
205:     artifact('received', {
206:       protocol: 'online-transfer-received-v1',
207:       destinationDevice,
208:       authorization,
209:       outcome: 'activated',
210:       entry: head(12),
211:     }),
212:   );
213:   expect(source.snapshot().phase).toBe('activated');
214:   const restarted = new SourceTransferExchange({
215:     record: { ...required(saved.at(-1)), role: 'source' },
216:     channel: {
217:       async send(item) {
218:         sent.push(item);
219:       },
220:     },
221:     worker: worker((body) => {
222:       if (body.kind === 'transferStatus')
223:         return {
224:           head: head(12),
225:           pending: null,
226:           outcome: { authorization, outcome: 'activated', entry: head(12) },
227:         };
228:       if (body.kind === 'exportTransferBootstrap') return Uint8Array.of(body.throughSeq ?? 99);
229:       throw new Error('Retired source must not sign or submit again');
230:     }),
231:     async savePublicRecord() {
232:       throw new Error('No new decision expected');
233:     },
234:   });
235:   await restarted.retry();
236:   expect(sent.slice(-2).map((item) => item.kind)).toEqual(['authorized', 'activated']);
237: });
238: 
239: test('source rejects offer replacement and a failed durable approval before any submit or private disclosure', async () => {
240:   const calls: string[] = [];
241:   const sent: OnlineTransferArtifact[] = [];
242:   const source = new SourceTransferExchange({
243:     record: sourceRecord(),
244:     channel: {
245:       async send(item) {
246:         sent.push(item);
247:       },
248:     },
249:     worker: worker((body) => {
250:       calls.push(body.kind);
251:       if (body.kind === 'transferStatus') return { head: head(10), pending: null, outcome: null };
252:       if (body.kind === 'authorizeLiveTransfer') return approved;
253:       throw new Error('Approval was not persisted');
254:     }),
255:     async savePublicRecord(next) {
256:       if (next.approved) throw new Error('Storage failed');
257:     },
258:   });
259:   await source.receive(artifact('offer', offer));
260:   await expect(
261:     source.receive(
262:       artifact('offer', {
263:         ...offer,
264:         statement: {
265:           ...offer.statement,
266:           destination: { ...offer.statement.destination, gamePeer: key(20) },
267:         },
268:       }),
269:     ),
270:   ).rejects.toThrow(/changed/);
271:   await expect(source.confirm()).rejects.toThrow(/Storage failed/);
272:   expect(calls).toEqual(['transferStatus', 'authorizeLiveTransfer']);
273:   expect(sent).toEqual([]);
274: });
275: 
276: test('source never reports local cancellation after an approved request with an uncertain certificate', async () => {
277:   let pending = false;
278:   let cancelled = false;
279:   const sent: OnlineTransferArtifact[] = [];
280:   const source = new SourceTransferExchange({
281:     record: { ...sourceRecord(), offer, approved },
282:     channel: {
283:       async send(item) {
284:         sent.push(item);
285:       },
286:     },
287:     worker: worker((body) => {
288:       if (body.kind === 'transferStatus')
289:         return {
290:           head: cancelled ? head(12) : pending ? authorization : head(10),
291:           pending:
292:             pending && !cancelled ? { entry: authorization, statement: offer.statement } : null,
293:           outcome: cancelled ? { authorization, outcome: 'cancelled', entry: head(12) } : null,
294:         };
295:       if (body.kind === 'submitTransfer') {
296:         if (
297:           !body.change ||
298:           typeof body.change !== 'object' ||
299:           !('kind' in body.change) ||
300:           body.change.kind !== 'transfer-cancel'
301:         )
302:           throw new Error('Expected certified cancel');
303:         cancelled = true;
304:         return undefined;
305:       }
306:       if (body.kind === 'exportTransferBootstrap') return Uint8Array.of(body.throughSeq ?? 99);
307:       throw new Error('Cancellation must not sign or disclose private material');
308:     }),
309:     async savePublicRecord() {
310:       return undefined;
311:     },
312:   });
313:   await expect(source.cancel()).rejects.toThrow(/uncertain/);
314:   expect(source.snapshot().phase).toBe('connecting');
315:   expect(sent).toEqual([]);
316:   pending = true;
317:   await source.cancel();
318:   expect(source.snapshot().record.authorization).toEqual(authorization);
319:   expect(source.snapshot().phase).toBe('awaiting-receipt');
320:   expect(sent.map((item) => item.kind)).toEqual(['authorized', 'cancelled']);
321: });
322: 
323: test('stale readiness gets a fresh certified parent instead of being submitted', async () => {
324:   const sent: OnlineTransferArtifact[] = [];
325:   const source = new SourceTransferExchange({
326:     record: { ...sourceRecord(), offer, approved, authorization },
327:     channel: {
328:       async send(item) {
329:         sent.push(item);
330:       },
331:     },
332:     worker: worker((body) => {
333:       if (body.kind === 'transferStatus')
334:         return {
335:           head: head(12),
336:           pending: { entry: authorization, statement: offer.statement },
337:           outcome: null,
338:         };
339:       if (body.kind === 'exportTransferBootstrap') return Uint8Array.of(12);
340:       throw new Error('Stale readiness must not be certified');
341:     }),
342:     async savePublicRecord() {
343:       throw new Error('No new decision expected');
344:     },
345:   });
346:   await source.receive(artifact('readiness', readiness));
347:   expect(sent.map((item) => item.kind)).toEqual(['authorized']);
348:   expect(source.snapshot().phase).toBe('awaiting-readiness');
349: });
350: 
351: test('destination delegates import and promotion to worker and shuts it down before opening the game', async () => {
352:   const steps: string[] = [];
353:   const sent: OnlineTransferArtifact[] = [];
354:   let stage: 'offered' | 'imported' = 'offered';
355:   const destination = new DestinationTransferExchange({
356:     record: destinationRecord(),
357:     expected: { gameId: 'a'.repeat(22), genesisDigest: digest },
358:     channel: {
359:       async send(item) {
360:         sent.push({ kind: item.kind, bytes: new Uint8Array(item.bytes) });
361:       },
362:     },
363:     worker: worker((body) => {
364:       steps.push(body.kind);
365:       // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- This fake rejects requests outside the destination exchange API.
366:       switch (body.kind) {
367:         case 'initializeTransfer':
368:           return {
369:             phase: 'prepared',
370:             gameId: 'a'.repeat(22),
371:             head: head(10),
372:             authorization: null,
373:             outcome: null,
374:           };
375:         case 'prepareTransferOffer':
376:           return offer;
377:         case 'refreshTransferBootstrap':
378:           return {
379:             phase: stage,
380:             gameId: 'a'.repeat(22),
381:             head: authorization,
382:             authorization: stage === 'imported' ? authorization : null,
383:             outcome: null,
384:           };
385:         case 'transferSnapshot':
386:           return {
387:             phase: stage,
388:             gameId: 'a'.repeat(22),
389:             head: authorization,
390:             authorization: stage === 'imported' ? authorization : null,
391:             outcome: null,
392:           };
393:         case 'importTransferPacket':
394:           stage = 'imported';
395:           return {
396:             phase: stage,
397:             gameId: 'a'.repeat(22),
398:             head: authorization,
399:             authorization,
400:             outcome: null,
401:           };
402:         case 'prepareTransferReadiness':
403:           return readiness;
404:         case 'observeTransferActivation':
405:           return {
406:             gameId: 'a'.repeat(22),
407:             snapshot: {
408:               phase: 'promoted',
409:               gameId: 'a'.repeat(22),
410:               head: head(12),
411:               authorization,
412:               outcome: { authorization, outcome: 'activated', entry: head(12) },
413:             },
414:           };
415:         default:
416:           throw new Error(`Unexpected destination request ${body.kind}`);
417:       }
418:     }),
419:     async savePublicRecord() {
420:       steps.push('save');
421:     },
422:     async shutdownWorker() {
423:       steps.push('shutdown');
424:     },
425:     async onPromoted(gameId) {
426:       expect(gameId).toBe('a'.repeat(22));
427:       steps.push('promoted');
428:     },
429:   });
430:   await destination.receive({ kind: 'bootstrap', bytes: Uint8Array.of(1) });
431:   await destination.receive({ kind: 'authorized', bytes: Uint8Array.of(2) });
432:   await destination.receive(artifact('private', packet));
433:   expect(sent.map((item) => item.kind)).toEqual(['offer', 'readiness']);
434:   expect(canonicalDecode(required(sent.at(-1)).bytes)).toEqual(readiness);
435:   await destination.receive(artifact('private', packet));
436:   expect(steps.filter((step) => step === 'importTransferPacket')).toHaveLength(2);
437:   await destination.receive({ kind: 'authorized', bytes: Uint8Array.of(4) });
438:   expect(steps.filter((step) => step === 'importTransferPacket')).toHaveLength(2);
439:   expect(sent.at(-1)?.kind).toBe('readiness');
440:   await destination.receive({ kind: 'activated', bytes: Uint8Array.of(3) });
441:   expect(steps.slice(-3)).toEqual(['observeTransferActivation', 'shutdown', 'promoted']);
442:   expect(sent.at(-1)?.kind).toBe('received');
443:   expect(destination.snapshot().phase).toBe('activated');
444:   const requestsAfterPromotion = steps.length;
445:   await destination.receive({ kind: 'authorized', bytes: Uint8Array.of(4) });
446:   expect(steps).toHaveLength(requestsAfterPromotion);
447:   expect(sent.at(-1)?.kind).toBe('received');
448: });
449: 
450: test('destination sends a cancellation receipt only after verified certified evidence', async () => {
451:   const steps: string[] = [];
452:   const sent: OnlineTransferArtifact[] = [];
453:   let exactOutcome = false;
454:   const destination = new DestinationTransferExchange({
455:     record: destinationRecord(),
456:     expected: { gameId: 'a'.repeat(22), genesisDigest: digest },
457:     channel: {
458:       async send(item) {
459:         sent.push(item);
460:       },
461:     },
462:     worker: worker((body) => {
463:       steps.push(body.kind);
464:       if (body.kind === 'initializeTransfer')
465:         return {
466:           phase: 'prepared',
467:           gameId: 'a'.repeat(22),
468:           head: head(10),
469:           authorization: null,
470:           outcome: null,
471:         };
472:       if (body.kind === 'prepareTransferOffer') return offer;
473:       if (body.kind === 'observeTransferCancellation')
474:         return {
475:           phase: 'cancelled',
476:           gameId: 'a'.repeat(22),
477:           head: head(12),
478:           authorization,
479:           outcome: exactOutcome
480:             ? { authorization, entry: head(12), outcome: 'cancelled' }
481:             : { authorization, entry: head(13), outcome: 'cancelled' },
482:         };
483:       throw new Error('Unexpected destination request');
484:     }),
485:     async savePublicRecord() {
486:       steps.push('save');
487:     },
488:     async shutdownWorker() {
489:       steps.push('shutdown');
490:     },
491:     onPromoted() {
492:       throw new Error('A cancelled transfer cannot promote');
493:     },
494:   });
495:   await destination.receive({ kind: 'bootstrap', bytes: Uint8Array.of(1) });
496:   await expect(destination.receive({ kind: 'cancelled', bytes: Uint8Array.of(2) })).rejects.toThrow(
497:     /did not verify this exact certified outcome/,
498:   );
499:   expect(sent.map((item) => item.kind)).toEqual(['offer']);
500:   expect(steps).not.toContain('shutdown');
501:   exactOutcome = true;
502:   await destination.receive({ kind: 'cancelled', bytes: Uint8Array.of(2) });
503:   expect(sent.at(-1)?.kind).toBe('received');
504:   expect(canonicalDecode(required(sent.at(-1)).bytes)).toMatchObject({
505:     authorization,
506:     entry: head(12),
507:     outcome: 'cancelled',
508:   });
509:   expect(destination.snapshot().phase).toBe('cancelled');
510: });
511: 
512: test('destination completes promotion after a lost final receipt and reconnect without using its stopped worker', async () => {
513:   const calls: string[] = [];
514:   const sent: OnlineTransferArtifact[] = [];
515:   let failReceipt = true;
516:   const destination = new DestinationTransferExchange({
517:     record: destinationRecord(),
518:     expected: { gameId: 'a'.repeat(22), genesisDigest: digest },
519:     channel: {
520:       async send(item) {
521:         sent.push(item);
522:         if (item.kind === 'received' && failReceipt) {
523:           failReceipt = false;
524:           throw new Error('connection replaced before receipt ack');
525:         }
526:       },
527:     },
528:     worker: worker((body) => {
529:       calls.push(body.kind);
530:       if (body.kind === 'initializeTransfer')
531:         return {
532:           phase: 'prepared',
533:           gameId: 'a'.repeat(22),
534:           head: head(10),
535:           authorization: null,
536:           outcome: null,
537:         };
538:       if (body.kind === 'prepareTransferOffer') return offer;
539:       if (body.kind === 'observeTransferActivation')
540:         return {
541:           gameId: 'a'.repeat(22),
542:           snapshot: {
543:             phase: 'promoted',
544:             gameId: 'a'.repeat(22),
545:             head: head(12),
546:             authorization,
547:             outcome: { authorization, entry: head(12), outcome: 'activated' },
548:           },
549:         };
550:       throw new Error('Stopped destination worker was called after finalization');
551:     }),
552:     async savePublicRecord() {
553:       calls.push('save');
554:     },
555:     async shutdownWorker() {
556:       calls.push('shutdown');
557:     },
558:     async onPromoted() {
559:       calls.push('promoted');
560:     },
561:   });
562:   await destination.receive({ kind: 'bootstrap', bytes: Uint8Array.of(1) });
563:   await expect(destination.receive({ kind: 'activated', bytes: Uint8Array.of(2) })).rejects.toThrow(
564:     /connection replaced/,
565:   );
566:   expect(calls).toContain('shutdown');
567:   expect(calls).not.toContain('promoted');
568:   await destination.receive({ kind: 'bootstrap', bytes: Uint8Array.of(1) });
569:   expect(destination.snapshot().phase).toBe('activated');
570:   expect(calls.filter((call) => call === 'promoted')).toHaveLength(1);
571:   expect(sent.filter((item) => item.kind === 'received')).toHaveLength(2);
572:   await destination.retry();
573:   expect(calls.filter((call) => call === 'promoted')).toHaveLength(1);
574:   expect(calls.filter((call) => call === 'transferSnapshot')).toHaveLength(0);
575: });

## File: apps/web/src/session/online-transfer-browser.test.ts

1: import { identityFromSecret } from '@cp2p/crypto';
2: import { MemoryEscrowLifecycleStore, VirtualClock } from '@cp2p/protocol/testing';
3: import { afterEach, expect, test, vi } from 'vitest';
4: import type { OnlineWorkerClient } from './online-worker-client.js';
5: import { OnlineTransferBrowser } from './online-transfer-browser.js';
6: import { createTransferInvite, OnlineTransferLink } from './online-transfer-link.js';
7: import type { OnlineTransferLinkOptions } from './online-transfer-link.js';
8: 
9: afterEach(() => vi.restoreAllMocks());
10: 
11: test('an error from a replaced transfer link cannot clear the current browser connection', async () => {
12:   const source = identityFromSecret(new Uint8Array(32).fill(71));
13:   const destination = identityFromSecret(new Uint8Array(32).fill(72));
14:   const invite = createTransferInvite({
15:     attemptId: 'A'.repeat(43),
16:     gameId: 'b'.repeat(22),
17:     seat: 0,
18:     genesisDigest: 'C'.repeat(43),
19:     roomId: 'transferac',
20:     serverUrl: 'wss://signal.example/',
21:     identity: { ...source, dispose: () => source.secretKey.fill(0) },
22:   });
23:   const callbacks: OnlineTransferLinkOptions[] = [];
24:   const closed: boolean[] = [];
25:   vi.spyOn(OnlineTransferLink, 'openDestination').mockImplementation((options) => {
26:     const index = callbacks.push(options) - 1;
27:     closed.push(false);
28:     // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The browser test exercises only close and callback ownership, not WebRTC internals.
29:     return {
30:       close: () => {
31:         closed[index] = true;
32:       },
33:     } as OnlineTransferLink;
34:   });
35:   let shutdowns = 0;
36:   // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only shutdown is used before a channel authenticates.
37:   const worker = {
38:     shutdown: async () => {
39:       shutdowns += 1;
40:     },
41:   } as OnlineWorkerClient;
42:   const browser = await OnlineTransferBrowser.openDestination({
43:     invite,
44:     identity: { ...destination, dispose: () => destination.secretKey.fill(0) },
45:     store: new MemoryEscrowLifecycleStore(),
46:     worker,
47:     clock: new VirtualClock(),
48:     network: {},
49:   });
50:   try {
51:     expect(callbacks).toHaveLength(1);
52:     await browser.retry();
53:     expect(callbacks).toHaveLength(2);
54:     expect(closed[0]).toBe(true);
55:     callbacks[0]?.onError(new Error('stale link failure'));
56:     expect(browser.getSnapshot().error).toBeNull();
57:     callbacks[1]?.onError(new Error('current link failure'));
58:     expect(browser.getSnapshot().error).toBe('current link failure');
59:   } finally {
60:     await browser.close();
61:     source.secretKey.fill(0);
62:     destination.secretKey.fill(0);
63:   }
64:   expect(shutdowns).toBe(1);
65: });

## File: apps/web/src/session/online-transfer-records.test.ts

1: import { identityFromSecret } from '@cp2p/crypto';
2: import { MemoryEscrowLifecycleStore } from '@cp2p/protocol/testing';
3: import { expect, test } from 'vitest';
4: import { createTransferInvite } from './online-transfer-link.js';
5: import {
6:   loadCurrentTransferInvite,
7:   OnlineTransferRecordStore,
8:   saveCurrentTransferInvite,
9: } from './online-transfer-records.js';
10: import type { OnlineTransferExchangeRecord } from './online-transfer-records.js';
11: 
12: test('public transfer decisions survive reload and cannot switch destination or signed invitation', async () => {
13:   const source = identityFromSecret(new Uint8Array(32).fill(81));
14:   const destination = identityFromSecret(new Uint8Array(32).fill(82));
15:   const other = identityFromSecret(new Uint8Array(32).fill(83));
16:   const store = new MemoryEscrowLifecycleStore();
17:   try {
18:     const invite = createTransferInvite({
19:       identity: { ...source, dispose: () => source.secretKey.fill(0) },
20:       attemptId: 'A'.repeat(43),
21:       gameId: 'g'.repeat(22),
22:       genesisDigest: 'B'.repeat(43),
23:       seat: 0,
24:       serverUrl: 'wss://example.com',
25:       roomId: 'transferaa',
26:     });
27:     const records = new OnlineTransferRecordStore(store, source.peerId, invite, 'source');
28:     const record: OnlineTransferExchangeRecord = {
29:       protocol: 'online-transfer-exchange-v1',
30:       role: 'source',
31:       attemptId: invite.body.attemptId,
32:       gameId: invite.body.gameId,
33:       genesisDigest: invite.body.genesisDigest,
34:       sourceDevice: source.peerId,
35:       destinationDevice: destination.peerId,
36:       seat: 0,
37:       offer: null,
38:       approved: null,
39:       authorization: null,
40:     };
41:     await records.save(record);
42:     const restored = new OnlineTransferRecordStore(store, source.peerId, invite, 'source');
43:     expect(await restored.load()).toEqual({ record, finished: false });
44:     await expect(restored.save({ ...record, destinationDevice: other.peerId })).rejects.toThrow(
45:       'pinned',
46:     );
47:     await expect(restored.save({ ...record, seat: 1 })).rejects.toThrow('invitation');
48:     await expect(
49:       restored.save({ ...record, authorization: { seq: 3, hash: 'a'.repeat(64) } }),
50:     ).rejects.toThrow('chosen offer');
51:     expect(await records.load()).toEqual({ record, finished: false });
52:     const changedInvite = createTransferInvite({
53:       ...invite.body,
54:       identity: { ...source, dispose: () => source.secretKey.fill(0) },
55:       genesisDigest: 'C'.repeat(43),
56:     });
57:     await expect(
58:       new OnlineTransferRecordStore(store, source.peerId, changedInvite, 'source').load(),
59:     ).rejects.toThrow('another invitation');
60:   } finally {
61:     source.secretKey.fill(0);
62:     destination.secretKey.fill(0);
63:     other.secretKey.fill(0);
64:   }
65: });
66: 
67: test('the game locator preserves unfinished attempts and permits replacement only after finish', async () => {
68:   const source = identityFromSecret(new Uint8Array(32).fill(84));
69:   const store = new MemoryEscrowLifecycleStore();
70:   try {
71:     const identity = { ...source, dispose: () => source.secretKey.fill(0) };
72:     const input = {
73:       identity,
74:       gameId: 'h'.repeat(22),
75:       genesisDigest: 'D'.repeat(43),
76:       seat: 0 as const,
77:       serverUrl: 'wss://example.com',
78:       roomId: 'transferab',
79:     };
80:     const first = createTransferInvite({ ...input, attemptId: 'E'.repeat(43) });
81:     const second = createTransferInvite({ ...input, attemptId: 'F'.repeat(43) });
82:     await saveCurrentTransferInvite(store, source.peerId, first);
83:     await saveCurrentTransferInvite(store, source.peerId, first);
84:     await expect(saveCurrentTransferInvite(store, source.peerId, second)).rejects.toThrow(
85:       'progress',
86:     );
87:     expect(await loadCurrentTransferInvite(store, source.peerId, input.gameId)).toEqual(first);
88:     const records = new OnlineTransferRecordStore(store, source.peerId, first, 'source');
89:     await records.finish();
90:     await saveCurrentTransferInvite(store, source.peerId, second);
91:     expect(await loadCurrentTransferInvite(store, source.peerId, input.gameId)).toEqual(second);
92:     expect((await records.load()).finished).toBe(true);
93:   } finally {
94:     source.secretKey.fill(0);
95:   }
96: });

## File: apps/web/src/queries/online-transfers.test.ts

1: import { beforeEach, expect, test, vi } from 'vitest';
2: import type { GameWriterLeaseOptions } from '@cp2p/storage';
3: import { openDestinationTransfer } from './online-transfers.js';
4: 
5: const mocks = vi.hoisted(() => ({
6:   network: vi.fn(),
7:   identity: vi.fn(),
8:   lease: vi.fn(),
9:   open: vi.fn(),
10:   constructWorker: vi.fn(),
11:   closeStore: vi.fn(),
12:   disposeIdentity: vi.fn(),
13:   closeLease: vi.fn(),
14:   closeBrowser: vi.fn(),
15:   shutdown: vi.fn(),
16:   fail: vi.fn(),
17: }));
18: 
19: vi.mock('./network.js', () => ({ loadOnlineConnectionSettings: mocks.network }));
20: vi.mock('../session/online-credentials.js', () => ({ loadOrCreateOnlineIdentity: mocks.identity }));
21: vi.mock('@cp2p/storage', () => ({
22:   IndexedDbByteStore: class {
23:     close = mocks.closeStore;
24:   },
25:   acquireGameWriterLease: mocks.lease,
26: }));
27: vi.mock('../session/online-worker-client.js', () => ({
28:   OnlineWorkerClient: class {
29:     constructor() {
30:       mocks.constructWorker();
31:     }
32:     shutdown = mocks.shutdown;
33:     fail = mocks.fail;
34:   },
35: }));
36: vi.mock('../session/online-transfer-browser.js', () => ({
37:   OnlineTransferBrowser: { openDestination: mocks.open },
38: }));
39: 
40: const invite = {
41:   body: {
42:     protocol: 'cp2p/online-transfer-invite/v4' as const,
43:     roomId: 'transferaa',
44:     attemptId: 'A'.repeat(43),
45:     gameId: 'g'.repeat(22),
46:     genesisDigest: 'B'.repeat(43),
47:     seat: 0 as const,
48:     sourceDevice: 'C'.repeat(43),
49:     serverUrl: 'wss://example.com',
50:   },
51:   sig: 'D'.repeat(86),
52: };
53: 
54: beforeEach(() => {
55:   vi.resetAllMocks();
56:   mocks.network.mockResolvedValue({ iceServers: [], iceTransportPolicy: 'all' });
57:   mocks.identity.mockResolvedValue({ peerId: 'destination', dispose: mocks.disposeIdentity });
58:   mocks.lease.mockResolvedValue({ close: mocks.closeLease });
59:   mocks.open.mockResolvedValue({ close: mocks.closeBrowser });
60:   for (const close of [mocks.closeStore, mocks.closeLease, mocks.closeBrowser, mocks.shutdown])
61:     close.mockResolvedValue(undefined);
62: });
63: 
64: test('identity failure closes the store before any worker is created', async () => {
65:   mocks.identity.mockRejectedValue(new Error('identity unavailable'));
66:   await expect(openDestinationTransfer(invite)).rejects.toThrow('identity unavailable');
67:   expect(mocks.closeStore).toHaveBeenCalledOnce();
68:   expect(mocks.constructWorker).not.toHaveBeenCalled();
69: });
70: 
71: test('writer contention releases identity and store without creating an importer', async () => {
72:   mocks.lease.mockResolvedValue(null);
73:   await expect(openDestinationTransfer(invite)).rejects.toThrow('another tab');
74:   expect(mocks.disposeIdentity).toHaveBeenCalledOnce();
75:   expect(mocks.closeStore).toHaveBeenCalledOnce();
76:   expect(mocks.constructWorker).not.toHaveBeenCalled();
77:   expect(mocks.open).not.toHaveBeenCalled();
78: });
79: 
80: test('worker constructor failure releases the acquired lease and identity', async () => {
81:   mocks.constructWorker.mockImplementation(() => {
82:     throw new Error('worker unavailable');
83:   });
84:   await expect(openDestinationTransfer(invite)).rejects.toThrow('worker unavailable');
85:   expect(mocks.disposeIdentity).toHaveBeenCalledOnce();
86:   expect(mocks.closeLease).toHaveBeenCalledOnce();
87:   expect(mocks.closeStore).toHaveBeenCalledOnce();
88: });
89: 
90: test('link initialization failure shuts down the importer and preserves the original error', async () => {
91:   mocks.open.mockRejectedValue(new Error('connection failed'));
92:   mocks.shutdown.mockRejectedValue(new Error('shutdown failed'));
93:   await expect(openDestinationTransfer(invite)).rejects.toThrow('connection failed');
94:   expect(mocks.shutdown).toHaveBeenCalledOnce();
95:   expect(mocks.disposeIdentity).toHaveBeenCalledOnce();
96:   expect(mocks.closeLease).toHaveBeenCalledOnce();
97:   expect(mocks.closeStore).toHaveBeenCalledOnce();
98: });
99: 
100: test('lease loss during open rejects and closes the late browser', async () => {
101:   let leaseOptions: GameWriterLeaseOptions | undefined;
102:   mocks.lease.mockImplementation(
103:     (_game: string, _self: string, options: GameWriterLeaseOptions) => {
104:       leaseOptions = options;
105:       return { close: mocks.closeLease };
106:     },
107:   );
108:   mocks.open.mockImplementation(() => {
109:     // The callback receives a specific storage error in production; its value is not consumed here.
110:     const error = Object.assign(new Error('lost'), { code: 'lost' as const });
111:     leaseOptions?.onLost?.(error);
112:     return { close: mocks.closeBrowser };
113:   });
114:   await expect(openDestinationTransfer(invite)).rejects.toThrow('elsewhere');
115:   expect(mocks.fail).toHaveBeenCalledOnce();
116:   expect(mocks.closeBrowser).toHaveBeenCalledOnce();
117:   expect(mocks.shutdown).toHaveBeenCalledOnce();
118:   expect(mocks.closeLease).toHaveBeenCalledOnce();
119:   expect(mocks.closeStore).toHaveBeenCalledOnce();
120: });
121: 
122: test('close is idempotent and cleans up even when browser shutdown rejects', async () => {
123:   const handle = await openDestinationTransfer(invite);
124:   mocks.closeBrowser.mockRejectedValue(new Error('browser shutdown failed'));
125:   const closing = handle.close();
126:   expect(handle.close()).toBe(closing);
127:   await expect(closing).rejects.toThrow('browser shutdown failed');
128:   expect(mocks.shutdown).toHaveBeenCalledOnce();
129:   expect(mocks.disposeIdentity).toHaveBeenCalledOnce();
130:   expect(mocks.closeLease).toHaveBeenCalledOnce();
131:   expect(mocks.closeStore).toHaveBeenCalledOnce();
132: });