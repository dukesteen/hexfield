import { hashValue, toHex } from '@cp2p/codec';
import type { Input, Seat } from '@cp2p/engine';
import { DEFAULT_BOT_DELAY_MS } from '@cp2p/protocol';
import { createLocalReplay, parseLocalReplay } from '../../queries/transfers.js';
import type { LocalReplay } from '../../queries/transfers.js';
import type { GamePresentation } from '../../queries/repositories/saved-games.js';
import type { PublicArchiveReplay } from '../../session/online-public-archive-worker.js';
import { PLAYER_COLORS, PLAYER_SEATS, PLAYER_SHAPES } from '../players/identity.js';
import { onlineReplayDocument } from './replay-document.js';
import type { LocalReplayDocument, ReplayDocument } from './replay-document.js';
import { ReplaySession } from './replay-session.js';

/** What the viewer exports: a JSON file to download and the document behind the string. */
export interface ReplayExport {
  readonly fileName: string;
  readonly json: unknown;
  readonly document: ReplayDocument;
}

export interface LoadedReplay {
  readonly session: ReplaySession<ReplayExport>;
  readonly presentation: GamePresentation;
  readonly source: 'local' | 'online';
}

function built(
  transcript: Parameters<typeof ReplaySession.create<ReplayExport>>[0],
): ReplaySession<ReplayExport> {
  const session = ReplaySession.create(transcript);
  if (!session.ok) throw new Error(`${session.error.code}: ${session.error.message}`);
  return session.value;
}

function defaultPresentation(
  seats: readonly Seat[],
  playerName: (seat: Seat) => string,
): GamePresentation {
  return {
    players: seats.map((seat, index) => {
      const displaySeat = PLAYER_SEATS.find((candidate) => candidate === seat);
      if (displaySeat === undefined) throw new Error('Replay has unsupported seats');
      return {
        seat: displaySeat,
        name: playerName(seat),
        color: PLAYER_COLORS[index] ?? 'blue',
        shape: PLAYER_SHAPES[index] ?? 'circle',
      };
    }),
    botDelayMs: DEFAULT_BOT_DELAY_MS,
  };
}

/** A verified local replay: every input carries its own identities, so all hands are known. */
function fromLocalReplay(
  replay: LocalReplay,
  name: string,
  playerName: (seat: Seat) => string,
): LoadedReplay {
  const { save } = replay;
  const inputs: Input[] = [
    ...save.genesis,
    ...save.batches.flatMap((batch) => [batch.submitted, ...batch.generated]),
  ];
  const presentation = replay.presentation ?? defaultPresentation(save.config.seats, playerName);
  const document: LocalReplayDocument = {
    format: 'hexfield-replay',
    v: 1,
    kind: 'local',
    save,
    presentation,
  };
  const session = built({
    config: save.config,
    genesisSeed: save.genesisSeed,
    inputs,
    privateData: [],
    document: { fileName: `${name}.replay.json`, json: replay, document },
  });
  if (session.finalStateHash !== save.finalHash)
    throw new Error('Replay differs from its saved final state');
  return { session, presentation, source: 'local' };
}

/** A saved local game (verified again by replaying its whole save). */
export function loadLocalGameReplay(
  record: { readonly id: string; readonly save: unknown; readonly presentation: GamePresentation },
  playerName: (seat: Seat) => string,
): LoadedReplay {
  return fromLocalReplay(
    createLocalReplay(record.save, record.presentation),
    record.id,
    playerName,
  );
}

/** A local replay from an imported file or string. */
export function loadLocalReplay(
  source: { readonly document: LocalReplayDocument } | { readonly file: unknown },
  playerName: (seat: Seat) => string,
): LoadedReplay {
  const replay =
    'file' in source
      ? parseLocalReplay(source.file)
      : createLocalReplay(source.document.save, source.document.presentation);
  return fromLocalReplay(replay, 'hexfield', playerName);
}

/** An archive the public-archive worker verified (and audited, when it had the masters). */
export function loadOnlineReplay(archive: PublicArchiveReplay): LoadedReplay {
  const presentation: GamePresentation = {
    players: archive.players.map((player) => ({
      ...player,
      shape: PLAYER_SHAPES[player.seat],
    })),
    botDelayMs: 0,
  };
  const document = onlineReplayDocument(archive.bytes, archive.masters);
  const session = built({
    config: archive.config,
    genesisSeed: archive.genesisSeed,
    inputs: archive.inputs,
    privateData: archive.privateData,
    document: { fileName: `hexfield-${archive.gameId}.replay.json`, json: document, document },
  });
  if (session.finalStateHash !== toHex(hashValue(archive.state)))
    throw new Error('Replay differs from its certified final state');
  return { session, presentation, source: 'online' };
}
