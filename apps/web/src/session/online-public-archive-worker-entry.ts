import { runPublicArchiveWorkerRequest } from './online-public-archive-worker.js';

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const request = event.data;
  void runPublicArchiveWorkerRequest(request).then(
    (response) => {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Dedicated Worker messages do not take a target origin.
      self.postMessage(response);
      return undefined;
    },
    () => {
      const rawId =
        typeof request === 'object' && request !== null ? Reflect.get(request, 'id') : 0;
      const id = Number.isSafeInteger(rawId) && Number(rawId) > 0 ? Number(rawId) : 0;
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Dedicated Worker messages do not take a target origin.
      self.postMessage({ id, kind: 'error', error: 'Public replay worker failed' });
      return undefined;
    },
  );
});
