import { canonicalEncode, fromBase64Url, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import {
  DERIVATION_LABELS,
  G,
  decodePoint,
  deriveScalar,
  encodePoint,
  encodeScalar,
  identityFromSecret,
  pedersenCommit,
  proveDleq,
  proveHiddenTransfer,
  scalePoint,
  sealWithEphemeralProof,
  signObject,
} from '@cp2p/crypto';
import { RESOURCES } from '@cp2p/engine';
import type { Resource, Result } from '@cp2p/engine';
import { describe, expect, test, vi } from 'vitest';
import {
  STEAL_EVIDENCE_PROTOCOL,
  STEAL_OPENING_BYTES,
  createStealContribution,
  createStealDispute,
  createStealReceipt,
  openStealContribution,
  stealOperationId,
  verifyStealContribution,
  verifyStealDispute,
  verifyStealReceipt,
} from './steal-delivery.js';
import type { FixedSteal, SignedStealContribution, StealOperation } from './steal-delivery.js';
import * as stealProofs from './steal-proof-cache.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function alias(encoded: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const final = alphabet.indexOf(encoded.at(-1) ?? '');
  if (final < 0 || (final & 3) !== 0) throw new Error('Expected canonical 32-byte encoding');
  return `${encoded.slice(0, -1)}${alphabet[final + 1]}`;
}

const COUNTS: Record<Resource, number> = {
  brick: 1,
  lumber: 2,
  wool: 1,
  grain: 1,
  ore: 1,
};
const BLINDING_SCALARS: Record<Resource, bigint> = {
  brick: 11n,
  lumber: 12n,
  wool: 13n,
  grain: 14n,
  ore: 15n,
};
const BLINDINGS: Record<Resource, string> = {
  brick: encodeScalar(BLINDING_SCALARS.brick),
  lumber: encodeScalar(BLINDING_SCALARS.lumber),
  wool: encodeScalar(BLINDING_SCALARS.wool),
  grain: encodeScalar(BLINDING_SCALARS.grain),
  ore: encodeScalar(BLINDING_SCALARS.ore),
};
const STEAL_SEED = new Uint8Array(32).fill(45);
const DISPUTE_SEED = new Uint8Array(32).fill(46);
const RECIPIENT_SECRET = 21n;

function makeFixture() {
  const thief = identityFromSecret(new Uint8Array(32).fill(1));
  const victim = identityFromSecret(new Uint8Array(32).fill(2));
  const commitments: Record<Resource, string> = {
    brick: '',
    lumber: '',
    wool: '',
    grain: '',
    ore: '',
  };
  for (const resource of RESOURCES)
    commitments[resource] = pedersenCommit(BigInt(COUNTS[resource]), BLINDING_SCALARS[resource]);
  const operation: StealOperation = {
    protocol: STEAL_EVIDENCE_PROTOCOL,
    genesisDigest: toBase64Url(new Uint8Array(32).fill(9)),
    epoch: 2,
    anchor: { seq: 12, hash: 'a'.repeat(64) },
    beaconOperationId: 'c'.repeat(64),
    thief: {
      seat: 0,
      publicKey: thief.peerId,
      encryptionKey: encodePoint(scalePoint(G, RECIPIENT_SECRET)),
    },
    victim: { seat: 1, publicKey: victim.peerId },
    handSize: 6,
    index: 3,
    commitments,
  };
  const contribution = value(
    createStealContribution(operation, COUNTS, BLINDINGS, STEAL_SEED, victim.secretKey),
  );
  const fixed: FixedSteal = {
    operation,
    contribution,
    entry: { seq: 13, hash: 'b'.repeat(64) },
  };
  return { thief, victim, operation, contribution, fixed };
}

let cached: ReturnType<typeof makeFixture> | null = null;
function fixture(): ReturnType<typeof makeFixture> {
  cached ??= makeFixture();
  return cached;
}

