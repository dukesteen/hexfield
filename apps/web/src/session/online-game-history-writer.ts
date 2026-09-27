import { canonicalEncode, toBase64Url } from '@cp2p/codec';
import type { Seat } from '@cp2p/engine';
import type { EscrowCeremonyStore, P2PSession, SessionAuditState } from '@cp2p/protocol';
import { saveOnlineGameOutcome, saveOnlineGameVoid } from './online-game-history.js';

type OnlineHistorySession = Pick<
  P2PSession,
  'getCommittedHead' | 'getAudit' | 'controllableSeats' | 'subscribe'
>;

export interface OnlineGameHistoryWriterOptions {
  readonly store: EscrowCeremonyStore;
  readonly gameId: string;
  readonly genesisDigest: string;
  readonly session: OnlineHistorySession;
  readonly localHumanSeat: Seat;
  readonly terminalHead: { readonly seq: number; readonly hash: string } | null;
  readonly onError?: (error: Error) => void;
}

export interface OnlineGameHistoryWriter {
  /** Stop accepting session updates before the caller disposes the session. */
  stop(): void;
  /** Wait for all queued outcome metadata writes. */
  flush(): Promise<void>;
}

function auditSignature(audit: SessionAuditState): unknown {
  if (audit.kind !== 'complete') return audit;
  const { report } = audit;
  return {
    kind: audit.kind,
    ok: report.ok,
    complete: report.complete,
    missingSeats: report.missingSeats,
    violations: report.violations.length,
    inputErrors: report.inputErrors.length,
    cheatFindings: report.cheatFindings.length,
    terminal: report.terminal,
    finalHead: report.finalHead,
    historyError: report.historyError,
    auditError: report.auditError,
    finalHiddenVictoryPoints: report.finalHiddenVictoryPoints,
  };
}

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error('Could not save online game history');
}

function reportError(options: OnlineGameHistoryWriterOptions, value: unknown): void {
  try {
    if (options.onError) options.onError(errorFrom(value));
    else {
      // oxlint-disable-next-line no-console -- Display-only storage failures need a production-visible signal.
      console.warn('Could not save online game history metadata');
    }
  } catch {
    // History metadata reporting cannot affect the certified session.
  }
}

/** Persists terminal display metadata separately from the safety journal. */
export function createOnlineGameHistoryWriter(
  options: OnlineGameHistoryWriterOptions,
): OnlineGameHistoryWriter {
  let terminalHead = options.terminalHead ? { ...options.terminalHead } : null;
  let stopped = false;
  let lastSignature: string | null = null;
  let writes = Promise.resolve();

  const unsubscribe = options.session.subscribe((update) => {
    if (stopped) return;
    if (update.status.kind === 'void') {
      const head = options.session.getCommittedHead();
      const signature = `void:${head.seq}:${head.hash}`;
      if (lastSignature === signature) return;
      lastSignature = signature;
      writes = writes.then(async () => {
        try {
          await saveOnlineGameVoid(options.store, {
            gameId: options.gameId,
            genesisDigest: options.genesisDigest,
            head,
          });
        } catch (error) {
          if (lastSignature === signature) lastSignature = null;
          reportError(options, error);
        }
        return undefined;
      });
      return;
    }
    if (!update.state.result) return;
    const head = options.session.getCommittedHead();
    terminalHead ??= { ...head };
    const audit = update.audit ?? options.session.getAudit();
    const localSeat = options.session.controllableSeats().includes(options.localHumanSeat)
      ? options.localHumanSeat
      : null;
    const writeInput = {
      gameId: options.gameId,
      genesisDigest: options.genesisDigest,
      head,
      terminalHead,
      state: {
        config: { seats: [...update.state.config.seats] },
        seats: update.state.seats.map(({ seat, publicVp }) => ({ seat, publicVp })),
        result: update.state.result ? { ...update.state.result } : null,
      },
      localSeat,
      audit,
    };
    let signature: string;
    try {
      signature = toBase64Url(
        canonicalEncode({
          gameId: writeInput.gameId,
          genesisDigest: writeInput.genesisDigest,
          head: writeInput.head,
          terminalHead: writeInput.terminalHead,
          terminal: update.state.result,
          seats: update.state.seats.map((seat) => ({ seat: seat.seat, publicVp: seat.publicVp })),
          localSeat,
          audit: auditSignature(audit),
        }),
      );
    } catch (error) {
      reportError(options, error);
      return;
    }
    if (lastSignature === signature) return;
    lastSignature = signature;

    writes = writes.then(() => persist(writeInput, signature));
  });

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      lastSignature = null;
    },
    async flush() {
      await writes;
    },
  };

  async function persist(
    input: Parameters<typeof saveOnlineGameOutcome>[1],
    signature: string,
  ): Promise<void> {
    try {
      await saveOnlineGameOutcome(options.store, input);
    } catch (error) {
      if (lastSignature === signature) lastSignature = null;
      reportError(options, error);
    }
  }
}
