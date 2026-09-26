import { pedersenCommit } from '@cp2p/crypto';
import { createResourceBounds, RESOURCES, zeroCounts } from '@cp2p/engine';
import type { CommandInput, Engine, GameState, Input, Result, Seat } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import type { CryptoContext } from './crypto-context.js';
import { entryHash, genesisDigest } from './genesis.js';
import { emptyHandCommitments } from './hand-commitments.js';
import { planHandTransition } from './hand-transition.js';
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
        hand: { ...zero, brick: seat === 0 ? 1 : 0 },
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
    expect(
      driver.prepareCommand(
        {
          gameId: genesis.gameId,
          genesisDigest: genesisDigest(genesis),
          seat: 0,
          nonce: 1,
          headSeq: context.head.seq,
          headHash: entryHash(context.head),
          command: confirm.command,
        },
        context,
      ),
    ).toMatchObject({ ok: false, error: { code: 'hand-proof-owner' } });
    expect(driver.privateState(0)?.hand.brick).toBe(1);
    driver.dispose();
  });
});
