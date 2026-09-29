import { fromBase64Url, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import type { GameState, Result } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { completeDeckDraw, freezeDeckDraw, proveDeckReveal } from './deck-draw.js';
import { createDeckGenesisCommitment, genesisDeckDefinitions } from './deck-genesis.js';
import {
  applyDeckSetupEntry,
  captureDeckPending,
  completeDeckDeal,
  DECK_DRAW_PROTOCOL,
  DECK_REVEAL_PROTOCOL,
  decksReady,
  initializeDeckLedger,
  revealDeckCards,
  validateDeckLedger,
} from './deck-ledger.js';
import type { DeckLedger } from './deck-ledger.js';
import { applyDeckPass, initDeckSetup, signDeckLock, signDeckShuffle } from './deck-setup.js';
import type { DeckDefinition } from './deck-setup.js';
import { genesisDigest } from './genesis.js';
import { createSimulationGenesis } from './testing/simulation-genesis.js';
import type { Genesis, SignedCommand } from './types.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

const bytes = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const digest = toBase64Url(bytes(12));
const anchor = { seq: 11, hash: 'a'.repeat(64) };
const deal = { seq: 12, hash: 'b'.repeat(64) };

function tinyFixture(card: 'knight' | 'victoryPoint' = 'knight') {
  const secret = bytes(1);
  const definition: DeckDefinition = {
    ceremonyId: digest,
    deckId: 'dev',
    deckEpoch: 0,
    creation: { kind: 'ceremony' as const },
    cards: [{ identity: `${card}#1`, card }],
    participants: [{ seat: 0, publicKey: identityFromSecret(secret).peerId }],
  };
  const initial = value(initDeckSetup(definition));
  const shuffle = signDeckShuffle(initial, 2n, [0], bytes(31), secret);
  const afterShuffle = value(applyDeckPass(initial, shuffle));
  const lock = signDeckLock(afterShuffle, 2n, [3n], bytes(32), secret);
  const setup = value(applyDeckPass(afterShuffle, lock));
  const commitment = value(createDeckGenesisCommitment(definition, [shuffle, lock]));
  const ledger: DeckLedger = {
    genesisDigest: digest,
    decks: [{ commitment, setup: initial, nextPass: 0, nextPosition: 0, slots: [] }],
    active: null,
  };
  const simulation = createSimulationGenesis({ seed: 191 });
  const created = simulation.engine.createGame(
    simulation.genesis.config,
    fromBase64Url(simulation.genesis.genesisSeed),
  );
  const state: GameState = { ...created, decks: { dev: { remaining: 1, drawn: [] } } };
  const pending = {
    kind: 'random' as const,
    request: { type: 'draw' as const, deck: 'dev', seat: 0, slotId: 'dev:0', remaining: 1 },
    systemType: 'CARD_DEALT' as const,
  };
  return { card, shuffle, lock, setup, ledger, state, pending };
}

function readyFixture(card: 'knight' | 'victoryPoint' = 'knight') {
  const fixture = tinyFixture(card);
  const once = value(applyDeckSetupEntry(fixture.ledger, { deckId: 'dev', pass: fixture.shuffle }));
  const ready = value(applyDeckSetupEntry(once, { deckId: 'dev', pass: fixture.lock }));
  const captured = value(captureDeckPending(ready, fixture.state, fixture.pending, anchor, 0));
  const dealt = value(
    completeDeckDeal(
      captured,
      fixture.state,
      fixture.pending,
      { kind: 'system', type: 'CARD_DEALT', deck: 'dev', seat: 0, slotId: 'dev:0' },
      { kind: 'proof', protocol: DECK_DRAW_PROTOCOL, data: [] },
      deal,
      [],
    ),
  );
  const afterDeal: GameState = {
    ...fixture.state,
    decks: { dev: { remaining: 0, drawn: [{ slotId: 'dev:0', seat: 0 }] } },
    seats: fixture.state.seats.map((seat) =>
      seat.seat === 0
        ? { ...seat, cardSlots: [{ slotId: 'dev:0', deck: 'dev', acquiredTurn: 1 }] }
        : seat,
    ),
  };
  return { ...fixture, once, ready, captured, dealt, afterDeal };
}

describe('certified deck ledger', () => {
  test('initializes only exact genesis deck keys and full starting counts', () => {
    const simulation = createSimulationGenesis({ seed: 37, humanCount: 2 });
    const body = { ...simulation.genesis, security: 'verified' as const, commitments: {} };
    const definition = value(genesisDeckDefinitions(body))[0];
    if (!definition) throw new Error('missing base deck');
    const fakeCommitment = {
      definition,
      passHashes: Array.from({ length: definition.participants.length * 2 }, (_, i) =>
        (i + 1).toString(16).padStart(64, '0'),
      ),
      finalStateHash: 'f'.repeat(64),
    };
    const genesis: Genesis = {
      ...body,
      commitments: { decks: [fakeCommitment] },
      gameId: simulation.genesis.gameId,
      signatures: simulation.genesis.signatures,
    };
    const state = simulation.engine.createGame(body.config, fromBase64Url(body.genesisSeed));
    const initialized = value(initializeDeckLedger(genesis, state));
    expect(initialized.genesisDigest).toBe(genesisDigest(genesis));
    expect(initialized.decks[0]?.nextPass).toBe(0);
    expect(initializeDeckLedger(genesis, { ...state, decks: {} }).ok).toBe(false);
    expect(
      initializeDeckLedger(genesis, {
        ...state,
        decks: { dev: { remaining: 24, drawn: [] } },
      }).ok,
    ).toBe(false);
  });

  test('folds committed passes in order, freezes one draw, and consumes a certified deal once', () => {
    const fixture = readyFixture();
    expect(decksReady(fixture.ledger)).toBe(false);
    expect(decksReady(fixture.ready)).toBe(true);
    expect(fixture.ready.decks[0]?.setup).toEqual(fixture.setup);
    expect(applyDeckSetupEntry(fixture.ledger, { deckId: 'dev', pass: fixture.lock }).ok).toBe(
      false,
    );
    expect(applyDeckSetupEntry(fixture.once, { deckId: 'dev', pass: fixture.shuffle }).ok).toBe(
      false,
    );
    expect(fixture.captured.active?.anchor).toEqual(anchor);
    expect(captureDeckPending(fixture.captured, fixture.state, fixture.pending, deal, 1)).toEqual({
      ok: true,
      value: fixture.captured,
    });
    expect(fixture.dealt.decks[0]?.nextPosition).toBe(1);
    expect(fixture.dealt.decks[0]?.slots).toHaveLength(1);
    expect(fixture.dealt.active).toBeNull();
    expect(fixture.captured.decks[0]?.nextPosition).toBe(0);
    expect(
      completeDeckDeal(
        fixture.dealt,
        fixture.afterDeal,
        fixture.pending,
        { kind: 'system', type: 'CARD_DEALT', deck: 'dev', seat: 0, slotId: 'dev:0' },
        { kind: 'proof', protocol: DECK_DRAW_PROTOCOL, data: [] },
        deal,
        [],
      ).ok,
    ).toBe(false);
  });

  test('rejects changed draw request, card identity in system input, and malformed unlock envelope', () => {
    const fixture = readyFixture();
    const changed = {
      ...fixture.pending,
      request: { ...fixture.pending.request, slotId: 'dev:1' },
    };
    expect(captureDeckPending(fixture.captured, fixture.state, changed, anchor, 0).ok).toBe(false);
    const input = {
      kind: 'system' as const,
      type: 'CARD_DEALT' as const,
      deck: 'dev',
      seat: 0,
      slotId: 'dev:0',
    };
    expect(
      completeDeckDeal(
        fixture.captured,
        fixture.state,
        fixture.pending,
        { ...input, card: 'knight' },
        { kind: 'proof', protocol: DECK_DRAW_PROTOCOL, data: [] },
        deal,
        [],
      ).ok,
    ).toBe(false);
    expect(
      completeDeckDeal(
        fixture.captured,
        fixture.state,
        fixture.pending,
        input,
        { kind: 'proof', protocol: DECK_DRAW_PROTOCOL, data: [{}] },
        deal,
        [],
      ).ok,
    ).toBe(false);
    expect(
      completeDeckDeal(
        fixture.captured,
        fixture.state,
        fixture.pending,
        input,
        { kind: 'proof', protocol: 'wrong', data: [] },
        deal,
        [],
      ).ok,
    ).toBe(false);
  });

  test('proves owned card kind and consumes only the prospective hidden receipt', () => {
    const fixture = readyFixture();
    const receipt = fixture.dealt.decks[0]?.slots[0]?.receipt;
    if (!receipt) throw new Error('missing receipt');
    const command = { type: 'PLAY_DEV_CARD' as const, slotId: 'dev:0', card: 'knight' as const };
    const proof = proveDeckReveal(fixture.setup, receipt, 'knight#1', 3n, bytes(41), {
      genesisDigest: digest,
      epoch: 0,
      anchor: deal,
      seat: 0,
      nonce: 1,
      command,
    });
    const signed: SignedCommand = {
      body: {
        gameId: 'a'.repeat(22),
        genesisDigest: digest,
        seat: 0,
        nonce: 1,
        headSeq: deal.seq,
        headHash: deal.hash,
        command,
        evidence: { protocol: DECK_REVEAL_PROTOCOL, data: [{ slotId: 'dev:0', ...proof }] },
      },
      sig: toBase64Url(new Uint8Array(64)),
    };
    const reveals = [{ seat: 0 as const, deck: 'dev', slotId: 'dev:0', card: command.card }];
    const revealed = value(revealDeckCards(fixture.dealt, fixture.afterDeal, signed, 0, reveals));
    expect(revealed.decks[0]?.slots).toHaveLength(0);
    expect(fixture.dealt.decks[0]?.slots).toHaveLength(1);
    expect(revealDeckCards(revealed, fixture.afterDeal, signed, 0, reveals).ok).toBe(false);
    expect(
      revealDeckCards(
        fixture.dealt,
        fixture.afterDeal,
        {
          ...signed,
          body: { ...signed.body, command: { ...command, card: 'monopoly' } },
        },
        0,
        [{ ...reveals[0], card: 'monopoly' }],
      ).ok,
    ).toBe(false);
    expect(
      revealDeckCards(
        fixture.dealt,
        fixture.afterDeal,
        {
          ...signed,
          body: { ...signed.body, headSeq: deal.seq - 1 },
        },
        0,
        reveals,
      ).ok,
    ).toBe(false);
    expect(
      revealDeckCards(
        fixture.dealt,
        fixture.afterDeal,
        {
          ...signed,
          body: { ...signed.body, seat: 1 },
        },
        0,
        reveals,
      ).ok,
    ).toBe(false);
    expect(
      revealDeckCards(
        fixture.dealt,
        fixture.afterDeal,
        { ...signed, body: { ...signed.body, genesisDigest: toBase64Url(bytes(99)) } },
        0,
        reveals,
      ).ok,
    ).toBe(false);
  });

  test('victory claim requires an exact ordered proof of a held point card', () => {
    const fixture = readyFixture('victoryPoint');
    const receipt = fixture.dealt.decks[0]?.slots[0]?.receipt;
    if (!receipt) throw new Error('missing receipt');
    const command = { type: 'CLAIM_VICTORY' as const, slotIds: ['dev:0'] };
    const proof = proveDeckReveal(fixture.setup, receipt, 'victoryPoint#1', 3n, bytes(42), {
      genesisDigest: digest,
      epoch: 0,
      anchor: deal,
      seat: 0,
      nonce: 2,
      command,
    });
    const signed: SignedCommand = {
      body: {
        gameId: 'a'.repeat(22),
        genesisDigest: digest,
        seat: 0,
        nonce: 2,
        headSeq: deal.seq,
        headHash: deal.hash,
        command,
        evidence: { protocol: DECK_REVEAL_PROTOCOL, data: [{ slotId: 'dev:0', ...proof }] },
      },
      sig: toBase64Url(new Uint8Array(64)),
    };
    const held = [{ seat: 0 as const, deck: 'dev', slotId: 'dev:0', card: 'victoryPoint' }];
    expect(
      value(revealDeckCards(fixture.dealt, fixture.afterDeal, signed, 0, held)).decks[0]?.slots,
    ).toHaveLength(0);
    expect(
      revealDeckCards(
        fixture.dealt,
        fixture.afterDeal,
        {
          ...signed,
          body: { ...signed.body, command: { ...command, slotIds: ['other'] } },
        },
        0,
        [{ ...held[0], slotId: 'other' }],
      ).ok,
    ).toBe(false);
  });

  test('shape validation is bounded, detached, and not a proof-authority shortcut', () => {
    const fixture = readyFixture();
    const copy = value(validateDeckLedger(fixture.dealt));
    expect(copy).toEqual(fixture.dealt);
    expect(copy).not.toBe(fixture.dealt);
    expect(validateDeckLedger({ ...fixture.dealt, unknown: true }).ok).toBe(false);
    expect(
      validateDeckLedger({
        ...fixture.dealt,
        decks: [
          {
            ...fixture.dealt.decks[0],
            nextPosition: 128,
          },
        ],
      }).ok,
    ).toBe(false);
    expect(validateDeckLedger({ ...fixture.dealt, active: { invalid: true } }).ok).toBe(false);
    const independent = freezeDeckDraw(fixture.setup, {
      genesisDigest: digest,
      epoch: 0,
      anchor,
      position: 0,
      seat: 0,
      slotId: 'dev:0',
    });
    expect(completeDeckDraw(value(independent), []).ok).toBe(true);
    expect(toHex(hashValue(fixture.dealt))).toMatch(/^[0-9a-f]{64}$/);
  });
});
