# Local encryption review input

## Proposed design

# Local passphrase lock design (read-only inventory)

This is an optional **at-rest lock for local secrets**. It does not change game keys, certified history, quorum, escrow, or the wire protocol. It does not protect secrets while an unlocked tab is running, against same-origin script execution, or against deletion/rollback of the entire browser database. Forgetting the passphrase makes protected local records unusable; it must never trigger replacement-key generation or reset a voting journal.

## Current durable copies

| Record/path                                                                                                                                        | Secret content                                                                                                          | Current owner and consequence                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bytes: online-credentials/device-identity/v1`                                                                                                     | Device Ed25519 secret                                                                                                   | `online-credentials.ts` loads or creates it for the lobby, transfers and worker. A locked read must throw before its `loadOrCreateOnlineIdentity` missing-record branch.                                                                                                                                                                            |
| `bytes: online-credentials/ceremony/<nonce>/<device>`                                                                                              | Each owned game signing key and original master scalar                                                                  | `prepareCeremonyMaterial` reserves once under a ceremony Web Lock. It is retained even after `online-game/<digest>/keys` is written. Both copies need protection.                                                                                                                                                                                   |
| `bytes: online-game/<digest>/keys`                                                                                                                 | Active/installing-generation human and bot signing keys and masters                                                     | `online-game.ts` passes the canonical record to `IndexedDbProtocolJournal` as its byte-exact `keyBinding`. Journal load, safety writes and commit compare this record inside their own IDB transactions. Transfer promotion also decodes and replaces it. This is the critical cross-store boundary.                                                |
| `bytes: escrow-accepted/<ceremony>/<dealer>/<holder>`                                                                                              | Decrypted private Shamir share                                                                                          | `EscrowCeremony` persists before ACK. `escrow-lifecycle/device-index-v1` instead holds public master commitments, encrypted envelopes and irreversible consent/retirement status; keep its anti-equivocation semantics.                                                                                                                             |
| `bytes: recovery-readiness/...`, `recovery-private/<digest>/...`                                                                                   | Reserved replacement signing keys; recovered original masters                                                           | Readiness must persist before signed authorization; recovered masters persist before activation checks. Loss or failed decryption must pause recovery.                                                                                                                                                                                              |
| `bytes: online-transfer-credentials/v1/...`                                                                                                        | Destination signing keys and encryption secret                                                                          | Generated and reserved before authorization, including retries/reload. Locked reads must not mint another key for the same attempt.                                                                                                                                                                                                                 |
| `bytes: transfer-private/import/...`                                                                                                               | Imported packet **and destination decryption secret**                                                                   | `transfer-private.ts` retains this private import. Its signed outbox is sealed but still retry-sensitive.                                                                                                                                                                                                                                           |
| `bytes: transfer-import/<game>/<authorization>/...`                                                                                                | New binding bytes (keys/masters), sealed packet and reconstructed private replay bytes                                  | `TransferImportStore` writes the stage with direct IDB access; `IndexedDbProtocolJournal.promoteTransfer` rereads it and installs binding plus fresh safety atomically. Protect the whole stage; a generic byte-store wrapper alone misses this direct path. The final cancellation/promotion tombstone stays independently visible for anti-reuse. |
| `bytes: online-full-import/v1/chunk/...`                                                                                                           | Public package plus an HXFS1 private capsule that is already encrypted by its **separate file passphrase**              | `online-full-save-store.ts` retains exact validated file chunks inertly. HXFS1 does not permit plaintext private capsules. A local vault may additionally cover these chunks for metadata privacy, but they are not a plaintext secret copy. |
| `bytes: master-reveal/...`, `master-reveal/accepted/...`                                                                                           | Signed original master disclosure                                                                                       | Published only after the certified result, but locally queued/accepted copies contain master bytes. Include them in the protected/default-private class, without changing their public audit validity.                                                                                                                                              |
| Other `bytes` records: signed contribution/outbox packets, ceremony packet/draft/manifest, transfer locators, public start/catalogue/chat/settings | Mostly public or already sealed, with some proof/opening or retry-sensitive bytes                                       | Default to protected for any key not on a small reviewed public allowlist. The allowlist must include game-start pointer/catalogue, deletion markers and necessary lock metadata; new key families must not silently become plaintext.                                                                                                              |
| `games`, `entries`, `snapshots`, `consensus`, `deletedGames` stores                                                                                | Certified public history/cache; `consensus` has signed votes, locks and safety metadata, not the private signing scalar | Keep public and exact. `consensus` must remain atomically coupled to journal entries. The private key binding must still be verified in that same transaction before a vote or next height is accepted. Deletion tombstones must remain readable while locked.                                                                                      |

The private per-seat `PrivateState` is reconstructed from retained masters and certified history in the current online runtime; it is not a separate live IndexedDB record today. Any future private-state cache is protected by default. The device identity also exists as an owned in-memory copy in `OnlineRoom` and as a worker-owned copy; locking must dispose both.

## Storage contract and envelope

Use WebCrypto only: PBKDF2-HMAC-SHA-256 with a fresh 32-byte salt and bounded versioned work factor (initially 600,000 iterations, benchmarked on supported mobile devices), deriving a non-extractable AES-256-GCM `CryptoKey`. The strict `vault-v1` metadata stores the salt, KDF parameters, random vault ID, generation, mode, the pinned device PeerId and an AEAD verifier; never the passphrase or derived key. Each protected record uses a fresh random 96-bit nonce and authenticates `{vaultId, generation, store, exact record key}` as additional data. Validate the envelope's type/size/version before decryption. The encrypted value remains byte-exact and immutable for `putIfAbsent`. A wrong passphrase or mixed generation is an explicit error. An absent **required existing** record, especially the pinned device identity or current journal binding, is corrupt rather than a `null` that permits reminting; an absent genuinely new ceremony/transfer slot remains a valid first-write case after unlock.

`IndexedDbByteStore` needs an unlocked vault-aware interface. `load` returns a detached plaintext copy; `putIfAbsent` encrypts before its atomic insert. For plaintext `compareAndSwap`, load and decrypt the current ciphertext, compare plaintext with the supplied expected bytes, then call an **IDB byte-exact CAS on that captured ciphertext** with a newly encrypted replacement. Never await WebCrypto inside an open IDB transaction; that can close the transaction. CAS contention returns false and callers retry under their existing rules. Preserve all existing write-before-send ordering and zero temporary plaintext buffers.

A transparent wrapper is insufficient at two direct-IDB paths. `IndexedDbProtocolJournal` must receive **both** validated plaintext owned material and its pinned stored ciphertext representation: it uses the latter for in-transaction binding CAS while the former is checked against certified authority and master commitments before opening. `TransferImportStore.stage` and `promoteTransfer` need the same vault-aware encoding for the complete private stage, and promotion must still create fresh safety and install the new binding in one strict transaction. Neither ciphertext, vault verifier nor a successful decrypt can authorize a vote; only the existing certified replay plus journal safety/key checks can.

## Enable, disable and change passphrase

Use a new storage schema version (after current `cp2p` v4). Every protected read/write, ceremony signer, active game writer and transfer staging operation must participate in one same-origin **shared vault Web Lock**; migration takes it exclusively. This lock is a fence, not a replacement for per-game writer leases, ceremony locks, or IDB CAS. Acquire the vault lease before any per-game/ceremony lock; the migration never nests those locks. Web Locks absence fails closed for passphrase mode.

1. Stop output and close/drain every local room, game, ceremony and transfer worker on this device. Wait for their shared vault leases to release. Other tabs receive a generation-change notice and must drop owned keys; an old generation cannot resume output.
2. Under the exclusive vault lock, scan and classify records, including direct-IDB stage and key-binding copies. Reject unknown malformed records and bound total migration bytes; do not silently skip one. Precompute new ciphertext (or plaintext when disabling) **outside** the IDB transaction, retaining and wiping owned buffers. An oversized device requires cleanup or a future streaming migration design, not partial conversion.
3. In one strict IDB transaction, compare every original record byte-for-byte, write every replacement, and change the vault metadata/generation last. Retain `games`, `entries`, `consensus`, snapshots and deletion tombstones unchanged. Any abort leaves the old mode and old passphrase fully usable; a committed transaction makes only the new mode usable. Never create a second active voting key or reset height/round/lock data.
4. Close/wipe old key handles, reopen from the committed marker, decrypt and validate identity/material and the exact journal binding before allowing any signing. Disable and passphrase change use the same transaction shape; change decrypts with the old key and re-encrypts with a fresh salt/key/nonces. No plaintext fallback if metadata says locked.

An active game is not migrated in place while it can sign: the game writer lease and journal key-binding object must be released before the exclusive migration. On later restore, a missing or failed-to-decrypt binding fails before `P2PSession.restore`. Local deletion may be offered while locked, but it must take the exclusive vault lock and atomically remove ciphertext plus preserve the public `deletedGames` tombstone; it never recreates credentials. A whole database wipe erases both vault state and keys and is outside this anti-revival guarantee.

## Unlock and UI boundary

Each tab unlocks independently; never broadcast a passphrase or raw vault key between tabs. The main thread currently signs device transport messages and the dedicated game worker loads the same identity, so both need an explicit unlock handoff. Prefer passing a structured-cloned, non-extractable `CryptoKey` to the worker over sending raw derived bits. The passphrase input is cleared promptly; each side checks the committed vault generation/verifier before use. Worker crash, page reload, explicit lock or lost game writer drops in-memory secrets and requires another unlock. A locked worker can read public catalogue/history and deletion tombstones but cannot call `loadOrCreateOnlineIdentity`, prepare keys, stage transfer, publish escrow ACK, or vote.

The public UI distinguishes locked, wrong-passphrase and corrupt/incomplete records. Unlocking is not a repair path: no new identity, master, game key, consensus safety or transfer credential is generated to replace a failed record. The HXFS1 file passphrase is separate from this local vault passphrase; any decrypted owned material later installed from an import must enter the protected local store before being reported durable.

## Implementation boundaries and focused evidence

- `@cp2p/storage`: vault metadata/envelope, protected byte classification, atomic migration and cross-tab lock; journal key-binding and transfer stage/promotion integration; deletion under the vault fence. Keep public journal replay and snapshots unchanged.
- `apps/web/src/session`: explicit unlock lifecycle for `OnlineRoom`, worker initialization and credential loaders; no secret-bearing signing path starts without an unlocked generation. `online-game.ts` supplies plaintext for validation and pinned stored binding bytes for journal CAS. Full-save import participates in protected storage.
- `@cp2p/protocol`: existing store interfaces should stay byte-oriented; no cryptographic passphrase logic in replay or engine. Preserve their exact-packet retry contracts.

Tests should cover v4-to-vault migration with every plaintext secret family above, wrong passphrase/no remint, AES-GCM AAD key swap/tamper, two-tab CAS and migration-vs-signing exclusion, transaction abort at each conversion boundary, crash/reopen under old versus new passphrase, exact journal height/lock/vote and transfer promotion after rotation, escrow ACK retry, locked deletion/tombstone, and installation of decrypted HXFS1 material into protected local storage. A real signed resume trace is needed before release; a pure encrypted-store test alone would not establish voting safety.


## Pinned source excerpts

### `packages/storage/src/database.ts:1-85`

```ts
1: import { openDB } from 'idb';
2: import type { DBSchema, IDBPDatabase, IDBPTransaction } from 'idb';
3: 
4: export const DATABASE_NAME = 'cp2p';
5: export const DATABASE_VERSION = 4;
6: export const BYTE_STORE = 'bytes';
7: export const GAME_STORE = 'games';
8: export const ENTRY_STORE = 'entries';
9: export const CONSENSUS_STORE = 'consensus';
10: export const DELETED_GAME_STORE = 'deletedGames';
11: export const SNAPSHOT_STORE = 'snapshots';
12: 
13: export const MAX_RECORD_BYTES = 16 * 1024 * 1024;
14: 
15: export interface CP2PDatabase extends DBSchema {
16:   bytes: { key: string; value: Uint8Array };
17:   games: { key: string; value: Uint8Array };
18:   entries: { key: [string, number]; value: Uint8Array };
19:   consensus: { key: string; value: Uint8Array };
20:   deletedGames: { key: string; value: Uint8Array };
21:   snapshots: { key: [string, number]; value: Uint8Array };
22: }
23: 
24: export function openDatabase(
25:   blocked: () => void,
26:   reset: () => void,
27: ): Promise<IDBPDatabase<CP2PDatabase>> {
28:   const factory = globalThis.indexedDB;
29:   if (!factory) return Promise.reject(new Error('IndexedDB is unavailable'));
30: 
31:   let opening: Promise<IDBPDatabase<CP2PDatabase>>;
32:   opening = openDB<CP2PDatabase>(DATABASE_NAME, DATABASE_VERSION, {
33:     upgrade(database, oldVersion) {
34:       if (oldVersion < 1) database.createObjectStore(BYTE_STORE);
35:       if (oldVersion < 2) {
36:         database.createObjectStore(GAME_STORE);
37:         database.createObjectStore(ENTRY_STORE);
38:         database.createObjectStore(CONSENSUS_STORE);
39:       }
40:       if (oldVersion < 3) database.createObjectStore(DELETED_GAME_STORE);
41:       if (oldVersion < 4) database.createObjectStore(SNAPSHOT_STORE);
42:     },
43:     blocking: () => {
44:       blocked();
45:       opening.then((database) => database.close()).catch(() => undefined);
46:     },
47:     terminated: reset,
48:   });
49:   return opening;
50: }
51: 
52: export function strictWriteTransaction<
53:   Stores extends readonly (
54:     | 'bytes'
55:     | 'games'
56:     | 'entries'
57:     | 'consensus'
58:     | 'deletedGames'
59:     | 'snapshots'
60:   )[],
61: >(
62:   database: IDBPDatabase<CP2PDatabase>,
63:   stores: Stores,
64: ): IDBPTransaction<CP2PDatabase, Stores, 'readwrite'> {
65:   try {
66:     return database.transaction(stores, 'readwrite', { durability: 'strict' });
67:   } catch (error) {
68:     if (!(error instanceof TypeError)) throw error;
69:     return database.transaction(stores, 'readwrite');
70:   }
71: }
```

### `packages/storage/src/indexed-db-byte-store.ts:1-195`

```ts
1: import type { IDBPDatabase } from 'idb';
2: import { BYTE_STORE, MAX_RECORD_BYTES, openDatabase, strictWriteTransaction } from './database.js';
3: import type { CP2PDatabase } from './database.js';
4: 
5: const MAX_KEY_LENGTH = 512;
6: const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
7: const LOCK_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._:/-]*$/;
8: 
9: export type CeremonyLockProvider = <T>(name: string, task: () => Promise<T>) => Promise<T>;
10: 
11: export interface IndexedDbByteStoreOptions {
12:   /** A smaller application limit may be selected; the hard limit is 16 MiB. */
13:   readonly maxRecordBytes?: number;
14:   /** Override only for tests; production uses same-origin Web Locks. */
15:   readonly lockProvider?: CeremonyLockProvider;
16: }
17: 
18: /**
19:  * Versioned cp2p IndexedDB foundation. Each method is a bounded atomic byte
20:  * record operation shared by every tab and connection on this origin. It does
21:  * not reset or replace an existing database after an error.
22:  */
23: export class IndexedDbByteStore {
24:   readonly #maxRecordBytes: number;
25:   readonly #lockProvider: CeremonyLockProvider | undefined;
26:   #databasePromise: Promise<IDBPDatabase<CP2PDatabase>> | null = null;
27: 
28:   constructor(options: IndexedDbByteStoreOptions = {}) {
29:     this.#maxRecordBytes = options.maxRecordBytes ?? MAX_RECORD_BYTES;
30:     this.#lockProvider = options.lockProvider;
31:     if (
32:       !Number.isSafeInteger(this.#maxRecordBytes) ||
33:       this.#maxRecordBytes < 0 ||
34:       this.#maxRecordBytes > MAX_RECORD_BYTES
35:     )
36:       throw new RangeError('maxRecordBytes must be between zero and 16 MiB');
37:   }
38: 
39:   get maxRecordBytes(): number {
40:     return this.#maxRecordBytes;
41:   }
42: 
43:   async load(id: string): Promise<Uint8Array | null> {
44:     const key = validateKey(id);
45:     const database = await this.#database();
46:     const transaction = database.transaction(BYTE_STORE, 'readonly');
47:     let value: Uint8Array | undefined;
48:     try {
49:       value = await transaction.store.get(key);
50:       await transaction.done;
51:     } catch (error) {
52:       await transaction.done.catch(() => undefined);
53:       throw error;
54:     }
55:     if (value === undefined) return null;
56:     try {
57:       return validateStoredBytes(value, this.#maxRecordBytes).slice();
58:     } finally {
59:       if (value instanceof Uint8Array) value.fill(0);
60:     }
61:   }
62: 
63:   async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
64:     const key = validateKey(id);
65:     const value = copyBytes(bytes, this.#maxRecordBytes);
66:     try {
67:       const database = await this.#database();
68:       const transaction = strictWriteTransaction(database, [BYTE_STORE]);
69:       try {
70:         const store = transaction.objectStore(BYTE_STORE);
71:         const existing = await store.get(key);
72:         if (existing !== undefined) {
73:           await transaction.done;
74:           try {
75:             validateStoredBytes(existing, this.#maxRecordBytes);
76:           } finally {
77:             if (existing instanceof Uint8Array) existing.fill(0);
78:           }
79:           return false;
80:         }
81:         await store.add(value, key);
82:         await transaction.done;
83:         return true;
84:       } catch (error) {
85:         await transaction.done.catch(() => undefined);
86:         throw error;
87:       }
88:     } finally {
89:       value.fill(0);
90:     }
91:   }
92: 
93:   /** Byte-exact compare-and-swap in one cross-connection readwrite transaction. */
94:   async compareAndSwap(
95:     id: string,
96:     expected: Uint8Array,
97:     replacement: Uint8Array,
98:   ): Promise<boolean> {
99:     const key = validateKey(id);
100:     const expectedCopy = copyBytes(expected, this.#maxRecordBytes);
101:     let replacementCopy: Uint8Array;
102:     try {
103:       replacementCopy = copyBytes(replacement, this.#maxRecordBytes);
104:     } catch (error) {
105:       expectedCopy.fill(0);
106:       throw error;
107:     }
108:     try {
109:       const database = await this.#database();
110:       const transaction = strictWriteTransaction(database, [BYTE_STORE]);
111:       let existing: Uint8Array | undefined;
112:       try {
113:         const store = transaction.objectStore(BYTE_STORE);
114:         existing = await store.get(key);
115:         if (existing === undefined) {
116:           await transaction.done;
117:           return false;
118:         }
119:         const current = validateStoredBytes(existing, this.#maxRecordBytes);
120:         if (!equalBytes(current, expectedCopy)) {
121:           await transaction.done;
122:           return false;
123:         }
124:         await store.put(replacementCopy, key);
125:         await transaction.done;
126:         return true;
127:       } catch (error) {
128:         await transaction.done.catch(() => undefined);
129:         throw error;
130:       } finally {
131:         if (existing instanceof Uint8Array) existing.fill(0);
132:       }
133:     } finally {
134:       expectedCopy.fill(0);
135:       replacementCopy.fill(0);
136:     }
137:   }
138: 
139:   /**
140:    * Serialize escrow read/CAS/send-enqueue work across tabs. A caller should
141:    * keep the callback to its critical section; this lock does not replace IDB
142:    * transactions or make network delivery durable.
143:    */
144:   async withCeremonyLock<T>(ceremonyId: string, task: () => Promise<T>): Promise<T> {
145:     // Bare ceremony digests use every base64url character, including the first one.
146:     const id = validateKey(ceremonyId, LOCK_PATTERN);
147:     const lockName = `cp2p/escrow-ceremony/${id}`;
148:     const provider = this.#lockProvider ?? browserLockProvider;
149:     return provider(lockName, task);
150:   }
151: 
152:   /** Close this connection; a later operation may open a fresh connection. */
153:   async close(): Promise<void> {
154:     const pending = this.#databasePromise;
155:     this.#databasePromise = null;
156:     if (!pending) return;
157:     const database = await pending;
158:     database.close();
159:   }
160: 
161:   #database(): Promise<IDBPDatabase<CP2PDatabase>> {
162:     if (this.#databasePromise) return this.#databasePromise;
163:     let opening: Promise<IDBPDatabase<CP2PDatabase>>;
164:     opening = openDatabase(
165:       () => {
166:         if (this.#databasePromise === opening) this.#databasePromise = null;
167:       },
168:       () => {
169:         if (this.#databasePromise === opening) this.#databasePromise = null;
170:       },
171:     ).catch((error: unknown) => {
172:       if (this.#databasePromise === opening) this.#databasePromise = null;
173:       throw error;
174:     });
175:     this.#databasePromise = opening;
176:     return opening;
177:   }
178: }
179: 
180: function validateKey(id: string, pattern = KEY_PATTERN): string {
181:   if (typeof id !== 'string' || id.length === 0 || id.length > MAX_KEY_LENGTH || !pattern.test(id))
182:     throw new TypeError('IndexedDB record key is invalid');
183:   return id;
184: }
185: 
186: function copyBytes(value: Uint8Array, maxBytes: number): Uint8Array {
187:   if (!(value instanceof Uint8Array) || value.byteLength > maxBytes)
188:     throw new RangeError('IndexedDB record must be a bounded Uint8Array');
189:   return value.slice();
190: }
191: 
192: function validateStoredBytes(value: unknown, maxBytes: number): Uint8Array {
193:   if (!(value instanceof Uint8Array) || value.byteLength > maxBytes)
194:     throw new TypeError('Stored IndexedDB record is malformed or oversized');
195:   return value;
```

### `packages/storage/src/indexed-db-protocol-journal.ts:75-265`

```ts
75:   readonly keyBinding?: { readonly recordKey: string; readonly bytes: Uint8Array };
76: }
77: 
78: /** Stores each certified entry once and updates next-height safety in the same transaction. */
79: export class IndexedDbProtocolJournal implements ProtocolJournal {
80:   readonly #gameId: string;
81:   readonly #maxRecordBytes: number;
82:   readonly #keyBinding: { readonly recordKey: string; readonly bytes: Uint8Array } | undefined;
83:   #databasePromise: Promise<IDBPDatabase<CP2PDatabase>> | null = null;
84:   #closePromise: Promise<void> | null = null;
85:   #closed = false;
86:   #activeOperations = 0;
87:   #drainOperations: (() => void) | null = null;
88: 
89:   constructor(gameId: string, options: IndexedDbProtocolJournalOptions = {}) {
90:     if (
91:       typeof gameId !== 'string' ||
92:       gameId.length === 0 ||
93:       gameId.length > 512 ||
94:       !/^[A-Za-z0-9_-][A-Za-z0-9._:/-]*$/.test(gameId)
95:     )
96:       throw new TypeError('Journal gameId is invalid');
97:     const maxRecordBytes = options.maxRecordBytes ?? MAX_RECORD_BYTES;
98:     if (
99:       !Number.isSafeInteger(maxRecordBytes) ||
100:       maxRecordBytes < 0 ||
101:       maxRecordBytes > MAX_RECORD_BYTES
102:     )
103:       throw new RangeError('maxRecordBytes must be between zero and 16 MiB');
104:     this.#gameId = gameId;
105:     this.#maxRecordBytes = maxRecordBytes;
106:     this.#keyBinding = options.keyBinding
107:       ? copyKeyBinding(options.keyBinding, maxRecordBytes)
108:       : undefined;
109:   }
110: 
111:   load() {
112:     return this.#runOperation(() => this.#load());
113:   }
114: 
115:   async #load() {
116:     const database = await this.#database();
117:     const keyBinding = this.#keyBinding;
118:     const stores = keyBinding
119:       ? ([GAME_STORE, ENTRY_STORE, CONSENSUS_STORE, BYTE_STORE, DELETED_GAME_STORE] as const)
120:       : ([GAME_STORE, ENTRY_STORE, CONSENSUS_STORE, DELETED_GAME_STORE] as const);
121:     const transaction = database.transaction(stores, 'readonly');
122:     let bindingBytes: Uint8Array | undefined;
123:     try {
124:       await assertOnlineGameNotDeleted(transaction, this.#gameId);
125:       const genesisBytes = await transaction.objectStore(GAME_STORE).get(this.#gameId);
126:       const consensusBytes = await transaction.objectStore(CONSENSUS_STORE).get(this.#gameId);
127:       const range = IDBKeyRange.bound([this.#gameId, 0], [this.#gameId, Number.MAX_SAFE_INTEGER]);
128:       const entryKeys = await transaction.objectStore(ENTRY_STORE).getAllKeys(range);
129:       const entryBytes = await transaction.objectStore(ENTRY_STORE).getAll(range);
130:       bindingBytes = keyBinding
131:         ? await transaction.objectStore(BYTE_STORE).get(keyBinding.recordKey)
132:         : undefined;
133:       await transaction.done;
134: 
135:       const journalAbsent =
136:         genesisBytes === undefined && consensusBytes === undefined && entryKeys.length === 0;
137:       if (journalAbsent) {
138:         if (bindingBytes !== undefined)
139:           throw new TypeError('Voting-key binding exists without its journal');
140:         return null;
141:       }
142:       if (
143:         keyBinding &&
144:         (bindingBytes === undefined ||
145:           !matchesKeyBinding(bindingBytes, keyBinding.bytes, this.#maxRecordBytes))
146:       )
147:         throw new TypeError('Journal voting-key binding is missing or mismatched');
148:       if (genesisBytes === undefined || consensusBytes === undefined)
149:         throw new TypeError('Journal metadata is incomplete');
150:       const genesis = decodeRecord(genesisBytes, logEntrySchema, this.#maxRecordBytes);
151:       if (
152:         genesis.seq !== 0 ||
153:         genesis.payload.kind !== 'genesis' ||
154:         genesis.payload.genesis.gameId !== this.#gameId
155:       )
156:         throw new TypeError('Stored journal genesis does not match its gameId');
157:       const consensus = decodeRecord(consensusBytes, consensusRecordSchema, this.#maxRecordBytes);
158:       const entries = entryBytes.map((bytes, index) => {
159:         const key = entryKeys[index];
160:         const certified = decodeRecord(bytes, certifiedEntrySchema, this.#maxRecordBytes);
161:         if (
162:           !Array.isArray(key) ||
163:           key[0] !== this.#gameId ||
164:           key[1] !== index + 1 ||
165:           certified.entry.seq !== index + 1
166:         )
167:           throw new TypeError('Stored journal entries are not contiguous');
168:         return certified;
169:       });
170:       validateHistory(genesis, entries, consensus, this.#gameId);
171:       return {
172:         genesis: copyLogEntry(genesis, this.#maxRecordBytes),
173:         entries: entries.map((entry) => copyCertifiedEntry(entry, this.#maxRecordBytes)),
174:         height: consensus.height,
175:         safety: { revision: consensus.revision, bytes: consensus.safety.slice() },
176:       };
177:     } catch (error) {
178:       await transaction.done.catch(() => undefined);
179:       throw error;
180:     } finally {
181:       if (bindingBytes instanceof Uint8Array) bindingBytes.fill(0);
182:     }
183:   }
184: 
185:   initialize(genesis: LogEntry, safety: Uint8Array): Promise<boolean> {
186:     return this.#runOperation(() => this.#initialize(genesis, safety));
187:   }
188: 
189:   async #initialize(genesis: LogEntry, safety: Uint8Array): Promise<boolean> {
190:     const checkedGenesis = copyLogEntry(genesis, this.#maxRecordBytes);
191:     if (
192:       checkedGenesis.seq !== 0 ||
193:       checkedGenesis.payload.kind !== 'genesis' ||
194:       checkedGenesis.payload.genesis.gameId !== this.#gameId
195:     )
196:       throw new TypeError('Journal genesis must be sequence zero for its pinned gameId');
197:     const safetyBytes = copyBytes(safety, this.#maxRecordBytes);
198:     const genesisBytes = canonicalEncode(checkedGenesis);
199:     const consensusBytes = encodeRecord(
200:       { height: 1, revision: 0, safety: safetyBytes },
201:       consensusRecordSchema,
202:       this.#maxRecordBytes,
203:     );
204:     const database = await this.#database();
205:     const keyBinding = this.#keyBinding;
206:     const stores = keyBinding
207:       ? ([GAME_STORE, ENTRY_STORE, CONSENSUS_STORE, BYTE_STORE, DELETED_GAME_STORE] as const)
208:       : ([GAME_STORE, ENTRY_STORE, CONSENSUS_STORE, DELETED_GAME_STORE] as const);
209:     const transaction = strictWriteTransaction(database, stores);
210:     let bindingExists: Uint8Array | undefined;
211:     try {
212:       await assertOnlineGameNotDeleted(transaction, this.#gameId);
213:       const genesisExists = await transaction.objectStore(GAME_STORE).get(this.#gameId);
214:       const consensusExists = await transaction.objectStore(CONSENSUS_STORE).get(this.#gameId);
215:       const entryCount = await transaction
216:         .objectStore(ENTRY_STORE)
217:         .count(IDBKeyRange.bound([this.#gameId, 0], [this.#gameId, Number.MAX_SAFE_INTEGER]));
218:       const journalExists =
219:         genesisExists !== undefined || consensusExists !== undefined || entryCount !== 0;
220:       bindingExists = keyBinding
221:         ? await transaction.objectStore(BYTE_STORE).get(keyBinding.recordKey)
222:         : undefined;
223:       if (keyBinding) {
224:         if (!journalExists && bindingExists !== undefined)
225:           throw new TypeError('Voting-key binding exists without its journal');
226:         if (
227:           journalExists &&
228:           (bindingExists === undefined ||
229:             !matchesKeyBinding(bindingExists, keyBinding.bytes, this.#maxRecordBytes))
230:         )
231:           throw new TypeError('Existing journal voting-key binding is missing or mismatched');
232:       }
233:       if (journalExists) {
234:         if (genesisExists === undefined || consensusExists === undefined)
235:           throw new TypeError('Existing journal metadata is incomplete');
236:         const existingGenesis = decodeRecord(genesisExists, logEntrySchema, this.#maxRecordBytes);
237:         const existingConsensus = decodeRecord(
238:           consensusExists,
239:           consensusRecordSchema,
240:           this.#maxRecordBytes,
241:         );
242:         if (
243:           existingGenesis.seq !== 0 ||
244:           existingGenesis.payload.kind !== 'genesis' ||
245:           existingGenesis.payload.genesis.gameId !== this.#gameId ||
246:           existingConsensus.height !== entryCount + 1
247:         )
248:           throw new TypeError('Existing journal metadata is inconsistent');
249:         if (!equalBytes(canonicalEncode(existingGenesis), genesisBytes))
250:           throw new TypeError('Existing journal genesis differs from requested genesis');
251:         await transaction.done;
252:         return false;
253:       }
254:       if (keyBinding) {
255:         const bindingCopy = keyBinding.bytes.slice();
256:         try {
257:           await transaction.objectStore(BYTE_STORE).add(bindingCopy, keyBinding.recordKey);
258:         } finally {
259:           bindingCopy.fill(0);
260:         }
261:       }
262:       await transaction.objectStore(GAME_STORE).add(genesisBytes, this.#gameId);
263:       await transaction.objectStore(CONSENSUS_STORE).add(consensusBytes, this.#gameId);
264:       await transaction.done;
265:       return true;
```

### `packages/storage/src/indexed-db-protocol-journal.ts:315-445`

```ts
315:         : null;
316:     } catch (error) {
317:       await transaction.done.catch(() => undefined);
318:       throw error;
319:     } finally {
320:       if (bindingBytes instanceof Uint8Array) bindingBytes.fill(0);
321:     }
322:   }
323: 
324:   saveSafety(height: number, revision: number, bytes: Uint8Array): Promise<boolean> {
325:     return this.#runOperation(() => this.#saveSafety(height, revision, bytes));
326:   }
327: 
328:   async #saveSafety(height: number, revision: number, bytes: Uint8Array): Promise<boolean> {
329:     validateHeight(height);
330:     validateRevision(revision);
331:     if (revision === Number.MAX_SAFE_INTEGER) return false;
332:     const safety = copyBytes(bytes, this.#maxRecordBytes);
333:     const database = await this.#database();
334:     const keyBinding = this.#keyBinding;
335:     const stores = keyBinding
336:       ? ([CONSENSUS_STORE, BYTE_STORE, DELETED_GAME_STORE] as const)
337:       : ([CONSENSUS_STORE, DELETED_GAME_STORE] as const);
338:     const transaction = strictWriteTransaction(database, stores);
339:     let bindingBytes: Uint8Array | undefined;
340:     try {
341:       await assertOnlineGameNotDeleted(transaction, this.#gameId);
342:       const currentBytes = await transaction.objectStore(CONSENSUS_STORE).get(this.#gameId);
343:       if (currentBytes === undefined) {
344:         await transaction.done;
345:         return false;
346:       }
347:       if (keyBinding) {
348:         bindingBytes = await transaction.objectStore(BYTE_STORE).get(keyBinding.recordKey);
349:         if (
350:           bindingBytes === undefined ||
351:           !matchesKeyBinding(bindingBytes, keyBinding.bytes, this.#maxRecordBytes)
352:         )
353:           throw new TypeError('Journal voting-key binding is missing or mismatched');
354:       }
355:       const current = decodeRecord(currentBytes, consensusRecordSchema, this.#maxRecordBytes);
356:       if (current.height !== height || current.revision !== revision) {
357:         await transaction.done;
358:         return false;
359:       }
360:       const replacement = encodeRecord(
361:         { height, revision: revision + 1, safety },
362:         consensusRecordSchema,
363:         this.#maxRecordBytes,
364:       );
365:       await transaction.objectStore(CONSENSUS_STORE).put(replacement, this.#gameId);
366:       await transaction.done;
367:       return true;
368:     } catch (error) {
369:       await transaction.done.catch(() => undefined);
370:       throw error;
371:     } finally {
372:       if (bindingBytes instanceof Uint8Array) bindingBytes.fill(0);
373:     }
374:   }
375: 
376:   commit(
377:     height: number,
378:     safetyRevision: number,
379:     certified: CertifiedEntry,
380:     nextSafety: Uint8Array,
381:   ): Promise<boolean> {
382:     return this.#runOperation(() => this.#commit(height, safetyRevision, certified, nextSafety));
383:   }
384: 
385:   async #commit(
386:     height: number,
387:     safetyRevision: number,
388:     certified: CertifiedEntry,
389:     nextSafety: Uint8Array,
390:   ): Promise<boolean> {
391:     validateHeight(height);
392:     validateRevision(safetyRevision);
393:     if (height === Number.MAX_SAFE_INTEGER) return false;
394:     const checkedEntry = copyCertifiedEntry(certified, this.#maxRecordBytes);
395:     if (checkedEntry.entry.seq !== height) return false;
396:     const certifiedBytes = canonicalEncode(checkedEntry);
397:     const safetyBytes = copyBytes(nextSafety, this.#maxRecordBytes);
398:     const nextConsensus = encodeRecord(
399:       { height: height + 1, revision: 0, safety: safetyBytes },
400:       consensusRecordSchema,
401:       this.#maxRecordBytes,
402:     );
403:     const database = await this.#database();
404:     const keyBinding = this.#keyBinding;
405:     const stores = keyBinding
406:       ? ([GAME_STORE, ENTRY_STORE, CONSENSUS_STORE, BYTE_STORE, DELETED_GAME_STORE] as const)
407:       : ([GAME_STORE, ENTRY_STORE, CONSENSUS_STORE, DELETED_GAME_STORE] as const);
408:     const transaction = strictWriteTransaction(database, stores);
409:     let bindingBytes: Uint8Array | undefined;
410:     try {
411:       await assertOnlineGameNotDeleted(transaction, this.#gameId);
412:       const consensusBytes = await transaction.objectStore(CONSENSUS_STORE).get(this.#gameId);
413:       if (consensusBytes === undefined) {
414:         await transaction.done;
415:         return false;
416:       }
417:       if (keyBinding) {
418:         bindingBytes = await transaction.objectStore(BYTE_STORE).get(keyBinding.recordKey);
419:         if (
420:           bindingBytes === undefined ||
421:           !matchesKeyBinding(bindingBytes, keyBinding.bytes, this.#maxRecordBytes)
422:         )
423:           throw new TypeError('Journal voting-key binding is missing or mismatched');
424:       }
425:       const current = decodeRecord(consensusBytes, consensusRecordSchema, this.#maxRecordBytes);
426:       if (current.height !== height || current.revision !== safetyRevision) {
427:         await transaction.done;
428:         return false;
429:       }
430:       const parent = await this.#parentEntry(transaction, height);
431:       if (checkedEntry.entry.prevHash !== entryHash(parent)) {
432:         await transaction.done;
433:         return false;
434:       }
435:       await transaction.objectStore(ENTRY_STORE).add(certifiedBytes, [this.#gameId, height]);
436:       await transaction.objectStore(CONSENSUS_STORE).put(nextConsensus, this.#gameId);
437:       await transaction.done;
438:       return true;
439:     } catch (error) {
440:       await transaction.done.catch(() => undefined);
441:       throw error;
442:     } finally {
443:       if (bindingBytes instanceof Uint8Array) bindingBytes.fill(0);
444:     }
445:   }
```

### `packages/storage/src/indexed-db-protocol-journal.ts:450-575`

```ts
450:    * writers; the transaction remains the cross-tab compare-and-swap boundary.
451:    */
452:   promoteTransfer(options: TransferPromotionOptions): Promise<boolean> {
453:     if (this.#closed) return Promise.reject(new Error('Journal is closed'));
454:     const activation = copyCertifiedEntry(options.activation, this.#maxRecordBytes);
455:     const expectedActive = options.expectedActive
456:       ? {
457:           head: { ...options.expectedActive.head },
458:           bindingBytes: copyBytes(options.expectedActive.bindingBytes, this.#maxRecordBytes),
459:         }
460:       : null;
461:     return this.#runOperation(async () => {
462:       let lease: Awaited<ReturnType<typeof acquireActiveGameWriterLease>> = null;
463:       try {
464:         lease = await acquireActiveGameWriterLease(this.#gameId, options.leaseOptions);
465:         if (!lease) return false;
466:         return await lease.run(() =>
467:           this.#promoteTransfer({ ...options, activation, expectedActive }),
468:         );
469:       } finally {
470:         try {
471:           await lease?.close();
472:         } finally {
473:           expectedActive?.bindingBytes.fill(0);
474:         }
475:       }
476:     });
477:   }
478: 
479:   async #promoteTransfer(options: TransferPromotionOptions): Promise<boolean> {
480:     const keyBinding = this.#keyBinding;
481:     if (!keyBinding) throw new TypeError('Transfer promotion requires a destination key binding');
482:     const stagedStore = new TransferImportStore();
483:     let staged: Awaited<ReturnType<TransferImportStore['load']>> = null;
484:     let readiness: Awaited<ReturnType<TransferImportStore['loadReadiness']>> = null;
485:     try {
486:       staged = await stagedStore.load(options.stageKey);
487:       readiness = await stagedStore.loadReadiness(options.stageKey);
488:       if (!staged || !readiness || staged.gameId !== this.#gameId)
489:         throw new TypeError('Transfer import or durable readiness is missing');
490:       const authorization = staged.authorization;
491:       if (
492:         !equalBytes(staged.bindingBytes, keyBinding.bytes) ||
493:         options.activation.entry.seq !== staged.head.seq + 1 ||
494:         options.activation.entry.prevHash !== staged.head.hash ||
495:         staged.authorization.seq >= options.activation.entry.seq
496:       )
497:         throw new TypeError('Activation is not the exact next entry after staged import');
498:       const fullEntries = [...staged.entries, options.activation];
499:       const before = replayCertifiedPrefix(
500:         staged.genesis,
501:         staged.entries,
502:         options.engine,
503:         options.policy,
504:       );
505:       const after = replayCertifiedPrefix(
506:         staged.genesis,
507:         fullEntries,
508:         options.engine,
509:         options.policy,
510:       );
511:       if (!before.ok || !after.ok)
512:         throw new TypeError('Transfer promotion requires a fully certified valid prefix');
513:       const change = options.activation.entry.payload;
514:       if (
515:         change.kind !== 'membership' ||
516:         !isTransferActivation(change.change) ||
517:         change.change.statement.authorization.seq !== staged.authorization.seq ||
518:         change.change.statement.authorization.hash !== staged.authorization.hash ||
519:         change.change.statement.parent.seq !== staged.head.seq ||
520:         change.change.statement.parent.hash !== staged.head.hash ||
521:         !equalBytes(
522:           canonicalEncode(readiness.statement),
523:           canonicalEncode(change.change.statement),
524:         ) ||
525:         readiness.destinationCheck !== change.change.destinationCheck ||
526:         !equalBytes(
527:           canonicalEncode(readiness.replacementChecks),
528:           canonicalEncode(change.change.replacementChecks),
529:         ) ||
530:         !after.value.context.log.transfer?.completed.some(
531:           (item) =>
532:             item.outcome === 'activated' &&
533:             item.authorization.seq === authorization.seq &&
534:             item.authorization.hash === authorization.hash &&
535:             item.entry.seq === options.activation.entry.seq &&
536:             item.entry.hash === entryHash(options.activation.entry),
537:         )
538:       )
539:         throw new TypeError('Certified activation differs from durable import readiness');
540:       const digest = genesisDigest(after.value.context.log.genesis);
541:       if (keyBinding.recordKey !== `online-game/${digest}/keys`)
542:         throw new TypeError('Destination binding is outside its game namespace');
543:       const destinationBinding = canonicalDecode(keyBinding.bytes);
544:       let owned: ReturnType<typeof validateTransferOwnedMaterial>;
545:       try {
546:         owned = validateTransferOwnedMaterial(destinationBinding, after.value.context.log);
547:       } finally {
548:         wipeDecodedBytes(destinationBinding);
549:       }
550:       if (!owned.ok) throw new TypeError(`Destination material: ${owned.error.code}`);
551:       for (const seat of owned.value.seats) {
552:         seat.signingKey.fill(0);
553:         seat.master.fill(0);
554:       }
555:       const approved = after.value.context.log.transfer?.authorizations.find(
556:         (item) => item.entry.seq === authorization.seq && item.entry.hash === authorization.hash,
557:       );
558:       const destinationSeat = approved?.statement.seat;
559:       if (destinationSeat === undefined)
560:         throw new TypeError('Certified destination seat is missing');
561:       const fresh = createConsensusState(after.value.context, destinationSeat);
562:       if (!fresh.ok) throw new TypeError(`Fresh transfer safety: ${fresh.error.code}`);
563:       const nextConsensus = encodeRecord(
564:         {
565:           height: options.activation.entry.seq + 1,
566:           revision: 0,
567:           safety: canonicalEncode(fresh.value),
568:         },
569:         consensusRecordSchema,
570:         this.#maxRecordBytes,
571:       );
572:       const oldBinding = options.expectedActive?.bindingBytes;
573:       if (oldBinding) {
574:         const historical = historicalOldMaterialContext(
575:           staged.genesis,
```

### `packages/storage/src/indexed-db-protocol-journal.ts:605-745`

```ts
605:           throw new TypeError('Existing binding belongs to a different device or seat');
606:       }
607:       const database = await this.#database();
608:       const transaction = strictWriteTransaction(database, [
609:         GAME_STORE,
610:         ENTRY_STORE,
611:         CONSENSUS_STORE,
612:         DELETED_GAME_STORE,
613:         BYTE_STORE,
614:       ]);
615:       let storedStage: Uint8Array | undefined;
616:       let storedCheck: Uint8Array | undefined;
617:       try {
618:         await assertOnlineGameNotDeleted(transaction, this.#gameId);
619:         const bytes = transaction.objectStore(BYTE_STORE);
620:         const finalKey = transferImportFinalKey(staged);
621:         const priorFinal = await bytes.get(finalKey);
622:         if (priorFinal !== undefined) {
623:           if (priorFinal instanceof Uint8Array) priorFinal.fill(0);
624:           throw new TypeError('Transfer authorization was already finalized locally');
625:         }
626:         storedStage = await bytes.get(options.stageKey);
627:         storedCheck = await bytes.get(readinessKey(options.stageKey));
628:         const stagedBytes = canonicalEncode(staged);
629:         const readinessBytes = canonicalEncode(readiness);
630:         const stageMatches = Boolean(storedStage && equalBytes(storedStage, stagedBytes));
631:         stagedBytes.fill(0);
632:         storedStage?.fill(0);
633:         const checkMatches = Boolean(storedCheck && equalBytes(storedCheck, readinessBytes));
634:         readinessBytes.fill(0);
635:         storedCheck?.fill(0);
636:         if (!stageMatches || !checkMatches)
637:           throw new TypeError('Transfer import changed during promotion');
638:         const games = transaction.objectStore(GAME_STORE);
639:         const entries = transaction.objectStore(ENTRY_STORE);
640:         const consensus = transaction.objectStore(CONSENSUS_STORE);
641:         const existingGenesis = await games.get(this.#gameId);
642:         const existingSafety = await consensus.get(this.#gameId);
643:         const existingBinding = await bytes.get(keyBinding.recordKey);
644:         const bindingMatches = Boolean(
645:           existingBinding &&
646:           options.expectedActive &&
647:           equalBytes(existingBinding, options.expectedActive.bindingBytes),
648:         );
649:         existingBinding?.fill(0);
650:         const range = IDBKeyRange.bound([this.#gameId, 0], [this.#gameId, Number.MAX_SAFE_INTEGER]);
651:         const existingKeys = await entries.getAllKeys(range);
652:         const existingEntries = await entries.getAll(range);
653:         if (options.expectedActive === null) {
654:           if (
655:             existingGenesis !== undefined ||
656:             existingSafety !== undefined ||
657:             existingBinding !== undefined ||
658:             existingKeys.length !== 0
659:           )
660:             throw new TypeError('Fresh destination already has active or partial journal state');
661:         } else {
662:           const expected = options.expectedActive;
663:           if (
664:             existingGenesis === undefined ||
665:             existingSafety === undefined ||
666:             !bindingMatches ||
667:             !equalBytes(existingGenesis, canonicalEncode(staged.genesis)) ||
668:             expected.head.seq !== existingKeys.length ||
669:             expected.head.seq > options.activation.entry.seq
670:           )
671:             throw new TypeError('Existing active journal binding or head changed');
672:           const oldSafety = decodeRecord(
673:             existingSafety,
674:             consensusRecordSchema,
675:             this.#maxRecordBytes,
676:           );
677:           if (oldSafety.height !== existingKeys.length + 1)
678:             throw new TypeError('Existing active journal safety is incomplete');
679:           if (existingKeys.length === options.activation.entry.seq) {
680:             const retiredKey = oldMaterialKey(approved, before.value.context.log.transfer);
681:             const markerBytes = canonicalDecode(oldSafety.safety);
682:             try {
683:               const marker = restoreRetiredSafety(
684:                 markerBytes,
685:                 after.value.context,
686:                 destinationSeat,
687:                 retiredKey,
688:               );
689:               if (!marker.ok)
690:                 throw new TypeError(`Existing controller was not retired: ${marker.error.code}`);
691:             } finally {
692:               wipeDecodedBytes(markerBytes);
693:             }
694:           }
695:           const oldHead =
696:             existingKeys.length === 0
697:               ? staged.genesis
698:               : decodeRecord(existingEntries.at(-1), certifiedEntrySchema, this.#maxRecordBytes)
699:                   .entry;
700:           if (entryHash(oldHead) !== expected.head.hash)
701:             throw new TypeError('Existing active journal head is stale');
702:           for (const [index, stored] of existingEntries.entries()) {
703:             const key = existingKeys[index];
704:             if (
705:               !Array.isArray(key) ||
706:               key[0] !== this.#gameId ||
707:               key[1] !== index + 1 ||
708:               !equalBytes(stored, canonicalEncode(fullEntries[index]))
709:             )
710:               throw new TypeError('Existing active journal conflicts with certified import');
711:           }
712:         }
713:         if (existingGenesis === undefined) {
714:           const genesisBytes = encodeRecord(staged.genesis, logEntrySchema, this.#maxRecordBytes);
715:           try {
716:             await games.add(genesisBytes, this.#gameId);
717:           } finally {
718:             genesisBytes.fill(0);
719:           }
720:         }
721:         for (const [offset, entry] of fullEntries.slice(existingKeys.length).entries()) {
722:           const encoded = encodeRecord(entry, certifiedEntrySchema, this.#maxRecordBytes);
723:           try {
724:             // Retain canonical entry order and wipe each staged record after its IDB request.
725:             // eslint-disable-next-line no-await-in-loop
726:             await entries.add(encoded, [this.#gameId, existingKeys.length + offset + 1]);
727:           } finally {
728:             encoded.fill(0);
729:           }
730:         }
731:         await consensus.put(nextConsensus, this.#gameId);
732:         const bindingCopy = keyBinding.bytes.slice();
733:         try {
734:           await bytes.put(bindingCopy, keyBinding.recordKey);
735:         } finally {
736:           bindingCopy.fill(0);
737:         }
738:         const marker = canonicalEncode({
739:           outcome: 'promoted',
740:           authorization: staged.authorization,
741:           activation: {
742:             seq: options.activation.entry.seq,
743:             hash: entryHash(options.activation.entry),
744:           },
745:         });
```

### `packages/storage/src/indexed-db-protocol-journal.ts:770-835`

```ts
770:   }
771: 
772:   close(): Promise<void> {
773:     if (this.#closePromise) return this.#closePromise;
774:     this.#closed = true;
775:     this.#closePromise = this.#closeAfterOperations();
776:     return this.#closePromise;
777:   }
778: 
779:   async #closeAfterOperations(): Promise<void> {
780:     try {
781:       if (this.#activeOperations > 0) {
782:         await new Promise<void>((resolve) => {
783:           this.#drainOperations = resolve;
784:         });
785:       }
786:       const pending = this.#databasePromise;
787:       this.#databasePromise = null;
788:       if (pending) (await pending).close();
789:     } finally {
790:       this.#keyBinding?.bytes.fill(0);
791:     }
792:   }
793: 
794:   #database(): Promise<IDBPDatabase<CP2PDatabase>> {
795:     if (this.#closed) return Promise.reject(new Error('Journal is closed'));
796:     if (this.#databasePromise) return this.#databasePromise;
797:     let opening: Promise<IDBPDatabase<CP2PDatabase>>;
798:     opening = openDatabase(
799:       () => {
800:         if (this.#databasePromise === opening) this.#databasePromise = null;
801:       },
802:       () => {
803:         if (this.#databasePromise === opening) this.#databasePromise = null;
804:       },
805:     ).catch((error: unknown) => {
806:       if (this.#databasePromise === opening) this.#databasePromise = null;
807:       throw error;
808:     });
809:     this.#databasePromise = opening;
810:     return opening;
811:   }
812: 
813:   #runOperation<T>(operation: () => Promise<T>): Promise<T> {
814:     if (this.#closed) return Promise.reject(new Error('Journal is closed'));
815:     this.#activeOperations += 1;
816:     return (async () => {
817:       try {
818:         return await operation();
819:       } finally {
820:         this.#activeOperations -= 1;
821:         if (this.#activeOperations === 0) {
822:           this.#drainOperations?.();
823:           this.#drainOperations = null;
824:         }
825:       }
826:     })();
827:   }
828: 
829:   async #parentEntry(
830:     transaction: ReturnType<typeof strictWriteTransaction>,
831:     height: number,
832:   ): Promise<LogEntry> {
833:     if (height === 1) {
834:       const genesisBytes = await transaction.objectStore(GAME_STORE).get(this.#gameId);
835:       if (genesisBytes === undefined) throw new TypeError('Journal genesis is missing');
```

### `packages/storage/src/transfer-import-store.ts:1-210`

```ts
1: import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
2: import {
3:   certifiedEntrySchema,
4:   entryHash,
5:   logEntrySchema,
6:   replayCertifiedPrefix,
7:   transferActivationStatementSchema,
8:   validatePendingTransferMaterial,
9: } from '@cp2p/protocol';
10: import type { CertifiedEntry, LogEntry, ReplayPolicy } from '@cp2p/protocol';
11: import * as v from 'valibot';
12: import {
13:   BYTE_STORE,
14:   DELETED_GAME_STORE,
15:   MAX_RECORD_BYTES,
16:   openDatabase,
17:   strictWriteTransaction,
18: } from './database.js';
19: import { assertOnlineGameNotDeleted } from './online-game-deletion.js';
20: import { IndexedDbByteStore } from './indexed-db-byte-store.js';
21: 
22: const hashSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));
23: const peerSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));
24: const refSchema = v.strictObject({
25:   seq: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER)),
26:   hash: hashSchema,
27: });
28: const bytesSchema = v.custom<Uint8Array>((value) => value instanceof Uint8Array);
29: const stageSchema = v.strictObject({
30:   protocol: v.literal('seat-transfer-import-v1'),
31:   gameId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,128}$/)),
32:   authorization: refSchema,
33:   destinationGameKey: peerSchema,
34:   head: refSchema,
35:   bindingBytes: bytesSchema,
36:   sealedPackage: bytesSchema,
37:   privateReplayBytes: bytesSchema,
38:   genesis: logEntrySchema,
39:   entries: v.array(certifiedEntrySchema),
40: });
41: const readinessSchema = v.strictObject({
42:   protocol: v.literal('seat-transfer-readiness-v1'),
43:   statement: transferActivationStatementSchema,
44:   destinationCheck: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{86}$/)),
45:   replacementChecks: v.pipe(
46:     v.array(
47:       v.strictObject({
48:         seat: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5)),
49:         sig: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{86}$/)),
50:       }),
51:     ),
52:     v.maxLength(6),
53:   ),
54: });
55: const outcomeSchema = v.variant('outcome', [
56:   v.strictObject({
57:     outcome: v.literal('cancelled'),
58:     authorization: refSchema,
59:   }),
60:   v.strictObject({
61:     outcome: v.literal('promoted'),
62:     authorization: refSchema,
63:     activation: refSchema,
64:   }),
65: ]);
66: 
67: export type TransferImportRecord = v.InferOutput<typeof stageSchema>;
68: export type TransferReadinessRecord = v.InferOutput<typeof readinessSchema>;
69: export type TransferImportOutcome =
70:   | { readonly kind: 'missing' }
71:   | { readonly kind: 'cancelled' }
72:   | {
73:       readonly kind: 'promoted';
74:       readonly activation: { readonly seq: number; readonly hash: string };
75:     };
76: export type TransferReplayEngine = Parameters<typeof replayCertifiedPrefix>[2];
77: export interface TransferImportInput {
78:   readonly gameId: string;
79:   readonly authorization: { readonly seq: number; readonly hash: string };
80:   readonly destinationGameKey: string;
81:   readonly bindingBytes: Uint8Array;
82:   readonly sealedPackage: Uint8Array;
83:   readonly privateReplayBytes: Uint8Array;
84:   readonly genesis: LogEntry;
85:   readonly entries: readonly CertifiedEntry[];
86: }
87: 
88: /** An immutable private import. Its presence never gives the destination voting authority. */
89: export class TransferImportStore {
90:   readonly #bytes: IndexedDbByteStore;
91: 
92:   constructor(bytes = new IndexedDbByteStore()) {
93:     this.#bytes = bytes;
94:   }
95: 
96:   async stage(
97:     value: TransferImportInput,
98:     engine: TransferReplayEngine,
99:     policy: ReplayPolicy,
100:   ): Promise<string> {
101:     assertBoundedStageInput(value, this.#bytes.maxRecordBytes);
102:     const entries = value.entries;
103:     const last = entries.at(-1)?.entry ?? value.genesis;
104:     const checked = v.parse(stageSchema, {
105:       ...value,
106:       protocol: 'seat-transfer-import-v1',
107:       head: { seq: last.seq, hash: entryHash(last) },
108:     });
109:     const bytes = canonicalEncode(checked);
110:     if (bytes.byteLength > this.#bytes.maxRecordBytes) {
111:       bytes.fill(0);
112:       throw new RangeError('Transfer import exceeds the durable record limit');
113:     }
114:     try {
115:       if (
116:         checked.genesis.payload.kind !== 'genesis' ||
117:         checked.genesis.payload.genesis.gameId !== checked.gameId
118:       )
119:         throw new TypeError('Transfer import genesis differs from its game');
120:       const replayed = replayCertifiedPrefix(checked.genesis, checked.entries, engine, policy);
121:       if (!replayed.ok) throw new TypeError(`Transfer import prefix: ${replayed.error.code}`);
122:       const transfer = replayed.value.context.log.transfer;
123:       const authorization = transfer?.authorizations.find(
124:         (item) =>
125:           item.entry.seq === checked.authorization.seq &&
126:           item.entry.hash === checked.authorization.hash,
127:       );
128:       if (
129:         transfer?.pending?.seq !== checked.authorization.seq ||
130:         transfer.pending.hash !== checked.authorization.hash ||
131:         !authorization ||
132:         authorization.statement.destination.gamePeer !== checked.destinationGameKey ||
133:         replayed.value.context.log.head.seq !== checked.head.seq ||
134:         entryHash(replayed.value.context.log.head) !== checked.head.hash
135:       )
136:         throw new TypeError('Transfer import is not pinned to the certified pending authorization');
137:       const binding = canonicalDecode(checked.bindingBytes);
138:       let material: ReturnType<typeof validatePendingTransferMaterial>;
139:       try {
140:         material = validatePendingTransferMaterial(
141:           binding,
142:           replayed.value.context.log,
143:           checked.authorization,
144:         );
145:       } finally {
146:         wipeByteArrays(binding);
147:       }
148:       if (!material.ok) throw new TypeError(`Transfer import material: ${material.error.code}`);
149:       for (const seat of material.value.seats) {
150:         seat.signingKey.fill(0);
151:         seat.master.fill(0);
152:       }
153:       const key = transferImportKey(checked);
154:       const database = await openDatabase(
155:         () => undefined,
156:         () => undefined,
157:       );
158:       try {
159:         const transaction = strictWriteTransaction(database, [BYTE_STORE, DELETED_GAME_STORE]);
160:         try {
161:           await assertOnlineGameNotDeleted(transaction, checked.gameId);
162:           const store = transaction.objectStore(BYTE_STORE);
163:           const final = await store.get(transferImportFinalKey(checked));
164:           if (final !== undefined) {
165:             final.fill(0);
166:             throw new TypeError('Transfer authorization is already finalized locally');
167:           }
168:           const existing = await store.get(key);
169:           try {
170:             if (existing === undefined) await store.add(bytes, key);
171:             else if (!equalBytes(existing, bytes))
172:               throw new TypeError('Transfer import already exists with different bytes');
173:           } finally {
174:             existing?.fill(0);
175:           }
176:           await transaction.done;
177:         } catch (error) {
178:           transaction.abort();
179:           await transaction.done.catch(() => undefined);
180:           throw error;
181:         }
182:       } finally {
183:         database.close();
184:       }
185:       return key;
186:     } finally {
187:       bytes.fill(0);
188:     }
189:   }
190: 
191:   async load(key: string): Promise<TransferImportRecord | null> {
192:     const bytes = await this.#bytes.load(key);
193:     if (!bytes) return null;
194:     let decoded: unknown;
195:     let accepted = false;
196:     try {
197:       decoded = canonicalDecode(bytes);
198:       const parsed = v.parse(stageSchema, decoded);
199:       const canonical = canonicalEncode(parsed);
200:       const exact = equalBytes(canonical, bytes);
201:       canonical.fill(0);
202:       if (!exact || transferImportKey(parsed) !== key) {
203:         wipeByteArrays(parsed);
204:         throw new TypeError('Stored transfer import is noncanonical or misplaced');
205:       }
206:       accepted = true;
207:       return parsed;
208:     } finally {
209:       if (!accepted) wipeByteArrays(decoded);
210:       bytes.fill(0);
```

### `packages/storage/src/transfer-import-store.ts:225-305`

```ts
225:         checked.statement.destinationGame !== stage.destinationGameKey
226:       )
227:         throw new TypeError('Readiness does not bind the exact staged parent and destination');
228:       const bytes = canonicalEncode(checked);
229:       try {
230:         if (bytes.byteLength > this.#bytes.maxRecordBytes)
231:           throw new RangeError('Transfer readiness exceeds the durable record limit');
232:         const database = await openDatabase(
233:           () => undefined,
234:           () => undefined,
235:         );
236:         try {
237:           const transaction = strictWriteTransaction(database, [BYTE_STORE, DELETED_GAME_STORE]);
238:           try {
239:             await assertOnlineGameNotDeleted(transaction, stage.gameId);
240:             const store = transaction.objectStore(BYTE_STORE);
241:             const final = await store.get(transferImportFinalKey(stage));
242:             if (final !== undefined) {
243:               final.fill(0);
244:               throw new TypeError('Transfer authorization is already finalized locally');
245:             }
246:             const storedStage = await store.get(key);
247:             const stageBytes = canonicalEncode(stage);
248:             try {
249:               if (!storedStage || !equalBytes(storedStage, stageBytes))
250:                 throw new TypeError('Transfer import changed before readiness');
251:             } finally {
252:               stageBytes.fill(0);
253:               storedStage?.fill(0);
254:             }
255:             const slot = readinessKey(key);
256:             const previous = await store.get(slot);
257:             try {
258:               if (previous === undefined) await store.add(bytes, slot);
259:               else if (!equalBytes(previous, bytes))
260:                 throw new TypeError('A different readiness packet is already durable');
261:             } finally {
262:               previous?.fill(0);
263:             }
264:             await transaction.done;
265:           } catch (error) {
266:             transaction.abort();
267:             await transaction.done.catch(() => undefined);
268:             throw error;
269:           }
270:         } finally {
271:           database.close();
272:         }
273:       } finally {
274:         bytes.fill(0);
275:       }
276:     } finally {
277:       wipeByteArrays(stage);
278:     }
279:   }
280: 
281:   async loadReadiness(key: string): Promise<TransferReadinessRecord | null> {
282:     const bytes = await this.#bytes.load(readinessKey(key));
283:     if (!bytes) return null;
284:     try {
285:       const parsed = v.parse(readinessSchema, canonicalDecode(bytes));
286:       const canonical = canonicalEncode(parsed);
287:       try {
288:         if (!equalBytes(canonical, bytes))
289:           throw new TypeError('Stored transfer readiness is noncanonical');
290:         return parsed;
291:       } finally {
292:         canonical.fill(0);
293:       }
294:     } finally {
295:       bytes.fill(0);
296:     }
297:   }
298: 
299:   /**
300:    * Read the durable outcome marker only. Callers must match it against replayed
301:    * certified history and the active journal before treating it as an outcome.
302:    */
303:   async readOutcome(
304:     gameId: string,
305:     authorization: { readonly seq: number; readonly hash: string },
```

### `packages/storage/src/transfer-import-store.ts:345-420`

```ts
345:     authorization: { seq: number; hash: string };
346:     genesis: LogEntry;
347:     entries: readonly CertifiedEntry[];
348:     engine: TransferReplayEngine;
349:     policy: ReplayPolicy;
350:   }): Promise<void> {
351:     assertBoundedStageInput({ genesis: input.genesis, entries: input.entries });
352:     const replayed = replayCertifiedPrefix(
353:       input.genesis,
354:       input.entries,
355:       input.engine,
356:       input.policy,
357:     );
358:     if (!replayed.ok) throw new TypeError(`Transfer cancellation prefix: ${replayed.error.code}`);
359:     const transfer = replayed.value.context.log.transfer;
360:     if (
361:       input.genesis.payload.kind !== 'genesis' ||
362:       input.genesis.payload.genesis.gameId !== input.gameId ||
363:       !transfer?.completed.some(
364:         (item) =>
365:           item.outcome === 'cancelled' &&
366:           item.authorization.seq === input.authorization.seq &&
367:           item.authorization.hash === input.authorization.hash,
368:       )
369:     )
370:       throw new TypeError('Transfer authorization has no certified cancellation');
371:     const finalKey = transferImportFinalKey(input);
372:     const marker = canonicalEncode({ outcome: 'cancelled', authorization: input.authorization });
373:     if (marker.byteLength > this.#bytes.maxRecordBytes) {
374:       marker.fill(0);
375:       throw new RangeError('Transfer outcome exceeds the durable record limit');
376:     }
377:     const database = await openDatabase(
378:       () => undefined,
379:       () => undefined,
380:     );
381:     try {
382:       const transaction = strictWriteTransaction(database, [BYTE_STORE, DELETED_GAME_STORE]);
383:       try {
384:         await assertOnlineGameNotDeleted(transaction, input.gameId);
385:         const store = transaction.objectStore(BYTE_STORE);
386:         const existing = await store.get(finalKey);
387:         try {
388:           if (existing === undefined) await store.add(marker, finalKey);
389:           else if (!equalBytes(existing, marker))
390:             throw new TypeError('Transfer authorization has another durable outcome');
391:         } finally {
392:           existing?.fill(0);
393:         }
394:         await deleteAuthorizationStages(store, input.gameId, input.authorization.hash);
395:         await transaction.done;
396:       } catch (error) {
397:         transaction.abort();
398:         await transaction.done.catch(() => undefined);
399:         throw error;
400:       }
401:     } finally {
402:       marker.fill(0);
403:       database.close();
404:     }
405:   }
406: 
407:   close(): Promise<void> {
408:     return this.#bytes.close();
409:   }
410: }
411: 
412: export function transferImportKey(
413:   record: Pick<TransferImportRecord, 'gameId' | 'authorization' | 'destinationGameKey' | 'head'>,
414: ): string {
415:   return `transfer-import/${record.gameId}/${record.authorization.hash}/${record.destinationGameKey}/${record.head.hash}`;
416: }
417: 
418: export function readinessKey(stageKey: string): string {
419:   return `${stageKey}/readiness`;
420: }
```

### `packages/storage/src/online-game-deletion.ts:150-270`

```ts
150:     try {
151:       await lease.close();
152:     } finally {
153:       await byteStore.close();
154:     }
155:   }
156: }
157: 
158: async function deleteTransaction(
159:   gameId: string,
160:   expectedGenesisDigest: string,
161:   deletedAt: number,
162: ): Promise<DeleteOnlineGameDataResult> {
163:   if (!Number.isSafeInteger(deletedAt) || deletedAt < 0)
164:     throw new RangeError('Deletion time is invalid');
165:   const database = await openDatabase(
166:     () => undefined,
167:     () => undefined,
168:   );
169:   const transaction = strictWriteTransaction(database, [
170:     DELETED_GAME_STORE,
171:     GAME_STORE,
172:     ENTRY_STORE,
173:     CONSENSUS_STORE,
174:     BYTE_STORE,
175:     SNAPSHOT_STORE,
176:   ]);
177:   let markerBytes: Uint8Array | undefined;
178:   let startBytes: Uint8Array | undefined;
179:   let pointerBytes: Uint8Array | undefined;
180:   let genesisBytes: Uint8Array | undefined;
181:   let catalogueBytes: Uint8Array | undefined;
182:   try {
183:     const deletedStore = transaction.objectStore(DELETED_GAME_STORE);
184:     const bytes = transaction.objectStore(BYTE_STORE);
185:     markerBytes = await deletedStore.get(gameId);
186:     if (markerBytes) {
187:       const marker = parseTombstone(markerBytes, gameId);
188:       if (marker.genesisDigest !== expectedGenesisDigest)
189:         throw new TypeError('Deleted gameId is permanently bound to another genesis');
190:       const byteMarker = await bytes.get(onlineGameTombstoneKey(gameId));
191:       if (byteMarker === undefined)
192:         await bytes.add(markerBytes.slice(), onlineGameTombstoneKey(gameId));
193:       else {
194:         const parsedByteMarker = parseTombstone(byteMarker, gameId);
195:         byteMarker.fill(0);
196:         if (parsedByteMarker.genesisDigest !== expectedGenesisDigest)
197:           throw new Error('Deletion markers disagree; refusing to modify game data');
198:       }
199:       await transaction.done;
200:       return 'already-deleted';
201:     }
202: 
203:     const gameStore = transaction.objectStore(GAME_STORE);
204:     startBytes = await bytes.get(`online-game/${expectedGenesisDigest}/start`);
205:     pointerBytes = await bytes.get(`online-game/${gameId}/start-digest`);
206:     genesisBytes = await gameStore.get(gameId);
207:     const identifiers = verifyStoredGameIdentity(
208:       gameId,
209:       expectedGenesisDigest,
210:       startBytes,
211:       pointerBytes,
212:       genesisBytes,
213:     );
214:     catalogueBytes = await bytes.get(CATALOGUE_KEY);
215:     const marker = canonicalEncode({
216:       protocol: TOMBSTONE_PROTOCOL,
217:       gameId,
218:       genesisDigest: expectedGenesisDigest,
219:       deletedAt,
220:     } satisfies OnlineGameTombstone);
221:     const byteTombstoneKey = onlineGameTombstoneKey(gameId);
222:     const existingByteMarker = await bytes.get(byteTombstoneKey);
223:     if (existingByteMarker !== undefined) {
224:       const existing = parseTombstone(existingByteMarker, gameId);
225:       existingByteMarker.fill(0);
226:       if (existing.genesisDigest !== expectedGenesisDigest)
227:         throw new TypeError('Deleted gameId is permanently bound to another genesis');
228:       throw new Error('Deletion markers disagree; refusing to modify game data');
229:     }
230:     await deletedStore.add(marker, gameId);
231:     await bytes.add(marker.slice(), byteTombstoneKey);
232: 
233:     if (catalogueBytes) {
234:       const catalogue = v.parse(catalogueSchema, canonicalDecode(catalogueBytes));
235:       if (new Set(catalogue.gameIds).size !== catalogue.gameIds.length)
236:         throw new TypeError('Saved game catalogue contains duplicate identifiers');
237:       const gameIds = catalogue.gameIds.filter((id) => id !== gameId);
238:       if (gameIds.length !== catalogue.gameIds.length)
239:         await bytes.put(canonicalEncode({ protocol: catalogue.protocol, gameIds }), CATALOGUE_KEY);
240:     }
241: 
242:     await deleteJournalRecords(transaction, gameId);
243:     await deleteSnapshots(transaction, gameId);
244:     await deleteKnownByteRecords(transaction, gameId, expectedGenesisDigest, identifiers);
245:     await transaction.done;
246:     return 'deleted';
247:   } catch (error) {
248:     try {
249:       transaction.abort();
250:     } catch {
251:       // Preserve the original failure if the transaction already completed or aborted.
252:     }
253:     await transaction.done.catch(() => undefined);
254:     throw error;
255:   } finally {
256:     markerBytes?.fill(0);
257:     startBytes?.fill(0);
258:     pointerBytes?.fill(0);
259:     genesisBytes?.fill(0);
260:     catalogueBytes?.fill(0);
261:     database.close();
262:   }
263: }
264: 
265: async function deleteSnapshots(transaction: DeletionTransaction, gameId: string): Promise<void> {
266:   const store = transaction.objectStore(SNAPSHOT_STORE);
267:   const range = IDBKeyRange.bound([gameId, 0], [gameId, Number.MAX_SAFE_INTEGER]);
268:   let cursor = await store.openCursor(range);
269:   while (cursor) {
270:     // oxlint-disable-next-line eslint/no-await-in-loop -- Cursor steps share the tombstone transaction.
```

### `apps/web/src/session/online-credentials.ts:1-110`

```ts
1: import { canonicalDecode, canonicalEncode, hashValue, toBase64Url, toHex } from '@cp2p/codec';
2: import {
3:   DERIVATION_LABELS,
4:   deriveScalar,
5:   identityFromSecret,
6:   parsePeerId,
7:   scalarFromBytes,
8:   scalarToBytes,
9: } from '@cp2p/crypto';
10: import type { PeerId } from '@cp2p/protocol';
11: import type { Seat } from '@cp2p/engine';
12: import * as v from 'valibot';
13: 
14: const DEVICE_ID = 'online-credentials/device-identity/v1';
15: const IDENTITY_PROTOCOL = 'cp2p/online-device-identity/v1';
16: const MATERIAL_PROTOCOL = 'cp2p/online-ceremony-material/v1';
17: const SEAT_LIMIT = 6;
18: const VALID_SEATS: Seat[] = [0, 1, 2, 3, 4, 5];
19: 
20: export interface OnlineCredentialStore {
21:   load(id: string): Promise<Uint8Array | null>;
22:   putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean>;
23:   withCeremonyLock<T>(id: string, task: () => Promise<T>): Promise<T>;
24: }
25: 
26: export type RandomBytes = (length: number) => Uint8Array;
27: 
28: export type OnlineSeatLayout =
29:   | { readonly seat: Seat; readonly kind: 'human'; readonly devicePeerId: PeerId }
30:   | { readonly seat: Seat; readonly kind: 'bot'; readonly botHost: PeerId };
31: 
32: export interface DisposableOnlineIdentity {
33:   readonly peerId: PeerId;
34:   readonly secretKey: Uint8Array;
35:   dispose(): void;
36: }
37: 
38: export interface OwnedSeatMaterial {
39:   readonly seat: Seat;
40:   readonly kind: 'human' | 'bot';
41:   readonly peerId: PeerId;
42:   readonly signingKey: Uint8Array;
43:   readonly master: Uint8Array;
44: }
45: 
46: export interface OwnedCeremonyMaterial {
47:   readonly ceremonyNonce: string;
48:   readonly layoutHash: string;
49:   readonly keys: readonly OwnedSeatMaterial[];
50:   dispose(): void;
51: }
52: 
53: interface IdentityRecord {
54:   readonly protocol: typeof IDENTITY_PROTOCOL;
55:   readonly peerId: PeerId;
56:   readonly secretKey: Uint8Array;
57: }
58: 
59: interface MaterialRecord {
60:   readonly protocol: typeof MATERIAL_PROTOCOL;
61:   readonly ceremonyNonce: string;
62:   readonly devicePeerId: PeerId;
63:   readonly layoutHash: string;
64:   readonly layout: readonly OnlineSeatLayout[];
65:   readonly seats: readonly OwnedSeatMaterial[];
66: }
67: 
68: const identityRecordSchema = v.strictObject({
69:   protocol: v.literal(IDENTITY_PROTOCOL),
70:   peerId: v.string(),
71:   secretKey: v.custom<Uint8Array>((value) => value instanceof Uint8Array && value.length === 32),
72: });
73: 
74: const layoutSeatSchema = v.variant('kind', [
75:   v.strictObject({
76:     seat: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5)),
77:     kind: v.literal('human'),
78:     devicePeerId: v.string(),
79:   }),
80:   v.strictObject({
81:     seat: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5)),
82:     kind: v.literal('bot'),
83:     botHost: v.string(),
84:   }),
85: ]);
86: 
87: const storedSeatSchema = v.strictObject({
88:   seat: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5)),
89:   kind: v.picklist(['human', 'bot']),
90:   peerId: v.string(),
91:   signingKey: v.custom<Uint8Array>((value) => value instanceof Uint8Array && value.length === 32),
92:   master: v.custom<Uint8Array>((value) => value instanceof Uint8Array && value.length === 32),
93: });
94: 
95: const materialRecordSchema = v.strictObject({
96:   protocol: v.literal(MATERIAL_PROTOCOL),
97:   ceremonyNonce: v.string(),
98:   devicePeerId: v.string(),
99:   layoutHash: v.string(),
100:   layout: v.pipe(v.array(layoutSeatSchema), v.minLength(2), v.maxLength(SEAT_LIMIT)),
101:   seats: v.pipe(v.array(storedSeatSchema), v.minLength(1), v.maxLength(SEAT_LIMIT)),
102: });
103: 
104: function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
105:   return left.length === right.length && left.every((byte, index) => byte === right[index]);
106: }
107: 
108: function checkedSeat(value: number): Seat {
109:   const seat = VALID_SEATS[value];
110:   if (seat === undefined || seat !== value)
```

### `apps/web/src/session/online-credentials.ts:188-245`

```ts
188: 
189: /** Load or durably pin one device identity before returning its private key. */
190: export async function loadOrCreateOnlineIdentity(
191:   store: OnlineCredentialStore,
192:   randomBytes: RandomBytes = browserRandomBytes,
193: ): Promise<DisposableOnlineIdentity> {
194:   return store.withCeremonyLock(DEVICE_ID, async () => {
195:     const prior = await store.load(DEVICE_ID);
196:     if (prior !== null) return identityFromRecord(prior);
197: 
198:     const seed = randomSeed(randomBytes);
199:     let identity: ReturnType<typeof identityFromSecret>;
200:     try {
201:       identity = identityFromSecret(seed);
202:     } finally {
203:       seed.fill(0);
204:     }
205:     const encoded = canonicalEncode({
206:       protocol: IDENTITY_PROTOCOL,
207:       peerId: identity.peerId,
208:       secretKey: identity.secretKey,
209:     });
210:     try {
211:       let saved: boolean;
212:       try {
213:         saved = await store.putIfAbsent(DEVICE_ID, encoded);
214:       } catch (writeError) {
215:         const winner = await store.load(DEVICE_ID).catch(() => null);
216:         if (winner === null) throw writeError;
217:         identity.secretKey.fill(0);
218:         return identityFromRecord(winner);
219:       }
220:       if (saved) return disposeIdentity(identity.peerId, identity.secretKey);
221:       identity.secretKey.fill(0);
222:       const winner = await store.load(DEVICE_ID);
223:       if (winner === null) throw new Error('Device identity reservation winner is missing');
224:       return identityFromRecord(winner);
225:     } catch (error) {
226:       identity.secretKey.fill(0);
227:       throw error;
228:     } finally {
229:       identity.publicKey.fill(0);
230:       encoded.fill(0);
231:     }
232:   });
233: }
234: 
235: /** Resume requires the original durable device key; it cannot mint a replacement. */
236: export async function loadOnlineIdentity(
237:   store: OnlineCredentialStore,
238: ): Promise<DisposableOnlineIdentity> {
239:   return store.withCeremonyLock(DEVICE_ID, async () => {
240:     const prior = await store.load(DEVICE_ID);
241:     if (prior === null) throw new Error('Stored online device identity is missing');
242:     return identityFromRecord(prior);
243:   });
244: }
245: 
```

### `apps/web/src/session/online-credentials.ts:381-510`

```ts
381: /** Persist one immutable set of game signing keys and independent master scalars. */
382: export async function prepareCeremonyMaterial(input: {
383:   readonly store: OnlineCredentialStore;
384:   readonly identity: DisposableOnlineIdentity;
385:   readonly ceremonyNonce: Uint8Array;
386:   readonly layout: readonly OnlineSeatLayout[];
387:   readonly randomBytes?: RandomBytes;
388:   /** Internal resume guard: reject absent material instead of minting fresh keys. */
389:   readonly loadOnly?: boolean;
390: }): Promise<OwnedCeremonyMaterial> {
391:   const nonceBytes = input.ceremonyNonce.slice();
392:   if (nonceBytes.length !== 32) {
393:     nonceBytes.fill(0);
394:     throw new TypeError('Ceremony nonce must be exactly 32 bytes');
395:   }
396:   const nonce = toBase64Url(nonceBytes);
397:   nonceBytes.fill(0);
398: 
399:   const identitySeed = input.identity.secretKey.slice();
400:   let identity: ReturnType<typeof identityFromSecret>;
401:   try {
402:     identity = identityFromSecret(identitySeed);
403:   } finally {
404:     identitySeed.fill(0);
405:   }
406:   try {
407:     if (identity.peerId !== input.identity.peerId)
408:       throw new TypeError('Device identity key does not match its PeerId');
409:     const layout = checkedLayout(input.layout, identity.peerId);
410:     const layoutHash = layoutDigest(nonce, identity.peerId, layout);
411:     const expected = { nonce, devicePeerId: identity.peerId, layoutHash, layout };
412:     const id = materialKey(nonce, identity.peerId);
413:     const random = input.randomBytes ?? browserRandomBytes;
414: 
415:     return await input.store.withCeremonyLock(id, async () => {
416:       const prior = await input.store.load(id);
417:       if (prior !== null) return materialFromRecord(prior, expected);
418:       if (input.loadOnly) throw new Error('Stored ceremony material is missing');
419: 
420:       const ownedSeats = layout.filter(
421:         (seat) =>
422:           (seat.kind === 'human' && seat.devicePeerId === identity.peerId) ||
423:           (seat.kind === 'bot' && seat.botHost === identity.peerId),
424:       );
425:       const storedSeats: OwnedSeatMaterial[] = [];
426:       try {
427:         for (const seat of ownedSeats) {
428:           const signingEntropy = randomSeed(random);
429:           try {
430:             const masterEntropy = randomSeed(random);
431:             try {
432:               const signing = identityFromSecret(signingEntropy);
433:               let retained = false;
434:               try {
435:                 const masterScalar = deriveScalar(
436:                   masterEntropy,
437:                   DERIVATION_LABELS.escrowCoefficient,
438:                   {
439:                     domain: 'cp2p/v1/online-seat-master',
440:                     ceremonyNonce: nonce,
441:                     devicePeerId: identity.peerId,
442:                     seat: seat.seat,
443:                   },
444:                 );
445:                 storedSeats.push({
446:                   seat: seat.seat,
447:                   kind: seat.kind,
448:                   peerId: signing.peerId,
449:                   signingKey: signing.secretKey,
450:                   master: scalarToBytes(masterScalar),
451:                 });
452:                 retained = true;
453:               } finally {
454:                 signing.publicKey.fill(0);
455:                 if (!retained) signing.secretKey.fill(0);
456:               }
457:             } finally {
458:               masterEntropy.fill(0);
459:             }
460:           } finally {
461:             signingEntropy.fill(0);
462:           }
463:         }
464: 
465:         const record: MaterialRecord = {
466:           protocol: MATERIAL_PROTOCOL,
467:           ceremonyNonce: nonce,
468:           devicePeerId: identity.peerId,
469:           layoutHash,
470:           layout,
471:           seats: storedSeats,
472:         };
473:         const bytes = canonicalEncode(record);
474:         try {
475:           let saved: boolean;
476:           try {
477:             saved = await input.store.putIfAbsent(id, bytes);
478:           } catch (writeError) {
479:             const winner = await input.store.load(id).catch(() => null);
480:             if (winner === null) throw writeError;
481:             return materialFromRecord(winner, expected);
482:           }
483:           if (saved) return materialFromRecord(bytes.slice(), expected);
484:           const winner = await input.store.load(id);
485:           if (winner === null) throw new Error('Ceremony material reservation winner is missing');
486:           return materialFromRecord(winner, expected);
487:         } finally {
488:           bytes.fill(0);
489:         }
490:       } finally {
491:         for (const stored of storedSeats) {
492:           stored.signingKey.fill(0);
493:           stored.master.fill(0);
494:         }
495:       }
496:     });
497:   } finally {
498:     identity.secretKey.fill(0);
499:     identity.publicKey.fill(0);
500:   }
501: }
502: 
503: /** Load exact persisted game keys and masters without any generation path. */
504: export async function loadCeremonyMaterial(
505:   input: Omit<Parameters<typeof prepareCeremonyMaterial>[0], 'randomBytes' | 'loadOnly'>,
506: ): Promise<OwnedCeremonyMaterial> {
507:   return prepareCeremonyMaterial({ ...input, loadOnly: true });
508: }
```

### `apps/web/src/session/online-game.ts:110-220`

```ts
110:     bindings: copyEvidence(supplied.bindings),
111:   };
112:   const material = input.material.map((item) => ({
113:     ...item,
114:     signingKey: new Uint8Array(item.signingKey),
115:     master: new Uint8Array(item.master),
116:   }));
117:   let journal: OnlineJournal | null = null;
118:   let snapshotStore: IndexedDbPublicSnapshotStore | null = null;
119:   let lease: GameWriterLease | null = null;
120:   let transport: OnlineGameTransport | null = null;
121:   let session: P2PSession | null = null;
122:   let historyWriter: ReturnType<typeof createOnlineGameHistoryWriter> | null = null;
123:   let activityWriter: ReturnType<typeof createOnlineGameActivityWriter> | null = null;
124:   let terminalHead: { seq: number; hash: string } | null = null;
125:   let leaseLost = false;
126:   const providers = new Map<Seat, BeaconSecretProvider>();
127:   const checkCancelled = () => {
128:     if (input.signal?.aborted || leaseLost)
129:       throw new DOMException('Online game opening was cancelled', 'AbortError');
130:   };
131:   const stopOutput = () => transport?.dispose();
132:   input.signal?.addEventListener('abort', stopOutput, { once: true });
133:   const cleanup = async () => {
134:     input.signal?.removeEventListener('abort', stopOutput);
135:     historyWriter?.stop();
136:     activityWriter?.stop();
137:     try {
138:       session?.dispose();
139:       await session?.flush();
140:     } finally {
141:       await historyWriter?.flush();
142:       await activityWriter?.flush();
143:       transport?.dispose();
144:       for (const provider of providers.values()) provider.dispose();
145:       for (const item of material) {
146:         item.signingKey.fill(0);
147:         item.master.fill(0);
148:       }
149:       try {
150:         try {
151:           await snapshotStore?.close();
152:         } finally {
153:           await journal?.close();
154:         }
155:       } finally {
156:         await lease?.close();
157:       }
158:     }
159:   };
160:   try {
161:     checkCancelled();
162:     const policy: ReplayPolicy = {
163:       genesis: {
164:         verifyCommitments(genesis) {
165:           const decks = validateDeckCeremony(genesis, input.transcripts);
166:           return decks.ok ? success(undefined) : decks;
167:         },
168:       },
169:       entry: {},
170:     };
171:     const checked = initialProposalContext(input.entry, input.engine, policy);
172:     if (!checked.ok) throw new Error(checked.error.message);
173:     const { genesis, state, crypto } = checked.value.log;
174:     const startup = validateGenesisOnlineStart(genesis);
175:     if (!startup.ok) throw new Error(startup.error.message);
176:     if (!crypto) throw new Error('Verified game commitments are missing');
177:     const humans = material.filter((seat) => seat.kind === 'human');
178:     const local = humans[0];
179:     if (humans.length !== 1 || !local) throw new Error('Stored material needs one human seat');
180:     lease = await (runtime.acquireLease ?? acquireActiveGameWriterLease)(genesis.gameId, {
181:       onLost(error) {
182:         leaseLost = true;
183:         transport?.dispose();
184:         session?.dispose();
185:         try {
186:           input.onFatal?.(error);
187:         } catch {
188:           // Reporting failure cannot restore authority or resume output.
189:         }
190:       },
191:     });
192:     checkCancelled();
193:     if (!lease) throw new Error('This game is already active in another tab');
194:     const digest = genesisDigest(genesis);
195:     if (!runtime.createJournal) snapshotStore = new IndexedDbPublicSnapshotStore(genesis.gameId);
196:     const keyBinding = {
197:       recordKey: `online-game/${digest}/keys`,
198:       bytes: canonicalEncode({
199:         protocol: 'online-game-keys-v1',
200:         genesisDigest: digest,
201:         devicePeer: input.deviceTransport.self,
202:         humanSeat: local.seat,
203:         seats: material,
204:       }),
205:     };
206:     try {
207:       journal = runtime.createJournal
208:         ? runtime.createJournal(genesis.gameId, keyBinding)
209:         : new IndexedDbProtocolJournal(genesis.gameId, { keyBinding });
210:     } finally {
211:       keyBinding.bytes.fill(0);
212:     }
213:     const saved = await journal.load();
214:     checkCancelled();
215:     if (saved && entryHash(saved.genesis) !== entryHash(input.entry))
216:       throw new Error('Stored game history differs from the certified online start');
217:     let installed: LogContext | null =
218:       checked.value.log.authority?.controllers.find((seat) => seat.seat === local.seat)
219:         ?.publicKey === local.peerId
220:         ? checked.value.log
```

### `apps/web/src/session/online-game.ts:375-415`

```ts
375:         throw new Error('Hosted master differs from the frozen beacon chain');
376:       beaconSources.set(item.seat, provider.source);
377:     }
378:     const bot = new RandomBot();
379:     const botKeys = new Map(
380:       activeMaterial
381:         .filter((item) => item.kind === 'bot')
382:         .map((item) => [item.seat, item.signingKey]),
383:     );
384:     const publicSnapshots = snapshotStore;
385:     const options = {
386:       genesisEntry: input.entry,
387:       engine: input.engine,
388:       policy,
389:       seat: human.seat,
390:       secretKey: local.signingKey,
391:       transport,
392:       clock: input.clock,
393:       journal,
394:       ...(publicSnapshots
395:         ? { savePublicSnapshot: (snapshot: unknown) => publicSnapshots.saveCommitted(snapshot) }
396:         : {}),
397:       onCertifiedNonMembershipCommit(head: { readonly seq: number; readonly hash: string }) {
398:         const pruned = projection.value.pruneRetired(head);
399:         if (pruned.ok && pruned.value) {
400:           const routes = projection.value.deviceRoutes();
401:           if (routes) input.onDeviceRoutes?.(routes);
402:         }
403:         return pruned.ok ? success(undefined) : pruned;
404:       },
405:       onMembershipCommitted(entries: readonly CertifiedEntry[]) {
406:         const routed = projection.value.advanceCertifiedHistory(entries);
407:         const payload = entries.at(-1)?.entry.payload;
408:         const transfer =
409:           payload?.kind === 'membership' ? v.safeParse(transferChangeSchema, payload.change) : null;
410:         const replacements =
411:           transfer?.success && transfer.output.kind === 'transfer-activate'
412:             ? transfer.output.statement.replacements
413:             : [];
414:         const retired = !routed.ok && routed.error.code === 'online-transport-retired';
415:         if (routed.ok) {
```

### `apps/web/src/session/online-game.ts:470-500`

```ts
470:       createDriver: (
471:         engine: Engine,
472:         approved: Genesis,
473:         _clock: ProtocolClock,
474:         seats: readonly Seat[],
475:       ) =>
476:         new VerifiedSessionDriver(
477:           engine,
478:           approved,
479:           seats,
480:           deckSource,
481:           (seat) => createHandSecretSource(masterFor(seat), digest, seat),
482:           stealSource,
483:         ),
484:       masterReveal: {
485:         store: input.store,
486:         async loadOwnedMaster(seat: Seat) {
487:           const item = ownedMaterial.get(seat);
488:           return item ? new Uint8Array(item.master) : null;
489:         },
490:       },
491:       auditRunner: runtime.auditRunner ?? createSessionAuditRunner(),
492:     };
493:     // The built-in journal returns null only when genesis, entries, safety and
494:     // its bound voting-key record are all absent in one IndexedDB transaction.
495:     // Injected journals have no equivalent proof and must remain restore-only.
496:     if (input.journalMode === 'restore-only' && !saved && runtime.createJournal)
497:       throw new Error('The certified online game journal is missing');
498:     const opened = await lease.run(() => {
499:       checkCancelled();
500:       return saved ? P2PSession.restore(options) : P2PSession.create(options);
```

### `apps/web/src/session/online-transfer-credentials.ts:25-95`

```ts
25:   OnlineCredentialStore,
26:   RandomBytes,
27: } from './online-credentials.js';
28: 
29: const RECORD_PROTOCOL = 'cp2p/online-transfer-credentials/v1';
30: const SLOT_PREFIX = 'online-transfer-credentials/v1';
31: const MAX_RECORD_BYTES = 16 * 1024;
32: const VALID_SEATS: readonly Seat[] = [0, 1, 2, 3, 4, 5];
33: 
34: /** The generated public keys and encryption point are deliberately absent from this scope. */
35: export interface OnlineTransferCredentialScope {
36:   readonly attemptId: string;
37:   readonly genesisDigest: string;
38:   readonly anchor: SeatTransferAuthorizationStatement['anchor'];
39:   readonly validUntilSeq: number;
40:   readonly mode: SeatTransferAuthorizationStatement['mode'];
41:   readonly seat: Seat;
42:   readonly currentController: SeatTransferAuthorizationStatement['currentController'];
43:   readonly recovery: SeatTransferAuthorizationStatement['recovery'];
44:   readonly nextEpoch: number;
45:   readonly devicePeer: string;
46:   readonly replacements: readonly Omit<TransferReplacement, 'newPublicKey'>[];
47: }
48: 
49: export interface OwnedOnlineTransferKey {
50:   readonly seat: Seat;
51:   readonly peerId: string;
52:   readonly signingKey: Uint8Array;
53: }
54: 
55: export interface OwnedOnlineTransferCredentials {
56:   readonly authorization: {
57:     readonly kind: 'transfer-authorize';
58:     readonly statement: SeatTransferAuthorizationStatement;
59:     readonly destinationDeviceSig: string;
60:     readonly destinationGameSig: string;
61:     readonly replacementKeySigs: readonly { readonly seat: Seat; readonly sig: string }[];
62:   };
63:   readonly keys: readonly OwnedOnlineTransferKey[];
64:   readonly encryptionSecret: Uint8Array;
65:   dispose(): void;
66: }
67: 
68: interface StoredKey {
69:   readonly seat: Seat;
70:   readonly signingKey: Uint8Array;
71: }
72: 
73: interface StoredRecord {
74:   readonly protocol: typeof RECORD_PROTOCOL;
75:   readonly attemptId: string;
76:   readonly statement: SeatTransferAuthorizationStatement;
77:   readonly encryptionSecret: Uint8Array;
78:   readonly keys: readonly StoredKey[];
79: }
80: 
81: const bytes32Schema = v.custom<Uint8Array>(
82:   (value) => value instanceof Uint8Array && value.length === 32,
83: );
84: const storedKeySchema = v.strictObject({
85:   seat: v.picklist(VALID_SEATS),
86:   signingKey: bytes32Schema,
87: });
88: const storedRecordSchema = v.strictObject({
89:   protocol: v.literal(RECORD_PROTOCOL),
90:   attemptId: v.string(),
91:   statement: transferAuthorizationStatementSchema,
92:   encryptionSecret: bytes32Schema,
93:   keys: v.pipe(v.array(storedKeySchema), v.minLength(1), v.maxLength(6)),
94: });
95: 
```

### `apps/web/src/session/online-transfer-credentials.ts:120-245`

```ts
120:   for (const key of Reflect.ownKeys(value)) wipe(Reflect.get(value, key), seen);
121: }
122: 
123: function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
124:   return left.length === right.length && left.every((byte, index) => byte === right[index]);
125: }
126: 
127: function slotKey(scope: OnlineTransferCredentialScope, devicePeer: string): string {
128:   return `${SLOT_PREFIX}/${scope.genesisDigest}/${devicePeer}/${scope.seat}/${scope.attemptId}`;
129: }
130: 
131: function snapshotScope(input: OnlineTransferCredentialScope): OnlineTransferCredentialScope {
132:   const bytes = canonicalEncode(input);
133:   if (bytes.length > 8 * 1024) {
134:     bytes.fill(0);
135:     throw new RangeError('Transfer authorization scope exceeds the supported size');
136:   }
137:   try {
138:     // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Detach the typed input; validateScope checks the decoded fields before use.
139:     return canonicalDecode(bytes) as OnlineTransferCredentialScope;
140:   } finally {
141:     bytes.fill(0);
142:   }
143: }
144: 
145: function validateScope(scope: OnlineTransferCredentialScope, devicePeer: string): void {
146:   if (scope.devicePeer !== devicePeer)
147:     throw new TypeError('Transfer device identity does not match scope');
148:   if (!/^[A-Za-z0-9_-]{43}$/.test(scope.genesisDigest))
149:     throw new TypeError('Transfer genesis digest must be a canonical 32-byte value');
150:   if (fromBase64Url(scope.genesisDigest).length !== 32)
151:     throw new TypeError('Transfer genesis digest must be a canonical 32-byte value');
152:   if (
153:     !/^[A-Za-z0-9_-]{43}$/.test(scope.attemptId) ||
154:     toBase64Url(fromBase64Url(scope.attemptId)) !== scope.attemptId
155:   )
156:     throw new TypeError('Transfer attempt ID must be a canonical 32-byte token');
157:   if (scope.replacements.length < 1 || scope.replacements.length > 6)
158:     throw new TypeError('Transfer must replace one to six seats');
159:   const seen = new Set<number>();
160:   let previousBotSeat = -1;
161:   for (const [index, replacement] of scope.replacements.entries()) {
162:     if (!VALID_SEATS.includes(replacement.seat) || seen.has(replacement.seat))
163:       throw new TypeError('Transfer replacements must be unique');
164:     if (index === 0 && replacement.seat !== scope.seat)
165:       throw new TypeError('The first replacement must be the destination human seat');
166:     if (index > 0 && replacement.seat <= previousBotSeat)
167:       throw new TypeError('Hosted bot replacements must be ordered by seat');
168:     if (index > 0) previousBotSeat = replacement.seat;
169:     seen.add(replacement.seat);
170:     parsePeerId(replacement.oldPublicKey);
171:     if (!VALID_SEATS.includes(replacement.newHostSeat))
172:       throw new TypeError('Invalid replacement host seat');
173:   }
174:   if (!VALID_SEATS.includes(scope.seat)) throw new TypeError('Invalid transfer seat');
175:   const firstReplacement = scope.replacements[0];
176:   if (!firstReplacement) throw new TypeError('Transfer primary replacement is missing');
177:   v.parse(transferAuthorizationStatementSchema, {
178:     protocol: 'seat-transfer-v1',
179:     genesisDigest: scope.genesisDigest,
180:     anchor: scope.anchor,
181:     validUntilSeq: scope.validUntilSeq,
182:     mode: scope.mode,
183:     seat: scope.seat,
184:     currentController: scope.currentController,
185:     recovery: scope.recovery,
186:     nextEpoch: scope.nextEpoch,
187:     destination: {
188:       devicePeer,
189:       gamePeer: firstReplacement.oldPublicKey,
190:       transferEncryptionKey: encodePoint(G),
191:     },
192:     replacements: scope.replacements.map((replacement) => ({
193:       ...replacement,
194:       newPublicKey: replacement.oldPublicKey,
195:     })),
196:   });
197: }
198: 
199: function parseStored(bytes: Uint8Array): StoredRecord {
200:   if (!(bytes instanceof Uint8Array) || bytes.length > MAX_RECORD_BYTES)
201:     throw new TypeError('Stored transfer credentials are oversized');
202:   let decoded: unknown;
203:   try {
204:     decoded = canonicalDecode(bytes);
205:     const parsed = v.safeParse(storedRecordSchema, decoded);
206:     if (!parsed.success) throw new TypeError('Stored transfer credentials are malformed');
207:     const canonical = canonicalEncode(parsed.output);
208:     const matches = sameBytes(canonical, bytes);
209:     canonical.fill(0);
210:     if (!matches) throw new TypeError('Stored transfer credentials are malformed');
211:     return parsed.output;
212:   } catch {
213:     wipe(decoded);
214:     throw new TypeError('Stored transfer credentials are malformed');
215:   }
216: }
217: 
218: function statementMatchesScope(
219:   statement: SeatTransferAuthorizationStatement,
220:   scope: OnlineTransferCredentialScope,
221: ): boolean {
222:   return (
223:     statement.protocol === 'seat-transfer-v1' &&
224:     statement.genesisDigest === scope.genesisDigest &&
225:     statement.anchor.seq === scope.anchor.seq &&
226:     statement.anchor.hash === scope.anchor.hash &&
227:     statement.validUntilSeq === scope.validUntilSeq &&
228:     statement.mode === scope.mode &&
229:     statement.seat === scope.seat &&
230:     canonicalEncode(statement.currentController).toString() ===
231:       canonicalEncode(scope.currentController).toString() &&
232:     canonicalEncode(statement.recovery).toString() === canonicalEncode(scope.recovery).toString() &&
233:     statement.nextEpoch === scope.nextEpoch &&
234:     statement.destination.devicePeer === scope.devicePeer &&
235:     statement.replacements.length === scope.replacements.length &&
236:     statement.replacements.every((item, index) => {
237:       const expected = scope.replacements[index];
238:       return (
239:         expected !== undefined &&
240:         item.seat === expected.seat &&
241:         item.oldPublicKey === expected.oldPublicKey &&
242:         item.newHostSeat === expected.newHostSeat
243:       );
244:     })
245:   );
```

### `packages/protocol/src/escrow-lifecycle.ts:30-105`

```ts
30: import { genesisSchema } from './schemas.js';
31: import { key32Schema, seatSchema, signature64Schema } from './schema-values.js';
32: import type { GenesisBody } from './types.js';
33: import { MAX_MESSAGE_BYTES, parseCanonical } from './validation.js';
34: 
35: const APPROVAL_PROTOCOL = 'escrow-manifest-approval-v1';
36: const RESERVATION_PROTOCOL = 'escrow-master-reservation-v1';
37: const REGISTRY_PROTOCOL = 'escrow-device-index-v1';
38: const REGISTRY_ID = 'escrow-lifecycle/device-index-v1';
39: const MAX_REGISTRY_BYTES = 16 * 1024 * 1024;
40: const MIN_RETIREMENT_HEADROOM_BYTES = 64 * 1024;
41: const RETIREMENT_HEADROOM_PER_ACTIVE_CEREMONY = 2 * 1024;
42: const approvalSchema = v.strictObject({
43:   body: v.strictObject({
44:     protocol: v.literal(APPROVAL_PROTOCOL),
45:     ceremonyId: key32Schema,
46:     seat: seatSchema,
47:     publicKey: key32Schema,
48:   }),
49:   sig: signature64Schema,
50: });
51: const reservationSchema = v.strictObject({
52:   protocol: v.literal(RESERVATION_PROTOCOL),
53:   ceremonyId: key32Schema,
54:   masterPub: key32Schema,
55:   dealerSeat: seatSchema,
56:   status: v.picklist(['active', 'retired', 'completed']),
57:   envelopes: v.pipe(
58:     v.array(v.pipe(v.string(), v.maxLength(MAX_MESSAGE_BYTES * 2))),
59:     v.maxLength(5),
60:   ),
61: });
62: const registrySchema = v.strictObject({
63:   protocol: v.literal(REGISTRY_PROTOCOL),
64:   reservations: v.pipe(v.array(reservationSchema), v.maxLength(50_000)),
65:   retiredCeremonies: v.pipe(v.array(key32Schema), v.maxLength(50_000)),
66:   consentingCeremonies: v.optional(
67:     v.pipe(
68:       v.array(v.strictObject({ ceremonyId: key32Schema, genesisDigest: key32Schema })),
69:       v.maxLength(50_000),
70:     ),
71:   ),
72:   completedCeremonies: v.optional(
73:     v.pipe(
74:       v.array(v.strictObject({ ceremonyId: key32Schema, genesisDigest: key32Schema })),
75:       v.maxLength(50_000),
76:     ),
77:   ),
78: });
79: 
80: export interface EscrowManifestApproval {
81:   readonly body: {
82:     readonly protocol: typeof APPROVAL_PROTOCOL;
83:     readonly ceremonyId: string;
84:     readonly seat: Seat;
85:     readonly publicKey: string;
86:   };
87:   readonly sig: string;
88: }
89: 
90: /**
91:  * Device-global durable storage. A browser implementation must use a
92:  * transactionally persistent store shared by every tab for this identity.
93:  * This process-local memory implementation is only a test fixture.
94:  * The integration layer must preserve each permanent master reservation and
95:  * clear retained envelope bytes only after validating the certified genesis.
96:  */
97: export interface EscrowLifecycleStore {
98:   load(id: string): Promise<Uint8Array | null>;
99:   putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean>;
100:   /** Atomic byte-exact compare-and-swap; true only after durable commit. */
101:   compareAndSwap(id: string, expected: Uint8Array, replacement: Uint8Array): Promise<boolean>;
102:   /** Shared device lock, required when this store is used for live delivery. */
103:   withCeremonyLock?<T>(ceremonyId: string, task: () => Promise<T>): Promise<T>;
104: }
105: 
```

### `packages/protocol/src/escrow-lifecycle.ts:420-445`

```ts
420:     return failure('escrow-registry-record', 'Escrow registry is not canonical data');
421:   }
422: }
423: 
424: async function loadRegistry(
425:   store: EscrowLifecycleStore,
426: ): Promise<Result<{ readonly bytes: Uint8Array | null; readonly value: EscrowRegistry }>> {
427:   try {
428:     const bytes = await store.load(REGISTRY_ID);
429:     if (bytes === null) return success({ bytes: null, value: emptyRegistry() });
430:     const value = parseRegistry(bytes);
431:     return value.ok ? success({ bytes, value: value.value }) : value;
432:   } catch {
433:     return failure('escrow-registry-read', 'Could not read the device escrow registry');
434:   }
435: }
436: 
437: function envelopeBytes(envelope: EscrowShareEnvelope): Uint8Array {
438:   return canonicalEncode(envelope);
439: }
440: 
441: function decodeRetainedEnvelopes(reservation: Reservation): Result<readonly EscrowShareEnvelope[]> {
442:   try {
443:     const output: EscrowShareEnvelope[] = [];
444:     for (const encoded of reservation.envelopes) {
445:       const bytes = fromBase64Url(encoded);
```

### `packages/protocol/src/escrow-lifecycle.ts:535-565`

```ts
535:     if (previous)
536:       return previous.genesisDigest === digest
537:         ? success(undefined)
538:         : failure(
539:             'escrow-ceremony-consent-conflict',
540:             'Ceremony already consented to another genesis',
541:           );
542:     const encoded = encodeRegistry(
543:       {
544:         ...value,
545:         consentingCeremonies: [
546:           ...value.consentingCeremonies,
547:           { ceremonyId, genesisDigest: digest },
548:         ],
549:       },
550:       false,
551:     );
552:     if (!encoded.ok) return encoded;
553:     try {
554:       const won =
555:         bytes === null
556:           ? await store.putIfAbsent(REGISTRY_ID, encoded.value)
557:           : await store.compareAndSwap(REGISTRY_ID, bytes, encoded.value);
558:       if (won) return success(undefined);
559:     } catch {
560:       return failure('escrow-registry-write', 'Could not durably reserve genesis consent');
561:     }
562:   }
563:   // oxlint-enable no-await-in-loop
564:   return failure('escrow-registry-contention', 'Could not reserve genesis consent');
565: }
```

### `packages/protocol/src/recovery-private.ts:25-80`

```ts
25: type Secret = PrivateRecord['secrets'][number];
26: 
27: /**
28:  * Local private storage; never publish these bytes in messages or public saves.
29:  * load returns a fresh owned buffer. putIfAbsent copies its input before awaiting,
30:  * resolves only after durable commit, and never retains the caller's array.
31:  * Callers wipe both returned and supplied buffers after each operation.
32:  */
33: export interface RecoveryPrivateStore {
34:   load(id: string): Promise<Uint8Array | null>;
35:   putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean>;
36: }
37: 
38: function sameRef(a: EntryRef, b: EntryRef): boolean {
39:   return a.seq === b.seq && a.hash === b.hash;
40: }
41: 
42: function privateScope(context: LogContext, authorization: EntryRef, recipientSeat: Seat) {
43:   const recovery = context.recovery;
44:   const approved = recovery?.authorizations.find((item) => sameRef(item.entry, authorization));
45:   const active = context.authority?.controllers.find((item) => item.seat === recipientSeat);
46:   const recipient = approved?.statement.recoverers.find((item) => item.seat === recipientSeat);
47:   if (
48:     !approved ||
49:     !recipient ||
50:     !context.crypto ||
51:     active?.kind !== 'human' ||
52:     active.status !== 'active' ||
53:     active.publicKey !== recipient.publicKey ||
54:     !(
55:       (recovery?.pending && sameRef(recovery.pending, authorization)) ||
56:       recovery?.completed.some((item) => sameRef(item.authorization, authorization))
57:     )
58:   )
59:     return failure(
60:       'recovery-private-authority',
61:       'Recovery secrets require certified authorization',
62:     );
63:   return success({
64:     version: 1 as const,
65:     genesisDigest: genesisDigest(context.genesis),
66:     authorization: { ...authorization },
67:     recipientSeat,
68:     seats: approved.statement.replacements.map(({ seat }) => seat),
69:   });
70: }
71: 
72: function recordId(record: Omit<PrivateRecord, 'secrets'>): string {
73:   return `recovery-private/${record.genesisDigest}/${record.authorization.seq}-${record.authorization.hash}/${record.recipientSeat}`;
74: }
75: 
76: function validateSecrets(context: LogContext, secrets: readonly Secret[], seats: readonly Seat[]) {
77:   if (
78:     !context.crypto ||
79:     secrets.length !== seats.length ||
80:     secrets.some((secret, index) => secret.seat !== seats[index])
```

### `packages/protocol/src/recovery-private.ts:95-135`

```ts
95: export async function persistRecoveryPrivate(
96:   context: LogContext,
97:   authorization: EntryRef,
98:   recipientSeat: Seat,
99:   secrets: readonly Secret[],
100:   store: RecoveryPrivateStore,
101: ): Promise<Result<void>> {
102:   const scope = privateScope(context, authorization, recipientSeat);
103:   if (!scope.ok) return scope;
104:   let record: PrivateRecord | undefined;
105:   const copies: Secret[] = [];
106:   let bytes: Uint8Array | undefined;
107:   let existing: Uint8Array | null = null;
108:   try {
109:     const { seats, ...binding } = scope.value;
110:     for (const { seat, master } of secrets) copies.push({ seat, master: master.slice() });
111:     record = v.parse(privateRecordSchema, { ...binding, secrets: copies });
112:     const verified = validateSecrets(context, record.secrets, seats);
113:     if (!verified.ok) return verified;
114:     bytes = canonicalEncode(record);
115:     const id = recordId(record);
116:     if (await store.putIfAbsent(id, bytes)) return success(undefined);
117:     existing = await store.load(id);
118:     return existing && sameBytes(existing, bytes)
119:       ? success(undefined)
120:       : failure(
121:           'recovery-private-conflict',
122:           'An inconsistent private record occupies this authorization',
123:         );
124:   } catch {
125:     return failure('recovery-private-storage', 'Could not durably retain recovered secrets');
126:   } finally {
127:     copies.forEach(({ master }) => master.fill(0));
128:     bytes?.fill(0);
129:     existing?.fill(0);
130:   }
131: }
132: 
133: /** Restart reads only secrets authorized by the caller's fully replayed certified history. */
134: export async function loadRecoveryPrivate(
135:   context: LogContext,
```

### `packages/protocol/src/transfer-private.ts:80-100`

```ts
80:   encryptionSecret: v.custom<Uint8Array>(
81:     (x): x is Uint8Array => x instanceof Uint8Array && x.length === 32,
82:   ),
83: });
84: export type TransferPrivateEnvelope = v.InferOutput<typeof transferPrivateEnvelopeSchema>;
85: type Master = v.InferOutput<typeof masterSchema>;
86: type Custody = v.InferOutput<typeof custodySchema>;
87: type Plaintext = v.InferOutput<typeof plaintextSchema>;
88: 
89: /** load returns owned bytes; putIfAbsent copies before awaiting and commits durably. */
90: export interface TransferPrivateStore {
91:   load(id: string): Promise<Uint8Array | null>;
92:   putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean>;
93: }
94: 
95: export interface ImportedTransferPrivate extends ReconstructedPrivateSeats {
96:   /** Owned copies; dispose clears these as well as the reconstructed driver. */
97:   readonly masters: readonly Master[];
98: }
99: 
100: function sameRef(a: EntryRef, b: EntryRef): boolean {
```

### `packages/protocol/src/transfer-private.ts:1000-1050`

```ts
1000:     const point = encodePoint(scalePoint(G, scalar));
1001:     if (point !== statement.destination.transferEncryptionKey)
1002:       return failure(
1003:         'transfer-private-key',
1004:         'Destination key differs from certified authorization',
1005:       );
1006:     opened = openSealed(packet.sealed, scalar, sealContext(packet, point));
1007:     const decoded = decodePlaintext(opened, authorization, context);
1008:     if (!decoded.ok) return decoded;
1009:     plain = decoded.value;
1010:     rebuilt = (() => {
1011:       const result = reconstructPrivateSeats({
1012:         genesisEntry: input.genesisEntry,
1013:         entries: input.entries,
1014:         engine,
1015:         policy,
1016:         secrets: plain?.masters ?? [],
1017:       });
1018:       return result.ok ? result.value : undefined;
1019:     })();
1020:     if (!rebuilt)
1021:       return failure(
1022:         'transfer-private-replay',
1023:         'Imported private hands failed certified reconstruction',
1024:       );
1025:     const storeRecord = {
1026:       protocol: 'seat-transfer-private-import-v1',
1027:       packet,
1028:       encryptionSecret: secret,
1029:     };
1030:     encoded = canonicalEncode(storeRecord);
1031:     const id = recordId(packet);
1032:     if (!(await importStore.putIfAbsent(id, encoded))) {
1033:       prior = await importStore.load(id);
1034:       if (!prior || !sameBytes(prior, encoded))
1035:         return failure(
1036:           'transfer-private-import',
1037:           'Different immutable import occupies this destination',
1038:         );
1039:     }
1040:     const masters = plain.masters.map(({ seat, master }) => ({
1041:       seat,
1042:       master: new Uint8Array(master),
1043:     }));
1044:     const retained = rebuilt;
1045:     rebuilt = undefined;
1046:     return success({
1047:       context: retained.context,
1048:       driver: retained.driver,
1049:       masters,
1050:       releaseSeat(seat) {
```

### `apps/web/src/session/online-full-save.ts:525-565`

```ts
525:           archive.value,
526:           safety.output,
527:           privateCopy.holderSeat,
528:           privateCopy.escrowComplete,
529:           privateCopy.masters,
530:           privateCopy.escrow,
531:         ),
532:       );
533:       const verified = await checkedPrivate(
534:         privateValue,
535:         archive.value,
536:         context.value,
537:         safety.output,
538:       );
539:       if (!verified.ok) return verified;
540:       plaintext = canonicalEncode(privateValue);
541:       if (plaintext.length > MAX_PRIVATE_BYTES)
542:         return failure('full-save-private-size', 'Private capsule exceeds its size limit');
543:       const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
544:       const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
545:       const key = await cryptoKey(passphrase, salt);
546:       const encryptionInput = new Uint8Array(plaintext);
547:       try {
548:         ciphertext = {
549:           kdf: 'PBKDF2-SHA256',
550:           iterations: PBKDF2_ITERATIONS,
551:           salt,
552:           nonce,
553:           ciphertext: new Uint8Array(
554:             await crypto.subtle.encrypt(
555:               {
556:                 name: 'AES-GCM',
557:                 iv: new Uint8Array(nonce),
558:                 additionalData: new Uint8Array(aad(archive.value, safety.output)),
559:               },
560:               key,
561:               encryptionInput,
562:             ),
563:           ),
564:         };
565:       } finally {
```
