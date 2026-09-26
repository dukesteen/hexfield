import { pedersenCommit, signObject } from '@cp2p/crypto';
import { createResourceBounds, RESOURCES, zeroCounts } from '@cp2p/engine';
import type { CommandInput, Engine, GameState, Input, Result, Seat } from '@cp2p/engine';
import { describe, expect, test, vi } from 'vitest';
import type { CryptoContext } from './crypto-context.js';
import { readCommandProofs } from './command-proofs.js';
import { entryHash, genesisDigest } from './genesis.js';
import { emptyHandCommitments } from './hand-commitments.js';
import { planHandTransition, verifyHandProofs } from './hand-transition.js';
import type { LogContext } from './log.js';
import { protocolFixture } from './testing/fixtures.js';
import { VerifiedSessionDriver } from './verified-session-driver.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function apply(engine: Engine, state: GameState, input: Input) {
  return value(engine.apply(state, input));
}

describe('verified gross player trades', () => {
  test.each([
    { name: 'active offer', proposer: 0 as Seat, firstResource: 'brick' },
    { name: 'counter-offer', proposer: 1 as Seat, firstResource: 'ore' },
  ])('$name requires both owners’ debit proofs', ({ proposer, firstResource }) => {
    const fixture = protocolFixture();
    const engine = fixture.engine;
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
            command: { type: 'OFFER_TRADE', give: { brick: 1 }, want: { ore: 1 }, to: [1] },
          }
        : {
            kind: 'command',
            seat: 1,
            command: { type: 'PROPOSE_TRADE', give: { ore: 1 }, want: { brick: 1 } },
          };
    const offered = apply(engine, state, offer);
    const ready =
      proposer === 0
        ? apply(engine, offered.state, {
            kind: 'command',
            seat: 1,
            command: { type: 'RESPOND_TRADE', offerId: 0, accept: true },
          }).state
        : offered.state;
    const confirm: CommandInput = {
      kind: 'command',
      seat: 0,
      command: { type: 'CONFIRM_TRADE', offerId: 0, withSeat: 1 },
    };
    const transition = apply(engine, ready, confirm);
    const transfers = transition.effects.filter((effect) => effect.type === 'resource-transfer');
    expect(transfers.map((effect) => effect.resource)).toEqual(
      firstResource === 'brick' ? ['brick', 'ore'] : ['ore', 'brick'],
    );
    expect(transfers.map((effect) => effect.count)).toEqual([1, 1]);

    const hands = value(emptyHandCommitments(genesis.config.seats)).map((row) => ({
      ...row,
      commitments: {
        ...row.commitments,
        brick: row.seat === 0 ? pedersenCommit(1n, 0n) : row.commitments.brick,
        ore: row.seat === 1 ? pedersenCommit(1n, 0n) : row.commitments.ore,
      },
    }));
    const plan = value(planHandTransition(hands, ready, confirm, transition));
    expect(plan.obligations).toMatchObject([
      { kind: 'range', seat: 0, resource: 'brick', count: 1 },
      { kind: 'range', seat: 1, resource: 'ore', count: 1 },
    ]);
    expect(plan.obligations.map((obligation) => obligation.effectIndices)).toEqual(
      firstResource === 'brick' ? [[0], [1]] : [[1], [0]],
    );

    // The fixture has a stub genesis, so only crypto.hands is material here. The
    // hand commitments and owned opening are genuine; no peer proof is fabricated.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- synthetic context supplies the hand ledger read by this driver path.
    const crypto = { epoch: 0, hands, decks: { decks: [] } } as unknown as CryptoContext;
    const context: LogContext = {
      genesis,
      engine,
      head: fixture.entry,
      state: ready,
      lastNonces: new Map(),
      crypto,
    };
    const ownedEngine = {
      ...engine,
      createPrivateState: (seat: Seat) => ({
        ...engine.createPrivateState(seat),
        hand: { ...zero, brick: seat === 0 ? 1 : 0, ore: seat === 1 ? 1 : 0 },
      }),
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the owned private initialization differs from the real engine.
    } as Engine;
    const driver = new VerifiedSessionDriver(
      ownedEngine,
      genesis,
      [0],
      () => {
        throw new Error('Trade needs no deck source');
      },
      () => ({ proofSeed: () => new Uint8Array(32).fill(7), dispose: () => undefined }),
    );
    const body = {
      gameId: genesis.gameId,
      genesisDigest: genesisDigest(genesis),
      seat: 0 as Seat,
      nonce: 1,
      headSeq: context.head.seq,
      headHash: entryHash(context.head),
      command: { type: 'CONFIRM_TRADE' as const, offerId: 0, withSeat: 1 as Seat },
    };
    expect(driver.prepareCommand(body, context)).toMatchObject({
      ok: false,
      error: { code: 'hand-proof-owner' },
    });
    const signer = fixture.identities[0];
    if (!signer) throw new Error('Missing trade finalizer key');
    const request = { body, sig: signObject('trade-proof-request', body, signer.secretKey) };
    const source = vi.fn<(seat: Seat) => { proofSeed: () => Uint8Array; dispose: () => void }>(
      () => ({
        proofSeed: () => new Uint8Array(32).fill(8),
        dispose: () => undefined,
      }),
    );
    const owner = new VerifiedSessionDriver(
      ownedEngine,
      genesis,
      [1],
      () => {
        throw new Error('Trade needs no deck source');
      },
      source,
    );
    const external = value(owner.produceTradeProofs(request, context));
    const remoteProof = external[0];
    if (!remoteProof) throw new Error('Missing remote trade proof');
    expect(external.map((item) => item.index)).toEqual([1]);
    expect(source).toHaveBeenCalledOnce();
    const evidence = value(driver.prepareCommand(body, context, external));
    const assembledHands = value(readCommandProofs(evidence, plan)).hands;
    expect(assembledHands).toHaveLength(2);
    expect(
      verifyHandProofs(plan, assembledHands, {
        genesisDigest: body.genesisDigest,
        epoch: 0,
        anchor: { seq: body.headSeq, hash: body.headHash },
        command: body,
      }),
    ).toMatchObject({ ok: true });
    expect(driver.prepareCommand(body, context, [...external, ...external])).toMatchObject({
      ok: false,
      error: { code: 'hand-proof-external' },
    });
    expect(driver.prepareCommand(body, context, [{ ...remoteProof, index: 0 }])).toMatchObject({
      ok: false,
      error: { code: 'hand-proof-external' },
    });
    expect(driver.prepareCommand(body, context, [{ ...remoteProof, index: 99 }])).toMatchObject({
      ok: false,
      error: { code: 'hand-proof-external' },
    });
    expect(
      driver.prepareCommand(body, context, [
        { ...remoteProof, proof: { ...remoteProof.proof, resource: 'wool' } },
      ]),
    ).toMatchObject({ ok: false });
    const both = new VerifiedSessionDriver(
      ownedEngine,
      genesis,
      [0, 1],
      () => {
        throw new Error('Trade needs no deck source');
      },
      () => ({ proofSeed: () => new Uint8Array(32).fill(7), dispose: () => undefined }),
    );
    expect(both.prepareCommand(body, context)).toMatchObject({
      ok: true,
      value: { protocol: 'command-proofs-v1', data: { hands: [{}, {}] } },
    });
    const wrongSigner = fixture.identities[1];
    if (!wrongSigner) throw new Error('Missing wrong trade signer');
    const forged = { body, sig: signObject('trade-proof-request', body, wrongSigner.secretKey) };
    expect(owner.produceTradeProofs(forged, context).ok).toBe(false);
    expect(source).toHaveBeenCalledOnce();
    for (const changedBody of [
      { ...body, nonce: 2 },
      { ...body, command: { ...body.command, withSeat: 2 as Seat } },
      { ...body, command: { ...body.command, offerId: 99 } },
      { ...body, command: { ...body.command, extra: true } },
    ]) {
      const changed = {
        body: changedBody,
        sig: signObject('trade-proof-request', changedBody, signer.secretKey),
      };
      expect(owner.produceTradeProofs(changed, context).ok).toBe(false);
      expect(source).toHaveBeenCalledOnce();
    }
    expect(
      owner.produceTradeProofs(request, { ...context, head: { ...context.head, seq: 1 } }).ok,
    ).toBe(false);
    expect(source).toHaveBeenCalledOnce();
    both.dispose();
    owner.dispose();
    expect(driver.privateState(0)?.hand.brick).toBe(1);
    driver.dispose();
  });
});
