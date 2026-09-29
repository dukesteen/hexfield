import { fromBase64Url } from '@cp2p/codec';
import { encodeScalar, signObject } from '@cp2p/crypto';
import { publicDrawInput } from '@cp2p/engine';
import type { GameState, Pending, Result, Seat, SystemInput } from '@cp2p/engine';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { resolveArtifactSigner } from './authority.js';
import {
  completeDeckDraw,
  decodeDeckCard,
  decodePublicDeckCard,
  deckUnlockers,
  verifyDeckUnlockPrefix,
} from './deck-draw.js';
import type { DealtDeckCard, DeckDrawOperation, SignedDeckUnlock } from './deck-draw.js';
import { createDeckGenesisCommitment, genesisDeckDefinitions } from './deck-genesis.js';
import {
  DECK_DRAW_PROTOCOL,
  applyDeckSetupEntry,
  captureDeckPending,
  completeDeckDeal,
  initializeDeckLedger,
} from './deck-ledger.js';
import type { DeckLedger } from './deck-ledger.js';
import { prepareDeckUnlock } from './deck-outbox.js';
import type { DeckContributionStore } from './deck-outbox.js';
import { createDeckSecretSource } from './deck-source.js';
import type { DeckDefinition } from './deck-setup.js';
import { createDeckPasses } from './testing/deck-fixture.js';
import { createSimulationGenesis } from './testing/simulation-genesis.js';
import {
  FOG_CARDS,
  LOOT_CARDS,
  registerSyntheticDecks,
  revealedFog,
  syntheticConfig,
} from './testing/synthetic-decks.js';
import type { Genesis } from './types.js';
import { scalarToBytes } from '@cp2p/crypto';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function need<T>(item: T | undefined | null): T {
  if (item === undefined || item === null) throw new Error('Missing fixture value');
  return item;
}

const SEATS: readonly Seat[] = [0, 1, 2];
const masterA = (seat: Seat): Uint8Array => scalarToBytes(BigInt(17 + seat));
const masterB = (seat: Seat): Uint8Array => scalarToBytes(BigInt(1_017 + seat * 3));

class MemoryStore implements DeckContributionStore {
  readonly records = new Map<string, Uint8Array>();
  load(id: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.records.get(id) ?? null);
  }
  putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    if (this.records.has(id)) return Promise.resolve(false);
    this.records.set(id, bytes.slice());
    return Promise.resolve(true);
  }
}

let dispose = (): void => undefined;
beforeAll(() => {
  dispose = registerSyntheticDecks();
});
afterAll(() => {
  dispose();
});

/** Three seats run the real deck ceremony for every module deck; `master` is their secret. */
function openSession(master: (seat: Seat) => Uint8Array) {
  const sim = createSimulationGenesis({ seed: 51, config: syntheticConfig(SEATS), humanCount: 3 });
  const definitions = value(genesisDeckDefinitions(sim.genesis));
  const passes = new Map(
    definitions.map((definition) => [
      definition.deckId,
      createDeckPasses(definition, sim.identities, master),
    ]),
  );
  const commitments = definitions.map((definition) =>
    value(createDeckGenesisCommitment(definition, need(passes.get(definition.deckId)))),
  );
  const genesis: Genesis = {
    ...sim.genesis,
    security: 'verified',
    commitments: { decks: commitments },
  };
  const state = sim.engine.createGame(genesis.config, fromBase64Url(genesis.genesisSeed));
  let ledger = value(initializeDeckLedger(genesis, state));
  for (const definition of definitions)
    for (const pass of need(passes.get(definition.deckId)))
      ledger = value(applyDeckSetupEntry(ledger, { deckId: definition.deckId, pass }));
  const signers = SEATS.map((seat) => value(resolveArtifactSigner(undefined, genesis, 0, seat)));
  return { sim, genesis, definitions, state, ledger, signers, master };
}
type Session = ReturnType<typeof openSession>;

const yieldTask = () => new Promise<void>((resolve) => setImmediate(resolve));

