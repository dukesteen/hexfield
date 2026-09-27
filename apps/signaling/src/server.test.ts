import { identityFromSecret } from '@cp2p/crypto';
import { ServerSignalingAdapter } from '@cp2p/p2p';
import { signSignalEnvelope } from '@cp2p/p2p';
import { SERVER_BUFFER_LIMIT } from '@cp2p/p2p/server-signaling-wire';
import type { ProtocolClock } from '@cp2p/protocol';
import { WebSocket } from 'ws';
import { describe, expect, test } from 'vitest';
import { pingOrTerminate, sendServerFrame, startSignalingServer } from './server.js';

const clock: ProtocolClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ProtocolClock stores the native Node timer as an opaque handle.
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

function makeAdapter(port: number, seed: number) {
  const identity = identityFromSecret(new Uint8Array(32).fill(seed));
  const adapter = new ServerSignalingAdapter({
    serverUrl: `ws://127.0.0.1:${port}`,
    roomId: 'aaaaaaaaaa',
    self: identity.peerId,
    secretKey: identity.secretKey,
    clock,
    socketFactory: (url) => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ws implements the browser WebSocket event surface used by the adapter.
      return new WebSocket(url) as unknown as globalThis.WebSocket;
    },
  });
  return { identity, adapter };
}

describe('localhost signaling host', () => {
  test('exposes health status to browser diagnostics on another origin', async () => {
    const server = await startSignalingServer(0);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/healthz`, {
        headers: { Origin: 'https://game.example.test' },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(await response.text()).toBe('ok');
    } finally {
      await server.close();
    }
  });

  test('joins two authenticated ws clients and relays a signed envelope', async () => {
    const server = await startSignalingServer(0);
    const a = makeAdapter(server.port, 1);
    const b = makeAdapter(server.port, 2);
    try {
      const first = signSignalEnvelope(
        {
          version: 2,
          scope: 'test-lobby',
          from: a.identity.peerId,
          to: b.identity.peerId,
          attemptId: 'AQEBAQEBAQEBAQEBAQEBAQ',
          sessionId: 'AwMDAwMDAwMDAwMDAwMDAw',
          attemptSeq: 1,
          blob: {
            kind: 'description',
            generation: 1,
            revision: 1,
            description: { type: 'offer', sdp: 'v=0\r\n' },
          },
        },
        a.identity.secretKey,
      );
      const second = signSignalEnvelope(
        {
          ...first.body,
          from: b.identity.peerId,
          to: a.identity.peerId,
          blob: {
            kind: 'description',
            generation: 1,
            revision: 1,
            description: { type: 'offer', sdp: 'v=0\r\n' },
          },
        },
        b.identity.secretKey,
      );
      const received: { from: string; value: unknown }[] = [];
      b.adapter.onSignal((from, value) => {
        received.push({ from, value });
      });
      await Promise.all([
        a.adapter.send(b.identity.peerId, first),
        b.adapter.send(a.identity.peerId, second),
      ]);
      await expect.poll(() => received.length, { timeout: 2_000 }).toBe(1);
      expect(received).toEqual([{ from: a.identity.peerId, value: first }]);
    } finally {
      a.adapter.close();
      b.adapter.close();
      await server.close();
    }
  });

  test('host refuses a slow recipient before its ws queue can grow', () => {
    const sent: string[] = [];
    const fake = {
      readyState: WebSocket.OPEN,
      bufferedAmount: SERVER_BUFFER_LIMIT - 1,
      send: (text: string) => {
        sent.push(text);
      },
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- bounded send is tested with a minimal ws fake.
    expect(() => sendServerFrame(fake as unknown as WebSocket, 'Ω', () => undefined)).toThrow(
      'Slow signaling recipient',
    );
    expect(sent).toEqual([]);
  });

  test('heartbeat terminates a socket missing the next pong and accepts a live pong', () => {
    let pings = 0;
    let terminations = 0;
    const fake = {
      readyState: WebSocket.OPEN,
      ping: () => {
        pings += 1;
      },
      terminate: () => {
        terminations += 1;
      },
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- heartbeat only uses this ws surface.
    const ws = fake as unknown as WebSocket;
    const awaitingPong = new WeakSet<WebSocket>();
    pingOrTerminate(ws, awaitingPong);
    expect(pings).toBe(1);
    expect(terminations).toBe(0);
    awaitingPong.delete(ws); // The host's pong listener performs this removal.
    pingOrTerminate(ws, awaitingPong);
    expect(pings).toBe(2);
    pingOrTerminate(ws, awaitingPong);
    expect(terminations).toBe(1);
  });

  test('an asynchronous ws send error calls the host failure handler', () => {
    let failed = 0;
    const fake = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: (_text: string, done: (error: Error) => void) => done(new Error('closed')),
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- bounded send is tested with a minimal ws fake.
    sendServerFrame(fake as unknown as WebSocket, 'x', () => {
      failed += 1;
    });
    expect(failed).toBe(1);
  });
});
