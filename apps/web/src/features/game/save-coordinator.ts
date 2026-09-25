import type { LocalSession, LocalSessionSave } from '../../session';
import type {
  GamePresentation,
  SaveInput,
  SavedGameRecord,
  SavedGameRepository,
} from '../../queries/repositories/saved-games';

export type SaveStatus = 'saved' | 'saving' | 'error';

/** Coalesces session revisions, while the repository serializes and checks actual writes. */
export class SaveCoordinator {
  private latestRevision: number;
  private savedRevision: number;
  private enqueuedRevision: number;
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private unsubscribe: () => void;

  constructor(
    private readonly id: string,
    private readonly session: LocalSession,
    private readonly presentation: GamePresentation,
    private readonly repository: SavedGameRepository,
    private readonly saveAsync: (input: SaveInput) => Promise<SavedGameRecord>,
    initialRevision: number,
    private readonly onStatus: (status: SaveStatus) => void,
  ) {
    this.latestRevision = initialRevision;
    this.savedRevision = initialRevision;
    this.enqueuedRevision = initialRevision;
    this.unsubscribe = session.subscribe((update) => {
      if (update.revision <= this.latestRevision) return;
      this.latestRevision = update.revision;
      this.onStatus('saving');
      if (this.scheduled === null) this.scheduled = setTimeout(() => this.enqueueLatest(), 0);
    });
  }

  private input(revision: number, save: LocalSessionSave) {
    return { id: this.id, revision, presentation: this.presentation, save };
  }

  private enqueueLatest(): void {
    if (this.scheduled !== null) clearTimeout(this.scheduled);
    this.scheduled = null;
    if (this.latestRevision <= this.enqueuedRevision) return;
    const revision = this.latestRevision;
    const snapshot = this.session.exportSave();
    this.enqueuedRevision = revision;
    this.inFlight = this.saveAsync(this.input(revision, snapshot)).then(
      () => {
        this.savedRevision = Math.max(this.savedRevision, revision);
        if (this.savedRevision >= this.latestRevision) this.onStatus('saved');
        return undefined;
      },
      () => {
        if (this.enqueuedRevision === revision) this.enqueuedRevision = this.savedRevision;
        if (revision > this.savedRevision) this.onStatus('error');
        return undefined;
      },
    );
  }

  /** Synchronous localStorage write for pagehide and effect cleanup. */
  flushSync(): void {
    if (this.scheduled !== null) clearTimeout(this.scheduled);
    this.scheduled = null;
    if (this.latestRevision <= this.savedRevision) return;
    this.repository.flushSync(this.input(this.latestRevision, this.session.exportSave()));
    this.savedRevision = this.latestRevision;
    this.onStatus('saved');
  }

  async flush(): Promise<void> {
    this.enqueueLatest();
    await this.inFlight;
    if (this.savedRevision < this.latestRevision) {
      this.enqueueLatest();
      await this.inFlight;
    }
    if (this.savedRevision < this.latestRevision) {
      throw new Error('The latest game revision could not be saved');
    }
  }

  dispose(): void {
    this.unsubscribe();
    if (this.scheduled !== null) clearTimeout(this.scheduled);
  }
}