function withFrame(state: GameState, frame: GameState['turn']['phase'][number]): GameState {
  return { ...state, turn: { ...state.turn, phase: [...state.turn.phase, frame] } };
}

function randomPending(session: Session, state: GameState): Extract<Pending, { kind: 'random' }> {
  const found = session.sim.engine.getPending(state).find((item) => item.kind === 'random');
  if (found?.kind !== 'random') throw new Error('Expected a random pending');
  return found;
}

/** Every unlocking seat signs in order, each verifying the prefix before it. */
async function unlockAll(
  session: Session,
  operation: DeckDrawOperation,
): Promise<SignedDeckUnlock[]> {
  const definition = need(session.definitions.find((item) => item.deckId === operation.deckId));
  const setup = need(
    session.ledger.decks.find((deck) => deck.commitment.definition.deckId === definition.deckId),
  ).setup;
  const request = {
    genesisDigest: operation.genesisDigest,
    epoch: operation.epoch,
    anchor: operation.anchor,
    position: operation.position,
    seat: operation.seat,
    slotId: operation.slotId,
    ...(operation.public ? { public: true as const } : {}),
  };
  const store = new MemoryStore();
  const prefix: SignedDeckUnlock[] = [];
  for (const participant of operation.participants) {
    const source = createDeckSecretSource(
      session.master(participant.seat),
      definition,
      participant.seat,
    );
    try {
      const prepared = value(
        // oxlint-disable-next-line no-await-in-loop -- Each unlock consumes the verified prefix.
        await prepareDeckUnlock(
          setup,
          request,
          prefix,
          participant.seat,
          need(session.sim.identities.get(participant.seat)).secretKey,
          source,
          store,
        ),
      );
      if (prepared) prefix.push(prepared);
    } finally {
      source.dispose();
    }
  }
  return prefix;
}

interface PublicDraw {
  card: string;
  input: SystemInput;
  unlocks: SignedDeckUnlock[];
  operation: DeckDrawOperation;
  state: GameState;
  ledger: DeckLedger;
  pending: Extract<Pending, { kind: 'random' }>;
  before: GameState;
  beforeLedger: DeckLedger;
}

/** One certified public fog reveal: capture, all unlocks, decode, verify, apply. */
async function publicDraw(session: Session, drawer: Seat, index: number): Promise<PublicDraw> {
  const before = withFrame(session.state, {
    id: 'drawFog',
    module: 'synthetic-decks',
    data: { seat: drawer, slotId: `fog:${index}` },
  });
  const pending = randomPending(session, before);
  const anchor = { seq: 100 + index, hash: 'a'.repeat(64) };
  const captured = value(captureDeckPending(session.ledger, before, pending, anchor, 0));
  const operation = need(captured.active);
  const unlocks = await unlockAll({ ...session, ledger: captured }, operation);
  const fog = need(captured.decks.find((deck) => deck.commitment.definition.deckId === 'fog'));
  const receipt: DealtDeckCard = {
    operation,
    point: need(unlocks.at(-1)).body.point,
    unlocks,
  };
  const card = value(decodePublicDeckCard(fog.setup, receipt, session.signers)).card;
  const input = publicDrawInput(pending, card);
  const ledger = value(
    completeDeckDeal(
      captured,
      before,
      pending,
      input,
      { kind: 'proof', protocol: DECK_DRAW_PROTOCOL, data: unlocks },
      { seq: 101 + index, hash: 'b'.repeat(64) },
      session.signers,
    ),
  );
  const applied = value(session.sim.engine.apply(before, input));
  return {
    card,
    input,
    unlocks,
    operation,
    state: applied.state,
    ledger,
    pending,
    before,
    beforeLedger: captured,
  };
}

