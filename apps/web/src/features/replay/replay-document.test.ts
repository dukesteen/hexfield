import { toBase64Url } from '@cp2p/codec';
import { beforeAll, describe, expect, test } from 'vitest';
import type { LocalSessionSave } from '../../session/types.js';
import {
  CHAT_LENGTH_LIMIT,
  decodeReplayString,
  encodeReplayString,
  onlineReplayDocument,
  parseReplayDocument,
  REPLAY_STRING_PREFIX,
  tooLongForChat,
} from './replay-document.js';
import type { LocalReplayDocument } from './replay-document.js';
import { loadLocalReplay } from './replay-load.js';
import { goldenSave } from './replay-golden.test-helper.js';

const name = (seat: number) => `Player ${seat + 1}`;
let save: LocalSessionSave;
let document: LocalReplayDocument;

beforeAll(async () => {
  save = goldenSave('normal-game-01.replay.json', 400);
  document = { format: 'hexfield-replay', v: 1, kind: 'local', save };
}, 60_000);

async function deflated(json: string): Promise<string> {
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return `${REPLAY_STRING_PREFIX}${toBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()))}`;
}

describe('replay strings', () => {
  test('round trip a local game to an identical document that replays', async () => {
    const text = await encodeReplayString(document);
    expect(text.startsWith(REPLAY_STRING_PREFIX)).toBe(true);
    const decoded = await decodeReplayString(`  ${text.slice(0, 40)}\n${text.slice(40)} `);
    expect(decoded).toEqual(document);
    const parsed = parseReplayDocument(decoded);
    if (parsed.kind !== 'local') throw new Error('Expected a local replay');
    const loaded = loadLocalReplay({ document: parsed.document }, name);
    expect(loaded.session.length).toBe(
      save.genesis.length +
        save.batches.reduce((sum, batch) => sum + 1 + batch.generated.length, 0),
    );
    expect(loaded.presentation.players.map((player) => player.name)).toEqual(
      save.config.seats.map(name),
    );
    // A real game is far longer than a chat message.
    expect(tooLongForChat(text)).toBe(text.length > CHAT_LENGTH_LIMIT);
  });

  test('round trip an online document with its masters', async () => {
    const online = onlineReplayDocument(Uint8Array.of(1, 2, 3, 4), [
      { seat: 0, master: 'A'.repeat(43) },
      { seat: 1, master: 'B'.repeat(43) },
    ]);
    const decoded = await decodeReplayString(await encodeReplayString(online));
    expect(parseReplayDocument(decoded)).toEqual({ kind: 'online', document: online });
  });

  test('reject damaged, foreign and non-canonical strings', async () => {
    await expect(decodeReplayString('HXMAP1.abc')).rejects.toThrow('not a replay string');
    await expect(decodeReplayString(`${REPLAY_STRING_PREFIX}not*base64`)).rejects.toThrow(
      'damaged',
    );
    const text = await encodeReplayString(document);
    await expect(decodeReplayString(text.slice(0, -20))).rejects.toThrow('damaged');
    await expect(decodeReplayString(await deflated('{"b":1, "a":2}'))).rejects.toThrow('canonical');
    expect(() => parseReplayDocument({ format: 'hexfield-replay', v: 2 })).toThrow(
      'not a Hexfield replay',
    );
  });

  test('reject a tampered game even when the string itself is well formed', async () => {
    const batches = save.batches.map((batch) => ({ ...batch }));
    const index = batches.findIndex(
      (batch) => batch.submitted.kind === 'command' && batch.submitted.command.type === 'END_TURN',
    );
    const target = batches[index];
    if (!target) throw new Error('Golden prefix has no ended turn');
    batches.splice(index, 1);
    const tampered: LocalReplayDocument = { ...document, save: { ...save, batches } };
    const decoded = await decodeReplayString(await encodeReplayString(tampered));
    const parsed = parseReplayDocument(decoded);
    if (parsed.kind !== 'local') throw new Error('Expected a local replay');
    expect(() => loadLocalReplay({ document: parsed.document }, name)).toThrow(
      'local-session-restore',
    );
    const forgedHash = { ...document, save: { ...save, finalHash: '0'.repeat(64) } };
    expect(() => loadLocalReplay({ document: forgedHash }, name)).toThrow(/hash|differs/i);
  });
});
