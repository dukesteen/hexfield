import { fromBase64Url, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { createHashChain, signObject } from '@cp2p/crypto';
import { success } from '@cp2p/engine';
import type { CommandShape, GameState, Result, Seat, SystemInput } from '@cp2p/engine';
import { describe, expect, test, vi } from 'vitest';
import { completeBeaconState, freezeBeaconRequest, getBeaconOperation } from './beacon-state.js';
import { signBeaconReveal } from './beacon.js';
import { getBeaconExtensionOperation } from './beacon-state.js';
import { signBeaconExtension } from './beacon-extension.js';
import { BEACON_EVIDENCE_PROTOCOL, captureCryptoPending } from './crypto-context.js';
import {
  GENESIS_PREVIOUS_HASH,
  entryHash,
  genesisBody,
  genesisId,
  signEntry,
  signVerifiedGenesis,
} from './genesis.js';
import { signCommand, validateNextEntry } from './log.js';
import type { EntryPolicy } from './log.js';
import { advanceContext, proposerFor, validateCertifiedEntry } from './proposal.js';
import type { CertifiedEntry, ProposalContext } from './proposal.js';
import {
  initialProposalContext,
  replayCertifiedPrefix,
  snapshotFromContext,
  verifyReplaySnapshot,
} from './replay.js';
import { createSimulationGenesis } from './testing/simulation-genesis.js';
import { createGenesisDeckFixture } from './testing/deck-fixture.js';
import type { EntryBody, Genesis, GenesisBody, LogEntry } from './types.js';
import { signVote } from './votes.js';

// The first fixture generation validates a complete 25-card multiparty shuffle.
vi.setConfig({ testTimeout: 30_000 });

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing beacon log fixture');
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildFixture(humanCount: number, chainLength: number) {
  const source = createSimulationGenesis({ seed: 91, humanCount });
  const humans = source.genesis.seats.filter((seat) => seat.kind === 'human');
  const chains = humans.map((_, index) =>
    createHashChain(new Uint8Array(32).fill(index + 29), chainLength),
  );
  const initialBody: GenesisBody = {
    ...genesisBody(source.genesis),
    security: 'verified',
    commitments: {
      beaconChains: humans.map((seat, index) => ({
        seat: seat.seat,
        length: chainLength,
        tip: toBase64Url(required(required(chains[index])[0])),
      })),
    },
  };
  const deck = createGenesisDeckFixture(initialBody, source.identities);
  const body = deck.body;
  const verifySystem = vi.fn<() => Result<void>>(() => success(undefined));
  const verifyCommand = vi.fn<() => Result<void>>(() => success(undefined));
  const policy = {
    // Base deck proofs are checked by signVerifiedGenesis and each certified deck-pass fold.
    genesis: { verifyCommitments: () => success(undefined) },
    entry: { verifySystem, verifyCommand },
  };
  const signatures = humans.map((seat) => {
    const signed = signVerifiedGenesis(
      body,
      deck.transcripts,
      seat.seat,
      required(source.identities.get(seat.seat)).secretKey,
    );
    if (!signed.ok) throw new Error(`Verified genesis signing failed: ${signed.error.message}`);
    return signed.value;
  });
  const genesis: Genesis = { ...body, gameId: genesisId(body), signatures };
  const state = source.engine.createGame(body.config, fromBase64Url(body.genesisSeed));
  const first = required(source.identities.get(0));
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
  const initial = initialProposalContext(entry, source.engine, policy);
  if (!initial.ok) throw new Error(initial.error.message);
  const data = {
    source,
    humans,
    chains,
    deck,
    genesis,
    state,
    entry,
    policy,
    verifySystem,
    verifyCommand,
    initial: initial.value,
    setupEntries: [] as CertifiedEntry[],
  };
  let context = initial.value;
  for (const transcript of deck.transcripts) {
    for (const pass of transcript.passes) {
      const setupEntry = signAt(
        data,
        context,
        { kind: 'crypto', action: 'deck-pass', evidence: { deckId: transcript.deckId, pass } },
        context.log.head.stateHash,
      );
      const proof = certified(data, context, setupEntry);
      const checked = validateCertifiedEntry(proof, context);
      if (!checked.ok) throw new Error(`Deck setup entry failed: ${checked.error.message}`);
      const advanced = advanceContext(context, checked.value);
      if (!advanced.ok) throw new Error(`Deck setup advance failed: ${advanced.error.message}`);
      data.setupEntries.push(proof);
      context = advanced.value;
    }
  }
  data.initial = context;
  return data;
}

type BeaconFixture = ReturnType<typeof buildFixture>;
const fixtureCache = new Map<string, BeaconFixture>();

function fixture(humanCount = 2, chainLength = 2): BeaconFixture {
  const key = `${humanCount}/${chainLength}`;
  let value = fixtureCache.get(key);
  if (!value) {
    value = buildFixture(humanCount, chainLength);
    fixtureCache.set(key, value);
  }
  value.verifySystem.mockClear();
  value.verifyCommand.mockClear();
  return value;
}

function revealsFor(data: ReturnType<typeof fixture>, context: ProposalContext, index = 1) {
  if (!context.log.crypto) throw new Error('Verified crypto context is missing');
  const operation = getBeaconOperation(context.log.crypto.beacon);
  if (!operation.ok) throw new Error(operation.error.message);
  return data.humans.map((seat, position) =>
    signBeaconReveal(
      operation.value,
      seat.seat,
      required(required(data.chains[position])[index]),
      required(data.source.identities.get(seat.seat)).secretKey,
    ),
  );
}

function signer(data: ReturnType<typeof fixture>, context: ProposalContext, term: number) {
  const elected = proposerFor(
    context.log.head.seq + 1,
    term,
    context.membership,
    context.excludedProposers,
  );
  return {
    peerId: elected.publicKey,
    secretKey: required(data.source.identities.get(elected.seat)).secretKey,
  };
}

function signAt(
  data: ReturnType<typeof fixture>,
  context: ProposalContext,
  payload: EntryBody['payload'],
  stateHash: string,
  term = 1,
): LogEntry {
  const elected = signer(data, context, term);
  return signEntry(
    {
      seq: context.log.head.seq + 1,
      term,
      prevHash: entryHash(context.log.head),
      payload,
      stateHash,
      sequencer: elected.peerId,
    },
    elected.secretKey,
  );
}

function resultFor(data: ReturnType<typeof fixture>, context: ProposalContext, reveals: unknown[]) {
  if (!context.log.crypto) throw new Error('Verified crypto context is missing');
  const prospective = completeBeaconState(context.log.crypto.beacon, reveals, context.log.state, {
    seq: context.log.head.seq + 1,
    hash: 'c'.repeat(64),
  });
  if (!prospective.ok || prospective.value.outcome.kind !== 'system')
    throw new Error('Fixture did not derive a system outcome');
  const input = prospective.value.outcome.input;
  const applied = data.source.engine.apply(context.log.state, input);
  if (!applied.ok) throw new Error(applied.error.message);
  const payload = {
    kind: 'system' as const,
    input,
    evidence: { kind: 'proof' as const, protocol: BEACON_EVIDENCE_PROTOCOL, data: reveals },
  };
  return signAt(data, context, payload, toHex(hashValue(applied.value.state)));
}

function certified(
  data: ReturnType<typeof fixture>,
  context: ProposalContext,
  entry: LogEntry,
): CertifiedEntry {
  const valueHash = entryHash(entry);
  const certificate = data.humans.map((seat) =>
    signVote(
      {
        genesisDigest: context.membership.genesisDigest,
        epoch: context.membership.epoch,
        seat: seat.seat,
        seq: entry.seq,
        term: entry.term,
        phase: 'precommit',
        valueHash,
      },
      required(data.source.identities.get(seat.seat)).secretKey,
    ),
  );
  return { entry, certificate };
}

function directPolicy(
  data: ReturnType<typeof fixture>,
  context: ProposalContext,
  term = 1,
): EntryPolicy {
  return { ...data.policy.entry, term, sequencer: signer(data, context, term).peerId };
}

function certifiedCommand(
  data: ReturnType<typeof fixture>,
  context: ProposalContext,
  seat: Seat,
  command: CommandShape,
): { context: ProposalContext; certified: CertifiedEntry } {
  const key = required(data.source.identities.get(seat)).secretKey;
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
    key,
  );
  const applied = data.source.engine.apply(context.log.state, { kind: 'command', seat, command });
  if (!applied.ok) throw new Error(applied.error.message);
  const entry = signAt(
    data,
    context,
    { kind: 'command', signed },
    toHex(hashValue(applied.value.state)),
  );
  const proof = certified(data, context, entry);
  const checked = validateCertifiedEntry(proof, context);
  if (!checked.ok) throw new Error(checked.error.message);
  const next = advanceContext(context, checked.value);
  if (!next.ok) throw new Error(next.error.message);
  return { context: next.value, certified: proof };
}

