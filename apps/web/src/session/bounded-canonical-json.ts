/** Cheap structural bound before canonicalDecode allocates and re-encodes JSON. */
export function boundedCanonicalJsonStructure(
  bytes: Uint8Array,
  maxNodes: number,
  maxDepth = 64,
): boolean {
  let quoted = false;
  let escaped = false;
  let depth = 0;
  let nodes = 0;
  for (const byte of bytes) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (byte === 92) escaped = true;
      else if (byte === 34) quoted = false;
      continue;
    }
    if (byte === 34) {
      quoted = true;
      nodes += 1;
    } else if (byte === 123 || byte === 91) {
      depth += 1;
      nodes += 1;
      if (depth > maxDepth) return false;
    } else if (byte === 125 || byte === 93) {
      depth -= 1;
      if (depth < 0) return false;
    } else if (byte === 44 || byte === 58) nodes += 1;
    if (nodes > maxNodes) return false;
  }
  return !quoted && depth === 0;
}
