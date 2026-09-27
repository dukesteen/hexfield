import { canonicalEncode } from '@cp2p/codec';
import {
  MAX_ONLINE_WORKER_REQUEST_BYTES,
  ONLINE_WORKER_PROTOCOL,
} from './online-worker-messages.js';
import type { OnlineWorkerRequest } from './online-worker-messages.js';
import { OnlineWorkerRuntime } from './online-worker-runtime.js';

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This entry runs only inside a dedicated worker, whose postMessage has no target origin.
const scope = globalThis as unknown as {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
};

const kinds = new Set<string>([
  'initialize',
  'attachTransport',
  'pinFreeze',
  'startCeremony',
  'retryStart',
  'validate',
  'submit',
  'setPrivateVisible',
  'exportSave',
  'retryAudit',
  'ackSession',
  'approveRecoveryAuthorization',
  'clearRecoveryApproval',
  'requestTakeover',
  'cancelPending',
  'shutdown',
]);

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Shape is inspected before any field is used.
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function seat(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 5;
}

function validBody(body: Record<string, unknown>): boolean {
  switch (body.kind) {
    case 'initialize':
      return (
        typeof body.self === 'string' &&
        /^[A-Za-z0-9_-]{43}$/.test(body.self) &&
        (body.mode === 'fresh'
          ? !!object(body.invite) && onlyKeys(body, ['kind', 'self', 'mode', 'invite'])
          : body.mode === 'resume' &&
            typeof body.gameId === 'string' &&
            /^[A-Za-z0-9_-]{22}$/.test(body.gameId) &&
            onlyKeys(body, ['kind', 'self', 'mode', 'gameId']))
      );
    case 'attachTransport':
      return (
        typeof body.self === 'string' &&
        /^[A-Za-z0-9_-]{43}$/.test(body.self) &&
        Array.isArray(body.peers) &&
        body.peers.length <= 32 &&
        body.peers.every(
          (peer: unknown) => typeof peer === 'string' && /^[A-Za-z0-9_-]{43}$/.test(peer),
        ) &&
        body.port instanceof MessagePort &&
        onlyKeys(body, ['kind', 'self', 'peers', 'port'])
      );
    case 'pinFreeze':
      return !!object(body.state) && onlyKeys(body, ['kind', 'state']);
    case 'startCeremony':
      return !!object(body.agreement) && onlyKeys(body, ['kind', 'agreement']);
    case 'validate':
    case 'submit': {
      const head = object(body.head);
      const command = object(body.command);
      return (
        seat(body.seat) &&
        !!head &&
        Number.isSafeInteger(head.seq) &&
        typeof head.seq === 'number' &&
        head.seq >= 0 &&
        typeof head.hash === 'string' &&
        /^[0-9a-f]{64}$/.test(head.hash) &&
        !!command &&
        typeof command.type === 'string' &&
        onlyKeys(body, ['kind', 'seat', 'head', 'command'])
      );
    }
    case 'setPrivateVisible':
      return (
        typeof body.visible === 'boolean' &&
        Number.isSafeInteger(body.visibilityToken) &&
        typeof body.visibilityToken === 'number' &&
        body.visibilityToken >= 0 &&
        onlyKeys(body, ['kind', 'visible', 'visibilityToken'])
      );
    case 'ackSession':
      return (
        typeof body.snapshotId === 'number' &&
        Number.isSafeInteger(body.snapshotId) &&
        body.snapshotId > 0 &&
        onlyKeys(body, ['kind', 'snapshotId'])
      );
    case 'approveRecoveryAuthorization':
      return 'change' in body && onlyKeys(body, ['kind', 'change']);
    case 'requestTakeover':
      return (
        seat(body.departedSeat) &&
        ['easy', 'medium', 'hard'].includes(String(body.botLevel)) &&
        onlyKeys(body, ['kind', 'departedSeat', 'botLevel'])
      );
    case 'cancelPending':
      return seat(body.seat) && onlyKeys(body, ['kind', 'seat']);
    case 'retryStart':
    case 'exportSave':
    case 'retryAudit':
    case 'clearRecoveryApproval':
    case 'shutdown':
      return onlyKeys(body, ['kind']);
    default:
      return false;
  }
}

function checkedHeader(value: unknown) {
  const candidate = object(value);
  const body = object(candidate?.body);
  if (
    !candidate ||
    candidate.protocol !== ONLINE_WORKER_PROTOCOL ||
    typeof candidate.generation !== 'string' ||
    candidate.generation.length < 1 ||
    candidate.generation.length > 256 ||
    typeof candidate.id !== 'number' ||
    !Number.isSafeInteger(candidate.id) ||
    candidate.id <= 0 ||
    !body ||
    typeof body.kind !== 'string' ||
    !kinds.has(body.kind)
  )
    return null;
  return { candidate, body, generation: candidate.generation, id: candidate.id, kind: body.kind };
}

function checkedRequest(
  value: unknown,
  { candidate, body }: NonNullable<ReturnType<typeof checkedHeader>>,
): OnlineWorkerRequest | null {
  if (!validBody(body)) return null;
  try {
    // MessagePort is transferred separately; the remaining request is canonical data.
    const measurable =
      body.kind === 'attachTransport'
        ? {
            protocol: candidate.protocol,
            generation: candidate.generation,
            id: candidate.id,
            body: { kind: body.kind, self: body.self, peers: body.peers },
          }
        : candidate;
    if (canonicalEncode(measurable).byteLength > MAX_ONLINE_WORKER_REQUEST_BYTES) return null;
  } catch {
    return null;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The worker applies per-operation domain checks before using any field.
  return value as OnlineWorkerRequest;
}

// oxlint-disable-next-line unicorn/require-post-message-target-origin -- DedicatedWorkerGlobalScope.postMessage has no target origin.
const runtime = new OnlineWorkerRuntime({ emit: (event) => scope.postMessage(event) });
scope.addEventListener('message', (event) => {
  const header = checkedHeader(event.data);
  if (!header) return;
  const request = checkedRequest(event.data, header);
  if (!request) {
    // Only trusted primitive header fields are echoed; malformed bodies never leave the worker.
    const reply = {
      protocol: ONLINE_WORKER_PROTOCOL,
      generation: header.generation,
      id: header.id,
      kind: header.kind,
      result: {
        ok: false,
        error: { code: 'online-worker-request', message: 'Malformed online worker request' },
      },
    };
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- DedicatedWorkerGlobalScope.postMessage has no target origin.
    scope.postMessage(reply);
    return;
  }
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- DedicatedWorkerGlobalScope.postMessage has no target origin.
  void runtime.handle(request).then((reply) => scope.postMessage(reply));
});
