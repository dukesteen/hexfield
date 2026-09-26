import { toBase64Url } from '@cp2p/codec';
import { encodeScalar, pedersenCommit } from '@cp2p/crypto';
import { RESOURCES, createResourceBounds, zeroCounts } from '@cp2p/engine';
import type { GameState, Input, Result, Seat } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import type { CryptoContext } from './crypto-context.js';
import { entryHash, genesisDigest } from './genesis.js';
import { emptyHandCommitments } from './hand-commitments.js';
import { proveHandObligation } from './hand-transition.js';
import type { LogContext } from './log.js';
import { protocolFixture } from './testing/fixtures.js';
import {
  authorizeTradeProof,
  planTradeProof,
  signTradeProofRequest,
  signTradeProofResponse,
  tradeProofHost,
  tradeProofRequestId,
  verifyTradeProofRequest,
  verifyTradeProofResponse,
} from './trade-proof-delivery.js';
import type { TradeProofBody } from './trade-proof-delivery.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function scenario(proposer: Seat) {
  const fixture = protocolFixture();
  const genesis = { ...fixture.genesis, security: 'verified' as const };
  const zero = zeroCounts(RESOURCES);
  const brickOrWool = value(createResourceBounds(1, zero, { ...zero, brick: 1, wool: 1 }));
  const oreOrGrain = value(createResourceBounds(1, zero, { ...zero, ore: 1, grain: 1 }));
  const state: GameState = {
    ...fixture.state,
    turn: {
      ...fixture.state.turn,
      number: 3,
      activeSeat: 0,
      phase: [{ module: 'base', id: 'main', data: null }],
    },
    seats: fixture.state.seats.map((seat) => ({
      ...seat,
      resources: seat.seat === 0 ? brickOrWool : seat.seat === 1 ? oreOrGrain : seat.resources,
    })),
  };
  const offer: Input =
    proposer === 0
      ? {
          kind: 'command',
          seat: 0,
          command: {
            type: 'OFFER_TRADE',
            give: { brick: 1 },
            want: { ore: 1 },
            to: [1],
          },
        }
      : {
          kind: 'command',
          seat: 1,
          command: {
            type: 'PROPOSE_TRADE',
            give: { ore: 1 },
            want: { brick: 1 },
          },
        };
  const offered = value(fixture.engine.apply(state, offer)).state;
  const ready =
    proposer === 0
      ? value(
          fixture.engine.apply(offered, {
            kind: 'command',
            seat: 1,
            command: { type: 'RESPOND_TRADE', offerId: 0, accept: true },
          }),
        ).state
      : offered;
  const hands = value(emptyHandCommitments(genesis.config.seats)).map((row) => ({
    ...row,
    commitments: {
      ...row.commitments,
      brick: row.seat === 0 ? pedersenCommit(1n, 7n) : row.commitments.brick,
      ore: row.seat === 1 ? pedersenCommit(1n, 11n) : row.commitments.ore,
    },
  }));
  // The synthetic state isolates a legal accepted trade and genuine commitments.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the hand ledger is read by this planning path.
  const crypto = { epoch: 0, hands, decks: { decks: [] } } as unknown as CryptoContext;
  const context: LogContext = {
    genesis,
    engine: fixture.engine,
    head: fixture.entry,
    state: ready,
    lastNonces: new Map(),
    crypto,
  };
  const body: TradeProofBody = {
    gameId: genesis.gameId,
    genesisDigest: genesisDigest(genesis),
    seat: 0,
    nonce: 1,
    headSeq: context.head.seq,
    headHash: entryHash(context.head),
    command: { type: 'CONFIRM_TRADE', offerId: 0, withSeat: 1 },
  };
  const finalizer = fixture.identities[0];
  const owner = fixture.identities[1];
  if (!finalizer || !owner) throw new Error('Missing trade identities');
  const request = signTradeProofRequest(body, finalizer.secretKey);
  const planned = value(authorizeTradeProof(body, 1, context));
  const counts = { ...zero, ore: 1 };
  const blindings = {
    brick: encodeScalar(0n),
    lumber: encodeScalar(0n),
    wool: encodeScalar(0n),
    grain: encodeScalar(0n),
    ore: encodeScalar(11n),
  };
  const proofs = planned.indices.map((index) => ({
    index,
    proof: value(
      proveHandObligation(
        planned.plan,
        index,
        counts,
        blindings,
        new Uint8Array(32).fill(9),
        planned.binding,
      ),
    ),
  }));
  const response = signTradeProofResponse(request, 1, proofs, owner.secretKey);
  return { fixture, context, body, request, response, planned, finalizer, owner };
}

