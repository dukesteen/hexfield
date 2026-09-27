import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { identityFromSecret } from '@cp2p/crypto';
import { signRoomJoin } from '@cp2p/p2p/server-signaling-wire';

const origin = process.env.SIGNALING_ORIGIN ?? 'http://127.0.0.1:8791';
const room = [...randomBytes(10)].map((n) => 'abcdefghijklmnopqrstuvwxyz234567'[n % 32]).join('');
const sockets = [];
function open() {
  const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/room/${room}`);
  sockets.push(socket);
  const frames = [];
  const waiters = new Set();
  const close = new Promise((resolve) =>
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  socket.on('message', (data) => {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : Array.isArray(data)
          ? Buffer.concat(data)
          : data;
    const frame = JSON.parse(new TextDecoder().decode(bytes));
    frames.push(frame);
    for (const poll of waiters) poll();
  });
  socket.on('error', () => {});
  function next(predicate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(poll);
        reject(new Error('Expected signaling frame timed out'));
      }, 8000);
      function poll() {
        const at = frames.findIndex(predicate);
        if (at < 0) return;
        const [frame] = frames.splice(at, 1);
        clearTimeout(timer);
        waiters.delete(poll);
        resolve(frame);
      }
      waiters.add(poll);
      poll();
    });
  }
  return { socket, next, close };
}
async function join(identity) {
  const connection = open();
  const challenge = await connection.next((x) => x.type === 'challenge');
  connection.socket.send(
    JSON.stringify(signRoomJoin(room, challenge.challenge, identity.secretKey)),
  );
  await connection.next((x) => x.type === 'peers' && x.peers.includes(identity.peerId));
  return connection;
}
try {
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  assert.equal((await fetch(`${origin}/api/missing`)).status, 404);
  assert.equal((await fetch(`${origin}/api/turn`, { method: 'POST' })).status, 503);
  assert.equal(
    (await fetch(`${origin}/api/turn`, { headers: { Origin: 'https://unrelated.example' } }))
      .status,
    503,
  );
  const a = identityFromSecret(randomBytes(32));
  const b = identityFromSecret(randomBytes(32));
  const first = await join(a);
  const second = await join(b);
  await first.next((x) => x.type === 'peers' && x.peers.length === 2);
  first.socket.send(
    JSON.stringify({ type: 'signal', to: b.peerId, envelope: 'opaque-test-envelope' }),
  );
  assert.deepEqual(await second.next((x) => x.type === 'signal'), {
    type: 'signal',
    from: a.peerId,
    envelope: 'opaque-test-envelope',
  });
  const replacement = await join(a);
  assert.equal((await first.close).reason, 'replaced');
  await delay(11000);
  replacement.socket.send(JSON.stringify({ type: 'signal', to: b.peerId, envelope: 'after-idle' }));
  assert.equal((await second.next((x) => x.type === 'signal')).envelope, 'after-idle');
  const unauthenticated = open();
  await unauthenticated.next((x) => x.type === 'challenge');
  unauthenticated.socket.send(
    JSON.stringify({ type: 'signal', to: b.peerId, envelope: 'rejected' }),
  );
  assert.equal((await unauthenticated.close).code, 1008);
  const binary = open();
  await binary.next((x) => x.type === 'challenge');
  binary.socket.send(new Uint8Array([1, 2, 3]));
  assert.equal((await binary.close).code, 1003);
  const timedOut = open();
  await timedOut.next((x) => x.type === 'challenge');
  const joinStarted = Date.now();
  while (timedOut.socket.readyState === WebSocket.OPEN && Date.now() - joinStarted < 15000) {
    // oxlint-disable-next-line no-await-in-loop -- Observe the server's close frame independently of TCP teardown.
    await delay(100);
  }
  assert.notEqual(timedOut.socket.readyState, WebSocket.OPEN, 'Join deadline did not send close');
  const closeResult = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Close handshake timed out')), 25000);
    timedOut.close.then((result) => {
      clearTimeout(timer);
      return resolve(result);
    }, reject);
  });
  assert.equal(closeResult.reason, 'join-timeout');
  // oxlint-disable-next-line no-console -- This CLI emits only a redacted verification summary.
  console.log(
    JSON.stringify({
      ok: true,
      target: new URL(origin).host,
      checks: [
        'health',
        'API routes',
        'TURN disabled',
        'signed join',
        'opaque relay',
        'identity replacement',
        'idle relay',
        'unauthenticated rejection',
        'binary rejection',
        'join deadline',
      ],
    }),
  );
} finally {
  for (const socket of sockets) socket.close();
}
