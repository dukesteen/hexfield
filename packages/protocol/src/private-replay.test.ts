import { fromBase64Url, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { scalarToBytes } from '@cp2p/crypto';
import { success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import { beforeAll, describe, expect, test } from 'vitest';
import { createBeaconSecretSource } from './beacon-source.js';
import {
  completeBeaconState,
  getBeaconExtensionOperation,
  getBeaconOperation,
} from './beacon-state.js';
import { signBeaconExtension } from './beacon-extension.js';
import { signBeaconReveal } from './beacon.js';
import { BEACON_EVIDENCE_PROTOCOL } from './crypto-context.js';
import { deckCeremonyId } from './deck-genesis.js';
import { createDeckSecretSource } from './deck-source.js';
import {
  GENESIS_PREVIOUS_HASH,
  entryHash,
  genesisBody,
  genesisDigest,
  genesisId,
  signEntry,
  signVerifiedGenesis,
} from './genesis.js';
import { createHandSecretSource } from './hand-source.js';
import { signCommand } from './log.js';
import { reconstructPrivateSeats } from './private-replay.js';
import { advanceContext, validateCertifiedEntry } from './proposal.js';
import type { CertifiedEntry } from './proposal.js';
import { initialProposalContext, replayCertifiedPrefix } from './replay.js';
import { createStealSecretSource } from './steal-source.js';
import { createGenesisDeckFixture } from './testing/deck-fixture.js';
import { createSimulationGenesis } from './testing/simulation-genesis.js';
import type { EntryPayload, Genesis } from './types.js';
import { VerifiedSessionDriver } from './verified-session-driver.js';
import { signVote } from './votes.js';

function checked<T>(value: Result<T>): T {
  if (!value.ok) throw new Error(`${value.error.code}: ${value.error.message}`);
  return value.value;
}

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null)
    throw new Error('Missing private replay fixture value');
  return value;
}

const master = (seat: Seat) => scalarToBytes(BigInt(17 + seat));

function fixture() {
  const simulation = createSimulationGenesis({
    seed: 71,
    humanCount: 1,
    config: {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1],
      options: {},
    },
  });
  const deck = createGenesisDeckFixture(
    { ...genesisBody(simulation.genesis), security: 'verified', commitments: {} },
    simulation.identities,
  );
  const source = createBeaconSecretSource(
    master(0),
    { ceremonyId: deckCeremonyId(deck.body), seat: 0 },
    1,
  );
  const body = {
    ...deck.body,
    commitments: {
      ...deck.body.commitments,
      beaconChains: [
        { seat: 0, ...source.initialCommitment, tip: toBase64Url(source.initialCommitment.tip) },
      ],
    },
  };
  source.dispose();
  const signer = required(simulation.identities.get(0));
  const genesis: Genesis = {
    ...body,
    gameId: genesisId(body),
    signatures: [checked(signVerifiedGenesis(body, deck.transcripts, 0, signer.secretKey))],
  };
  const state = simulation.engine.createGame(body.config, fromBase64Url(body.genesisSeed));
  const entry = signEntry(
    {
      seq: 0,
      term: 1,
      prevHash: GENESIS_PREVIOUS_HASH,
      payload: { kind: 'genesis', genesis },
      stateHash: toHex(hashValue(state)),
      sequencer: signer.peerId,
    },
    signer.secretKey,
  );
  const policy = { genesis: { verifyCommitments: () => success(undefined) }, entry: {} };
  return { simulation, deck, genesis, signer, entry, policy };
}

