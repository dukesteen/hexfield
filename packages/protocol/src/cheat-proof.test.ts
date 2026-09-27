import { canonicalEncode, hashValue, sha256, toBase64Url, toHex } from '@cp2p/codec';
import {
  DERIVATION_LABELS,
  G,
  decodePoint,
  deriveScalar,
  encodePoint,
  encodeScalar,
  pedersenCommit,
  proveDleq,
  proveHiddenTransfer,
  scalePoint,
  sealWithEphemeralProof,
  signObject,
} from '@cp2p/crypto';
import {
  createResourceBounds,
  exactResourceBounds,
  RESOURCES,
  success,
  zeroCounts,
} from '@cp2p/engine';
import type { Engine, Resource, Result, Seat } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { beaconOperationId } from './beacon.js';
import { getBeaconOperation } from './beacon-state.js';
import type { BeaconState } from './beacon-state.js';
import { firstCheatFindings, verifyCheatProof } from './cheat-proof.js';
import { composeCommandProofs } from './command-proofs.js';
import type { CryptoContext } from './crypto-context.js';
import { countOperationId, proveCountOpening } from './count-reveal.js';
import type { CountOperation } from './count-reveal.js';
import { deckPassHash } from './deck-genesis.js';
import { deckDrawOperationId, signDeckUnlock } from './deck-draw.js';
import type { DeckDrawOperation } from './deck-draw.js';
import { applyDeckPass, initDeckSetup, signDeckLock, signDeckShuffle } from './deck-setup.js';
import { entryHash, genesisDigest, signEntry } from './genesis.js';
import { emptyHandCommitments } from './hand-commitments.js';
import { planHandTransition, proveHandObligation } from './hand-transition.js';
import { signCommand } from './log.js';
import type { LogContext } from './log.js';
import {
  STEAL_EVIDENCE_PROTOCOL,
  createStealContribution,
  createStealDispute,
  stealOperationId,
  stealReceiptBinding,
} from './steal-delivery.js';
import type { FixedSteal, StealOperation } from './steal-delivery.js';
import { protocolFixture } from './testing/fixtures.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing cheat-proof fixture value');
  return item;
}

function context(): {
  context: LogContext;
  identities: ReturnType<typeof protocolFixture>['identities'];
} {
  const fixture = protocolFixture();
  // Pure-verifier fixture: a replay integration must supply this same certified parent.
  const genesis = { ...fixture.genesis, security: 'verified' as const };
  const zero = zeroCounts(RESOURCES);
  const uncertain = value(createResourceBounds(1, zero, { ...zero, brick: 1, ore: 1 }));
  const none = value(exactResourceBounds(zero));
  const state = {
    ...fixture.state,
    bank: { ...fixture.state.bank, brick: (fixture.state.bank.brick ?? 0) - 1 },
    seats: fixture.state.seats.map((seat) =>
      seat.seat === 0 ? { ...seat, resources: uncertain } : seat,
    ),
  };
  const after = {
    ...state,
    bank: { ...fixture.state.bank },
    seats: state.seats.map((seat) => (seat.seat === 0 ? { ...seat, resources: none } : seat)),
  };
  const engine = {
    ...fixture.engine,
    validate: () => success(undefined),
    apply: () =>
      success({
        state: after,
        events: [],
        effects: [
          {
            type: 'resource-transfer' as const,
            from: { kind: 'seat' as const, seat: 0 },
            to: { kind: 'bank' as const },
            resource: 'brick' as const,
            count: 1,
          },
        ],
      }),
    checkInvariants: () => [],
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This synthetic engine isolates proof classification from turn legality; real integration supplies replayed engine state.
  } as unknown as Engine;
  const hands = value(emptyHandCommitments(genesis.config.seats)).map((row) => ({
    ...row,
    commitments:
      row.seat === 0 ? { ...row.commitments, brick: pedersenCommit(1n, 0n) } : row.commitments,
  }));
  const signer = required(fixture.identities[0]);
  const head = signEntry(
    {
      seq: 0,
      term: 1,
      prevHash: fixture.entry.prevHash,
      payload: { kind: 'genesis', genesis },
      stateHash: toHex(hashValue(state)),
      sequencer: signer.peerId,
    },
    signer.secretKey,
  );
  // oxlint-disable typescript/no-unsafe-type-assertion -- Only the hand and later frozen fields under test are read by the pure classifier.
  const crypto = {
    epoch: 0,
    hands,
    decks: { decks: [], active: null },
    counts: null,
    steal: null,
  } as unknown as CryptoContext;
  // oxlint-enable typescript/no-unsafe-type-assertion
  return {
    context: { genesis, engine, head, state, lastNonces: new Map(), crypto },
    identities: fixture.identities,
  };
}

