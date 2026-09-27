import type { StorageSmokeRequest, StorageSmokeResponse } from './storage-smoke.worker.js';
import { createSimulationGenesis } from '@cp2p/protocol/testing';
import { entryHash, genesisDigest, quorumSize, signEntry, signVote } from '@cp2p/protocol';
import type { CertifiedEntry, LogEntry } from '@cp2p/protocol';

function createJournalFixture(seed: number): { genesis: LogEntry; certified: CertifiedEntry } {
  const simulation = createSimulationGenesis({ seed, humanCount: 4 });
  const humans = simulation.genesis.seats.filter((seat) => seat.kind === 'human');
  const proposer = humans[0];
  const proposerIdentity = proposer && simulation.identities.get(proposer.seat);
  if (!proposer || !proposerIdentity) throw new Error('Could not create the smoke signer');

  const entry = signEntry(
    {
      seq: 1,
      term: 1,
      prevHash: entryHash(simulation.entry),
      payload: { kind: 'membership', change: { smoke: true } },
      stateHash: simulation.entry.stateHash,
      sequencer: proposer.publicKey,
    },
    proposerIdentity.secretKey,
  );
  const hash = entryHash(entry);
  const digest = genesisDigest(simulation.genesis);
  const certificate = humans.slice(0, quorumSize(humans.length)).map((human) => {
    const identity = simulation.identities.get(human.seat);
    if (!identity) throw new Error('Could not create a smoke voter');
    return signVote(
      {
        genesisDigest: digest,
        epoch: 0,
        seat: human.seat,
        seq: 1,
        term: 1,
        phase: 'precommit',
        valueHash: hash,
      },
      identity.secretKey,
    );
  });
  return { genesis: simulation.entry, certified: { entry, certificate } };
}

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

      const seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 1;
      const fixture = createJournalFixture(seed);
      const gameId =
        fixture.genesis.payload.kind === 'genesis' ? fixture.genesis.payload.genesis.gameId : '';
      assert(gameId.length > 0, 'Synthetic journal genesis has no gameId');
      assert(
        (await first.call({ action: 'writer-acquire', key: gameId, gameId })) === true,
        'First worker failed to acquire its writer lease',
      );
      assert(
        (await second.call({ action: 'writer-acquire', key: gameId, gameId })) === false,
        'A second worker acquired the same live game writer lease',
      );
      await first.call({ action: 'writer-release', key: gameId });
      assert(
        (await second.call({ action: 'writer-acquire', key: gameId, gameId })) === true,
        'Closing the first writer did not release its browser lock',
      );
      await second.call({ action: 'writer-release', key: gameId });
      log('PASS native game writer lease excludes a second worker and releases on close');
      const initialized = await Promise.all(
        clients.map((client) =>
          client.call({
            action: 'journal-initialize',
            key: gameId,
            gameId,
            genesis: fixture.genesis,
          }),
        ),
      );
      assert(initialized.filter(Boolean).length === 1, 'Two journal initializers won');
      const safetySaves = await Promise.all(
        clients.map((client, index) =>
          client.call({
            action: 'journal-save',
            key: gameId,
            gameId,
            value: index + 1,
            height: 1,
            revision: 0,
          }),
        ),
      );
      assert(safetySaves.filter(Boolean).length === 1, 'Two journal safety saves won');
      log('PASS journal safety compare-and-swap across two workers');

      const commits = await Promise.all(
        clients.map((client, index) =>
          client.call({
            action: 'journal-commit',
            key: gameId,
            gameId,
            certified: fixture.certified,
            height: 1,
            revision: 1,
            value: index + 1,
          }),
        ),
      );
      const commitWinner = commits.findIndex(Boolean);
      assert(commitWinner >= 0 && commits.filter(Boolean).length === 1, 'Two journal commits won');
      await Promise.all(clients.map((client) => client.call({ action: 'close', key: gameId })));

      const restored = await first.call({ action: 'journal-read', key: gameId, gameId });
      assert(
        typeof restored === 'object' &&
          restored !== null &&
          restored.height === 2 &&
          restored.entrySeqs.join(',') === '1' &&
          restored.headHash === entryHash(fixture.certified.entry) &&
          restored.safetyRevision === 0 &&
          restored.safety[0] === commitWinner + 1,
        'Journal reopen differs from the committed entry or next-height safety',
      );
      log('PASS journal reopen restores exact entry and next-height safety');

      const staleWrites = await Promise.all(
        clients.map((client) =>
          client.call({
            action: 'journal-stale',
            key: gameId,
            gameId,
            certified: fixture.certified,
          }),
        ),
      );
      assert(staleWrites.every(Boolean), 'Journal accepted an old-height safety write');
      log('PASS journal rejects writes from the committed height');
      await Promise.all(clients.map((client) => client.call({ action: 'close', key: gameId })));
      log('PASS native storage and protocol journal checks complete');
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
