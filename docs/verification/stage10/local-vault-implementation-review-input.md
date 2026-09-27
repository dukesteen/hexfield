# Pinned local-vault implementation source excerpts

## packages/storage/src/database.ts

Lines 1-75:
```ts
   1 import { openDB } from 'idb';
   2 import type { DBSchema, IDBPDatabase, IDBPTransaction } from 'idb';
   3 
   4 export const DATABASE_NAME = 'cp2p';
   5 export const DATABASE_VERSION = 5;
   6 export const BYTE_STORE = 'bytes';
   7 export const GAME_STORE = 'games';
   8 export const ENTRY_STORE = 'entries';
   9 export const CONSENSUS_STORE = 'consensus';
  10 export const DELETED_GAME_STORE = 'deletedGames';
  11 export const SNAPSHOT_STORE = 'snapshots';
  12 export const VAULT_STORE = 'vault';
  13 
  14 export const MAX_RECORD_BYTES = 16 * 1024 * 1024;
  15 
  16 export interface CP2PDatabase extends DBSchema {
  17   bytes: { key: string; value: Uint8Array };
  18   games: { key: string; value: Uint8Array };
  19   entries: { key: [string, number]; value: Uint8Array };
  20   consensus: { key: string; value: Uint8Array };
  21   deletedGames: { key: string; value: Uint8Array };
  22   snapshots: { key: [string, number]; value: Uint8Array };
  23   vault: { key: string; value: Uint8Array };
  24 }
  25 
  26 export function openDatabase(
  27   blocked: () => void,
  28   reset: () => void,
  29 ): Promise<IDBPDatabase<CP2PDatabase>> {
  30   const factory = globalThis.indexedDB;
  31   if (!factory) return Promise.reject(new Error('IndexedDB is unavailable'));
  32 
  33   let opening: Promise<IDBPDatabase<CP2PDatabase>>;
  34   opening = openDB<CP2PDatabase>(DATABASE_NAME, DATABASE_VERSION, {
  35     upgrade(database, oldVersion) {
  36       if (oldVersion < 1) database.createObjectStore(BYTE_STORE);
  37       if (oldVersion < 2) {
  38         database.createObjectStore(GAME_STORE);
  39         database.createObjectStore(ENTRY_STORE);
  40         database.createObjectStore(CONSENSUS_STORE);
  41       }
  42       if (oldVersion < 3) database.createObjectStore(DELETED_GAME_STORE);
  43       if (oldVersion < 4) database.createObjectStore(SNAPSHOT_STORE);
  44       if (oldVersion < 5) database.createObjectStore(VAULT_STORE);
  45     },
  46     blocking: () => {
  47       blocked();
  48       opening.then((database) => database.close()).catch(() => undefined);
  49     },
  50     terminated: reset,
  51   });
  52   return opening;
  53 }
  54 
  55 export function strictWriteTransaction<
  56   Stores extends readonly (
  57     | 'bytes'
  58     | 'games'
  59     | 'entries'
  60     | 'consensus'
  61     | 'deletedGames'
  62     | 'snapshots'
  63     | 'vault'
  64   )[],
  65 >(
  66   database: IDBPDatabase<CP2PDatabase>,
  67   stores: Stores,
  68 ): IDBPTransaction<CP2PDatabase, Stores, 'readwrite'> {
  69   try {
  70     return database.transaction(stores, 'readwrite', { durability: 'strict' });
  71   } catch (error) {
  72     if (!(error instanceof TypeError)) throw error;
  73     return database.transaction(stores, 'readwrite');
  74   }
  75 }
```

## packages/storage/src/local-vault.ts

