import { fromBase64Url, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { createHashChain, scalarToBytes } from '@cp2p/crypto';
import { RESOURCES, publicDrawInput, success } from '@cp2p/engine';
import type { CommandShape, Result, Seat, SystemInput } from '@cp2p/engine';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { completeBeaconState, getBeaconOperation } from './beacon-state.js';
import { signBeaconReveal } from './beacon.js';
import { BEACON_EVIDENCE_PROTOCOL } from './crypto-context.js';
import { DeckInbox } from './deck-inbox.js';
import { DECK_DRAW_PROTOCOL } from './deck-ledger.js';
import { decodePublicDeckCard, deckUnlockers, signDeckUnlock } from './deck-draw.js';
import type { SignedDeckUnlock } from './deck-draw.js';
import { createDeckSecretSource } from './deck-source.js';
import {
  GENESIS_PREVIOUS_HASH,
  entryHash,
  genesisBody,
  genesisId,
  signEntry,
  signVerifiedGenesis,
} from './genesis.js';
import { signCommand } from './log.js';
import { advanceContext, proposerFor, validateCertifiedEntry } from './proposal.js';
import type { CertifiedEntry, ProposalContext } from './proposal.js';
import {
  initialProposalContext,
  replayCertifiedPrefix,
  snapshotFromContext,
  verifyReplaySnapshot,
} from './replay.js';
import { createGenesisDeckFixture } from './testing/deck-fixture.js';
import { createSimulationGenesis } from './testing/simulation-genesis.js';
import {
  FOG_CARDS,
  LOOT_CARDS,
  registerSyntheticDecks,
  revealedFog,
  syntheticConfig,
} from './testing/synthetic-decks.js';
import type { EntryBody, Genesis, GenesisBody, LogEntry } from './types.js';
import { signVote } from './votes.js';

function need<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Missing public draw fixture value');
  return value;
}

function checked<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

let dispose = (): void => undefined;
beforeAll(() => {
  dispose = registerSyntheticDecks();
});
afterAll(() => {
  dispose();
});

/** Verified genesis with a single human hosting four seats and the synthetic module's decks. */
function fixture() {
  const source = createSimulationGenesis({
    seed: 317,
    humanCount: 1,
    config: syntheticConfig([0, 1, 2, 3]),
  });
  const humans = source.genesis.seats.filter((seat) => seat.kind === 'human');
  const chains = humans.map((_, index) =>
    createHashChain(new Uint8Array(32).fill(index + 84), 128),
  );
  const initialBody: GenesisBody = {
    ...genesisBody(source.genesis),
    ceremonyNonce: toBase64Url(new Uint8Array(32).fill(0)),
    security: 'verified',
    commitments: {
      beaconChains: humans.map((seat, index) => ({
        seat: seat.seat,
        length: 128,
        tip: toBase64Url(need(need(chains[index])[0])),
      })),
    },
  };
  const deck = createGenesisDeckFixture(initialBody, source.identities);
  const body = deck.body;
  const genesis: Genesis = {
    ...body,
    gameId: genesisId(body),
    signatures: humans.map((seat) =>
      checked(
        signVerifiedGenesis(
          body,
          deck.transcripts,
          seat.seat,
          need(source.identities.get(seat.seat)).secretKey,
        ),
      ),
    ),
  };
  const state = source.engine.createGame(body.config, fromBase64Url(body.genesisSeed));
  const first = need(source.identities.get(0));
  const entry = signEntry(
    {
      seq: 0,
      term: 1,
      prevHash: GENESIS_PREVIOUS_HASH,
      payload: { kind: 'genesis', genesis },
      stateHash: toHex(hashValue(state)),
      sequencer: first.peerId,
    },
    first.secretKey,
  );
  const verifySystem = vi.fn<() => Result<void>>(() => success(undefined));
  const verifyCommand = vi.fn<() => Result<void>>(() => success(undefined));
  const policy = {
    genesis: { verifyCommitments: () => success(undefined) },
    entry: { verifySystem, verifyCommand },
  };
  const initial = checked(initialProposalContext(entry, source.engine, policy));
  return { source, humans, chains, deck, genesis, entry, policy, verifySystem, initial };
}
type Fixture = ReturnType<typeof fixture>;

