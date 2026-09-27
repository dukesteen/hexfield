import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import * as v from 'valibot';
import {
  BYTE_STORE,
  MAX_RECORD_BYTES,
  openDatabase,
  strictWriteTransaction,
  VAULT_STORE,
} from './database.js';

const VAULT_KEY = 'state';
const LOCK_NAME = 'cp2p/local-vault/v1';
const IDENTITY_KEY = 'online-credentials/device-identity/v1';
const ITERATIONS = 600_000;
const MAX_MIGRATION_BYTES = 256 * 1024 * 1024;
const MAGIC = Uint8Array.of(0x56, 0x4c, 0x54, 0x31); // VLT1
const HEADER_BYTES = 20;
export const MAX_VAULT_STORED_BYTES = MAX_RECORD_BYTES + HEADER_BYTES + 16;

export class VaultError extends Error {
  constructor(
    readonly code:
      | 'locked'
      | 'invalid-key'
      | 'corrupt'
      | 'stale-generation'
      | 'closed'
      | 'busy'
      | 'changed'
      | 'identity-missing'
      | 'identity-mismatch'
      | 'weak-passphrase'
      | 'unsupported',
    message: string,
    readonly recordKey: string | null = null,
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

const bytesSchema = v.custom<Uint8Array>((value) => value instanceof Uint8Array);
const generationSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(0xffffffff));
const clearSchema = v.strictObject({
  protocol: v.literal('local-vault-v1'),
  mode: v.literal('clear'),
  generation: generationSchema,
  vaultId: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  identityHash: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
});
const lockedSchema = v.strictObject({
  protocol: v.literal('local-vault-v1'),
  mode: v.literal('locked'),
  generation: generationSchema,
  vaultId: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  identityHash: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  salt: bytesSchema,
  iterations: v.literal(ITERATIONS),
  verifierNonce: bytesSchema,
  verifier: bytesSchema,
});
const metadataSchema = v.union([clearSchema, lockedSchema]);
type VaultMetadata = v.InferOutput<typeof metadataSchema>;
type VaultLockManager = Pick<LockManager, 'request'>;

export interface VaultKeyHandoff {
  readonly key: CryptoKey;
  readonly vaultId: string;
  readonly generation: number;
}

export interface VaultOwnerOptions {
  readonly passphrase?: string;
  readonly handoff?: VaultKeyHandoff;
  /** Test seam; production uses same-origin Web Locks. */
  readonly lockManager?: VaultLockManager;
}

export interface VaultMigrationOptions {
  readonly oldPassphrase?: string;
  readonly newPassphrase?: string;
  /** Test seam; production uses same-origin Web Locks. */
  readonly lockManager?: VaultLockManager;
}

/** Exact public records needed by locked deletion, escrow retirement and transfer tombstones. */
export function isPublicVaultRecord(key: string): boolean {
  return (
    key === 'escrow-lifecycle/device-index-v1' ||
    key === 'online-games/catalogue-v1' ||
    /^online-game\/[A-Za-z0-9_-]+\/(start|start-digest)$/.test(key) ||
    /^online-game-deleted\/[A-Za-z0-9_-]+$/.test(key) ||
    /^transfer-import-final\/[A-Za-z0-9_-]+\/[0-9a-f]{64}$/.test(key)
  );
}

/** An owner holds one shared lock across its room, game, ceremony or transfer lifetime. */
export class VaultOwnerLease {
  readonly #access: VaultRecordAccess;
  readonly #release: () => void;
  readonly #held: Promise<void>;
  #closed = false;

  constructor(access: VaultRecordAccess, release: () => void, held: Promise<void>) {
    this.#access = access;
    this.#release = release;
    this.#held = held;
    void held.then(() => {
      if (!this.#closed) {
        this.#closed = true;
        access.close();
      }
      return undefined;
    });
  }

  get generation(): number {
    return this.#access.generation;
  }

  get mode(): 'clear' | 'locked' {
    return this.#access.mode;
  }

  handoff(): VaultKeyHandoff | null {
    this.assertActive();
    return this.#access.handoff();
  }

  /** Storage constructors use this only while the owner lease remains live. */
  access(): VaultRecordAccess {
    this.assertActive();
    return this.#access;
  }