Lines 1-654:
```ts
   1 import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
   2 import * as v from 'valibot';
   3 import {
   4   BYTE_STORE,
   5   MAX_RECORD_BYTES,
   6   openDatabase,
   7   strictWriteTransaction,
   8   VAULT_STORE,
   9 } from './database.js';
  10 
  11 const VAULT_KEY = 'state';
  12 const LOCK_NAME = 'cp2p/local-vault/v1';
  13 const IDENTITY_KEY = 'online-credentials/device-identity/v1';
  14 const ITERATIONS = 600_000;
  15 const MAX_MIGRATION_BYTES = 256 * 1024 * 1024;
  16 const MAGIC = Uint8Array.of(0x56, 0x4c, 0x54, 0x31); // VLT1
  17 const HEADER_BYTES = 20;
  18 export const MAX_VAULT_STORED_BYTES = MAX_RECORD_BYTES + HEADER_BYTES + 16;
  19 
  20 export class VaultError extends Error {
  21   constructor(
  22     readonly code: 'locked' | 'invalid-key' | 'corrupt' | 'stale-generation',
  23     message: string,
  24   ) {
  25     super(message);
  26     this.name = 'VaultError';
  27   }
  28 }
  29 
  30 const bytesSchema = v.custom<Uint8Array>((value) => value instanceof Uint8Array);
  31 const generationSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(0xffffffff));
  32 const clearSchema = v.strictObject({
  33   protocol: v.literal('local-vault-v1'),
  34   mode: v.literal('clear'),
  35   generation: generationSchema,
  36   vaultId: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  37   identityHash: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  38 });
  39 const lockedSchema = v.strictObject({
  40   protocol: v.literal('local-vault-v1'),
  41   mode: v.literal('locked'),
  42   generation: generationSchema,
  43   vaultId: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  44   identityHash: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  45   salt: bytesSchema,
  46   iterations: v.literal(ITERATIONS),
  47   verifierNonce: bytesSchema,
  48   verifier: bytesSchema,
  49 });
  50 const metadataSchema = v.union([clearSchema, lockedSchema]);
  51 type VaultMetadata = v.InferOutput<typeof metadataSchema>;
  52 type VaultLockManager = Pick<LockManager, 'request'>;
  53 
  54 export interface VaultKeyHandoff {
  55   readonly key: CryptoKey;
  56   readonly vaultId: string;
  57   readonly generation: number;
  58 }
  59 
  60 export interface VaultOwnerOptions {
  61   readonly passphrase?: string;
  62   readonly handoff?: VaultKeyHandoff;
  63   /** Test seam; production uses same-origin Web Locks. */
  64   readonly lockManager?: VaultLockManager;
  65 }
  66 
  67 export interface VaultMigrationOptions {
  68   readonly oldPassphrase?: string;
  69   readonly newPassphrase?: string;
  70   /** Test seam; production uses same-origin Web Locks. */
  71   readonly lockManager?: VaultLockManager;
  72 }
  73 
  74 /** Exact public records needed by locked deletion, escrow retirement and transfer tombstones. */
  75 export function isPublicVaultRecord(key: string): boolean {
  76   return (
  77     key === 'escrow-lifecycle/device-index-v1' ||
  78     key === 'online-games/catalogue-v1' ||
  79     /^online-game\/[A-Za-z0-9_-]+\/(start|start-digest)$/.test(key) ||
  80     /^online-game-deleted\/[A-Za-z0-9_-]+$/.test(key) ||
  81     /^transfer-import-final\/[A-Za-z0-9_-]+\/[0-9a-f]{64}$/.test(key)
  82   );
  83 }
  84 
  85 /** An owner holds one shared lock across its room, game, ceremony or transfer lifetime. */
  86 export class VaultOwnerLease {
  87   readonly #access: VaultRecordAccess;
  88   readonly #release: () => void;
  89   readonly #held: Promise<void>;
  90   #closed = false;
  91 
  92   constructor(access: VaultRecordAccess, release: () => void, held: Promise<void>) {
  93     this.#access = access;
  94     this.#release = release;
  95     this.#held = held;
  96     void held.then(() => {
  97       if (!this.#closed) {
  98         this.#closed = true;
  99         access.close();
 100       }
 101       return undefined;
 102     });
 103   }
 104 
 105   get generation(): number {
 106     return this.#access.generation;
 107   }
 108 
 109   get mode(): 'clear' | 'locked' {
 110     return this.#access.mode;
 111   }
 112 
 113   handoff(): VaultKeyHandoff | null {
 114     this.assertActive();
 115     return this.#access.handoff();
 116   }
 117 
 118   /** Storage constructors use this only while the owner lease remains live. */
 119   access(): VaultRecordAccess {
 120     this.assertActive();
 121     return this.#access;
 122   }
 123 
 124   assertActive(): void {
 125     if (this.#closed) throw new Error('Vault owner lease is closed');
 126   }
 127 
 128   async close(): Promise<void> {
 129     if (this.#closed) return;
 130     this.#closed = true;
 131     this.#access.close();
 132     this.#release();
 133     await this.#held;
 134   }
 135 }
 136 
 137 /** Acquires the shared lock before any writer or ceremony lock. No inner storage call reacquires it. */
 138 export async function acquireVaultOwner(options: VaultOwnerOptions = {}): Promise<VaultOwnerLease> {
 139   const manager = options.lockManager ?? browserLocks();
 140   let release!: () => void;
 141   const untilRelease = new Promise<void>((resolve) => {
 142     release = resolve;
 143   });
 144   let resolveStarted!: () => void;
 145   const started = new Promise<void>((resolve) => {
 146     resolveStarted = resolve;
 147   });
 148   let lockError: unknown;
 149   let acquired = false;
 150   const held: Promise<void> = manager
 151     .request(LOCK_NAME, { mode: 'shared' }, async (lock) => {
 152       acquired = Boolean(lock);
 153       resolveStarted();
 154       if (lock) await untilRelease;
 155     })
 156     .then(
 157       () => undefined,
 158       (error: unknown) => {
 159         lockError = error;
 160         resolveStarted();
 161       },
 162     );
 163   await started;
 164   if (!acquired) {
 165     await held;
 166     throw lockError ?? new Error('Vault lock could not be acquired');
 167   }
 168   try {
 169     const access = new VaultRecordAccess();
 170     await access.pin(options);
 171     return new VaultOwnerLease(access, release, held);
 172   } catch (error) {
 173     release();
 174     await held;
 175     throw error;
 176   }
 177 }
 178 
 179 /** Migration is one exact-key-set and exact-value transaction after all encryption work. */
 180 export async function migrateLocalVault(options: VaultMigrationOptions): Promise<void> {
 181   const manager = options.lockManager ?? browserLocks();
 182   await manager.request(LOCK_NAME, { mode: 'exclusive' }, async (lock) => {
 183     if (!lock) throw new Error('Exclusive vault lock could not be acquired');
 184     const database = await openDatabase(
 185       () => undefined,
 186       () => undefined,
 187     );
 188     const oldRecords: { key: string; bytes: Uint8Array }[] = [];
 189     const replacements: { key: string; bytes: Uint8Array }[] = [];
 190     let oldRaw: Uint8Array | undefined;
 191     try {
 192       const read = database.transaction([BYTE_STORE, VAULT_STORE], 'readonly');
 193       let cursor = await read.objectStore(BYTE_STORE).openCursor();
 194       let total = 0;
 195       while (cursor) {
 196         const key = cursor.key;
 197         const bytes = cursor.value;
 198         if (
 199           typeof key !== 'string' ||
 200           key.length > 512 ||
 201           !(bytes instanceof Uint8Array) ||
 202           bytes.byteLength > MAX_VAULT_STORED_BYTES
 203         )
 204           throw new TypeError('Vault migration found a malformed record');
 205         total += key.length * 3 + bytes.byteLength;
 206         if (total > MAX_MIGRATION_BYTES || oldRecords.length >= 65_536)
 207           throw new RangeError('Vault migration is too large');
 208         oldRecords.push({ key, bytes });
 209         // IDB cursors keep the read transaction alive without materializing unbounded getAll().
 210         // eslint-disable-next-line no-await-in-loop
 211         cursor = await cursor.continue();
 212       }
 213       oldRaw = await read.objectStore(VAULT_STORE).get(VAULT_KEY);
 214       await read.done;
 215       const oldMeta = parseMetadata(oldRaw);
 216       const oldKey = await unlockKey(oldMeta, options.oldPassphrase);
 217       if (oldMeta?.mode === 'clear' && options.oldPassphrase !== undefined)
 218         throw new TypeError('Clear vault does not accept an old passphrase');
 219       if (!oldMeta && options.oldPassphrase !== undefined)
 220         throw new TypeError('Clear vault does not accept an old passphrase');
 221       const identity = oldRecords.find((item) => item.key === IDENTITY_KEY);
 222       if (!identity) throw new TypeError('Cannot migrate a device without its reserved identity');
 223       const identityPlain = await decodeProtected(IDENTITY_KEY, identity.bytes, oldMeta, oldKey);
 224       let identityHash: string;
 225       try {
 226         identityHash = await sha256Hex(identityPlain);
 227       } finally {
 228         identityPlain.fill(0);
 229       }
 230       if (oldMeta && oldMeta.identityHash !== identityHash)
 231         throw new TypeError('Reserved device identity changed before vault migration');
 232       const generation = (oldMeta?.generation ?? 0) + 1;
 233       if (generation > 0xffffffff) throw new RangeError('Vault generation is exhausted');
 234       const vaultId = oldMeta?.vaultId ?? randomHex(32);
 235       const next = await nextMetadata(vaultId, generation, identityHash, options.newPassphrase);
 236       for (const item of oldRecords) {
 237         if (isPublicVaultRecord(item.key)) continue;
 238         // Bound peak migration memory by converting records one at a time.
 239         // eslint-disable-next-line no-await-in-loop
 240         const plain = await decodeProtected(item.key, item.bytes, oldMeta, oldKey);
 241         try {
 242           // eslint-disable-next-line no-await-in-loop
 243           const encrypted = await encodeProtected(item.key, plain, next.meta, next.key);
 244           replacements.push({ key: item.key, bytes: encrypted });
 245         } finally {
 246           plain.fill(0);
 247         }
 248       }
 249       const nextRaw = canonicalEncode(next.meta);
 250       try {
 251         const transaction = strictWriteTransaction(database, [BYTE_STORE, VAULT_STORE]);
 252         try {
 253           const bytes = transaction.objectStore(BYTE_STORE);
 254           const currentKeys = await bytes.getAllKeys();
 255           if (
 256             currentKeys.length !== oldRecords.length ||
 257             currentKeys.some((key, index) => key !== oldRecords[index]?.key)
 258           )
 259             throw new TypeError('Vault records changed during migration');
 260           for (const item of oldRecords) {
 261             // Keep all IDB work in one transaction; no WebCrypto awaits in this loop.
 262             // eslint-disable-next-line no-await-in-loop
 263             const current = await bytes.get(item.key);
 264             if (!(current instanceof Uint8Array) || !equalBytes(current, item.bytes))
 265               throw new TypeError('Vault record changed during migration');
 266             current.fill(0);
 267           }
 268           const currentMeta = await transaction.objectStore(VAULT_STORE).get(VAULT_KEY);
 269           if (!equalOptional(currentMeta, oldRaw))
 270             throw new TypeError('Vault metadata changed during migration');
 271           currentMeta?.fill(0);
 272           for (const item of replacements) {
 273             // eslint-disable-next-line no-await-in-loop
 274             await bytes.put(item.bytes, item.key);
 275           }
 276           await transaction.objectStore(VAULT_STORE).put(nextRaw, VAULT_KEY);
 277           await transaction.done;
 278         } catch (error) {
 279           transaction.abort();
 280           await transaction.done.catch(() => undefined);
 281           throw error;
 282         }
 283       } finally {
 284         nextRaw.fill(0);
 285       }
 286     } finally {
 287       oldRaw?.fill(0);
 288       oldRecords.forEach((item) => item.bytes.fill(0));
 289       replacements.forEach((item) => item.bytes.fill(0));
 290       database.close();
 291     }
 292   });
 293 }
 294 
 295 /** Shared codec and generation assertion used by all direct IDB writers. */
 296 export class VaultRecordAccess {
 297   readonly #publicOnlyWhenLocked: boolean;
 298   #meta: VaultMetadata | null = null;
 299   #raw: Uint8Array | undefined;
 300   #key: CryptoKey | null = null;
 301   #ready: Promise<void> | null = null;
 302   #closed = false;
 303 
 304   constructor(publicOnlyWhenLocked = false) {
 305     this.#publicOnlyWhenLocked = publicOnlyWhenLocked;
 306   }
 307 
 308   get generation(): number {
 309     return this.#meta?.generation ?? 0;
 310   }
 311 
 312   get mode(): 'clear' | 'locked' {
 313     return this.#meta?.mode ?? 'clear';
 314   }
 315 
 316   get hasMetadata(): boolean {
 317     return this.#meta !== null;
 318   }
 319 
 320   handoff(): VaultKeyHandoff | null {
 321     if (this.#closed) throw new Error('Vault access is closed');
 322     if (!this.#key || this.#meta?.mode !== 'locked') return null;
 323     return { key: this.#key, vaultId: this.#meta.vaultId, generation: this.#meta.generation };
 324   }
 325 
 326   pin(options: Pick<VaultOwnerOptions, 'passphrase' | 'handoff'> = {}): Promise<void> {
 327     if (this.#closed) return Promise.reject(new Error('Vault access is closed'));
 328     if (this.#ready) return this.#ready;
 329     this.#ready = (async () => {
 330       const database = await openDatabase(
 331         () => undefined,
 332         () => undefined,
 333       );
 334       try {
 335         const raw = await database.get(VAULT_STORE, VAULT_KEY);
 336         const meta = parseMetadata(raw);
 337         const key = await unlockKey(
 338           meta,
 339           options.passphrase,
 340           options.handoff,
 341           this.#publicOnlyWhenLocked,
 342         );
 343         if (this.#closed) throw new VaultError('locked', 'Vault access closed during unlock');
 344         this.#raw = raw?.slice();
 345         this.#meta = meta;
 346         this.#key = key;
 347       } finally {
 348         database.close();
 349       }
 350     })().catch((error: unknown) => {
 351       if (!this.#closed) this.#ready = null;
 352       throw error;
 353     });
 354     return this.#ready;
 355   }
 356 
 357   async assertGeneration(vaultStore: {
 358     get(key: string): Promise<Uint8Array | undefined>;
 359   }): Promise<void> {
 360     if (this.#closed) throw new Error('Vault access is closed');
 361     await this.pin();
 362     if (this.#closed) throw new VaultError('locked', 'Vault access is closed');
 363     const current = await vaultStore.get(VAULT_KEY);
 364     try {
 365       if (!equalOptional(current, this.#raw))
 366         throw new VaultError('stale-generation', 'Vault generation changed; output is stopped');
 367     } finally {
 368       current?.fill(0);
 369     }
 370   }
 371 
 372   async encode(key: string, plain: Uint8Array): Promise<Uint8Array> {
 373     if (this.#closed) throw new Error('Vault access is closed');
 374     await this.pin();
 375     if (this.#closed) throw new VaultError('locked', 'Vault access is closed');
 376     await assertIdentityHash(key, plain, this.#meta);
 377     return encodeProtected(key, plain, this.#meta, this.#key);
 378   }
 379 
 380   async decode(key: string, stored: Uint8Array): Promise<Uint8Array> {
 381     if (this.#closed) throw new Error('Vault access is closed');
 382     await this.pin();
 383     if (this.#closed) throw new VaultError('locked', 'Vault access is closed');
 384     const plain = await decodeProtected(key, stored, this.#meta, this.#key);
 385     try {
 386       await assertIdentityHash(key, plain, this.#meta);
 387       return plain;
 388     } catch (error) {
 389       plain.fill(0);
 390       throw error;
 391     }
 392   }
 393 
 394   close(): void {
 395     this.#closed = true;
 396     this.#key = null;
 397     this.#raw?.fill(0);
 398     this.#raw = undefined;
 399   }
 400 }
 401 
 402 function browserLocks(): VaultLockManager {
 403   if (typeof navigator === 'undefined' || !navigator.locks)
 404     throw new Error('Web Locks are unavailable; vault coordination cannot proceed safely');
 405   return navigator.locks;
 406 }
 407 
 408 function parseMetadata(raw: Uint8Array | undefined): VaultMetadata | null {
 409   if (!raw) return null;
 410   if (!(raw instanceof Uint8Array) || raw.length > 512)
 411     throw new TypeError('Vault metadata is malformed');
 412   const meta = v.parse(metadataSchema, canonicalDecode(raw));
 413   if (meta.mode === 'locked' && (meta.salt.length !== 32 || meta.verifierNonce.length !== 12))
 414     throw new TypeError('Vault metadata has invalid cryptographic lengths');
 415   const canonical = canonicalEncode(meta);
 416   const exact = equalBytes(canonical, raw);
 417   canonical.fill(0);
 418   if (!exact) throw new TypeError('Vault metadata is noncanonical');
 419   return meta;
 420 }
 421 
 422 async function unlockKey(
 423   meta: VaultMetadata | null,
 424   passphrase?: string,
 425   handoff?: VaultKeyHandoff,
 426   publicOnlyWhenLocked = false,
 427 ): Promise<CryptoKey | null> {
 428   if (meta?.mode !== 'locked') {
 429     if (handoff) throw new TypeError('Vault key handoff does not match clear storage');
 430     if (passphrase !== undefined) throw new TypeError('Clear storage does not accept a passphrase');
 431     return null;
 432   }
 433   if (publicOnlyWhenLocked && passphrase === undefined && handoff === undefined) return null;
 434   if ((passphrase === undefined) === (handoff === undefined))
 435     throw new VaultError(
 436       'locked',
 437       'Locked storage requires exactly one passphrase or worker key handoff',
 438     );
 439   let key: CryptoKey;
 440   if (handoff) {
 441     if (
 442       handoff.vaultId !== meta.vaultId ||
 443       handoff.generation !== meta.generation ||
 444       !(handoff.key instanceof CryptoKey) ||
 445       handoff.key.extractable ||
 446       handoff.key.algorithm.name !== 'AES-GCM' ||
 447       !handoff.key.usages.includes('encrypt') ||
 448       !handoff.key.usages.includes('decrypt')
 449     )
 450       throw new TypeError('Vault key handoff does not match current metadata');
 451     key = handoff.key;
 452   } else key = await deriveKey(passphrase ?? '', meta.salt);
 453   try {
 454     const plain = new Uint8Array(
 455       await crypto.subtle.decrypt(
 456         {
 457           name: 'AES-GCM',
 458           iv: buffer(meta.verifierNonce),
 459           additionalData: buffer(aad(meta, 'verifier')),
 460         },
 461         key,
 462         buffer(meta.verifier),
 463       ),
 464     );
 465     const valid = equalBytes(plain, new TextEncoder().encode('cp2p-local-vault-v1'));
 466     plain.fill(0);
 467     if (!valid) throw new Error('Vault verifier is invalid');
 468     return key;
 469   } catch {
 470     throw new VaultError('invalid-key', 'Vault passphrase or key handoff is invalid');
 471   }
 472 }
 473 
 474 /** Deletion is a standalone exclusive operation, ordered before game and catalogue locks. */
 475 export async function withExclusiveVault<T>(
 476   task: () => Promise<T>,
 477   lockManager?: VaultLockManager,
 478 ): Promise<T> {
 479   const manager = lockManager ?? browserLocks();
 480   return manager.request(LOCK_NAME, { mode: 'exclusive' }, (lock) => {
 481     if (!lock) throw new Error('Exclusive vault lock could not be acquired');
 482     return task();
 483   });
 484 }
 485 
 486 async function nextMetadata(
 487   vaultId: string,
 488   generation: number,
 489   identityHash: string,
 490   passphrase?: string,
 491 ): Promise<{
 492   meta: VaultMetadata;
 493   key: CryptoKey | null;
 494 }> {
 495   if (passphrase === undefined)
 496     return {
 497       meta: { protocol: 'local-vault-v1', mode: 'clear', generation, vaultId, identityHash },
 498       key: null,
 499     };
 500   validatePassphrase(passphrase);
 501   const salt = crypto.getRandomValues(new Uint8Array(32));
 502   const verifierNonce = crypto.getRandomValues(new Uint8Array(12));
 503   const key = await deriveKey(passphrase, salt);
 504   const metaBase = {
 505     protocol: 'local-vault-v1' as const,
 506     mode: 'locked' as const,
 507     generation,
 508     vaultId,
 509     identityHash,
 510     salt,
 511     iterations: ITERATIONS as typeof ITERATIONS,
 512     verifierNonce,
 513   };
 514   const verifier = new Uint8Array(
 515     await crypto.subtle.encrypt(
 516       {
 517         name: 'AES-GCM',
 518         iv: buffer(verifierNonce),
 519         additionalData: buffer(aad(metaBase, 'verifier')),
 520       },
 521       key,
 522       new TextEncoder().encode('cp2p-local-vault-v1'),
 523     ),
 524   );
 525   return { meta: { ...metaBase, verifier }, key };
 526 }
 527 
 528 async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
 529   validatePassphrase(passphrase);
 530   const secret = new TextEncoder().encode(passphrase);
 531   try {
 532     const base = await crypto.subtle.importKey('raw', buffer(secret), 'PBKDF2', false, [
 533       'deriveKey',
 534     ]);
 535     return crypto.subtle.deriveKey(
 536       { name: 'PBKDF2', hash: 'SHA-256', salt: buffer(salt), iterations: ITERATIONS },
 537       base,
 538       { name: 'AES-GCM', length: 256 },
 539       false,
 540       ['encrypt', 'decrypt'],
 541     );
 542   } finally {
 543     secret.fill(0);
 544   }
 545 }
 546 
 547 async function encodeProtected(
 548   recordKey: string,
 549   plain: Uint8Array,
 550   meta: VaultMetadata | null,
 551   key: CryptoKey | null,
 552 ): Promise<Uint8Array> {
 553   if (!(plain instanceof Uint8Array) || plain.length > MAX_RECORD_BYTES)
 554     throw new RangeError('Vault plaintext record exceeds 16 MiB');
 555   if (isPublicVaultRecord(recordKey) || meta?.mode !== 'locked') return plain.slice();
 556   if (!key) throw new VaultError('locked', 'Vault key is unavailable');
 557   const nonce = crypto.getRandomValues(new Uint8Array(12));
 558   const ciphertext = new Uint8Array(
 559     await crypto.subtle.encrypt(
 560       { name: 'AES-GCM', iv: buffer(nonce), additionalData: buffer(aad(meta, recordKey)) },
 561       key,
 562       buffer(plain),
 563     ),
 564   );
 565   const stored = new Uint8Array(HEADER_BYTES + ciphertext.length);
 566   stored.set(MAGIC);
 567   new DataView(stored.buffer).setUint32(4, meta.generation);
 568   stored.set(nonce, 8);
 569   stored.set(ciphertext, HEADER_BYTES);
 570   ciphertext.fill(0);
 571   return stored;
 572 }
 573 
 574 async function decodeProtected(
 575   recordKey: string,
 576   stored: Uint8Array,
 577   meta: VaultMetadata | null,
 578   key: CryptoKey | null,
 579 ): Promise<Uint8Array> {
 580   if (!(stored instanceof Uint8Array) || stored.length > MAX_VAULT_STORED_BYTES)
 581     throw new TypeError('Vault stored record is malformed or oversized');
 582   if (isPublicVaultRecord(recordKey) || meta?.mode !== 'locked') {
 583     if (stored.length > MAX_RECORD_BYTES) throw new TypeError('Clear vault record exceeds 16 MiB');
 584     return stored.slice();
 585   }
 586   if (!key) throw new VaultError('locked', 'Vault key is unavailable');
 587   if (
 588     stored.length < HEADER_BYTES + 16 ||
 589     !equalBytes(stored.subarray(0, 4), MAGIC) ||
 590     new DataView(stored.buffer, stored.byteOffset).getUint32(4) !== meta.generation
 591   )
 592     throw new TypeError('Vault record has the wrong envelope or generation');
 593   try {
 594     const plain = new Uint8Array(
 595       await crypto.subtle.decrypt(
 596         {
 597           name: 'AES-GCM',
 598           iv: buffer(stored.subarray(8, 20)),
 599           additionalData: buffer(aad(meta, recordKey)),
 600         },
 601         key,
 602         buffer(stored.subarray(HEADER_BYTES)),
 603       ),
 604     );
 605     if (plain.length > MAX_RECORD_BYTES) {
 606       plain.fill(0);
 607       throw new TypeError('Vault record plaintext exceeds 16 MiB');
 608     }
 609     return plain;
 610   } catch {
 611     throw new VaultError('corrupt', 'Vault record authentication failed');
 612   }
 613 }
 614 
 615 function aad(meta: Pick<VaultMetadata, 'vaultId' | 'generation'>, key: string): Uint8Array {
 616   return canonicalEncode(['local-vault-v1', meta.vaultId, meta.generation, BYTE_STORE, key]);
 617 }
 618 
 619 function randomHex(length: number): string {
 620   return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) =>
 621     byte.toString(16).padStart(2, '0'),
 622   ).join('');
 623 }
 624 
 625 async function sha256Hex(bytes: Uint8Array): Promise<string> {
 626   const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer(bytes)));
 627   return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
 628 }
 629 
 630 async function assertIdentityHash(
 631   key: string,
 632   bytes: Uint8Array,
 633   meta: VaultMetadata | null,
 634 ): Promise<void> {
 635   if (key === IDENTITY_KEY && meta && (await sha256Hex(bytes)) !== meta.identityHash)
 636     throw new TypeError('Reserved device identity differs from the pinned vault identity');
 637 }
 638 
 639 function buffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
 640   return new Uint8Array(bytes);
 641 }
 642 
 643 function validatePassphrase(passphrase: string): void {
 644   if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024)
 645     throw new TypeError('Vault passphrase must contain 12 to 1024 characters');
 646 }
 647 
 648 function equalOptional(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
 649   return left === undefined ? right === undefined : right !== undefined && equalBytes(left, right);
 650 }
 651 
 652 function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
 653   return left.length === right.length && left.every((byte, index) => byte === right[index]);
 654 }
```

## packages/storage/src/indexed-db-byte-store.ts

