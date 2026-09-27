import { performAuditRequest } from './audit-worker-job.js';
import type { AuditWorkerRequest, AuditWorkerResponse } from './audit-worker-job.js';

function wipeMasters(value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const master = Reflect.get(item, 'master');
    if (master instanceof Uint8Array) master.fill(0);
  }
}

function isRequest(value: unknown): value is AuditWorkerRequest {
  const id = typeof value === 'object' && value !== null ? Reflect.get(value, 'id') : null;
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof id === 'number' &&
    Number.isSafeInteger(id) &&
    id > 0 &&
    Array.isArray(Reflect.get(value, 'entries')) &&
    Array.isArray(Reflect.get(value, 'masters'))
  );
}

function reply(response: AuditWorkerResponse): void {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker messaging has no targetOrigin.
  self.postMessage(response);
}

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = event.data;
  const rawId = typeof message === 'object' && message !== null ? Reflect.get(message, 'id') : null;
  const id = typeof rawId === 'number' && Number.isSafeInteger(rawId) ? rawId : 0;
  if (!isRequest(message)) {
    wipeMasters(
      typeof message === 'object' && message !== null ? Reflect.get(message, 'masters') : null,
    );
    reply({ id, error: 'Malformed audit request' });
    return;
  }
  try {
    reply({ id, report: performAuditRequest(message) });
  } catch {
    reply({ id, error: 'Audit worker failed' });
  } finally {
    wipeMasters(message.masters);
  }
});