describe('authenticated trade proof delivery', () => {
  test('signed undecodable proof points are rejected without throwing', () => {
    const { context, request, response, owner } = scenario(0);
    const first = response.body.proofs[0];
    if (!first || first.proof.kind !== 'range') throw new Error('Missing range proof fixture');
    const malformed = {
      ...first,
      proof: {
        ...first.proof,
        proof: {
          ...first.proof.proof,
          commitments: first.proof.proof.commitments.map((point, index) =>
            index === 0 ? toBase64Url(new Uint8Array(32).fill(255)) : point,
          ),
        },
      },
    };
    const signed = signTradeProofResponse(request, 1, [malformed], owner.secretKey);
    expect(verifyTradeProofResponse(signed, request, context)).toMatchObject({
      ok: false,
      error: { code: 'hand-proof-invalid' },
    });
  });

  test('local engine exceptions return unavailable instead of a peer fault', () => {
    const { context, body, request, response } = scenario(0);
    for (const method of ['validate', 'apply'] as const) {
      const unavailable = {
        ...context,
        engine: {
          ...context.engine,
          [method]: () => {
            throw new Error('Local engine failure');
          },
        },
      };
      expect(planTradeProof(body, unavailable)).toMatchObject({
        ok: false,
        error: { code: 'trade-proof-unavailable' },
      });
      expect(verifyTradeProofRequest(request, unavailable)).toMatchObject({
        ok: false,
        error: { code: 'trade-proof-unavailable' },
      });
      expect(verifyTradeProofResponse(response, request, unavailable)).toMatchObject({
        ok: false,
        error: { code: 'trade-proof-unavailable' },
      });
    }
  });

  test.each([
    { name: 'accepted offer', proposer: 0 as Seat },
    { name: 'counter-offer', proposer: 1 as Seat },
  ])('$name binds the exact legal trade and each owner obligation', ({ proposer }) => {
    const { fixture, context, body, request, response, planned, finalizer, owner } =
      scenario(proposer);
    expect(planned.indices).toEqual([1]);
    expect(planTradeProof(body, context).ok).toBe(true);
    expect(authorizeTradeProof(body, 0, context).ok).toBe(false);
    expect(verifyTradeProofRequest(request, context).ok).toBe(true);
    expect(verifyTradeProofResponse(response, request, context).ok).toBe(true);
    expect(response.body.requestId).toBe(tradeProofRequestId(body));
    expect(tradeProofHost(context.genesis, 0)).toBe(finalizer.peerId);
    expect(tradeProofHost(context.genesis, 1)).toBe(owner.peerId);
    expect(tradeProofHost(context.genesis, 2)).toBe(finalizer.peerId);
    expect(tradeProofHost({ ...context.genesis, seats: [] }, 0)).toBeNull();

    const badSignature = signTradeProofRequest(body, owner.secretKey);
    expect(verifyTradeProofRequest(badSignature, context)).toMatchObject({
      ok: false,
      error: { code: 'trade-proof-signature' },
    });
    expect(planTradeProof({ ...body, nonce: 2 }, context)).toMatchObject({
      ok: false,
      error: { code: 'trade-proof-nonce' },
    });
    expect(
      planTradeProof({ ...body, command: { ...body.command, unexpected: true } }, context).ok,
    ).toBe(false);
    expect(planTradeProof({ ...body, command: { ...body.command, withSeat: 2 } }, context).ok).toBe(
      false,
    );
    expect(planTradeProof(body, { ...context, head: { ...context.head, seq: 1 } })).toMatchObject({
      ok: false,
      error: { code: 'trade-proof-stale-head' },
    });
    const firstProof = response.body.proofs[0];
    if (!firstProof || !context.crypto) throw new Error('Missing trade proof context');
    expect(
      verifyTradeProofResponse(
        signTradeProofResponse(request, 1, [{ ...firstProof, index: 0 }], owner.secretKey),
        request,
        context,
      ),
    ).toMatchObject({ ok: false, error: { code: 'trade-proof-indices' } });
    expect(
      verifyTradeProofResponse(
        signTradeProofResponse(request, 1, response.body.proofs, finalizer.secretKey),
        request,
        context,
      ),
    ).toMatchObject({ ok: false, error: { code: 'trade-proof-response-signature' } });
    expect(
      verifyTradeProofResponse(response, request, {
        ...context,
        crypto: { ...context.crypto, epoch: 1 },
      }).ok,
    ).toBe(false);
    expect(
      fixture.engine.validate(context.state, {
        kind: 'command',
        seat: 0,
        command: body.command,
      }).ok,
    ).toBe(true);
  });
});