function maliciousContribution(data: ReturnType<typeof makeFixture>): SignedStealContribution {
  const { operation, contribution, victim } = data;
  const operationId = stealOperationId(operation);
  const transfer = contribution.body.transfer;
  const transferBlindings = RESOURCES.map((resource) =>
    deriveScalar(STEAL_SEED, DERIVATION_LABELS.transferBlind, { operationId, resource }),
  );
  // The public transfer selects wool (index 3). Encrypt a same-length false
  // claim of brick while retaining genuine transfer blindings and public points.
  const falseOpening = canonicalEncode({
    type: 0,
    blindings: transferBlindings.map(encodeScalar),
  });
  expect(falseOpening).toHaveLength(STEAL_OPENING_BYTES);
  const { sealed, ephemeralProof } = sealWithEphemeralProof(
    falseOpening,
    operation.thief.encryptionKey,
    STEAL_SEED,
    { protocol: 'steal-seal-v1', operationId, transfer },
    { protocol: 'steal-ephemeral-v1', operationId, transfer },
  );
  falseOpening.fill(0);
  const proof = proveHiddenTransfer(
    {
      commitments: RESOURCES.map((resource) => operation.commitments[resource]),
      transfer,
      handSize: operation.handSize,
      index: operation.index,
      payloadHash: toHex(hashValue(sealed)),
    },
    {
      counts: RESOURCES.map((resource) => COUNTS[resource]),
      blindings: RESOURCES.map((resource) => BLINDING_SCALARS[resource]),
      transferBlindings,
    },
    STEAL_SEED,
    { protocol: 'steal-transfer-v1', operationId },
  );
  const body = {
    operationId,
    seat: operation.victim.seat,
    transfer,
    sealed,
    ephemeralProof,
    proof,
  };
  return { body, sig: signObject('steal-contribution', body, victim.secretKey) };
}

