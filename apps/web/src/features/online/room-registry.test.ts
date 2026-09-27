import { identityFromSecret } from '@cp2p/crypto';
import type { GameConfig, Seat } from '@cp2p/engine';
import { success } from '@cp2p/engine';
import type { LobbyBotLevel, LobbyRequest, PeerId } from '@cp2p/protocol';
import { describe, expect, test, vi } from 'vitest';
import type { OnlineRoomSnapshot } from '../../session/online-room.js';
import type { OnlineInvite } from '../../session/online-invite.js';
import {
  beginOnlineRoomOpen,
  closeOnlineRoom,
  getOnlineGameRoom,
  getOnlineRoom,
} from './room-registry.js';
import type { OnlineRoomHandleValue } from './room-registry.js';

function peer(seed: number): PeerId {
  const identity = identityFromSecret(new Uint8Array(32).fill(seed));
  identity.secretKey.fill(0);
  return identity.peerId;
}

function makeRoom(invite: OnlineInvite, gameId?: string) {
  let closed = false;
  const lobby: OnlineRoomHandleValue['lobby'] = {
    request: (_action: LobbyRequest) => success(undefined),
    configure: (_config: GameConfig) => success(undefined),
    setBot: (_seat: Seat, _level: LobbyBotLevel, _host?: PeerId) => success(undefined),
    openSeat: (_seat: Seat) => success(undefined),
    kick: (_peer: PeerId) => success(undefined),
    start: (_nonce: string) => success(undefined),
  };
  const snapshot: OnlineRoomSnapshot = {
    invite,
    self: invite.hostPeer,
    signaling: { state: 'connecting' },
    manual: { phase: 'idle', code: null, peer: null, gatheringComplete: null, error: null },
    peers: [],
    lobby: null,
    agreement: null,
    diagnostic: null,
    connectionError: null,
    startup: gameId
      ? { phase: 'opening', gameId, awaitingSeats: [], locallyConsented: true, error: null }
      : null,
    closed: false,
  };
  const room: OnlineRoomHandleValue = {
    invite,
    lobby,
    startGame: () => success(undefined),
    retryStart: async () => success(undefined),
    getGame: () => null,
    getSnapshot: () => ({ ...snapshot, closed }),
    subscribe: () => () => undefined,
    close: vi.fn<() => Promise<void>>(async () => {
      closed = true;
    }),
  };
  return { room, isClosed: () => closed };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve: (value: T) => resolve(value) };
}