function signAt(
  data: Fixture,
  context: ProposalContext,
  payload: EntryBody['payload'],
  stateHash = context.log.head.stateHash,
): LogEntry {
  const proposer = proposerFor(
    context.log.head.seq + 1,
    1,
    context.membership,
    context.excludedProposers,
  );
  return signEntry(
    {
      seq: context.log.head.seq + 1,
      term: 1,
      prevHash: entryHash(context.log.head),
      payload,
      stateHash,
      sequencer: proposer.publicKey,
    },
    need(data.source.identities.get(proposer.seat)).secretKey,
  );
}

function certify(data: Fixture, context: ProposalContext, entry: LogEntry): CertifiedEntry {
  return {
    entry,
    certificate: data.humans.map((seat) =>
      signVote(
        {
          genesisDigest: context.membership.genesisDigest,
          epoch: context.membership.epoch,
          seat: seat.seat,
          seq: entry.seq,
          term: entry.term,
          phase: 'precommit',
          valueHash: entryHash(entry),
        },
        need(data.source.identities.get(seat.seat)).secretKey,
      ),
    ),
  };
}

function advance(data: Fixture, context: ProposalContext, entry: LogEntry) {
  const proof = certify(data, context, entry);
  const validated = checked(validateCertifiedEntry(proof, context));
  return { context: checked(advanceContext(context, validated)), proof };
}

function beaconResult(data: Fixture, context: ProposalContext): LogEntry {
  const beacon = need(context.log.crypto).beacon;
  const operation = checked(getBeaconOperation(beacon));
  const reveals = data.humans.map((seat, index) =>
    signBeaconReveal(
      operation,
      seat.seat,
      need(need(data.chains[index])[beacon.round + 1]),
      need(data.source.identities.get(seat.seat)).secretKey,
    ),
  );
  const completed = checked(
    completeBeaconState(beacon, reveals, context.log.state, {
      seq: context.log.head.seq + 1,
      hash: 'c'.repeat(64),
    }),
  );
  if (completed.outcome.kind !== 'system') throw new Error('Expected a public beacon result');
  const input = completed.outcome.input;
  const applied = checked(data.source.engine.apply(context.log.state, input));
  return signAt(
    data,
    context,
    {
      kind: 'system',
      input,
      evidence: { kind: 'proof', protocol: BEACON_EVIDENCE_PROTOCOL, data: reveals },
    },
    toHex(hashValue(applied.state)),
  );
}

function commandEntry(
  data: Fixture,
  context: ProposalContext,
  seat: Seat,
  command: CommandShape,
): LogEntry {
  const signed = signCommand(
    {
      gameId: data.genesis.gameId,
      genesisDigest: context.membership.genesisDigest,
      seat,
      nonce: (context.log.lastNonces.get(seat) ?? 0) + 1,
      headSeq: context.log.head.seq,
      headHash: entryHash(context.log.head),
      command,
    },
    need(data.source.identities.get(seat)).secretKey,
  );
  const applied = checked(
    data.source.engine.apply(context.log.state, { kind: 'command', seat, command }),
  );
  return signAt(data, context, { kind: 'command', signed }, toHex(hashValue(applied.state)));
}

function publicDiscard(context: ProposalContext, seat: Seat): CommandShape {
  const hand = need(context.log.state.seats.find((item) => item.seat === seat)).resources;
  let remaining = Math.floor(hand.total / 2);
  const cards = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
  for (const resource of RESOURCES) {
    cards[resource] = Math.min(hand.min[resource], remaining);
    remaining -= cards[resource];
  }
  if (remaining !== 0) throw new Error('Fixture discard requires an exact public hand');
  return { type: 'DISCARD', cards };
}

