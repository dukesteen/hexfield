import { ONLINE_WORKER_PROTOCOL } from './online-worker-messages.js';
import type { OnlineWorkerRequest, OnlineWorkerRequestBody } from './online-worker-messages.js';
import { prepareOnlineWorkerRequest } from './online-worker-request-size.js';
import { OnlineWorkerRuntime } from './online-worker-runtime.js';

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This entry runs only inside a dedicated worker, whose postMessage has no target origin.
const scope = globalThis as unknown as {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
};

const kinds = {
  initializeTransfer: true,
  transferSnapshot: true,
  prepareTransferOffer: true,
  refreshTransferBootstrap: true,
  importTransferPacket: true,
  prepareTransferReadiness: true,
  observeTransferActivation: true,
  observeTransferCancellation: true,
  exportTransferBootstrap: true,
  transferStatus: true,
  authorizeLiveTransfer: true,
  submitTransfer: true,
  prepareTransferPrivate: true,
  initialize: true,
  attachTransport: true,
  pinFreeze: true,
  startCeremony: true,
  retryStart: true,
  validate: true,
  submit: true,
  setPrivateVisible: true,
  exportSave: true,
  retryAudit: true,
  ackSession: true,
  approveRecoveryAuthorization: true,
  clearRecoveryApproval: true,
  canRequestTakeover: true,
  requestTakeover: true,
  cancelPending: true,
  shutdown: true,
} satisfies Record<OnlineWorkerRequestBody['kind'], true>;

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

function token(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function head(value: unknown): boolean {
  const ref = object(value);
  return (
    !!ref &&
    onlyKeys(ref, ['seq', 'hash']) &&
    Number.isSafeInteger(ref.seq) &&
    typeof ref.seq === 'number' &&
    ref.seq >= 0 &&
    typeof ref.hash === 'string' &&
    /^[0-9a-f]{64}$/.test(ref.hash)
  );
}

function bootstrap(value: unknown): boolean {
  return value instanceof Uint8Array && value.buffer instanceof ArrayBuffer;
}

function validBody(body: Record<string, unknown>): boolean {
  switch (body.kind) {
    case 'initializeTransfer': {
      const expected = object(body.expected);
      return (
        token(body.self) &&
        token(body.attemptId) &&
        ['new', 'resume', 'open'].includes(String(body.mode)) &&
        !!expected &&
        onlyKeys(expected, ['gameId', 'genesisDigest']) &&
        typeof expected.gameId === 'string' &&
        /^[A-Za-z0-9_-]{22}$/.test(expected.gameId) &&
        token(expected.genesisDigest) &&
        (body.bootstrapBytes === undefined || bootstrap(body.bootstrapBytes)) &&
        (body.importedArchiveId === undefined ||
          (typeof body.importedArchiveId === 'string' &&
            /^[0-9a-f]{64}$/.test(body.importedArchiveId))) &&
        onlyKeys(body, [
          'kind',
          'self',
          'attemptId',
          'mode',
          'expected',
          'bootstrapBytes',
          'importedArchiveId',
        ])
      );
    }
    case 'transferSnapshot':
    case 'prepareTransferReadiness':
      return onlyKeys(body, ['kind']);
    case 'prepareTransferOffer':
      return (
        seat(body.seat) &&
        ['live', 'return'].includes(String(body.mode)) &&
        onlyKeys(body, ['kind', 'seat', 'mode'])
      );
    case 'refreshTransferBootstrap':
    case 'observeTransferActivation':
    case 'observeTransferCancellation':
      return bootstrap(body.bootstrapBytes) && onlyKeys(body, ['kind', 'bootstrapBytes']);
    case 'importTransferPacket':
      return !!object(body.packet) && onlyKeys(body, ['kind', 'packet']);
    case 'exportTransferBootstrap':
      return (
        (body.throughSeq === undefined ||
          (Number.isSafeInteger(body.throughSeq) &&
            typeof body.throughSeq === 'number' &&
            body.throughSeq >= 0)) &&
        onlyKeys(body, ['kind', 'throughSeq'])
      );
    case 'transferStatus':
      return (
        (body.authorization === undefined || head(body.authorization)) &&
        (body.statement === undefined || !!object(body.statement)) &&
        onlyKeys(body, ['kind', 'authorization', 'statement'])
      );
    case 'authorizeLiveTransfer':
      return !!object(body.offer) && head(body.head) && onlyKeys(body, ['kind', 'offer', 'head']);
    case 'submitTransfer':
      return !!object(body.change) && head(body.head) && onlyKeys(body, ['kind', 'change', 'head']);
    case 'prepareTransferPrivate':
      return head(body.authorization) && onlyKeys(body, ['kind', 'authorization']);
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
      const command = object(body.command);
      return (
        seat(body.seat) &&
        head(body.head) &&
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
    case 'canRequestTakeover':
      return seat(body.departedSeat) && onlyKeys(body, ['kind', 'departedSeat']);
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
    !Object.hasOwn(kinds, body.kind)
  )
    return null;
  return { candidate, body, generation: candidate.generation, id: candidate.id, kind: body.kind };
}

function checkedRequest({
  body,
  generation,
  id,
}: NonNullable<ReturnType<typeof checkedHeader>>): OnlineWorkerRequest | null {
  if (!validBody(body)) return null;
  try {
    // The same bounds and detached-copy rules apply on both sides of the worker port.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validBody checked the discriminant and required fields above.
    const checked = prepareOnlineWorkerRequest(body as OnlineWorkerRequestBody);
    return { protocol: ONLINE_WORKER_PROTOCOL, generation, id, body: checked.body };
  } catch {
    return null;
  }
}

// oxlint-disable-next-line unicorn/require-post-message-target-origin -- DedicatedWorkerGlobalScope.postMessage has no target origin.
const runtime = new OnlineWorkerRuntime({ emit: (event) => scope.postMessage(event) });
scope.addEventListener('message', (event) => {
  const header = checkedHeader(event.data);
  if (!header) return;
  const request = checkedRequest(header);
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
