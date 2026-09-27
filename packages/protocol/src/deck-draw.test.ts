import { canonicalEncode, toBase64Url } from '@cp2p/codec';
import * as crypto from '@cp2p/crypto';
import { identityFromSecret, signObject } from '@cp2p/crypto';
import { describe, expect, test, vi } from 'vitest';
import {
  completeDeckDraw,
  deckDrawOperationId,
  decodeDeckCard,
  freezeDeckDraw,
  proveDeckReveal,
  signDeckUnlock,
  verifyDeckUnlockPrefix,
  verifyDeckReveal,
} from './deck-draw.js';
import type { DealtDeckCard, DeckDrawRequest, SignedDeckUnlock } from './deck-draw.js';
import type { ArtifactSigner } from './authority-types.js';
import { createDeckGenesisCommitment } from './deck-genesis.js';
import { validateDeckLedger } from './deck-ledger.js';
import {
  applyDeckPass,
  deckSetupId,
  initDeckSetup,
  signDeckLock,
  signDeckShuffle,
} from './deck-setup.js';
import type { DeckSetupState, SignedDeckPass } from './deck-setup.js';
import { prepareDeckUnlock } from './deck-outbox.js';
import type { DeckContributionStore } from './deck-outbox.js';

const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);
const hexHash = (digit: string): string => digit.repeat(64);
const digest = toBase64Url(new Uint8Array(32).fill(12));

interface Fixture {
  setup: DeckSetupState;
  passes: SignedDeckPass[];
  keys: readonly Uint8Array[];
  ownerLocks: readonly bigint[];
  lockRows: readonly (readonly bigint[])[];
  request: DeckDrawRequest;
}

function setupFixture(): Fixture {
  const keys = [bytes(1), bytes(2), bytes(3)] as const;
  const identities = keys.map(identityFromSecret);
  const definition = {
    ceremonyId: digest,
    deckId: 'fixture-dev-deck',
    deckEpoch: 0,
    creation: { kind: 'ceremony' as const },
    cards: [
      { identity: 'knight-a', card: 'knight' },
      { identity: 'road-b', card: 'roadBuilding' },
      { identity: 'point-c', card: 'victoryPoint' },
    ],
    participants: identities.map((identity, seat) => ({ seat, publicKey: identity.peerId })),
  };
  for (const identity of identities) identity.secretKey.fill(0);
  const initial = initDeckSetup(definition);
  if (!initial.ok) throw new Error(`fixture init failed: ${initial.error.code}`);

  let setup = initial.value;
  const passes: SignedDeckPass[] = [];
  const shuffleSecrets = [5n, 7n, 9n] as const;
  const permutations = [
    [2, 0, 1],
    [0, 2, 1],
    [2, 0, 1],
  ] as const;
  const lockSecrets = [
    [11n, 13n, 17n],
    [19n, 23n, 29n],
    [31n, 37n, 41n],
  ] as const;
  for (let seat = 0; seat < 3; seat += 1) {
    const secret = shuffleSecrets[seat];
    const key = keys[seat];
    const permutation = permutations[seat];
    const proofSeed = bytes(31 + seat);
    if (!secret || !key || !permutation) throw new Error('missing fixture signer');
    const shuffled = signDeckShuffle(setup, secret, permutation, proofSeed, key);
    passes.push(shuffled);
    const next = applyDeckPass(setup, shuffled);
    if (!next.ok) throw new Error(`fixture shuffle failed: ${next.error.code}`);
    setup = next.value;
  }
  for (let seat = 0; seat < 3; seat += 1) {
    const secret = shuffleSecrets[seat];
    const locks = lockSecrets[seat];
    const key = keys[seat];
    if (!secret || !locks || !key) throw new Error('missing fixture lock signer');
    const locked = signDeckLock(setup, secret, locks, bytes(41 + seat), key);
    passes.push(locked);
    const next = applyDeckPass(setup, locked);
    if (!next.ok) throw new Error(`fixture lock failed: ${next.error.code}`);
    setup = next.value;
  }
  return {
    setup,
    passes,
    keys,
    ownerLocks: lockSecrets[2],
    lockRows: lockSecrets,
    request: {
      genesisDigest: digest,
      epoch: 4,
      anchor: { seq: 12, hash: hexHash('a') },
      position: 1,
      seat: 2,
      slotId: 'dev-slot-12',
    },
  };
}

function draw(fixture: Fixture, request = fixture.request): DealtDeckCard {
  const frozen = freezeDeckDraw(fixture.setup, request);
  if (!frozen.ok) throw new Error(`draw freeze failed: ${frozen.error.code}`);
  const unlocks: SignedDeckUnlock[] = [];
  for (const { seat } of frozen.value.participants.filter(
    ({ seat: candidateSeat }) => candidateSeat !== request.seat,
  )) {
    const lock = lockAt(fixture, seat, request.position);
    const key = keyAt(fixture, seat);
    unlocks.push(signDeckUnlock(frozen.value, unlocks, lock, bytes(70 + seat), key));
  }
  const completed = completeDeckDraw(frozen.value, unlocks);
  if (!completed.ok) throw new Error(`draw completion failed: ${completed.error.code}`);
  return completed.value;
}

