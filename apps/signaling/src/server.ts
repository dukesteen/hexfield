import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { SERVER_BUFFER_LIMIT, SERVER_WIRE_LIMIT } from '@cp2p/p2p/server-signaling-wire';
import { RoomCore } from './room-core.js';

const MAX_SOCKETS = 256;
const HEARTBEAT_MS = 15_000;
const roomPath = /^\/room\/([a-z2-7]{10})$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });

export interface SignalingServer {
  readonly port: number;
  close(): Promise<void>;
}

/** Close a recipient instead of accumulating an unbounded ws send queue. */
export function sendServerFrame(ws: WebSocket, text: string, onFailure: () => void): void {
  if (ws.readyState !== WebSocket.OPEN) throw new Error('Socket is not open');
  if (ws.bufferedAmount + Buffer.byteLength(text, 'utf8') > SERVER_BUFFER_LIMIT)
    throw new Error('Slow signaling recipient');
  ws.send(text, (error) => {
    if (error) onFailure();
  });
}

/** A socket without a pong by the next heartbeat cannot retain a room slot. */
export function pingOrTerminate(ws: WebSocket, awaitingPong: WeakSet<WebSocket>): void {
  if (awaitingPong.has(ws)) {
    ws.terminate();
    return;
  }
  if (ws.readyState !== WebSocket.OPEN) return;
  awaitingPong.add(ws);
  try {
    ws.ping();
  } catch {
    ws.terminate();
  }
}

/** Plain HTTP/ws host for TLS termination upstream; no SDP or envelope logging. */
export async function startSignalingServer(
  port = 3_009,
  host = '127.0.0.1',
): Promise<SignalingServer> {
  const core = new RoomCore(() => performance.now());
  const server = createServer((request, response) => {
    if (request.url === '/healthz') {
      response.writeHead(200, {
        'content-type': 'text/plain',
        'access-control-allow-origin': '*',
      });
      response.end('ok');
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: SERVER_WIRE_LIMIT,
    perMessageDeflate: false,
  });
  const awaitingPong = new WeakSet<WebSocket>();
  server.on('upgrade', (request, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    const roomId = roomPath.exec(pathname)?.[1];
    if (!roomId || sockets.clients.size >= MAX_SOCKETS) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      sockets.emit('connection', ws, request, roomId);
    });
  });
  sockets.on('connection', (ws: WebSocket, _request: IncomingMessage, roomId: string) => {
    let id = 0;
    try {
      id = core.open(roomId, {
        send: (text) =>
          sendServerFrame(ws, text, () => {
            if (id) core.disconnect(id);
            ws.terminate();
          }),
        close: (code, reason) => ws.close(code, reason),
      });
    } catch {
      ws.close(1011, 'open-failed');
      return;
    }
    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        ws.close(1003, 'text-required');
        core.disconnect(id);
        return;
      }
      try {
        const bytes =
          raw instanceof ArrayBuffer
            ? new Uint8Array(raw)
            : Array.isArray(raw)
              ? Buffer.concat(raw)
              : raw;
        core.receive(id, utf8.decode(bytes));
      } catch {
        ws.close(1007, 'invalid-utf8');
        core.disconnect(id);
      }
    });
    ws.on('close', () => core.disconnect(id));
    ws.on('error', () => core.disconnect(id));
    ws.on('pong', () => awaitingPong.delete(ws));
  });
  const sweep = setInterval(() => core.sweep(), 1_000);
  const heartbeat = setInterval(() => {
    for (const ws of sockets.clients) pingOrTerminate(ws, awaitingPong);
  }, HEARTBEAT_MS);
  try {
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(port, host, () => {
        server.off('error', fail);
        done();
      });
    });
  } catch (error) {
    clearInterval(sweep);
    clearInterval(heartbeat);
    sockets.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing signaling port');
  return {
    port: address.port,
    close: async () => {
      clearInterval(sweep);
      clearInterval(heartbeat);
      for (const ws of sockets.clients) ws.terminate();
      await new Promise<void>((done) => sockets.close(() => done()));
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT ?? '3009');
  const host = process.env.HOST ?? '0.0.0.0';
  void (async () => {
    try {
      const { port: bound } = await startSignalingServer(port, host);
      process.stdout.write(`signaling listening on ${host}:${bound}\n`);
    } catch (error) {
      process.stderr.write(
        `signaling failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  })();
}