function history(data: ReturnType<typeof fixture>) {
  let context = checked(initialProposalContext(data.entry, data.simulation.engine, data.policy));
  const entries: CertifiedEntry[] = [];
  const driver = new VerifiedSessionDriver(
    data.simulation.engine,
    data.genesis,
    [0, 1],
    (deckId, seat) =>
      createDeckSecretSource(
        master(seat),
        required(
          context.log.crypto?.decks.decks.find(
            (item) => item.commitment.definition.deckId === deckId,
          ),
        ).commitment.definition,
        seat,
      ),
    (seat) => createHandSecretSource(master(seat), genesisDigest(data.genesis), seat),
    (seat) =>
      createStealSecretSource(
        master(seat),
        data.genesis.ceremonyNonce,
        seat,
        required(data.genesis.seats.find((item) => item.seat === seat)).publicKey,
      ),
  );
  const append = (payload: EntryPayload, stateHash = context.log.head.stateHash) => {
    const entry = signEntry(
      {
        seq: context.log.head.seq + 1,
        term: 1,
        prevHash: entryHash(context.log.head),
        payload,
        stateHash,
        sequencer: data.signer.peerId,
      },
      data.signer.secretKey,
    );
    const certified = {
      entry,
      certificate: [
        signVote(
          {
            genesisDigest: context.membership.genesisDigest,
            epoch: context.membership.epoch,
            seat: 0,
            seq: entry.seq,
            term: 1,
            phase: 'precommit',
            valueHash: entryHash(entry),
          },
          data.signer.secretKey,
        ),
      ],
    };
    const validated = checked(validateCertifiedEntry(certified, context));
    const next = checked(advanceContext(context, validated));
    checked(driver.committedEntry(validated, context.log, next.log));
    context = next;
    entries.push(certified);
  };
  for (const transcript of data.deck.transcripts)
    for (const pass of transcript.passes)
      append({
        kind: 'crypto',
        action: 'deck-pass',
        evidence: { deckId: transcript.deckId, pass },
      });
  const beacon = required(context.log.crypto).beacon;
  const operation = checked(getBeaconOperation(beacon));
  const source = createBeaconSecretSource(
    master(0),
    { ceremonyId: deckCeremonyId(data.genesis), seat: 0 },
    1,
  );
  const reveals = [signBeaconReveal(operation, 0, source.source.link(0, 1), data.signer.secretKey)];
  source.dispose();
  const outcome = checked(
    completeBeaconState(beacon, reveals, context.log.state, {
      seq: context.log.head.seq + 1,
      hash: 'c'.repeat(64),
    }),
  ).outcome;
  if (outcome.kind !== 'system') throw new Error('Expected initial seat outcome');
  const start = checked(data.simulation.engine.apply(context.log.state, outcome.input));
  append(
    {
      kind: 'system',
      input: outcome.input,
      evidence: { kind: 'proof', protocol: BEACON_EVIDENCE_PROTOCOL, data: reveals },
    },
    toHex(hashValue(start.state)),
  );
  // Four settlements and four roads, followed by the first roll request.
  for (let index = 0; index < 9; index++) {
    const pending = required(
      data.simulation.engine.getPending(context.log.state).find((item) => item.kind === 'player'),
    );
    if (pending.kind !== 'player') throw new Error('Expected player');
    const legal = data.simulation.engine.getLegalCommands(
      context.log.state,
      pending.seat,
      required(driver.privateState(pending.seat)),
    );
    const command = required(
      legal.commands.find((item) => item.type === 'ROLL_DICE') ?? legal.commands[0],
    );
    const body = {
      gameId: data.genesis.gameId,
      genesisDigest: genesisDigest(data.genesis),
      seat: pending.seat,
      nonce: (context.log.lastNonces.get(pending.seat) ?? 0) + 1,
      headSeq: context.log.head.seq,
      headHash: entryHash(context.log.head),
      command,
    };
    const evidence = checked(driver.prepareCommand(body, context.log));
    const signed = signCommand(
      { ...body, ...(evidence ? { evidence } : {}) },
      required(data.simulation.identities.get(pending.seat)).secretKey,
    );
    const applied = checked(
      data.simulation.engine.apply(context.log.state, {
        kind: 'command',
        seat: pending.seat,
        command,
      }),
    );
    append({ kind: 'command', signed }, toHex(hashValue(applied.state)));
  }
  return { entries, driver, append, context: () => context };
}