Lines 1-258:
```ts
   1 import type { IDBPDatabase } from 'idb';
   2 import {
   3   BYTE_STORE,
   4   MAX_RECORD_BYTES,
   5   openDatabase,
   6   strictWriteTransaction,
   7   VAULT_STORE,
   8 } from './database.js';
   9 import type { CP2PDatabase } from './database.js';
  10 import { MAX_VAULT_STORED_BYTES, VaultRecordAccess } from './local-vault.js';
  11 import type { VaultOwnerLease } from './local-vault.js';
  12 
  13 const MAX_KEY_LENGTH = 512;
  14 const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
  15 const LOCK_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._:/-]*$/;
  16 
  17 export type CeremonyLockProvider = <T>(name: string, task: () => Promise<T>) => Promise<T>;
  18 
  19 export interface IndexedDbByteStoreOptions {
  20   /** A smaller application limit may be selected; the hard limit is 16 MiB. */
  21   readonly maxRecordBytes?: number;
  22   /** Override only for tests; production uses same-origin Web Locks. */
  23   readonly lockProvider?: CeremonyLockProvider;
  24   /** A lifetime owner lease acquired before ceremony or game-writer locks. */
  25   readonly vault?: VaultOwnerLease;
  26 }
  27 
  28 /**
  29  * Versioned cp2p IndexedDB foundation. Each method is a bounded atomic byte
  30  * record operation shared by every tab and connection on this origin. It does
  31  * not reset or replace an existing database after an error.
  32  */
  33 export class IndexedDbByteStore {
  34   readonly #maxRecordBytes: number;
  35   readonly #lockProvider: CeremonyLockProvider | undefined;
  36   readonly #vault: VaultRecordAccess;
  37   #databasePromise: Promise<IDBPDatabase<CP2PDatabase>> | null = null;
  38 
  39   constructor(options: IndexedDbByteStoreOptions = {}) {
  40     this.#maxRecordBytes = options.maxRecordBytes ?? MAX_RECORD_BYTES;
  41     this.#lockProvider = options.lockProvider;
  42     this.#vault = options.vault?.access() ?? new VaultRecordAccess(true);
  43     if (
  44       !Number.isSafeInteger(this.#maxRecordBytes) ||
  45       this.#maxRecordBytes < 0 ||
  46       this.#maxRecordBytes > MAX_RECORD_BYTES
  47     )
  48       throw new RangeError('maxRecordBytes must be between zero and 16 MiB');
  49   }
  50 
  51   get maxRecordBytes(): number {
  52     return this.#maxRecordBytes;
  53   }
  54 
  55   /** Internal direct-IDB callers share the same pinned generation and record codec. */
  56   recordAccess(): VaultRecordAccess {
  57     return this.#vault;
  58   }
  59 
  60   async load(id: string): Promise<Uint8Array | null> {
  61     const captured = await this.loadPinned(id);
  62     if (!captured) return null;
  63     captured.stored.fill(0);
  64     return captured.plain;
  65   }
  66 
  67   /** Returns detached plaintext plus the exact stored bytes needed for transaction CAS. */
  68   async loadPinned(id: string): Promise<{ plain: Uint8Array; stored: Uint8Array } | null> {
  69     const key = validateKey(id);
  70     await this.#vault.pin();
  71     const database = await this.#database();
  72     const transaction = database.transaction([BYTE_STORE, VAULT_STORE], 'readonly');
  73     let value: Uint8Array | undefined;
  74     try {
  75       await this.#vault.assertGeneration(transaction.objectStore(VAULT_STORE));
  76       value = await transaction.objectStore(BYTE_STORE).get(key);
  77       await transaction.done;
  78     } catch (error) {
  79       await transaction.done.catch(() => undefined);
  80       throw error;
  81     }
  82     if (value === undefined) {
  83       if (key === 'online-credentials/device-identity/v1' && this.#vault.hasMetadata)
  84         throw new TypeError('Reserved device identity is missing');
  85       return null;
  86     }
  87     try {
  88       validateStoredBytes(value, MAX_VAULT_STORED_BYTES);
  89       const plain = await this.#vault.decode(key, value);
  90       if (plain.length > this.#maxRecordBytes) {
  91         plain.fill(0);
  92         throw new TypeError('Stored IndexedDB record is malformed or oversized');
  93       }
  94       return { plain, stored: value.slice() };
  95     } finally {
  96       if (value instanceof Uint8Array) value.fill(0);
  97     }
  98   }
  99 
 100   async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
 101     const key = validateKey(id);
 102     const value = copyBytes(bytes, this.#maxRecordBytes);
 103     let stored: Uint8Array | undefined;
 104     try {
 105       stored = await this.#vault.encode(key, value);
 106       const database = await this.#database();
 107       const transaction = strictWriteTransaction(database, [BYTE_STORE, VAULT_STORE]);
 108       try {
 109         await this.#vault.assertGeneration(transaction.objectStore(VAULT_STORE));
 110         const store = transaction.objectStore(BYTE_STORE);
 111         const existing = await store.get(key);
 112         if (existing !== undefined) {
 113           await transaction.done;
 114           try {
 115             validateStoredBytes(existing, MAX_VAULT_STORED_BYTES);
 116           } finally {
 117             if (existing instanceof Uint8Array) existing.fill(0);
 118           }
 119           return false;
 120         }
 121         if (key === 'online-credentials/device-identity/v1' && this.#vault.hasMetadata)
 122           throw new TypeError('Reserved device identity is missing');
 123         await store.add(stored, key);
 124         await transaction.done;
 125         return true;
 126       } catch (error) {
 127         await transaction.done.catch(() => undefined);
 128         throw error;
 129       }
 130     } finally {
 131       value.fill(0);
 132       stored?.fill(0);
 133     }
 134   }
 135 
 136   /** Byte-exact compare-and-swap in one cross-connection readwrite transaction. */
 137   async compareAndSwap(
 138     id: string,
 139     expected: Uint8Array,
 140     replacement: Uint8Array,
 141   ): Promise<boolean> {
 142     const key = validateKey(id);
 143     const expectedCopy = copyBytes(expected, this.#maxRecordBytes);
 144     let replacementCopy: Uint8Array;
 145     try {
 146       replacementCopy = copyBytes(replacement, this.#maxRecordBytes);
 147     } catch (error) {
 148       expectedCopy.fill(0);
 149       throw error;
 150     }
 151     let pinned: { plain: Uint8Array; stored: Uint8Array } | null = null;
 152     let storedReplacement: Uint8Array | undefined;
 153     try {
 154       pinned = await this.loadPinned(key);
 155       if (!pinned || !equalBytes(pinned.plain, expectedCopy)) return false;
 156       storedReplacement = await this.#vault.encode(key, replacementCopy);
 157       const database = await this.#database();
 158       const transaction = strictWriteTransaction(database, [BYTE_STORE, VAULT_STORE]);
 159       let existing: Uint8Array | undefined;
 160       try {
 161         await this.#vault.assertGeneration(transaction.objectStore(VAULT_STORE));
 162         const store = transaction.objectStore(BYTE_STORE);
 163         existing = await store.get(key);
 164         if (existing === undefined) {
 165           await transaction.done;
 166           return false;
 167         }
 168         const current = validateStoredBytes(existing, MAX_VAULT_STORED_BYTES);
 169         if (!equalBytes(current, pinned.stored)) {
 170           await transaction.done;
 171           return false;
 172         }
 173         await store.put(storedReplacement, key);
 174         await transaction.done;
 175         return true;
 176       } catch (error) {
 177         await transaction.done.catch(() => undefined);
 178         throw error;
 179       } finally {
 180         if (existing instanceof Uint8Array) existing.fill(0);
 181       }
 182     } finally {
 183       expectedCopy.fill(0);
 184       replacementCopy.fill(0);
 185       pinned?.plain.fill(0);
 186       pinned?.stored.fill(0);
 187       storedReplacement?.fill(0);
 188     }
 189   }
 190 
 191   /**
 192    * Serialize escrow read/CAS/send-enqueue work across tabs. A caller should
 193    * keep the callback to its critical section; this lock does not replace IDB
 194    * transactions or make network delivery durable.
 195    */
 196   async withCeremonyLock<T>(ceremonyId: string, task: () => Promise<T>): Promise<T> {
 197     // Bare ceremony digests use every base64url character, including the first one.
 198     const id = validateKey(ceremonyId, LOCK_PATTERN);
 199     const lockName = `cp2p/escrow-ceremony/${id}`;
 200     const provider = this.#lockProvider ?? browserLockProvider;
 201     return provider(lockName, task);
 202   }
 203 
 204   /** Close this connection; a later operation may open a fresh connection. */
 205   async close(): Promise<void> {
 206     const pending = this.#databasePromise;
 207     this.#databasePromise = null;
 208     if (!pending) return;
 209     const database = await pending;
 210     database.close();
 211   }
 212 
 213   #database(): Promise<IDBPDatabase<CP2PDatabase>> {
 214     if (this.#databasePromise) return this.#databasePromise;
 215     let opening: Promise<IDBPDatabase<CP2PDatabase>>;
 216     opening = openDatabase(
 217       () => {
 218         if (this.#databasePromise === opening) this.#databasePromise = null;
 219       },
 220       () => {
 221         if (this.#databasePromise === opening) this.#databasePromise = null;
 222       },
 223     ).catch((error: unknown) => {
 224       if (this.#databasePromise === opening) this.#databasePromise = null;
 225       throw error;
 226     });
 227     this.#databasePromise = opening;
 228     return opening;
 229   }
 230 }
 231 
 232 function validateKey(id: string, pattern = KEY_PATTERN): string {
 233   if (typeof id !== 'string' || id.length === 0 || id.length > MAX_KEY_LENGTH || !pattern.test(id))
 234     throw new TypeError('IndexedDB record key is invalid');
 235   return id;
 236 }
 237 
 238 function copyBytes(value: Uint8Array, maxBytes: number): Uint8Array {
 239   if (!(value instanceof Uint8Array) || value.byteLength > maxBytes)
 240     throw new RangeError('IndexedDB record must be a bounded Uint8Array');
 241   return value.slice();
 242 }
 243 
 244 function validateStoredBytes(value: unknown, maxBytes: number): Uint8Array {
 245   if (!(value instanceof Uint8Array) || value.byteLength > maxBytes)
 246     throw new TypeError('Stored IndexedDB record is malformed or oversized');
 247   return value;
 248 }
 249 
 250 function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
 251   return left.length === right.length && left.every((byte, index) => byte === right[index]);
 252 }
 253 
 254 const browserLockProvider: CeremonyLockProvider = async (name, task) => {
 255   if (typeof navigator === 'undefined' || !navigator.locks)
 256     throw new Error('Web Locks are unavailable; escrow coordination cannot proceed safely');
 257   return navigator.locks.request(name, { mode: 'exclusive' }, () => task());
 258 };
```

## packages/storage/src/indexed-db-protocol-journal.ts

Lines 1-168:
```ts
   1 import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
   2 import {
   3   certifiedEntrySchema,
   4   createConsensusState,
   5   entryHash,
   6   genesisDigest,
   7   logEntrySchema,
   8   replayCertifiedPrefix,
   9   restoreRetiredSafety,
  10   validateRetiredTransferBinding,
  11   validateTransferOwnedMaterial,
  12 } from '@cp2p/protocol';
  13 import type {
  14   CertifiedEntry,
  15   LogContext,
  16   LogEntry,
  17   ProtocolJournal,
  18   ReplayPolicy,
  19 } from '@cp2p/protocol';
  20 import type { IDBPDatabase } from 'idb';
  21 import * as v from 'valibot';
  22 import type { CP2PDatabase } from './database.js';
  23 import {
  24   CONSENSUS_STORE,
  25   DELETED_GAME_STORE,
  26   ENTRY_STORE,
  27   BYTE_STORE,
  28   GAME_STORE,
  29   MAX_RECORD_BYTES,
  30   openDatabase,
  31   strictWriteTransaction,
  32   VAULT_STORE,
  33 } from './database.js';
  34 import { IndexedDbByteStore } from './indexed-db-byte-store.js';
  35 import { VaultRecordAccess } from './local-vault.js';
  36 import type { VaultOwnerLease } from './local-vault.js';
  37 import { acquireActiveGameWriterLease } from './game-writer.js';
  38 import type { GameWriterLeaseOptions } from './game-writer.js';
  39 import { assertOnlineGameNotDeleted } from './online-game-deletion.js';
  40 import {
  41   deleteAuthorizationStages,
  42   readinessKey,
  43   transferImportFinalKey,
  44   TransferImportStore,
  45 } from './transfer-import-store.js';
  46 import type { TransferReplayEngine } from './transfer-import-store.js';
  47 
  48 export interface TransferPromotionOptions {
  49   readonly stageKey: string;
  50   readonly activation: CertifiedEntry;
  51   readonly engine: Parameters<typeof replayCertifiedPrefix>[2];
  52   readonly policy: ReplayPolicy;
  53   /** Null requires a wholly absent active journal and binding on this device. */
  54   readonly expectedActive: {
  55     readonly head: { readonly seq: number; readonly hash: string };
  56     readonly bindingBytes: Uint8Array;
  57   } | null;
  58   readonly leaseOptions?: GameWriterLeaseOptions;
  59 }
  60 
  61 const consensusRecordSchema = v.strictObject({
  62   height: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER)),
  63   revision: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  64   safety: v.custom<Uint8Array>((value) => value instanceof Uint8Array),
  65 });
  66 
  67 interface ConsensusRecord {
  68   height: number;
  69   revision: number;
  70   safety: Uint8Array;
  71 }
  72 
  73 export interface IndexedDbProtocolJournalOptions {
  74   readonly maxRecordBytes?: number;
  75   readonly vault?: VaultOwnerLease;
  76   /**
  77    * Bind a separately persisted voting-key record to this journal. The record
  78    * and initial journal safety data are installed in one transaction.
  79    */
  80   readonly keyBinding?: { readonly recordKey: string; readonly bytes: Uint8Array };
  81 }
  82 
  83 /** Stores each certified entry once and updates next-height safety in the same transaction. */
  84 export class IndexedDbProtocolJournal implements ProtocolJournal {
  85   readonly #gameId: string;
  86   readonly #maxRecordBytes: number;
  87   readonly #keyBinding: { readonly recordKey: string; readonly bytes: Uint8Array } | undefined;
  88   readonly #vault: VaultRecordAccess;
  89   readonly #vaultOwner: VaultOwnerLease | undefined;
  90   #storedBinding: Uint8Array | undefined;
  91   #databasePromise: Promise<IDBPDatabase<CP2PDatabase>> | null = null;
  92   #closePromise: Promise<void> | null = null;
  93   #closed = false;
  94   #activeOperations = 0;
  95   #drainOperations: (() => void) | null = null;
  96 
  97   constructor(gameId: string, options: IndexedDbProtocolJournalOptions = {}) {
  98     if (
  99       typeof gameId !== 'string' ||
 100       gameId.length === 0 ||
 101       gameId.length > 512 ||
 102       !/^[A-Za-z0-9_-][A-Za-z0-9._:/-]*$/.test(gameId)
 103     )
 104       throw new TypeError('Journal gameId is invalid');
 105     const maxRecordBytes = options.maxRecordBytes ?? MAX_RECORD_BYTES;
 106     if (
 107       !Number.isSafeInteger(maxRecordBytes) ||
 108       maxRecordBytes < 0 ||
 109       maxRecordBytes > MAX_RECORD_BYTES
 110     )
 111       throw new RangeError('maxRecordBytes must be between zero and 16 MiB');
 112     this.#gameId = gameId;
 113     this.#maxRecordBytes = maxRecordBytes;
 114     this.#vaultOwner = options.vault;
 115     this.#vault = options.vault?.access() ?? new VaultRecordAccess(true);
 116     this.#keyBinding = options.keyBinding
 117       ? copyKeyBinding(options.keyBinding, maxRecordBytes)
 118       : undefined;
 119   }
 120 
 121   load() {
 122     return this.#runOperation(() => this.#load());
 123   }
 124 
 125   async #load() {
 126     const database = await this.#database();
 127     const keyBinding = this.#keyBinding;
 128     const stores = keyBinding
 129       ? ([
 130           GAME_STORE,
 131           ENTRY_STORE,
 132           CONSENSUS_STORE,
 133           BYTE_STORE,
 134           DELETED_GAME_STORE,
 135           VAULT_STORE,
 136         ] as const)
 137       : ([GAME_STORE, ENTRY_STORE, CONSENSUS_STORE, DELETED_GAME_STORE, VAULT_STORE] as const);
 138     const transaction = database.transaction(stores, 'readonly');
 139     let bindingBytes: Uint8Array | undefined;
 140     try {
 141       await this.#vault.assertGeneration(transaction.objectStore(VAULT_STORE));
 142       await assertOnlineGameNotDeleted(transaction, this.#gameId);
 143       const genesisBytes = await transaction.objectStore(GAME_STORE).get(this.#gameId);
 144       const consensusBytes = await transaction.objectStore(CONSENSUS_STORE).get(this.#gameId);
 145       const range = IDBKeyRange.bound([this.#gameId, 0], [this.#gameId, Number.MAX_SAFE_INTEGER]);
 146       const entryKeys = await transaction.objectStore(ENTRY_STORE).getAllKeys(range);
 147       const entryBytes = await transaction.objectStore(ENTRY_STORE).getAll(range);
 148       bindingBytes = keyBinding
 149         ? await transaction.objectStore(BYTE_STORE).get(keyBinding.recordKey)
 150         : undefined;
 151       await transaction.done;
 152 
 153       const journalAbsent =
 154         genesisBytes === undefined && consensusBytes === undefined && entryKeys.length === 0;
 155       if (journalAbsent) {
 156         if (bindingBytes !== undefined)
 157           throw new TypeError('Voting-key binding exists without its journal');
 158         return null;
 159       }
 160       if (keyBinding) await this.#acceptBinding(bindingBytes);
 161       if (genesisBytes === undefined || consensusBytes === undefined)
 162         throw new TypeError('Journal metadata is incomplete');
 163       const genesis = decodeRecord(genesisBytes, logEntrySchema, this.#maxRecordBytes);
 164       if (
 165         genesis.seq !== 0 ||
 166         genesis.payload.kind !== 'genesis' ||
 167         genesis.payload.genesis.gameId !== this.#gameId
 168       )
```