describe('online room registry', () => {
  test('reuses a restoring game before its session is ready', async () => {
    const invite = { roomId: 'resumeroom', hostPeer: peer(5), serverUrl: 'ws://one.test' };
    const fixture = makeRoom(invite, 'restore-game');
    const first = beginOnlineRoomOpen(
      'resume:restore-game',
      { kind: 'resume', gameId: 'restore-game' },
      async () => fixture.room,
    );
    expect(await first.promise).toBe(fixture.room);
    first.keep();
    const duplicate = vi.fn<() => Promise<OnlineRoomHandleValue>>(async () => fixture.room);
    const second = beginOnlineRoomOpen(
      'another-resume',
      { kind: 'resume', gameId: 'restore-game' },
      duplicate,
    );
    expect(await second.promise).toBe(fixture.room);
    expect(getOnlineGameRoom('restore-game')).toBe(fixture.room);
    expect(duplicate).not.toHaveBeenCalled();
    second.cancel();
    expect(fixture.isClosed()).toBe(false);
    await closeOnlineRoom(invite.roomId);
  });

  test('a pending resume key cannot be reused for another game', async () => {
    const invite = { roomId: 'resumetwoa', hostPeer: peer(6), serverUrl: 'ws://one.test' };
    const opening = deferred<OnlineRoomHandleValue>();
    const first = beginOnlineRoomOpen(
      'shared-resume',
      { kind: 'resume', gameId: 'game-one' },
      () => opening.promise,
    );
    const rejected = beginOnlineRoomOpen(
      'shared-resume',
      { kind: 'resume', gameId: 'game-two' },
      async () => makeRoom(invite).room,
    );
    await expect(rejected.promise).rejects.toThrow('different room request');
    const fixture = makeRoom(invite, 'game-one');
    opening.resolve(fixture.room);
    expect(await first.promise).toBe(fixture.room);
    await closeOnlineRoom(invite.roomId);
  });

  test('a resumed game cannot silently reuse a live lobby with the same invitation', async () => {
    const invite = { roomId: 'resumethre', hostPeer: peer(7), serverUrl: 'ws://one.test' };
    const lobby = makeRoom(invite);
    const joined = beginOnlineRoomOpen(
      'existing-lobby',
      { kind: 'join', invite },
      async () => lobby.room,
    );
    await joined.promise;
    joined.keep();
    const game = makeRoom(invite, 'other-game');
    const resume = beginOnlineRoomOpen(
      'other-game',
      { kind: 'resume', gameId: 'other-game' },
      async () => game.room,
    );
    await expect(resume.promise).rejects.toThrow('different game or lobby');
    expect(game.isClosed()).toBe(true);
    expect(lobby.isClosed()).toBe(false);
    expect(getOnlineRoom(invite.roomId)).toBe(lobby.room);
    await closeOnlineRoom(invite.roomId);
  });

  test('StrictMode cleanup cancels one caller while a remount keeps the shared opening', async () => {
    const invite = { roomId: 'aaaaaaaaaa', hostPeer: peer(1), serverUrl: 'ws://one.test' };
    const open = deferred<OnlineRoomHandleValue>();
    const opener = vi.fn<() => Promise<OnlineRoomHandleValue>>(() => open.promise);
    const first = beginOnlineRoomOpen('strict-join', { kind: 'join', invite }, opener);
    const firstOutcome = first.promise.then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    first.cancel();

    const second = beginOnlineRoomOpen('strict-join', { kind: 'join', invite }, opener);
    const fixture = makeRoom(invite);
    open.resolve(fixture.room);

    const [firstResult, secondRoom] = await Promise.all([firstOutcome, second.promise]);
    expect(firstResult).toMatchObject({ kind: 'rejected', error: { name: 'AbortError' } });
    expect(opener).toHaveBeenCalledTimes(1);
    expect(secondRoom).toBe(fixture.room);
    second.keep();
    second.cancel();
    expect(fixture.isClosed()).toBe(false);
    expect(getOnlineRoom(invite.roomId)).toBe(fixture.room);

    await closeOnlineRoom(invite.roomId);
    expect(fixture.isClosed()).toBe(true);
  });

  test('rejects conflicting host or server pins for an occupied room code', async () => {
    const invite = { roomId: 'bbbbbbbbbb', hostPeer: peer(2), serverUrl: 'ws://one.test' };
    const fixture = makeRoom(invite);
    const first = beginOnlineRoomOpen(
      'original',
      { kind: 'join', invite },
      async () => fixture.room,
    );
    const opened = await first.promise;
    first.keep();
    expect(opened).toBe(fixture.room);

    const conflicts = [
      { ...invite, hostPeer: peer(3) },
      { ...invite, serverUrl: 'wss://other.test' },
    ];
    const attempts = conflicts.map((conflict) => {
      const opener = vi.fn<() => Promise<OnlineRoomHandleValue>>(
        async () => makeRoom(conflict).room,
      );
      const handle = beginOnlineRoomOpen('conflict', { kind: 'join', invite: conflict }, opener);
      return { handle, opener };
    });
    const outcomes = await Promise.all(
      attempts.map(({ handle }) =>
        handle.promise.then(
          () => null,
          (error: unknown) => error,
        ),
      ),
    );
    for (const outcome of outcomes)
      expect(outcome).toMatchObject({ message: expect.stringContaining('Invitation conflicts') });
    for (const attempt of attempts) expect(attempt.opener).not.toHaveBeenCalled();

    await closeOnlineRoom(invite.roomId);
  });

  test('same-invite race closes only its redundant room and retains the registered room', async () => {
    const invite = { roomId: 'cccccccccc', hostPeer: peer(4), serverUrl: 'ws://one.test' };
    const firstOpen = deferred<OnlineRoomHandleValue>();
    const secondOpen = deferred<OnlineRoomHandleValue>();
    const first = beginOnlineRoomOpen(
      'race-one',
      { kind: 'join', invite },
      () => firstOpen.promise,
    );
    const second = beginOnlineRoomOpen(
      'race-two',
      { kind: 'join', invite },
      () => secondOpen.promise,
    );
    const primary = makeRoom(invite);
    const redundant = makeRoom(invite);
    firstOpen.resolve(primary.room);
    expect(await first.promise).toBe(primary.room);
    first.keep();
    secondOpen.resolve(redundant.room);
    expect(await second.promise).toBe(primary.room);
    expect(redundant.isClosed()).toBe(true);
    second.cancel();
    expect(primary.isClosed()).toBe(false);
    expect(getOnlineRoom(invite.roomId)).toBe(primary.room);

    await closeOnlineRoom(invite.roomId);
  });
});
