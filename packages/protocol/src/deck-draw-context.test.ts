import { toBase64Url } from '@cp2p/codec';
import { G, decodePoint, encodePoint, identityFromSecret, scalePoint } from '@cp2p/crypto';
import type { Result } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import {
  completeDeckDraw,
  freezeDeckDraw,
  proveDeckReveal,
  verifyDeckReveal,
} from './deck-draw.js';
import type { DeckDrawRequest } from './deck-draw.js';
import { initDeckSetup, validateDeckSetupState } from './deck-setup.js';

const genesisDigest = toBase64Url(new Uint8Array(32).fill(8));
const creationHash = 'a'.repeat(64);
const signingKey = new Uint8Array(32).fill(1);

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function fixture() {
  const definition = {
    ceremonyId: toBase64Url(new Uint8Array(32).fill(9)),
    deckId: 'single-card',
    deckEpoch: 0,
    creation: {
      kind: 'certified' as const,
      genesisDigest,
      epoch: 2,
      anchor: { seq: 10, hash: creationHash },
    },
    cards: [{ identity: 'knight#1', card: 'knight' }],
    participants: [{ seat: 0 as const, publicKey: identityFromSecret(signingKey).peerId }],
  };
  const initial = value(initDeckSetup(definition));
  const initialPoint = initial.points[0];
  if (!initialPoint) throw new Error('Missing canonical card point');
  const lockKey = encodePoint(scalePoint(G, 2n));
  // A trusted synthetic fold: one shuffle scales P by 2, then b/a = 1 leaves it unchanged.
  // This isolates parent binding without rerunning the expensive signed shuffle proof.
  const setup = value(
    validateDeckSetupState({
      ...initial,
      points: [encodePoint(scalePoint(decodePoint(initialPoint), 2n))],
      shuffleKeys: [lockKey],
      lockKeys: [[lockKey]],
    }),
  );
  const request: DeckDrawRequest = {
    genesisDigest,
    epoch: 2,
    anchor: { seq: 10, hash: creationHash },
    position: 0,
    seat: 0,
    slotId: 'dev:0',
  };
  return { setup, request };
}

describe('deck draw certified-parent binding', () => {
  test('cannot draw before deck creation or from a different same-sequence parent', () => {
    const { setup, request } = fixture();
    expect(freezeDeckDraw(setup, request).ok).toBe(true);
    expect(freezeDeckDraw(setup, { ...request, epoch: 1 }).ok).toBe(false);
    expect(
      freezeDeckDraw(setup, {
        ...request,
        anchor: { seq: 9, hash: 'b'.repeat(64) },
      }).ok,
    ).toBe(false);
    expect(
      freezeDeckDraw(setup, {
        ...request,
        anchor: { seq: 10, hash: 'b'.repeat(64) },
      }).ok,
    ).toBe(false);
    expect(
      freezeDeckDraw(setup, {
        ...request,
        anchor: { seq: 11, hash: 'b'.repeat(64) },
      }).ok,
    ).toBe(true);
  });

  test('a public reveal must follow its draw request', () => {
    const { setup, request } = fixture();
    const operation = value(freezeDeckDraw(setup, request));
    const receipt = value(completeDeckDraw(operation, []));
    const context = {
      genesisDigest,
      epoch: 2,
      anchor: { seq: 11, hash: 'b'.repeat(64) },
      seat: 0 as const,
      nonce: 1,
      command: { type: 'PLAY_DEV_CARD', slotId: request.slotId },
    };
    const proof = proveDeckReveal(
      setup,
      receipt,
      'knight#1',
      2n,
      new Uint8Array(32).fill(5),
      context,
    );
    expect(verifyDeckReveal(setup, receipt, proof, context).ok).toBe(true);
    expect(verifyDeckReveal(setup, receipt, proof, { ...context, anchor: request.anchor }).ok).toBe(
      false,
    );
    expect(
      verifyDeckReveal(setup, receipt, proof, {
        ...context,
        anchor: { seq: 10, hash: 'b'.repeat(64) },
      }).ok,
    ).toBe(false);
  });
});