  assertActive(): void {
    if (this.#closed) throw new VaultError('closed', 'Vault owner lease is closed');
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#access.close();
    this.#release();
    await this.#held;
  }
}

/** Acquires the shared lock before any writer or ceremony lock. No inner storage call reacquires it. */
export async function acquireVaultOwner(options: VaultOwnerOptions = {}): Promise<VaultOwnerLease> {
  const manager = options.lockManager ?? browserLocks();
  let release!: () => void;
  const untilRelease = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let lockError: unknown;
  let acquired = false;
  const held: Promise<void> = manager
    .request(LOCK_NAME, { mode: 'shared', ifAvailable: true }, async (lock) => {
      acquired = Boolean(lock);
      resolveStarted();
      if (lock) await untilRelease;
    })
    .then(
      () => undefined,
      (error: unknown) => {
        lockError = error;
        resolveStarted();
      },
    );
  await started;
  if (!acquired) {
    await held;
    throw lockError ?? new VaultError('busy', 'Vault owner lock is busy');
  }
  try {
    const access = new VaultRecordAccess();
    await access.pin(options);
    return new VaultOwnerLease(access, release, held);
  } catch (error) {
    release();
    await held;
    throw error;
  }
}

/** Migration is one exact-key-set and exact-value transaction after all encryption work. */
export async function migrateLocalVault(options: VaultMigrationOptions): Promise<void> {
  const manager = options.lockManager ?? browserLocks();
  await manager.request(LOCK_NAME, { mode: 'exclusive' }, async (lock) => {
    if (!lock) throw new VaultError('busy', 'Exclusive vault lock could not be acquired');
    const database = await openDatabase(
      () => undefined,
      () => undefined,
    );
    const oldRecords: { key: string; bytes: Uint8Array }[] = [];
    const replacements: { key: string; bytes: Uint8Array }[] = [];
    let oldRaw: Uint8Array | undefined;
    try {
      const read = database.transaction([BYTE_STORE, VAULT_STORE], 'readonly');
      let cursor = await read.objectStore(BYTE_STORE).openCursor();
      let total = 0;
      while (cursor) {
        const key = cursor.key;
        const bytes = cursor.value;
        if (
          typeof key !== 'string' ||
          key.length > 512 ||
          !(bytes instanceof Uint8Array) ||
          bytes.byteLength > MAX_VAULT_STORED_BYTES
        )
          throw new TypeError('Vault migration found a malformed record');
        total += key.length * 3 + bytes.byteLength;
        if (total > MAX_MIGRATION_BYTES || oldRecords.length >= 65_536)
          throw new RangeError('Vault migration is too large');
        oldRecords.push({ key, bytes });
        // IDB cursors keep the read transaction alive without materializing unbounded getAll().
        // eslint-disable-next-line no-await-in-loop
        cursor = await cursor.continue();
      }
      oldRaw = await read.objectStore(VAULT_STORE).get(VAULT_KEY);
      await read.done;
      const oldMeta = parseMetadata(oldRaw);
      const oldKey = await unlockKey(oldMeta, options.oldPassphrase);
      if (oldMeta?.mode === 'clear' && options.oldPassphrase !== undefined)
        throw new TypeError('Clear vault does not accept an old passphrase');
      if (!oldMeta && options.oldPassphrase !== undefined)
        throw new TypeError('Clear vault does not accept an old passphrase');
      const identity = oldRecords.find((item) => item.key === IDENTITY_KEY);
      if (!identity)
        throw new VaultError(
          'identity-missing',
          'Cannot migrate a device without its reserved identity',
        );
      const identityPlain = await decodeProtected(IDENTITY_KEY, identity.bytes, oldMeta, oldKey);
      let identityHash: string;
      try {
        identityHash = await sha256Hex(identityPlain);
      } finally {
        identityPlain.fill(0);
      }
      if (oldMeta && oldMeta.identityHash !== identityHash)
        throw new VaultError(
          'identity-mismatch',
          'Reserved device identity changed before vault migration',
        );
      const generation = (oldMeta?.generation ?? 0) + 1;
      if (generation > 0xffffffff) throw new RangeError('Vault generation is exhausted');
      const vaultId = oldMeta?.vaultId ?? randomHex(32);
      const next = await nextMetadata(vaultId, generation, identityHash, options.newPassphrase);
      for (const item of oldRecords) {
        if (isPublicVaultRecord(item.key)) continue;
        // Bound peak migration memory by converting records one at a time.
        // eslint-disable-next-line no-await-in-loop
        const plain = await decodeProtected(item.key, item.bytes, oldMeta, oldKey);
        try {
          // eslint-disable-next-line no-await-in-loop
          const encrypted = await encodeProtected(item.key, plain, next.meta, next.key);
          replacements.push({ key: item.key, bytes: encrypted });
        } finally {
          plain.fill(0);
        }
      }
      const nextRaw = canonicalEncode(next.meta);
      try {
        const transaction = strictWriteTransaction(database, [BYTE_STORE, VAULT_STORE]);
        try {
          const bytes = transaction.objectStore(BYTE_STORE);
          const currentKeys = await bytes.getAllKeys();
          if (
            currentKeys.length !== oldRecords.length ||
            currentKeys.some((key, index) => key !== oldRecords[index]?.key)
          )
            throw new VaultError('changed', 'Vault records changed during migration');
          for (const item of oldRecords) {
            // Keep all IDB work in one transaction; no WebCrypto awaits in this loop.
            // eslint-disable-next-line no-await-in-loop
            const current = await bytes.get(item.key);
            if (!(current instanceof Uint8Array) || !equalBytes(current, item.bytes))
              throw new VaultError('changed', 'Vault record changed during migration', item.key);
            current.fill(0);
          }
          const currentMeta = await transaction.objectStore(VAULT_STORE).get(VAULT_KEY);
          if (!equalOptional(currentMeta, oldRaw))
            throw new VaultError('changed', 'Vault metadata changed during migration');
          currentMeta?.fill(0);
          for (const item of replacements) {
            // eslint-disable-next-line no-await-in-loop
            await bytes.put(item.bytes, item.key);
          }
          await transaction.objectStore(VAULT_STORE).put(nextRaw, VAULT_KEY);
          await transaction.done;
        } catch (error) {
          try {
            transaction.abort();
          } catch {
            // A failed commit may have already closed the transaction.
          }
          await transaction.done.catch(() => undefined);
          throw error;
        }
      } finally {
        nextRaw.fill(0);
      }
    } finally {
      oldRaw?.fill(0);
      oldRecords.forEach((item) => item.bytes.fill(0));
      replacements.forEach((item) => item.bytes.fill(0));
      database.close();
    }
  });
}

/** Shared codec and generation assertion used by all direct IDB writers. */
export class VaultRecordAccess {
  readonly #publicOnlyWhenLocked: boolean;
  #meta: VaultMetadata | null = null;
  #raw: Uint8Array | undefined;
  #key: CryptoKey | null = null;
  #ready: Promise<void> | null = null;
  #closed = false;

