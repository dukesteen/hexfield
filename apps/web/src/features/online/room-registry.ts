import { OnlineRoom } from '../../session/online-room.js';
import { OnlineIce } from '../../session/online-ice.js';
import { loadOnlineConnectionSettings } from '../../queries/network.js';
import type { OpenOnlineRoom } from '../../session/online-room.js';
import type { OnlineRoomSnapshot } from '../../session/online-room.js';
import type { OnlineInvite } from '../../session/online-invite.js';
import type { GameSession, LobbyController } from '@cp2p/protocol';
import type { Unsubscribe } from '@cp2p/protocol';
import type { OnlineGame } from '../../session/online-game.js';
import type { WebRtcPeerStats } from '@cp2p/p2p';
import type { Result } from '@cp2p/engine';
import type { Seat } from '@cp2p/engine';
import type { PeerId } from '@cp2p/protocol';
import type { ChatContent } from '../../session/online-chat.js';

type OnlineLobbyController = Pick<
  LobbyController,
  'request' | 'configure' | 'setBot' | 'openSeat' | 'kick' | 'start'
>;

export interface OnlineRoomHandleValue {
  readonly invite: OnlineInvite;
  readonly lobby: OnlineLobbyController | null;
  startManualInvitation?: OnlineRoom['startManualInvitation'];
  acceptManualAnswer?: OnlineRoom['acceptManualAnswer'];
  answerManualOffer?: OnlineRoom['answerManualOffer'];
  cancelManualInvitation?: OnlineRoom['cancelManualInvitation'];
  startGame: () => Result<void>;
  retryStart: () => Promise<Result<void>>;
  getGame: () => OnlineGame<GameSession> | null;
  getPeerStats?: () => Promise<readonly WebRtcPeerStats[]>;
  startTransfer?: OnlineRoom['startTransfer'];
  returnableSeats?: () => Promise<readonly Seat[]>;
  sendChat?: (content: ChatContent) => Promise<Result<void>>;
  muteChat?: (peer: PeerId, muted: boolean) => Promise<Result<void>>;
  getSnapshot: () => OnlineRoomSnapshot;
  subscribe: (listener: () => void) => Unsubscribe;
  close: () => Promise<void>;
}

type OnlineRoomOpener = (request: OpenOnlineRoom) => Promise<OnlineRoomHandleValue>;

interface PendingRoomOpen {
  readonly request: OpenOnlineRoom;
  references: number;
  kept: boolean;
  ownsRoom: boolean;
  room: OnlineRoomHandleValue | null;
  invite: OnlineInvite | null;
  promise: Promise<OnlineRoomHandleValue>;
}

export interface RoomOpenHandle {
  readonly promise: Promise<OnlineRoomHandleValue>;
  /** Keep an opened room alive after the caller navigates away. */
  keep(): void;
  /** Cancel this caller's interest; an unclaimed room is closed when no callers remain. */
  cancel(): void;
}

const rooms = new Map<string, OnlineRoomHandleValue>();
const openings = new Map<string, PendingRoomOpen>();

function sameInvite(left: OnlineInvite, right: OnlineInvite): boolean {
  return (
    left.roomId === right.roomId &&
    left.hostPeer === right.hostPeer &&
    left.serverUrl === right.serverUrl
  );
}

function rejectedOpen(error: Error): RoomOpenHandle {
  const fail = async () => {
    throw error;
  };
  return { promise: fail(), keep() {}, cancel() {} };
}

function aborted(): Error {
  return new DOMException('Online room opening was cancelled', 'AbortError');
}

export function getOnlineRoom(lobbyId: string): OnlineRoomHandleValue | null {
  const room = rooms.get(lobbyId);
  if (!room) return null;
  if (room.getSnapshot().closed) {
    if (rooms.get(lobbyId) === room) rooms.delete(lobbyId);
    return null;
  }
  return room;
}

export function getOnlineGameRoom(gameId: string): OnlineRoomHandleValue | null {
  return (
    [...rooms.values()].find(
      (room) =>
        !room.getSnapshot().closed &&
        (room.getGame()?.gameId === gameId || room.getSnapshot().startup?.gameId === gameId),
    ) ?? null
  );
}

