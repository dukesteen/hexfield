import { toBase64Url } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import { expect, test } from 'vitest';
import { decodeManualCode, encodeManualCode, manualOfferHash } from './manual-code.js';
import { aggregateManualSdp } from './manual-sdp.js';

const sdp =
  [
    'v=0',
    'o=- 1234 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE data',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:abcd',
    'a=ice-pwd:abcdefghijklmnopqrstuvwx',
    `a=fingerprint:sha-256 ${Array(32).fill('AA').join(':')}`,
    'a=setup:actpass',
    'a=mid:data',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    'a=x-browser-required:preserve-me',
  ].join('\r\n') + '\r\n';

test('manual SDP keeps unknown negotiation attributes and all distinct candidates', () => {
  const candidates = [
    { candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', sdpMid: 'data' },
    { candidate: 'candidate:2 1 udp 1 198.51.100.2 6000 typ srflx', sdpMid: 'data' },
    { candidate: 'candidate:3 1 udp 1 203.0.113.3 7000 typ relay', sdpMid: 'data' },
  ];
  const joined = aggregateManualSdp(sdp, [
    ...candidates,
    { candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host', sdpMid: 'data' },
  ]);
  expect(joined).toContain('a=x-browser-required:preserve-me');
  expect(joined.match(/a=candidate:/g)).toHaveLength(3);
  expect(joined.endsWith('a=end-of-candidates\r\n')).toBe(true);
  expect(() => aggregateManualSdp(sdp, [{ ...candidates[0], sdpMid: 'other' }])).toThrow(
    'another media section',
  );
  expect(() => aggregateManualSdp(sdp.replace('a=sctp-port:5000\r\n', ''))).toThrow(
    'lacks a=sctp-port:',
  );
});

test('HX1 codes verify signatures, offer hash, scope, recipient and strict framing', async () => {
  const host = identityFromSecret(new Uint8Array(32).fill(11));
  const guest = identityFromSecret(new Uint8Array(32).fill(12));
  try {
    const offerCode = await encodeManualCode(
      {
        v: 1,
        k: 'o',
        sc: 'lobby:example',
        f: host.peerId,
        n: 'AAAAAAAAAAAAAAAAAAAAAA',
        s: aggregateManualSdp(sdp),
      },
      host.secretKey,
    );
    expect(offerCode.startsWith('HX1.')).toBe(true);
    const offer = await decodeManualCode(offerCode, 'lobby:example', guest.peerId);
    const answerCode = await encodeManualCode(
      {
        v: 1,
        k: 'a',
        sc: 'lobby:example',
        f: guest.peerId,
        t: host.peerId,
        n: offer.b.n,
        h: manualOfferHash(offer),
        s: aggregateManualSdp(sdp),
      },
      guest.secretKey,
    );
    const answer = await decodeManualCode(answerCode, 'lobby:example', host.peerId);
    expect(answer.b.k).toBe('a');
    await expect(decodeManualCode(offerCode, 'lobby:other')).rejects.toThrow('scope');
    await expect(decodeManualCode(answerCode, 'lobby:example', guest.peerId)).rejects.toThrow(
      'recipient',
    );
    await expect(decodeManualCode('HX2.' + offerCode.slice(4), 'lobby:example')).rejects.toThrow(
      'HX1',
    );
    const last = offerCode.at(-1) === 'A' ? 'B' : 'A';
    await expect(
      decodeManualCode(offerCode.slice(0, -1) + last, 'lobby:example'),
    ).rejects.toBeInstanceOf(Error);
    expect(offerCode.length).toBeLessThanOrEqual(2_048);
  } finally {
    host.secretKey.fill(0);
    guest.secretKey.fill(0);
  }
});

test('oversized compressed codes fail instead of dropping ICE or SDP attributes', async () => {
  const owner = identityFromSecret(new Uint8Array(32).fill(13));
  let seed = 0x1234_5678;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const noise = Array.from({ length: 3_000 }, () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return alphabet[seed & 63];
  }).join('');
  try {
    await expect(
      encodeManualCode(
        {
          v: 1,
          k: 'o',
          sc: 'lobby:example',
          f: owner.peerId,
          n: 'AAAAAAAAAAAAAAAAAAAAAA',
          s: aggregateManualSdp(`${sdp}a=x-required-browser-attribute:${noise}\r\n`),
        },
        owner.secretKey,
      ),
    ).rejects.toThrow('size limit');
  } finally {
    owner.secretKey.fill(0);
  }
});

test('bounded decompression rejects a small HX1 zip bomb', async () => {
  const source = new Blob(['A'.repeat(90_000)])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(source).arrayBuffer());
  expect(bytes.length).toBeLessThan(1_533);
  await expect(decodeManualCode(`HX1.${toBase64Url(bytes)}`, 'lobby:example')).rejects.toThrow(
    'size limit',
  );
});
