import { canonicalEncode, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import {
  DERIVATION_LABELS,
  G,
  deriveScalar,
  encodePoint,
  encodeScalar,
  identityFromSecret,
  pedersenCommit,
  proveHiddenTransfer,
  scalePoint,
  sealWithEphemeralProof,
  signObject,
} from '@cp2p/crypto';
import { RESOURCES } from '@cp2p/engine';
import type { Resource } from '@cp2p/engine';
import { describe, expect, test, vi } from 'vitest';
import * as delivery from './steal-delivery.js';
import {
  STEAL_EVIDENCE_PROTOCOL,
  STEAL_OPENING_BYTES,
  createStealContribution,
  createStealDispute,
  createStealReceipt,
  stealOperationId,
} from './steal-delivery.js';
import type {
  FixedSteal,
  SignedStealContribution,
  SignedStealDispute,
  StealOperation,
} from './steal-delivery.js';
import { StealInbox } from './steal-inbox.js';
import type { StealState } from './steal-state.js';
import type { CryptoContext } from './crypto-context.js';
import { decodeProtocolMessage, encodeProtocolMessage } from './messages.js';
import { protocolFixture } from './testing/fixtures.js';

const COUNTS: Record<Resource, number> = { brick: 1, lumber: 2, wool: 1, grain: 1, ore: 1 };
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
    brick: pedersenCommit(BigInt(COUNTS.brick), BLINDING_SCALARS.brick),
    lumber: pedersenCommit(BigInt(COUNTS.lumber), BLINDING_SCALARS.lumber),
    wool: pedersenCommit(BigInt(COUNTS.wool), BLINDING_SCALARS.wool),
    grain: pedersenCommit(BigInt(COUNTS.grain), BLINDING_SCALARS.grain),
    ore: pedersenCommit(BigInt(COUNTS.ore), BLINDING_SCALARS.ore),
  };
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
  const protocol = protocolFixture();
  return { thief, victim, operation, contribution, fixed, protocol };
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
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

// The inbox reads only the replayed steal substate in these tests.
function cryptoContext(steal: StealState | null): CryptoContext {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- use the inbox's consumed CryptoContext projection.
  return { steal } as CryptoContext;
}

function state(
  operation: StealOperation,
  fixed: FixedSteal | null = null,
  dispute: SignedStealDispute | null = null,
): StealState {
  return { operation, fixed, dispute };
}

