export const PACKAGE_NAME = '@cp2p/storage';

export { IndexedDbByteStore } from './indexed-db-byte-store.js';
export type { CeremonyLockProvider, IndexedDbByteStoreOptions } from './indexed-db-byte-store.js';
export { IndexedDbProtocolJournal } from './indexed-db-protocol-journal.js';
export type {
  IndexedDbProtocolJournalOptions,
  TransferPromotionOptions,
} from './indexed-db-protocol-journal.js';
export {
  acquireActiveGameWriterLease,
  acquireGameWriterLease,
  acquireTransferStagingLease,
  GameWriterLeaseError,
} from './game-writer.js';
export type { GameWriterLease, GameWriterLeaseOptions } from './game-writer.js';
export { TransferImportStore, transferImportKey } from './transfer-import-store.js';
export type {
  TransferImportRecord,
  TransferImportInput,
  TransferReadinessRecord,
} from './transfer-import-store.js';