Lines 184-454:
```ts
 184       return {
 185         genesis: copyLogEntry(genesis, this.#maxRecordBytes),
 186         entries: entries.map((entry) => copyCertifiedEntry(entry, this.#maxRecordBytes)),
 187         height: consensus.height,
 188         safety: { revision: consensus.revision, bytes: consensus.safety.slice() },
 189       };
 190     } catch (error) {
 191       await transaction.done.catch(() => undefined);
 192       throw error;
 193     } finally {
 194       if (bindingBytes instanceof Uint8Array) bindingBytes.fill(0);
 195     }
 196   }
 197 
 198   initialize(genesis: LogEntry, safety: Uint8Array): Promise<boolean> {
 199     return this.#runOperation(() => this.#initialize(genesis, safety));
 200   }
 201 
 202   async #initialize(genesis: LogEntry, safety: Uint8Array): Promise<boolean> {
 203     const checkedGenesis = copyLogEntry(genesis, this.#maxRecordBytes);
 204     if (
 205       checkedGenesis.seq !== 0 ||
 206       checkedGenesis.payload.kind !== 'genesis' ||
 207       checkedGenesis.payload.genesis.gameId !== this.#gameId
 208     )
 209       throw new TypeError('Journal genesis must be sequence zero for its pinned gameId');
 210     const safetyBytes = copyBytes(safety, this.#maxRecordBytes);
 211     const genesisBytes = canonicalEncode(checkedGenesis);
 212     const consensusBytes = encodeRecord(
 213       { height: 1, revision: 0, safety: safetyBytes },
 214       consensusRecordSchema,
 215       this.#maxRecordBytes,
 216     );
 217     const expectedBinding = await this.#captureBinding();
 218     const newBinding =
 219       this.#keyBinding && !expectedBinding
 220         ? await this.#vault.encode(this.#keyBinding.recordKey, this.#keyBinding.bytes)
 221         : undefined;
 222     const database = await this.#database();
 223     const keyBinding = this.#keyBinding;
 224     const stores = keyBinding
 225       ? ([
 226           GAME_STORE,
 227           ENTRY_STORE,
 228           CONSENSUS_STORE,
 229           BYTE_STORE,
 230           DELETED_GAME_STORE,
 231           VAULT_STORE,
 232         ] as const)
 233       : ([GAME_STORE, ENTRY_STORE, CONSENSUS_STORE, DELETED_GAME_STORE, VAULT_STORE] as const);
 234     const transaction = strictWriteTransaction(database, stores);
 235     let bindingExists: Uint8Array | undefined;
 236     try {
 237       await this.#vault.assertGeneration(transaction.objectStore(VAULT_STORE));
 238       await assertOnlineGameNotDeleted(transaction, this.#gameId);
 239       const genesisExists = await transaction.objectStore(GAME_STORE).get(this.#gameId);
 240       const consensusExists = await transaction.objectStore(CONSENSUS_STORE).get(this.#gameId);
 241       const entryCount = await transaction
 242         .objectStore(ENTRY_STORE)
 243         .count(IDBKeyRange.bound([this.#gameId, 0], [this.#gameId, Number.MAX_SAFE_INTEGER]));
 244       const journalExists =
 245         genesisExists !== undefined || consensusExists !== undefined || entryCount !== 0;
 246       bindingExists = keyBinding
 247         ? await transaction.objectStore(BYTE_STORE).get(keyBinding.recordKey)
 248         : undefined;
 249       if (keyBinding) {
 250         if (!journalExists && bindingExists !== undefined)
 251           throw new TypeError('Voting-key binding exists without its journal');
 252         if (
 253           journalExists &&
 254           (bindingExists === undefined ||
 255             !expectedBinding ||
 256             !equalBytes(bindingExists, expectedBinding))
 257         )
 258           throw new TypeError('Existing journal voting-key binding is missing or mismatched');
 259       }
 260       if (journalExists) {
 261         if (genesisExists === undefined || consensusExists === undefined)
 262           throw new TypeError('Existing journal metadata is incomplete');
 263         const existingGenesis = decodeRecord(genesisExists, logEntrySchema, this.#maxRecordBytes);
 264         const existingConsensus = decodeRecord(
 265           consensusExists,
 266           consensusRecordSchema,
 267           this.#maxRecordBytes,
 268         );
 269         if (
 270           existingGenesis.seq !== 0 ||
 271           existingGenesis.payload.kind !== 'genesis' ||
 272           existingGenesis.payload.genesis.gameId !== this.#gameId ||
 273           existingConsensus.height !== entryCount + 1
 274         )
 275           throw new TypeError('Existing journal metadata is inconsistent');
 276         if (!equalBytes(canonicalEncode(existingGenesis), genesisBytes))
 277           throw new TypeError('Existing journal genesis differs from requested genesis');
 278         await transaction.done;
 279         return false;
 280       }
 281       if (keyBinding) {
 282         const bindingCopy = newBinding?.slice();
 283         if (!bindingCopy) throw new TypeError('New voting-key binding was not prepared');
 284         try {
 285           await transaction.objectStore(BYTE_STORE).add(bindingCopy, keyBinding.recordKey);
 286         } finally {
 287           bindingCopy.fill(0);
 288         }
 289       }
 290       await transaction.objectStore(GAME_STORE).add(genesisBytes, this.#gameId);
 291       await transaction.objectStore(CONSENSUS_STORE).add(consensusBytes, this.#gameId);
 292       await transaction.done;
 293       return true;
 294     } catch (error) {
 295       await transaction.done.catch(() => undefined);
 296       throw error;
 297     } finally {
 298       if (bindingExists instanceof Uint8Array) bindingExists.fill(0);
 299       expectedBinding?.fill(0);
 300       newBinding?.fill(0);
 301     }
 302   }
 303 
 304   loadSafety(height: number) {
 305     return this.#runOperation(() => this.#loadSafety(height));
 306   }
 307 
 308   async #loadSafety(height: number) {
 309     validateHeight(height);
 310     const database = await this.#database();
 311     const keyBinding = this.#keyBinding;
 312     const stores = keyBinding
 313       ? ([
 314           GAME_STORE,
 315           ENTRY_STORE,
 316           CONSENSUS_STORE,
 317           BYTE_STORE,
 318           DELETED_GAME_STORE,
 319           VAULT_STORE,
 320         ] as const)
 321       : ([CONSENSUS_STORE, DELETED_GAME_STORE, VAULT_STORE] as const);
 322     const transaction = database.transaction(stores, 'readonly');
 323     let bindingBytes: Uint8Array | undefined;
 324     try {
 325       await this.#vault.assertGeneration(transaction.objectStore(VAULT_STORE));
 326       await assertOnlineGameNotDeleted(transaction, this.#gameId);
 327       const bytes = await transaction.objectStore(CONSENSUS_STORE).get(this.#gameId);
 328       const genesisBytes = keyBinding
 329         ? await transaction.objectStore(GAME_STORE).get(this.#gameId)
 330         : undefined;
 331       const entryCount = keyBinding
 332         ? await transaction
 333             .objectStore(ENTRY_STORE)
 334             .count(IDBKeyRange.bound([this.#gameId, 0], [this.#gameId, Number.MAX_SAFE_INTEGER]))
 335         : 0;
 336       bindingBytes = keyBinding
 337         ? await transaction.objectStore(BYTE_STORE).get(keyBinding.recordKey)
 338         : undefined;
 339       await transaction.done;
 340       if (keyBinding) {
 341         const journalExists = genesisBytes !== undefined || bytes !== undefined || entryCount !== 0;
 342         if (!journalExists && bindingBytes === undefined) return null;
 343         if (!journalExists) throw new TypeError('Voting-key binding exists without its journal');
 344         if (genesisBytes === undefined || bytes === undefined || bindingBytes === undefined)
 345           throw new TypeError('Journal safety or voting-key binding is missing');
 346         await this.#acceptBinding(bindingBytes);
 347       }
 348       if (bytes === undefined) return null;
 349       const consensus = decodeRecord(bytes, consensusRecordSchema, this.#maxRecordBytes);
 350       return consensus.height === height
 351         ? { revision: consensus.revision, bytes: consensus.safety.slice() }
 352         : null;
 353     } catch (error) {
 354       await transaction.done.catch(() => undefined);
 355       throw error;
 356     } finally {
 357       if (bindingBytes instanceof Uint8Array) bindingBytes.fill(0);
 358     }
 359   }
 360 
 361   saveSafety(height: number, revision: number, bytes: Uint8Array): Promise<boolean> {
 362     return this.#runOperation(() => this.#saveSafety(height, revision, bytes));
 363   }
 364 
 365   async #saveSafety(height: number, revision: number, bytes: Uint8Array): Promise<boolean> {
 366     validateHeight(height);
 367     validateRevision(revision);
 368     if (revision === Number.MAX_SAFE_INTEGER) return false;
 369     const safety = copyBytes(bytes, this.#maxRecordBytes);
 370     const expectedBinding = await this.#captureBinding();
 371     const database = await this.#database();
 372     const keyBinding = this.#keyBinding;
 373     const stores = keyBinding
 374       ? ([CONSENSUS_STORE, BYTE_STORE, DELETED_GAME_STORE, VAULT_STORE] as const)
 375       : ([CONSENSUS_STORE, DELETED_GAME_STORE, VAULT_STORE] as const);
 376     const transaction = strictWriteTransaction(database, stores);
 377     let bindingBytes: Uint8Array | undefined;
 378     try {
 379       await this.#vault.assertGeneration(transaction.objectStore(VAULT_STORE));
 380       await assertOnlineGameNotDeleted(transaction, this.#gameId);
 381       const currentBytes = await transaction.objectStore(CONSENSUS_STORE).get(this.#gameId);
 382       if (currentBytes === undefined) {
 383         await transaction.done;
 384         return false;
 385       }
 386       if (keyBinding) {
 387         bindingBytes = await transaction.objectStore(BYTE_STORE).get(keyBinding.recordKey);
 388         if (
 389           bindingBytes === undefined ||
 390           !expectedBinding ||
 391           !equalBytes(bindingBytes, expectedBinding)
 392         )
 393           throw new TypeError('Journal voting-key binding is missing or mismatched');
 394       }
 395       const current = decodeRecord(currentBytes, consensusRecordSchema, this.#maxRecordBytes);
 396       if (current.height !== height || current.revision !== revision) {
 397         await transaction.done;
 398         return false;
 399       }
 400       const replacement = encodeRecord(
 401         { height, revision: revision + 1, safety },
 402         consensusRecordSchema,
 403         this.#maxRecordBytes,
 404       );
 405       await transaction.objectStore(CONSENSUS_STORE).put(replacement, this.#gameId);
 406       await transaction.done;
 407       return true;
 408     } catch (error) {
 409       await transaction.done.catch(() => undefined);
 410       throw error;
 411     } finally {
 412       if (bindingBytes instanceof Uint8Array) bindingBytes.fill(0);
 413       expectedBinding?.fill(0);
 414     }
 415   }
 416 
 417   commit(
 418     height: number,
 419     safetyRevision: number,
 420     certified: CertifiedEntry,
 421     nextSafety: Uint8Array,
 422   ): Promise<boolean> {
 423     return this.#runOperation(() => this.#commit(height, safetyRevision, certified, nextSafety));
 424   }
 425 
 426   async #commit(
 427     height: number,
 428     safetyRevision: number,
 429     certified: CertifiedEntry,
 430     nextSafety: Uint8Array,
 431   ): Promise<boolean> {
 432     validateHeight(height);
 433     validateRevision(safetyRevision);
 434     if (height === Number.MAX_SAFE_INTEGER) return false;
 435     const checkedEntry = copyCertifiedEntry(certified, this.#maxRecordBytes);
 436     if (checkedEntry.entry.seq !== height) return false;
 437     const certifiedBytes = canonicalEncode(checkedEntry);
 438     const safetyBytes = copyBytes(nextSafety, this.#maxRecordBytes);
 439     const nextConsensus = encodeRecord(
 440       { height: height + 1, revision: 0, safety: safetyBytes },
 441       consensusRecordSchema,
 442       this.#maxRecordBytes,
 443     );
 444     const expectedBinding = await this.#captureBinding();
 445     const database = await this.#database();
 446     const keyBinding = this.#keyBinding;
 447     const stores = keyBinding
 448       ? ([
 449           GAME_STORE,
 450           ENTRY_STORE,
 451           CONSENSUS_STORE,
 452           BYTE_STORE,
 453           DELETED_GAME_STORE,
 454           VAULT_STORE,
```

