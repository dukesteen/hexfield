import { fromBase64Url, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { createHashChain, pedersenCommit } from '@cp2p/crypto';
import { RESOURCES, createResourceBounds, success } from '@cp2p/engine';
import type { CommandShape, Result, Seat, SystemInput } from '@cp2p/engine';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { completeBeaconState, getBeaconOperation } from './beacon-state.js';
import { signBeaconReveal } from './beacon.js';
import { BEACON_EVIDENCE_PROTOCOL, validateCryptoTransition } from './crypto-context.js';
import { validateObjectiveAccusation } from './control.js';
import {
  MemoryBeaconContributionStore,
  prepareBeaconContribution,
} from './beacon-contributions.js';
import { BeaconInbox } from './beacon-inbox.js';
import { DECK_DRAW_PROTOCOL, DECK_REVEAL_PROTOCOL } from './deck-ledger.js';
import { COMMAND_PROOFS_PROTOCOL } from './command-proofs.js';
import { planHandTransition } from './hand-transition.js';
import { decodeDeckCard, proveDeckReveal, signDeckUnlock } from './deck-draw.js';
import {
  GENESIS_PREVIOUS_HASH,
  entryBody,
  entryHash,
  genesisBody,
  genesisId,
  signEntry,
  signVerifiedGenesis,
} from './genesis.js';
import { signCommand, validateCommandForEntry, validateNextEntry } from './log.js';
import { advanceContext, proposerFor, signProposal, validateCertifiedEntry } from './proposal.js';
import type { CertifiedEntry, ProposalContext } from './proposal.js';
import { encodeProtocolMessage } from './messages.js';
import {
  initialProposalContext,
  replayCertifiedPrefix,
  snapshotFromContext,
  verifyReplaySnapshot,
} from './replay.js';
import { createGenesisDeckFixture } from './testing/deck-fixture.js';
import { createSimulationGenesis } from './testing/simulation-genesis.js';
import type { CommandBody, EntryBody, Genesis, GenesisBody, LogEntry } from './types.js';
import { MAX_MESSAGE_BYTES } from './validation.js';
import { signVote } from './votes.js';
import { VerifiedSessionDriver } from './verified-session-driver.js';

function need<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Missing deck log fixture value');
  return value;
}

