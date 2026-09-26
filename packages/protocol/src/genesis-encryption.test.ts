import { toBase64Url } from '@cp2p/codec';
import { encodePoint, G, scalePoint } from '@cp2p/crypto';
import { describe, expect, test, vi } from 'vitest';
import {
  deckCeremonyId,
  genesisDeckDefinitions,
  validateDeckGenesisCommitments,
} from './deck-genesis.js';
import {
  genesisDigest,
  genesisId,
  signGenesis,
  signVerifiedGenesis,
  validateGenesis,
} from './genesis.js';
import { validateGenesisEncryption } from './genesis-encryption.js';
import { fixtureAt, protocolFixture } from './testing/fixtures.js';
import type { Genesis, GenesisBody } from './types.js';

function encryptionKeys(): string[] {
  return [0, 1, 2, 3].map((seat) => encodePoint(scalePoint(G, BigInt(seat + 101))));
}

function withEncryptionKeys(body: GenesisBody, keys: readonly (string | undefined)[]): GenesisBody {
  return {
    ...body,
    seats: body.seats.map((seat, index) => {
      const changed = { ...seat };
      const encryptionKey = keys[index];
      if (encryptionKey === undefined) delete changed.encryptionKey;
      else changed.encryptionKey = encryptionKey;
      return changed;
    }),
  };
}

function verifiedBody(): { fixture: ReturnType<typeof protocolFixture>; body: GenesisBody } {
  const fixture = protocolFixture();
  const base: GenesisBody = {
    ...fixture.body,
    security: 'verified',
    commitments: {},
  };
  const body = withEncryptionKeys(base, encryptionKeys());
  return { fixture, body };
}

function signedGenesis(
  body: GenesisBody,
  identities: ReturnType<typeof protocolFixture>['identities'],
): Genesis {
  return {
    ...body,
    gameId: genesisId(body),
    signatures: body.seats
      .filter((seat) => seat.kind === 'human')
      .map((seat) => signGenesis(body, seat.seat, fixtureAt(identities, seat.seat).secretKey)),
  };
}

function errorCode(result: { ok: boolean; error?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

describe('genesis encryption key binding', () => {
  test('requires distinct canonical non-identity encryption keys for every verified seat', () => {
    const { body } = verifiedBody();
    const keys = encryptionKeys();
    const firstKey = keys[0];
    const secondKey = keys[1];
    const fourthKey = keys[3];
    if (!firstKey || !secondKey || !fourthKey) throw new Error('Missing encryption fixture key.');
    const malformedPoint = toBase64Url(new Uint8Array(32).fill(255));
    const candidates = [
      withEncryptionKeys(body, [undefined, ...keys.slice(1)]),
      withEncryptionKeys(body, [firstKey, firstKey, ...keys.slice(2)]),
      withEncryptionKeys(body, [encodePoint(scalePoint(G, 0n)), ...keys.slice(1)]),
      withEncryptionKeys(body, [malformedPoint, ...keys.slice(1)]),
      withEncryptionKeys(body, [firstKey, secondKey, undefined, fourthKey]),
      withEncryptionKeys(body, [firstKey, secondKey, firstKey, fourthKey]),
    ];
    for (const candidate of candidates)
      expect(errorCode(validateGenesisEncryption(candidate))).toBe('genesis-encryption-key');
  });

  test('fails before commitment callbacks or deck verification can authorize bad keys', () => {
    const { fixture, body } = verifiedBody();
    const callback = vi.fn<() => { ok: true; value: undefined }>(() => ({
      ok: true,
      value: undefined,
    }));
    const missingKey = withEncryptionKeys(body, [undefined, ...encryptionKeys().slice(1)]);
    const genesis = signedGenesis(missingKey, fixture.identities);

    expect(
      errorCode(validateGenesis(genesis, fixture.engine, { verifyCommitments: callback })),
    ).toBe('genesis-encryption-key');
    expect(callback).not.toHaveBeenCalled();
    expect(
      errorCode(signVerifiedGenesis(missingKey, [], 0, fixtureAt(fixture.identities, 0).secretKey)),
    ).toBe('genesis-encryption-key');
  });

  test('stub genesis cannot advertise encryption keys', () => {
    const fixture = protocolFixture();
    const body = withEncryptionKeys(fixture.body, encryptionKeys());
    expect(errorCode(validateGenesisEncryption(body))).toBe('stub-encryption');
    const genesis = signedGenesis(body, fixture.identities);
    expect(errorCode(validateGenesis(genesis, fixture.engine, { allowStub: true }))).toBe(
      'stub-encryption',
    );
  });

  test('encryption keys change the genesis and deck ceremony ids and invalidate old definitions', () => {
    const { body } = verifiedBody();
    const originalDefinitions = genesisDeckDefinitions(body);
    expect(originalDefinitions.ok).toBe(true);
    if (!originalDefinitions.ok) throw new Error(originalDefinitions.error.message);
    const originalDefinition = fixtureAt(originalDefinitions.value, 0);
    const commitmentBody: GenesisBody = {
      ...body,
      commitments: {
        decks: [
          {
            definition: originalDefinition,
            passHashes: Array.from(
              { length: originalDefinition.participants.length * 2 },
              (_, at) => at.toString(16).padStart(64, '0'),
            ),
            finalStateHash: 'f'.repeat(64),
          },
        ],
      },
    };
    const changed = withEncryptionKeys(commitmentBody, [
      encodePoint(scalePoint(G, 211n)),
      ...encryptionKeys().slice(1),
    ]);

    expect(genesisDigest(changed)).not.toBe(genesisDigest(commitmentBody));
    expect(deckCeremonyId(changed)).not.toBe(deckCeremonyId(commitmentBody));
    expect(errorCode(validateDeckGenesisCommitments(changed))).toBe('deck-genesis-definition');
  });
});
