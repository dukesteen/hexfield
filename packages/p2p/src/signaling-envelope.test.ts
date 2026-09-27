import { identityFromSecret } from '@cp2p/crypto';
import { describe, expect, test } from 'vitest';
import { signSignalEnvelope, validAttemptId, verifySignalEnvelope } from './signaling-envelope.js';
import type { SignalEnvelopeBody } from './signaling-envelope.js';

function fixture() {
  const sender = identityFromSecret(new Uint8Array(32).fill(1));
  const receiver = identityFromSecret(new Uint8Array(32).fill(2));
  const body: SignalEnvelopeBody = {
    version: 1,
    scope: 'lobby-A',
    from: sender.peerId,
    to: receiver.peerId,
    attemptId: 'AQEBAQEBAQEBAQEBAQEBAQ',
    sessionId: 'AwMDAwMDAwMDAwMDAwMDAw',
    attemptSeq: 1,
    blob: {
      kind: 'description',
      generation: 1,
      revision: 1,
      description: { type: 'offer', sdp: 'v=0\r\n' },
    },
  };
  return { sender, receiver, body };
}

describe('signed per-attempt signaling', () => {
  test('authenticates exact scope, route, attempt and body', () => {
    const { sender, receiver, body } = fixture();
    const signed = signSignalEnvelope(body, sender.secretKey);
    const expected = new Set([sender.peerId]);
    expect(verifySignalEnvelope(signed, 'lobby-A', receiver.peerId, expected)).toEqual(signed);
    expect(verifySignalEnvelope(signed, 'lobby-B', receiver.peerId, expected)).toBeNull();
    expect(verifySignalEnvelope(signed, 'lobby-A', sender.peerId, expected)).toBeNull();
    expect(verifySignalEnvelope(signed, 'lobby-A', receiver.peerId, new Set())).toBeNull();
    expect(
      verifySignalEnvelope(
        { ...signed, body: { ...body, attemptId: 'AgICAgICAgICAgICAgICAg' } },
        'lobby-A',
        receiver.peerId,
        expected,
      ),
    ).toBeNull();
    expect(
      verifySignalEnvelope(
        {
          ...signed,
          body: {
            ...body,
            blob: {
              ...body.blob,
              revision: 2,
            },
          },
        },
        'lobby-A',
        receiver.peerId,
        expected,
      ),
    ).toBeNull();
  });

  test('bounds canonical IDs and malformed peer-controlled bodies before verification', () => {
    const { sender, receiver, body } = fixture();
    expect(validAttemptId(body.attemptId)).toBe(true);
    expect(validAttemptId('AAAA')).toBe(false);
    const expected = new Set([sender.peerId]);
    const signed = signSignalEnvelope(body, sender.secretKey);
    expect(
      verifySignalEnvelope({ ...signed, extra: true }, 'lobby-A', receiver.peerId, expected),
    ).toBeNull();
    expect(
      verifySignalEnvelope(
        { ...signed, body: { ...body, extra: true } },
        'lobby-A',
        receiver.peerId,
        expected,
      ),
    ).toBeNull();
    expect(
      verifySignalEnvelope(
        {
          ...signed,
          body: {
            ...body,
            blob: {
              kind: 'description',
              generation: 1,
              revision: 1,
              description: { type: 'offer', sdp: 'x'.repeat(70_000) },
            },
          },
        },
        'lobby-A',
        receiver.peerId,
        expected,
      ),
    ).toBeNull();
  });

  test('verified signaling detaches adapter-owned mutable objects', () => {
    const { sender, receiver, body } = fixture();
    const signed = signSignalEnvelope(body, sender.secretKey);
    const verified = verifySignalEnvelope(
      signed,
      body.scope,
      receiver.peerId,
      new Set([sender.peerId]),
    );
    expect(verified).not.toBeNull();
    if (signed.body.blob.kind !== 'description' || verified?.body.blob.kind !== 'description')
      throw new Error('Missing description fixture');
    Reflect.set(signed.body.blob.description, 'sdp', 'tampered after verification');
    expect(verified.body.blob.description.sdp).toBe('v=0\r\n');
  });
});
