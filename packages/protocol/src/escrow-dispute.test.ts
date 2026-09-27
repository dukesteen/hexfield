import { canonicalEncode, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import {
  DERIVATION_LABELS,
  G,
  decodePoint,
  decodeScalar,
  deriveScalar,
  encodePoint,
  encodeScalar,
  identityFromSecret,
  invertScalar,
  modScalar,
  openSealed,
  proveDleq,
  scalePoint,
  sealWithEphemeralProof,
  signObject,
} from '@cp2p/crypto';
import type { DleqProof } from '@cp2p/crypto';
import type { Result, Seat } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import {
  createEscrowShareEnvelopes,
  escrowShareEnvelopeHash,
  verifyEscrowShareEphemeralProof,
} from './escrow-distribution.js';
import type { EscrowShareEnvelope } from './escrow-distribution.js';
import { createEscrowShareDispute, verifyEscrowShareDispute } from './escrow-dispute.js';
import type { EscrowShareDispute } from './escrow-dispute.js';
import { escrowDeliveryContexts, readEscrowShareOpening } from './escrow-opening.js';
import { protocolFixture } from './testing/fixtures.js';
import type { GenesisBody } from './types.js';

const identities = [1, 2, 3, 4].map((n) => identityFromSecret(new Uint8Array(32).fill(n + 100)));
const encryption = [31n, 32n, 33n, 34n];
const master = 81n;
const entropy = new Uint8Array(32).fill(95);
const proofSeed = new Uint8Array(32).fill(96);

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture value');
  return value;
}

function get<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function fixture() {
  const genesis: GenesisBody = {
    ...protocolFixture().body,
    security: 'verified',
    seats: ([0, 1, 2, 3] as const).map((seat) => ({
      seat,
      kind: 'human',
      name: `Human ${seat}`,
      colour: '#123456',
      publicKey: required(identities[seat]).peerId,
      encryptionKey: encodePoint(scalePoint(G, required(encryption[seat]))),
    })),
    commitments: {
      masters: identities.map((_, seat) => ({
        seat,
        masterPub: encodePoint(scalePoint(G, master + BigInt(seat))),
      })),
    },
  };
  const envelope = required(
    get(
      createEscrowShareEnvelopes({
        genesis,
        dealerSeat: 0,
        expectedMasterPub: encodePoint(scalePoint(G, master)),
        masterSecret: master,
        entropy,
        dealerSigningKey: required(identities[0]).secretKey,
      }),
    )[0],
  );
  const input = {
    genesis,
    envelope,
    dealerSeat: 0 as Seat,
    holderSeat: 1 as Seat,
    recipientEncryptionSecret: required(encryption[1]),
    holderSigningKey: required(identities[1]).secretKey,
  };
  return { genesis, envelope, input };
}

function resign(body: EscrowShareEnvelope['body']): EscrowShareEnvelope {
  return { body, sig: signObject('escrow-share', body, required(identities[0]).secretKey) };
}

function changedDelivery(
  envelope: EscrowShareEnvelope,
  mode: 'share' | 'hash' | 'holder' | 'encoding' | 'scalar',
): EscrowShareEnvelope {
  const prior = envelope.body;
  let payload = canonicalEncode({
    protocol: prior.protocol,
    ceremonyId: prior.ceremonyId,
    dealerSeat: prior.dealer.seat,
    holderSeat: mode === 'holder' ? 2 : prior.holder.seat,
    holderIndex: prior.holder.index,
    threshold: prior.threshold,
    masterPub: prior.masterPub,
    share: mode === 'scalar' ? toBase64Url(new Uint8Array(32).fill(255)) : encodeScalar(999n),
  });
  if (mode === 'encoding') payload = new Uint8Array(payload.length);
  const shareHash =
    mode === 'hash'
      ? prior.shareHash
      : toHex(hashValue({ domain: 'cp2p/v1/escrow-share-payload', payload }));
  const body = { ...prior, shareHash };
  const contexts = escrowDeliveryContexts(body);
  const sealed = sealWithEphemeralProof(
    payload,
    prior.holder.encryptionKey,
    entropy,
    contexts.seal,
    contexts.proof,
  );
  payload.fill(0);
  return resign({ ...body, ...sealed });
}

function signDispute(body: EscrowShareDispute['body']): EscrowShareDispute {
  return { body, sig: signObject('escrow-share-dispute', body, required(identities[1]).secretKey) };
}