function advanceToDice(
  data: ReturnType<typeof fixture>,
  first: CertifiedEntry,
): { context: ProposalContext; history: CertifiedEntry[] } {
  const checked = validateCertifiedEntry(first, data.initial);
  if (!checked.ok) throw new Error(checked.error.message);
  const advanced = advanceContext(data.initial, checked.value);
  if (!advanced.ok) throw new Error(advanced.error.message);
  let context = advanced.value;
  const history = [...data.setupEntries, first];
  for (let step = 0; step < 32; step += 1) {
    const pendings = data.source.engine.getPending(context.log.state);
    if (pendings.some((pending) => pending.kind === 'random' && pending.request.type === 'dice'))
      return { context, history };
    const player = pendings.find((pending) => pending.kind === 'player');
    if (!player || player.kind !== 'player') throw new Error('Expected setup or roll choice');
    const choices = data.source.engine.getLegalCommands(context.log.state, player.seat).commands;
    const command = choices.find((choice) => choice.type === 'ROLL_DICE') ?? choices[0];
    if (!command) throw new Error('No legal setup or roll command');
    const next = certifiedCommand(data, context, player.seat, command);
    context = next.context;
    history.push(next.certified);
  }
  throw new Error('Dice request did not follow setup');
}

function driveToSteal(data: ReturnType<typeof fixture>, afterStart: GameState): GameState {
  let state = afterStart;
  for (let step = 0; step < 32; step += 1) {
    const pending = data.source.engine.getPending(state);
    const player = pending.find((item) => item.kind === 'player');
    if (!player || player.kind !== 'player') throw new Error('Expected setup or pre-roll choice');
    const commands = data.source.engine.getLegalCommands(state, player.seat).commands;
    const roll = commands.find((command) => command.type === 'ROLL_DICE');
    if (roll) {
      const rolled = data.source.engine.apply(state, {
        kind: 'command',
        seat: player.seat,
        command: roll,
      });
      if (!rolled.ok) throw new Error(rolled.error.message);
      const seven = data.source.engine.apply(rolled.value.state, {
        kind: 'system',
        type: 'DICE_RESULT',
        dice: [3, 4],
      });
      if (!seven.ok) throw new Error(seven.error.message);
      state = seven.value.state;
      break;
    }
    const command = commands[0];
    if (!command) throw new Error('Missing setup command');
    const applied = data.source.engine.apply(state, {
      kind: 'command',
      seat: player.seat,
      command,
    });
    if (!applied.ok) throw new Error(applied.error.message);
    state = applied.value.state;
  }
  const robber = data.source.engine.getPending(state).find((item) => item.kind === 'player');
  if (!robber || robber.kind !== 'player') throw new Error('Expected robber placement');
  const moves = data.source.engine
    .getLegalCommands(state, robber.seat)
    .commands.filter((command) => command.type === 'MOVE_ROBBER');
  for (const move of moves) {
    const placed = data.source.engine.apply(state, {
      kind: 'command',
      seat: robber.seat,
      command: move,
    });
    if (!placed.ok) continue;
    const steal = data.source.engine
      .getLegalCommands(placed.value.state, robber.seat)
      .commands.find((command) => command.type === 'STEAL');
    if (!steal) continue;
    const selected = data.source.engine.apply(placed.value.state, {
      kind: 'command',
      seat: robber.seat,
      command: steal,
    });
    if (!selected.ok) throw new Error(selected.error.message);
    return selected.value.state;
  }
  throw new Error('No legal victim followed the first seven');
}

