# Pinned Cloudflare review excerpts

All source and test file hashes are in deployment-review-manifest.sha256. This input contains selected security-critical code; mark claims about omitted lines unverified.

## docs/verification/cloudflare/deployment-review-brief.md

1: # Cloudflare deployment review brief
2: 
3: Review the pinned source snapshot as text. Tools are disabled. Do not inspect the checkout or infer account state. The bundle contains no actual TURN token, device identity, browser save, room code or WebRTC payload. The account ID and hostname in Wrangler are public configuration.
4: 
5: The Worker serves a public friends-beta app. Its room WebSocket endpoint has a signed challenge join. Its public TURN endpoint has a Cloudflare rate-limit binding configured at 10 requests per minute per IP, a global Durable Object budget of 200 issued credentials per UTC day, and two-hour credentials. The rate-limit binding is an abuse throttle, not exact accounting; the Durable Object budget is intended as the hard issuance cap.
6: 
7: Find concrete security or lifecycle defects in:
8: 
9: - Durable Object hibernation restoration, challenge replay, per-socket message rate state, room expiry, attachment validation and oversized signaling.
10: - TURN upstream routing, response bounds, TTL, quota reservation/refund, error handling and credential leakage.
11: - Wrangler deployment routing, Workers assets fallback and browser network defaults.
12: 
13: Give each finding a reproducible trace, source line, severity and narrow correction. Separate confirmed defects from platform behavior that needs a real Worker test. Do not propose authentication for the deliberately public TURN endpoint or broader product features.

## apps/signaling/src/worker.ts

14:     const url = new URL(request.url);
15:     if (url.pathname === '/healthz') return new Response('ok', { headers: privateHeaders });
16:     const roomId = roomPath.exec(url.pathname)?.[1];
17:     if (roomId) {
18:       if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
19:         return error(426, 'WebSocket required');
20:       // Native clients may omit Origin; browsers must use the deployed app.
21:       const origin = request.headers.get('Origin');
22:       if (origin !== null && origin !== env.APP_ORIGIN) return error(403, 'Origin not allowed');
23:       const { success } = await env.CONNECTION_LIMIT.limit({
24:         key: request.headers.get('CF-Connecting-IP') ?? 'unknown',
25:       });
26:       if (!success) return error(429, 'Too many connections');
27:       return env.ROOMS.getByName(roomId).fetch(request);
28:     }
29:     if (url.pathname === '/api/turn') {
30:       if (request.method !== 'GET') return error(405, 'GET required');
31:       // This is a public, rate-limited issuance endpoint, not an authentication boundary.
32:       const origin = request.headers.get('Origin');
33:       const site = request.headers.get('Sec-Fetch-Site');
34:       if (
35:         (origin !== null && origin !== env.APP_ORIGIN) ||
36:         (site !== null && site !== 'same-origin')
37:       )
38:         return error(403, 'Origin not allowed');
39:       if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return error(503, 'Relay unavailable');
40:       const { success } = await env.TURN_LIMIT.limit({
41:         key: request.headers.get('CF-Connecting-IP') ?? 'unknown',
42:       });
43:       if (!success) return error(429, 'Too many relay requests');
44:       const quota = env.TURN_QUOTA.getByName('issuance');
45:       let reservation: number | null = null;
46:       try {
47:         reservation = await quota.reserve();
48:         if (reservation === null) return error(429, 'Daily relay credential limit reached');
49:         const credentials = await issueTurnCredentials(
50:           env.TURN_KEY_ID,
51:           env.TURN_KEY_API_TOKEN,
52:           Number(env.TURN_TTL_SECONDS),
53:         );
54:         return Response.json(credentials, { headers: privateHeaders });
55:       } catch {
56:         if (reservation !== null) await quota.refund(reservation).catch(() => undefined);
57:         // Deliberately omit provider errors, headers, and credential-bearing bodies.
58:         // oxlint-disable-next-line no-console -- An opaque operational event; never log provider bodies or tokens.
59:         console.error(JSON.stringify({ event: 'turn-issuance-failed' }));
60:         return error(503, 'Relay unavailable');
61:       }
62:     }
63:     if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/room/'))
64:       return error(404, 'Not found');
65:     return env.ASSETS.fetch(request);
66:   },
67: } satisfies ExportedHandler<Cloudflare.Env>;