describe('signed hidden-steal delivery', () => {
  test('opens a genuine signed transfer and binds the receipt to the fixed entry and body', () => {
    const data = fixture();
    const { operation, contribution, fixed, thief, victim } = data;
    expect(verifyStealContribution(contribution, operation)).toMatchObject({ ok: true });
    expect(value(openStealContribution(operation, contribution, RECIPIENT_SECRET))).toEqual({
      resource: 'wool',
      blindings: Object.fromEntries(
        RESOURCES.map((resource, index) => [
          resource,
          encodeScalar(
            deriveScalar(STEAL_SEED, DERIVATION_LABELS.transferBlind, {
              operationId: stealOperationId(operation),
              resource: RESOURCES[index],
            }),
          ),
        ]),
      ),
    });
    const receipt = value(createStealReceipt(fixed, RECIPIENT_SECRET, thief.secretKey));
    expect(value(verifyStealReceipt(receipt, fixed))).toEqual(receipt);
    expect(receipt.body).toMatchObject({
      operationId: stealOperationId(operation),
      fixed: fixed.entry,
      contributionHash: toHex(hashValue(contribution.body)),
      payloadHash: toHex(hashValue(contribution.body.sealed)),
      transferHash: toHex(hashValue(contribution.body.transfer)),
      seat: operation.thief.seat,
    });
    expect(
      verifyStealReceipt(receipt, {
        ...fixed,
        entry: { ...fixed.entry, hash: 'd'.repeat(64) },
      }),
    ).toMatchObject({ ok: false, error: { code: 'steal-receipt-binding' } });
    expect(createStealReceipt(fixed, RECIPIENT_SECRET, victim.secretKey).ok).toBe(false);
    expect(
      createStealDispute(fixed, RECIPIENT_SECRET, thief.secretKey, DISPUTE_SEED),
    ).toMatchObject({
      ok: false,
      error: { code: 'steal-good-delivery' },
    });
  });

  test('binds the owner signature and every frozen operation field', () => {
    const { operation, contribution, thief, victim } = fixture();
    const changes: StealOperation[] = [
      { ...operation, epoch: operation.epoch + 1 },
      { ...operation, anchor: { ...operation.anchor, hash: 'e'.repeat(64) } },
      { ...operation, beaconOperationId: 'f'.repeat(64) },
      {
        ...operation,
        thief: { ...operation.thief, encryptionKey: encodePoint(scalePoint(G, 22n)) },
      },
    ];
    for (const changed of changes) {
      expect(stealOperationId(changed)).not.toBe(stealOperationId(operation));
      expect(verifyStealContribution(contribution, changed).ok).toBe(false);
    }
    expect(
      createStealContribution(operation, COUNTS, BLINDINGS, STEAL_SEED, thief.secretKey).ok,
    ).toBe(false);
    expect(
      verifyStealContribution(
        {
          ...contribution,
          sig: signObject('steal-contribution', contribution.body, thief.secretKey),
        },
        operation,
      ),
    ).toMatchObject({ ok: false, error: { code: 'steal-contribution-signature' } });
    expect(openStealContribution(operation, contribution, 22n)).toMatchObject({
      ok: false,
      error: { code: 'steal-recipient-key' },
    });
    expect(victim.peerId).not.toBe(thief.peerId);
  });

  test('rejects a victim-resigned proof copied to a changed operation', () => {
    const { operation, contribution, victim } = fixture();
    const changed = { ...operation, epoch: operation.epoch + 1 };
    const operationId = stealOperationId(changed);
    const transferBlindings = RESOURCES.map((resource) =>
      deriveScalar(STEAL_SEED, DERIVATION_LABELS.transferBlind, {
        operationId: stealOperationId(operation),
        resource,
      }),
    );
    const plaintext = canonicalEncode({ type: 2, blindings: transferBlindings.map(encodeScalar) });
    const { sealed, ephemeralProof } = sealWithEphemeralProof(
      plaintext,
      changed.thief.encryptionKey,
      STEAL_SEED,
      { protocol: 'steal-seal-v1', operationId, transfer: contribution.body.transfer },
      { protocol: 'steal-ephemeral-v1', operationId, transfer: contribution.body.transfer },
    );
    plaintext.fill(0);
    const body = { ...contribution.body, operationId, sealed, ephemeralProof };
    expect(
      verifyStealContribution(
        { body, sig: signObject('steal-contribution', body, victim.secretKey) },
        changed,
      ),
    ).toMatchObject({ ok: false, error: { code: 'steal-transfer-proof' } });
  });

  test('rejects a complete sealed payload and ephemeral proof copied into another operation', () => {
    const { operation, contribution, victim } = fixture();
    const changed = { ...operation, epoch: operation.epoch + 1 };
    const body = { ...contribution.body, operationId: stealOperationId(changed) };
    const copied = { body, sig: signObject('steal-contribution', body, victim.secretKey) };
    expect(verifyStealContribution(copied, changed)).toMatchObject({
      ok: false,
      error: { code: 'steal-ephemeral-proof' },
    });
  });

  test('rejects changed sealed bytes even with a valid new ephemeral proof and the old transfer proof', () => {
    const { operation, contribution, victim } = fixture();
    const operationId = stealOperationId(operation);
    const plaintext = canonicalEncode({
      type: 0,
      blindings: RESOURCES.map(() => encodeScalar(0n)),
    });
    expect(plaintext).toHaveLength(STEAL_OPENING_BYTES);
    const { sealed, ephemeralProof } = sealWithEphemeralProof(
      plaintext,
      operation.thief.encryptionKey,
      new Uint8Array(32).fill(88),
      { protocol: 'steal-seal-v1', operationId, transfer: contribution.body.transfer },
      { protocol: 'steal-ephemeral-v1', operationId, transfer: contribution.body.transfer },
    );
    plaintext.fill(0);
    const body = { ...contribution.body, sealed, ephemeralProof };
    const altered = { body, sig: signObject('steal-contribution', body, victim.secretKey) };
    expect(verifyStealContribution(altered, operation)).toMatchObject({
      ok: false,
      error: { code: 'steal-transfer-proof' },
    });
  });

  test('rejects a copied earlier ephemeral even when the transfer proof binds forged ciphertext', () => {
    const { operation, contribution, fixed, thief, victim } = fixture();
    const operationId = stealOperationId(operation);
    const earlier = sealWithEphemeralProof(
      canonicalEncode({ type: 2, blindings: RESOURCES.map(() => encodeScalar(0n)) }),
      operation.thief.encryptionKey,
      new Uint8Array(32).fill(77),
      { protocol: 'earlier-sealed-delivery', operationId: 'e'.repeat(64) },
      {
        protocol: 'steal-ephemeral-v1',
        operationId: 'e'.repeat(64),
        transfer: contribution.body.transfer,
      },
    );
    const sealed = {
      ephemeral: earlier.sealed.ephemeral,
      ciphertext: toBase64Url(new Uint8Array(STEAL_OPENING_BYTES).fill(0)),
    };
    const transferBlindings = RESOURCES.map((resource) =>
      deriveScalar(STEAL_SEED, DERIVATION_LABELS.transferBlind, { operationId, resource }),
    );
    const proof = proveHiddenTransfer(
      {
        commitments: RESOURCES.map((resource) => operation.commitments[resource]),
        transfer: contribution.body.transfer,
        handSize: operation.handSize,
        index: operation.index,
        payloadHash: toHex(hashValue(sealed)),
      },
      {
        counts: RESOURCES.map((resource) => COUNTS[resource]),
        blindings: RESOURCES.map((resource) => BLINDING_SCALARS[resource]),
        transferBlindings,
      },
      STEAL_SEED,
      { protocol: 'steal-transfer-v1', operationId },
    );
    const body = { ...contribution.body, sealed, ephemeralProof: earlier.ephemeralProof, proof };
    const forged = { body, sig: signObject('steal-contribution', body, victim.secretKey) };
    expect(verifyStealContribution(forged, operation)).toMatchObject({
      ok: false,
      error: { code: 'steal-ephemeral-proof' },
    });
    const dispute = createStealDispute(
      { ...fixed, contribution: forged },
      RECIPIENT_SECRET,
      thief.secretKey,
      DISPUTE_SEED,
    );
    expect(dispute).toMatchObject({ ok: false, error: { code: 'steal-dispute-production' } });
    expect('value' in dispute).toBe(false);
  });

  test('rejects a correctly bound receipt signed by the wrong owner', () => {
    const { fixed, thief, victim } = fixture();
    const receipt = value(createStealReceipt(fixed, RECIPIENT_SECRET, thief.secretKey));
    expect(
      verifyStealReceipt(
        { ...receipt, sig: signObject('steal-receipt', receipt.body, victim.secretKey) },
        fixed,
      ),
    ).toMatchObject({ ok: false, error: { code: 'steal-receipt-signature' } });
  });

  test('uses the same sealed ciphertext length for every resource index', () => {
    const { operation, victim } = fixture();
    let prefix = 0;
    const lengths = RESOURCES.map((resource) => {
      const selected = { ...operation, index: prefix };
      prefix += COUNTS[resource];
      const contribution = value(
        createStealContribution(selected, COUNTS, BLINDINGS, STEAL_SEED, victim.secretKey),
      );
      expect(value(openStealContribution(selected, contribution, RECIPIENT_SECRET)).resource).toBe(
        resource,
      );
      return fromBase64Url(contribution.body.sealed.ciphertext).length;
    });
    expect(new Set(lengths).size).toBe(1);
    expect(lengths[0]).toBe(STEAL_OPENING_BYTES);
  });

  test('refuses an authenticated bad opening and accepts only its genuine recipient dispute', () => {
    const data = fixture();
    const bad = maliciousContribution(data);
    const fixed: FixedSteal = { ...data.fixed, contribution: bad };
    expect(verifyStealContribution(bad, data.operation)).toMatchObject({ ok: true });
    const genuineReceipt = value(
      createStealReceipt(data.fixed, RECIPIENT_SECRET, data.thief.secretKey),
    );
    expect(verifyStealReceipt(genuineReceipt, fixed)).toMatchObject({
      ok: false,
      error: { code: 'steal-receipt-binding' },
    });
    expect(openStealContribution(data.operation, bad, RECIPIENT_SECRET)).toMatchObject({
      ok: false,
      error: { code: 'steal-opening-mismatch' },
    });
    expect(createStealReceipt(fixed, RECIPIENT_SECRET, data.thief.secretKey)).toMatchObject({
      ok: false,
      error: { code: 'steal-opening-mismatch' },
    });
    const dispute = value(
      createStealDispute(fixed, RECIPIENT_SECRET, data.thief.secretKey, DISPUTE_SEED),
    );
    expect(value(verifyStealDispute(dispute, fixed))).toEqual(dispute);
    expect(
      verifyStealDispute(dispute, {
        ...fixed,
        entry: { ...fixed.entry, hash: 'd'.repeat(64) },
      }),
    ).toMatchObject({ ok: false, error: { code: 'steal-dispute-binding' } });
    const alternativeSecret = RECIPIENT_SECRET + 1n;
    const alternativeShared = encodePoint(
      scalePoint(decodePoint(bad.body.sealed.ephemeral), alternativeSecret),
    );
    const alternativeProof = proveDleq(
      {
        base1: encodePoint(G),
        point1: encodePoint(scalePoint(G, alternativeSecret)),
        base2: bad.body.sealed.ephemeral,
        point2: alternativeShared,
      },
      alternativeSecret,
      DISPUTE_SEED,
      { protocol: 'steal-dispute-v1', binding: dispute.body.binding },
    );
    const alternativeBody = {
      binding: dispute.body.binding,
      sharedPoint: alternativeShared,
      proof: alternativeProof,
    };
    expect(
      verifyStealDispute(
        {
          body: alternativeBody,
          sig: signObject('steal-dispute', alternativeBody, data.thief.secretKey),
        },
        fixed,
      ),
    ).toMatchObject({ ok: false, error: { code: 'steal-dispute-proof' } });
    const wrongDleqBody = {
      ...dispute.body,
      proof: { ...dispute.body.proof, response: encodeScalar(0n) },
    };
    expect(
      verifyStealDispute(
        {
          body: wrongDleqBody,
          sig: signObject('steal-dispute', wrongDleqBody, data.thief.secretKey),
        },
        fixed,
      ),
    ).toMatchObject({ ok: false, error: { code: 'steal-dispute-proof' } });
    expect(
      verifyStealDispute(
        { ...dispute, sig: signObject('steal-dispute', dispute.body, data.victim.secretKey) },
        fixed,
      ),
    ).toMatchObject({ ok: false, error: { code: 'steal-dispute-signature' } });
    const honestBinding = value(
      createStealReceipt(data.fixed, RECIPIENT_SECRET, data.thief.secretKey),
    ).body;
    const honestShared = encodePoint(
      scalePoint(decodePoint(data.contribution.body.sealed.ephemeral), RECIPIENT_SECRET),
    );
    const honestProof = proveDleq(
      {
        base1: encodePoint(G),
        point1: data.operation.thief.encryptionKey,
        base2: data.contribution.body.sealed.ephemeral,
        point2: honestShared,
      },
      RECIPIENT_SECRET,
      DISPUTE_SEED,
      { protocol: 'steal-dispute-v1', binding: honestBinding },
    );
    const honestBody = { binding: honestBinding, sharedPoint: honestShared, proof: honestProof };
    expect(
      verifyStealDispute(
        { body: honestBody, sig: signObject('steal-dispute', honestBody, data.thief.secretKey) },
        data.fixed,
      ),
    ).toMatchObject({ ok: false, error: { code: 'steal-good-delivery' } });
  });

  test('rejects noncanonical base64url point aliases', () => {
    const { operation, contribution } = fixture();
    expect(() => fromBase64Url(alias(operation.thief.encryptionKey))).toThrow(
      'canonical base64url',
    );
    expect(() => fromBase64Url(alias(encodeScalar(BLINDING_SCALARS.brick)))).toThrow(
      'canonical base64url',
    );
    expect(
      verifyStealContribution(contribution, {
        ...operation,
        thief: { ...operation.thief, encryptionKey: alias(operation.thief.encryptionKey) },
      }).ok,
    ).toBe(false);
    expect(
      verifyStealContribution(contribution, {
        ...operation,
        commitments: { ...operation.commitments, brick: alias(operation.commitments.brick) },
      }).ok,
    ).toBe(false);
    expect(
      verifyStealContribution(
        {
          ...contribution,
          body: {
            ...contribution.body,
            sealed: {
              ...contribution.body.sealed,
              ephemeral: alias(contribution.body.sealed.ephemeral),
            },
          },
        },
        operation,
      ).ok,
    ).toBe(false);
  });

  test('rejects malformed, mismatched and unsigned acknowledgements before public proof verification', () => {
    const { fixed, thief, victim } = fixture();
    const receipt = value(createStealReceipt(fixed, RECIPIENT_SECRET, thief.secretKey));
    const bad = maliciousContribution(fixture());
    const badFixed = { ...fixed, contribution: bad };
    const dispute = value(
      createStealDispute(badFixed, RECIPIENT_SECRET, thief.secretKey, DISPUTE_SEED),
    );
    const verify = vi.spyOn(stealProofs, 'verifyStealTransfer');
    try {
      expect(verifyStealReceipt({ nonsense: true }, fixed).ok).toBe(false);
      expect(
        verifyStealReceipt(receipt, { ...fixed, entry: { ...fixed.entry, hash: 'e'.repeat(64) } }),
      ).toMatchObject({ ok: false, error: { code: 'steal-receipt-binding' } });
      expect(
        verifyStealReceipt(
          { ...receipt, sig: signObject('steal-receipt', receipt.body, victim.secretKey) },
          fixed,
        ),
      ).toMatchObject({ ok: false, error: { code: 'steal-receipt-signature' } });
      expect(verifyStealDispute({ nonsense: true }, badFixed).ok).toBe(false);
      expect(
        verifyStealDispute(dispute, {
          ...badFixed,
          entry: { ...badFixed.entry, hash: 'e'.repeat(64) },
        }),
      ).toMatchObject({ ok: false, error: { code: 'steal-dispute-binding' } });
      expect(
        verifyStealDispute(
          { ...dispute, sig: signObject('steal-dispute', dispute.body, victim.secretKey) },
          badFixed,
        ),
      ).toMatchObject({ ok: false, error: { code: 'steal-dispute-signature' } });
      expect(verify).not.toHaveBeenCalled();
      expect(verifyStealReceipt(receipt, fixed).ok).toBe(true);
      expect(verifyStealDispute(dispute, badFixed).ok).toBe(true);
      expect(verify).toHaveBeenCalledTimes(2);
    } finally {
      verify.mockRestore();
    }
  });
});
