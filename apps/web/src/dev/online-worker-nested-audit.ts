import type { SessionAuditInput } from '@cp2p/protocol';
import { createSessionAuditRunner } from '../session/audit-worker-client.js';

const audit = createSessionAuditRunner(undefined, { deadlineMs: 60_000 });
let started = false;

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const value = event.data;
  if (started || typeof value !== 'object' || value === null) return;
  const id = Reflect.get(value, 'id');
  const input = Reflect.get(value, 'input');
  if (
    id !== 1 ||
    typeof input !== 'object' ||
    input === null ||
    !Array.isArray(Reflect.get(input, 'entries')) ||
    !Array.isArray(Reflect.get(input, 'masters'))
  )
    return;
  started = true;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The production audit job validates and consumes the cloned fixture input.
  const job = audit(input as SessionAuditInput);
  void job.result.then(
    (report) => {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Dedicated workers have no target origin.
      self.postMessage({ id, report });
      return undefined;
    },
    (error: unknown) => {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Dedicated workers have no target origin.
      self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
      return undefined;
    },
  );
});
