import { canonicalDecode, canonicalEncode, fromBase64Url, toBase64Url } from '@cp2p/codec';
import * as v from 'valibot';
import { MAX_ONLINE_PUBLIC_ARCHIVE_BYTES } from '../../session/online-public-archive-format.js';

/** A replay string: this prefix, then base64url(deflate-raw(canonical JSON)). */
export const REPLAY_STRING_PREFIX = 'HXREPLAY1.';
/** Longer strings get a warning: common chat apps cap a message at about 2,000 characters. */
export const CHAT_LENGTH_LIMIT = 2_000;
const MAX_STRING_LENGTH = 24 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_TEXT = Math.ceil((MAX_ONLINE_PUBLIC_ARCHIVE_BYTES * 4) / 3) + 4;

const base64url = /^[A-Za-z0-9_-]*$/;

const localSchema = v.strictObject({
  format: v.literal('hexfield-replay'),
  v: v.literal(1),
  kind: v.literal('local'),
  /** A local save: its inputs are the game's authority and replay to its final hash. */
  save: v.unknown(),
  presentation: v.optional(v.unknown()),
});

const onlineSchema = v.strictObject({
  format: v.literal('hexfield-replay'),
  v: v.literal(1),
  kind: v.literal('online'),
  /** A signed public archive (HXAR1): genesis, certificates and the certified inputs. */
  archive: v.pipe(v.string(), v.maxLength(MAX_ARCHIVE_TEXT), v.regex(base64url)),
  /** The masters every seat revealed for the audit; with them the replay shows every hand. */
  masters: v.optional(
    v.pipe(
      v.array(
        v.strictObject({
          seat: v.picklist([0, 1, 2, 3, 4, 5] as const),
          master: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/)),
        }),
      ),
      v.minLength(2),
      v.maxLength(6),
    ),
  ),
});

/** The exported local replay file (`hexfield-local-replay` v2), checked in full by its parser. */
const legacyLocalSchema = v.looseObject({
  format: v.literal('hexfield-local-replay'),
  v: v.literal(2),
});

export type LocalReplayDocument = v.InferOutput<typeof localSchema>;
export type OnlineReplayDocument = v.InferOutput<typeof onlineSchema>;
export type ReplayDocument = LocalReplayDocument | OnlineReplayDocument;

/** The recognised shapes; the contents are verified by whoever opens them. */
export type ParsedReplay =
  | { readonly kind: 'local'; readonly document: LocalReplayDocument }
  | { readonly kind: 'local-file'; readonly replay: unknown }
  | { readonly kind: 'online'; readonly document: OnlineReplayDocument };

/** Checks only the outer shape. Local saves and archives are verified when they are opened. */
export function parseReplayDocument(raw: unknown): ParsedReplay {
  const local = v.safeParse(localSchema, raw);
  if (local.success) return { kind: 'local', document: local.output };
  const online = v.safeParse(onlineSchema, raw);
  if (online.success) return { kind: 'online', document: online.output };
  if (v.safeParse(legacyLocalSchema, raw).success) return { kind: 'local-file', replay: raw };
  throw new Error('This is not a Hexfield replay');
}

export function onlineReplayDocument(
  archive: Uint8Array,
  masters: OnlineReplayDocument['masters'] | null,
): OnlineReplayDocument {
  return {
    format: 'hexfield-replay',
    v: 1,
    kind: 'online',
    archive: toBase64Url(archive),
    ...(masters ? { masters } : {}),
  };
}

export function archiveBytes(document: OnlineReplayDocument): Uint8Array {
  const bytes = fromBase64Url(document.archive);
  if (bytes.length > MAX_ONLINE_PUBLIC_ARCHIVE_BYTES)
    throw new Error('Replay archive exceeds its size limit');
  return bytes;
}

async function transform(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
  limit: number,
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const input = new Uint8Array(bytes.length);
  input.set(bytes);
  const writing = writer.write(input).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- The output is capped while it streams.
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > limit) throw new RangeError('Replay exceeds its size limit');
      chunks.push(next.value);
    }
    await writing;
  } catch (error) {
    await Promise.allSettled([reader.cancel(), writer.abort()]);
    void writing.catch(() => undefined);
    throw error;
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

/** `HXREPLAY1.` + base64url(deflate-raw(canonical JSON of the document)). */
export async function encodeReplayString(document: ReplayDocument): Promise<string> {
  const json = canonicalEncode(document);
  const compressed = await transform(json, new CompressionStream('deflate-raw'), MAX_STRING_LENGTH);
  return `${REPLAY_STRING_PREFIX}${toBase64Url(compressed)}`;
}

/** Decodes a pasted replay string to its JSON value; blanks and line breaks are ignored. */
export async function decodeReplayString(text: string): Promise<unknown> {
  const compact = text.replace(/\s+/g, '');
  if (!compact.startsWith(REPLAY_STRING_PREFIX)) throw new Error('This is not a replay string');
  if (compact.length > MAX_STRING_LENGTH) throw new RangeError('Replay exceeds its size limit');
  const body = compact.slice(REPLAY_STRING_PREFIX.length);
  if (!body || !base64url.test(body)) throw new Error('The replay string is damaged');
  let json: Uint8Array;
  try {
    json = await transform(
      fromBase64Url(body),
      new DecompressionStream('deflate-raw'),
      MAX_JSON_BYTES,
    );
  } catch (error) {
    if (error instanceof RangeError) throw error;
    throw new Error('The replay string is damaged', { cause: error });
  }
  try {
    // Rejects any JSON that is not the canonical encoding of its value.
    return canonicalDecode(json);
  } catch (error) {
    throw new Error('The replay string is not canonical JSON', { cause: error });
  }
}

export function tooLongForChat(text: string): boolean {
  return text.length > CHAT_LENGTH_LIMIT;
}
