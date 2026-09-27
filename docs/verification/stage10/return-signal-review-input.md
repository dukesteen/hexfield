Read-only focused security/code review; no tools or MCP. The previous review found that SDP equality is not an adequate stale-answer test. This p2p-only change signs an `inReplyTo` local-offer revision in signaling envelope version 2, pins local outstanding offer revision in PeerLink, and drops answer mismatches without changing generation/revision or authentication state. Review answer→offer binding across glare, manual answer-only, ICE restart, duplicate/fresh revision, candidate buffering, signal-envelope parsing, and size bounds. Identify only concrete remaining defects or meaningful missing tests, with file/line and minimal fix. Do not request game protocol changes or compatibility with unpublished v1 signal envelopes.
FILE packages/p2p/src/signaling.ts LINES 1-40
1: import type { PeerId, Unsubscribe } from '@cp2p/protocol';
2: 
3: /** A bounded envelope; adapters may encode it as a manual code, WebSocket, or mesh relay. */
4: export type SignalBlob =
5:   | {
6:       readonly kind: 'description';
7:       readonly generation: number;
8:       readonly revision: number;
9:       readonly description: RTCSessionDescriptionInit;
10:       /** Answers name the exact revision of the local offer they answer. */
11:       readonly inReplyTo?: number;
12:     }
13:   | {
14:       readonly kind: 'candidate';
15:       readonly generation: number;
16:       readonly revision: number;
17:       readonly candidate: RTCIceCandidateInit | null;
18:     };
19: 
20: export interface SignalingAdapter {
21:   readonly kind: 'manual' | 'server' | 'mesh-relay';
22:   /** The literal `room` is accepted because PeerId is currently a string alias. */
23:   send(to: PeerId, blob: SignalBlob): Promise<void>;
24:   onSignal(listener: (from: PeerId, blob: SignalBlob) => void): Unsubscribe;
25:   close(): void;
26: }
FILE packages/p2p/src/signaling-envelope.ts LINES 1-165
1: import { canonicalEncode, fromBase64Url, toBase64Url } from '@cp2p/codec';
2: import { parsePeerId, signObject, verifyObject } from '@cp2p/crypto';
3: import type { PeerId, Unsubscribe } from '@cp2p/protocol';
4: import type { SignalBlob } from './signaling.js';
5: 
6: const MAX_ENVELOPE_BYTES = 70_000;
7: const MAX_DESCRIPTION_BYTES = 65_536;
8: const MAX_CANDIDATE_BYTES = 4_096;
9: 
10: export interface SignalEnvelopeBody {
11:   readonly version: 2;
12:   readonly scope: string;
13:   readonly from: PeerId;
14:   readonly to: PeerId;
15:   /** Fresh random 128-bit ID for one offer/answer and its ICE candidates. */
16:   readonly attemptId: string;
17:   /** Random process session; only attemptSeq orders attempts within it. */
18:   readonly sessionId: string;
19:   readonly attemptSeq: number;
20:   readonly blob: SignalBlob;
21: }
22: 
23: export interface SignedSignalEnvelope {
24:   readonly body: SignalEnvelopeBody;
25:   readonly sig: string;
26: }
27: 
28: /** Adapter sender metadata is untrusted until the contained signature verifies. */
29: export interface EnvelopeSignalingAdapter {
30:   send(to: PeerId, value: SignedSignalEnvelope): Promise<void>;
31:   onSignal(listener: (from: PeerId, value: unknown) => void): Unsubscribe;
32:   close(): void;
33: }
34: 
35: function record(value: unknown): value is Record<string, unknown> {
36:   return value !== null && typeof value === 'object' && !Array.isArray(value);
37: }
38: 
39: function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
40:   return (
41:     Object.keys(value).length === fields.length &&
42:     fields.every((field) => Object.hasOwn(value, field))
43:   );
44: }
45: 
46: export function validAttemptId(value: unknown): value is string {
47:   if (typeof value !== 'string') return false;
48:   try {
49:     return fromBase64Url(value).length === 16 && toBase64Url(fromBase64Url(value)) === value;
50:   } catch {
51:     return false;
52:   }
53: }
54: 
55: /** Validation occurs before signing and before any untrusted value reaches PeerLink. */
56: export function validSignalEnvelopeBody(value: unknown): value is SignalEnvelopeBody {
57:   if (
58:     !record(value) ||
59:     !exact(value, [
60:       'version',
61:       'scope',
62:       'from',
63:       'to',
64:       'attemptId',
65:       'sessionId',
66:       'attemptSeq',
67:       'blob',
68:     ]) ||
69:     value.version !== 2 ||
70:     typeof value.scope !== 'string' ||
71:     value.scope.length < 1 ||
72:     value.scope.length > 128 ||
73:     typeof value.from !== 'string' ||
74:     typeof value.to !== 'string' ||
75:     value.from === value.to ||
76:     !validAttemptId(value.attemptId) ||
77:     !validAttemptId(value.sessionId) ||
78:     !Number.isSafeInteger(value.attemptSeq) ||
79:     Number(value.attemptSeq) < 1 ||
80:     !record(value.blob)
81:   )
82:     return false;
83:   try {
84:     parsePeerId(value.from);
85:     parsePeerId(value.to);
86:   } catch {
87:     return false;
88:   }
89:   const blob = value.blob;
90:   if (
91:     !Number.isSafeInteger(blob.generation) ||
92:     Number(blob.generation) < 0 ||
93:     !Number.isSafeInteger(blob.revision) ||
94:     Number(blob.revision) < 1
95:   )
96:     return false;
97:   if (blob.kind === 'description') {
98:     if (
99:       !record(blob.description) ||
100:       !exact(blob.description, ['type', 'sdp']) ||
101:       !['offer', 'answer'].includes(String(blob.description.type)) ||
102:       typeof blob.description.sdp !== 'string' ||
103:       blob.description.sdp.length > MAX_DESCRIPTION_BYTES
104:     )
105:       return false;
106:     if (blob.description.type === 'answer') {
107:       if (
108:         !exact(blob, ['kind', 'generation', 'revision', 'description', 'inReplyTo']) ||
109:         !Number.isSafeInteger(blob.inReplyTo) ||
110:         Number(blob.inReplyTo) < 1
111:       )
112:         return false;
113:     } else if (!exact(blob, ['kind', 'generation', 'revision', 'description'])) return false;
114:   } else if (blob.kind === 'candidate') {
115:     if (!exact(blob, ['kind', 'generation', 'revision', 'candidate'])) return false;
116:     if (
117:       blob.candidate !== null &&
118:       (!record(blob.candidate) ||
119:         typeof blob.candidate.candidate !== 'string' ||
120:         blob.candidate.candidate.length > MAX_CANDIDATE_BYTES)
121:     )
122:       return false;
123:   } else return false;
124:   try {
125:     return canonicalEncode(value).byteLength <= MAX_ENVELOPE_BYTES;
126:   } catch {
127:     return false;
128:   }
129: }
130: 
131: export function signSignalEnvelope(
132:   body: SignalEnvelopeBody,
133:   key: Uint8Array,
134: ): SignedSignalEnvelope {
135:   if (!validSignalEnvelopeBody(body)) throw new TypeError('Invalid signaling envelope body');
136:   return { body, sig: signObject('p2p-signal', body, key) };
137: }
138: 
139: export function verifySignalEnvelope(
140:   value: unknown,
141:   scope: string,
142:   recipient: PeerId,
143:   expectedSenders: ReadonlySet<PeerId>,
144: ): SignedSignalEnvelope | null {
145:   let detached: unknown;
146:   try {
147:     detached = structuredClone(value);
148:   } catch {
149:     return null;
150:   }
151:   if (
152:     !record(detached) ||
153:     !exact(detached, ['body', 'sig']) ||
154:     !validSignalEnvelopeBody(detached.body) ||
155:     typeof detached.sig !== 'string'
156:   )
157:     return null;
158:   const body = detached.body;
159:   if (body.scope !== scope || body.to !== recipient || !expectedSenders.has(body.from)) return null;
160:   try {
161:     return verifyObject('p2p-signal', body, detached.sig, parsePeerId(body.from))
162:       ? { body, sig: detached.sig }
163:       : null;
164:   } catch {
165:     return null;
FILE packages/p2p/src/peer-link.ts LINES 175-355
175:   }
176: 
177:   get isAuthenticated(): boolean {
178:     return this.authenticated && !this.closed;
179:   }
180: 
181:   get hasOpenedChannels(): boolean {
182:     return !this.closed && this.game.readyState === 'open' && this.bulk.readyState === 'open';
183:   }
184: 
185:   async receiveSignal(blob: SignalBlob): Promise<void> {
186:     if (
187:       this.closed ||
188:       !blob ||
189:       !Number.isSafeInteger(blob.generation) ||
190:       blob.generation < 0 ||
191:       !Number.isSafeInteger(blob.revision) ||
192:       blob.revision < 1
193:     )
194:       return;
195:     if (this.remoteGeneration !== null && blob.generation !== this.remoteGeneration) return;
196:     try {
197:       if (blob.kind === 'description') {
198:         if (blob.revision <= this.remoteRevision) return;
199:         const description = blob.description;
200:         if (
201:           !description ||
202:           !['offer', 'answer'].includes(description.type) ||
203:           typeof description.sdp !== 'string' ||
204:           description.sdp.length > 65_536
205:         )
206:           return;
207:         const candidateKey = `${blob.generation}/${blob.revision}`;
208:         // Only the answer to the currently outstanding local offer may change SDP.
209:         if (
210:           description.type === 'answer' &&
211:           (this.pc.signalingState !== 'have-local-offer' ||
212:             this.isSettingRemoteAnswerPending ||
213:             blob.inReplyTo !== this.localOfferRevision)
214:         ) {
215:           this.earlyCandidates.delete(candidateKey);
216:           return;
217:         }
218:         if (this.authenticated) {
219:           try {
220:             const current = this.pc.currentRemoteDescription?.sdp;
221:             if (
222:               !current ||
223:               applicationFingerprint(description.sdp) !== applicationFingerprint(current)
224:             )
225:               return;
226:           } catch {
227:             return;
228:           }
229:         }
230:         if (this.remoteGeneration === null) this.remoteGeneration = blob.generation;
231:         const readyForOffer =
232:           !this.makingOffer &&
233:           (this.pc.signalingState === 'stable' || this.isSettingRemoteAnswerPending);
234:         const collision = description.type === 'offer' && !readyForOffer;
235:         this.ignoreOffer = collision && !this.polite;
236:         if (this.ignoreOffer) {
237:           this.ignoredRevision = Math.max(this.ignoredRevision, blob.revision);
238:           this.earlyCandidates.delete(candidateKey);
239:           return;
240:         }
241:         this.isSettingRemoteAnswerPending = description.type === 'answer';
242:         await this.pc.setRemoteDescription(description);
243:         this.isSettingRemoteAnswerPending = false;
244:         this.localOfferRevision = null;
245:         this.remoteRevision = blob.revision;
246:         this.acceptedRemoteRevision = blob.revision;
247:         const early = this.earlyCandidates.get(candidateKey) ?? [];
248:         this.earlyCandidates.clear();
249:         if (description.type === 'offer') {
250:           this.localRevision++;
251:           await this.pc.setLocalDescription();
252:           const answer = this.pc.localDescription;
253:           if (!answer) throw new Error('Missing local answer');
254:           this.sendSignal({
255:             kind: 'description',
256:             generation: this.options.generation,
257:             revision: this.localRevision,
258:             description: { type: answer.type, sdp: answer.sdp ?? '' },
259:             inReplyTo: blob.revision,
260:           });
261:         }
262:         for (const candidate of early) {
263:           try {
264:             // oxlint-disable-next-line no-await-in-loop -- ICE candidates retain signaling order.
265:             await this.pc.addIceCandidate(candidate);
266:           } catch {
267:             /* A rejected candidate must not suppress an answer. */
268:           }
269:         }
270:         this.trySendHello();
271:       } else if (blob.kind === 'candidate') {
272:         if (
273:           blob.candidate !== null &&
274:           (typeof blob.candidate.candidate !== 'string' || blob.candidate.candidate.length > 4_096)
275:         )
276:           return;
277:         if (blob.revision <= this.ignoredRevision || blob.revision < this.acceptedRemoteRevision)
278:           return;
279:         if (blob.revision === this.acceptedRemoteRevision) {
280:           try {
281:             await this.pc.addIceCandidate(blob.candidate);
282:           } catch {
283:             /* Other candidates can still establish ICE. */
284:           }
285:           return;
286:         }
287:         const candidateKey = `${blob.generation}/${blob.revision}`;
288:         const pending = this.earlyCandidates.get(candidateKey) ?? [];
289:         const count = [...this.earlyCandidates.values()].reduce(
290:           (total, values) => total + values.length,
291:           0,
292:         );
293:         if (count >= MAX_EARLY_CANDIDATES) return;
294:         pending.push(blob.candidate);
295:         this.earlyCandidates.set(candidateKey, pending);
296:       }
297:     } catch {
298:       this.isSettingRemoteAnswerPending = false;
299:       this.fail('negotiation-error');
300:     }
301:   }
302: 
303:   send(message: Uint8Array, channel: 'game' | 'bulk' = 'game'): void {
304:     if (!this.isAuthenticated) throw new Error('Peer link is not authenticated');
305:     if (!(message instanceof Uint8Array) || message.byteLength > MAX_MESSAGE_BYTES)
306:       throw new RangeError('Transport message exceeds 1 MiB');
307:     const target = channel === 'game' ? this.game : this.bulk;
308:     const queue = this.queues.get(target);
309:     if (!queue || target.readyState !== 'open') throw new Error('Peer channel is unavailable');
310:     const frames = this.framer.split(message);
311:     const bytes = frames.reduce((total, frame) => total + frame.byteLength, 0);
312:     if (queue.bytes + bytes > MAX_QUEUED_BYTES) throw new Error('Peer send queue is full');
313:     queue.frames.push(...frames);
314:     queue.bytes += bytes;
315:     if (channel === 'game' || this.remoteReady) this.drain(target);
316:   }
317: 
318:   close(reason = 'closed'): void {
319:     this.fail(reason);
320:   }
321: 
322:   private get polite(): boolean {
323:     return this.options.self < this.options.peer;
324:   }
325: 
326:   private async negotiate(): Promise<void> {
327:     if (this.closed || (this.options.offerMode === 'answer-only' && !this.authenticated)) return;
328:     try {
329:       this.makingOffer = true;
330:       this.localRevision++;
331:       await this.pc.setLocalDescription();
332:       if (!this.pc.localDescription) throw new Error('Missing local description');
333:       if (this.pc.localDescription.type === 'offer') this.localOfferRevision = this.localRevision;
334:       this.sendSignal({
335:         kind: 'description',
336:         generation: this.options.generation,
337:         revision: this.localRevision,
338:         description: {
339:           type: this.pc.localDescription.type,
340:           sdp: this.pc.localDescription.sdp ?? '',
341:         },
342:         ...(this.pc.localDescription.type === 'answer'
343:           ? { inReplyTo: this.acceptedRemoteRevision }
344:           : {}),
345:       });
346:     } catch {
347:       this.fail('negotiation-error');
348:     } finally {
349:       this.makingOffer = false;
350:     }
351:   }
352: 
353:   private sendSignal(blob: SignalBlob): void {
354:     if (this.closed) return;
355:     try {
FILE packages/p2p/src/peer-link.test.ts LINES 805-945
805:       expect(politePc.localDescription?.type).toBe('answer');
806:       expect(impolitePc.signalingState).toBe('have-local-offer');
807:       expect(impolitePc.localDescription?.type).toBe('offer');
808:     } finally {
809:       f.close();
810:     }
811:   });
812: 
813:   test('an answer without a local offer and a delayed repeat do not close a link', async () => {
814:     const f = pair();
815:     try {
816:       const answer = { type: 'answer' as const, sdp: sdp('BB') };
817:       await f.left.receiveSignal({
818:         kind: 'description',
819:         generation: 1,
820:         revision: 1,
821:         description: answer,
822:         inReplyTo: 1,
823:       });
824:       expect(f.leftPc.currentRemoteDescription).toEqual({ type: 'offer', sdp: sdp('BB') });
825:       f.leftPc.emit('negotiationneeded');
826:       await Promise.resolve();
827:       expect(f.leftPc.signalingState).toBe('have-local-offer');
828:       await f.left.receiveSignal({
829:         kind: 'description',
830:         generation: 1,
831:         revision: 2,
832:         description: answer,
833:         inReplyTo: 1,
834:       });
835:       expect(f.leftPc.signalingState).toBe('stable');
836:       await f.left.receiveSignal({
837:         kind: 'description',
838:         generation: 1,
839:         revision: 3,
840:         description: answer,
841:         inReplyTo: 1,
842:       });
843:       expect(f.leftPc.currentRemoteDescription).toEqual(answer);
844:       expect(f.leftDown).toEqual([]);
845:     } finally {
846:       f.close();
847:     }
848:   });
849: 
850:   test('a second answer during asynchronous answer application is ignored', async () => {
851:     const f = pair();
852:     try {
853:       f.leftPc.emit('negotiationneeded');
854:       await Promise.resolve();
855:       const release = f.leftPc.holdNextRemoteDescription();
856:       const first = f.left.receiveSignal({
857:         kind: 'description',
858:         generation: 1,
859:         revision: 1,
860:         description: { type: 'answer', sdp: sdp('BB') },
861:         inReplyTo: 1,
862:       });
863:       await f.left.receiveSignal({
864:         kind: 'description',
865:         generation: 1,
866:         revision: 2,
867:         description: { type: 'answer', sdp: sdp('BB') },
868:         inReplyTo: 1,
869:       });
870:       release();
871:       await first;
872:       expect(f.leftPc.signalingState).toBe('stable');
873:       expect(f.leftDown).toEqual([]);
874:     } finally {
875:       f.close();
876:     }
877:   });
878: 
879:   test('a repeated answer with a fresh revision cannot satisfy a newer local offer', async () => {
880:     const f = pair();
881:     try {
882:       f.leftPc.emit('negotiationneeded');
883:       await Promise.resolve();
884:       const oldAnswer = { type: 'answer' as const, sdp: sdp('BB') };
885:       await f.left.receiveSignal({
886:         kind: 'description',
887:         generation: 1,
888:         revision: 1,
889:         description: oldAnswer,
890:         inReplyTo: 1,
891:       });
892:       expect(f.leftPc.signalingState).toBe('stable');
893:       f.leftPc.emit('negotiationneeded');
894:       await Promise.resolve();
895:       expect(f.leftPc.signalingState).toBe('have-local-offer');
896:       await f.left.receiveSignal({
897:         kind: 'description',
898:         generation: 1,
899:         revision: 2,
900:         description: oldAnswer,
901:         inReplyTo: 1,
902:       });
903:       expect(f.leftPc.signalingState).toBe('have-local-offer');
904:       await f.left.receiveSignal({
905:         kind: 'description',
906:         generation: 1,
907:         revision: 3,
908:         description: { type: 'answer', sdp: `${sdp('BB')}a=ice-ufrag:new\r\n` },
909:         inReplyTo: 1,
910:       });
911:       expect(f.leftPc.signalingState).toBe('have-local-offer');
912:       await f.left.receiveSignal({
913:         kind: 'description',
914:         generation: 1,
915:         revision: 4,
916:         description: oldAnswer,
917:         inReplyTo: 2,
918:       });
919:       expect(f.leftPc.signalingState).toBe('stable');
920:       expect(f.leftDown).toEqual([]);
921:     } finally {
922:       f.close();
923:     }
924:   });
925: 
926:   test('a malformed answer to the current local offer still fails negotiation', async () => {
927:     const f = pair();
928:     try {
929:       f.leftPc.emit('negotiationneeded');
930:       await Promise.resolve();
931:       expect(f.leftPc.signalingState).toBe('have-local-offer');
932:       await f.left.receiveSignal({
933:         kind: 'description',
934:         generation: 1,
935:         revision: 1,
936:         description: { type: 'answer', sdp: `${sdp('BB')}a=malformed\r\n` },
937:         inReplyTo: 1,
938:       });
939:       expect(f.leftDown).toContain('negotiation-error');
940:     } finally {
941:       f.close();
942:     }
943:   });
944: 
945:   test('future ICE waits for its exact description; stale and foreign generations are ignored', async () => {
FILE packages/p2p/src/web-rtc-transport.ts LINES 585-610
585:       generation,
586:       offerMode: origin === peer ? 'answer-only' : 'auto',
587:       clock: this.options.clock,
588:       rtcFactory: () => this.options.rtcFactory(peer, configuration),
589:       ...(this.options.randomBytes ? { randomBytes: this.options.randomBytes } : {}),
590:       signal: (blob) => {
591:         if (!this.expected.has(peer) || this.disposed || this.manualDisconnects.has(peer))
592:           return Promise.reject(new Error('Peer is outside the active mesh roster'));
593:         return this.options.adapter.send(
594:           peer,
595:           signSignalEnvelope(
596:             {
597:               version: 2,
598:               scope: this.options.scope,
599:               from: this.self,
600:               to: peer,
601:               attemptId,
602:               sessionId,
603:               attemptSeq,
604:               blob,
605:             },
606:             this.secretKey,
607:           ),
608:         );
609:       },
610:       onMessage: (message) => {