function quietRobberMove(
  data: Fixture,
  context: ProposalContext,
  seat: Seat,
  legal: readonly CommandShape[],
): CommandShape | undefined {
  for (const command of legal) {
    if (command.type !== 'MOVE_ROBBER') continue;
    const applied = data.source.engine.apply(context.log.state, { kind: 'command', seat, command });
    if (
      applied.ok &&
      !data.source.engine
        .getPending(applied.value.state)
        .some((pending) => pending.kind === 'player' && pending.allowed.includes('STEAL'))
    )
      return command;
  }
  return undefined;
}

/** Deck setup passes for every module deck, in genesis order. */
function setup(data: Fixture): { context: ProposalContext; history: CertifiedEntry[] } {
  let context = data.initial;
  const history: CertifiedEntry[] = [];
  for (const transcript of data.deck.transcripts) {
    for (const pass of transcript.passes) {
      const next = advance(
        data,
        context,
        signAt(data, context, {
          kind: 'crypto',
          action: 'deck-pass',
          evidence: { deckId: transcript.deckId, pass },
        }),
      );
      context = next.context;
      history.push(next.proof);
    }
  }
  return { context, history };
}

/** Play legal, proof-free commands until the ending turn opens a certified draw. */
function driveToDraw(
  data: Fixture,
  start: ProposalContext,
): { context: ProposalContext; history: CertifiedEntry[] } {
  let context = start;
  const history: CertifiedEntry[] = [];
  for (let step = 0; step < 500; step += 1) {
    if (context.log.crypto?.decks.active) return { context, history };
    const pending = data.source.engine.getPending(context.log.state);
    const random = pending.find((item) => item.kind === 'random');
    if (random?.kind === 'random') {
      if (random.request.type === 'draw') throw new Error('A draw must already be frozen');
      const next = advance(data, context, beaconResult(data, context));
      context = next.context;
      history.push(next.proof);
      continue;
    }
    const player = pending.find((item) => item.kind === 'player');
    if (!player || player.kind !== 'player') throw new Error('No legal player choice');
    const legal = data.source.engine.getLegalCommands(context.log.state, player.seat).commands;
    const choice =
      (player.allowed.includes('DISCARD') ? publicDiscard(context, player.seat) : undefined) ??
      legal.find((item) => item.type === 'ROLL_DICE') ??
      legal.find((item) => item.type === 'END_TURN') ??
      quietRobberMove(data, context, player.seat, legal) ??
      legal[0];
    if (!choice) throw new Error('No legal command on the certified path');
    const next = advance(data, context, commandEntry(data, context, player.seat, choice));
    context = next.context;
    history.push(next.proof);
  }
  throw new Error('No certified draw was reached within 500 inputs');
}

function unlockChain(data: Fixture, context: ProposalContext): SignedDeckUnlock[] {
  const active = need(context.log.crypto?.decks.active);
  const definition = need(
    need(context.log.crypto).decks.decks.find(
      (deck) => deck.commitment.definition.deckId === active.deckId,
    ),
  ).commitment.definition;
  const prefix: SignedDeckUnlock[] = [];
  for (const participant of deckUnlockers(active)) {
    // The fixture's masters are scalarToBytes(17 + seat), as in createGenesisDeckFixture.
    const source = createDeckSecretSource(
      scalarToBytes(BigInt(17 + participant.seat)),
      definition,
      participant.seat,
    );
    try {
      prefix.push(
        signDeckUnlock(
          active,
          prefix,
          source.lock(active.position),
          new Uint8Array(32).fill(71 + participant.seat),
          need(data.source.identities.get(participant.seat)).secretKey,
        ),
      );
    } finally {
      source.dispose();
    }
  }
  return prefix;
}

let shared: Fixture;
let ready: { context: ProposalContext; history: CertifiedEntry[] };
let drawn: { context: ProposalContext; history: CertifiedEntry[] };
beforeAll(() => {
  shared = fixture();
  ready = setup(shared);
  const started = advance(shared, ready.context, beaconResult(shared, ready.context));
  const driven = driveToDraw(shared, started.context);
  drawn = {
    context: driven.context,
    history: [...ready.history, started.proof, ...driven.history],
  };
}, 300_000);