Lines 464-825:
```ts
 464         await transaction.done;
 465         return false;
 466       }
 467       if (keyBinding) {
 468         bindingBytes = await transaction.objectStore(BYTE_STORE).get(keyBinding.recordKey);
 469         if (
 470           bindingBytes === undefined ||
 471           !expectedBinding ||
 472           !equalBytes(bindingBytes, expectedBinding)
 473         )
 474           throw new TypeError('Journal voting-key binding is missing or mismatched');
 475       }
 476       const current = decodeRecord(consensusBytes, consensusRecordSchema, this.#maxRecordBytes);
 477       if (current.height !== height || current.revision !== safetyRevision) {
 478         await transaction.done;
 479         return false;
 480       }
 481       const parent = await this.#parentEntry(transaction, height);
 482       if (checkedEntry.entry.prevHash !== entryHash(parent)) {
 483         await transaction.done;
 484         return false;
 485       }
 486       await transaction.objectStore(ENTRY_STORE).add(certifiedBytes, [this.#gameId, height]);
 487       await transaction.objectStore(CONSENSUS_STORE).put(nextConsensus, this.#gameId);
 488       await transaction.done;
 489       return true;
 490     } catch (error) {
 491       await transaction.done.catch(() => undefined);
 492       throw error;
 493     } finally {
 494       if (bindingBytes instanceof Uint8Array) bindingBytes.fill(0);
 495       expectedBinding?.fill(0);
 496     }
 497   }
 498 
 499   /**
 500    * Promote an authenticated, fully replayed import. No pre-activation staging
 501    * record can be opened as a voting journal. The Web Lock coordinates local
 502    * writers; the transaction remains the cross-tab compare-and-swap boundary.
 503    */
 504   promoteTransfer(options: TransferPromotionOptions): Promise<boolean> {
 505     if (this.#closed) return Promise.reject(new Error('Journal is closed'));
 506     const activation = copyCertifiedEntry(options.activation, this.#maxRecordBytes);
 507     const expectedActive = options.expectedActive
 508       ? {
 509           head: { ...options.expectedActive.head },
 510           bindingBytes: copyBytes(options.expectedActive.bindingBytes, this.#maxRecordBytes),
 511         }
 512       : null;
 513     return this.#runOperation(async () => {
 514       let lease: Awaited<ReturnType<typeof acquireActiveGameWriterLease>> = null;
 515       try {
 516         lease = await acquireActiveGameWriterLease(this.#gameId, options.leaseOptions);
 517         if (!lease) return false;
 518         return await lease.run(() =>
 519           this.#promoteTransfer({ ...options, activation, expectedActive }),
 520         );
 521       } finally {
 522         try {
 523           await lease?.close();
 524         } finally {
 525           expectedActive?.bindingBytes.fill(0);
 526         }
 527       }
 528     });
 529   }
 530 
 531   async #promoteTransfer(options: TransferPromotionOptions): Promise<boolean> {
 532     const keyBinding = this.#keyBinding;
 533     if (!keyBinding) throw new TypeError('Transfer promotion requires a destination key binding');
 534     const stagedStore = new TransferImportStore(this.#newByteStore());
 535     let staged: Awaited<ReturnType<TransferImportStore['load']>> = null;
 536     let readiness: Awaited<ReturnType<TransferImportStore['loadReadiness']>> = null;
 537     let storedStage: Uint8Array | undefined;
 538     let storedReadiness: Uint8Array | undefined;
 539     let storedOldBinding: Uint8Array | undefined;
 540     let storedNewBinding: Uint8Array | undefined;
 541     try {
 542       const stagePinned = await stagedStore.loadPinned(options.stageKey);
 543       const readinessPinned = await stagedStore.loadReadinessPinned(options.stageKey);
 544       staged = stagePinned?.record ?? null;
 545       readiness = readinessPinned?.record ?? null;
 546       storedStage = stagePinned?.stored;
 547       storedReadiness = readinessPinned?.stored;
 548       if (!staged || !readiness || staged.gameId !== this.#gameId)
 549         throw new TypeError('Transfer import or durable readiness is missing');
 550       const authorization = staged.authorization;
 551       if (
 552         !equalBytes(staged.bindingBytes, keyBinding.bytes) ||
 553         options.activation.entry.seq !== staged.head.seq + 1 ||
 554         options.activation.entry.prevHash !== staged.head.hash ||
 555         staged.authorization.seq >= options.activation.entry.seq
 556       )
 557         throw new TypeError('Activation is not the exact next entry after staged import');
 558       const fullEntries = [...staged.entries, options.activation];
 559       const before = replayCertifiedPrefix(
 560         staged.genesis,
 561         staged.entries,
 562         options.engine,
 563         options.policy,
 564       );
 565       const after = replayCertifiedPrefix(
 566         staged.genesis,
 567         fullEntries,
 568         options.engine,
 569         options.policy,
 570       );
 571       if (!before.ok || !after.ok)
 572         throw new TypeError('Transfer promotion requires a fully certified valid prefix');
 573       const change = options.activation.entry.payload;
 574       if (
 575         change.kind !== 'membership' ||
 576         !isTransferActivation(change.change) ||
 577         change.change.statement.authorization.seq !== staged.authorization.seq ||
 578         change.change.statement.authorization.hash !== staged.authorization.hash ||
 579         change.change.statement.parent.seq !== staged.head.seq ||
 580         change.change.statement.parent.hash !== staged.head.hash ||
 581         !equalBytes(
 582           canonicalEncode(readiness.statement),
 583           canonicalEncode(change.change.statement),
 584         ) ||
 585         readiness.destinationCheck !== change.change.destinationCheck ||
 586         !equalBytes(
 587           canonicalEncode(readiness.replacementChecks),
 588           canonicalEncode(change.change.replacementChecks),
 589         ) ||
 590         !after.value.context.log.transfer?.completed.some(
 591           (item) =>
 592             item.outcome === 'activated' &&
 593             item.authorization.seq === authorization.seq &&
 594             item.authorization.hash === authorization.hash &&
 595             item.entry.seq === options.activation.entry.seq &&
 596             item.entry.hash === entryHash(options.activation.entry),
 597         )
 598       )
 599         throw new TypeError('Certified activation differs from durable import readiness');
 600       const digest = genesisDigest(after.value.context.log.genesis);
 601       if (keyBinding.recordKey !== `online-game/${digest}/keys`)
 602         throw new TypeError('Destination binding is outside its game namespace');
 603       const destinationBinding = canonicalDecode(keyBinding.bytes);
 604       let owned: ReturnType<typeof validateTransferOwnedMaterial>;
 605       try {
 606         owned = validateTransferOwnedMaterial(destinationBinding, after.value.context.log);
 607       } finally {
 608         wipeDecodedBytes(destinationBinding);
 609       }
 610       if (!owned.ok) throw new TypeError(`Destination material: ${owned.error.code}`);
 611       for (const seat of owned.value.seats) {
 612         seat.signingKey.fill(0);
 613         seat.master.fill(0);
 614       }
 615       const approved = after.value.context.log.transfer?.authorizations.find(
 616         (item) => item.entry.seq === authorization.seq && item.entry.hash === authorization.hash,
 617       );
 618       const destinationSeat = approved?.statement.seat;
 619       if (destinationSeat === undefined)
 620         throw new TypeError('Certified destination seat is missing');
 621       const fresh = createConsensusState(after.value.context, destinationSeat);
 622       if (!fresh.ok) throw new TypeError(`Fresh transfer safety: ${fresh.error.code}`);
 623       const nextConsensus = encodeRecord(
 624         {
 625           height: options.activation.entry.seq + 1,
 626           revision: 0,
 627           safety: canonicalEncode(fresh.value),
 628         },
 629         consensusRecordSchema,
 630         this.#maxRecordBytes,
 631       );
 632       const oldBinding = options.expectedActive?.bindingBytes;
 633       if (oldBinding) {
 634         const historical = historicalOldMaterialContext(
 635           staged.genesis,
 636           staged.entries,
 637           before.value.context.log.transfer,
 638           staged.authorization,
 639           options.engine,
 640           options.policy,
 641         );
 642         const retiredBinding = canonicalDecode(oldBinding);
 643         let old: ReturnType<typeof validateRetiredTransferBinding>;
 644         try {
 645           old = validateRetiredTransferBinding(
 646             retiredBinding,
 647             historical,
 648             before.value.context.log,
 649           );
 650         } finally {
 651           wipeDecodedBytes(retiredBinding);
 652         }
 653         if (!old.ok) throw new TypeError(`Retired material: ${old.error.code}`);
 654         for (const seat of old.value.seats) {
 655           seat.signingKey.fill(0);
 656           seat.master.fill(0);
 657         }
 658         if (
 659           old.value.devicePeer !== owned.value.devicePeer ||
 660           old.value.humanSeat !== owned.value.humanSeat ||
 661           !approved ||
 662           old.value.seats.find((seat) => seat.seat === approved.statement.seat)?.peerId !==
 663             oldMaterialKey(approved, before.value.context.log.transfer)
 664         )
 665           throw new TypeError('Existing binding belongs to a different device or seat');
 666       }
 667       storedNewBinding = await this.#vault.encode(keyBinding.recordKey, keyBinding.bytes);
 668       if (oldBinding) {
 669         const oldStore = this.#newByteStore();
 670         try {
 671           const pinned = await oldStore.loadPinned(keyBinding.recordKey);
 672           if (!pinned) throw new TypeError('Existing active binding is missing');
 673           try {
 674             if (!equalBytes(pinned.plain, oldBinding))
 675               throw new TypeError('Existing active binding differs from the expected controller');
 676             storedOldBinding = pinned.stored.slice();
 677           } finally {
 678             pinned.plain.fill(0);
 679             pinned.stored.fill(0);
 680           }
 681         } finally {
 682           await oldStore.close();
 683         }
 684       }
 685       const database = await this.#database();
 686       const transaction = strictWriteTransaction(database, [
 687         GAME_STORE,
 688         ENTRY_STORE,
 689         CONSENSUS_STORE,
 690         DELETED_GAME_STORE,
 691         BYTE_STORE,
 692         VAULT_STORE,
 693       ]);
 694       let transactionStage: Uint8Array | undefined;
 695       let transactionCheck: Uint8Array | undefined;
 696       try {
 697         await this.#vault.assertGeneration(transaction.objectStore(VAULT_STORE));
 698         await assertOnlineGameNotDeleted(transaction, this.#gameId);
 699         const bytes = transaction.objectStore(BYTE_STORE);
 700         const finalKey = transferImportFinalKey(staged);
 701         const priorFinal = await bytes.get(finalKey);
 702         if (priorFinal !== undefined) {
 703           if (priorFinal instanceof Uint8Array) priorFinal.fill(0);
 704           throw new TypeError('Transfer authorization was already finalized locally');
 705         }
 706         transactionStage = await bytes.get(options.stageKey);
 707         transactionCheck = await bytes.get(readinessKey(options.stageKey));
 708         const stageMatches = Boolean(
 709           transactionStage && storedStage && equalBytes(transactionStage, storedStage),
 710         );
 711         const checkMatches = Boolean(
 712           transactionCheck && storedReadiness && equalBytes(transactionCheck, storedReadiness),
 713         );
 714         if (!stageMatches || !checkMatches)
 715           throw new TypeError('Transfer import changed during promotion');
 716         const games = transaction.objectStore(GAME_STORE);
 717         const entries = transaction.objectStore(ENTRY_STORE);
 718         const consensus = transaction.objectStore(CONSENSUS_STORE);
 719         const existingGenesis = await games.get(this.#gameId);
 720         const existingSafety = await consensus.get(this.#gameId);
 721         const existingBinding = await bytes.get(keyBinding.recordKey);
 722         const bindingMatches = Boolean(
 723           existingBinding &&
 724           options.expectedActive &&
 725           storedOldBinding &&
 726           equalBytes(existingBinding, storedOldBinding),
 727         );
 728         existingBinding?.fill(0);
 729         const range = IDBKeyRange.bound([this.#gameId, 0], [this.#gameId, Number.MAX_SAFE_INTEGER]);
 730         const existingKeys = await entries.getAllKeys(range);
 731         const existingEntries = await entries.getAll(range);
 732         if (options.expectedActive === null) {
 733           if (
 734             existingGenesis !== undefined ||
 735             existingSafety !== undefined ||
 736             existingBinding !== undefined ||
 737             existingKeys.length !== 0
 738           )
 739             throw new TypeError('Fresh destination already has active or partial journal state');
 740         } else {
 741           const expected = options.expectedActive;
 742           if (
 743             existingGenesis === undefined ||
 744             existingSafety === undefined ||
 745             !bindingMatches ||
 746             !equalBytes(existingGenesis, canonicalEncode(staged.genesis)) ||
 747             expected.head.seq !== existingKeys.length ||
 748             expected.head.seq > options.activation.entry.seq
 749           )
 750             throw new TypeError('Existing active journal binding or head changed');
 751           const oldSafety = decodeRecord(
 752             existingSafety,
 753             consensusRecordSchema,
 754             this.#maxRecordBytes,
 755           );
 756           if (oldSafety.height !== existingKeys.length + 1)
 757             throw new TypeError('Existing active journal safety is incomplete');
 758           if (existingKeys.length === options.activation.entry.seq) {
 759             const retiredKey = oldMaterialKey(approved, before.value.context.log.transfer);
 760             const markerBytes = canonicalDecode(oldSafety.safety);
 761             try {
 762               const marker = restoreRetiredSafety(
 763                 markerBytes,
 764                 after.value.context,
 765                 destinationSeat,
 766                 retiredKey,
 767               );
 768               if (!marker.ok)
 769                 throw new TypeError(`Existing controller was not retired: ${marker.error.code}`);
 770             } finally {
 771               wipeDecodedBytes(markerBytes);
 772             }
 773           }
 774           const oldHead =
 775             existingKeys.length === 0
 776               ? staged.genesis
 777               : decodeRecord(existingEntries.at(-1), certifiedEntrySchema, this.#maxRecordBytes)
 778                   .entry;
 779           if (entryHash(oldHead) !== expected.head.hash)
 780             throw new TypeError('Existing active journal head is stale');
 781           for (const [index, stored] of existingEntries.entries()) {
 782             const key = existingKeys[index];
 783             if (
 784               !Array.isArray(key) ||
 785               key[0] !== this.#gameId ||
 786               key[1] !== index + 1 ||
 787               !equalBytes(stored, canonicalEncode(fullEntries[index]))
 788             )
 789               throw new TypeError('Existing active journal conflicts with certified import');
 790           }
 791         }
 792         if (existingGenesis === undefined) {
 793           const genesisBytes = encodeRecord(staged.genesis, logEntrySchema, this.#maxRecordBytes);
 794           try {
 795             await games.add(genesisBytes, this.#gameId);
 796           } finally {
 797             genesisBytes.fill(0);
 798           }
 799         }
 800         for (const [offset, entry] of fullEntries.slice(existingKeys.length).entries()) {
 801           const encoded = encodeRecord(entry, certifiedEntrySchema, this.#maxRecordBytes);
 802           try {
 803             // Retain canonical entry order and wipe each staged record after its IDB request.
 804             // eslint-disable-next-line no-await-in-loop
 805             await entries.add(encoded, [this.#gameId, existingKeys.length + offset + 1]);
 806           } finally {
 807             encoded.fill(0);
 808           }
 809         }
 810         await consensus.put(nextConsensus, this.#gameId);
 811         const bindingCopy = storedNewBinding.slice();
 812         try {
 813           await bytes.put(bindingCopy, keyBinding.recordKey);
 814         } finally {
 815           bindingCopy.fill(0);
 816         }
 817         const marker = canonicalEncode({
 818           outcome: 'promoted',
 819           authorization: staged.authorization,
 820           activation: {
 821             seq: options.activation.entry.seq,
 822             hash: entryHash(options.activation.entry),
 823           },
 824         });
 825         try {
```

Lines 830-900:
```ts
 830         await deleteAuthorizationStages(bytes, staged.gameId, staged.authorization.hash);
 831         await transaction.done;
 832         return true;
 833       } catch (error) {
 834         try {
 835           transaction.abort();
 836         } catch {
 837           // The transaction may already have aborted after a failed request.
 838         }
 839         await transaction.done.catch(() => undefined);
 840         throw error;
 841       } finally {
 842         transactionStage?.fill(0);
 843         transactionCheck?.fill(0);
 844       }
 845     } finally {
 846       if (staged) wipeDecodedBytes(staged);
 847       storedStage?.fill(0);
 848       storedReadiness?.fill(0);
 849       storedOldBinding?.fill(0);
 850       storedNewBinding?.fill(0);
 851       await stagedStore.close();
 852     }
 853   }
 854 
 855   close(): Promise<void> {
 856     if (this.#closePromise) return this.#closePromise;
 857     this.#closed = true;
 858     this.#closePromise = this.#closeAfterOperations();
 859     return this.#closePromise;
 860   }
 861 
 862   async #closeAfterOperations(): Promise<void> {
 863     try {
 864       if (this.#activeOperations > 0) {
 865         await new Promise<void>((resolve) => {
 866           this.#drainOperations = resolve;
 867         });
 868       }
 869       const pending = this.#databasePromise;
 870       this.#databasePromise = null;
 871       if (pending) (await pending).close();
 872     } finally {
 873       this.#keyBinding?.bytes.fill(0);
 874       this.#storedBinding?.fill(0);
 875       if (!this.#vaultOwner) this.#vault.close();
 876     }
 877   }
 878 
 879   async #acceptBinding(stored: Uint8Array | undefined): Promise<void> {
 880     const binding = this.#keyBinding;
 881     if (!binding || !stored)
 882       throw new TypeError('Journal voting-key binding is missing or mismatched');
 883     const plain = await this.#vault.decode(binding.recordKey, stored);
 884     try {
 885       if (!equalBytes(plain, binding.bytes))
 886         throw new TypeError('Journal voting-key binding is missing or mismatched');
 887       this.#storedBinding?.fill(0);
 888       this.#storedBinding = stored.slice();
 889     } finally {
 890       plain.fill(0);
 891     }
 892   }
 893 
 894   async #captureBinding(): Promise<Uint8Array | null> {
 895     const binding = this.#keyBinding;
 896     if (!binding) return null;
 897     if (this.#storedBinding) return this.#storedBinding.slice();
 898     const store = this.#newByteStore();
 899     try {
 900       const pinned = await store.loadPinned(binding.recordKey);
```

## packages/storage/src/transfer-import-store.ts

