import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import * as v from 'valibot';
import { entryHash } from './genesis.js';
import { certifiedEntrySchema } from './proposal.js';
import type { CertifiedEntry } from './proposal.js';
import type { SafetyStore, StoredSafety } from './safety-store.js';
import { logEntrySchema } from './schemas.js';
import type { LogEntry } from './types.js';

export interface JournalRecord {
  genesis: LogEntry;
  entries: CertifiedEntry[];
  /** The next height, initialized atomically with the committed parent. */
  height: number;
  safety: StoredSafety;
}

/** All writes are atomic. Failed writes must leave both history and votes intact. */
export interface ProtocolJournal {
  load(): Promise<JournalRecord | null>;
  initialize(genesis: LogEntry, safety: Uint8Array): Promise<boolean>;
  loadSafety(height: number): Promise<StoredSafety | null>;
  saveSafety(height: number, revision: number, bytes: Uint8Array): Promise<boolean>;
  commit(
    height: number,
    safetyRevision: number,
    certified: CertifiedEntry,
    nextSafety: Uint8Array,
  ): Promise<boolean>;
}

/**
 * A height's controller can restore and update its votes, but cannot initialize
 * missing records. Only the journal's certified-parent transaction opens a height.
 */
export function journalSafetyStore(journal: ProtocolJournal, height: number): SafetyStore {
  return {
    load: () => journal.loadSafety(height),
    save: (revision, bytes) =>
      revision === null ? Promise.resolve(false) : journal.saveSafety(height, revision, bytes),
  };
}

function copySafety(record: StoredSafety): StoredSafety {
  return { revision: record.revision, bytes: record.bytes.slice() };
}

function copyEntry(entry: LogEntry): LogEntry {
  return v.parse(logEntrySchema, canonicalDecode(canonicalEncode(entry)));
}

function copyCertified(certified: CertifiedEntry): CertifiedEntry {
  return v.parse(certifiedEntrySchema, canonicalDecode(canonicalEncode(certified)));
}

/** Retain this object across simulated process crashes. It has no reset operation. */
export class MemoryProtocolJournal implements ProtocolJournal {
  private record: JournalRecord | null = null;

  async load(): Promise<JournalRecord | null> {
    const record = this.record;
    return record === null
      ? null
      : {
          genesis: copyEntry(record.genesis),
          entries: record.entries.map(copyCertified),
          height: record.height,
          safety: copySafety(record.safety),
        };
  }

  async initialize(genesis: LogEntry, safety: Uint8Array): Promise<boolean> {
    if (this.record !== null || genesis.seq !== 0 || !(safety instanceof Uint8Array)) return false;
    this.record = {
      genesis: copyEntry(genesis),
      entries: [],
      height: 1,
      safety: { revision: 0, bytes: safety.slice() },
    };
    return true;
  }

  async loadSafety(height: number): Promise<StoredSafety | null> {
    return this.record?.height === height ? copySafety(this.record.safety) : null;
  }

  async saveSafety(height: number, revision: number, bytes: Uint8Array): Promise<boolean> {
    const record = this.record;
    if (
      record === null ||
      record.height !== height ||
      record.safety.revision !== revision ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      !Number.isSafeInteger(revision + 1) ||
      !(bytes instanceof Uint8Array)
    )
      return false;
    record.safety = { revision: revision + 1, bytes: bytes.slice() };
    return true;
  }

  async commit(
    height: number,
    safetyRevision: number,
    certified: CertifiedEntry,
    nextSafety: Uint8Array,
  ): Promise<boolean> {
    const record = this.record;
    if (
      record === null ||
      record.height !== height ||
      record.safety.revision !== safetyRevision ||
      certified.entry.seq !== height ||
      !Number.isSafeInteger(height + 1) ||
      !(nextSafety instanceof Uint8Array)
    )
      return false;
    const parent = record.entries.at(-1)?.entry ?? record.genesis;
    if (certified.entry.prevHash !== entryHash(parent)) return false;
    // Copy before mutation: a failed copy cannot append a partial transaction.
    const stored = copyCertified(certified);
    const safety = { revision: 0, bytes: nextSafety.slice() };
    record.entries.push(stored);
    record.height = height + 1;
    record.safety = safety;
    return true;
  }
}
