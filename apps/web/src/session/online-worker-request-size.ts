import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import {
  MAX_ONLINE_WORKER_REQUEST_BYTES,
  MAX_ONLINE_WORKER_SNAPSHOT_BYTES,
} from './online-worker-messages.js';
import type { OnlineWorkerRequestBody } from './online-worker-messages.js';

/** Detach request data and reserve one large import/export slot without starving control. */
export function prepareOnlineWorkerRequest(body: OnlineWorkerRequestBody): {
  body: OnlineWorkerRequestBody;
  bytes: number;
  heavy: boolean;
} {
  const bootstrap =
    body.kind === 'initializeTransfer' ||
    body.kind === 'refreshTransferBootstrap' ||
    body.kind === 'observeTransferActivation' ||
    body.kind === 'observeTransferCancellation';
  if (bootstrap) {
    const payload = body.bootstrapBytes;
    if (
      (payload !== undefined &&
        (!(payload instanceof Uint8Array) ||
          !(payload.buffer instanceof ArrayBuffer) ||
          payload.byteLength > MAX_ONLINE_WORKER_SNAPSHOT_BYTES)) ||
      (payload === undefined && body.kind !== 'initializeTransfer')
    )
      throw new RangeError('Transfer bootstrap exceeds the worker request limit');
    const { bootstrapBytes: _payload, ...metadata } = body;
    const encoded = canonicalEncode(metadata);
    if (encoded.byteLength > 65_536)
      throw new RangeError('Transfer request metadata exceeds its limit');
    // Copy only the visible bytes: structured clone would otherwise copy the
    // entire backing buffer of a small subarray. Shared backing is rejected.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Canonical round trip preserves the request metadata.
    const detached = canonicalDecode(encoded) as typeof metadata;
    const copied =
      payload === undefined ? detached : { ...detached, bootstrapBytes: payload.slice() };
    return {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Required bytes were checked above; only initialization can omit them.
      body: copied as OnlineWorkerRequestBody,
      bytes: encoded.byteLength + (payload?.byteLength ?? 0),
      heavy: true,
    };
  }
  const encoded = canonicalEncode(body.kind === 'attachTransport' ? { ...body, port: null } : body);
  if (encoded.byteLength > MAX_ONLINE_WORKER_REQUEST_BYTES)
    throw new RangeError('Worker request exceeds its size limit');
  // Ordinary requests also contain byte views, such as sealed transfer packets.
  // Canonical copying makes them immutable snapshots with bounded backing buffers.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Canonical round trip preserves every ordinary field; the port is restored below.
  const detached = canonicalDecode(encoded) as OnlineWorkerRequestBody;
  return {
    body:
      body.kind === 'attachTransport' && detached.kind === 'attachTransport'
        ? { ...detached, port: body.port }
        : detached,
    bytes: encoded.byteLength,
    heavy: body.kind === 'exportTransferBootstrap' || body.kind === 'exportSave',
  };
}