  constructor(publicOnlyWhenLocked = false) {
    this.#publicOnlyWhenLocked = publicOnlyWhenLocked;
  }

  get generation(): number {
    return this.#meta?.generation ?? 0;
  }

  get mode(): 'clear' | 'locked' {
    return this.#meta?.mode ?? 'clear';
  }

  get hasMetadata(): boolean {
    return this.#meta !== null;
  }

  handoff(): VaultKeyHandoff | null {
    if (this.#closed) throw new VaultError('closed', 'Vault access is closed');
    if (!this.#key || this.#meta?.mode !== 'locked') return null;
    return { key: this.#key, vaultId: this.#meta.vaultId, generation: this.#meta.generation };
  }

  pin(options: Pick<VaultOwnerOptions, 'passphrase' | 'handoff'> = {}): Promise<void> {
    if (this.#closed) return Promise.reject(new VaultError('closed', 'Vault access is closed'));
    if (this.#ready) return this.#ready;
    this.#ready = (async () => {
      const database = await openDatabase(
        () => undefined,
        () => undefined,
      );
      try {
        const raw = await database.get(VAULT_STORE, VAULT_KEY);
        const meta = parseMetadata(raw);
        const key = await unlockKey(
          meta,
          options.passphrase,
          options.handoff,
          this.#publicOnlyWhenLocked,
        );
        if (this.#closed) throw new VaultError('closed', 'Vault access closed during unlock');
        this.#raw = raw?.slice();
        this.#meta = meta;
        this.#key = key;
      } finally {
        database.close();
      }
    })().catch((error: unknown) => {
      if (!this.#closed) this.#ready = null;
      throw error;
    });
    return this.#ready;
  }

  async assertGeneration(vaultStore: {
    get(key: string): Promise<Uint8Array | undefined>;
  }): Promise<void> {
    if (this.#closed) throw new VaultError('closed', 'Vault access is closed');
    await this.pin();
    if (this.#closed) throw new VaultError('closed', 'Vault access is closed');
    const current = await vaultStore.get(VAULT_KEY);
    try {
      if (this.#closed) throw new VaultError('closed', 'Vault access is closed');
      if (!equalOptional(current, this.#raw))
        throw new VaultError('stale-generation', 'Vault generation changed; output is stopped');
    } finally {
      current?.fill(0);
    }
  }

  async encode(key: string, plain: Uint8Array): Promise<Uint8Array> {
    if (this.#closed) throw new VaultError('closed', 'Vault access is closed');
    await this.pin();
    if (this.#closed) throw new VaultError('closed', 'Vault access is closed');
    await assertIdentityHash(key, plain, this.#meta);
    return encodeProtected(key, plain, this.#meta, this.#key);
  }

  async decode(key: string, stored: Uint8Array): Promise<Uint8Array> {
    if (this.#closed) throw new VaultError('closed', 'Vault access is closed');
    await this.pin();
    if (this.#closed) throw new VaultError('closed', 'Vault access is closed');
    const plain = await decodeProtected(key, stored, this.#meta, this.#key);
    try {
      if (this.#closed) throw new VaultError('closed', 'Vault access closed during decrypt');
      await assertIdentityHash(key, plain, this.#meta);
      if (this.#closed) throw new VaultError('closed', 'Vault access closed during decrypt');
      return plain;
    } catch (error) {
      plain.fill(0);
      throw error;
    }
  }

  close(): void {
    this.#closed = true;
    this.#key = null;
    this.#raw?.fill(0);
    this.#raw = undefined;
  }
}

function browserLocks(): VaultLockManager {
  if (typeof navigator === 'undefined' || !navigator.locks)
    throw new VaultError(
      'unsupported',
      'Web Locks are unavailable; vault coordination cannot proceed safely',
    );
  return navigator.locks;
}

function parseMetadata(raw: Uint8Array | undefined): VaultMetadata | null {
  if (!raw) return null;
  if (!(raw instanceof Uint8Array) || raw.length > 512)
    throw new VaultError('corrupt', 'Vault metadata is malformed');
  try {
    const meta = v.parse(metadataSchema, canonicalDecode(raw));
    if (meta.mode === 'locked' && (meta.salt.length !== 32 || meta.verifierNonce.length !== 12))
      throw new VaultError('corrupt', 'Vault metadata has invalid cryptographic lengths');
    const canonical = canonicalEncode(meta);
    const exact = equalBytes(canonical, raw);
    canonical.fill(0);
    if (!exact) throw new VaultError('corrupt', 'Vault metadata is noncanonical');
    return meta;
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError('corrupt', 'Vault metadata is malformed');
  }
}

async function unlockKey(
  meta: VaultMetadata | null,
  passphrase?: string,
  handoff?: VaultKeyHandoff,
  publicOnlyWhenLocked = false,
): Promise<CryptoKey | null> {
  if (meta?.mode !== 'locked') {
    if (handoff)
      throw new VaultError('stale-generation', 'Vault key handoff does not match clear storage');
    if (passphrase !== undefined)
      throw new VaultError('invalid-key', 'Clear storage does not accept a passphrase');
    return null;
  }
  if (publicOnlyWhenLocked && passphrase === undefined && handoff === undefined) return null;
  if ((passphrase === undefined) === (handoff === undefined))
    throw new VaultError(
      'locked',
      'Locked storage requires exactly one passphrase or worker key handoff',
    );
  let key: CryptoKey;
  if (handoff) {
    if (
      handoff.vaultId !== meta.vaultId ||
      handoff.generation !== meta.generation ||
      !(handoff.key instanceof CryptoKey) ||
      handoff.key.extractable ||
      handoff.key.algorithm.name !== 'AES-GCM' ||
      !handoff.key.usages.includes('encrypt') ||
      !handoff.key.usages.includes('decrypt')
    )
      throw new VaultError('stale-generation', 'Vault key handoff does not match current metadata');
    key = handoff.key;
  } else key = await deriveKey(passphrase ?? '', meta.salt);
  try {
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: buffer(meta.verifierNonce),
          additionalData: buffer(aad(meta, 'verifier')),
        },
        key,
        buffer(meta.verifier),
      ),
    );
    const valid = equalBytes(plain, new TextEncoder().encode('cp2p-local-vault-v1'));
    plain.fill(0);
    if (!valid) throw new Error('Vault verifier is invalid');
    return key;
  } catch {
    throw new VaultError('invalid-key', 'Vault passphrase or key handoff is invalid');
  }
}

/** Deletion is a standalone exclusive operation, ordered before game and catalogue locks. */
export async function withExclusiveVault<T>(
  task: () => Promise<T>,
  lockManager?: VaultLockManager,
): Promise<T | null> {
  const manager = lockManager ?? browserLocks();
  return manager.request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, (lock) =>
    lock ? task() : null,
  );
}

async function nextMetadata(
  vaultId: string,
  generation: number,
  identityHash: string,
  passphrase?: string,
): Promise<{
  meta: VaultMetadata;
  key: CryptoKey | null;
}> {
  if (passphrase === undefined)
    return {
      meta: { protocol: 'local-vault-v1', mode: 'clear', generation, vaultId, identityHash },
      key: null,
    };
  validatePassphrase(passphrase);
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const verifierNonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const metaBase = {
    protocol: 'local-vault-v1' as const,
    mode: 'locked' as const,
    generation,
    vaultId,
    identityHash,
    salt,
    iterations: ITERATIONS as typeof ITERATIONS,
    verifierNonce,
  };
  const verifier = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: buffer(verifierNonce),
        additionalData: buffer(aad(metaBase, 'verifier')),
      },
      key,
      new TextEncoder().encode('cp2p-local-vault-v1'),
    ),
  );
  return { meta: { ...metaBase, verifier }, key };
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  validatePassphrase(passphrase);
  const secret = new TextEncoder().encode(passphrase);
  try {
    const base = await crypto.subtle.importKey('raw', buffer(secret), 'PBKDF2', false, [
      'deriveKey',
    ]);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: buffer(salt), iterations: ITERATIONS },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    secret.fill(0);
  }
}

async function encodeProtected(
  recordKey: string,
  plain: Uint8Array,
  meta: VaultMetadata | null,
  key: CryptoKey | null,
): Promise<Uint8Array> {
  if (!(plain instanceof Uint8Array) || plain.length > MAX_RECORD_BYTES)
    throw new RangeError('Vault plaintext record exceeds 16 MiB');
  if (isPublicVaultRecord(recordKey) || meta?.mode !== 'locked') return plain.slice();
  if (!key) throw new VaultError('locked', 'Vault key is unavailable');
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: buffer(nonce), additionalData: buffer(aad(meta, recordKey)) },
      key,
      buffer(plain),
    ),
  );
  const stored = new Uint8Array(HEADER_BYTES + ciphertext.length);
  stored.set(MAGIC);
  new DataView(stored.buffer).setUint32(4, meta.generation);
  stored.set(nonce, 8);
  stored.set(ciphertext, HEADER_BYTES);
  ciphertext.fill(0);
  return stored;
}

async function decodeProtected(
  recordKey: string,
  stored: Uint8Array,
  meta: VaultMetadata | null,
  key: CryptoKey | null,
): Promise<Uint8Array> {
  if (!(stored instanceof Uint8Array) || stored.length > MAX_VAULT_STORED_BYTES)
    throw new TypeError('Vault stored record is malformed or oversized');
  if (isPublicVaultRecord(recordKey) || meta?.mode !== 'locked') {
    if (stored.length > MAX_RECORD_BYTES) throw new TypeError('Clear vault record exceeds 16 MiB');
    return stored.slice();
  }
  if (!key) throw new VaultError('locked', 'Vault key is unavailable');
  if (
    stored.length < HEADER_BYTES + 16 ||
    !equalBytes(stored.subarray(0, 4), MAGIC) ||
    new DataView(stored.buffer, stored.byteOffset).getUint32(4) !== meta.generation
  )
    throw new VaultError('corrupt', 'Vault record has the wrong envelope or generation', recordKey);
  try {
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: buffer(stored.subarray(8, 20)),
          additionalData: buffer(aad(meta, recordKey)),
        },
        key,
        buffer(stored.subarray(HEADER_BYTES)),
      ),
    );
    if (plain.length > MAX_RECORD_BYTES) {
      plain.fill(0);
      throw new TypeError('Vault record plaintext exceeds 16 MiB');
    }
    return plain;
  } catch {
    throw new VaultError('corrupt', 'Vault record authentication failed', recordKey);
  }
}

function aad(meta: Pick<VaultMetadata, 'vaultId' | 'generation'>, key: string): Uint8Array {
  return canonicalEncode(['local-vault-v1', meta.vaultId, meta.generation, BYTE_STORE, key]);
}

function randomHex(length: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer(bytes)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function assertIdentityHash(
  key: string,
  bytes: Uint8Array,
  meta: VaultMetadata | null,
): Promise<void> {
  if (key === IDENTITY_KEY && meta && (await sha256Hex(bytes)) !== meta.identityHash)
    throw new VaultError(
      'identity-mismatch',
      'Reserved device identity differs from the pinned vault identity',
    );
}

function buffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

function validatePassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024)
    throw new VaultError('weak-passphrase', 'Vault passphrase must contain 12 to 1024 characters');
}

function equalOptional(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && equalBytes(left, right);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
