import { createBaseEngine } from '@cp2p/engine';
import type { Seat } from '@cp2p/engine';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ONLINE_WORKER_PROTOCOL } from './online-worker-messages.js';
import type { OnlineWorkerRequest, OnlineWorkerSessionSnapshot } from './online-worker-messages.js';
import { OnlineWorkerClient } from './online-worker-client.js';
import type { OnlineProtocolWorkerPort } from './online-worker-client.js';
import { OnlineWorkerSession } from './online-worker-session.js';

class SessionWorker implements OnlineProtocolWorkerPort {
  readonly requests: OnlineWorkerRequest[] = [];
  terminated = false;
  private readonly messageListeners = new Set<unknown>();
  private readonly errorListeners = new Set<unknown>();

  postMessage(message: OnlineWorkerRequest, _transfer: Transferable[]): void {
    this.requests.push(message);
  }

  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: unknown): void {
    if (type === 'message') this.messageListeners.add(listener);
    else this.errorListeners.add(listener);
  }

  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: unknown): void {
    if (type === 'message') this.messageListeners.delete(listener);
    else this.errorListeners.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: unknown): void {
    for (const listener of this.messageListeners)
      if (typeof listener === 'function')
        Reflect.apply(listener, undefined, [new MessageEvent('message', { data })]);
  }

  reply(request: OnlineWorkerRequest, result: unknown): void {
    this.emit({
      protocol: ONLINE_WORKER_PROTOCOL,
      generation: request.generation,
      id: request.id,
      kind: request.body.kind,
      result,
    });
  }
}

const engine = createBaseEngine();
const state = engine.createGame(
  {
    modules: [{ id: 'base', version: '1.0.0' }],
    seats: [0, 1],
    options: { base: { mapLayout: 'random' } },
  },
  new Uint8Array(32),
);

function snapshot(
  seq = 0,
  visibilityToken = 0,
  options: { privateState?: boolean; controllableSeats?: readonly Seat[] } = {},
): OnlineWorkerSessionSnapshot {
  return {
    committedHead: { seq, hash: `head-${seq}` },
    update: {
      revision: seq,
      state,
      events: [],
      pending: [{ kind: 'player', seat: 0, allowed: ['endTurn'] }],
      timers: [
        {
          key: 'turn',
          seat: 0,
          phase: 'main',
          remainingMs: 5_000,
          expiresAt: 5_000,
          paused: false,
        },
      ],
      status: { kind: 'running' },
    },
    events: [],
    localHumanSeat: 0,
    privateState:
      options.privateState === false ? null : { seat: 0, hand: { wood: 2 }, slots: {}, ext: {} },
    legal: { commands: [{ type: 'endTurn' }], templates: [] },
    controllableSeats: options.controllableSeats ?? [0],
    visibilityToken,
  };
}

function setup(initial = snapshot()) {
  const worker = new SessionWorker();
  const client = new OnlineWorkerClient({ worker, generation: 'session-generation' });
  const session = new OnlineWorkerSession(client, initial, () => undefined);
  return { worker, client, session };
}

function latestRequest(worker: SessionWorker, kind: OnlineWorkerRequest['body']['kind']) {
  const request = worker.requests.findLast((item) => item.body.kind === kind);
  if (!request) throw new Error(`Expected ${kind} request`);
  return request;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OnlineWorkerSession', () => {
  test('exposes private state, legal commands, and control only for the local human', async () => {
    const { session, client } = setup();
    expect(session.getPrivate(0)).toMatchObject({ seat: 0, hand: { wood: 2 } });
    expect(session.getPrivate(1)).toBeNull();
    expect(session.getLegalCommands(0).commands).toEqual([{ type: 'endTurn' }]);
    expect(session.getLegalCommands(1)).toEqual({ commands: [], templates: [] });
    expect(session.controllableSeats()).toEqual([0]);
    await expect(session.validate(1, { type: 'endTurn' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'session-inactive' },
    });
    await expect(session.submit(1, { type: 'endTurn' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'session-inactive' },
    });
    client.fail(new Error('test complete'));
  });

  test('rejects snapshots that grant another seat local control', () => {
    const { client } = setup();
    client.fail(new Error('test complete'));
    expect(
      () =>
        new OnlineWorkerSession(
          client,
          snapshot(0, 0, { controllableSeats: [0, 1] }),
          () => undefined,
        ),
    ).toThrow('another seat');
  });

  test('suppresses validation replies after the committed head advances', async () => {
    const { worker, client, session } = setup(snapshot(3));
    const validating = session.validate(0, { type: 'endTurn' });
    const request = latestRequest(worker, 'validate');
    expect(request.body.kind === 'validate' ? request.body.head : null).toEqual({
      seq: 3,
      hash: 'head-3',
    });
    session.accept(snapshot(4));
    worker.reply(request, { ok: true, value: undefined });

    await expect(validating).resolves.toMatchObject({
      ok: false,
      error: { code: 'stale-revision' },
    });
    client.fail(new Error('test complete'));
  });

  test('checks expectedRevision before making a submit RPC', async () => {
    const { worker, client, session } = setup(snapshot(5));
    await expect(
      session.submit(0, { type: 'endTurn' }, { expectedRevision: 4 }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'stale-revision' },
    });
    expect(worker.requests).toHaveLength(0);
    client.fail(new Error('test complete'));
  });

  test('hide clears private data immediately and an older visibility token cannot restore it', async () => {
    const { worker, client, session } = setup();
    session.setPrivateVisible(false);
    expect(session.getPrivate(0)).toBeNull();
    expect(session.getLegalCommands(0)).toEqual({ commands: [], templates: [] });
    const hideRequest = latestRequest(worker, 'setPrivateVisible');
    expect(
      hideRequest.body.kind === 'setPrivateVisible' ? hideRequest.body.visibilityToken : null,
    ).toBe(1);

    session.accept(snapshot(0, 0));
    expect(session.getPrivate(0)).toBeNull();
    worker.reply(hideRequest, { ok: true, value: undefined });
    await Promise.resolve();
    client.fail(new Error('test complete'));
  });

  test('late show reply cannot restore private data after failure, which clears pending timers', async () => {
    const { worker, client, session } = setup();
    session.setPrivateVisible(false);
    const hide = latestRequest(worker, 'setPrivateVisible');
    worker.reply(hide, { ok: true, value: undefined });
    await Promise.resolve();

    session.setPrivateVisible(true);
    const show = latestRequest(worker, 'setPrivateVisible');
    expect(show.body.kind === 'setPrivateVisible' ? show.body.visibilityToken : null).toBe(2);
    session.fail(new Error('worker failed'));
    expect(session.getPrivate(0)).toBeNull();
    expect(session.getTimers()).toEqual([]);
    expect(session.getPending()).toEqual([]);
    expect(session.getState().result).toBeNull();

    worker.reply(show, { ok: true, value: undefined });
    session.accept(snapshot(1, 2));
    expect(session.getPrivate(0)).toBeNull();
    expect(session.getTimers()).toEqual([]);
    expect(session.getPending()).toEqual([]);
    client.fail(new Error('test complete'));
  });
});