Lines 1-455:
```ts
   1 import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
   2 import {
   3   certifiedEntrySchema,
   4   entryHash,
   5   logEntrySchema,
   6   replayCertifiedPrefix,
   7   transferActivationStatementSchema,
   8   validatePendingTransferMaterial,
   9 } from '@cp2p/protocol';
  10 import type { CertifiedEntry, LogEntry, ReplayPolicy } from '@cp2p/protocol';
  11 import * as v from 'valibot';
  12 import {
  13   BYTE_STORE,
  14   DELETED_GAME_STORE,
  15   MAX_RECORD_BYTES,
  16   openDatabase,
  17   strictWriteTransaction,
  18   VAULT_STORE,
  19 } from './database.js';
  20 import { assertOnlineGameNotDeleted } from './online-game-deletion.js';
  21 import { IndexedDbByteStore } from './indexed-db-byte-store.js';
  22 
  23 const hashSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));
  24 const peerSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));
  25 const refSchema = v.strictObject({
  26   seq: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER)),
  27   hash: hashSchema,
  28 });
  29 const bytesSchema = v.custom<Uint8Array>((value) => value instanceof Uint8Array);
  30 const stageSchema = v.strictObject({
  31   protocol: v.literal('seat-transfer-import-v1'),
  32   gameId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,128}$/)),
  33   authorization: refSchema,
  34   destinationGameKey: peerSchema,
  35   head: refSchema,
  36   bindingBytes: bytesSchema,
  37   sealedPackage: bytesSchema,
  38   privateReplayBytes: bytesSchema,
  39   genesis: logEntrySchema,
  40   entries: v.array(certifiedEntrySchema),
  41 });
  42 const readinessSchema = v.strictObject({
  43   protocol: v.literal('seat-transfer-readiness-v1'),
  44   statement: transferActivationStatementSchema,
  45   destinationCheck: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{86}$/)),
  46   replacementChecks: v.pipe(
  47     v.array(
  48       v.strictObject({
  49         seat: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5)),
  50         sig: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{86}$/)),
  51       }),
  52     ),
  53     v.maxLength(6),
  54   ),
  55 });
  56 const outcomeSchema = v.variant('outcome', [
  57   v.strictObject({
  58     outcome: v.literal('cancelled'),
  59     authorization: refSchema,
  60   }),
  61   v.strictObject({
  62     outcome: v.literal('promoted'),
  63     authorization: refSchema,
  64     activation: refSchema,
  65   }),
  66 ]);
  67 
  68 export type TransferImportRecord = v.InferOutput<typeof stageSchema>;
  69 export type TransferReadinessRecord = v.InferOutput<typeof readinessSchema>;
  70 export type TransferImportOutcome =
  71   | { readonly kind: 'missing' }
  72   | { readonly kind: 'cancelled' }
  73   | {
  74       readonly kind: 'promoted';
  75       readonly activation: { readonly seq: number; readonly hash: string };
  76     };
  77 export type TransferReplayEngine = Parameters<typeof replayCertifiedPrefix>[2];
  78 export interface TransferImportInput {
  79   readonly gameId: string;
  80   readonly authorization: { readonly seq: number; readonly hash: string };
  81   readonly destinationGameKey: string;
  82   readonly bindingBytes: Uint8Array;
  83   readonly sealedPackage: Uint8Array;
  84   readonly privateReplayBytes: Uint8Array;
  85   readonly genesis: LogEntry;
  86   readonly entries: readonly CertifiedEntry[];
  87 }
  88 
  89 /** An immutable private import. Its presence never gives the destination voting authority. */
  90 export class TransferImportStore {
  91   readonly #bytes: IndexedDbByteStore;
  92 
  93   constructor(bytes = new IndexedDbByteStore()) {
  94     this.#bytes = bytes;
  95   }
  96 
  97   async stage(
  98     value: TransferImportInput,
  99     engine: TransferReplayEngine,
 100     policy: ReplayPolicy,
 101   ): Promise<string> {
 102     assertBoundedStageInput(value, this.#bytes.maxRecordBytes);
 103     const entries = value.entries;
 104     const last = entries.at(-1)?.entry ?? value.genesis;
 105     const checked = v.parse(stageSchema, {
 106       ...value,
 107       protocol: 'seat-transfer-import-v1',
 108       head: { seq: last.seq, hash: entryHash(last) },
 109     });
 110     const bytes = canonicalEncode(checked);
 111     if (bytes.byteLength > this.#bytes.maxRecordBytes) {
 112       bytes.fill(0);
 113       throw new RangeError('Transfer import exceeds the durable record limit');
 114     }
 115     try {
 116       if (
 117         checked.genesis.payload.kind !== 'genesis' ||
 118         checked.genesis.payload.genesis.gameId !== checked.gameId
 119       )
 120         throw new TypeError('Transfer import genesis differs from its game');
 121       const replayed = replayCertifiedPrefix(checked.genesis, checked.entries, engine, policy);
 122       if (!replayed.ok) throw new TypeError(`Transfer import prefix: ${replayed.error.code}`);
 123       const transfer = replayed.value.context.log.transfer;
 124       const authorization = transfer?.authorizations.find(
 125         (item) =>
 126           item.entry.seq === checked.authorization.seq &&
 127           item.entry.hash === checked.authorization.hash,
 128       );
 129       if (
 130         transfer?.pending?.seq !== checked.authorization.seq ||
 131         transfer.pending.hash !== checked.authorization.hash ||
 132         !authorization ||
 133         authorization.statement.destination.gamePeer !== checked.destinationGameKey ||
 134         replayed.value.context.log.head.seq !== checked.head.seq ||
 135         entryHash(replayed.value.context.log.head) !== checked.head.hash
 136       )
 137         throw new TypeError('Transfer import is not pinned to the certified pending authorization');
 138       const binding = canonicalDecode(checked.bindingBytes);
 139       let material: ReturnType<typeof validatePendingTransferMaterial>;
 140       try {
 141         material = validatePendingTransferMaterial(
 142           binding,
 143           replayed.value.context.log,
 144           checked.authorization,
 145         );
 146       } finally {
 147         wipeByteArrays(binding);
 148       }
 149       if (!material.ok) throw new TypeError(`Transfer import material: ${material.error.code}`);
 150       for (const seat of material.value.seats) {
 151         seat.signingKey.fill(0);
 152         seat.master.fill(0);
 153       }
 154       const key = transferImportKey(checked);
 155       const access = this.#bytes.recordAccess();
 156       const prior = await this.#bytes.loadPinned(key);
 157       let stored: Uint8Array | undefined;
 158       try {
 159         if (prior && !equalBytes(prior.plain, bytes))
 160           throw new TypeError('Transfer import already exists with different bytes');
 161         stored = await access.encode(key, bytes);
 162         const database = await openDatabase(
 163           () => undefined,
 164           () => undefined,
 165         );
 166         try {
 167           const transaction = strictWriteTransaction(database, [
 168             BYTE_STORE,
 169             DELETED_GAME_STORE,
 170             VAULT_STORE,
 171           ]);
 172           try {
 173             await access.assertGeneration(transaction.objectStore(VAULT_STORE));
 174             await assertOnlineGameNotDeleted(transaction, checked.gameId);
 175             const store = transaction.objectStore(BYTE_STORE);
 176             const final = await store.get(transferImportFinalKey(checked));
 177             if (final !== undefined) {
 178               final.fill(0);
 179               throw new TypeError('Transfer authorization is already finalized locally');
 180             }
 181             const existing = await store.get(key);
 182             try {
 183               if (existing === undefined && !prior) await store.add(stored, key);
 184               else if (!existing || !prior || !equalBytes(existing, prior.stored))
 185                 throw new TypeError('Transfer import already exists with different bytes');
 186             } finally {
 187               existing?.fill(0);
 188             }
 189             await transaction.done;
 190           } catch (error) {
 191             transaction.abort();
 192             await transaction.done.catch(() => undefined);
 193             throw error;
 194           }
 195         } finally {
 196           database.close();
 197         }
 198       } finally {
 199         prior?.plain.fill(0);
 200         prior?.stored.fill(0);
 201         stored?.fill(0);
 202       }
 203       return key;
 204     } finally {
 205       bytes.fill(0);
 206     }
 207   }
 208 
 209   async load(key: string): Promise<TransferImportRecord | null> {
 210     const pinned = await this.loadPinned(key);
 211     if (!pinned) return null;
 212     pinned.stored.fill(0);
 213     return pinned.record;
 214   }
 215 
 216   /** Exact ciphertext is retained for a later stage/readiness promotion CAS. */
 217   async loadPinned(
 218     key: string,
 219   ): Promise<{ record: TransferImportRecord; stored: Uint8Array } | null> {
 220     const pinned = await this.#bytes.loadPinned(key);
 221     if (!pinned) return null;
 222     const bytes = pinned.plain;
 223     let decoded: unknown;
 224     let accepted = false;
 225     try {
 226       decoded = canonicalDecode(bytes);
 227       const parsed = v.parse(stageSchema, decoded);
 228       const canonical = canonicalEncode(parsed);
 229       const exact = equalBytes(canonical, bytes);
 230       canonical.fill(0);
 231       if (!exact || transferImportKey(parsed) !== key) {
 232         wipeByteArrays(parsed);
 233         throw new TypeError('Stored transfer import is noncanonical or misplaced');
 234       }
 235       accepted = true;
 236       return { record: parsed, stored: pinned.stored };
 237     } finally {
 238       if (!accepted) wipeByteArrays(decoded);
 239       if (!accepted) pinned.stored.fill(0);
 240       bytes.fill(0);
 241     }
 242   }
 243 
 244   /** Prepared only after the full import is durable; retries use the exact same bytes. */
 245   async saveReadiness(key: string, readiness: TransferReadinessRecord): Promise<void> {
 246     const pinnedStage = await this.loadPinned(key);
 247     if (!pinnedStage) throw new TypeError('Transfer import is absent');
 248     const stage = pinnedStage.record;
 249     try {
 250       const checked = v.parse(readinessSchema, readiness);
 251       if (
 252         checked.statement.authorization.seq !== stage.authorization.seq ||
 253         checked.statement.authorization.hash !== stage.authorization.hash ||
 254         checked.statement.parent.seq !== stage.head.seq ||
 255         checked.statement.parent.hash !== stage.head.hash ||
 256         checked.statement.destinationGame !== stage.destinationGameKey
 257       )
 258         throw new TypeError('Readiness does not bind the exact staged parent and destination');
 259       const bytes = canonicalEncode(checked);
 260       try {
 261         if (bytes.byteLength > this.#bytes.maxRecordBytes)
 262           throw new RangeError('Transfer readiness exceeds the durable record limit');
 263         const access = this.#bytes.recordAccess();
 264         const slot = readinessKey(key);
 265         const prior = await this.#bytes.loadPinned(slot);
 266         let stored: Uint8Array | undefined;
 267         try {
 268           if (prior && !equalBytes(prior.plain, bytes))
 269             throw new TypeError('A different readiness packet is already durable');
 270           stored = await access.encode(slot, bytes);
 271           const database = await openDatabase(
 272             () => undefined,
 273             () => undefined,
 274           );
 275           try {
 276             const transaction = strictWriteTransaction(database, [
 277               BYTE_STORE,
 278               DELETED_GAME_STORE,
 279               VAULT_STORE,
 280             ]);
 281             try {
 282               await access.assertGeneration(transaction.objectStore(VAULT_STORE));
 283               await assertOnlineGameNotDeleted(transaction, stage.gameId);
 284               const store = transaction.objectStore(BYTE_STORE);
 285               const final = await store.get(transferImportFinalKey(stage));
 286               if (final !== undefined) {
 287                 final.fill(0);
 288                 throw new TypeError('Transfer authorization is already finalized locally');
 289               }
 290               const storedStage = await store.get(key);
 291               try {
 292                 if (!storedStage || !equalBytes(storedStage, pinnedStage.stored))
 293                   throw new TypeError('Transfer import changed before readiness');
 294               } finally {
 295                 storedStage?.fill(0);
 296               }
 297               const previous = await store.get(slot);
 298               try {
 299                 if (previous === undefined && !prior) await store.add(stored, slot);
 300                 else if (!previous || !prior || !equalBytes(previous, prior.stored))
 301                   throw new TypeError('A different readiness packet is already durable');
 302               } finally {
 303                 previous?.fill(0);
 304               }
 305               await transaction.done;
 306             } catch (error) {
 307               transaction.abort();
 308               await transaction.done.catch(() => undefined);
 309               throw error;
 310             }
 311           } finally {
 312             database.close();
 313           }
 314         } finally {
 315           prior?.plain.fill(0);
 316           prior?.stored.fill(0);
 317           stored?.fill(0);
 318         }
 319       } finally {
 320         bytes.fill(0);
 321       }
 322     } finally {
 323       wipeByteArrays(stage);
 324       pinnedStage.stored.fill(0);
 325     }
 326   }
 327 
 328   async loadReadiness(key: string): Promise<TransferReadinessRecord | null> {
 329     const pinned = await this.loadReadinessPinned(key);
 330     if (!pinned) return null;
 331     pinned.stored.fill(0);
 332     return pinned.record;
 333   }
 334 
 335   async loadReadinessPinned(
 336     key: string,
 337   ): Promise<{ record: TransferReadinessRecord; stored: Uint8Array } | null> {
 338     const pinned = await this.#bytes.loadPinned(readinessKey(key));
 339     if (!pinned) return null;
 340     const bytes = pinned.plain;
 341     let accepted = false;
 342     try {
 343       const parsed = v.parse(readinessSchema, canonicalDecode(bytes));
 344       const canonical = canonicalEncode(parsed);
 345       try {
 346         if (!equalBytes(canonical, bytes))
 347           throw new TypeError('Stored transfer readiness is noncanonical');
 348         accepted = true;
 349         return { record: parsed, stored: pinned.stored };
 350       } finally {
 351         canonical.fill(0);
 352       }
 353     } finally {
 354       // The record owns only its parsed immutable strings; no private byte fields.
 355       bytes.fill(0);
 356       if (!accepted) pinned.stored.fill(0);
 357     }
 358   }
 359 
 360   /**
 361    * Read the durable outcome marker only. Callers must match it against replayed
 362    * certified history and the active journal before treating it as an outcome.
 363    */
 364   async readOutcome(
 365     gameId: string,
 366     authorization: { readonly seq: number; readonly hash: string },
 367   ): Promise<TransferImportOutcome> {
 368     const scope = v.parse(
 369       v.strictObject({
 370         gameId: v.pipe(v.string(), v.minLength(1), v.maxLength(128), v.regex(/^[A-Za-z0-9_-]+$/)),
 371         authorization: refSchema,
 372       }),
 373       { gameId, authorization },
 374     );
 375     const key = transferImportFinalKey(scope);
 376     const bytes = await this.#bytes.load(key);
 377     if (!bytes) return { kind: 'missing' };
 378     try {
 379       if (bytes.byteLength > 1024)
 380         throw new RangeError('Stored transfer outcome exceeds its record limit');
 381       const decoded: unknown = canonicalDecode(bytes);
 382       const parsed = v.parse(outcomeSchema, decoded);
 383       const canonical = canonicalEncode(parsed);
 384       try {
 385         if (!equalBytes(canonical, bytes))
 386           throw new TypeError('Stored transfer outcome is noncanonical');
 387       } finally {
 388         canonical.fill(0);
 389       }
 390       if (
 391         parsed.authorization.seq !== scope.authorization.seq ||
 392         parsed.authorization.hash !== scope.authorization.hash
 393       )
 394         throw new TypeError('Stored transfer outcome belongs to another authorization');
 395       return parsed.outcome === 'cancelled'
 396         ? { kind: 'cancelled' }
 397         : { kind: 'promoted', activation: { ...parsed.activation } };
 398     } finally {
 399       bytes.fill(0);
 400     }
 401   }
 402 
 403   /** A certified cancellation closes the authorization and erases every staged parent. */
 404   async cancelCertified(input: {
 405     gameId: string;
 406     authorization: { seq: number; hash: string };
 407     genesis: LogEntry;
 408     entries: readonly CertifiedEntry[];
 409     engine: TransferReplayEngine;
 410     policy: ReplayPolicy;
 411   }): Promise<void> {
 412     assertBoundedStageInput({ genesis: input.genesis, entries: input.entries });
 413     const replayed = replayCertifiedPrefix(
 414       input.genesis,
 415       input.entries,
 416       input.engine,
 417       input.policy,
 418     );
 419     if (!replayed.ok) throw new TypeError(`Transfer cancellation prefix: ${replayed.error.code}`);
 420     const transfer = replayed.value.context.log.transfer;
 421     if (
 422       input.genesis.payload.kind !== 'genesis' ||
 423       input.genesis.payload.genesis.gameId !== input.gameId ||
 424       !transfer?.completed.some(
 425         (item) =>
 426           item.outcome === 'cancelled' &&
 427           item.authorization.seq === input.authorization.seq &&
 428           item.authorization.hash === input.authorization.hash,
 429       )
 430     )
 431       throw new TypeError('Transfer authorization has no certified cancellation');
 432     const finalKey = transferImportFinalKey(input);
 433     const marker = canonicalEncode({ outcome: 'cancelled', authorization: input.authorization });
 434     if (marker.byteLength > this.#bytes.maxRecordBytes) {
 435       marker.fill(0);
 436       throw new RangeError('Transfer outcome exceeds the durable record limit');
 437     }
 438     await this.#bytes.recordAccess().pin();
 439     const database = await openDatabase(
 440       () => undefined,
 441       () => undefined,
 442     );
 443     try {
 444       const transaction = strictWriteTransaction(database, [
 445         BYTE_STORE,
 446         DELETED_GAME_STORE,
 447         VAULT_STORE,
 448       ]);
 449       try {
 450         await this.#bytes.recordAccess().assertGeneration(transaction.objectStore(VAULT_STORE));
 451         await assertOnlineGameNotDeleted(transaction, input.gameId);
 452         const store = transaction.objectStore(BYTE_STORE);
 453         const existing = await store.get(finalKey);
 454         try {
 455           if (existing === undefined) await store.add(marker, finalKey);
```