function checked<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function fixture() {
  const source = createSimulationGenesis({ seed: 317, humanCount: 1 });
  const humans = source.genesis.seats.filter((seat) => seat.kind === 'human');
  const chains = humans.map((_, index) =>
    createHashChain(new Uint8Array(32).fill(index + 84), 128),
  );
  const initialBody: GenesisBody = {
    ...genesisBody(source.genesis),
    // Keep the original board while selecting a Knight-first ceremony permutation.
    ceremonyNonce: toBase64Url(new Uint8Array(32).fill(1)),
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
  // These permissive callbacks stand in only for unrelated game-specific policy.
  // Deck setup, dealing, and hidden-card reveal must be checked before they run.
  const verifySystem = vi.fn<() => Result<void>>(() => success(undefined));
  const verifyCommand = vi.fn<() => Result<void>>(() => success(undefined));
  const policy = {
    genesis: { verifyCommitments: () => success(undefined) },
    entry: { verifySystem, verifyCommand },
  };
  const initial = checked(initialProposalContext(entry, source.engine, policy));
  return {
    source,
    humans,
    chains,
    deck,
    genesis,
    entry,
    policy,
    verifySystem,
    verifyCommand,
    initial,
  };
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
  const key = need(data.source.identities.get(proposer.seat)).secretKey;
  return signEntry(
    {
      seq: context.log.head.seq + 1,
      term: 1,
      prevHash: entryHash(context.log.head),
      payload,
      stateHash,
      sequencer: proposer.publicKey,
    },
    key,
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

function advance(
  data: Fixture,
  context: ProposalContext,
  entry: LogEntry,
): { context: ProposalContext; proof: CertifiedEntry } {
  const proof = certify(data, context, entry);
  const validated = checked(validateCertifiedEntry(proof, context));
  return { context: checked(advanceContext(context, validated)), proof };
}

function setup(data: Fixture): { context: ProposalContext; history: CertifiedEntry[] } {
  let context = data.initial;
  const history: CertifiedEntry[] = [];
  for (const transcript of data.deck.transcripts) {
    for (const pass of transcript.passes) {
      const entry = signAt(data, context, {
        kind: 'crypto',
        action: 'deck-pass',
        evidence: { deckId: transcript.deckId, pass },
      });
      const next = advance(data, context, entry);
      context = next.context;
      history.push(next.proof);
    }
  }
  return { context, history };
}

function beaconResult(data: Fixture, context: ProposalContext, chainIndex: number): LogEntry {
  const beacon = need(context.log.crypto).beacon;
  const operation = checked(getBeaconOperation(beacon));
  const reveals = data.humans.map((seat, index) =>
    signBeaconReveal(
      operation,
      seat.seat,
      need(need(data.chains[index])[chainIndex]),
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
  evidence?: CommandBody['evidence'],
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
      ...(evidence === undefined ? {} : { evidence }),
    },
    need(data.source.identities.get(seat)).secretKey,
  );
  const applied = checked(
    data.source.engine.apply(context.log.state, { kind: 'command', seat, command }),
  );
  return signAt(data, context, { kind: 'command', signed }, toHex(hashValue(applied.state)));
}

function signedCommandFrom(entry: LogEntry) {
  if (entry.payload.kind !== 'command') throw new Error('Expected a signed command entry');
  return entry.payload.signed;
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

function driveToDraw(
  data: Fixture,
  start: ProposalContext,
): { context: ProposalContext; history: CertifiedEntry[]; purchaseParent: ProposalContext | null } {
  let context = start;
  const history: CertifiedEntry[] = [];
  let purchaseParent: ProposalContext | null = null;
  for (let step = 0; step < 500; step += 1) {
    if (context.log.crypto?.decks.active) return { context, history, purchaseParent };
    const pending = data.source.engine.getPending(context.log.state);
    const random = pending.find((item) => item.kind === 'random');
    if (random?.kind === 'random') {
      if (random.request.type !== 'dice')
        throw new Error(`Unexpected random request ${random.request.type}`);
      const entry = beaconResult(data, context, need(context.log.crypto).beacon.round + 1);
      const next = advance(data, context, entry);
      context = next.context;
      history.push(next.proof);
      continue;
    }
    const player = pending.find((item) => item.kind === 'player');
    if (!player || player.kind !== 'player')
      throw new Error('No legal player choice on certified path');
    const legal = data.source.engine.getLegalCommands(context.log.state, player.seat).commands;
    const choice =
      legal.find((item) => item.type === 'BUY_DEV_CARD') ??
      legal.find((item) => item.type === 'ROLL_DICE') ??
      legal.find((item) => item.type === 'END_TURN') ??
      quietRobberMove(data, context, player.seat, legal) ??
      legal[0];
    if (!choice) throw new Error('No legal command on certified path');
    if (choice.type === 'BUY_DEV_CARD') purchaseParent = context;
    const next = advance(data, context, commandEntry(data, context, player.seat, choice));
    context = next.context;
    history.push(next.proof);
  }
  throw new Error('A legal development-card purchase was not reached within 500 inputs');
}

function driveToPlayableKnight(
  data: Fixture,
  start: ProposalContext,
  seat: Seat,
  slotId: string,
): { context: ProposalContext; history: CertifiedEntry[] } {
  let context = start;
  const history: CertifiedEntry[] = [];
  for (let step = 0; step < 70; step += 1) {
    const pending = data.source.engine.getPending(context.log.state);
    const player = pending.find((item) => item.kind === 'player');
    const legal =
      player?.kind === 'player'
        ? data.source.engine.getLegalCommands(context.log.state, player.seat).commands
        : [];
    const play: CommandShape = { type: 'PLAY_DEV_CARD', slotId, card: 'knight' };
    if (
      player?.kind === 'player' &&
      player.seat === seat &&
      data.source.engine.validate(context.log.state, { kind: 'command', seat, command: play }).ok
    )
      return { context, history };
    const random = pending.find((item) => item.kind === 'random');
    if (random?.kind === 'random') {
      if (random.request.type !== 'dice')
        throw new Error(`Unexpected random request ${random.request.type}`);
      const next = advance(
        data,
        context,
        beaconResult(data, context, need(context.log.crypto).beacon.round + 1),
      );
      context = next.context;
      history.push(next.proof);
      continue;
    }
    if (!player || player.kind !== 'player') throw new Error('Expected a pending player');
    const choice =
      legal.find((item) => item.type === 'ROLL_DICE') ??
      legal.find((item) => item.type === 'END_TURN') ??
      quietRobberMove(data, context, player.seat, legal) ??
      legal[0];
    if (!choice) throw new Error('No legal command while waiting to play Knight');
    const next = advance(data, context, commandEntry(data, context, player.seat, choice));
    context = next.context;
    history.push(next.proof);
  }
  throw new Error('The dealt Knight did not become playable');
}

let shared: Fixture;
let sharedReady: { context: ProposalContext; history: CertifiedEntry[] };
beforeAll(() => {
  shared = fixture();
  sharedReady = setup(shared);
}, 120_000);

describe('certified deck log', () => {
  test('genesis commitments gate START_SEAT; only exact ordered signed setup passes advance', async () => {
    const data = shared;
    const first = need(need(data.deck.transcripts[0]).passes[0]);
    const second = need(need(data.deck.transcripts[0]).passes[1]);
    const before = snapshotFromContext(data.initial);
    const source = {
      link: vi.fn<() => Uint8Array>(() => new Uint8Array(32)),
      extension: vi.fn<() => { length: number; tip: Uint8Array }>(() => ({
        length: 128,
        tip: new Uint8Array(32),
      })),
    };
    const store = new MemoryBeaconContributionStore();
    const load = vi.spyOn(store, 'load');
    const prepared = await prepareBeaconContribution(
      need(data.initial.log.crypto),
      0,
      need(data.source.identities.get(0)).secretKey,
      source,
      store,
    );
    expect(prepared).toEqual({ ok: true, value: null });
    expect(source.link).not.toHaveBeenCalled();
    expect(source.extension).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    const inbox = new BeaconInbox();
    expect(inbox.refresh(data.initial.log.crypto).ok).toBe(true);
    const earlyOperation = checked(getBeaconOperation(need(data.initial.log.crypto).beacon));
    const earlyReveal = signBeaconReveal(
      earlyOperation,
      0,
      need(need(data.chains[0])[1]),
      need(data.source.identities.get(0)).secretKey,
    );
    expect(inbox.remember({ kind: 'beacon-reveal', signed: earlyReveal })).toEqual({
      ok: true,
      value: false,
    });
    const start = signAt(data, data.initial, {
      kind: 'system',
      input: { kind: 'system', type: 'START_SEAT', seat: 0 },
      evidence: { kind: 'proof', protocol: BEACON_EVIDENCE_PROTOCOL, data: [] },
    });
    expect(validateCertifiedEntry(certify(data, data.initial, start), data.initial)).toMatchObject({
      ok: false,
      error: { code: 'deck-setup-pending' },
    });
    const wrongOrder = signAt(data, data.initial, {
      kind: 'crypto',
      action: 'deck-pass',
      evidence: { deckId: 'dev', pass: second },
    });
    expect(
      validateNextEntry(wrongOrder, data.initial.log, {
        ...data.policy.entry,
        term: 1,
        sequencer: wrongOrder.sequencer,
      }),
    ).toMatchObject({ ok: false, error: { code: 'deck-pass-commitment' } });
    const forged = { ...first, sig: second.sig };
    const mismatch = signAt(data, data.initial, {
      kind: 'crypto',
      action: 'deck-pass',
      evidence: { deckId: 'dev', pass: forged },
    });
    expect(validateCertifiedEntry(certify(data, data.initial, mismatch), data.initial).ok).toBe(
      false,
    );
    expect(snapshotFromContext(data.initial)).toEqual(before);

    const played = sharedReady;
    expect(played.context.log.crypto?.decks.decks[0]?.nextPass).toBe(8);
    const signedPass = need(played.history[0]);
    const elected = proposerFor(1, 1, data.initial.membership, data.initial.excludedProposers);
    const proposal = signProposal(
      {
        genesisDigest: data.initial.membership.genesisDigest,
        epoch: data.initial.membership.epoch,
        entry: signedPass.entry,
        validRound: null,
        prevotes: [],
      },
      need(data.source.identities.get(elected.seat)).secretKey,
    );
    const proposalBytes = checked(encodeProtocolMessage({ t: 'PROPOSAL', proposal }));
    const commitBytes = checked(encodeProtocolMessage({ t: 'COMMIT', certified: signedPass }));
    expect(Math.max(proposalBytes.length, commitBytes.length)).toBeLessThan(MAX_MESSAGE_BYTES);
    const startEntry = beaconResult(data, played.context, 1);
    const started = advance(data, played.context, startEntry);
    expect(started.context.log.head.seq).toBe(9);
    const replayed = checked(
      replayCertifiedPrefix(
        data.entry,
        [...played.history, started.proof],
        data.source.engine,
        data.policy,
      ),
    );
    expect(snapshotFromContext(replayed.context)).toEqual(snapshotFromContext(started.context));
    expect(verifyReplaySnapshot(snapshotFromContext(started.context), replayed.context).ok).toBe(
      true,
    );
    expect(data.verifySystem).not.toHaveBeenCalled();
  }, 120_000);

  test('a missing CARD_DEALT proof cannot be approved by permissive callbacks and rejection preserves the cursor', () => {
    const data = shared;
    const played = sharedReady;
    const started = advance(data, played.context, beaconResult(data, played.context, 1));
    const context = started.context;
    const prior = snapshotFromContext(context);
    const fake: SystemInput = {
      kind: 'system',
      type: 'CARD_DEALT',
      deck: 'dev',
      seat: 0,
      slotId: 'absent',
    };
    const entry = signAt(data, context, {
      kind: 'system',
      input: fake,
      evidence: { kind: 'proof', protocol: DECK_DRAW_PROTOCOL, data: [] },
    });
    expect(validateCertifiedEntry(certify(data, context, entry), context).ok).toBe(false);
    expect(snapshotFromContext(context)).toEqual(prior);
    expect(context.log.crypto?.decks.decks[0]?.nextPosition).toBe(0);
  }, 120_000);

  test('real certified setup, beacon rolls and purchase produce one privately decodable public deal', () => {
    const data = shared;
    const started = advance(data, sharedReady.context, beaconResult(data, sharedReady.context, 1));
    const pendingPlayer = data.source.engine
      .getPending(started.context.log.state)
      .find((item) => item.kind === 'player');
    if (pendingPlayer?.kind !== 'player') throw new Error('Expected player after certified dice');
    const legal = data.source.engine.getLegalCommands(
      started.context.log.state,
      pendingPlayer.seat,
    );
    const ordinary = need(legal.commands[0]);
    const extraProof = commandEntry(data, started.context, pendingPlayer.seat, ordinary, {
      protocol: COMMAND_PROOFS_PROTOCOL,
      data: { deck: [], hands: [] },
    });
    data.verifyCommand.mockClear();
    expect(
      validateCommandForEntry(signedCommandFrom(extraProof), started.context.log, data.policy.entry)
        .ok,
    ).toBe(false);
    expect(data.verifyCommand).not.toHaveBeenCalled();
    const beforeDraw = driveToDraw(data, started.context);
    // Fixture-only uncertainty at a real certified BUY parent: public totals and
    // commitments stay unchanged, but the owner may hold several feasible hands.
    const purchaseParent = need(beforeDraw.purchaseParent);
    const buyer = data.source.engine
      .getPending(purchaseParent.log.state)
      .find((item) => item.kind === 'player');
    if (buyer?.kind !== 'player') throw new Error('Expected certified purchase parent');
    const originalBuyer = need(
      purchaseParent.log.state.seats.find((item) => item.seat === buyer.seat),
    );
    const total = originalBuyer.resources.total;
    const uncertainBounds = checked(
      createResourceBounds(
        total,
        { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 },
        { brick: total, lumber: total, wool: total, grain: total, ore: total },
      ),
    );
    const syntheticState = {
      ...purchaseParent.log.state,
      seats: purchaseParent.log.state.seats.map((seat) =>
        seat.seat === buyer.seat
          ? {
              ...seat,
              resources: uncertainBounds,
            }
          : seat,
      ),
    };
    // This parent is deliberately synthetic: preserve the engine-legal public
    // state and commitment ledger while making uncertainty require a proof.
    const syntheticPurchaseHead = signEntry(
      {
        ...entryBody(purchaseParent.log.head),
        stateHash: toHex(hashValue(syntheticState)),
      },
      need(data.source.identities.get(0)).secretKey,
    );
    const purchaseContext = {
      ...purchaseParent,
      log: { ...purchaseParent.log, state: syntheticState, head: syntheticPurchaseHead },
    };
    const buyInput = {
      kind: 'command' as const,
      seat: buyer.seat,
      command: { type: 'BUY_DEV_CARD' },
    };
    const buyApplied = checked(data.source.engine.apply(syntheticState, buyInput));
    const buyPlan = checked(
      planHandTransition(
        need(purchaseContext.log.crypto).hands,
        syntheticState,
        buyInput,
        buyApplied,
      ),
    );
    expect(buyPlan.obligations.some((obligation) => obligation.kind === 'range')).toBe(true);
    const missingHandProof = commandEntry(data, purchaseContext, buyer.seat, buyInput.command);
    data.verifyCommand.mockClear();
    expect(
      validateCommandForEntry(
        signedCommandFrom(missingHandProof),
        purchaseContext.log,
        data.policy.entry,
      ),
    ).toMatchObject({ ok: false, error: { code: 'command-proofs-required' } });
    expect(
      validateNextEntry(missingHandProof, purchaseContext.log, {
        ...data.policy.entry,
        term: 1,
        sequencer: missingHandProof.sequencer,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'command-proofs-required' },
    });
    expect(data.verifyCommand).not.toHaveBeenCalled();
    const proposalFor = (entry: LogEntry) =>
      signProposal(
        {
          genesisDigest: purchaseContext.membership.genesisDigest,
          epoch: purchaseContext.membership.epoch,
          entry,
          validRound: null,
          prevotes: [],
        },
        need(data.source.identities.get(0)).secretKey,
      );
    const accused = (entry: LogEntry) => ({
      kind: 'control' as const,
      action: 'exclude-proposer' as const,
      offender: 0 as const,
      evidence: { kind: 'invalid-command' as const, proposal: proposalFor(entry) },
    });
    const accusationContext = {
      log: purchaseContext.log,
      commandPolicy: data.policy.entry,
      membership: purchaseContext.membership,
      excludedProposers: purchaseContext.excludedProposers,
      proposerFor: (seq: number, term: number) =>
        proposerFor(seq, term, purchaseContext.membership, purchaseContext.excludedProposers),
    };
    expect(validateObjectiveAccusation(accused(missingHandProof), accusationContext)).toEqual(
      success(undefined),
    );
    const staleSigned = signCommand(
      {
        ...signedCommandFrom(missingHandProof).body,
        headHash: entryHash(purchaseParent.log.head),
      },
      need(data.source.identities.get(buyer.seat)).secretKey,
    );
    const staleEntry = signAt(data, purchaseContext, {
      kind: 'command',
      signed: staleSigned,
    });
    expect(validateObjectiveAccusation(accused(staleEntry), accusationContext)).toMatchObject({
      ok: false,
      error: { code: 'control-unproven' },
    });
    const active = need(beforeDraw.context.log.crypto).decks.active;
    if (!active) throw new Error('Expected a certified frozen draw');
    expect(active.anchor).toEqual({
      seq: beforeDraw.context.log.head.seq,
      hash: entryHash(beforeDraw.context.log.head),
    });
    expect(active.position).toBe(0);
    // This is only the crypto transition. Separate control/consensus tests prove
    // exclusion authority; one voter cannot certify an exclusion without ending
    // the proposer set. A control interleaving must not re-anchor a frozen draw.
    const conflictingVote = (valueHash: string) =>
      signVote(
        {
          genesisDigest: beforeDraw.context.membership.genesisDigest,
          epoch: beforeDraw.context.membership.epoch,
          seat: 0,
          seq: beforeDraw.context.log.head.seq + 1,
          term: 1,
          phase: 'prevote',
          valueHash,
        },
        need(data.source.identities.get(0)).secretKey,
      );
    const controlTransition = checked(
      validateCryptoTransition(
        data.genesis,
        beforeDraw.context.log.crypto,
        data.source.engine,
        beforeDraw.context.log.state,
        signAt(data, beforeDraw.context, {
          kind: 'control',
          action: 'exclude-proposer',
          offender: 0,
          evidence: {
            kind: 'vote-equivocation',
            first: conflictingVote('a'.repeat(64)),
            second: conflictingVote('b'.repeat(64)),
          },
        }),
      ),
    );
    expect(controlTransition.crypto?.decks.active?.anchor).toEqual(active.anchor);
    expect(controlTransition.crypto?.decks.active?.position).toBe(active.position);
    const missingHands = { ...need(beforeDraw.context.log.crypto) };
    Reflect.deleteProperty(missingHands, 'hands');
    expect(
      validateCryptoTransition(
        data.genesis,
        missingHands,
        data.source.engine,
        beforeDraw.context.log.state,
        signAt(data, beforeDraw.context, {
          kind: 'control',
          action: 'exclude-proposer',
          offender: 0,
          evidence: {
            kind: 'vote-equivocation',
            first: conflictingVote('a'.repeat(64)),
            second: conflictingVote('b'.repeat(64)),
          },
        }),
      ).ok,
    ).toBe(false);
    const prefix: ReturnType<typeof signDeckUnlock>[] = [];
    for (const participant of active.participants) {
      if (participant.seat === active.seat) continue;
      const source = data.deck.createSource(participant.seat);
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
    const input: SystemInput = {
      kind: 'system',
      type: 'CARD_DEALT',
      deck: active.deckId,
      seat: active.seat,
      slotId: active.slotId,
    };
    const applied = checked(data.source.engine.apply(beforeDraw.context.log.state, input));
    const deal = signAt(
      data,
      beforeDraw.context,
      {
        kind: 'system',
        input,
        evidence: { kind: 'proof', protocol: DECK_DRAW_PROTOCOL, data: prefix },
      },
      toHex(hashValue(applied.state)),
    );
    const result = advance(data, beforeDraw.context, deal);
    const ledger = need(result.context.log.crypto).decks;
    const hands = need(result.context.log.crypto).hands;
    for (const seat of result.context.log.state.seats) {
      const committed = need(hands.find((item) => item.seat === seat.seat));
      for (const resource of RESOURCES) {
        expect(seat.resources.min[resource]).toBe(seat.resources.max[resource]);
        expect(committed.commitments[resource]).toBe(
          pedersenCommit(BigInt(seat.resources.min[resource]), 0n),
        );
      }
    }
    const deck = need(ledger.decks[0]);
    const slot = need(deck.slots[0]);
    expect(deck.nextPosition).toBe(1);
    expect(slot.seat).toBe(active.seat);
    expect(slot.slotId).toBe(active.slotId);
    expect(JSON.stringify(result.context.log.state)).not.toContain(slot.receipt.point);
    const owner = data.deck.createSource(active.seat);
    const decoded = decodeDeckCard(deck.setup, slot.receipt, owner.lock(active.position));
    expect(decoded.ok).toBe(true);
    expect(checked(decoded).card).toBe('knight');
    const playable = driveToPlayableKnight(data, result.context, active.seat, active.slotId);
    const playCommand: CommandShape = {
      type: 'PLAY_DEV_CARD',
      slotId: active.slotId,
      card: 'knight',
    };
    const reveal = proveDeckReveal(
      deck.setup,
      slot.receipt,
      checked(decoded).identity,
      owner.lock(active.position),
      new Uint8Array(32).fill(93),
      {
        genesisDigest: playable.context.membership.genesisDigest,
        epoch: need(playable.context.log.crypto).epoch,
        anchor: { seq: playable.context.log.head.seq, hash: entryHash(playable.context.log.head) },
        seat: active.seat,
        nonce: (playable.context.log.lastNonces.get(active.seat) ?? 0) + 1,
        command: playCommand,
      },
    );
    const omitted = commandEntry(data, playable.context, active.seat, playCommand);
    expect(
      validateCommandForEntry(signedCommandFrom(omitted), playable.context.log, data.policy.entry)
        .ok,
    ).toBe(false);
    expect(
      validateCertifiedEntry(certify(data, playable.context, omitted), playable.context).ok,
    ).toBe(false);
    const wrongIdentity = commandEntry(data, playable.context, active.seat, playCommand, {
      protocol: DECK_REVEAL_PROTOCOL,
      data: [{ slotId: active.slotId, identity: 'victoryPoint#1', proof: reveal.proof }],
    });
    expect(
      validateCommandForEntry(
        signedCommandFrom(wrongIdentity),
        playable.context.log,
        data.policy.entry,
      ).ok,
    ).toBe(false);
    expect(
      validateCertifiedEntry(certify(data, playable.context, wrongIdentity), playable.context).ok,
    ).toBe(false);

    // Deliberately synthetic near-win public state: the physical receipt is the
    // genuine certified Knight above. A permissive command callback must not
    // turn that Knight into a VP card merely because CLAIM_VICTORY is engine-legal.
    const nearWinState = {
      ...playable.context.log.state,
      seats: playable.context.log.state.seats.map((seat) =>
        seat.seat === active.seat ? { ...seat, publicVp: 9 } : seat,
      ),
    };
    const originalHead = playable.context.log.head;
    const headSigner = need(
      data.genesis.seats.find((seat) => seat.publicKey === originalHead.sequencer),
    );
    const syntheticHead = signEntry(
      {
        seq: originalHead.seq,
        term: originalHead.term,
        prevHash: originalHead.prevHash,
        payload: originalHead.payload,
        stateHash: toHex(hashValue(nearWinState)),
        sequencer: originalHead.sequencer,
      },
      need(data.source.identities.get(headSigner.seat)).secretKey,
    );
    const synthetic: ProposalContext = {
      ...playable.context,
      log: { ...playable.context.log, state: nearWinState, head: syntheticHead },
    };
    const claim: CommandShape = { type: 'CLAIM_VICTORY', slotIds: [active.slotId] };
    expect(
      data.source.engine.validate(nearWinState, {
        kind: 'command',
        seat: active.seat,
        command: claim,
      }).ok,
    ).toBe(true);
    const falseClaim = commandEntry(data, synthetic, active.seat, claim);
    expect(
      validateCommandForEntry(signedCommandFrom(falseClaim), synthetic.log, data.policy.entry).ok,
    ).toBe(false);
    expect(validateCertifiedEntry(certify(data, synthetic, falseClaim), synthetic).ok).toBe(false);
    const claimProof = proveDeckReveal(
      deck.setup,
      slot.receipt,
      checked(decoded).identity,
      owner.lock(active.position),
      new Uint8Array(32).fill(94),
      {
        genesisDigest: synthetic.membership.genesisDigest,
        epoch: need(synthetic.log.crypto).epoch,
        anchor: { seq: synthetic.log.head.seq, hash: entryHash(synthetic.log.head) },
        seat: active.seat,
        nonce: (synthetic.log.lastNonces.get(active.seat) ?? 0) + 1,
        command: claim,
      },
    );
    owner.dispose();
    const wrongClaim = commandEntry(data, synthetic, active.seat, claim, {
      protocol: DECK_REVEAL_PROTOCOL,
      data: [{ slotId: active.slotId, ...claimProof }],
    });
    expect(
      validateCommandForEntry(signedCommandFrom(wrongClaim), synthetic.log, data.policy.entry),
    ).toMatchObject({
      ok: false,
      error: { code: 'deck-reveal-kind' },
    });
    expect(validateCertifiedEntry(certify(data, synthetic, wrongClaim), synthetic)).toMatchObject({
      ok: false,
      error: { code: 'deck-reveal-kind' },
    });
    const historyBeforePlay = [
      ...sharedReady.history,
      started.proof,
      ...beforeDraw.history,
      result.proof,
      ...playable.history,
    ];
    const driver = new VerifiedSessionDriver(
      data.source.engine,
      data.genesis,
      [active.seat],
      (_deckId, seat) => data.deck.createSource(seat),
    );
    let privateParent = data.initial.log;
    checked(
      replayCertifiedPrefix(
        data.entry,
        historyBeforePlay,
        data.source.engine,
        data.policy,
        (certified, next) => {
          const privateApplied = driver.committedEntry(certified, privateParent, next.log);
          if (privateApplied.ok) privateParent = next.log;
          return privateApplied;
        },
      ),
    );
    expect(driver.privateState(active.seat)?.slots[active.slotId]).toBe('knight');
    expect(driver.privateState(active.seat === 0 ? 1 : 0)).toBeNull();
    const body = signedCommandFrom(omitted).body;
    expect(
      driver.prepareCommand({ ...body, headHash: 'f'.repeat(64) }, playable.context.log),
    ).toMatchObject({
      ok: false,
      error: { code: 'verified-command-context' },
    });
    const preparedEvidence = checked(driver.prepareCommand(body, playable.context.log));
    const validKnight = commandEntry(
      data,
      playable.context,
      active.seat,
      playCommand,
      preparedEvidence,
    );
    expect(
      validateCommandForEntry(
        signedCommandFrom(validKnight),
        playable.context.log,
        data.policy.entry,
      ).ok,
    ).toBe(true);
    const playedKnight = advance(data, playable.context, validKnight);
    checked(
      driver.committedEntry(
        checked(validateCertifiedEntry(playedKnight.proof, playable.context)),
        playable.context.log,
        playedKnight.context.log,
      ),
    );
    expect(driver.privateState(active.seat)?.slots).toEqual({});
    driver.dispose();
    expect(driver.privateState(active.seat)).toBeNull();
    expect(need(playedKnight.context.log.crypto).decks.decks[0]?.slots).toEqual([]);
    const history = [...historyBeforePlay, playedKnight.proof];
    const replayed = checked(
      replayCertifiedPrefix(data.entry, history, data.source.engine, data.policy),
    );
    expect(snapshotFromContext(replayed.context)).toEqual(
      snapshotFromContext(playedKnight.context),
    );
  }, 120_000);
});