describe('certified beacon log integration', () => {
  test('derives initial START_SEAT from signed reveals and replays the same crypto snapshot', () => {
    const data = fixture();
    const anchor = data.initial.log.crypto?.beacon.active?.anchor;
    expect(anchor).toEqual({ seq: 0, hash: entryHash(data.entry) });
    const reveals = revealsFor(data, data.initial);
    const entry = resultFor(data, data.initial, reveals);
    const checked = validateNextEntry(entry, data.initial.log, directPolicy(data, data.initial));
    if (!checked.ok) throw new Error(checked.error.message);
    expect(checked.value.input).toEqual(
      entry.payload.kind === 'system' ? entry.payload.input : null,
    );
    expect(checked.value.crypto?.beacon.round).toBe(1);
    expect(checked.value.crypto?.beacon.active).toBeNull();
    expect(checked.value.crypto?.beacon.chains.map((chain) => chain.index)).toEqual([1, 1]);
    expect(data.verifySystem).not.toHaveBeenCalled();

    const proof = certified(data, data.initial, entry);
    const certifiedResult = validateCertifiedEntry(proof, data.initial);
    if (!certifiedResult.ok) throw new Error(certifiedResult.error.message);
    const advanced = advanceContext(data.initial, certifiedResult.value);
    if (!advanced.ok) throw new Error(advanced.error.message);
    const replayed = replayCertifiedPrefix(
      data.entry,
      [...data.setupEntries, proof],
      data.source.engine,
      data.policy,
    );
    if (!replayed.ok) throw new Error(replayed.error.message);
    expect(snapshotFromContext(replayed.value.context)).toEqual(
      snapshotFromContext(advanced.value),
    );
    expect(
      verifyReplaySnapshot(snapshotFromContext(advanced.value), replayed.value.context).ok,
    ).toBe(true);
    const snapshot: unknown = snapshotFromContext(advanced.value);
    if (!record(snapshot)) throw new Error('Expected replay snapshot');
    expect(snapshot.crypto).not.toBeNull();
    expect(verifyReplaySnapshot({ ...snapshot, crypto: null }, replayed.value.context).ok).toBe(
      false,
    );
    expect(replayed.value.inputs).toEqual([checked.value.input]);
    expect(data.verifySystem).not.toHaveBeenCalled();
  });

  test('does not let a permissive callback bypass wrong input or incomplete, duplicate, stale evidence', () => {
    const data = fixture();
    const reveals = revealsFor(data, data.initial);
    const valid = resultFor(data, data.initial, reveals);
    if (valid.payload.kind !== 'system') throw new Error('Expected system entry');
    const selected = valid.payload.input.seat;
    if (typeof selected !== 'number') throw new Error('Expected a starting seat');
    const otherSeat = data.genesis.config.seats.find((seat) => seat !== selected);
    if (otherSeat === undefined) throw new Error('Expected another configured seat');
    const wrongInput: SystemInput = { kind: 'system', type: 'START_SEAT', seat: otherSeat };
    const wrongApplied = data.source.engine.apply(data.state, wrongInput);
    if (!wrongApplied.ok) throw new Error(wrongApplied.error.message);
    const changed = signAt(
      data,
      data.initial,
      { ...valid.payload, input: wrongInput },
      toHex(hashValue(wrongApplied.value.state)),
    );
    expect(
      validateNextEntry(changed, data.initial.log, directPolicy(data, data.initial)),
    ).toMatchObject({
      ok: false,
      error: { code: 'beacon-result' },
    });
    const invalidLists = [
      reveals.slice(0, 1),
      [required(reveals[0]), required(reveals[0])],
      [required(reveals[1]), required(reveals[0])],
    ];
    const firstReveal = required(reveals[0]);
    const staleBody = {
      ...firstReveal.body,
      value: toBase64Url(required(required(data.chains[0])[2])),
    };
    invalidLists.push([
      {
        body: staleBody,
        sig: signObject(
          'beacon-reveal',
          staleBody,
          required(data.source.identities.get(0)).secretKey,
        ),
      },
      required(reveals[1]),
    ]);
    for (const invalid of invalidLists) {
      const entry = signAt(
        data,
        data.initial,
        {
          ...valid.payload,
          evidence: { kind: 'proof', protocol: BEACON_EVIDENCE_PROTOCOL, data: invalid },
        },
        valid.stateHash,
      );
      expect(validateNextEntry(entry, data.initial.log, directPolicy(data, data.initial)).ok).toBe(
        false,
      );
    }
    const noCrypto = { ...data.initial.log, crypto: null };
    expect(validateNextEntry(valid, noCrypto, directPolicy(data, data.initial))).toMatchObject({
      ok: false,
      error: { code: 'crypto-context-required' },
    });
    expect(data.verifySystem).not.toHaveBeenCalled();
  });

  test('rejects a wrong beacon proof label and ambiguous pending requests without mutation', () => {
    const data = fixture();
    const reveals = revealsFor(data, data.initial);
    const valid = resultFor(data, data.initial, reveals);
    if (valid.payload.kind !== 'system') throw new Error('Expected system entry');
    const before = snapshotFromContext(data.initial);
    const wrongProtocol = signAt(
      data,
      data.initial,
      {
        ...valid.payload,
        evidence: { kind: 'proof', protocol: 'another-random-protocol', data: reveals },
      },
      valid.stateHash,
    );
    expect(
      validateNextEntry(wrongProtocol, data.initial.log, directPolicy(data, data.initial)),
    ).toMatchObject({ ok: false, error: { code: 'beacon-evidence-required' } });
    expect(snapshotFromContext(data.initial)).toEqual(before);
    expect(data.verifySystem).not.toHaveBeenCalled();

    const pending = data.source.engine
      .getPending(data.state)
      .find((item) => item.kind === 'random');
    if (!pending || !data.initial.log.crypto) throw new Error('Expected initial random request');
    const duplicatePendingEngine = {
      ...data.source.engine,
      getPending: () => [pending, pending],
    };
    expect(
      captureCryptoPending(data.initial.log.crypto, duplicatePendingEngine, data.state, {
        seq: 0,
        hash: entryHash(data.entry),
      }),
    ).toMatchObject({ ok: false, error: { code: 'ambiguous-random-request' } });
    expect(snapshotFromContext(data.initial)).toEqual(before);
  });

  test('one human with bots needs exactly that human reveal and certificate', () => {
    const data = fixture(1);
    const reveals = revealsFor(data, data.initial);
    expect(reveals).toHaveLength(1);
    const entry = resultFor(data, data.initial, reveals);
    const replayed = replayCertifiedPrefix(
      data.entry,
      [...data.setupEntries, certified(data, data.initial, entry)],
      data.source.engine,
      data.policy,
    );
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) throw new Error(replayed.error.message);
    expect(replayed.value.context.log.crypto?.beacon.chains).toHaveLength(1);
    expect(replayed.value.context.log.crypto?.beacon.round).toBe(1);
  });

  test('a certified control between request and result preserves the original beacon anchor', () => {
    const data = fixture();
    const reveals = revealsFor(data, data.initial);
    const offender = required(data.humans[1]);
    const conflicting = (valueHash: string) =>
      signVote(
        {
          genesisDigest: data.initial.membership.genesisDigest,
          epoch: 0,
          seat: offender.seat,
          seq: data.initial.log.head.seq + 1,
          term: 1,
          phase: 'prevote',
          valueHash,
        },
        required(data.source.identities.get(offender.seat)).secretKey,
      );
    const control = signAt(
      data,
      data.initial,
      {
        kind: 'control',
        action: 'exclude-proposer',
        offender: offender.seat,
        evidence: {
          kind: 'vote-equivocation',
          first: conflicting('a'.repeat(64)),
          second: conflicting('b'.repeat(64)),
        },
      },
      data.initial.log.head.stateHash,
    );
    const controlProof = certified(data, data.initial, control);
    const checkedControl = validateCertifiedEntry(controlProof, data.initial);
    if (!checkedControl.ok) throw new Error(checkedControl.error.message);
    const afterControl = advanceContext(data.initial, checkedControl.value);
    if (!afterControl.ok) throw new Error(afterControl.error.message);
    expect(afterControl.value.excludedProposers).toEqual([offender.seat]);
    expect(afterControl.value.log.crypto?.beacon.active?.anchor).toEqual({
      seq: 0,
      hash: entryHash(data.entry),
    });
    expect(afterControl.value.log.crypto?.beacon.round).toBe(0);

    const result = resultFor(data, afterControl.value, reveals);
    const resultProof = certified(data, afterControl.value, result);
    const replayed = replayCertifiedPrefix(
      data.entry,
      [...data.setupEntries, controlProof, resultProof],
      data.source.engine,
      data.policy,
    );
    if (!replayed.ok) throw new Error(replayed.error.message);
    expect(replayed.value.context.log.crypto?.beacon.round).toBe(1);
    expect(replayed.value.context.log.crypto?.beacon.chains.map((chain) => chain.index)).toEqual([
      1, 1,
    ]);
    expect(replayed.value.inputs).toHaveLength(1);
    expect(data.verifySystem).not.toHaveBeenCalled();
  });

  test('certifies a state-preserving exhausted-chain extension before the next real dice result', () => {
    const data = fixture(2, 1);
    const first = certified(
      data,
      data.initial,
      resultFor(data, data.initial, revealsFor(data, data.initial)),
    );
    const { context, history } = advanceToDice(data, first);
    const active = context.log.crypto?.beacon.active;
    expect(active?.pending.request.type).toBe('dice');
    expect(active?.participants.map((chain) => chain.index)).toEqual([1, 1]);
    if (!context.log.crypto) throw new Error('Missing verified crypto state');
    const extensionOperation = getBeaconExtensionOperation(context.log.crypto.beacon);
    if (!extensionOperation.ok) throw new Error(extensionOperation.error.message);
    const newChains = data.humans.map((_, index) =>
      createHashChain(new Uint8Array(32).fill(index + 59), 2),
    );
    const signedExtensions = data.humans.map((seat, index) =>
      signBeaconExtension(
        extensionOperation.value,
        seat.seat,
        2,
        required(required(newChains[index])[0]),
        required(data.source.identities.get(seat.seat)).secretKey,
      ),
    );
    const extension = signAt(
      data,
      context,
      { kind: 'crypto', action: 'beacon-extend', evidence: signedExtensions },
      context.log.head.stateHash,
    );
    const extensionProof = certified(data, context, extension);
    const checkedExtension = validateCertifiedEntry(extensionProof, context);
    if (!checkedExtension.ok) throw new Error(checkedExtension.error.message);
    expect(checkedExtension.value.input).toBeNull();
    expect(checkedExtension.value.state).toEqual(context.log.state);
    expect(checkedExtension.value.crypto?.beacon.round).toBe(1);
    const afterExtension = advanceContext(context, checkedExtension.value);
    if (!afterExtension.ok) throw new Error(afterExtension.error.message);
    expect(afterExtension.value.log.crypto?.beacon.active?.anchor).toEqual(active?.anchor);
    expect(afterExtension.value.log.crypto?.beacon.chains.map((chain) => chain.index)).toEqual([
      0, 0,
    ]);
    const duplicateExtension = signAt(
      data,
      afterExtension.value,
      extension.payload,
      afterExtension.value.log.head.stateHash,
    );
    expect(
      validateNextEntry(
        duplicateExtension,
        afterExtension.value.log,
        directPolicy(data, afterExtension.value),
      ).ok,
    ).toBe(false);
    const crypto = afterExtension.value.log.crypto;
    if (!crypto) throw new Error('Extension lost verified crypto state');
    const operation = getBeaconOperation(crypto.beacon);
    if (!operation.ok) throw new Error(operation.error.message);
    const reveals = data.humans.map((seat, index) =>
      signBeaconReveal(
        operation.value,
        seat.seat,
        required(required(newChains[index])[1]),
        required(data.source.identities.get(seat.seat)).secretKey,
      ),
    );
    const result = resultFor(data, afterExtension.value, reveals);
    const replayed = replayCertifiedPrefix(
      data.entry,
      [...history, extensionProof, certified(data, afterExtension.value, result)],
      data.source.engine,
      data.policy,
    );
    if (!replayed.ok) throw new Error(replayed.error.message);
    expect(replayed.value.context.log.crypto?.beacon.round).toBe(2);
    expect(replayed.value.context.log.crypto?.beacon.chains.map((chain) => chain.index)).toEqual([
      1, 1,
    ]);
    expect(data.verifySystem).not.toHaveBeenCalled();
  });

  test('beacon-fixed preserves engine state and consumes one steal round once', () => {
    const data = fixture();
    const first = resultFor(data, data.initial, revealsFor(data, data.initial));
    const checkedStart = validateNextEntry(
      first,
      data.initial.log,
      directPolicy(data, data.initial),
    );
    if (!checkedStart.ok || !checkedStart.value.crypto) throw new Error('Starting beacon failed');
    const atSteal = driveToSteal(data, checkedStart.value.state);
    const pending = required(
      data.source.engine
        .getPending(atSteal)
        .find((item) => item.kind === 'random' && item.request.type === 'stealIndex'),
    );
    const head = signEntry(
      {
        seq: 39,
        term: 1,
        prevHash: 'd'.repeat(64),
        payload: first.payload,
        stateHash: toHex(hashValue(atSteal)),
        sequencer: required(data.source.identities.get(0)).peerId,
      },
      required(data.source.identities.get(0)).secretKey,
    );
    const frozen = freezeBeaconRequest(
      checkedStart.value.crypto.beacon,
      pending,
      atSteal,
      { seq: head.seq, hash: entryHash(head) },
      0,
    );
    if (!frozen.ok) throw new Error(frozen.error.message);
    const deckLedger = data.initial.log.crypto?.decks;
    if (!deckLedger) throw new Error('Missing verified deck ledger');
    // The engine state and pending request come from legal engine inputs; this
    // focused validator fixture supplies the trusted head rather than replaying
    // the earlier public game through unrelated deck/hand protocols.
    const context: ProposalContext = {
      ...data.initial,
      log: {
        ...data.initial.log,
        head,
        state: atSteal,
        crypto: { epoch: 0, beacon: frozen.value, decks: deckLedger },
      },
    };
    const reveals = revealsFor(data, context, 2);
    const fixed = signAt(
      data,
      context,
      { kind: 'crypto', action: 'beacon-fixed', evidence: reveals },
      head.stateHash,
    );
    const checked = validateNextEntry(fixed, context.log, directPolicy(data, context));
    if (!checked.ok) throw new Error(checked.error.message);
    expect(checked.value.input).toBeNull();
    expect(checked.value.state).toEqual(atSteal);
    expect(checked.value.crypto?.beacon.round).toBe(2);
    expect(checked.value.crypto?.beacon.chains.map((chain) => chain.index)).toEqual([2, 2]);
    expect(checked.value.crypto?.beacon.fixed?.entry).toEqual({ seq: 40, hash: entryHash(fixed) });
    expect(checked.value.crypto?.beacon.fixed?.outcome.kind).toBe('steal-index');
    const next = advanceContext(context, checked.value);
    if (!next.ok) throw new Error(next.error.message);

    const beforePendingAttempt = snapshotFromContext(next.value);
    data.verifySystem.mockClear();
    const unrelatedSystem = signAt(
      data,
      next.value,
      {
        kind: 'system',
        input: { kind: 'system', type: 'UNRELATED_SYSTEM_INPUT' },
        evidence: {
          kind: 'proof',
          protocol: 'another-random-protocol',
          data: reveals,
        },
      },
      next.value.log.head.stateHash,
    );
    expect(
      validateNextEntry(unrelatedSystem, next.value.log, directPolicy(data, next.value)),
    ).toMatchObject({ ok: false, error: { code: 'beacon-pending' } });
    expect(snapshotFromContext(next.value)).toEqual(beforePendingAttempt);
    expect(data.verifySystem).not.toHaveBeenCalled();

    const again = signAt(data, next.value, fixed.payload, next.value.log.head.stateHash);
    expect(validateNextEntry(again, next.value.log, directPolicy(data, next.value)).ok).toBe(false);
    expect(data.verifySystem).not.toHaveBeenCalled();
  });

  test('beacon-fixed evidence cannot be used to stand in for START_SEAT or dice results', () => {
    const data = fixture();
    const first = resultFor(data, data.initial, revealsFor(data, data.initial));
    const { context } = advanceToDice(data, certified(data, data.initial, first));
    const reveals = revealsFor(data, context, 2);
    const before = snapshotFromContext(context);
    data.verifySystem.mockClear();
    const wrongKind = signAt(
      data,
      context,
      { kind: 'crypto', action: 'beacon-fixed', evidence: reveals },
      context.log.head.stateHash,
    );
    expect(validateNextEntry(wrongKind, context.log, directPolicy(data, context))).toMatchObject({
      ok: false,
      error: { code: 'beacon-fixed-kind' },
    });
    expect(snapshotFromContext(context)).toEqual(before);
    expect(data.verifySystem).not.toHaveBeenCalled();
  });
});
