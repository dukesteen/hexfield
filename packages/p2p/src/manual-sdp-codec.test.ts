import { expect, test } from 'vitest';
import { decodeManualSdpWire, encodeManualSdpWire } from './manual-sdp-codec.js';

test('SDP wire is exact for known Chrome fields and unknown future lines', () => {
  const sdp =
    [
      'v=0',
      'o=- 8765432109876543210 2 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'a=candidate:1234 1 udp 2122260223 47ce8c1a-5487-4b23-b56e-0568f17711b2.local 54462 typ host generation 0 network-cost 10',
      'a=candidate:relay 1 udp 123 192.0.2.3 4532 typ relay raddr 198.51.100.4 rport 5600',
      'a=ice-pwd:PLffwjvrnhTY+IKPgOvQunpo',
      `a=fingerprint:sha-256 ${Array(32).fill('A5').join(':')}`,
      'a=x-future-negotiation:preserve this exactly',
      'a=end-of-candidates',
    ].join('\r\n') + '\r\n';
  const wire = encodeManualSdpWire(sdp);
  expect(wire[0]).toBe(1);
  expect(decodeManualSdpWire(wire)).toBe(sdp);
});

test('literal mode preserves noncanonical line endings and avoids expansion', () => {
  const sdp = 'v=0\na=x-unknown:unusual\n';
  const wire = encodeManualSdpWire(sdp);
  expect(wire[0]).toBe(0);
  expect(decodeManualSdpWire(wire)).toBe(sdp);
  const manyShortLines = `${Array(500).fill('x').join('\r\n')}\r\n`;
  const fallback = encodeManualSdpWire(manyShortLines);
  expect(fallback[0]).toBe(0);
  expect(decodeManualSdpWire(fallback)).toBe(manyShortLines);
});

test('SDP wire rejects truncated and extra data', () => {
  expect(() => decodeManualSdpWire(new Uint8Array([1, 0, 1, 2]))).toThrow('invalid');
  const wire = encodeManualSdpWire('v=0\r\ns=-\r\n');
  expect(() => decodeManualSdpWire(new Uint8Array([...wire, 0]))).toThrow('invalid');
});