## packages/storage/src/online-game-deletion.ts

Lines 1-275:
```ts
   1 import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
   2 import { genesisDigest, genesisSchema, logEntrySchema } from '@cp2p/protocol';
   3 import * as v from 'valibot';
   4 import type { IDBPTransaction } from 'idb';
   5 import { IndexedDbByteStore } from './indexed-db-byte-store.js';
   6 import type { CP2PDatabase } from './database.js';
   7 import {
   8   BYTE_STORE,
   9   CONSENSUS_STORE,
  10   DELETED_GAME_STORE,
  11   ENTRY_STORE,
  12   GAME_STORE,
  13   SNAPSHOT_STORE,
  14   VAULT_STORE,
  15   openDatabase,
  16   strictWriteTransaction,
  17 } from './database.js';
  18 import { acquireActiveGameWriterLease } from './game-writer.js';
  19 import type { GameWriterLockManager } from './game-writer.js';
  20 import { withExclusiveVault } from './local-vault.js';
  21 import type { VaultRecordAccess } from './local-vault.js';
  22 
  23 const GAME_ID = /^[A-Za-z0-9_-]{22}$/;
  24 const DIGEST = /^[A-Za-z0-9_-]{43}$/;
  25 const TOMBSTONE_PROTOCOL = 'online-game-deletion-v1';
  26 const CATALOGUE_KEY = 'online-games/catalogue-v1';
  27 const TOMBSTONE_KEY_PREFIX = 'online-game-deleted/';
  28 const tombstoneSchema = v.strictObject({
  29   protocol: v.literal(TOMBSTONE_PROTOCOL),
  30   gameId: v.pipe(v.string(), v.regex(GAME_ID)),
  31   genesisDigest: v.pipe(v.string(), v.regex(DIGEST)),
  32   deletedAt: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  33 });
  34 const startSchema = v.strictObject({
  35   protocol: v.literal('online-browser-game-v1'),
  36   invite: v.strictObject({
  37     roomId: v.string(),
  38     hostPeer: v.string(),
  39     serverUrl: v.string(),
  40   }),
  41   agreement: v.unknown(),
  42   result: v.strictObject({
  43     entry: logEntrySchema,
  44     genesis: genesisSchema,
  45     transcripts: v.unknown(),
  46     bindings: v.unknown(),
  47   }),
  48 });
  49 const catalogueSchema = v.strictObject({
  50   protocol: v.literal('online-games-catalogue-v1'),
  51   gameIds: v.pipe(v.array(v.pipe(v.string(), v.regex(GAME_ID))), v.maxLength(128)),
  52 });
  53 type DeletionTransaction = IDBPTransaction<
  54   CP2PDatabase,
  55   readonly ['deletedGames', 'games', 'entries', 'consensus', 'bytes', 'snapshots', 'vault'],
  56   'readwrite'
  57 >;
  58 type CP2PStoreName =
  59   | 'bytes'
  60   | 'games'
  61   | 'entries'
  62   | 'consensus'
  63   | 'deletedGames'
  64   | 'snapshots'
  65   | 'vault';
  66 
  67 export interface OnlineGameTombstone {
  68   readonly protocol: typeof TOMBSTONE_PROTOCOL;
  69   readonly gameId: string;
  70   readonly genesisDigest: string;
  71   readonly deletedAt: number;
  72 }
  73 
  74 export function onlineGameTombstoneKey(gameId: string): string {
  75   validateGameId(gameId);
  76   return `${TOMBSTONE_KEY_PREFIX}${gameId}`;
  77 }
  78 
  79 export function decodeOnlineGameTombstone(bytes: Uint8Array, gameId: string): OnlineGameTombstone {
  80   validateGameId(gameId);
  81   return parseTombstone(bytes, gameId);
  82 }
  83 
  84 export interface DeleteOnlineGameDataOptions {
  85   /** Test seam. Production uses the same-origin Web Locks manager. */
  86   readonly lockManager?: GameWriterLockManager;
  87   readonly now?: () => number;
  88 }
  89 
  90 export type DeleteOnlineGameDataResult = 'deleted' | 'already-deleted' | 'busy';
  91 
  92 /**
  93  * Read the permanent local non-revival marker. The marker contains no keys and
  94  * is intentionally retained after game data is removed.
  95  */
  96 export async function readOnlineGameTombstone(gameId: string): Promise<OnlineGameTombstone | null> {
  97   validateGameId(gameId);
  98   const database = await openDatabase(
  99     () => undefined,
 100     () => undefined,
 101   );
 102   try {
 103     const bytes = await database.get(DELETED_GAME_STORE, gameId);
 104     if (!bytes) return null;
 105     return parseTombstone(bytes, gameId);
 106   } finally {
 107     database.close();
 108   }
 109 }
 110 
 111 /** Check deletion in the caller's journal transaction to close check/write races. */
 112 export async function assertOnlineGameNotDeleted<
 113   Stores extends readonly CP2PStoreName[],
 114   Mode extends 'readonly' | 'readwrite',
 115 >(transaction: IDBPTransaction<CP2PDatabase, Stores, Mode>, gameId: string): Promise<void> {
 116   const bytes = await transaction.objectStore(DELETED_GAME_STORE).get(gameId);
 117   if (bytes === undefined) return;
 118   try {
 119     parseTombstone(bytes, gameId);
 120   } finally {
 121     bytes.fill(0);
 122   }
 123   throw new Error('Online game was deleted locally');
 124 }
 125 
 126 /**
 127  * Locally forget one game while retaining an irreversible gameId tombstone.
 128  * The full start record should be cryptographically validated by the app before
 129  * calling this storage transaction.
 130  */
 131 export async function deleteOnlineGameData(
 132   gameId: string,
 133   expectedGenesisDigest: string,
 134   options: DeleteOnlineGameDataOptions = {},
 135 ): Promise<DeleteOnlineGameDataResult> {
 136   validateGameId(gameId);
 137   if (!DIGEST.test(expectedGenesisDigest)) throw new TypeError('Invalid online game digest');
 138   return withExclusiveVault(
 139     () => deleteUnderVaultLock(gameId, expectedGenesisDigest, options),
 140     options.lockManager,
 141   );
 142 }
 143 
 144 async function deleteUnderVaultLock(
 145   gameId: string,
 146   expectedGenesisDigest: string,
 147   options: DeleteOnlineGameDataOptions,
 148 ): Promise<DeleteOnlineGameDataResult> {
 149   const lease = await acquireActiveGameWriterLease(
 150     gameId,
 151     options.lockManager ? { lockManager: options.lockManager } : {},
 152   );
 153   if (!lease) return 'busy';
 154 
 155   const lockManager = options.lockManager;
 156   const byteStore = lockManager
 157     ? new IndexedDbByteStore({
 158         lockProvider: <T>(name: string, task: () => Promise<T>) =>
 159           lockManager
 160             .request<Promise<T>>(name, { mode: 'exclusive' }, () => task())
 161             .then((result) => result),
 162       })
 163     : new IndexedDbByteStore();
 164   try {
 165     return await byteStore.withCeremonyLock('online-games/catalogue-lock-v1', () =>
 166       lease.run(() =>
 167         deleteTransaction(
 168           gameId,
 169           expectedGenesisDigest,
 170           options.now?.() ?? Date.now(),
 171           byteStore.recordAccess(),
 172         ),
 173       ),
 174     );
 175   } finally {
 176     try {
 177       await lease.close();
 178     } finally {
 179       await byteStore.close();
 180     }
 181   }
 182 }
 183 
 184 async function deleteTransaction(
 185   gameId: string,
 186   expectedGenesisDigest: string,
 187   deletedAt: number,
 188   vault: VaultRecordAccess,
 189 ): Promise<DeleteOnlineGameDataResult> {
 190   if (!Number.isSafeInteger(deletedAt) || deletedAt < 0)
 191     throw new RangeError('Deletion time is invalid');
 192   await vault.pin();
 193   const database = await openDatabase(
 194     () => undefined,
 195     () => undefined,
 196   );
 197   const transaction = strictWriteTransaction(database, [
 198     DELETED_GAME_STORE,
 199     GAME_STORE,
 200     ENTRY_STORE,
 201     CONSENSUS_STORE,
 202     BYTE_STORE,
 203     SNAPSHOT_STORE,
 204     VAULT_STORE,
 205   ]);
 206   let markerBytes: Uint8Array | undefined;
 207   let startBytes: Uint8Array | undefined;
 208   let pointerBytes: Uint8Array | undefined;
 209   let genesisBytes: Uint8Array | undefined;
 210   let catalogueBytes: Uint8Array | undefined;
 211   try {
 212     const deletedStore = transaction.objectStore(DELETED_GAME_STORE);
 213     const bytes = transaction.objectStore(BYTE_STORE);
 214     markerBytes = await deletedStore.get(gameId);
 215     if (markerBytes) {
 216       const marker = parseTombstone(markerBytes, gameId);
 217       if (marker.genesisDigest !== expectedGenesisDigest)
 218         throw new TypeError('Deleted gameId is permanently bound to another genesis');
 219       const byteMarker = await bytes.get(onlineGameTombstoneKey(gameId));
 220       if (byteMarker === undefined)
 221         await bytes.add(markerBytes.slice(), onlineGameTombstoneKey(gameId));
 222       else {
 223         const parsedByteMarker = parseTombstone(byteMarker, gameId);
 224         byteMarker.fill(0);
 225         if (parsedByteMarker.genesisDigest !== expectedGenesisDigest)
 226           throw new Error('Deletion markers disagree; refusing to modify game data');
 227       }
 228       await transaction.done;
 229       return 'already-deleted';
 230     }
 231 
 232     const gameStore = transaction.objectStore(GAME_STORE);
 233     startBytes = await bytes.get(`online-game/${expectedGenesisDigest}/start`);
 234     pointerBytes = await bytes.get(`online-game/${gameId}/start-digest`);
 235     genesisBytes = await gameStore.get(gameId);
 236     const identifiers = verifyStoredGameIdentity(
 237       gameId,
 238       expectedGenesisDigest,
 239       startBytes,
 240       pointerBytes,
 241       genesisBytes,
 242     );
 243     catalogueBytes = await bytes.get(CATALOGUE_KEY);
 244     const marker = canonicalEncode({
 245       protocol: TOMBSTONE_PROTOCOL,
 246       gameId,
 247       genesisDigest: expectedGenesisDigest,
 248       deletedAt,
 249     } satisfies OnlineGameTombstone);
 250     const byteTombstoneKey = onlineGameTombstoneKey(gameId);
 251     const existingByteMarker = await bytes.get(byteTombstoneKey);
 252     if (existingByteMarker !== undefined) {
 253       const existing = parseTombstone(existingByteMarker, gameId);
 254       existingByteMarker.fill(0);
 255       if (existing.genesisDigest !== expectedGenesisDigest)
 256         throw new TypeError('Deleted gameId is permanently bound to another genesis');
 257       throw new Error('Deletion markers disagree; refusing to modify game data');
 258     }
 259     await deletedStore.add(marker, gameId);
 260     await bytes.add(marker.slice(), byteTombstoneKey);
 261 
 262     if (catalogueBytes) {
 263       const catalogue = v.parse(catalogueSchema, canonicalDecode(catalogueBytes));
 264       if (new Set(catalogue.gameIds).size !== catalogue.gameIds.length)
 265         throw new TypeError('Saved game catalogue contains duplicate identifiers');
 266       const gameIds = catalogue.gameIds.filter((id) => id !== gameId);
 267       if (gameIds.length !== catalogue.gameIds.length)
 268         await bytes.put(canonicalEncode({ protocol: catalogue.protocol, gameIds }), CATALOGUE_KEY);
 269     }
 270 
 271     await deleteJournalRecords(transaction, gameId);
 272     await deleteSnapshots(transaction, gameId);
 273     await deleteKnownByteRecords(transaction, gameId, expectedGenesisDigest, identifiers);
 274     await transaction.done;
 275     return 'deleted';
```

## packages/storage/src/local-vault.test.ts