function claim(
  kind: string,
  ctx: LogContext,
  artifact: { body: unknown; sig: string },
  seat: Seat,
) {
  return {
    seat,
    evidence: { kind, at: { seq: ctx.head.seq, hash: entryHash(ctx.head) }, artifact },
  };
}

describe('objective cheat proofs', () => {
  test('flags a signed missing hand proof, but not an honest proof, wrong signer, stale parent or engine failure', () => {
    const data = context();
    const ctx = data.context;
    const signer = required(data.identities[0]);
    const body = {
      gameId: ctx.genesis.gameId,
      genesisDigest: genesisDigest(ctx.genesis),
      seat: 0 as Seat,
      nonce: 1,
      headSeq: ctx.head.seq,
      headHash: entryHash(ctx.head),
      command: { type: 'END_TURN' as const },
    };
    const missing = signCommand(body, signer.secretKey);
    const proved = value(verifyCheatProof(claim('command-proof', ctx, missing, 0), ctx));
    expect(proved).toMatchObject({ seat: 0, kind: 'command-proof' });
    const gapped = signCommand({ ...body, nonce: 2 }, signer.secretKey);
    expect(verifyCheatProof(claim('command-proof', ctx, gapped, 0), ctx)).toMatchObject({
      ok: true,
      value: { seat: 0 },
    });
    const replayedNonce = signCommand({ ...body, nonce: 0 }, signer.secretKey);
    expect(verifyCheatProof(claim('command-proof', ctx, replayedNonce, 0), ctx).ok).toBe(false);
    const appliedNonce = { ...ctx, lastNonces: new Map<Seat, number>([[0, 1]]) };
    expect(
      verifyCheatProof(claim('command-proof', appliedNonce, missing, 0), appliedNonce),
    ).toMatchObject({ ok: false, error: { code: 'cheat-unproven' } });
    expect(verifyCheatProof(claim('command-proof', ctx, missing, 1), ctx).ok).toBe(false);
    expect(
      verifyCheatProof(
        claim('command-proof', ctx, { ...missing, sig: required(data.identities[1]).peerId }, 0),
        ctx,
      ).ok,
    ).toBe(false);
    expect(
      verifyCheatProof(
        claim(
          'command-proof',
          ctx,
          { ...missing, sig: signObject('cmd', body, required(data.identities[1]).secretKey) },
          0,
        ),
        ctx,
      ).ok,
    ).toBe(false);
    expect(
      verifyCheatProof(
        {
          ...claim('command-proof', ctx, missing, 0),
          evidence: {
            ...claim('command-proof', ctx, missing, 0).evidence,
            at: { seq: 1, hash: entryHash(ctx.head) },
          },
        },
        ctx,
      ).ok,
    ).toBe(false);
    const input = { kind: 'command' as const, seat: 0 as Seat, command: body.command };
    const transition = value(ctx.engine.apply(ctx.state, input));
    const plan = value(
      planHandTransition(required(ctx.crypto).hands, ctx.state, input, transition),
    );
    const binding = {
      genesisDigest: body.genesisDigest,
      epoch: 0,
      anchor: { seq: body.headSeq, hash: body.headHash },
      command: body,
    };
    const proof = value(
      proveHandObligation(
        plan,
        0,
        { brick: 1, lumber: 0, wool: 0, grain: 0, ore: 0 },
        {
          brick: encodeScalar(0n),
          lumber: encodeScalar(0n),
          wool: encodeScalar(0n),
          grain: encodeScalar(0n),
          ore: encodeScalar(0n),
        },
        new Uint8Array(32).fill(7),
        binding,
      ),
    );
    const evidence = composeCommandProofs([], [proof]);
    if (!evidence) throw new Error('Missing honest command proof');
    const honest = signCommand({ ...body, evidence }, signer.secretKey);
    expect(verifyCheatProof(claim('command-proof', ctx, honest, 0), ctx).ok).toBe(false);
    const illegal: LogContext = {
      ...ctx,
      engine: {
        ...ctx.engine,
        validate: () => ({ ok: false, error: { code: 'synthetic-illegal', message: 'illegal' } }),
      },
    };
    expect(verifyCheatProof(claim('command-proof', illegal, missing, 0), illegal).ok).toBe(false);
    const brokenState: LogContext = {
      ...ctx,
      engine: {
        ...ctx.engine,
        checkInvariants: (state) => (state === ctx.state ? [] : ['synthetic invariant']),
      },
    };
    expect(verifyCheatProof(claim('command-proof', brokenState, missing, 0), brokenState).ok).toBe(
      false,
    );
    const mismatchedReveal: LogContext = {
      ...ctx,
      engine: {
        ...ctx.engine,
        apply: (state, attemptedInput) => {
          const applied = ctx.engine.apply(state, attemptedInput);
          return applied.ok
            ? success({
                ...applied.value,
                effects: [
                  ...applied.value.effects,
                  {
                    type: 'card-slot-revealed' as const,
                    seat: 0 as Seat,
                    deck: 'dev',
                    slotId: 'dev:0',
                    card: 'knight',
                  },
                ],
              })
            : applied;
        },
      },
    };
    expect(
      verifyCheatProof(claim('command-proof', mismatchedReveal, missing, 0), mismatchedReveal).ok,
    ).toBe(false);
    expect(firstCheatFindings([proved], proved, [0, 1])).toEqual([proved]);
  });

  test('flags a resigned bad count proof including malformed nested proof, but not a forged signature', () => {
    const { context: ctx, identities } = context();
    const owner = required(identities[0]);
    const commitment = pedersenCommit(1n, 0n);
    const operation: CountOperation = {
      protocol: 'monopoly-count-v1',
      genesisDigest: genesisDigest(ctx.genesis),
      epoch: 0,
      anchor: { seq: ctx.head.seq, hash: entryHash(ctx.head) },
      monopolist: 1,
      resource: 'brick',
      victims: [{ seat: 0, publicKey: owner.peerId, commitment }],
    };
    const valid = value(
      proveCountOpening(operation, 0, 1, encodeScalar(0n), new Uint8Array(32).fill(4)),
    );
    const body = {
      operationId: countOperationId(operation),
      seat: 0 as Seat,
      count: 1,
      proof: valid,
    };
    const good = { body, sig: signObject('monopoly-count', body, owner.secretKey) };
    ctx.crypto = { ...required(ctx.crypto), counts: { operation, remaining: [0] } };
    expect(verifyCheatProof(claim('count-proof', ctx, good, 0), ctx).ok).toBe(false);
    const wrongBody = { ...body, proof: { ...valid, response: encodeScalar(0n) } };
    const bad = { body: wrongBody, sig: signObject('monopoly-count', wrongBody, owner.secretKey) };
    expect(verifyCheatProof(claim('count-proof', ctx, bad, 0), ctx)).toMatchObject({
      ok: true,
      value: { seat: 0 },
    });
    const malformedBody = { ...body, proof: { commitment: 'bad', response: 'bad' } };
    const malformed = {
      body: malformedBody,
      sig: signObject('monopoly-count', malformedBody, owner.secretKey),
    };
    expect(verifyCheatProof(claim('count-proof', ctx, malformed, 0), ctx).ok).toBe(true);
    expect(verifyCheatProof(claim('count-proof', ctx, { ...bad, sig: good.sig }, 0), ctx).ok).toBe(
      false,
    );
  });

  test('requires committed deck pass hash and authenticates the next unlock before proof classification', () => {
    const { context: ctx, identities } = context();
    const first = required(identities[0]);
    const second = required(identities[1]);
    const setup = value(
      initDeckSetup({
        ceremonyId: toBase64Url(new Uint8Array(32).fill(11)),
        deckId: 'test-dev',
        deckEpoch: 0,
        creation: { kind: 'ceremony' },
        cards: [
          { identity: 'a', card: 'knight' },
          { identity: 'b', card: 'victoryPoint' },
          { identity: 'c', card: 'roadBuilding' },
        ],
        participants: [
          { seat: 0, publicKey: first.peerId },
          { seat: 1, publicKey: second.peerId },
        ],
      }),
    );
    const good = signDeckShuffle(setup, 5n, [1, 2, 0], new Uint8Array(32).fill(3), first.secretKey);
    if (good.body.phase !== 'shuffle') throw new Error('Expected shuffle pass');
    const badBody = {
      ...good.body,
      proof: {
        ...good.body.proof,
        responses: good.body.proof.responses.map((response, index) =>
          index === 0 ? { ...response, scalar: encodeScalar(0n) } : response,
        ),
      },
    };
    const bad = { body: badBody, sig: signObject('deck-pass', badBody, first.secretKey) };
    const deck = {
      setup,
      nextPass: 0,
      nextPosition: 0,
      slots: [],
      commitment: {
        definition: setup.definition,
        passHashes: [deckPassHash(bad)],
        finalStateHash: 'f'.repeat(64),
      },
    } satisfies CryptoContext['decks']['decks'][number];
    ctx.crypto = {
      ...required(ctx.crypto),
      decks: { genesisDigest: genesisDigest(ctx.genesis), decks: [deck], active: null },
    };
    expect(verifyCheatProof(claim('deck-pass', ctx, bad, 0), ctx).ok).toBe(true);
    expect(verifyCheatProof(claim('deck-pass', ctx, good, 0), ctx).ok).toBe(false);
    expect(verifyCheatProof(claim('deck-pass', ctx, { ...bad, sig: good.sig }, 0), ctx).ok).toBe(
      false,
    );
    const otherPass = { ...badBody, operationId: 'a'.repeat(64) };
    expect(
      verifyCheatProof(
        claim(
          'deck-pass',
          ctx,
          { body: otherPass, sig: signObject('deck-pass', otherPass, first.secretKey) },
          0,
        ),
        ctx,
      ).ok,
    ).toBe(false);

    const afterFirst = value(applyDeckPass(setup, good));
    const secondShuffle = signDeckShuffle(
      afterFirst,
      7n,
      [2, 0, 1],
      new Uint8Array(32).fill(4),
      second.secretKey,
    );
    const lockSetup = value(applyDeckPass(afterFirst, secondShuffle));
    const goodLock = signDeckLock(
      lockSetup,
      5n,
      [11n, 13n, 17n],
      new Uint8Array(32).fill(5),
      first.secretKey,
    );
    if (goodLock.body.phase !== 'lock') throw new Error('Expected lock pass');
    const badLockBody = {
      ...goodLock.body,
      proofs: goodLock.body.proofs.map((proof, index) =>
        index === 0 ? { ...proof, response: encodeScalar(0n) } : proof,
      ),
    };
    const badLock = {
      body: badLockBody,
      sig: signObject('deck-pass', badLockBody, first.secretKey),
    };
    ctx.crypto = {
      ...required(ctx.crypto),
      decks: {
        genesisDigest: genesisDigest(ctx.genesis),
        decks: [
          {
            ...deck,
            setup: lockSetup,
            nextPass: 2,
            commitment: {
              ...deck.commitment,
              passHashes: [deckPassHash(good), deckPassHash(secondShuffle), deckPassHash(badLock)],
            },
          },
        ],
        active: null,
      },
    };
    expect(verifyCheatProof(claim('deck-pass', ctx, badLock, 0), ctx).ok).toBe(true);

    const operation: DeckDrawOperation = {
      genesisDigest: genesisDigest(ctx.genesis),
      epoch: 0,
      anchor: { seq: ctx.head.seq, hash: entryHash(ctx.head) },
      position: 0,
      seat: 1,
      slotId: 'slot-0',
      setupHash: 'c'.repeat(64),
      deckId: 'test-dev',
      deckEpoch: 0,
      initialPoint: encodePoint(scalePoint(G, 35n)),
      participants: [
        { seat: 0, publicKey: first.peerId, lockKey: encodePoint(scalePoint(G, 3n)) },
        { seat: 1, publicKey: second.peerId, lockKey: encodePoint(scalePoint(G, 7n)) },
      ],
    };
    const unlock = signDeckUnlock(operation, [], 3n, new Uint8Array(32).fill(7), first.secretKey);
    const invalidBody = {
      ...unlock.body,
      proof: { ...unlock.body.proof, response: encodeScalar(0n) },
    };
    const invalid = {
      body: invalidBody,
      sig: signObject('deck-unlock', invalidBody, first.secretKey),
    };
    ctx.crypto = {
      ...required(ctx.crypto),
      decks: { ...required(ctx.crypto).decks, active: operation },
    };
    const unlockClaim = {
      seat: 0 as Seat,
      evidence: {
        kind: 'deck-unlock' as const,
        at: { seq: ctx.head.seq, hash: entryHash(ctx.head) },
        prefix: [],
        artifact: invalid,
      },
    };
    expect(verifyCheatProof(unlockClaim, ctx).ok).toBe(true);
    const malformedUnlock = { ...unlock.body, proof: { bad: true } };
    expect(
      verifyCheatProof(
        {
          ...unlockClaim,
          evidence: {
            ...unlockClaim.evidence,
            artifact: {
              body: malformedUnlock,
              sig: signObject('deck-unlock', malformedUnlock, first.secretKey),
            },
          },
        },
        ctx,
      ).ok,
    ).toBe(true);
    expect(
      verifyCheatProof(
        { ...unlockClaim, evidence: { ...unlockClaim.evidence, artifact: unlock } },
        ctx,
      ).ok,
    ).toBe(false);
    expect(
      verifyCheatProof(
        {
          ...unlockClaim,
          evidence: { ...unlockClaim.evidence, artifact: { ...invalid, sig: unlock.sig } },
        },
        ctx,
      ).ok,
    ).toBe(false);
    const wrongBody = { ...invalidBody, operationId: 'a'.repeat(64) };
    expect(
      verifyCheatProof(
        {
          ...unlockClaim,
          evidence: {
            ...unlockClaim.evidence,
            artifact: {
              body: wrongBody,
              sig: signObject('deck-unlock', wrongBody, first.secretKey),
            },
          },
        },
        ctx,
      ).ok,
    ).toBe(false);
    expect(unlock.body.operationId).toBe(deckDrawOperationId(operation));
  });

  test('flags a signed bad beacon link and hidden transfer proof only at their frozen operations', () => {
    const { context: ctx, identities } = context();
    const victim = required(identities[0]);
    const thief = required(identities[1]);
    const link = new Uint8Array(32).fill(7);
    const chainSeats: readonly Seat[] = [0, 1];
    const chains = chainSeats.map((seat) => ({
      seat,
      publicKey: required(identities[seat]).peerId,
      chainEpoch: 0,
      index: 0,
      length: 1,
      tip: toBase64Url(sha256(link)),
    }));
    const beacon: BeaconState = {
      genesisDigest: genesisDigest(ctx.genesis),
      chains,
      round: 0,
      active: {
        genesisDigest: genesisDigest(ctx.genesis),
        epoch: 0,
        anchor: { seq: ctx.head.seq, hash: entryHash(ctx.head) },
        round: 1,
        pending: { kind: 'random', request: { type: 'dice' }, systemType: 'DICE_RESULT' },
        participants: chains,
      },
      fixed: null,
    };
    ctx.crypto = { ...required(ctx.crypto), beacon };
    const operation = value(getBeaconOperation(beacon));
    const revealBody = {
      operationId: beaconOperationId(operation),
      seat: 0 as Seat,
      index: 1,
      value: toBase64Url(new Uint8Array(32).fill(9)),
    };
    const reveal = {
      body: revealBody,
      sig: signObject('beacon-reveal', revealBody, victim.secretKey),
    };
    expect(verifyCheatProof(claim('beacon-reveal', ctx, reveal, 0), ctx).ok).toBe(true);
    expect(
      verifyCheatProof(
        claim('beacon-reveal', ctx, { ...reveal, sig: required(identities[1]).peerId }, 0),
        ctx,
      ).ok,
    ).toBe(false);
    const wrongOperation = { ...revealBody, operationId: 'a'.repeat(64) };
    expect(
      verifyCheatProof(
        claim(
          'beacon-reveal',
          ctx,
          {
            body: wrongOperation,
            sig: signObject('beacon-reveal', wrongOperation, victim.secretKey),
          },
          0,
        ),
        ctx,
      ).ok,
    ).toBe(false);

    const counts: Record<Resource, number> = { brick: 1, lumber: 0, wool: 0, grain: 0, ore: 0 };
    const blindings: Record<Resource, string> = {
      brick: encodeScalar(0n),
      lumber: encodeScalar(0n),
      wool: encodeScalar(0n),
      grain: encodeScalar(0n),
      ore: encodeScalar(0n),
    };
    const commitments: Record<Resource, string> = {
      brick: pedersenCommit(1n, 0n),
      lumber: pedersenCommit(0n, 0n),
      wool: pedersenCommit(0n, 0n),
      grain: pedersenCommit(0n, 0n),
      ore: pedersenCommit(0n, 0n),
    };
    const steal: StealOperation = {
      protocol: STEAL_EVIDENCE_PROTOCOL,
      genesisDigest: genesisDigest(ctx.genesis),
      epoch: 0,
      anchor: { seq: ctx.head.seq, hash: entryHash(ctx.head) },
      beaconOperationId: 'c'.repeat(64),
      thief: { seat: 1, publicKey: thief.peerId, encryptionKey: encodePoint(scalePoint(G, 21n)) },
      victim: { seat: 0, publicKey: victim.peerId },
      handSize: 1,
      index: 0,
      commitments,
    };
    const contribution = value(
      createStealContribution(
        steal,
        counts,
        blindings,
        new Uint8Array(32).fill(8),
        victim.secretKey,
      ),
    );
    ctx.crypto = {
      ...required(ctx.crypto),
      steal: { operation: steal, fixed: null, dispute: null },
    };
    const corruptBody = { ...contribution.body, proof: { bad: true } };
    const corrupt = {
      body: corruptBody,
      sig: signObject('steal-contribution', corruptBody, victim.secretKey),
    };
    expect(verifyCheatProof(claim('steal-contribution', ctx, corrupt, 0), ctx)).toMatchObject({
      ok: true,
      value: { seat: 0 },
    });
    expect(verifyCheatProof(claim('steal-contribution', ctx, contribution, 0), ctx).ok).toBe(false);
    const badPointBody = {
      ...contribution.body,
      sealed: {
        ...contribution.body.sealed,
        ephemeral: toBase64Url(new Uint8Array(32).fill(255)),
      },
    };
    const badPoint = {
      body: badPointBody,
      sig: signObject('steal-contribution', badPointBody, victim.secretKey),
    };
    expect(verifyCheatProof(claim('steal-contribution', ctx, badPoint, 0), ctx)).toMatchObject({
      ok: true,
      value: { seat: 0 },
    });
    expect(
      verifyCheatProof(
        claim('steal-contribution', ctx, { ...badPoint, sig: contribution.sig }, 0),
        ctx,
      ).ok,
    ).toBe(false);
    const malformedEphemeral = { ...contribution.body, ephemeralProof: { bad: true } };
    expect(
      verifyCheatProof(
        claim(
          'steal-contribution',
          ctx,
          {
            body: malformedEphemeral,
            sig: signObject('steal-contribution', malformedEphemeral, victim.secretKey),
          },
          0,
        ),
        ctx,
      ).ok,
    ).toBe(true);
    expect(
      verifyCheatProof(
        claim('steal-contribution', ctx, { ...corrupt, sig: contribution.sig }, 0),
        ctx,
      ).ok,
    ).toBe(false);
    const otherSteal = { ...corruptBody, operationId: 'a'.repeat(64) };
    expect(
      verifyCheatProof(
        claim(
          'steal-contribution',
          ctx,
          { body: otherSteal, sig: signObject('steal-contribution', otherSteal, victim.secretKey) },
          0,
        ),
        ctx,
      ).ok,
    ).toBe(false);
  });

  test('distinguishes certified bad delivery from an authenticated false dispute', () => {
    const { context: ctx, identities } = context();
    const victim = required(identities[0]);
    const thief = required(identities[1]);
    const seed = new Uint8Array(32).fill(8);
    const counts: Record<Resource, number> = { brick: 1, lumber: 0, wool: 0, grain: 0, ore: 0 };
    const zero = encodeScalar(0n);
    const blindings: Record<Resource, string> = {
      brick: zero,
      lumber: zero,
      wool: zero,
      grain: zero,
      ore: zero,
    };
    const commitments: Record<Resource, string> = {
      brick: pedersenCommit(1n, 0n),
      lumber: pedersenCommit(0n, 0n),
      wool: pedersenCommit(0n, 0n),
      grain: pedersenCommit(0n, 0n),
      ore: pedersenCommit(0n, 0n),
    };
    const operation: StealOperation = {
      protocol: STEAL_EVIDENCE_PROTOCOL,
      genesisDigest: genesisDigest(ctx.genesis),
      epoch: 0,
      anchor: { seq: ctx.head.seq, hash: entryHash(ctx.head) },
      beaconOperationId: 'c'.repeat(64),
      thief: { seat: 1, publicKey: thief.peerId, encryptionKey: encodePoint(scalePoint(G, 21n)) },
      victim: { seat: 0, publicKey: victim.peerId },
      handSize: 1,
      index: 0,
      commitments,
    };
    const good = value(
      createStealContribution(operation, counts, blindings, seed, victim.secretKey),
    );
    const fixedEntry = signEntry(
      {
        seq: 1,
        term: 1,
        prevHash: entryHash(ctx.head),
        payload: { kind: 'crypto', action: 'steal-fixed', evidence: good },
        stateHash: ctx.head.stateHash,
        sequencer: thief.peerId,
      },
      thief.secretKey,
    );
    const goodFixed: FixedSteal = {
      operation,
      contribution: good,
      entry: { seq: 1, hash: entryHash(fixedEntry) },
    };
    ctx.head = fixedEntry;
    const sharedPoint = encodePoint(scalePoint(decodePoint(good.body.sealed.ephemeral), 21n));
    const binding = stealReceiptBinding(goodFixed);
    const proof = proveDleq(
      {
        base1: encodePoint(G),
        point1: operation.thief.encryptionKey,
        base2: good.body.sealed.ephemeral,
        point2: sharedPoint,
      },
      21n,
      new Uint8Array(32).fill(10),
      { protocol: 'steal-dispute-v1', binding },
    );
    const falseBody = { binding, sharedPoint, proof };
    const falseDispute = {
      body: falseBody,
      sig: signObject('steal-dispute', falseBody, thief.secretKey),
    };
    ctx.crypto = { ...required(ctx.crypto), steal: { operation, fixed: goodFixed, dispute: null } };
    expect(verifyCheatProof(claim('false-steal-dispute', ctx, falseDispute, 1), ctx)).toMatchObject(
      { ok: true, value: { seat: 1 } },
    );
    expect(verifyCheatProof(claim('bad-steal-delivery', ctx, falseDispute, 0), ctx).ok).toBe(false);
    expect(
      verifyCheatProof(
        claim('false-steal-dispute', ctx, { ...falseDispute, sig: good.sig }, 1),
        ctx,
      ).ok,
    ).toBe(false);

    const operationId = stealOperationId(operation);
    const transfer = good.body.transfer;
    const transferBlindings = RESOURCES.map((resource) =>
      deriveScalar(seed, DERIVATION_LABELS.transferBlind, { operationId, resource }),
    );
    const falseOpening = canonicalEncode({
      type: 1,
      blindings: transferBlindings.map(encodeScalar),
    });
    const { sealed, ephemeralProof } = sealWithEphemeralProof(
      falseOpening,
      operation.thief.encryptionKey,
      seed,
      { protocol: 'steal-seal-v1', operationId, transfer },
      { protocol: 'steal-ephemeral-v1', operationId, transfer },
    );
    falseOpening.fill(0);
    const falseProof = proveHiddenTransfer(
      {
        commitments: RESOURCES.map((resource) => operation.commitments[resource]),
        transfer,
        handSize: operation.handSize,
        index: operation.index,
        payloadHash: toHex(hashValue(sealed)),
      },
      {
        counts: RESOURCES.map((resource) => counts[resource]),
        blindings: RESOURCES.map(() => 0n),
        transferBlindings,
      },
      seed,
      { protocol: 'steal-transfer-v1', operationId },
    );
    const badBody = { ...good.body, sealed, ephemeralProof, proof: falseProof };
    const bad = { body: badBody, sig: signObject('steal-contribution', badBody, victim.secretKey) };
    const badFixed: FixedSteal = { ...goodFixed, contribution: bad };
    const dispute = value(
      createStealDispute(badFixed, 21n, thief.secretKey, new Uint8Array(32).fill(11)),
    );
    ctx.crypto = { ...required(ctx.crypto), steal: { operation, fixed: badFixed, dispute } };
    expect(verifyCheatProof(claim('bad-steal-delivery', ctx, dispute, 0), ctx)).toMatchObject({
      ok: true,
      value: { seat: 0 },
    });
    expect(verifyCheatProof(claim('false-steal-dispute', ctx, dispute, 1), ctx).ok).toBe(false);
  });
});
