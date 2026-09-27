/** Reversible SDP wire encoding. Unrecognized lines are kept verbatim. */
const constants = [
  'v=0',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=group:BUNDLE data',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=ice-options:trickle',
  'a=setup:actpass',
  'a=setup:active',
  'a=setup:passive',
  'a=mid:0',
  'a=mid:data',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  'a=end-of-candidates',
] as const;

const prefixes = [
  'a=ice-ufrag:',
  'a=ice-pwd:',
  'a=group:BUNDLE ',
  'a=mid:',
  'a=setup:',
  'a=sctp-port:',
  'a=max-message-size:',
  'a=ice-options:',
  'a=msid-semantic:',
  'a=candidate:',
] as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_SDP_BYTES = 65_536;
const MAX_LINES = 1_024;
const MDNS_HOST =
  /^a=candidate:([^ ]{1,32}) 1 udp ([1-9][0-9]{0,9}) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.local ([1-9][0-9]{0,4}) typ host generation 0 network-cost (0|[1-9][0-9]{0,4})$/;
const ORIGIN = /^o=- (0|[1-9][0-9]{0,19}) (0|[1-9][0-9]{0,9}) IN IP4 127\.0\.0\.1$/;
const FINGERPRINT = /^a=fingerprint:sha-256 ((?:[0-9A-F]{2}:){31}[0-9A-F]{2})$/;

function invalid(): never {
  throw new TypeError('Manual SDP wire is invalid');
}

class Writer {
  private readonly bytes: number[] = [];

  byte(value: number): void {
    this.bytes.push(value);
  }

  u16(value: number): void {
    this.bytes.push(value >>> 8, value & 255);
  }

  u32(value: number): void {
    this.bytes.push(value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
  }

  data(value: Uint8Array): void {
    for (const byte of value) this.bytes.push(byte);
  }

  result(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  byte(): number {
    if (this.offset >= this.bytes.length) return invalid();
    return this.bytes[this.offset++] ?? invalid();
  }

  u16(): number {
    return (this.byte() << 8) | this.byte();
  }

  u32(): number {
    return (this.byte() * 0x1000000 + (this.byte() << 16) + (this.byte() << 8) + this.byte()) >>> 0;
  }

  data(length: number): Uint8Array {
    if (length < 0 || length > this.bytes.length - this.offset) return invalid();
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  text(length: number): string {
    return decoder.decode(this.data(length));
  }

  done(): boolean {
    return this.offset === this.bytes.length;
  }
}

function hexBytes(hex: string): Uint8Array {
  const result = new Uint8Array(hex.length / 2);
  for (let i = 0; i < result.length; i++)
    result[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return result;
}

function uuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function writeLine(writer: Writer, line: string): void {
  const constant = constants.findIndex((value) => value === line);
  if (constant >= 0) {
    writer.byte(1);
    writer.byte(constant);
    return;
  }
  const fingerprint = FINGERPRINT.exec(line)?.[1];
  if (fingerprint) {
    writer.byte(2);
    writer.data(hexBytes(fingerprint.replaceAll(':', '')));
    return;
  }
  const candidate = MDNS_HOST.exec(line);
  if (candidate) {
    const [, foundation, priorityText, host, portText, costText] = candidate;
    const priority = Number(priorityText);
    const port = Number(portText);
    const cost = Number(costText);
    if (
      foundation &&
      host &&
      Number.isInteger(priority) &&
      priority <= 0xffff_ffff &&
      port > 0 &&
      port <= 0xffff &&
      cost <= 0xffff &&
      /^[!-~]+$/.test(foundation)
    ) {
      writer.byte(3);
      writer.byte(foundation.length);
      writer.data(encoder.encode(foundation));
      writer.u32(priority);
      writer.data(hexBytes(host.replaceAll('-', '')));
      writer.u16(port);
      writer.u16(cost);
      return;
    }
  }
  const origin = ORIGIN.exec(line);
  if (origin?.[1] && origin[2]) {
    const session = BigInt(origin[1]);
    const version = Number(origin[2]);
    if (session <= 0xffff_ffff_ffff_ffffn && version <= 0xffff_ffff) {
      writer.byte(4);
      for (let shift = 56n; shift >= 0n; shift -= 8n)
        writer.byte(Number((session >> shift) & 255n));
      writer.u32(version);
      return;
    }
  }
  const prefix = prefixes.findIndex((value) => line.startsWith(value));
  if (prefix >= 0) {
    const suffix = encoder.encode(line.slice(prefixes[prefix]?.length));
    writer.byte(5);
    writer.byte(prefix);
    writer.u16(suffix.length);
    writer.data(suffix);
    return;
  }
  const raw = encoder.encode(line);
  writer.byte(0);
  writer.u16(raw.length);
  writer.data(raw);
}

/** Exact SDP bytes are restored; this never removes candidate or negotiation lines. */
export function encodeManualSdpWire(sdp: string): Uint8Array {
  const raw = encoder.encode(sdp);
  if (raw.length > MAX_SDP_BYTES) throw new RangeError('Manual SDP exceeds its size limit');
  const literal = () => {
    const writer = new Writer();
    writer.byte(0);
    writer.data(raw);
    return writer.result();
  };
  const lines = sdp.endsWith('\r\n') ? sdp.slice(0, -2).split('\r\n') : [];
  if (lines.length < 1 || lines.length > MAX_LINES || lines.some((line) => line.includes('\n')))
    return literal();
  const writer = new Writer();
  writer.byte(1);
  writer.u16(lines.length);
  for (const line of lines) writeLine(writer, line);
  const compact = writer.result();
  return compact.length < raw.length + 1 ? compact : literal();
}

export function decodeManualSdpWire(bytes: Uint8Array): string {
  if (bytes.length < 2 || bytes.length > MAX_SDP_BYTES + 1) return invalid();
  const reader = new Reader(bytes);
  const mode = reader.byte();
  if (mode === 0) return reader.text(bytes.length - 1);
  if (mode !== 1) return invalid();
  const count = reader.u16();
  if (count < 1 || count > MAX_LINES) return invalid();
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const tag = reader.byte();
    let line: string;
    switch (tag) {
      case 0:
        line = reader.text(reader.u16());
        break;
      case 1:
        line = constants[reader.byte()] ?? invalid();
        break;
      case 2: {
        const hex = Array.from(reader.data(32), (byte) =>
          byte.toString(16).padStart(2, '0').toUpperCase(),
        );
        line = `a=fingerprint:sha-256 ${hex.join(':')}`;
        break;
      }
      case 3: {
        const foundation = reader.text(reader.byte());
        const priority = reader.u32();
        const host = uuid(reader.data(16));
        const port = reader.u16();
        const cost = reader.u16();
        line = `a=candidate:${foundation} 1 udp ${priority} ${host}.local ${port} typ host generation 0 network-cost ${cost}`;
        break;
      }
      case 4: {
        let session = 0n;
        for (let j = 0; j < 8; j++) session = (session << 8n) | BigInt(reader.byte());
        line = `o=- ${session} ${reader.u32()} IN IP4 127.0.0.1`;
        break;
      }
      case 5: {
        const prefix = prefixes[reader.byte()] ?? invalid();
        line = prefix + reader.text(reader.u16());
        break;
      }
      default:
        return invalid();
    }
    lines.push(line);
  }
  if (!reader.done()) return invalid();
  const sdp = `${lines.join('\r\n')}\r\n`;
  if (encoder.encode(sdp).length > MAX_SDP_BYTES) return invalid();
  return sdp;
}
