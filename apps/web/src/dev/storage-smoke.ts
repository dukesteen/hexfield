import type { StorageSmokeRequest, StorageSmokeResponse } from './storage-smoke.worker.js';

function createClient() {
  const worker = new Worker(new URL('./storage-smoke.worker.ts', import.meta.url), {
    type: 'module',
  });
  let id = 0;
  const pending = new Map<
    number,
    {
      resolve(value: StorageSmokeResponse['result']): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  worker.addEventListener('message', (event: MessageEvent<StorageSmokeResponse>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    clearTimeout(request.timer);
    if (event.data.error) request.reject(new Error(event.data.error));
    else request.resolve(event.data.result);
  });
  return {
    call(message: Omit<StorageSmokeRequest, 'id'>): Promise<StorageSmokeResponse['result']> {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`${message.action} timed out`));
        }, 5_000);
        pending.set(requestId, { resolve, reject, timer });
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker messaging has no targetOrigin.
        worker.postMessage({ ...message, id: requestId });
      });
    },
    dispose() {
      worker.terminate();
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Storage worker closed'));
      }
      pending.clear();
    },
  };
}

const button = document.querySelector<HTMLButtonElement>('#run');
const output = document.querySelector<HTMLPreElement>('#output');
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
if (button && output) {
  const log = (line: string) => {
    output.textContent += `${line}\n`;
  };
  button.addEventListener('click', () => {
    if (button.disabled) return;
    button.disabled = true;
    output.textContent = '';
    const clients = [createClient(), createClient()];
    const run = async () => {
      const [first, second] = clients;
      if (!first || !second) throw new Error('Missing storage worker');
      const key = `verification/${crypto.randomUUID()}`;
      const inserted = await Promise.all(
        clients.map((client, index) => client.call({ action: 'insert', key, value: index + 1 })),
      );
      assert(inserted.filter(Boolean).length === 1, 'Two first writes won');
      const winner = await first.call({ action: 'read', key });
      if (typeof winner !== 'number') throw new Error('Missing first-write value');
      const changed = await Promise.all(
        clients.map((client, index) =>
          client.call({ action: 'cas', key, expected: winner, value: index + 3 }),
        ),
      );
      assert(changed.filter(Boolean).length === 1, 'Two compare-and-swap writes won');
      log('PASS atomic first write and CAS across two workers');
      const finalValue = await first.call({ action: 'read', key });
      await Promise.all(clients.map((client) => client.call({ action: 'close', key })));
      assert(
        (await second.call({ action: 'read', key })) === finalValue,
        'Reopen lost committed bytes',
      );
      log('PASS native IndexedDB reopen preserves committed bytes');
      const lockKey = `${key}/lock`;
      await first.call({ action: 'insert', key: lockKey, value: 0 });
      const locked = await Promise.all(
        clients.map((client) => client.call({ action: 'lock', key: lockKey })),
      );
      assert(
        locked.every((value) => value === true),
        'Cross-worker lock failed',
      );
      log('PASS native Web Locks serialize both ceremony callbacks');
      await Promise.all(clients.map((client) => client.call({ action: 'close', key })));
      log('PASS native escrow storage check complete');
    };
    void run()
      .catch((error: unknown) =>
        log(`FAIL ${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => {
        for (const client of clients) client.dispose();
        button.disabled = false;
      });
  });
}