describe('hidden-steal inbox', () => {
  test('orders victim contribution, fixed transfer, and receipt completion', () => {
    const { operation, contribution, fixed, thief } = fixture();
    const inbox = new StealInbox();
    expect(inbox.candidate(cryptoContext(state(operation)))).toEqual({ ok: true, value: null });
    expect(inbox.rememberContribution(contribution)).toEqual({ ok: true, value: true });
    expect(inbox.candidate(cryptoContext(state(operation)))).toEqual({
      ok: true,
      value: { kind: 'crypto', action: 'steal-fixed', evidence: contribution },
    });
    expect(inbox.stageId()).toBe(`${stealOperationId(operation)}/contribution`);

    const receipt = value(createStealReceipt(fixed, RECIPIENT_SECRET, thief.secretKey));
    expect(inbox.candidate(cryptoContext(state(operation, fixed)))).toEqual({
      ok: true,
      value: null,
    });
    expect(inbox.rememberResponse({ kind: 'receipt', value: receipt })).toEqual({
      ok: true,
      value: true,
    });
    expect(inbox.candidate(cryptoContext(state(operation, fixed)))).toEqual({
      ok: true,
      value: {
        kind: 'system',
        input: {
          kind: 'system',
          type: 'STEAL_RESULT',
          thief: operation.thief.seat,
          victim: operation.victim.seat,
          resource: 'hidden',
        },
        evidence: { kind: 'proof', protocol: STEAL_EVIDENCE_PROTOCOL, data: receipt },
      },
    });
    expect(inbox.stageId()).toBe(`${stealOperationId(operation)}/${fixed.entry.hash}`);
  });

  test('ignores stale operation and fixed-entry replies before proof verification', () => {
    const { operation, contribution, fixed, thief } = fixture();
    const inbox = new StealInbox();
    expect(inbox.refresh(cryptoContext(state(operation))).ok).toBe(true);
    const verifyContribution = vi.spyOn(delivery, 'verifyStealContribution');
    expect(
      inbox.rememberContribution({
        ...contribution,
        body: { ...contribution.body, operationId: 'd'.repeat(64), proof: null },
      }),
    ).toEqual({ ok: true, value: false });
    expect(verifyContribution).not.toHaveBeenCalled();

    expect(inbox.refresh(cryptoContext(state(operation, fixed))).ok).toBe(true);
    const receipt = value(createStealReceipt(fixed, RECIPIENT_SECRET, thief.secretKey));
    const changed = {
      ...receipt,
      body: { ...receipt.body, fixed: { ...receipt.body.fixed, hash: 'e'.repeat(64) } },
    };
    const verifyReceipt = vi.spyOn(delivery, 'verifyStealReceipt');
    expect(inbox.rememberResponse({ kind: 'receipt', value: changed })).toEqual({
      ok: true,
      value: false,
    });
    expect(verifyReceipt).not.toHaveBeenCalled();
  });

  test('does not reverify duplicate valid contributions or responses', () => {
    const { operation, contribution, fixed, thief } = fixture();
    const inbox = new StealInbox();
    inbox.refresh(cryptoContext(state(operation)));
    const verifyContribution = vi.spyOn(delivery, 'verifyStealContribution');
    expect(inbox.rememberContribution(contribution)).toEqual({ ok: true, value: true });
    expect(inbox.rememberContribution(contribution)).toEqual({ ok: true, value: false });
    expect(verifyContribution).toHaveBeenCalledOnce();

    inbox.refresh(cryptoContext(state(operation, fixed)));
    const receipt = value(createStealReceipt(fixed, RECIPIENT_SECRET, thief.secretKey));
    const verifyReceipt = vi.spyOn(delivery, 'verifyStealReceipt');
    expect(inbox.rememberResponse({ kind: 'receipt', value: receipt })).toEqual({
      ok: true,
      value: true,
    });
    expect(inbox.rememberResponse({ kind: 'receipt', value: receipt })).toEqual({
      ok: true,
      value: false,
    });
    expect(verifyReceipt).toHaveBeenCalledOnce();
  });

  test('valid disputes take priority and completed or disputed operations suppress candidates', () => {
    const data = fixture();
    const malicious = maliciousContribution(data);
    const fixed: FixedSteal = { ...data.fixed, contribution: malicious };
    const dispute = value(
      createStealDispute(fixed, RECIPIENT_SECRET, data.thief.secretKey, DISPUTE_SEED),
    );
    const inbox = new StealInbox();
    inbox.refresh(cryptoContext(state(data.operation, fixed)));
    expect(inbox.rememberResponse({ kind: 'dispute', value: dispute })).toEqual({
      ok: true,
      value: true,
    });
    expect(inbox.candidate(cryptoContext(state(data.operation, fixed)))).toEqual({
      ok: true,
      value: { kind: 'crypto', action: 'steal-dispute', evidence: dispute },
    });
    expect(inbox.candidate(cryptoContext(state(data.operation, fixed, dispute)))).toEqual({
      ok: true,
      value: null,
    });
    expect(inbox.stageId()).toBeNull();

    const completed = new StealInbox();
    completed.refresh(cryptoContext(state(data.operation, data.fixed)));
    completed.rememberResponse({
      kind: 'receipt',
      value: value(createStealReceipt(data.fixed, RECIPIENT_SECRET, data.thief.secretKey)),
    });
    expect(completed.candidate(cryptoContext(null))).toEqual({
      ok: true,
      value: null,
    });
    expect(completed.operationId()).toBeNull();
  });

  test('round-trips both steal message variants and rejects extra keys', () => {
    const { operation, contribution, fixed, thief } = fixture();
    const receipt = value(createStealReceipt(fixed, RECIPIENT_SECRET, thief.secretKey));
    const messages = [
      { t: 'STEAL_CONTRIB', genesisDigest: operation.genesisDigest, contribution },
      {
        t: 'STEAL_RESPONSE',
        genesisDigest: operation.genesisDigest,
        response: { kind: 'receipt', value: receipt },
      },
    ];
    for (const message of messages) {
      const encoded = encodeProtocolMessage(message);
      expect(encoded.ok).toBe(true);
      if (!encoded.ok) continue;
      expect(decodeProtocolMessage(encoded.value)).toEqual({ ok: true, value: message });
      expect(encodeProtocolMessage({ ...message, extra: true }).ok).toBe(false);
    }
  });
});