function revealContext(request: DeckDrawRequest) {
  return {
    genesisDigest: request.genesisDigest,
    epoch: request.epoch + 1,
    anchor: { seq: request.anchor.seq + 1, hash: hexHash('b') },
    seat: request.seat,
    nonce: 3,
    command: { type: 'BUY_DEV_CARD', slotId: request.slotId },
  };
}

function errorCode(result: { ok: boolean; error?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

function lockAt(fixture: Fixture, seatIndex: number, position: number): bigint {
  const lock = fixture.lockRows[seatIndex]?.[position];
  if (lock === undefined) throw new Error('fixture lock is missing');
  return lock;
}

function keyAt(fixture: Fixture, seatIndex: number): Uint8Array {
  const key = fixture.keys[seatIndex];
  if (!key) throw new Error('fixture identity key is missing');
  return key;
}

describe('private deck draw', () => {
  test('opens and later reveals a card with the signer roster authorized at its deal', () => {
    const fixture = FIXTURE;
    const frozen = freezeDeckDraw(fixture.setup, fixture.request);
    if (!frozen.ok) throw new Error(frozen.error.code);
    const replacement = identityFromSecret(bytes(99));
    const signers: ArtifactSigner[] = frozen.value.participants
      .filter(({ seat }) => seat !== fixture.request.seat)
      .map(({ seat, publicKey }) => ({
        seat,
        publicKey: seat === 0 ? replacement.peerId : publicKey,
        generation: { seq: seat === 0 ? 10 : 0, hash: hexHash('c') },
      }));
    const unlocks: SignedDeckUnlock[] = [];
    for (const { seat } of signers)
      unlocks.push(
        signDeckUnlock(
          frozen.value,
          unlocks,
          lockAt(fixture, seat, fixture.request.position),
          bytes(80 + seat),
          seat === 0 ? replacement.secretKey : keyAt(fixture, seat),
          signers,
        ),
      );
    replacement.secretKey.fill(0);
    const completed = completeDeckDraw(frozen.value, unlocks, signers);
    if (!completed.ok) throw new Error(completed.error.code);
    const receipt = completed.value;
    const commitment = createDeckGenesisCommitment(fixture.setup.definition, fixture.passes);
    if (!commitment.ok) throw new Error(commitment.error.code);
    const ledgerWithSigners = (unlockSigners: readonly ArtifactSigner[]) => ({
      genesisDigest: fixture.request.genesisDigest,
      active: null,
      decks: [
        {
          commitment: commitment.value,
          setup: fixture.setup,
          nextPass: fixture.passes.length,
          nextPosition: fixture.request.position + 1,
          slots: [
            {
              slotId: fixture.request.slotId,
              seat: fixture.request.seat,
              receipt,
              deal: { seq: 13, hash: hexHash('d') },
              unlockSigners,
            },
          ],
        },
      ],
    });
    expect(validateDeckLedger(ledgerWithSigners(signers)).ok).toBe(true);
    expect(validateDeckLedger(ledgerWithSigners(signers.toReversed())).ok).toBe(false);
    expect(
      validateDeckLedger(
        ledgerWithSigners(
          signers.map((signer) => ({
            ...signer,
            generation: { ...signer.generation, seq: 13 },
          })),
        ),
      ).ok,
    ).toBe(false);
    expect(
      validateDeckLedger(
        ledgerWithSigners(
          signers.map((signer) => ({
            ...signer,
            publicKey: replacement.peerId,
          })),
        ),
      ).ok,
    ).toBe(false);
    const invalidKeys = signers.map((signer, index) =>
      index === 0 ? { ...signer, publicKey: toBase64Url(new Uint8Array(32)) } : signer,
    );
    expect(validateDeckLedger(ledgerWithSigners(invalidKeys))).toMatchObject({
      ok: false,
      error: { code: 'deck-ledger-signer' },
    });
    const lock = lockAt(fixture, fixture.request.seat, fixture.request.position);
    expect(decodeDeckCard(fixture.setup, receipt, lock, invalidKeys)).toMatchObject({
      ok: false,
      error: { code: 'deck-unlock-authority' },
    });
    expect(errorCode(decodeDeckCard(fixture.setup, receipt, lock))).toBe('deck-unlock-signature');
    const decoded = decodeDeckCard(fixture.setup, receipt, lock, signers);
    if (!decoded.ok) throw new Error(decoded.error.code);
    const context = revealContext(fixture.request);
    const reveal = proveDeckReveal(
      fixture.setup,
      receipt,
      decoded.value.identity,
      lock,
      bytes(98),
      context,
      signers,
    );
    expect(verifyDeckReveal(fixture.setup, receipt, reveal, context, signers)).toEqual(decoded);

    // A later replacement cannot rewrite who authorized this already dealt card.
    const laterSigners = signers.map((signer) => ({
      ...signer,
      publicKey: signer.seat === 0 ? identityFromSecret(bytes(100)).peerId : signer.publicKey,
    }));
    expect(errorCode(decodeDeckCard(fixture.setup, receipt, lock, laterSigners))).toBe(
      'deck-unlock-signature',
    );
    expect(verifyDeckReveal(fixture.setup, receipt, reveal, context, laterSigners).ok).toBe(false);
    expect(completeDeckDraw(frozen.value, draw(fixture).unlocks, signers).ok).toBe(false);
    expect(
      decodeDeckCard(
        fixture.setup,
        {
          ...receipt,
          unlocks: receipt.unlocks.map((unlock, index) =>
            index === 0 ? { ...unlock, sig: 'A'.repeat(86) } : unlock,
          ),
        },
        lock,
        signers,
      ).ok,
    ).toBe(false);
  });

  test('reuses an unlock proof during replay while still rejecting a changed signature', () => {
    const frozen = freezeDeckDraw(FIXTURE.setup, {
      ...FIXTURE.request,
      slotId: 'proof-replay-cache',
    });
    if (!frozen.ok) throw new Error(frozen.error.code);
    const unlock = signDeckUnlock(
      frozen.value,
      [],
      lockAt(FIXTURE, 0, FIXTURE.request.position),
      bytes(91),
      keyAt(FIXTURE, 0),
    );
    const verify = vi.spyOn(crypto, 'verifyDleq');
    try {
      expect(verifyDeckUnlockPrefix(frozen.value, [unlock]).ok).toBe(true);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(verifyDeckUnlockPrefix(frozen.value, [structuredClone(unlock)]).ok).toBe(true);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(
        verifyDeckUnlockPrefix(frozen.value, [{ ...unlock, sig: 'A'.repeat(86) }]),
      ).toMatchObject({ ok: false, error: { code: 'deck-unlock-signature' } });
    } finally {
      verify.mockRestore();
    }
  });

  test('unlocks every non-owner in order, keeps identity private, then decodes and proves a public reveal', () => {
    const fixture = FIXTURE;
    const receipts = [0, 1, 2].map((position) => draw(fixture, { ...fixture.request, position }));
    const receipt = receipts[1];
    if (!receipt) throw new Error('missing position-one receipt');
    expect(receipt.operation.position).toBe(1);
    expect(receipt.operation.seat).toBe(2);
    expect(receipt.unlocks.map(({ body }) => body.seat)).toEqual([0, 1]);
    expect(receipt.unlocks[0]?.body.point).toBeTruthy();
    expect(JSON.stringify(receipts)).not.toMatch(
      /knight-a|road-b|point-c|roadBuilding|victoryPoint/,
    );

    for (const position of [0, 1, 2]) {
      const positionedReceipt = receipts[position];
      const lock = lockAt(fixture, 2, position);
      if (!positionedReceipt) throw new Error('missing positioned draw fixture');
      const opened = decodeDeckCard(fixture.setup, positionedReceipt, lock);
      if (!opened.ok) throw new Error('fixture card did not open');
      // Track original positions through the three distinct old→new maps:
      // 0→2→1→0, 1→0→0→2, 2→1→2→1, giving final order [0, 2, 1].
      const originalPosition = [0, 2, 1][position];
      if (originalPosition === undefined) throw new Error('missing expected card position');
      expect(opened.value).toEqual(fixture.setup.definition.cards[originalPosition]);
    }

    const lock = lockAt(fixture, 2, 1);
    const decoded = decodeDeckCard(fixture.setup, receipt, lock);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error('fixture card did not decode');

    const context = revealContext(fixture.request);
    const proof = proveDeckReveal(
      fixture.setup,
      receipt,
      decoded.value.identity,
      lock,
      bytes(91),
      context,
    );
    expect(verifyDeckReveal(fixture.setup, receipt, proof, context)).toEqual({
      ok: true,
      value: decoded.value,
    });
  });

  test('requires the exact unlock prefix and rejects missing, reordered, duplicate, and owner unlocks', () => {
    const fixture = FIXTURE;
    const request = { ...fixture.request, seat: 2 as const };
    const frozen = freezeDeckDraw(fixture.setup, request);
    if (!frozen.ok) throw new Error('fixture freeze failed');
    const unlock1 = signDeckUnlock(
      frozen.value,
      [],
      lockAt(fixture, 0, 1),
      bytes(72),
      keyAt(fixture, 0),
    );
    const unlock2 = signDeckUnlock(
      frozen.value,
      [unlock1],
      lockAt(fixture, 1, 1),
      bytes(73),
      keyAt(fixture, 1),
    );
    const ownerBody = { ...unlock1.body, step: 0, seat: 2 as const };
    const ownerUnlock: SignedDeckUnlock = {
      body: ownerBody,
      sig: signObject('deck-unlock', ownerBody, keyAt(fixture, 2)),
    };

    expect(errorCode(completeDeckDraw(frozen.value, []))).toBe('deck-unlock-incomplete');
    expect(errorCode(completeDeckDraw(frozen.value, [unlock2, unlock1]))).toBe('deck-unlock-order');
    expect(errorCode(completeDeckDraw(frozen.value, [unlock1, unlock1]))).toBe('deck-unlock-order');
    expect(errorCode(completeDeckDraw(frozen.value, [ownerUnlock]))).toBe('deck-unlock-order');
  });

  test('binds unlocks to operation, position, slot, anchor, epoch and genesis', () => {
    const fixture = FIXTURE;
    const receipt = draw(fixture);
    const changedRequests: DeckDrawRequest[] = [
      { ...fixture.request, position: 2 },
      { ...fixture.request, slotId: 'different-slot' },
      { ...fixture.request, anchor: { seq: 13, hash: hexHash('c') } },
      { ...fixture.request, epoch: 5 },
      { ...fixture.request, genesisDigest: toBase64Url(bytes(13)) },
    ];
    for (const request of changedRequests) {
      const frozen = freezeDeckDraw(fixture.setup, request);
      expect(frozen.ok).toBe(true);
      if (!frozen.ok) continue;
      expect(errorCode(completeDeckDraw(frozen.value, receipt.unlocks))).toBe('deck-unlock-order');
    }
  });

  test('rejects wrong unlock point even when the actor signs the modified point', () => {
    const fixture = FIXTURE;
    const frozen = freezeDeckDraw(fixture.setup, fixture.request);
    if (!frozen.ok) throw new Error('fixture freeze failed');
    const original = signDeckUnlock(
      frozen.value,
      [],
      lockAt(fixture, 0, 1),
      bytes(75),
      keyAt(fixture, 0),
    );
    expect(verifyDeckUnlockPrefix(frozen.value, [original]).ok).toBe(true);
    const body = { ...original.body, point: frozen.value.initialPoint };
    const resigned: SignedDeckUnlock = {
      body,
      sig: signObject('deck-unlock', body, keyAt(fixture, 0)),
    };
    expect(errorCode(completeDeckDraw(frozen.value, [resigned]))).toBe('deck-unlock-proof');
  });

  test('a cached unlock proof does not accept an altered response with a fresh signature', () => {
    const receipt = draw(FIXTURE);
    const original = receipt.unlocks[0];
    if (!original) throw new Error('missing unlock');
    expect(verifyDeckUnlockPrefix(receipt.operation, [original]).ok).toBe(true);
    const body = {
      ...original.body,
      proof: { ...original.body.proof, response: toBase64Url(new Uint8Array(32)) },
    };
    expect(body.proof.response).not.toBe(original.body.proof.response);
    const changed = { body, sig: signObject('deck-unlock', body, keyAt(FIXTURE, 0)) };
    expect(errorCode(verifyDeckUnlockPrefix(receipt.operation, [changed]))).toBe(
      'deck-unlock-proof',
    );
    expect(verifyDeckUnlockPrefix(receipt.operation, [original]).ok).toBe(true);
  });

  test('an actor cannot move an existing DLEQ proof to a new operation by re-signing it', () => {
    const receipt = draw(FIXTURE);
    const original = receipt.unlocks[0];
    if (!original) throw new Error('missing unlock');
    const changed = freezeDeckDraw(FIXTURE.setup, { ...FIXTURE.request, slotId: 'another-slot' });
    if (!changed.ok) throw new Error('missing changed operation');
    const valid = signDeckUnlock(
      changed.value,
      [],
      lockAt(FIXTURE, 0, 1),
      bytes(96),
      keyAt(FIXTURE, 0),
    );
    const body = { ...valid.body, proof: original.body.proof };
    const replayed = { body, sig: signObject('deck-unlock', body, keyAt(FIXTURE, 0)) };
    expect(errorCode(completeDeckDraw(changed.value, [replayed]))).toBe('deck-unlock-proof');
  });

  test('decoding and revealing use the validated card table rather than proxy reads', () => {
    const receipt = draw(FIXTURE);
    const lock = lockAt(FIXTURE, 2, 1);
    const actual = decodeDeckCard(FIXTURE.setup, receipt, lock);
    if (!actual.ok) throw new Error('missing fixture card');
    const forgedDefinition = {
      ...FIXTURE.setup.definition,
      cards: FIXTURE.setup.definition.cards.map((card) => ({ ...card, card: 'forged-kind' })),
    };
    const proxy = new Proxy(FIXTURE.setup, {
      get(target, property, receiver) {
        return property === 'definition'
          ? forgedDefinition
          : Reflect.get(target, property, receiver);
      },
    });
    expect(decodeDeckCard(proxy, receipt, lock)).toEqual(actual);
    const context = revealContext(FIXTURE.request);
    const proof = proveDeckReveal(
      FIXTURE.setup,
      receipt,
      actual.value.identity,
      lock,
      bytes(97),
      context,
    );
    expect(verifyDeckReveal(proxy, receipt, proof, context)).toEqual(actual);
  });

  test('rejects a wrong owner lock and a cryptographically false card identity claim', () => {
    const fixture = FIXTURE;
    const receipt = draw(fixture);
    const rightLock = lockAt(fixture, 2, 1);
    const wrongLock = lockAt(fixture, 2, 0);
    expect(errorCode(decodeDeckCard(fixture.setup, receipt, wrongLock))).toBe('deck-owner-lock');

    const context = revealContext(fixture.request);
    const actual = decodeDeckCard(fixture.setup, receipt, rightLock);
    if (!actual.ok) throw new Error('fixture card did not decode');
    const wrongIdentity = fixture.setup.definition.cards.find(
      ({ identity: id }) => id !== actual.value.identity,
    )?.identity;
    if (!wrongIdentity) throw new Error('fixture lacks another card identity');
    const correct = proveDeckReveal(
      fixture.setup,
      receipt,
      actual.value.identity,
      rightLock,
      bytes(93),
      context,
    );
    expect(
      errorCode(
        verifyDeckReveal(fixture.setup, receipt, { ...correct, identity: wrongIdentity }, context),
      ),
    ).toBe('deck-reveal-proof');
    expect(
      errorCode(verifyDeckReveal(fixture.setup, receipt, correct, { ...context, nonce: 4 })),
    ).toBe('deck-reveal-proof');
    expect(
      errorCode(
        verifyDeckReveal(fixture.setup, receipt, correct, {
          ...context,
          command: { type: 'PLAY_DEV_CARD', card: 'roadBuilding' },
        }),
      ),
    ).toBe('deck-reveal-proof');
    expect(
      errorCode(
        verifyDeckReveal(fixture.setup, receipt, correct, {
          ...context,
          anchor: { seq: context.anchor.seq + 1, hash: hexHash('d') },
        }),
      ),
    ).toBe('deck-reveal-proof');
  });

  test('supports the single-owner case without fabricating an unlock', () => {
    const key = bytes(4);
    const identity = identityFromSecret(key);
    const definition = {
      ceremonyId: digest,
      deckId: 'solo-deck',
      deckEpoch: 0,
      creation: { kind: 'ceremony' as const },
      cards: [{ identity: 'solo', card: 'victoryPoint' }],
      participants: [{ seat: 0, publicKey: identity.peerId }],
    };
    identity.secretKey.fill(0);
    const initialized = initDeckSetup(definition);
    if (!initialized.ok) throw new Error('solo fixture init failed');
    const shuffled = signDeckShuffle(initialized.value, 31n, [0], bytes(94), key);
    const afterShuffle = applyDeckPass(initialized.value, shuffled);
    if (!afterShuffle.ok) throw new Error('solo fixture shuffle failed');
    const locked = signDeckLock(afterShuffle.value, 31n, [37n], bytes(95), key);
    const setupResult = applyDeckPass(afterShuffle.value, locked);
    if (!setupResult.ok) throw new Error('solo fixture lock failed');
    const request: DeckDrawRequest = {
      genesisDigest: digest,
      epoch: 0,
      anchor: { seq: 0, hash: hexHash('e') },
      position: 0,
      seat: 0,
      slotId: 'solo-slot',
    };
    const operation = freezeDeckDraw(setupResult.value, request);
    if (!operation.ok) throw new Error('solo fixture draw freeze failed');
    expect(completeDeckDraw(operation.value, [])).toMatchObject({
      ok: true,
      value: { unlocks: [] },
    });
    expect(errorCode(completeDeckDraw(operation.value, [{ invalid: true }]))).toBeDefined();
  });

  test('public parsers are total on hostile values and outputs are detached', () => {
    const fixture = FIXTURE;
    const receipt = draw(fixture);
    expect(
      errorCode(
        completeDeckDraw(
          receipt.operation,
          new Proxy([], {
            get() {
              throw new Error('hostile');
            },
          }),
        ),
      ),
    ).toBeDefined();
    expect(
      errorCode(
        verifyDeckReveal(
          fixture.setup,
          receipt,
          new Proxy(
            {},
            {
              ownKeys() {
                throw new Error('hostile');
              },
            },
          ),
          revealContext(fixture.request),
        ),
      ),
    ).toBeDefined();

    const mutableUnlocks = receipt.unlocks.map((item) => ({ ...item, body: { ...item.body } }));
    const canonical = completeDeckDraw(receipt.operation, mutableUnlocks);
    if (!canonical.ok) throw new Error('fixture contribution did not validate');
    const original = canonical.value.unlocks[0]?.body.point;
    const firstUnlock = mutableUnlocks[0];
    if (!firstUnlock) throw new Error('fixture unlock missing');
    firstUnlock.body.point = receipt.operation.initialPoint;
    expect(canonical.value.unlocks[0]?.body.point).toBe(original);
  });

  test('reserves the draw before returning, then persists and retries the signed unlock', async () => {
    const fixture = FIXTURE;
    const writes = new Map<string, Uint8Array>();
    const store: DeckContributionStore = {
      async load(id) {
        return writes.get(id)?.slice() ?? null;
      },
      async putIfAbsent(id, value) {
        if (writes.has(id)) return false;
        writes.set(id, value.slice());
        return true;
      },
    };
    let sourceCalls = 0;
    const source = {
      lock(position: number) {
        sourceCalls += 1;
        return lockAt(fixture, 0, position);
      },
      proofSeed() {
        sourceCalls += 1;
        return bytes(101);
      },
    };

    const drawer = await prepareDeckUnlock(
      fixture.setup,
      fixture.request,
      [],
      2,
      keyAt(fixture, 2),
      {
        lock() {
          throw new Error('drawer reservation needs no lock');
        },
        proofSeed() {
          throw new Error('drawer reservation needs no seed');
        },
      },
      store,
    );
    expect(drawer).toEqual({ ok: true, value: null });
    expect(writes.size).toBe(1);
    expect(sourceCalls).toBe(0);

    const notNext = await prepareDeckUnlock(
      fixture.setup,
      fixture.request,
      [],
      1,
      keyAt(fixture, 1),
      {
        lock() {
          throw new Error('not-next peer must not access lock');
        },
        proofSeed() {
          throw new Error('not-next peer must not access seed');
        },
      },
      store,
    );
    expect(notNext).toEqual({ ok: true, value: null });
    expect(sourceCalls).toBe(0);

    const first = await prepareDeckUnlock(
      fixture.setup,
      fixture.request,
      [],
      0,
      keyAt(fixture, 0),
      source,
      store,
    );
    expect(first.ok).toBe(true);
    expect(writes.size).toBe(4);
    const callsAfterFirst = sourceCalls;
    const retry = await prepareDeckUnlock(
      fixture.setup,
      fixture.request,
      [],
      0,
      keyAt(fixture, 0),
      {
        lock() {
          throw new Error('retry must not need lock source');
        },
        proofSeed() {
          throw new Error('retry must not need seed source');
        },
      },
      store,
    );
    expect(retry).toEqual(first);
    expect(sourceCalls).toBe(callsAfterFirst);
    if (!retry.ok || !retry.value) throw new Error('persisted contribution missing');
    const operation = freezeDeckDraw(fixture.setup, fixture.request);
    if (!operation.ok) throw new Error('fixture draw could not freeze');
    expect(verifyDeckUnlockPrefix(operation.value, [retry.value]).ok).toBe(true);
  });

  test('per-seat reservations prevent reuse under another request for owner and unlocker', async () => {
    const fixture = FIXTURE;
    const writes = new Map<string, Uint8Array>();
    const store: DeckContributionStore = {
      async load(id) {
        return writes.get(id)?.slice() ?? null;
      },
      async putIfAbsent(id, value) {
        if (writes.has(id)) return false;
        writes.set(id, value.slice());
        return true;
      },
    };
    let sourceCalls = 0;
    const source = {
      lock(position: number) {
        sourceCalls += 1;
        return lockAt(fixture, 0, position);
      },
      proofSeed() {
        sourceCalls += 1;
        return bytes(102);
      },
    };
    const ownerRequest = { ...fixture.request, seat: 0 as const };
    expect(
      await prepareDeckUnlock(fixture.setup, ownerRequest, [], 0, keyAt(fixture, 0), source, store),
    ).toEqual({ ok: true, value: null });
    const beforeOwnerConflict = sourceCalls;
    const changedOwnerRequest = { ...ownerRequest, seat: 2 as const, slotId: 'replacement-slot' };
    expect(
      await prepareDeckUnlock(
        fixture.setup,
        changedOwnerRequest,
        [],
        0,
        keyAt(fixture, 0),
        source,
        store,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'deck-outbox-position' },
    });
    expect(sourceCalls).toBe(beforeOwnerConflict);

    const unlockWrites = new Map<string, Uint8Array>();
    const unlockStore: DeckContributionStore = {
      async load(id) {
        return unlockWrites.get(id)?.slice() ?? null;
      },
      async putIfAbsent(id, value) {
        if (unlockWrites.has(id)) return false;
        unlockWrites.set(id, value.slice());
        return true;
      },
    };
    const unlockRequest = fixture.request;
    const signed = await prepareDeckUnlock(
      fixture.setup,
      unlockRequest,
      [],
      0,
      keyAt(fixture, 0),
      source,
      unlockStore,
    );
    expect(signed.ok && signed.value !== null).toBe(true);
    const beforeUnlockConflict = sourceCalls;
    const changedUnlockRequest = {
      ...unlockRequest,
      anchor: { seq: unlockRequest.anchor.seq + 1, hash: hexHash('f') },
    };
    expect(
      await prepareDeckUnlock(
        fixture.setup,
        changedUnlockRequest,
        [],
        0,
        keyAt(fixture, 0),
        source,
        unlockStore,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'deck-outbox-position' },
    });
    expect(sourceCalls).toBe(beforeUnlockConflict);
  });

  test('reserves the lock secret across two valid locked setups of the same definition', async () => {
    const fixture = FIXTURE;
    const initialized = initDeckSetup(fixture.setup.definition);
    if (!initialized.ok) throw new Error('alternate setup could not initialize');
    let beforeLastLock = initialized.value;
    for (const pass of fixture.passes.slice(0, -1)) {
      const applied = applyDeckPass(beforeLastLock, pass);
      if (!applied.ok) throw new Error('alternate setup prefix could not replay');
      beforeLastLock = applied.value;
    }
    const alternateLastLock = signDeckLock(
      beforeLastLock,
      9n,
      [31n, 37n, 43n],
      bytes(111),
      keyAt(fixture, 2),
    );
    const alternateResult = applyDeckPass(beforeLastLock, alternateLastLock);
    if (!alternateResult.ok) throw new Error('alternate final lock was rejected');
    const alternateSetup = alternateResult.value;
    expect(deckSetupId(alternateSetup.definition)).toBe(deckSetupId(fixture.setup.definition));

    const firstRequest = { ...fixture.request, seat: 0 as const };
    const secondRequest = { ...fixture.request, seat: 2 as const };
    const firstOperation = freezeDeckDraw(fixture.setup, firstRequest);
    const secondOperation = freezeDeckDraw(alternateSetup, secondRequest);
    if (!firstOperation.ok || !secondOperation.ok)
      throw new Error('alternate setup draw could not freeze');
    expect(firstOperation.value.setupHash).not.toBe(secondOperation.value.setupHash);
    expect(firstOperation.value.initialPoint).toBe(secondOperation.value.initialPoint);

    const records = new Map<string, Uint8Array>();
    const store: DeckContributionStore = {
      async load(id) {
        return records.get(id)?.slice() ?? null;
      },
      async putIfAbsent(id, value) {
        if (records.has(id)) return false;
        records.set(id, value.slice());
        return true;
      },
    };
    let sourceCalls = 0;
    const source = {
      lock() {
        sourceCalls += 1;
        return lockAt(fixture, 0, 1);
      },
      proofSeed() {
        sourceCalls += 1;
        return bytes(112);
      },
    };
    expect(
      await prepareDeckUnlock(fixture.setup, firstRequest, [], 0, keyAt(fixture, 0), source, store),
    ).toEqual({ ok: true, value: null });
    const rejected = await prepareDeckUnlock(
      alternateSetup,
      secondRequest,
      [],
      0,
      keyAt(fixture, 0),
      source,
      store,
    );
    expect(rejected).toMatchObject({ ok: false, error: { code: 'deck-outbox-position' } });
    expect(sourceCalls).toBe(0);
  });

  test('checks the supplied signer before writing any reservation', async () => {
    const fixture = FIXTURE;
    const records = new Map<string, Uint8Array>();
    const store: DeckContributionStore = {
      async load(id) {
        return records.get(id)?.slice() ?? null;
      },
      async putIfAbsent(id, value) {
        records.set(id, value.slice());
        return true;
      },
    };
    let sourceCalls = 0;
    const result = await prepareDeckUnlock(
      fixture.setup,
      fixture.request,
      [],
      0,
      keyAt(fixture, 1),
      {
        lock() {
          sourceCalls += 1;
          return 13n;
        },
        proofSeed() {
          sourceCalls += 1;
          return bytes(113);
        },
      },
      store,
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'deck-outbox-key' } });
    expect(records.size).toBe(0);
    expect(sourceCalls).toBe(0);
  });

  test('fails closed on unavailable, corrupt, or conflicting position/unlock records', async () => {
    const fixture = FIXTURE;
    const operation = freezeDeckDraw(fixture.setup, fixture.request);
    if (!operation.ok) throw new Error('fixture draw could not freeze');
    const setupId = deckSetupId(fixture.setup.definition);
    const positionId = `deck-position/${setupId}/${fixture.request.position}/0`;
    const unlockId = `deck-unlock/${setupId}/${fixture.request.position}/0`;
    let sourceCalls = 0;
    const source = {
      lock(position: number) {
        sourceCalls += 1;
        return lockAt(fixture, 0, position);
      },
      proofSeed() {
        sourceCalls += 1;
        return bytes(103);
      },
    };
    const args = [fixture.setup, fixture.request, [], 0, keyAt(fixture, 0), source] as const;
    const missingWinner: DeckContributionStore = {
      async load() {
        return null;
      },
      async putIfAbsent() {
        return false;
      },
    };
    expect(await prepareDeckUnlock(...args, missingWinner)).toMatchObject({
      ok: false,
      error: { code: 'deck-outbox-position' },
    });
    expect(sourceCalls).toBe(0);

    const writeFailure: DeckContributionStore = {
      async load() {
        return null;
      },
      async putIfAbsent() {
        throw new Error('disk failed');
      },
    };
    expect(await prepareDeckUnlock(...args, writeFailure)).toMatchObject({
      ok: false,
      error: { code: 'deck-outbox-write' },
    });
    expect(sourceCalls).toBe(0);

    const corruptPosition: DeckContributionStore = {
      async load(id) {
        return id === positionId ? new Uint8Array([0xff]) : null;
      },
      async putIfAbsent() {
        throw new Error('must not replace corrupt reservation');
      },
    };
    expect(await prepareDeckUnlock(...args, corruptPosition)).toMatchObject({
      ok: false,
      error: { code: 'deck-outbox-position' },
    });
    expect(sourceCalls).toBe(0);

    const corruptUnlock: DeckContributionStore = {
      async load(id) {
        return id === positionId
          ? canonicalEncode(deckDrawOperationId(operation.value))
          : id === unlockId
            ? new Uint8Array([0xff])
            : null;
      },
      async putIfAbsent() {
        throw new Error('existing records should be read only');
      },
    };
    expect(await prepareDeckUnlock(...args, corruptUnlock)).toMatchObject({
      ok: false,
      error: { code: 'deck-outbox-record' },
    });
    expect(sourceCalls).toBe(0);
  });

  test('verifies a competing CAS unlock winner and rejects forged operations before storage or secrets', async () => {
    const fixture = FIXTURE;
    const operation = freezeDeckDraw(fixture.setup, fixture.request);
    if (!operation.ok) throw new Error('fixture draw could not freeze');
    const winner = signDeckUnlock(
      operation.value,
      [],
      lockAt(fixture, 0, 1),
      bytes(104),
      keyAt(fixture, 0),
    );
    const setupId = deckSetupId(fixture.setup.definition);
    const positionId = `deck-position/${setupId}/${fixture.request.position}/0`;
    const unlockId = `deck-unlock/${setupId}/${fixture.request.position}/0`;
    const writes = new Map<string, Uint8Array>([
      [positionId, canonicalEncode(deckDrawOperationId(operation.value))],
    ]);
    let unlockReads = 0;
    const store: DeckContributionStore = {
      async load(id) {
        if (id === unlockId) {
          unlockReads += 1;
          return unlockReads === 1 ? null : canonicalEncode(winner);
        }
        return writes.get(id)?.slice() ?? null;
      },
      async putIfAbsent(id, value) {
        if (id === unlockId) return false;
        if (writes.has(id)) return false;
        writes.set(id, value.slice());
        return true;
      },
    };
    const signingSource = {
      lock: (position: number) => lockAt(fixture, 0, position),
      proofSeed: () => bytes(105),
    };
    const result = await prepareDeckUnlock(
      fixture.setup,
      fixture.request,
      [],
      0,
      keyAt(fixture, 0),
      signingSource,
      store,
    );
    expect(result).toEqual({ ok: true, value: winner });

    const wrongRequest = { ...fixture.request, slotId: 'different-slot' };
    const wrongOperation = freezeDeckDraw(fixture.setup, wrongRequest);
    if (!wrongOperation.ok) throw new Error('wrong-operation draw could not freeze');
    const wrongWinner = signDeckUnlock(
      wrongOperation.value,
      [],
      lockAt(fixture, 0, 1),
      bytes(106),
      keyAt(fixture, 0),
    );
    let wrongUnlockReads = 0;
    const wrongWinnerStore: DeckContributionStore = {
      async load(id) {
        if (id === unlockId) {
          wrongUnlockReads += 1;
          return wrongUnlockReads === 1 ? null : canonicalEncode(wrongWinner);
        }
        return id === positionId ? canonicalEncode(deckDrawOperationId(operation.value)) : null;
      },
      async putIfAbsent(id) {
        return id !== unlockId;
      },
    };
    const wrongWinnerResult = await prepareDeckUnlock(
      fixture.setup,
      fixture.request,
      [],
      0,
      keyAt(fixture, 0),
      signingSource,
      wrongWinnerStore,
    );
    expect(wrongWinnerResult).toMatchObject({
      ok: false,
      error: { code: 'deck-outbox-record' },
    });

    let reads = 0;
    let secrets = 0;
    const unusedStore: DeckContributionStore = {
      async load() {
        reads += 1;
        return null;
      },
      async putIfAbsent() {
        reads += 1;
        return true;
      },
    };
    const countingSource = {
      lock: () => {
        secrets += 1;
        return 1n;
      },
      proofSeed: () => {
        secrets += 1;
        return bytes(105);
      },
    };
    const resultUnknown: unknown = await Reflect.apply(prepareDeckUnlock, undefined, [
      fixture.setup,
      operation.value,
      [],
      0,
      keyAt(fixture, 0),
      countingSource,
      unusedStore,
    ]);
    expect(resultUnknown).toMatchObject({ ok: false });
    expect(reads).toBe(0);
    expect(secrets).toBe(0);
  });
});

const FIXTURE = setupFixture();
