import { IndexedDbByteStore } from '@cp2p/storage';

export interface StorageSmokeRequest {
  id: number;
  action: 'insert' | 'cas' | 'read' | 'lock' | 'close';
  key: string;
  value?: number;
  expected?: number;
}

export interface StorageSmokeResponse {
  id: number;
  result?: boolean | number | null;
  error?: string;
}

const store = new IndexedDbByteStore();

async function handle(message: StorageSmokeRequest): Promise<boolean | number | null> {
  switch (message.action) {
    case 'insert':
      return store.putIfAbsent(message.key, new Uint8Array([message.value ?? 0]));
    case 'cas':
      return store.compareAndSwap(
        message.key,
        new Uint8Array([message.expected ?? 0]),
        new Uint8Array([message.value ?? 0]),
      );
    case 'read':
      return (await store.load(message.key))?.[0] ?? null;
    case 'close':
      await store.close();
      return true;
    case 'lock':
      return store.withCeremonyLock(message.key, async () => {
        const entered = await store.compareAndSwap(
          message.key,
          new Uint8Array([0]),
          new Uint8Array([1]),
        );
        if (!entered) throw new Error('Ceremony callbacks overlapped across workers');
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        const left = await store.compareAndSwap(
          message.key,
          new Uint8Array([1]),
          new Uint8Array([0]),
        );
        if (!left) throw new Error('Ceremony record changed inside its exclusive lock');
        return true;
      });
    default:
      throw new Error('Unknown storage check action');
  }
}

function reply(message: StorageSmokeResponse): void {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker messaging has no targetOrigin.
  self.postMessage(message);
}

self.addEventListener('message', (event: MessageEvent<StorageSmokeRequest>) => {
  void handle(event.data).then(
    (result) => reply({ id: event.data.id, result }),
    (error: unknown) =>
      reply({
        id: event.data.id,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
});