describe('certified public draw', () => {
  test('a module with three decks runs one setup ceremony per deck before play', () => {
    const ledger = need(ready.context.log.crypto).decks;
    expect(ledger.decks.map((deck) => deck.commitment.definition.deckId)).toEqual([
      'dev',
      'fog',
      'loot',
    ]);
    expect(ledger.decks.every((deck) => deck.nextPass === 8)).toBe(true);
    expect(shared.verifySystem).not.toHaveBeenCalled();
  });

  test('ending a turn freezes a public draw whose unlockers include the drawer', () => {
    const active = need(drawn.context.log.crypto?.decks.active);
    expect(active.deckId).toBe('fog');
    expect(active.public).toBe(true);
    expect(active.position).toBe(0);
    expect(deckUnlockers(active).map((item) => item.seat)).toEqual([0, 1, 2, 3]);
  });

  test('a certified reveal is verified from the unlock chain, replays, and cannot be forged', () => {
    const data = shared;
    const context = drawn.context;
    const active = need(context.log.crypto?.decks.active);
    const prefix = unlockChain(data, context);
    expect(prefix.map((unlock) => unlock.body.seat)).toEqual([0, 1, 2, 3]);
    const fog = need(
      need(context.log.crypto).decks.decks.find(
        (deck) => deck.commitment.definition.deckId === 'fog',
      ),
    );
    const point = need(prefix.at(-1)).body.point;
    const card = checked(
      decodePublicDeckCard(fog.setup, { operation: active, point, unlocks: prefix }),
    ).card;
    const pending = need(
      data.source.engine.getPending(context.log.state).find((item) => item.kind === 'random'),
    );
    if (pending.kind !== 'random') throw new Error('Expected the frozen fog request');
    const entryFor = (input: SystemInput, unlocks: readonly SignedDeckUnlock[]): LogEntry => {
      const applied = checked(data.source.engine.apply(context.log.state, input));
      return signAt(
        data,
        context,
        {
          kind: 'system',
          input,
          evidence: { kind: 'proof', protocol: DECK_DRAW_PROTOCOL, data: [...unlocks] },
        },
        toHex(hashValue(applied.state)),
      );
    };
    const prior = snapshotFromContext(context);
    // Wrong identity, missing drawer unlock and the private input type are all refused.
    const other = need(Object.keys(FOG_CARDS).find((item) => item !== card));
    const refusals: [string, LogEntry][] = [
      ['wrong identity', entryFor(publicDrawInput(pending, other), prefix)],
      [
        'missing drawer unlock',
        entryFor(
          publicDrawInput(pending, card),
          prefix.filter((unlock) => unlock.body.seat !== active.seat),
        ),
      ],
      ['missing final unlock', entryFor(publicDrawInput(pending, card), prefix.slice(0, 3))],
    ];
    for (const [, entry] of refusals)
      expect(validateCertifiedEntry(certify(data, context, entry), context).ok).toBe(false);
    expect(snapshotFromContext(context)).toEqual(prior);

    const accepted = advance(data, context, entryFor(publicDrawInput(pending, card), prefix));
    expect(data.verifySystem).not.toHaveBeenCalled();
    const after = accepted.context.log;
    expect(revealedFog(after.state)).toEqual([card]);
    const ledger = need(after.crypto).decks;
    expect(ledger.active?.deckId).toBe('loot');
    const fogAfter = need(ledger.decks.find((deck) => deck.commitment.definition.deckId === 'fog'));
    expect(fogAfter.nextPosition).toBe(1);
    expect(fogAfter.slots).toHaveLength(0);
    // A fresh replica replays the certified history to the identical state and ledger.
    const replayed = checked(
      replayCertifiedPrefix(
        data.entry,
        [...drawn.history, accepted.proof],
        data.source.engine,
        data.policy,
      ),
    );
    expect(snapshotFromContext(replayed.context)).toEqual(snapshotFromContext(accepted.context));
    expect(verifyReplaySnapshot(snapshotFromContext(accepted.context), replayed.context).ok).toBe(
      true,
    );
    expect(need(replayed.context.log.crypto).decks.active?.deckId).toBe('loot');
  }, 120_000);

  test('the delivery inbox builds the certified public input itself', () => {
    const data = shared;
    const context = drawn.context;
    const inbox = new DeckInbox();
    checked(inbox.refresh(context.log.crypto, context.log.genesis, context.log.authority));
    const prefix = unlockChain(data, context);
    expect(inbox.candidate(context.log)).toEqual({ ok: true, value: null });
    for (let length = 1; length <= prefix.length; length += 1)
      checked(
        inbox.remember({
          kind: 'deck-unlock',
          operationId: need(inbox.operationId()),
          unlocks: prefix.slice(0, length),
        }),
      );
    const candidate = checked(inbox.candidate(context.log));
    if (candidate?.kind !== 'system') throw new Error('Expected a public deal candidate');
    expect(candidate.input).toMatchObject({ type: 'FOG_REVEALED', deck: 'fog', edge: 'north' });
    expect(Object.hasOwn(FOG_CARDS, String(candidate.input.card))).toBe(true);
    const applied = checked(data.source.engine.apply(context.log.state, candidate.input));
    const entry = signAt(data, context, candidate, toHex(hashValue(applied.state)));
    expect(validateCertifiedEntry(certify(data, context, entry), context).ok).toBe(true);
  }, 120_000);

  test('the private loot deck deals through CARD_DEALT after the public reveal', () => {
    const data = shared;
    const context = drawn.context;
    const prefix = unlockChain(data, context);
    const active = need(context.log.crypto?.decks.active);
    const fog = need(
      need(context.log.crypto).decks.decks.find(
        (deck) => deck.commitment.definition.deckId === 'fog',
      ),
    );
    const card = checked(
      decodePublicDeckCard(fog.setup, {
        operation: active,
        point: need(prefix.at(-1)).body.point,
        unlocks: prefix,
      }),
    ).card;
    const pending = need(
      data.source.engine.getPending(context.log.state).find((item) => item.kind === 'random'),
    );
    if (pending.kind !== 'random') throw new Error('Expected the frozen fog request');
    const revealInput = publicDrawInput(pending, card);
    const revealed = advance(
      data,
      context,
      signAt(
        data,
        context,
        {
          kind: 'system',
          input: revealInput,
          evidence: { kind: 'proof', protocol: DECK_DRAW_PROTOCOL, data: prefix },
        },
        toHex(hashValue(checked(data.source.engine.apply(context.log.state, revealInput)).state)),
      ),
    );
    const loot = need(revealed.context.log.crypto?.decks.active);
    expect(loot.deckId).toBe('loot');
    expect(loot.public).toBeUndefined();
    expect(deckUnlockers(loot).map((item) => item.seat)).toEqual(
      [0, 1, 2, 3].filter((seat) => seat !== loot.seat),
    );
    const lootPrefix = unlockChain(data, revealed.context);
    const dealt: SystemInput = {
      kind: 'system',
      type: 'CARD_DEALT',
      deck: 'loot',
      seat: loot.seat,
      slotId: loot.slotId,
    };
    const applied = checked(data.source.engine.apply(revealed.context.log.state, dealt));
    const next = advance(
      data,
      revealed.context,
      signAt(
        data,
        revealed.context,
        {
          kind: 'system',
          input: dealt,
          evidence: { kind: 'proof', protocol: DECK_DRAW_PROTOCOL, data: lootPrefix },
        },
        toHex(hashValue(applied.state)),
      ),
    );
    const lootDeck = need(
      need(next.context.log.crypto).decks.decks.find(
        (deck) => deck.commitment.definition.deckId === 'loot',
      ),
    );
    expect(lootDeck.slots.map((slot) => slot.slotId)).toEqual([loot.slotId]);
    expect(need(next.context.log.crypto).decks.active).toBeNull();
    expect(Object.keys(LOOT_CARDS).length).toBeGreaterThan(0);
    // The flow left the turn-end marker: the next seat's turn has begun.
    expect(next.context.log.state.turn.number).toBe(revealed.context.log.state.turn.number + 1);
  }, 120_000);
});