describe('authenticated bad escrow delivery disputes', () => {
  test.each(['share', 'hash', 'holder', 'encoding', 'scalar'] as const)(
    'proves a dealer-signed bad %s and binds the exact sealed envelope',
    (mode) => {
      const { genesis, envelope, input } = fixture();
      const bad = changedDelivery(envelope, mode);
      expect(verifyEscrowShareEphemeralProof(bad, genesis, 0, bad.body.masterPub).ok).toBe(true);
      const dispute = get(createEscrowShareDispute({ ...input, envelope: bad }));
      expect(dispute.body.envelopeHash).toBe(escrowShareEnvelopeHash(bad));
      expect(verifyEscrowShareDispute(dispute, bad, genesis)).toEqual({
        ok: true,
        value: { kind: 'bad-share', dealerSeat: 0, dispute },
      });
      expect(verifyEscrowShareDispute(dispute, envelope, genesis).ok).toBe(false);
      expect(
        verifyEscrowShareDispute(dispute, bad, { ...genesis, ceremonyNonce: encodeScalar(444n) })
          .ok,
      ).toBe(false);
    },
  );

  test('refuses to disclose a good share and identifies a signed false complaint for retirement', () => {
    const { genesis, envelope, input } = fixture();
    expect(createEscrowShareDispute(input)).toMatchObject({
      ok: false,
      error: { code: 'escrow-good-delivery' },
    });
    const context = {
      protocol: 'escrow-share-dispute-v1' as const,
      ceremonyId: envelope.body.ceremonyId,
      dealerSeat: 0 as Seat,
      holderSeat: 1 as Seat,
      envelopeHash: escrowShareEnvelopeHash(envelope),
    };
    const sharedPoint = encodePoint(
      scalePoint(decodePoint(envelope.body.sealed.ephemeral), input.recipientEncryptionSecret),
    );
    const proof = proveDleq(
      {
        base1: encodePoint(G),
        point1: envelope.body.holder.encryptionKey,
        base2: envelope.body.sealed.ephemeral,
        point2: sharedPoint,
      },
      input.recipientEncryptionSecret,
      proofSeed,
      context,
    );
    const complaint = signDispute({ ...context, sharedPoint, proof });
    expect(verifyEscrowShareDispute(complaint, envelope, genesis)).toEqual({
      ok: true,
      value: { kind: 'false-complaint', holderSeat: 1, dispute: complaint },
    });
  });

  test('derives identical private proof randomness for retries and separates deliveries', () => {
    const { envelope, input } = fixture();
    const firstInput = { ...input, envelope: changedDelivery(envelope, 'share') };
    const first = get(createEscrowShareDispute(firstInput));
    expect(get(createEscrowShareDispute(firstInput))).toEqual(first);
    const other = get(
      createEscrowShareDispute({ ...input, envelope: changedDelivery(envelope, 'hash') }),
    );
    expect(other.body.proof.commitments).not.toEqual(first.body.proof.commitments);
  });

  test('a public nonce seed recovers the holder key from an unsafe proof but not a real complaint', () => {
    const { envelope, input } = fixture();
    const bad = changedDelivery(envelope, 'share');
    const complaint = get(createEscrowShareDispute({ ...input, envelope: bad }));
    const { proof: realProof, sharedPoint, ...context } = complaint.body;
    const statement = {
      base1: encodePoint(G),
      point1: bad.body.holder.encryptionKey,
      base2: bad.body.sealed.ephemeral,
      point2: sharedPoint,
    };
    function recoverWithKnownSeed(proof: DleqProof, knownSeed: Uint8Array): bigint {
      const nonce = deriveScalar(knownSeed, DERIVATION_LABELS.proofRandomness, {
        domain: 'dleq',
        context,
        statement,
        role: 'commitments',
      });
      const digest = hashValue([
        'cp2p/v1/fiat-shamir',
        'dleq',
        context,
        statement,
        proof.commitments,
      ]);
      const challenge = modScalar(BigInt(`0x${toHex(digest.toReversed())}`));
      return modScalar((decodeScalar(proof.response) - nonce) * invertScalar(challenge));
    }
    for (const publicSeed of [proofSeed, hashValue(context)]) {
      const unsafeProof = proveDleq(
        statement,
        input.recipientEncryptionSecret,
        publicSeed,
        context,
      );
      expect(recoverWithKnownSeed(unsafeProof, publicSeed)).toBe(input.recipientEncryptionSecret);
      expect(recoverWithKnownSeed(realProof, publicSeed)).not.toBe(input.recipientEncryptionSecret);
    }
  });

  test('uses only the detached canonical genesis when looking up the holder', () => {
    const { genesis, envelope, input } = fixture();
    const bad = changedDelivery(envelope, 'share');
    const complaint = get(createEscrowShareDispute({ ...input, envelope: bad }));
    Object.setPrototypeOf(genesis.seats, {
      find() {
        throw new Error('Untrusted inherited array method must not run');
      },
    });
    expect(verifyEscrowShareDispute(complaint, bad, genesis)).toMatchObject({
      ok: true,
      value: { kind: 'bad-share', dealerSeat: 0 },
    });
  });

  test('requires both dealer and holder signatures and the exact dealer binding', () => {
    const { genesis, envelope, input } = fixture();
    const bad = changedDelivery(envelope, 'share');
    const complaint = get(createEscrowShareDispute({ ...input, envelope: bad }));
    const forged = { ...bad, sig: toBase64Url(new Uint8Array(64)) };
    expect(createEscrowShareDispute({ ...input, envelope: forged })).toMatchObject({
      ok: false,
      error: { code: 'escrow-signature' },
    });
    expect(verifyEscrowShareDispute(complaint, forged, genesis)).toMatchObject({
      ok: false,
      error: { code: 'escrow-signature' },
    });
    const wrongHolder = {
      ...complaint,
      sig: signObject('escrow-share-dispute', complaint.body, required(identities[2]).secretKey),
    };
    expect(verifyEscrowShareDispute(wrongHolder, bad, genesis)).toMatchObject({
      ok: false,
      error: { code: 'escrow-dispute-signature' },
    });
    const wrongDealer = signDispute({ ...complaint.body, dealerSeat: 2 });
    expect(verifyEscrowShareDispute(wrongDealer, bad, genesis).ok).toBe(false);
  });

  test('rejects forged signatures, wrong decryption proofs and the wrong recipient keys', () => {
    const { genesis, envelope, input } = fixture();
    const bad = changedDelivery(envelope, 'share');
    const complaint = get(createEscrowShareDispute({ ...input, envelope: bad }));
    expect(
      verifyEscrowShareDispute({ ...complaint, sig: toBase64Url(new Uint8Array(64)) }, bad, genesis)
        .ok,
    ).toBe(false);
    const invalidProof = signDispute({
      ...complaint.body,
      proof: { ...complaint.body.proof, response: encodeScalar(0n) },
    });
    expect(verifyEscrowShareDispute(invalidProof, bad, genesis)).toMatchObject({
      ok: false,
      error: { code: 'escrow-dispute-proof' },
    });
    expect(createEscrowShareDispute({ ...input, envelope: bad, holderSeat: 2 }).ok).toBe(false);
    expect(
      createEscrowShareDispute({ ...input, envelope: bad, recipientEncryptionSecret: 99n }).ok,
    ).toBe(false);
    expect(
      createEscrowShareDispute({
        ...input,
        envelope: bad,
        holderSigningKey: required(identities[2]).secretKey,
      }).ok,
    ).toBe(false);
  });

  test('rejects a copied ephemeral point before releasing any shared point', () => {
    const { envelope, input } = fixture();
    const forged = resign({
      ...envelope.body,
      sealed: {
        ...envelope.body.sealed,
        ephemeral: required(input.genesis.seats[2]).encryptionKey ?? '',
      },
    });
    expect(createEscrowShareDispute({ ...input, envelope: forged })).toMatchObject({
      ok: false,
      error: { code: 'escrow-ephemeral-proof' },
    });
    const changedHash = resign({ ...envelope.body, shareHash: 'f'.repeat(64) });
    expect(createEscrowShareDispute({ ...input, envelope: changedHash })).toMatchObject({
      ok: false,
      error: { code: 'escrow-ephemeral-proof' },
    });
    const changedKey = resign({
      ...envelope.body,
      holder: { ...envelope.body.holder, encryptionKey: encodePoint(scalePoint(G, 99n)) },
    });
    expect(createEscrowShareDispute({ ...input, envelope: changedKey })).toMatchObject({
      ok: false,
      error: { code: 'escrow-binding' },
    });
  });

  test('rejects a copied sealed share and knowledge proof from another dealer', () => {
    const { genesis, envelope, input } = fixture();
    const otherDealer = required(
      get(
        createEscrowShareEnvelopes({
          genesis,
          dealerSeat: 2,
          expectedMasterPub: encodePoint(scalePoint(G, master + 2n)),
          masterSecret: master + 2n,
          entropy,
          dealerSigningKey: required(identities[2]).secretKey,
        }),
      ).find((other) => other.body.holder.seat === envelope.body.holder.seat),
    );
    const copied = resign({
      ...envelope.body,
      sealed: otherDealer.body.sealed,
      ephemeralProof: otherDealer.body.ephemeralProof,
    });
    expect(createEscrowShareDispute({ ...input, envelope: copied })).toMatchObject({
      ok: false,
      error: { code: 'escrow-ephemeral-proof' },
    });
  });

  test('acceptance and dispute parsing clear the plaintext buffers they consume', () => {
    const { envelope, input } = fixture();
    const bytes = openSealed(
      envelope.body.sealed,
      input.recipientEncryptionSecret,
      escrowDeliveryContexts(envelope.body).seal,
    );
    expect(readEscrowShareOpening(bytes, envelope.body).ok).toBe(true);
    expect(bytes.every((value) => value === 0)).toBe(true);
    const malformed = new Uint8Array([1, 2, 3]);
    expect(readEscrowShareOpening(malformed, envelope.body).ok).toBe(false);
    expect(malformed.every((value) => value === 0)).toBe(true);
  });
});
