import { canonicalDecode, canonicalEncode, toBase64Url } from '@cp2p/codec';
import { BASE_VERSION, createBaseEngine } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { LobbyController, MemoryProtocolJournal } from '@cp2p/protocol';
import type { CertifiedEntry } from '@cp2p/protocol';
import { createMemnet, MemoryEscrowLifecycleStore } from '@cp2p/protocol/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { loadOrCreateOnlineIdentity } from './online-credentials.js';
import { loadOnlineGameRecord } from './online-game-records.js';
import type { SavedOnlineGameRecord } from './online-game-records.js';
import { OnlineStartup } from './online-startup.js';
import type { OnlineGameRuntime } from './online-game.js';
import {
  encodeOnlineTransferBootstrap,
  validateOnlineTransferBootstrap,
} from './online-transfer-bootstrap.js';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Fixture {
  readonly start: SavedOnlineGameRecord;
  readonly entries: readonly CertifiedEntry[];
  close(): Promise<void>;
}

async function createFixture(): Promise<Fixture> {
  const store = new MemoryEscrowLifecycleStore();
  const identity = await loadOrCreateOnlineIdentity(store, (length) =>
    new Uint8Array(length).fill(41),
  );
  const network = createMemnet({ peers: [identity.peerId] });
  const invite = { roomId: 'bootstrpqa', hostPeer: identity.peerId, serverUrl: '' };
  const lobby = unwrap(
    LobbyController.createHost({
      lobbyId: invite.roomId,
      name: 'Transfer bootstrap test',
      hostName: 'Avery',
      config: {
        modules: [{ id: 'base', version: BASE_VERSION }],
        seats: [0, 1],
        options: { base: { mapLayout: 'random', vpTarget: 3 } },
      },
      transport: network.transport(identity.peerId),
      clock: network.clock,
      secretKey: identity.secretKey,
    }),
  );
  unwrap(lobby.setBot(1, 'easy'));
  unwrap(lobby.request({ kind: 'setReady', ready: true }));
  const gameRuntime: OnlineGameRuntime = {
    acquireLease: async () => ({
      lockName: 'transfer-bootstrap-test',
      run: async <T>(task: () => T | PromiseLike<T>) => task(),
      close: async () => undefined,
    }),
    createJournal: () =>
      Object.assign(new MemoryProtocolJournal(), { close: async () => undefined }),
  };
  const startup = new OnlineStartup({
    invite,
    identity,
    lobby,
    transport: network.transport(identity.peerId),
    store,
    clock: network.clock,
    engine: createBaseEngine(),
    freezePeers: () => undefined,
    gameRuntime,
  });
  unwrap(startup.begin());
  for (let step = 0; step < 600 && startup.snapshot()?.phase !== 'playing'; step += 1) {
    network.clock.advanceBy(step % 10 === 0 ? 100 : 0);
    // oxlint-disable-next-line no-await-in-loop -- Run bounded asynchronous ceremony/storage progress.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (startup.snapshot()?.phase === 'error')
      throw new Error(startup.snapshot()?.error ?? 'Bootstrap fixture startup failed');
  }
  const game = startup.game();
  if (!game) throw new Error('Bootstrap fixture did not open its game');
  const start = await loadOnlineGameRecord(store, game.gameId);
  if (!start) throw new Error('Bootstrap fixture did not persist its public start');
  return {
    start,
    entries: game.session.exportSave().entries,
    async close() {
      await startup.close();
      lobby.dispose();
      identity.dispose();
      network.dispose();
    },
  };
}

