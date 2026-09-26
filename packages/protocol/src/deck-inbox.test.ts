import { toBase64Url } from '@cp2p/codec';
import {
  G,
  encodePoint,
  identityFromSecret,
  scalarToBytes,
  scalePoint,
  signObject,
} from '@cp2p/crypto';
import type { Result } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { deckDrawOperationId, signDeckUnlock } from './deck-draw.js';
import type { DeckDrawOperation, SignedDeckUnlock } from './deck-draw.js';
import { DeckInbox } from './deck-inbox.js';
import type { DeckUnlockContribution } from './deck-inbox.js';
import { DECK_DRAW_PROTOCOL } from './deck-ledger.js';
import { protocolFixture } from './testing/fixtures.js';
import type { CryptoContext } from './crypto-context.js';
import { emptyHandCommitments } from './hand-commitments.js';
import type { LogContext } from './log.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

const keys = [1, 2, 3].map((n) => new Uint8Array(32).fill(n));
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Missing item ${index}`);
  return item;
}

/** Unit fixture: a valid public operation, standing in for replayed certified metadata. */
function fixture(count: 2 | 3 = 3) {
  const seats = [0, 1, 2] as const;
  const participants = keys.slice(0, count).map((key, index) => ({
    seat: at(seats, index),
    publicKey: identityFromSecret(key).peerId,
    lockKey: encodePoint(scalePoint(G, at([7n, 3n, 5n], index))),
  }));
  const operation: DeckDrawOperation = {
    genesisDigest: toBase64Url(new Uint8Array(32).fill(12)),
    epoch: 0,
    anchor: { seq: 11, hash: 'a'.repeat(64) },
    position: 0,
    seat: 0,
    slotId: 'dev:0',
    setupHash: 'c'.repeat(64),
    deckId: 'dev',
    deckEpoch: 0,
    initialPoint: encodePoint(scalePoint(G, count === 3 ? 30n : 6n)),
    participants,
  };
  const first = signDeckUnlock(operation, [], 3n, scalarToBytes(11n), at(keys, 1));
  const unlocks =
    count === 3
      ? [first, signDeckUnlock(operation, [first], 5n, scalarToBytes(13n), at(keys, 2))]
      : [first];
  const protocol = protocolFixture();
  const cryptoFor = (active: DeckDrawOperation | null): CryptoContext => ({
    epoch: 0,
    beacon: {
      genesisDigest: operation.genesisDigest,
      chains: [],
      round: 0,
      active: null,
      fixed: null,
    },
    decks: { genesisDigest: operation.genesisDigest, decks: [], active },
    hands: value(emptyHandCommitments(protocol.genesis.config.seats)),
  });
  const context = (active: DeckDrawOperation | null): LogContext => ({
    genesis: protocol.genesis,
    engine: protocol.engine,
    head: protocol.entry,
    state: protocol.state,
    lastNonces: new Map(),
    crypto: cryptoFor(active),
  });
  const contribution = (prefix: readonly SignedDeckUnlock[]): DeckUnlockContribution => ({
    kind: 'deck-unlock',
    operationId: deckDrawOperationId(operation),
    unlocks: [...prefix],
  });
  return { operation, unlocks, context, cryptoFor, contribution };
}

describe('deck draw unlock inbox', () => {
  test('longer valid prefix can arrive first and produces only a completed local deal', () => {
    const { operation, unlocks, context, cryptoFor, contribution } = fixture();
    const inbox = new DeckInbox();
    expect(value(inbox.refresh(cryptoFor(operation)))).toBeUndefined();
    expect(value(inbox.candidate(context(operation)))).toBeNull();
    expect(value(inbox.remember(contribution(unlocks)))).toBe(true);
    expect(value(inbox.remember(contribution(unlocks.slice(0, 1))))).toBe(false);
    expect(value(inbox.remember(contribution(unlocks)))).toBe(false);
    expect(value(inbox.candidate(context(operation)))).toEqual({
      kind: 'system',
      input: { kind: 'system', type: 'CARD_DEALT', deck: 'dev', seat: 0, slotId: 'dev:0' },
      evidence: { kind: 'proof', protocol: DECK_DRAW_PROTOCOL, data: unlocks },
    });
  });

  test('incomplete prefix stays noncandidate and rejects a re-signed invalid proof', () => {
    const { operation, unlocks, context, cryptoFor, contribution } = fixture();
    const inbox = new DeckInbox();
    value(inbox.refresh(cryptoFor(operation)));
    expect(value(inbox.remember(contribution(unlocks.slice(0, 1))))).toBe(true);
    expect(value(inbox.candidate(context(operation)))).toBeNull();
    const second = unlocks[1];
    if (!second) throw new Error('Missing second unlock');
    const body = {
      ...second.body,
      proof: { ...second.body.proof, response: toBase64Url(scalarToBytes(17n)) },
    };
    const forged = { body, sig: signObject('deck-unlock', body, at(keys, 2)) };
    expect(inbox.remember(contribution([at(unlocks, 0), forged])).ok).toBe(false);
    expect(inbox.prefix()).toEqual(unlocks.slice(0, 1));
    expect(value(inbox.candidate(context(operation)))).toBeNull();
  });

  test('retains detached verified data and clears on operation refresh or no draw', () => {
    const { operation, unlocks, cryptoFor, contribution } = fixture(2);
    const inbox = new DeckInbox();
    value(inbox.refresh(cryptoFor(operation)));
    const delivered = contribution(unlocks);
    const originalPoint = at(unlocks, 0).body.point;
    const originalResponse = at(unlocks, 0).body.proof.response;
    expect(value(inbox.remember(delivered))).toBe(true);
    at(delivered.unlocks, 0).body.point = encodePoint(G);
    expect(inbox.prefix()[0]?.body.point).toBe(originalPoint);
    const exposed = inbox.prefix();
    const exposedFirst = at(exposed, 0);
    exposedFirst.body.proof = {
      ...exposedFirst.body.proof,
      response: toBase64Url(scalarToBytes(17n)),
    };
    expect(inbox.prefix()[0]?.body.proof.response).toBe(originalResponse);
    const later = { ...operation, slotId: 'dev:1' };
    value(inbox.refresh(cryptoFor(later)));
    expect(inbox.operationId()).toBe(deckDrawOperationId(later));
    expect(inbox.prefix()).toEqual([]);
    expect(value(inbox.remember(contribution(unlocks)))).toBe(false);
    value(inbox.refresh(cryptoFor(null)));
    expect(inbox.operationId()).toBeNull();
  });

  test('rejects malformed contribution and will not retain an unverified higher prefix', () => {
    const { operation, unlocks, cryptoFor, contribution } = fixture();
    const inbox = new DeckInbox();
    value(inbox.refresh(cryptoFor(operation)));
    const first = contribution(unlocks.slice(0, 1));
    const extra = { ...first, extra: true };
    expect(inbox.remember(extra).ok).toBe(false);
    expect(inbox.remember({ ...first, unlocks: [] }).ok).toBe(false);
    expect(value(inbox.remember(first))).toBe(true);
    const forged = [...unlocks];
    forged[1] = { ...at(forged, 1), sig: 'A'.repeat(86) };
    expect(inbox.remember(contribution(forged)).ok).toBe(false);
    expect(inbox.prefix()).toEqual(unlocks.slice(0, 1));
  });
});
