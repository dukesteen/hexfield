const MAX_SDP_BYTES = 65_536;
const MAX_CANDIDATES = 16;

function linesOf(sdp: string): string[] {
  if (
    typeof sdp !== 'string' ||
    sdp.length < 1 ||
    new TextEncoder().encode(sdp).length > MAX_SDP_BYTES ||
    sdp.includes('\0')
  )
    throw new TypeError('Manual SDP is missing or too large');
  const lines = sdp.replaceAll('\r\n', '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.some((line) => line.includes('\r') || line.length > 4_096))
    throw new TypeError('Manual SDP contains an invalid line');
  return lines;
}

function candidateLine(value: string): string {
  if (!/^candidate:[^\r\n]{1,4096}$/.test(value))
    throw new TypeError('Manual ICE candidate is malformed');
  return `a=${value}`;
}

/** Preserve unknown negotiation attributes; only normalize duplicate ICE lines. */
export function aggregateManualSdp(
  sdp: string,
  candidates: readonly RTCIceCandidateInit[] = [],
): string {
  const lines = linesOf(sdp);
  const media = lines.filter((line) => line.startsWith('m='));
  if (media.length !== 1 || !media[0]?.startsWith('m=application '))
    throw new TypeError('Manual bootstrap needs one data-channel media section');
  for (const required of [
    'v=',
    'o=',
    's=',
    't=',
    'a=ice-ufrag:',
    'a=ice-pwd:',
    'a=fingerprint:',
    'a=setup:',
    'a=mid:',
    'a=sctp-port:',
  ])
    if (!lines.some((line) => line.startsWith(required)))
      throw new TypeError(`Manual SDP lacks ${required}`);
  const mid = lines.find((line) => line.startsWith('a=mid:'))?.slice('a=mid:'.length);
  const gathered = new Set<string>();
  for (const line of lines) {
    if (line.startsWith('a=candidate:')) gathered.add(candidateLine(line.slice(2)));
  }
  for (const candidate of candidates) {
    if (candidate.sdpMid !== undefined && candidate.sdpMid !== null && candidate.sdpMid !== mid)
      throw new TypeError('Manual ICE candidate belongs to another media section');
    if (
      candidate.sdpMLineIndex !== undefined &&
      candidate.sdpMLineIndex !== null &&
      candidate.sdpMLineIndex !== 0
    )
      throw new TypeError('Manual ICE candidate belongs to another media section');
    gathered.add(candidateLine(candidate.candidate ?? ''));
  }
  if (gathered.size > MAX_CANDIDATES)
    throw new RangeError('Manual code has too many distinct ICE candidates');
  const retained = lines.filter(
    (line) => !line.startsWith('a=candidate:') && line !== 'a=end-of-candidates',
  );
  const result = [...retained, ...gathered, 'a=end-of-candidates'].join('\r\n') + '\r\n';
  if (new TextEncoder().encode(result).length > MAX_SDP_BYTES)
    throw new RangeError('Manual SDP exceeds its size limit');
  return result;
}