## apps/signaling/src/turn-service.ts

73: export async function issueTurnCredentials(
74:   keyId: string,
75:   apiToken: string,
76:   ttl: number,
77:   fetcher: typeof fetch = fetch,
78:   now: () => number = Date.now,
79: ): Promise<{ iceServers: TurnServer[]; ttl: number }> {
80:   if (
81:     !/^[a-f0-9]{32}$/.test(keyId) ||
82:     !apiToken ||
83:     !Number.isInteger(ttl) ||
84:     ttl < 60 ||
85:     ttl > 86_400
86:   )
87:     throw new Error('TURN is not configured');
88:   const started = now();
89:   const response = await fetcher(
90:     `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
91:     {
92:       method: 'POST',
93:       headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
94:       body: JSON.stringify({ ttl }),
95:       redirect: 'error',
96:       signal: AbortSignal.timeout(7_000),
97:     },
98:   );
99:   if (!response.ok) {
100:     await response.body?.cancel();
101:     throw new Error('TURN provider unavailable');
102:   }
103:   const iceServers = parseTurnServers(await readBoundedJson(response));
104:   const remaining = ttl - Math.ceil(Math.max(0, now() - started) / 1_000);
105:   if (remaining <= 0) throw new Error('TURN credentials expired');
106:   return { iceServers, ttl: remaining };
107: }

## apps/signaling/src/turn-quota.ts

1: import { DurableObject } from 'cloudflare:workers';
2: 
3: /** A tiny, durable issuance budget. It stores no IPs, credentials, or game data. */
4: export class TurnQuota extends DurableObject<Cloudflare.Env> {
5:   constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
6:     super(ctx, env);
7:     ctx.storage.sql.exec(
8:       'CREATE TABLE IF NOT EXISTS issuance (id INTEGER PRIMARY KEY CHECK (id = 1), day INTEGER NOT NULL, count INTEGER NOT NULL)',
9:     );
10:   }
11: 
12:   reserve(): number | null {
13:     const limit = Number(this.env.TURN_DAILY_LIMIT);
14:     if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) return null;
15:     const day = Math.floor(Date.now() / 86_400_000);
16:     const rows = this.ctx.storage.sql.exec<{ count: number }>(
17:       `INSERT INTO issuance (id, day, count) VALUES (1, ?, 1)
18:        ON CONFLICT(id) DO UPDATE SET
19:          day = MAX(issuance.day, excluded.day),
20:          count = CASE WHEN excluded.day > issuance.day THEN 1 ELSE issuance.count + 1 END
21:        WHERE excluded.day > issuance.day OR issuance.count < ?
22:        RETURNING count`,
23:       day,
24:       limit,
25:     );
26:     return rows.toArray().length === 1 ? day : null;
27:   }
28: 
29:   refund(day: number): void {
30:     this.ctx.storage.sql.exec(
31:       'UPDATE issuance SET count = count - 1 WHERE id = 1 AND day = ? AND count > 0',
32:       day,
33:     );
34:   }
35: }

## apps/signaling/src/cloudflare-room.ts

78:   override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
79:     await this.#ready;
80:     await this.#run(async () => {
81:       const socket = ws as SocketWithAttachment;
82:       const snapshot = this.#readAttachment(socket);
83:       if (!snapshot) {
84:         this.#close(socket, 1011, 'invalid-session');
85:         await this.#persistAndSchedule();
86:         return;
87:       }
88:       if (typeof message !== 'string') {
89:         this.#core.disconnect(snapshot.id);
90:         this.#close(socket, 1003, 'text-only');
91:         await this.#persistAndSchedule();
92:         return;
93:       }
94:       this.#core.sweep();
95:       this.#core.receive(snapshot.id, message);
96:       await this.#persistAndSchedule();
97:     });
98:   }
99: 
100:   override async webSocketClose(ws: WebSocket): Promise<void> {
101:     await this.#ready;
102:     await this.#run(async () => {
103:       const socket = ws as SocketWithAttachment;
104:       const snapshot = this.#readAttachment(socket);
105:       if (snapshot) this.#core.disconnect(snapshot.id);
106:       this.#clearAttachment(socket);
107:       await this.#persistAndSchedule();
108:     });
109:   }
110: 
111:   override async webSocketError(ws: WebSocket): Promise<void> {
112:     await this.webSocketClose(ws);
113:   }
114: 
115:   override async alarm(): Promise<void> {
116:     await this.#ready;
117:     await this.#run(async () => {
118:       this.#core.sweep();
119:       await this.#persistAndSchedule();
120:     });
121:   }
122: 
123:   async #restore(): Promise<void> {
124:     this.#roomId = (await this.ctx.storage.get<string>(roomIdKey)) ?? null;
125:     const storedActivity = await this.ctx.storage.get<number>(lastActivityKey);
126:     this.#lastActivity =
127:       typeof storedActivity === 'number' && Number.isFinite(storedActivity) ? storedActivity : null;
128:     const sockets = this.ctx.getWebSockets();
129:     for (const [index, ws] of sockets.entries()) {
130:       const socket = ws as SocketWithAttachment;
131:       const snapshot = this.#readAttachment(socket);
132:       if (
133:         index >= MAX_ROOM_SOCKETS ||
134:         !snapshot ||
135:         (this.#roomId !== null && snapshot.roomId !== this.#roomId)
136:       ) {
137:         this.#close(socket, 1011, 'invalid-session');
138:         continue;
139:       }
140:       this.#roomId ??= snapshot.roomId;
141:       const restoredSnapshot =
142:         this.#lastActivity === null
143:           ? snapshot
144:           : {
145:               ...snapshot,
146:               roomLastActivity: Math.max(snapshot.roomLastActivity ?? 0, this.#lastActivity),
147:             };
148:       try {
149:         this.#core.restoreSession(restoredSnapshot, socketAdapter(socket));
150:       } catch {
151:         this.#close(socket, 1011, 'invalid-session');
152:       }
153:     }
154:     this.#core.sweep();
155:     if (this.#roomId) await this.ctx.storage.put(roomIdKey, this.#roomId);
156:     await this.#persistAndSchedule();
157:   }
158: 
159:   async #persistAndSchedule(): Promise<void> {
160:     const sockets = this.ctx.getWebSockets();
161:     const snapshots: RoomSessionSnapshot[] = [];

## apps/signaling/src/room-core.ts

189:       peerId: session.peerId,
190:       roomLastActivity: this.rooms.get(session.roomId)?.lastActivity ?? null,
191:     };
192:   }
193: 
194:   /** Restore only validated attachment state created by this adapter. */
195:   restoreSession(value: unknown, socket: RoomSocket): number {
196:     if (!isRoomSessionSnapshot(value)) throw new TypeError('Invalid room session attachment');
197:     const snapshot = value;
198:     if (this.sessions.has(snapshot.id)) throw new TypeError('Duplicate room session attachment');
199:     const now = this.now();
200:     if (
201:       !Number.isFinite(now) ||
202:       now < snapshot.lastNow ||
203:       (snapshot.roomLastActivity !== null && now < snapshot.roomLastActivity)
204:     )
205:       throw new TypeError('Room session attachment is from the future');
206:     const session: Session = {
207:       id: snapshot.id,
208:       roomId: snapshot.roomId,
209:       socket,
210:       challenge: snapshot.challenge,
211:       openedAt: snapshot.openedAt,
212:       arrivals: [...snapshot.arrivals],
213:       lastNow: snapshot.lastNow,
214:       peerId: snapshot.peerId,
215:     };
216:     if (session.peerId) {
217:       const room = this.rooms.get(session.roomId) ?? {
218:         peers: new Map<PeerId, Session>(),
219:         lastActivity: snapshot.roomLastActivity ?? now,
220:       };
221:       if (room.peers.has(session.peerId) || room.peers.size >= MAX_ROOM_PEERS)
222:         throw new TypeError('Conflicting room session attachment');
223:       room.lastActivity = Math.max(room.lastActivity, snapshot.roomLastActivity ?? 0);
224:       room.peers.set(session.peerId, session);
225:       this.rooms.set(session.roomId, room);
226:     } else if (snapshot.roomLastActivity !== null) {
227:       const room = this.rooms.get(session.roomId) ?? {
228:         peers: new Map<PeerId, Session>(),
229:         lastActivity: snapshot.roomLastActivity,
230:       };
231:       room.lastActivity = Math.max(room.lastActivity, snapshot.roomLastActivity);
232:       this.rooms.set(session.roomId, room);
233:     }
234:     this.sessions.set(session.id, session);
235:     this.nextId = Math.max(this.nextId, session.id);
255:     if (
256:       session.peerId ||
257:       now - session.openedAt >= ROOM_JOIN_TIMEOUT_MS ||
258:       !exact(frame, ['type', 'body', 'sig']) ||
259:       !record(frame.body) ||
260:       !exact(frame.body, ['version', 'roomId', 'peerId', 'challenge']) ||
261:       frame.body.version !== 1 ||
262:       frame.body.roomId !== session.roomId ||
263:       frame.body.challenge !== session.challenge ||
264:       typeof frame.body.peerId !== 'string' ||
265:       typeof frame.sig !== 'string'
266:     ) {
267:       this.reject(session, 'invalid-join');
268:       return;
269:     }
270:     let publicKey: Uint8Array;
271:     try {
272:       publicKey = parsePeerId(frame.body.peerId);
273:       if (
274:         !validRoomChallenge(session.challenge) ||
275:         !verifyObject(ROOM_JOIN_DOMAIN, frame.body, frame.sig, publicKey)
276:       )
277:         throw new Error('Invalid join signature');
278:     } catch {
279:       this.reject(session, 'invalid-join');
280:       return;
281:     }
282:     const room = this.rooms.get(session.roomId) ?? {
283:       peers: new Map<PeerId, Session>(),
284:       lastActivity: now,
285:     };
286:     const existing = room.peers.get(frame.body.peerId);
287:     if (existing) {
288:       // The new challenge and signature prove possession of the same key.
289:       // Remove the old session first so a later close cannot evict its successor.
290:       room.peers.delete(frame.body.peerId);
291:       this.sessions.delete(existing.id);

## apps/signaling/wrangler.jsonc

1: {
2:   "$schema": "node_modules/wrangler/config-schema.json",
3:   "name": "hexfield",
4:   "main": "src/worker.ts",
5:   "account_id": "3cccf30c3a4ca0900c908210c523166c",
6:   "compatibility_date": "2026-09-27",
7:   "compatibility_flags": ["nodejs_compat"],
8:   "workers_dev": false,
9:   "preview_urls": false,
10:   "routes": [{ "pattern": "hexfield.steenbakkers.cc", "custom_domain": true }],
11:   "assets": {
12:     "directory": "../web/dist",
13:     "binding": "ASSETS",
14:     "not_found_handling": "single-page-application",
15:     "run_worker_first": ["/room/*", "/api/*", "/healthz"],
16:   },
17:   "durable_objects": {
18:     "bindings": [
19:       { "name": "ROOMS", "class_name": "CloudflareRoom" },
20:       { "name": "TURN_QUOTA", "class_name": "TurnQuota" },
21:     ],
22:   },
23:   "migrations": [{ "tag": "v1", "new_sqlite_classes": ["CloudflareRoom", "TurnQuota"] }],
24:   "ratelimits": [
25:     { "name": "CONNECTION_LIMIT", "namespace_id": "1001", "simple": { "limit": 30, "period": 60 } },
26:     { "name": "TURN_LIMIT", "namespace_id": "1002", "simple": { "limit": 10, "period": 60 } },
27:   ],
28:   "vars": {
29:     "APP_ORIGIN": "https://hexfield.steenbakkers.cc",
30:     "TURN_TTL_SECONDS": "7200",
31:     "TURN_DAILY_LIMIT": "200",
32:   },
33:   "secrets": { "required": ["TURN_KEY_ID", "TURN_KEY_API_TOKEN"] },
34:   "observability": {
35:     "enabled": true,
36:     "logs": { "enabled": true, "invocation_logs": false },
37:     "traces": { "enabled": true, "head_sampling_rate": 0.01 },
38:   },
39: }