export function beginOnlineRoomOpen(
  key: string,
  request: OpenOnlineRoom,
  openRoom: OnlineRoomOpener = openConfiguredRoom,
): RoomOpenHandle {
  if (request.kind === 'resume') {
    const existing = getOnlineGameRoom(request.gameId);
    if (existing) return { promise: Promise.resolve(existing), keep() {}, cancel() {} };
  }
  if (request.kind === 'join') {
    const existing = getOnlineRoom(request.invite.roomId);
    if (existing) {
      if (!sameInvite(existing.invite, request.invite))
        return rejectedOpen(
          new Error('Invitation conflicts with the room already open in this tab'),
        );
      return { promise: Promise.resolve(existing), keep() {}, cancel() {} };
    }
  }

  let opening = openings.get(key);
  if (
    opening &&
    (opening.request.kind !== request.kind ||
      (opening.request.kind === 'resume' &&
        request.kind === 'resume' &&
        opening.request.gameId !== request.gameId) ||
      (opening.request.kind === 'manual-join' &&
        request.kind === 'manual-join' &&
        opening.request.offerCode !== request.offerCode))
  )
    return rejectedOpen(new Error('A different room request already uses this opening key'));
  if (opening?.invite && request.kind === 'join' && !sameInvite(opening.invite, request.invite))
    return rejectedOpen(new Error('Invitation conflicts with a room opening already in progress'));
  if (!opening) {
    const opened = openRoom(request);
    const state: PendingRoomOpen = {
      request,
      references: 0,
      kept: false,
      ownsRoom: false,
      room: null,
      invite: request.kind === 'join' ? request.invite : null,
      promise: opened.then(async (room) => {
        state.room = room;
        state.ownsRoom = true;
        if (state.references === 0 && !state.kept) {
          await room.close();
          throw aborted();
        }
        const existing = getOnlineRoom(room.invite.roomId);
        if (
          request.kind === 'resume' &&
          existing &&
          existing !== getOnlineGameRoom(request.gameId)
        ) {
          await room.close();
          throw new Error('A different game or lobby is already open in this room');
        }
        if (existing && !sameInvite(existing.invite, room.invite)) {
          await room.close();
          throw new Error('A different pinned invitation already owns this room code');
        }
        if (existing) {
          await room.close();
          state.room = existing;
          state.ownsRoom = false;
          state.kept = true;
          return existing;
        }
        rooms.set(room.invite.roomId, room);
        return room;
      }),
    };
    void state.promise
      .finally(() => {
        if (openings.get(key) === state) openings.delete(key);
      })
      .catch(() => undefined);
    opening = state;
    openings.set(key, opening);
  }
  const pending = opening;
  pending.references += 1;
  let cancelled = false;

  return {
    promise: pending.promise.then((room) => {
      if (cancelled) throw aborted();
      return room;
    }),
    keep() {
      if (!cancelled) pending.kept = true;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      pending.references = Math.max(0, pending.references - 1);
      const room = pending.room;
      if (pending.references !== 0 || pending.kept || !pending.ownsRoom || !room) return;
      if (rooms.get(room.invite.roomId) === room) rooms.delete(room.invite.roomId);
      void room.close().catch(() => undefined);
    },
  };
}

async function openConfiguredRoom(request: OpenOnlineRoom): Promise<OnlineRoom> {
  const settings = await loadOnlineConnectionSettings();
  const ice = new OnlineIce(settings, loadOnlineConnectionSettings);
  try {
    const room = await OnlineRoom.open(request, {
      ...settings,
      rtcFactory: (_peer, configuration) => ice.createConnection(configuration),
      manualRtcFactory: () => ice.createConnection(),
    });
    const unsubscribe = room.subscribe(() => {
      if (!room.getSnapshot().closed) return;
      ice.dispose();
      unsubscribe();
    });
    return room;
  } catch (error) {
    ice.dispose();
    throw error;
  }
}

export async function closeOnlineRoom(lobbyId: string): Promise<void> {
  const room = rooms.get(lobbyId);
  if (!room) return;
  rooms.delete(lobbyId);
  await room.close();
}
