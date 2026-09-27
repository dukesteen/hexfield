/* oxlint-disable unicorn/require-post-message-target-origin -- Dedicated Worker messages have no target origin. */
import { runOnlineFullSaveWorkerRequest } from './online-full-save-worker.js';

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const request = event.data;
  void runOnlineFullSaveWorkerRequest(request).then(
    (response) => {
      self.postMessage(response, {
        transfer:
          response.kind === 'exported' && response.bytes.buffer instanceof ArrayBuffer
            ? [response.bytes.buffer]
            : [],
      });
      return undefined;
    },
    () => {
      const rawId =
        typeof request === 'object' && request !== null ? Reflect.get(request, 'id') : 0;
      const id = Number.isSafeInteger(rawId) && Number(rawId) > 0 ? Number(rawId) : 0;
      self.postMessage({
        id,
        kind: 'error',
        code: 'full-save-storage',
        message: 'Full-save worker failed',
      });
      return undefined;
    },
  );
});