describe('public online transfer bootstrap', () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await createFixture();
  }, 60_000);

  afterAll(async () => {
    await fixture?.close();
  });

  test('validates the original start and replays an exact certified prefix detached from bytes', () => {
    const bytes = unwrap(
      encodeOnlineTransferBootstrap({ start: fixture.start, entries: fixture.entries }),
    );
    const verified = unwrap(
      validateOnlineTransferBootstrap(bytes, {
        gameId: fixture.start.gameId,
        genesisDigest: fixture.start.genesisDigest,
      }),
    );
    expect(verified.record.gameId).toBe(fixture.start.gameId);
    expect(verified.replay.entries.length).toBe(fixture.entries.length);
    expect(verified.replay.context.log.head.seq).toBe(
      fixture.entries.at(-1)?.entry.seq ?? fixture.start.result.entry.seq,
    );
    bytes.fill(0);
    expect(verified.record.result.genesis.gameId).toBe(fixture.start.gameId);
    expect(verified.replay.entries.length).toBe(fixture.entries.length);
  });

  test('rejects wrong invite binding and extra or private artifact fields', () => {
    const encoded = unwrap(
      encodeOnlineTransferBootstrap({ start: fixture.start, entries: fixture.entries }),
    );
    expect(
      validateOnlineTransferBootstrap(encoded, {
        gameId: 'A'.repeat(22),
        genesisDigest: fixture.start.genesisDigest,
      }).ok,
    ).toBe(false);
    expect(
      validateOnlineTransferBootstrap(encoded, {
        gameId: fixture.start.gameId,
        genesisDigest: toBase64Url(new Uint8Array(32).fill(222)),
      }),
    ).toMatchObject({ ok: false, error: { code: 'transfer-bootstrap-binding' } });

    const decoded = canonicalDecode(encoded);
    if (!isRecord(decoded)) throw new Error('Expected a bootstrap object');
    const artifact = decoded;
    const withSafety = canonicalEncode({ ...artifact, safety: { votes: [] } });
    expect(
      validateOnlineTransferBootstrap(withSafety, {
        gameId: fixture.start.gameId,
        genesisDigest: fixture.start.genesisDigest,
      }).ok,
    ).toBe(false);

    const unsafeStart = { ...fixture.start, safety: { votes: [] } };
    expect(
      encodeOnlineTransferBootstrap({
        start: unsafeStart,
        entries: fixture.entries,
      }).ok,
    ).toBe(false);
    const unsafeResult = {
      ...fixture.start,
      result: { ...fixture.start.result, safety: { votes: [] } },
    };
    expect(
      encodeOnlineTransferBootstrap({
        start: unsafeResult,
        entries: fixture.entries,
      }).ok,
    ).toBe(false);
    const firstTranscript = fixture.start.result.transcripts[0];
    if (!firstTranscript) throw new Error('Expected deck transcript in saved start');
    const unsafeTranscript = {
      ...fixture.start,
      result: {
        ...fixture.start.result,
        transcripts: [{ ...firstTranscript, privateKey: 'must-not-serialize' }],
      },
    };
    expect(
      encodeOnlineTransferBootstrap({
        start: unsafeTranscript,
        entries: fixture.entries,
      }).ok,
    ).toBe(false);
    const cyclicStart: SavedOnlineGameRecord & { extra?: unknown } = { ...fixture.start };
    cyclicStart.extra = cyclicStart;
    expect(
      encodeOnlineTransferBootstrap({
        start: cyclicStart,
        entries: fixture.entries,
      }).ok,
    ).toBe(false);
    encoded.fill(0);
    withSafety.fill(0);
  });

  test('rejects a changed certified prefix and over-limit bytes before replay', () => {
    const first = fixture.entries[0];
    if (!first) throw new Error('Expected deck entries in the certified start prefix');
    const tampered = {
      ...first,
      certificate: first.certificate.map((vote, index) =>
        index === 0 ? { ...vote, sig: toBase64Url(new Uint8Array(64).fill(1)) } : vote,
      ),
    };
    const altered = unwrap(
      encodeOnlineTransferBootstrap({
        start: fixture.start,
        entries: [tampered, ...fixture.entries.slice(1)],
      }),
    );
    expect(
      validateOnlineTransferBootstrap(altered, {
        gameId: fixture.start.gameId,
        genesisDigest: fixture.start.genesisDigest,
      }).ok,
    ).toBe(false);
    expect(
      validateOnlineTransferBootstrap(new Uint8Array(16 * 1024 * 1024 + 1), {
        gameId: fixture.start.gameId,
        genesisDigest: fixture.start.genesisDigest,
      }),
    ).toMatchObject({ ok: false, error: { code: 'transfer-bootstrap-size' } });
    altered.fill(0);
  });
});
