import { entryHash } from '@cp2p/protocol';
import {
  acquireGameWriterLease,
  IndexedDbByteStore,
  IndexedDbProtocolJournal,
} from '@cp2p/storage';
import type { GameWriterLease } from '@cp2p/storage';
import type { CertifiedEntry, LogEntry } from '@cp2p/protocol';

export interface StorageJournalSnapshot {
  height: number;
  entrySeqs: number[];
  headHash: string;
  safetyRevision: number;
  safety: number[];
}

type StorageSmokeResult = boolean | number | null | StorageJournalSnapshot;

export interface StorageSmokeRequest {
  id: number;
  action:
    | 'insert'
    | 'cas'
    | 'read'
    | 'lock'
    | 'close'
    | 'writer-acquire'
    | 'writer-release'
    | 'journal-initialize'
    | 'journal-save'
    | 'journal-commit'
    | 'journal-read'
    | 'journal-stale';
  key: string;
  gameId?: string;
  value?: number;
  expected?: number;
  height?: number;
  revision?: number;
  genesis?: LogEntry;
  certified?: CertifiedEntry;
}

export interface StorageSmokeResponse {
  id: number;
  result?: StorageSmokeResult;
  error?: string;
}

const store = new IndexedDbByteStore();
let journal: IndexedDbProtocolJournal | null = null;
let journalGameId: string | null = null;
let writer: GameWriterLease | null = null;

function getJournal(gameId: string | undefined): IndexedDbProtocolJournal {
  if (!gameId) throw new Error('Journal request has no gameId');
  if (journal && journalGameId !== gameId) throw new Error('Worker already owns another journal');
  if (!journal) {
    journal = new IndexedDbProtocolJournal(gameId);
    journalGameId = gameId;
  }
  return journal;
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`Journal request has no ${name}`);
  return value;
}

async function handle(message: StorageSmokeRequest): Promise<StorageSmokeResult> {
  switch (message.action) {
    case 'insert':
      return store.putIfAbsent(message.key, new Uint8Array([message.value ?? 0]));
    case 'cas':
      return store.compareAndSwap(
        message.key,
        new Uint8Array([message.expected ?? 0]),
        new Uint8Array([message.value ?? 0]),
      );
    case 'read':
      return (await store.load(message.key))?.[0] ?? null;
    case 'close':
      await writer?.close();
      writer = null;
      await store.close();
      await journal?.close();
      journal = null;
      journalGameId = null;
      return true;
    case 'writer-acquire':
      if (writer) return false;
      writer = await acquireGameWriterLease(required(message.gameId, 'gameId'), 'storage-smoke');
      return writer !== null;
    case 'writer-release':
      await writer?.close();
      writer = null;
      return true;
    case 'lock':
      return store.withCeremonyLock(message.key, async () => {
        const entered = await store.compareAndSwap(
          message.key,
          new Uint8Array([0]),
          new Uint8Array([1]),
        );
        if (!entered) throw new Error('Ceremony callbacks overlapped across workers');
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        const left = await store.compareAndSwap(
          message.key,
          new Uint8Array([1]),
          new Uint8Array([0]),
        );
        if (!left) throw new Error('Ceremony record changed inside its exclusive lock');
        return true;
      });
    case 'journal-initialize':
      return getJournal(message.gameId).initialize(
        required(message.genesis, 'genesis'),
        Uint8Array.of(0),
      );
    case 'journal-save':
      return getJournal(message.gameId).saveSafety(
        required(message.height, 'height'),
        required(message.revision, 'revision'),
        Uint8Array.of(required(message.value, 'safety value')),
      );
    case 'journal-commit':
      return getJournal(message.gameId).commit(
        required(message.height, 'height'),
        required(message.revision, 'revision'),
        required(message.certified, 'certified entry'),
        Uint8Array.of(required(message.value, 'next safety value')),
      );
    case 'journal-read': {
      const record = await getJournal(message.gameId).load();
      if (!record) throw new Error('Journal disappeared after reopen');
      const head = record.entries.at(-1)?.entry ?? record.genesis;
      return {
        height: record.height,
        entrySeqs: record.entries.map(({ entry }) => entry.seq),
        headHash: entryHash(head),
        safetyRevision: record.safety.revision,
        safety: [...record.safety.bytes],
      };
    }
    case 'journal-stale': {
      const activeJournal = getJournal(message.gameId);
      const saved = await activeJournal.saveSafety(1, 0, Uint8Array.of(9));
      const committed = await activeJournal.commit(
        1,
        0,
        required(message.certified, 'certified entry'),
        Uint8Array.of(9),
      );
      return !saved && !committed;
    }
    default:
      throw new Error('Unknown storage check action');
  }
}

function reply(message: StorageSmokeResponse): void {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker messaging has no targetOrigin.
  self.postMessage(message);
}

self.addEventListener('message', (event: MessageEvent<StorageSmokeRequest>) => {
  void handle(event.data).then(
    (result) => reply({ id: event.data.id, result }),
    (error: unknown) =>
      reply({
        id: event.data.id,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
});
