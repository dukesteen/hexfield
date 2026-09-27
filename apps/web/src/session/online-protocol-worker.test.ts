import { afterAll, expect, test, vi } from 'vitest';
import {
  MAX_ONLINE_WORKER_REQUEST_BYTES,
  ONLINE_WORKER_PROTOCOL,
} from './online-worker-messages.js';

const replies: unknown[] = [];
let receive: ((event: MessageEvent<unknown>) => void) | null = null;

vi.stubGlobal('postMessage', (reply: unknown) => replies.push(reply));
vi.stubGlobal(
  'addEventListener',
  (type: string, listener: (event: MessageEvent<unknown>) => void) => {
    if (type === 'message') receive = listener;
  },
);

await import('./online-protocol-worker.js');

afterAll(() => vi.unstubAllGlobals());

function send(value: unknown): void {
  if (!receive) throw new Error('Worker message listener was not registered');
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only the event data is read by the dedicated-worker listener.
  receive({ data: value } as MessageEvent<unknown>);
}

test('rejects a malformed known request promptly without reflecting its body', () => {
  replies.length = 0;
  const secret = 'private-witness-do-not-echo';
  send({
    protocol: ONLINE_WORKER_PROTOCOL,
    generation: 'generation-one',
    id: 7,
    body: {
      kind: 'validate',
      seat: 0,
      head: { seq: 0, hash: 'not-a-hash' },
      command: { type: secret },
    },
  });
  expect(replies).toEqual([
    {
      protocol: ONLINE_WORKER_PROTOCOL,
      generation: 'generation-one',
      id: 7,
      kind: 'validate',
      result: {
        ok: false,
        error: { code: 'online-worker-request', message: 'Malformed online worker request' },
      },
    },
  ]);
  expect(JSON.stringify(replies)).not.toContain(secret);
});

test('rejects an oversized known request without reflecting its payload', () => {
  replies.length = 0;
  const payload = 'x'.repeat(MAX_ONLINE_WORKER_REQUEST_BYTES);
  send({
    protocol: ONLINE_WORKER_PROTOCOL,
    generation: 'generation-one',
    id: 8,
    body: { kind: 'pinFreeze', state: { name: payload } },
  });
  expect(replies).toHaveLength(1);
  expect(JSON.stringify(replies).length).toBeLessThan(300);
});

test('does not echo malformed, unknown or unbounded reply headers', () => {
  replies.length = 0;
  const base = { protocol: ONLINE_WORKER_PROTOCOL, generation: 'generation-one', id: 9 };
  send({ ...base, id: 0, body: { kind: 'retryStart' } });
  send({ ...base, generation: 'x'.repeat(257), body: { kind: 'retryStart' } });
  send({ ...base, body: { kind: 'unknown-operation' } });
  send({ ...base, protocol: 'wrong-protocol', body: { kind: 'retryStart' } });
  expect(replies).toEqual([]);
});