Lines 1-267:
```ts
   1 import {
   2   IDBCursor,
   3   IDBDatabase,
   4   IDBFactory,
   5   IDBIndex,
   6   IDBKeyRange,
   7   IDBObjectStore,
   8   IDBRequest,
   9   IDBTransaction,
  10 } from 'fake-indexeddb';
  11 import { openDB } from 'idb';
  12 import { afterEach, expect, test, vi } from 'vitest';
  13 import { IndexedDbByteStore } from './indexed-db-byte-store.js';
  14 import { acquireVaultOwner, migrateLocalVault, VaultRecordAccess } from './local-vault.js';
  15 
  16 const identityKey = 'online-credentials/device-identity/v1';
  17 
  18 class TestLocks implements Pick<LockManager, 'request'> {
  19   #tail = Promise.resolve();
  20 
  21   request<T>(name: string, callback: LockGrantedCallback<T>): Promise<T>;
  22   request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T>;
  23   async request<T>(
  24     name: string,
  25     optionsOrCallback: LockOptions | LockGrantedCallback<T>,
  26     maybeCallback?: LockGrantedCallback<T>,
  27   ): Promise<T> {
  28     const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
  29     if (!callback) throw new Error('Missing lock callback');
  30     let release!: () => void;
  31     const done = new Promise<void>((resolve) => {
  32       release = resolve;
  33     });
  34     const before = this.#tail;
  35     this.#tail = done;
  36     await before;
  37     try {
  38       return await callback({ name, mode: 'exclusive' });
  39     } finally {
  40       release();
  41     }
  42   }
  43 }
  44 
  45 function installFactory(): void {
  46   vi.stubGlobal('indexedDB', new IDBFactory());
  47   for (const [name, value] of Object.entries({
  48     IDBCursor,
  49     IDBDatabase,
  50     IDBIndex,
  51     IDBKeyRange,
  52     IDBObjectStore,
  53     IDBRequest,
  54     IDBTransaction,
  55   }))
  56     vi.stubGlobal(name, value);
  57 }
  58 
  59 afterEach(() => vi.unstubAllGlobals());
  60 
  61 async function seed(): Promise<IndexedDbByteStore> {
  62   const store = new IndexedDbByteStore();
  63   expect(await store.putIfAbsent(identityKey, Uint8Array.of(1, 2, 3))).toBe(true);
  64   expect(await store.putIfAbsent('escrow-accepted/ceremony/0/1', Uint8Array.of(4, 5, 6))).toBe(
  65     true,
  66   );
  67   expect(await store.putIfAbsent('escrow-lifecycle/device-index-v1', Uint8Array.of(7))).toBe(true);
  68   return store;
  69 }
  70 
  71 test('enables the local vault without plaintext fallback, authenticates records, and rotates atomically', async () => {
  72   installFactory();
  73   const locks = new TestLocks();
  74   const old = await seed();
  75   await old.close();
  76   await migrateLocalVault({ newPassphrase: 'first passphrase', lockManager: locks });
  77   const database = await openDB('cp2p');
  78   const raw = await database.get('bytes', identityKey);
  79   expect(raw).toBeInstanceOf(Uint8Array);
  80   expect(raw).not.toEqual(Uint8Array.of(1, 2, 3));
  81   expect(await database.get('bytes', 'escrow-lifecycle/device-index-v1')).toEqual(Uint8Array.of(7));
  82   database.close();
  83 
  84   await expect(new IndexedDbByteStore().load(identityKey)).rejects.toMatchObject({
  85     code: 'locked',
  86   });
  87   await expect(
  88     acquireVaultOwner({ passphrase: 'wrong vault passphrase', lockManager: locks }),
  89   ).rejects.toThrow(/invalid/);
  90   const owner = await acquireVaultOwner({ passphrase: 'first passphrase', lockManager: locks });
  91   const store = new IndexedDbByteStore({ vault: owner });
  92   expect(await store.load(identityKey)).toEqual(Uint8Array.of(1, 2, 3));
  93   const captured = await store.loadPinned(identityKey);
  94   expect(captured?.stored).toEqual(raw);
  95   captured?.plain.fill(0);
  96   captured?.stored.fill(0);
  97   expect(
  98     await store.compareAndSwap(
  99       'escrow-accepted/ceremony/0/1',
 100       Uint8Array.of(4, 5, 6),
 101       Uint8Array.of(9),
 102     ),
 103   ).toBe(true);
 104   const handoff = owner.handoff();
 105   expect(handoff?.key.extractable).toBe(false);
 106   await store.close();
 107   await owner.close();
 108 
 109   if (!handoff) throw new Error('Locked owner did not provide a worker key handoff');
 110   const worker = await acquireVaultOwner({ handoff, lockManager: locks });
 111   const workerStore = new IndexedDbByteStore({ vault: worker });
 112   expect(await workerStore.load('escrow-accepted/ceremony/0/1')).toEqual(Uint8Array.of(9));
 113   await workerStore.close();
 114   await worker.close();
 115 
 116   await migrateLocalVault({
 117     oldPassphrase: 'first passphrase',
 118     newPassphrase: 'second passphrase',
 119     lockManager: locks,
 120   });
 121   await expect(acquireVaultOwner({ handoff, lockManager: locks })).rejects.toThrow(/handoff/);
 122   await expect(
 123     acquireVaultOwner({ passphrase: 'first passphrase', lockManager: locks }),
 124   ).rejects.toThrow(/invalid/);
 125   const rotated = await acquireVaultOwner({ passphrase: 'second passphrase', lockManager: locks });
 126   const rotatedStore = new IndexedDbByteStore({ vault: rotated });
 127   expect(await rotatedStore.load('escrow-accepted/ceremony/0/1')).toEqual(Uint8Array.of(9));
 128   await rotatedStore.close();
 129   await rotated.close();
 130   await migrateLocalVault({ oldPassphrase: 'second passphrase', lockManager: locks });
 131   const clear = new IndexedDbByteStore();
 132   expect(await clear.load('escrow-accepted/ceremony/0/1')).toEqual(Uint8Array.of(9));
 133   await clear.close();
 134 });
 135 
 136 test('rejects enabling without an existing reserved device identity', async () => {
 137   installFactory();
 138   const store = new IndexedDbByteStore();
 139   await store.putIfAbsent('private/unrelated', Uint8Array.of(4));
 140   await store.close();
 141   await expect(
 142     migrateLocalVault({ newPassphrase: 'locked vault passphrase', lockManager: new TestLocks() }),
 143   ).rejects.toThrow(/identity/);
 144   const fresh = new IndexedDbByteStore();
 145   expect(await fresh.load('private/unrelated')).toEqual(Uint8Array.of(4));
 146   await fresh.close();
 147 });
 148 
 149 test('a deleted pinned identity is corruption and cannot be silently recreated', async () => {
 150   installFactory();
 151   const locks = new TestLocks();
 152   const initial = await seed();
 153   await initial.close();
 154   await migrateLocalVault({ newPassphrase: 'locked vault passphrase', lockManager: locks });
 155   const database = await openDB('cp2p');
 156   await database.delete('bytes', identityKey);
 157   database.close();
 158   const owner = await acquireVaultOwner({
 159     passphrase: 'locked vault passphrase',
 160     lockManager: locks,
 161   });
 162   const store = new IndexedDbByteStore({ vault: owner });
 163   await expect(store.load(identityKey)).rejects.toThrow(/Reserved device identity is missing/);
 164   await expect(store.putIfAbsent(identityKey, Uint8Array.of(1, 2, 3))).rejects.toThrow(
 165     /Reserved device identity is missing/,
 166   );
 167   await store.close();
 168   await owner.close();
 169 });
 170 
 171 test('an inserted key after migration scan aborts the whole mode change', async () => {
 172   installFactory();
 173   const initial = await seed();
 174   await initial.close();
 175   const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
 176   let inserted = false;
 177   const spy = vi
 178     .spyOn(crypto.subtle, 'encrypt')
 179     .mockImplementation(async (algorithm, key, data) => {
 180       const result = await encrypt(algorithm, key, data);
 181       if (!inserted) {
 182         inserted = true;
 183         const database = await openDB('cp2p');
 184         await database.put('bytes', Uint8Array.of(8), 'private/inserted-after-scan');
 185         database.close();
 186       }
 187       return result;
 188     });
 189   try {
 190     await expect(
 191       migrateLocalVault({ newPassphrase: 'locked vault passphrase', lockManager: new TestLocks() }),
 192     ).rejects.toThrow(/changed during migration/);
 193   } finally {
 194     spy.mockRestore();
 195   }
 196   const clear = new IndexedDbByteStore();
 197   expect(await clear.load(identityKey)).toEqual(Uint8Array.of(1, 2, 3));
 198   expect(await clear.load('private/inserted-after-scan')).toEqual(Uint8Array.of(8));
 199   await clear.close();
 200 });
 201 
 202 test('ciphertext is bound to the exact record key and a queued migration does not block owner work', async () => {
 203   installFactory();
 204   const locks = new TestLocks();
 205   const initial = await seed();
 206   await initial.close();
 207   await migrateLocalVault({ newPassphrase: 'locked vault passphrase', lockManager: locks });
 208   const owner = await acquireVaultOwner({
 209     passphrase: 'locked vault passphrase',
 210     lockManager: locks,
 211   });
 212   const store = new IndexedDbByteStore({ vault: owner });
 213   const migrating = migrateLocalVault({
 214     oldPassphrase: 'locked vault passphrase',
 215     newPassphrase: 'new vault passphrase',
 216     lockManager: locks,
 217   });
 218   // The owner already holds its shared lock. Its byte-store operation must not reacquire it.
 219   expect(await store.load(identityKey)).toEqual(Uint8Array.of(1, 2, 3));
 220   const database = await openDB('cp2p');
 221   const stolen = await database.get('bytes', identityKey);
 222   if (!stolen) throw new Error('Encrypted identity is missing');
 223   await database.put('bytes', stolen, 'private/swapped-key');
 224   database.close();
 225   await expect(store.load('private/swapped-key')).rejects.toThrow(/authentication/);
 226   await store.close();
 227   await owner.close();
 228   await expect(migrating).rejects.toThrow(/authentication/);
 229 });
 230 
 231 test('closing during worker unlock cannot repopulate the key or restart access', async () => {
 232   installFactory();
 233   const initial = await seed();
 234   await initial.close();
 235   await migrateLocalVault({
 236     newPassphrase: 'close race passphrase',
 237     lockManager: new TestLocks(),
 238   });
 239   const original = crypto.subtle.deriveKey.bind(crypto.subtle);
 240   let entered!: () => void;
 241   const started = new Promise<void>((resolve) => {
 242     entered = resolve;
 243   });
 244   let release!: () => void;
 245   const held = new Promise<void>((resolve) => {
 246     release = resolve;
 247   });
 248   const spy = vi
 249     .spyOn(crypto.subtle, 'deriveKey')
 250     .mockImplementation(async (algorithm, baseKey, derivedKeyType, extractable, usages) => {
 251       entered();
 252       await held;
 253       return original(algorithm, baseKey, derivedKeyType, extractable, usages);
 254     });
 255   const access = new VaultRecordAccess();
 256   try {
 257     const pending = access.pin({ passphrase: 'close race passphrase' });
 258     await started;
 259     access.close();
 260     release();
 261     await expect(pending).rejects.toThrow(/closed during unlock/);
 262     expect(() => access.handoff()).toThrow(/closed/);
 263     await expect(access.pin({ passphrase: 'close race passphrase' })).rejects.toThrow(/closed/);
 264   } finally {
 265     spy.mockRestore();
 266   }
 267 });
```

## packages/storage/src/transfer-import-store.test.ts

Lines 376-455:
```ts
 376   await journal.close();
 377   await store.close();
 378 }, 30_000);
 379 
 380 test('vault-protected transfer promotes ciphertext binding and survives safety write and key rotation', async () => {
 381   installFactory();
 382   const data = verifiedTransfer();
 383   const gameId = data.fixture.genesis.gameId;
 384   const recordKey = `online-game/${genesisDigest(data.fixture.genesis)}/keys`;
 385   const locks = new TestLocks();
 386   const seed = new IndexedDbByteStore();
 387   await seed.putIfAbsent('online-credentials/device-identity/v1', Uint8Array.of(1, 2, 3));
 388   await seed.close();
 389   await migrateLocalVault({ newPassphrase: 'first vault passphrase', lockManager: locks });
 390   const owner = await acquireVaultOwner({
 391     passphrase: 'first vault passphrase',
 392     lockManager: locks,
 393   });
 394   const bytes = new IndexedDbByteStore({ vault: owner });
 395   const stage = new TransferImportStore(bytes);
 396   const stageInput = {
 397     gameId,
 398     authorization: data.authorizationRef,
 399     destinationGameKey: data.game.peerId,
 400     bindingBytes: data.bindingBytes,
 401     sealedPackage: Uint8Array.of(1),
 402     privateReplayBytes: Uint8Array.of(2),
 403     genesis: data.fixture.genesisEntry,
 404     entries: data.entries,
 405   };
 406   const stageKey = await stage.stage(stageInput, data.fixture.source.engine, data.fixture.policy);
 407   expect(await stage.stage(stageInput, data.fixture.source.engine, data.fixture.policy)).toBe(
 408     stageKey,
 409   );
 410   const readiness = {
 411     protocol: 'seat-transfer-readiness-v1',
 412     statement: data.activationStatement,
 413     destinationCheck: data.destinationCheck,
 414     replacementChecks: [],
 415   } as const;
 416   await stage.saveReadiness(stageKey, readiness);
 417   await stage.saveReadiness(stageKey, readiness);
 418   const rawStage = await openDB('cp2p');
 419   expect((await rawStage.get('bytes', stageKey))?.subarray(0, 4)).toEqual(
 420     Uint8Array.of(0x56, 0x4c, 0x54, 0x31),
 421   );
 422   rawStage.close();
 423   const journal = new IndexedDbProtocolJournal(gameId, {
 424     vault: owner,
 425     keyBinding: { recordKey, bytes: data.bindingBytes },
 426   });
 427   expect(
 428     await journal.promoteTransfer({
 429       stageKey,
 430       activation: data.activationCertificate,
 431       engine: data.fixture.source.engine,
 432       policy: data.fixture.policy,
 433       expectedActive: null,
 434       leaseOptions: { lockManager: locks },
 435     }),
 436   ).toBe(true);
 437   const installed = await openDB('cp2p');
 438   expect((await installed.get('bytes', recordKey))?.subarray(0, 4)).toEqual(
 439     Uint8Array.of(0x56, 0x4c, 0x54, 0x31),
 440   );
 441   installed.close();
 442   const loaded = await journal.load();
 443   if (!loaded) throw new Error('Promoted vault journal is absent');
 444   expect(await journal.saveSafety(loaded.height, 0, loaded.safety.bytes)).toBe(true);
 445   await journal.close();
 446   await stage.close();
 447   await owner.close();
 448 
 449   await migrateLocalVault({
 450     oldPassphrase: 'first vault passphrase',
 451     newPassphrase: 'second vault passphrase',
 452     lockManager: locks,
 453   });
 454   const rotated = await acquireVaultOwner({
 455     passphrase: 'second vault passphrase',
```

## packages/storage/src/online-game-deletion.test.ts

Lines 180-230:
```ts
 180   const upgraded = await openDB<TestDatabase>('cp2p');
 181   expect([...upgraded.objectStoreNames].toSorted()).toContain('deletedGames');
 182   expect(await upgraded.get('bytes', 'keep/this')).toEqual(Uint8Array.of(11, 12));
 183   expect(await upgraded.get('deletedGames', 'any')).toBeUndefined();
 184   upgraded.close();
 185   expect(factory).toBeDefined();
 186 });
 187 
 188 test('locked deletion keeps the public tombstone and identity while removing encrypted game keys', async () => {
 189   installFactory();
 190   const locks = new TestLocks();
 191   const clear = byteStoreWithLocks(locks);
 192   const data = await seedGame(clear);
 193   await clear.close();
 194   await migrateLocalVault({ newPassphrase: 'deletion passphrase', lockManager: locks });
 195   expect(
 196     await deleteOnlineGameData(data.gameId, data.digest, {
 197       lockManager: locks,
 198       now: () => 1234,
 199     }),
 200   ).toBe('deleted');
 201   expect(await readOnlineGameTombstone(data.gameId)).toMatchObject({ deletedAt: 1234 });
 202   const owner = await acquireVaultOwner({ passphrase: 'deletion passphrase', lockManager: locks });
 203   const protectedStore = new IndexedDbByteStore({ vault: owner });
 204   expect(await protectedStore.load(`online-game/${data.digest}/keys`)).toBeNull();
 205   expect(await protectedStore.load('online-credentials/device-identity/v1')).toEqual(
 206     Uint8Array.of(1, 2, 3),
 207   );
 208   await protectedStore.close();
 209   await owner.close();
 210 });
 211 
 212 test('deletion atomically removes known game records but retains identity, escrow registry, and tombstone', async () => {
 213   installFactory();
 214   const locks = new TestLocks();
 215   const store = byteStoreWithLocks(locks);
 216   const data = await seedGame(store);
 217   const before = await openDB<TestDatabase>('cp2p');
 218   await before.put('snapshots', Uint8Array.of(9), [data.gameId, 100]);
 219   before.close();
 220   const result = await deleteOnlineGameData(data.gameId, data.digest, {
 221     lockManager: locks,
 222     now: () => 1234,
 223   });
 224   expect(result).toBe('deleted');
 225   expect(await readOnlineGameTombstone(data.gameId)).toEqual({
 226     protocol: 'online-game-deletion-v1',
 227     gameId: data.gameId,
 228     genesisDigest: data.digest,
 229     deletedAt: 1234,
 230   });
```
