import { canonicalEncode, toBase64Url } from '@cp2p/codec';
import { describe, expect, test } from 'vitest';
import { validateOnlinePublicArchive } from './online-public-archive.js';
import { validateOnlineTransferBootstrap } from './online-transfer-bootstrap.js';

const encoder = new TextEncoder();
const expected = {
  gameId: 'A'.repeat(22),
  genesisDigest: toBase64Url(new Uint8Array(32)),
};

describe('public bootstrap structural preflight', () => {
  test('rejects excessive nesting before canonical decoding', () => {
    const bootstrap = encoder.encode(`${'['.repeat(65)}null${']'.repeat(65)}`);
    const checked = validateOnlineTransferBootstrap(bootstrap, expected);
    expect(checked).toMatchObject({ ok: false, error: { code: 'transfer-bootstrap-size' } });

    const header = canonicalEncode({
      format: 'online-public-archive-v1',
      gameId: expected.gameId,
      genesisDigest: expected.genesisDigest,
    });
    const archive = new Uint8Array(7 + header.length + bootstrap.length);
    archive.set(encoder.encode('HXAR1'));
    archive[5] = header.length >> 8;
    archive[6] = header.length & 0xff;
    archive.set(header, 7);
    archive.set(bootstrap, 7 + header.length);
    const publicChecked = validateOnlinePublicArchive(archive);
    expect(publicChecked).toMatchObject({ ok: false, error: { code: 'transfer-bootstrap-size' } });
  });

  test('rejects excessive nodes within the byte cap', () => {
    const bootstrap = encoder.encode(`[${'null,'.repeat(600_001)}null]`);
    const checked = validateOnlineTransferBootstrap(bootstrap, expected);
    expect(checked).toMatchObject({ ok: false, error: { code: 'transfer-bootstrap-size' } });
  });
});