describe('public deck draws', () => {
  test('genesis declares every module deck in ascending id order', () => {
    const session = openSession(masterA);
    expect(session.definitions.map((definition: DeckDefinition) => definition.deckId)).toEqual([
      'dev',
      'fog',
      'loot',
    ]);
    expect(need(session.definitions[1]).cards).toHaveLength(6);
    expect(need(session.definitions[2]).cards).toHaveLength(3);
    expect(session.ledger.decks.map((deck) => deck.nextPosition)).toEqual([0, 0, 0]);
  }, 120_000);

  test('every seat, the drawer included, unlocks a public draw and each peer verifies the reveal', async () => {
    const session = openSession(masterA);
    const drawer: Seat = 1;
    const drawn = await publicDraw(session, drawer, 0);
    expect(drawn.operation.public).toBe(true);
    expect(deckUnlockers(drawn.operation).map((item) => item.seat)).toEqual([0, 1, 2]);
    expect(drawn.unlocks.map((unlock) => unlock.body.seat)).toEqual([0, 1, 2]);
    expect(Object.hasOwn(FOG_CARDS, drawn.card)).toBe(true);
    expect(drawn.input).toMatchObject({
      type: 'FOG_REVEALED',
      deck: 'fog',
      seat: 1,
      card: drawn.card,
    });
    // A hidden slot is never retained for a public card, but the cursor advanced exactly once.
    const fog = need(
      drawn.ledger.decks.find((deck) => deck.commitment.definition.deckId === 'fog'),
    );
    expect(fog.nextPosition).toBe(1);
    expect(fog.slots).toHaveLength(0);
    expect(drawn.ledger.active).toBeNull();
    expect(revealedFog(drawn.state)).toEqual([drawn.card]);
    expect(drawn.state.decks.fog).toEqual({
      remaining: 5,
      drawn: [{ slotId: 'fog:0', seat: 1 }],
    });
    // An observer holding only public data reaches the same identity from the unlock chain.
    expect(
      decodePublicDeckCard(
        fog.setup,
        {
          operation: drawn.operation,
          point: need(drawn.unlocks.at(-1)).body.point,
          unlocks: drawn.unlocks,
        },
        session.signers,
      ),
    ).toMatchObject({ ok: true, value: { card: drawn.card } });
  }, 120_000);

  test('the whole public deck is revealed once each, across changing drawers', async () => {
    let session = openSession(masterA);
    const cards: string[] = [];
    for (let index = 0; index < 6; index++) {
      // oxlint-disable-next-line no-await-in-loop -- Each reveal follows the certified previous one.
      const drawn = await publicDraw(session, need(SEATS[index % SEATS.length]), index);
      cards.push(drawn.card);
      session = { ...session, state: drawn.state, ledger: drawn.ledger };
    }
    expect([...cards].toSorted()).toEqual(Object.keys(FOG_CARDS));
    expect(revealedFog(session.state)).toEqual(cards);
    expect(session.state.decks.fog).toMatchObject({ remaining: 0 });
  }, 240_000);

  test('a private draw of a non-dev module deck keeps the CARD_DEALT path', async () => {
    const session = openSession(masterA);
    const owner: Seat = 2;
    const before = withFrame(session.state, {
      id: 'drawDev',
      module: 'base',
      data: { seat: owner, slotId: 'loot:0', deck: 'loot' },
    });
    const pending = randomPending(session, before);
    const captured = value(
      captureDeckPending(session.ledger, before, pending, { seq: 100, hash: 'a'.repeat(64) }, 0),
    );
    const operation = need(captured.active);
    expect(operation.public).toBeUndefined();
    expect(operation.deckId).toBe('loot');
    expect(deckUnlockers(operation).map((item) => item.seat)).toEqual([0, 1]);
    const unlocks = await unlockAll({ ...session, ledger: captured }, operation);
    const input: SystemInput = {
      kind: 'system',
      type: 'CARD_DEALT',
      deck: 'loot',
      seat: owner,
      slotId: 'loot:0',
    };
    const ledger = value(
      completeDeckDeal(
        captured,
        before,
        pending,
        input,
        { kind: 'proof', protocol: DECK_DRAW_PROTOCOL, data: unlocks },
        { seq: 101, hash: 'b'.repeat(64) },
        [need(session.signers[0]), need(session.signers[1])],
      ),
    );
    const loot = need(ledger.decks.find((deck) => deck.commitment.definition.deckId === 'loot'));
    const slot = need(loot.slots[0]);
    const definition = need(session.definitions.find((item) => item.deckId === 'loot'));
    const source = createDeckSecretSource(masterA(owner), definition, owner);
    const decoded = value(
      decodeDeckCard(loot.setup, slot.receipt, source.lock(operation.position), slot.unlockSigners),
    );
    source.dispose();
    expect(Object.hasOwn(LOOT_CARDS, decoded.card)).toBe(true);
    // Only the owner learns the card: the public input carries none, and other seats' private
    // state stays untouched.
    expect(input).not.toHaveProperty('card');
    const engine = session.sim.engine;
    const applied = value(engine.apply(before, input));
    const ownerPrivate = value(
      engine.applyPrivate(engine.createPrivateState(owner, session.genesis.config), before, input, {
        card: decoded.card,
      }),
    );
    expect(ownerPrivate.slots).toEqual({ 'loot:0': decoded.card });
    expect(applied.state.decks.loot).toEqual({
      remaining: 2,
      drawn: [{ slotId: 'loot:0', seat: owner }],
    });
  }, 120_000);

  test('a tampered unlock, an omitted drawer unlock or a wrong identity is rejected', async () => {
    const session = openSession(masterA);
    const drawn = await publicDraw(session, 1, 0);
    const { operation, unlocks, beforeLedger, before, pending } = drawn;
    const complete = (evidence: unknown) => completeDeckDraw(operation, evidence, session.signers);
    expect(complete(unlocks).ok).toBe(true);
    // A forged partial unlock breaks its signature; re-signed, it breaks the DLEQ proof.
    const middle = need(unlocks[1]);
    const moved = { ...middle.body, point: need(unlocks[2]).body.point };
    expect(complete(unlocks.with(1, { body: moved, sig: middle.sig }))).toMatchObject({
      ok: false,
      error: { code: 'deck-unlock-signature' },
    });
    const badProof = {
      ...middle.body,
      proof: { ...middle.body.proof, response: encodeScalar(0n) },
    };
    const resigned = {
      body: badProof,
      sig: signObject('deck-unlock', badProof, need(session.sim.identities.get(1)).secretKey),
    };
    expect(complete(unlocks.with(1, resigned))).toMatchObject({
      ok: false,
      error: { code: 'deck-unlock-proof' },
    });
    // The drawer is a required unlocker: a private-style chain without it is not a reveal.
    expect(complete(unlocks.filter((unlock) => unlock.body.seat !== 1))).toMatchObject({
      ok: false,
      error: { code: 'deck-unlock-order' },
    });
    expect(complete(unlocks.slice(0, 2))).toMatchObject({
      ok: false,
      error: { code: 'deck-unlock-incomplete' },
    });
    expect(verifyDeckUnlockPrefix(operation, unlocks, session.signers).ok).toBe(true);
    // The certified input must name exactly the card the chain opens, and echo the request.
    const evidence = { kind: 'proof' as const, protocol: DECK_DRAW_PROTOCOL, data: unlocks };
    const deal = { seq: 101, hash: 'b'.repeat(64) };
    const wrong = Object.keys(FOG_CARDS).find((card) => card !== drawn.card);
    const tries: SystemInput[] = [
      publicDrawInput(pending, need(wrong)),
      { ...drawn.input, seat: 2 },
      { ...drawn.input, edge: 'south' },
      { kind: 'system', type: 'CARD_DEALT', deck: 'fog', seat: 1, slotId: 'fog:0' },
    ];
    for (const input of tries)
      expect(
        completeDeckDeal(beforeLedger, before, pending, input, evidence, deal, session.signers).ok,
      ).toBe(false);
    expect(
      completeDeckDeal(
        beforeLedger,
        before,
        pending,
        drawn.input,
        { ...evidence, data: unlocks.slice(0, 2) },
        deal,
        session.signers,
      ).ok,
    ).toBe(false);
  }, 120_000);

  test('a draw must use the reveal mode its deck declares', async () => {
    const session = openSession(masterA);
    const anchor = { seq: 100, hash: 'a'.repeat(64) };
    const fogFrame = withFrame(session.state, {
      id: 'drawFog',
      module: 'synthetic-decks',
      data: { seat: 1, slotId: 'fog:0' },
    });
    const fog = randomPending(session, fogFrame);
    const privateFog: Pending = {
      kind: 'random',
      systemType: 'CARD_DEALT',
      request: { type: 'draw', deck: 'fog', seat: 1, slotId: 'fog:0', remaining: 6 },
    };
    expect(captureDeckPending(session.ledger, fogFrame, privateFog, anchor, 0)).toMatchObject({
      ok: false,
      error: { code: 'deck-reveal-mode' },
    });
    const lootFrame = withFrame(session.state, {
      id: 'drawDev',
      module: 'base',
      data: { seat: 2, slotId: 'loot:0', deck: 'loot' },
    });
    const loot = randomPending(session, lootFrame);
    const publicLoot = {
      kind: 'random' as const,
      systemType: 'LOOT_SHOWN',
      request: { ...loot.request, public: true },
    };
    expect(captureDeckPending(session.ledger, lootFrame, publicLoot, anchor, 0)).toMatchObject({
      ok: false,
      error: { code: 'deck-reveal-mode' },
    });
    // A public request may not borrow the private system input either.
    const disguised = { ...fog, systemType: 'CARD_DEALT' };
    expect(captureDeckPending(session.ledger, fogFrame, disguised, anchor, 0).ok).toBe(false);
    // Public decoding is only for public operations.
    const drawn = await publicDraw(session, 0, 0);
    const privateOperation = { ...drawn.operation };
    Reflect.deleteProperty(privateOperation, 'public');
    const fogDeck = need(
      drawn.ledger.decks.find((deck) => deck.commitment.definition.deckId === 'fog'),
    );
    expect(
      decodePublicDeckCard(
        fogDeck.setup,
        {
          operation: privateOperation,
          point: need(drawn.unlocks.at(-1)).body.point,
          unlocks: drawn.unlocks,
        },
        session.signers,
      ),
    ).toMatchObject({ ok: false, error: { code: 'deck-public-mode' } });
  }, 120_000);

  test('same genesis seed but different deck secrets reveal a different fog order', async () => {
    const order = async (opened: Session): Promise<string[]> => {
      let session = opened;
      const cards: string[] = [];
      for (let index = 0; index < 6; index++) {
        // oxlint-disable-next-line no-await-in-loop -- Each reveal follows the certified previous one.
        const drawn = await publicDraw(session, need(SEATS[index % SEATS.length]), index);
        cards.push(drawn.card);
        session = { ...session, state: drawn.state, ledger: drawn.ledger };
      }
      return cards;
    };
    const first = openSession(masterA);
    const second = openSession(masterB);
    // Identical genesis: same signed seed, same board, same ceremony id.
    expect(first.genesis.genesisSeed).toBe(second.genesis.genesisSeed);
    expect(first.state.board).toEqual(second.state.board);
    expect(need(first.definitions[1]).ceremonyId).toBe(need(second.definitions[1]).ceremonyId);
    // Opening a session shuffles every deck synchronously; a macrotask between the openings keeps
    // the test worker responsive.
    const a = await order(first);
    await yieldTask();
    const b = await order(second);
    await yieldTask();
    const again = await order(openSession(masterA));
    expect([...a].toSorted()).toEqual(Object.keys(FOG_CARDS));
    expect([...b].toSorted()).toEqual(Object.keys(FOG_CARDS));
    expect(a).not.toEqual(b);
    // The secrets alone decide the order: replaying them reproduces it.
    expect(again).toEqual(a);
  }, 480_000);
});
