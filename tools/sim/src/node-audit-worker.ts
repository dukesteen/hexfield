import { parentPort } from 'node:worker_threads';
import { performVerifiedNetworkAudit } from '@cp2p/protocol/testing';
import type { VerifiedNetworkAuditRequest } from '@cp2p/protocol/testing';

if (!parentPort) throw new Error('Audit worker requires a parent');
const port = parentPort;
port.once('message', (request: VerifiedNetworkAuditRequest) => {
  try {
    port.postMessage({ kind: 'result', value: performVerifiedNetworkAudit(request) });
  } catch {
    // Never transport error text that could contain a private payload.
    port.postMessage({ kind: 'error' });
  } finally {
    for (const item of request.masters) item.master.fill(0);
    port.close();
  }
});