describe('certified private history reconstruction', () => {
  let base: ReturnType<typeof fixture>;
  beforeAll(() => {
    base = fixture();
  }, 20_000);
  const reconstruct = (entries: readonly unknown[], seats: readonly Seat[] = [0, 1]) =>
    reconstructPrivateSeats({
      genesisEntry: base.entry,
      entries,
      engine: base.simulation.engine,
      policy: base.policy,
      secrets: seats.map((seat) => ({ seat, master: master(seat) })),
    });

  test('rebuilds each exact hand from legal production and retains only requested seats', () => {
    const trace = history(base);
    try {
      expect(trace.context().log.state.seats.some((seat) => seat.resources.total > 0)).toBe(true);
      const callerMaster = Buffer.from(master(1));
      const recovered = checked(
        reconstructPrivateSeats({
          genesisEntry: base.entry,
          entries: trace.entries,
          engine: base.simulation.engine,
          policy: base.policy,
          secrets: [{ seat: 1, master: callerMaster }],
        }),
      );
      expect(recovered.driver.privateState(1)).toEqual(trace.driver.privateState(1));
      expect(recovered.driver.privateState(0)).toBeNull();
      expect(recovered.context.log.state).toEqual(trace.context().log.state);
      recovered.releaseSeat(1);
      expect(recovered.driver.privateState(1)).toBeNull();
      expect(callerMaster).toEqual(Buffer.from(master(1)));
      recovered.dispose();
    } finally {
      trace.driver.dispose();
    }
  });

  test('checks historical extensions against the master, including a changed chain length', () => {
    const trace = history(base);
    try {
      const operation = checked(
        getBeaconExtensionOperation(required(trace.context().log.crypto).beacon),
      );
      const source = createBeaconSecretSource(
        master(0),
        { ceremonyId: deckCeremonyId(base.genesis), seat: 0 },
        3,
      );
      const extension = source.source.extension(1);
      source.dispose();
      trace.append({
        kind: 'crypto',
        action: 'beacon-extend',
        evidence: [
          signBeaconExtension(operation, 0, extension.length, extension.tip, base.signer.secretKey),
        ],
      });
      const recovered = checked(reconstruct(trace.entries));
      expect(recovered.context.log.crypto?.beacon.chains[0]?.length).toBe(3);
      recovered.dispose();
    } finally {
      trace.driver.dispose();
    }
  });

  test('rejects an honestly signed extension unrelated to the committed master', () => {
    const trace = history(base);
    try {
      const operation = checked(
        getBeaconExtensionOperation(required(trace.context().log.crypto).beacon),
      );
      const badTip = new Uint8Array(32).fill(99);
      trace.append({
        kind: 'crypto',
        action: 'beacon-extend',
        evidence: [signBeaconExtension(operation, 0, 3, badTip, base.signer.secretKey)],
      });
      expect(
        replayCertifiedPrefix(base.entry, trace.entries, base.simulation.engine, base.policy).ok,
      ).toBe(true);
      expect(reconstruct(trace.entries)).toMatchObject({
        ok: false,
        error: { code: 'master-beacon-history' },
      });
    } finally {
      trace.driver.dispose();
    }
  });

  test('validates certificates before attributing any master mismatch', () => {
    const trace = history(base);
    try {
      const entries = structuredClone(trace.entries);
      required(entries[0]).certificate = [];
      const result = reconstructPrivateSeats({
        genesisEntry: base.entry,
        entries,
        engine: base.simulation.engine,
        policy: base.policy,
        secrets: [{ seat: 0, master: master(1) }],
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'private-replay-history' } });
      expect(
        reconstructPrivateSeats({
          genesisEntry: base.entry,
          entries: trace.entries,
          engine: base.simulation.engine,
          policy: base.policy,
          secrets: [{ seat: 0, master: master(1) }],
        }),
      ).toMatchObject({ ok: false, error: { code: 'master-public-key' } });
    } finally {
      trace.driver.dispose();
    }
  });
});
