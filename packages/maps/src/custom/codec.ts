import { canonicalEncode, fromBase64Url, toBase64Url } from '@cp2p/codec';
import { failure } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { MAP_FORMAT, MAP_LIMITS, canonicalMap, parseMapDef } from './schema.js';
import type { MapDef } from './schema.js';

/** Share strings start with this prefix: the format name and version. */
export const MAP_PREFIX = `HXMAP${MAP_FORMAT}.`;

/** The canonical JSON bytes of a map: sorted keys, canonical order, no whitespace. */
export function mapBytes(map: MapDef): Uint8Array {
  return canonicalEncode(canonicalMap(map));
}

/** The canonical JSON text of a map, as written to a `.json` file. */
export function mapJson(map: MapDef): string {
  return new TextDecoder().decode(mapBytes(map));
}

async function transform(
  bytes: Uint8Array,
  mode: 'compress' | 'decompress',
  limit: number,
): Promise<Uint8Array> {
  const stream =
    mode === 'compress'
      ? new CompressionStream('deflate-raw')
      : new DecompressionStream('deflate-raw');
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
      if (length > limit) throw new RangeError('Map exceeds its size limit');
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

/** `HXMAP1.` + base64url(deflate-raw(canonical JSON)). */
export async function encodeMap(map: MapDef): Promise<string> {
  const bytes = mapBytes(map);
  if (bytes.length > MAP_LIMITS.jsonBytes) throw new RangeError('Map exceeds its size limit');
  return MAP_PREFIX + toBase64Url(await transform(bytes, 'compress', MAP_LIMITS.shareChars));
}

function parseJson(text: string): Result<MapDef> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return failure('MAP_MALFORMED', 'Map is not valid JSON');
  }
  return parseMapDef(value);
}

/** Read a share string. Malformed, oversized or schema-invalid input is refused, never thrown. */
export async function decodeMap(text: string): Promise<Result<MapDef>> {
  const trimmed = text.trim();
  if (!trimmed.startsWith(MAP_PREFIX))
    return failure('MAP_MALFORMED', `Map strings start with ${MAP_PREFIX}`);
  if (trimmed.length > MAP_LIMITS.shareChars)
    return failure('MAP_TOO_LARGE', 'Map string is too long');
  let json: string;
  try {
    const packed = fromBase64Url(trimmed.slice(MAP_PREFIX.length));
    const bytes = await transform(packed, 'decompress', MAP_LIMITS.jsonBytes);
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    return error instanceof RangeError
      ? failure('MAP_TOO_LARGE', 'Map is too large')
      : failure('MAP_MALFORMED', 'Map string is damaged');
  }
  return parseJson(json);
}

/**
 * Read a map from whatever a player pastes or opens: a share string, a link carrying one in its
 * `map` parameter, or the map's JSON.
 */
export async function importMap(text: string): Promise<Result<MapDef>> {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    if (new TextEncoder().encode(trimmed).length > MAP_LIMITS.jsonBytes)
      return failure('MAP_TOO_LARGE', 'Map is too large');
    return parseJson(trimmed);
  }
  const linked = /[?&]map=([^&#\s]+)/.exec(trimmed);
  if (linked?.[1]) {
    let value: string;
    try {
      value = decodeURIComponent(linked[1]);
    } catch {
      return failure('MAP_MALFORMED', 'Map link is damaged');
    }
    return decodeMap(value);
  }
  return decodeMap(trimmed);
}
