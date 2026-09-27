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

test('rejects malformed takeover eligibility seats before dispatch', () => {
  replies.length = 0;
  send({
    protocol: ONLINE_WORKER_PROTOCOL,
    generation: 'generation-one',
    id: 10,
    body: { kind: 'canRequestTakeover', departedSeat: 12 },
  });
  expect(replies).toMatchObject([
    { kind: 'canRequestTakeover', result: { ok: false, error: { code: 'online-worker-request' } } },
  ]);
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

test('dispatches every transfer request kind instead of silently dropping it', async () => {
  replies.length = 0;
  const token = 'A'.repeat(43);
  const head = { seq: 1, hash: 'a'.repeat(64) };
  const bootstrapBytes = Uint8Array.of(1);
  const bodies = [
    {
      kind: 'initializeTransfer',
      self: token,
      attemptId: token,
      mode: 'open',
      expected: { gameId: 'g'.repeat(22), genesisDigest: token },
      bootstrapBytes,
      importedArchiveId: 'a'.repeat(64),
    },
    { kind: 'transferSnapshot' },
    { kind: 'prepareTransferOffer', seat: 0, mode: 'live' },
    { kind: 'refreshTransferBootstrap', bootstrapBytes },
    { kind: 'importTransferPacket', packet: { protocol: 'invalid-test-packet' } },
    { kind: 'prepareTransferReadiness' },
    { kind: 'observeTransferActivation', bootstrapBytes },
    { kind: 'observeTransferCancellation', bootstrapBytes },
    { kind: 'exportTransferBootstrap', throughSeq: 1 },
    { kind: 'transferStatus', authorization: head },
    { kind: 'authorizeLiveTransfer', offer: {}, head },
    { kind: 'submitTransfer', change: {}, head },
    { kind: 'prepareTransferPrivate', authorization: head },
  ];
  for (const [index, body] of bodies.entries())
    send({ protocol: ONLINE_WORKER_PROTOCOL, generation: 'generation-one', id: 100 + index, body });
  await vi.waitFor(() => expect(replies).toHaveLength(bodies.length));
  expect(replies).toEqual(
    expect.arrayContaining(bodies.map((body) => expect.objectContaining({ kind: body.kind }))),
  );
});

test('rejects malformed transfer bodies promptly without echoing private content', () => {
  replies.length = 0;
  const privateText = 'private-transfer-witness-do-not-echo';
  send({
    protocol: ONLINE_WORKER_PROTOCOL,
    generation: 'generation-one',
    id: 200,
    body: { kind: 'initializeTransfer', self: 'wrong', bootstrapBytes: privateText },
  });
  send({
    protocol: ONLINE_WORKER_PROTOCOL,
    generation: 'generation-one',
    id: 203,
    body: {
      kind: 'initializeTransfer',
      self: 'A'.repeat(43),
      attemptId: 'A'.repeat(43),
      mode: 'open',
      expected: { gameId: 'g'.repeat(22), genesisDigest: 'A'.repeat(43) },
      importedArchiveId: 'not-a-content-hash',
    },
  });
  send({
    protocol: ONLINE_WORKER_PROTOCOL,
    generation: 'generation-one',
    id: 201,
    body: { kind: 'exportTransferBootstrap', throughSeq: -1, payload: privateText },
  });
  expect(replies).toMatchObject([
    { kind: 'initializeTransfer', result: { ok: false, error: { code: 'online-worker-request' } } },
    { kind: 'initializeTransfer', result: { ok: false, error: { code: 'online-worker-request' } } },
    {
      kind: 'exportTransferBootstrap',
      result: { ok: false, error: { code: 'online-worker-request' } },
    },
  ]);
  expect(JSON.stringify(replies)).not.toContain(privateText);
});

test('admits a bounded transfer bootstrap above the ordinary worker request limit', async () => {
  replies.length = 0;
  send({
    protocol: ONLINE_WORKER_PROTOCOL,
    generation: 'generation-one',
    id: 202,
    body: {
      kind: 'refreshTransferBootstrap',
      bootstrapBytes: new Uint8Array(MAX_ONLINE_WORKER_REQUEST_BYTES + 1),
    },
  });
  await vi.waitFor(() => expect(replies).toHaveLength(1));
  expect(replies).toMatchObject([{ kind: 'refreshTransferBootstrap', result: { ok: false } }]);
  expect(replies).not.toMatchObject([{ result: { error: { code: 'online-worker-request' } } }]);
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
