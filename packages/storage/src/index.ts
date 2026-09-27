export const PACKAGE_NAME = '@cp2p/storage';

export { IndexedDbByteStore } from './indexed-db-byte-store.js';
export type { CeremonyLockProvider, IndexedDbByteStoreOptions } from './indexed-db-byte-store.js';
export {
  decodeOnlineGameTombstone,
  deleteOnlineGameData,
  onlineGameTombstoneKey,
  readOnlineGameTombstone,
} from './online-game-deletion.js';
export type {
  DeleteOnlineGameDataOptions,
  DeleteOnlineGameDataResult,
  OnlineGameTombstone,
} from './online-game-deletion.js';
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
  TransferImportOutcome,
} from './transfer-import-store.js';
