import { fromBase64Url, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { createHashChain, identityFromSecret, scalarToBytes, signObject } from '@cp2p/crypto';
import { success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import { createBeaconSecretSource } from '../beacon-source.js';
import { completeBeaconState, getBeaconOperation } from '../beacon-state.js';
import { signBeaconReveal } from '../beacon.js';
import { BEACON_EVIDENCE_PROTOCOL } from '../crypto-context.js';
import { deckCeremonyId } from '../deck-genesis.js';
import {
  GENESIS_PREVIOUS_HASH,
  entryHash,
  genesisBody,
  genesisDigest,
  genesisId,
  signEntry,
  signVerifiedGenesis,
} from '../genesis.js';
import { advanceContext, proposerFor, validateCertifiedEntry } from '../proposal.js';
import type { CertifiedEntry, ProposalContext } from '../proposal.js';
import {
  RECOVERY_CHECK_DOMAIN,
  RECOVERY_READINESS_DOMAIN,
  recoveryCheckDigest,
} from '../recovery-membership.js';
import type {
  RecoveryActivation,
  RecoveryAuthorization,
  RecoveryReadiness,
} from '../recovery-types.js';
import { initialProposalContext } from '../replay.js';
import type { ReplayPolicy } from '../replay.js';
import type { EntryPayload, Genesis, LogEntry } from '../types.js';
import { signVote } from '../votes.js';
import { createGenesisDeckFixture } from './deck-fixture.js';
import { createSimulationGenesis } from './simulation-genesis.js';

const humanSeats = [0, 1, 2, 3] as const;
const remainingSeats = [1, 2, 3] as const;

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing recovery fixture value');
  return item;
}

export function recoveryFixtureRef(entry: LogEntry) {
  return { seq: entry.seq, hash: entryHash(entry) };
}

/** Signed four-human genesis and its exact certified deck-pass ancestry. */
export function createRecoveryFixture(
  options: {
    seed?: number;
    masterBackedBeacon?: boolean;
    chainLength?: number;
    vpTarget?: number;
    lobbyId?: string;
    offlineSeat?: Seat | null;
  } = {},
) {
  const chainLength = options.chainLength ?? 2;
  const source = createSimulationGenesis({
    seed: options.seed ?? 91,
    humanCount: 4,
    ...(options.vpTarget === undefined
      ? {}
      : {
          config: {
            modules: [{ id: 'base', version: '1.0.0' }],
            seats: [0, 1, 2, 3],
            options: { base: { mapLayout: 'random', vpTarget: options.vpTarget } },
          },
        }),
  });
  const base = { ...genesisBody(source.genesis), security: 'verified' as const, commitments: {} };
  const deck = createGenesisDeckFixture(base, source.identities, options.lobbyId);
  const chains = humanSeats.map((seat) => {
    if (!options.masterBackedBeacon)
      return createHashChain(new Uint8Array(32).fill(seat + 29), chainLength).map((link) =>
        link.slice(),
      );
    const provider = createBeaconSecretSource(
      scalarToBytes(BigInt(17 + seat)),
      { ceremonyId: deckCeremonyId(deck.body), seat },
      chainLength,
    );
    try {
      return [
        provider.initialCommitment.tip,
        ...Array.from({ length: chainLength }, (_, offset) => provider.source.link(0, offset + 1)),
      ];
    } finally {
      provider.dispose();
    }
  });
  const body = {
    ...deck.body,
    commitments: {
      ...deck.body.commitments,
      beaconChains: humanSeats.map((seat) => ({
        seat,
        length: chainLength,
        tip: toBase64Url(required(required(chains[seat])[0])),
      })),
    },
  };
  const signatures = humanSeats.map((seat) =>
    value(
      signVerifiedGenesis(
        body,
        deck.transcripts,
        seat,
        required(source.identities.get(seat)).secretKey,
      ),
    ),
  );
  const genesis: Genesis = { ...body, gameId: genesisId(body), signatures };
  const state = source.engine.createGame(genesis.config, fromBase64Url(genesis.genesisSeed));
  const first = required(source.identities.get(0));
  const genesisEntry = signEntry(
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
  const policy: ReplayPolicy = {
    genesis: { verifyCommitments: () => success(undefined) },
    entry: { verifySystem: () => success(undefined), verifyCommand: () => success(undefined) },
  };
  const beforeSetup = value(initialProposalContext(genesisEntry, source.engine, policy));
  const fixture = { source, genesis, genesisEntry, deck, chains, policy, beforeSetup };
  const deckEntries: CertifiedEntry[] = [];
  let context = beforeSetup;
  for (const transcript of deck.transcripts) {
    for (const pass of transcript.passes) {
      const entry = signRecoveryFixtureEntry(
        fixture,
        context,
        {
          kind: 'crypto',
          action: 'deck-pass',
          evidence: { deckId: transcript.deckId, pass },
        },
        context.log.head.stateHash,
      );
      const certified = certifyRecoveryFixtureEntry(fixture, context, entry, humanSeats);
      context = advanceRecoveryFixture(context, certified);
      deckEntries.push(certified);
    }
  }
  if (!context.log.crypto?.beacon.active)
    throw new Error('Verified genesis did not freeze the initial beacon request');
  if (options.offlineSeat !== null) {
    const marker = certifyRecoveryFixtureOffline(fixture, context, options.offlineSeat ?? 0);
    context = advanceRecoveryFixture(context, marker);
    deckEntries.push(marker);
  }
  return { ...fixture, deckEntries, ready: context };
}

export type RecoveryFixture = ReturnType<typeof createRecoveryFixture>;

export function recoveryFixtureKey(
  fixture: Pick<RecoveryFixture, 'source'>,
  seat: Seat,
): Uint8Array {
  return required(fixture.source.identities.get(seat)).secretKey;
}

export function signRecoveryFixtureEntry(
  fixture: Pick<RecoveryFixture, 'source'>,
  context: ProposalContext,
  payload: EntryPayload,
  stateHash: string,
  term = 1,
): LogEntry {
  const elected = proposerFor(
    context.log.head.seq + 1,
    term,
    context.membership,
    context.excludedProposers,
  );
  return signEntry(
    {
      seq: context.log.head.seq + 1,
      term,
      prevHash: entryHash(context.log.head),
      payload,
      stateHash,
      sequencer: elected.publicKey,
    },
    recoveryFixtureKey(fixture, elected.seat),
  );
}

export function certifyRecoveryFixtureEntry(
  fixture: Pick<RecoveryFixture, 'source'>,
  context: ProposalContext,
  entry: LogEntry,
  seats: readonly Seat[],
): CertifiedEntry {
  return {
    entry,
    certificate: seats.map((seat) =>
      signVote(
        {
          genesisDigest: context.membership.genesisDigest,
          epoch: context.membership.epoch,
          seat,
          seq: entry.seq,
          term: entry.term,
          phase: 'precommit',
          valueHash: entryHash(entry),
        },
        recoveryFixtureKey(fixture, seat),
      ),
    ),
  };
}

export function advanceRecoveryFixture(
  context: ProposalContext,
  certified: CertifiedEntry,
): ProposalContext {
  return value(advanceContext(context, value(validateCertifiedEntry(certified, context))));
}

/** Certify the public marker required before a seat may be recovered. */
export function certifyRecoveryFixtureOffline(
  fixture: Pick<RecoveryFixture, 'source'>,
  context: ProposalContext,
  seat: Seat = 0,
): CertifiedEntry {
  const entry = signRecoveryFixtureEntry(
    fixture,
    context,
    { kind: 'membership', change: { kind: 'seat-offline', seat } },
    context.log.head.stateHash,
  );
  return certifyRecoveryFixtureEntry(fixture, context, entry, humanSeats);
}

/** Certify the fixture's frozen first random result without bypassing beacon proofs. */
export function certifyRecoveryFixtureFirstBeacon(
  fixture: RecoveryFixture,
  context: ProposalContext,
): CertifiedEntry {
  if (!context.log.crypto) throw new Error('Fixture beacon context is missing');
  const operation = value(getBeaconOperation(context.log.crypto.beacon));
  const reveals = humanSeats.map((seat) =>
    signBeaconReveal(
      operation,
      seat,
      required(required(fixture.chains[seat])[1]),
      recoveryFixtureKey(fixture, seat),
    ),
  );
  const completed = value(
    completeBeaconState(context.log.crypto.beacon, reveals, context.log.state, {
      seq: context.log.head.seq + 1,
      hash: 'c'.repeat(64),
    }),
  );
  if (completed.outcome.kind !== 'system')
    throw new Error('Fixture beacon did not produce a system input');
  const applied = value(fixture.source.engine.apply(context.log.state, completed.outcome.input));
  const entry = signRecoveryFixtureEntry(
    fixture,
    context,
    {
      kind: 'system',
      input: completed.outcome.input,
      evidence: { kind: 'proof', protocol: BEACON_EVIDENCE_PROTOCOL, data: reveals },
    },
    toHex(hashValue(applied.state)),
  );
  return certifyRecoveryFixtureEntry(fixture, context, entry, humanSeats);
}

export function recoveryFixtureReadiness(
  fixture: Pick<RecoveryFixture, 'genesis'>,
  context: ProposalContext,
  replacementKey: string,
  previous: RecoveryReadiness['previous'] = null,
): RecoveryReadiness {
  return {
    genesisDigest: genesisDigest(fixture.genesis),
    parent: recoveryFixtureRef(context.log.head),
    nextEpoch: context.membership.epoch + 1,
    departedSeat: 0,
    hostSeat: 1,
    botLevel: 'medium',
    replacements: [{ seat: 0, publicKey: replacementKey }],
    recoverers: remainingSeats.map((seat) => ({
      seat,
      publicKey: required(fixture.genesis.seats[seat]).publicKey,
    })),
    previous,
  };
}

export function signRecoveryFixtureAuthorization(
  fixture: Pick<RecoveryFixture, 'source'>,
  statement: RecoveryReadiness,
  replacementSecret: Uint8Array,
): RecoveryAuthorization {
  return {
    kind: 'recovery-authorize',
    statement,
    hostSig: signObject(RECOVERY_READINESS_DOMAIN, statement, recoveryFixtureKey(fixture, 1)),
    keySigs: [
      {
        seat: 0,
        sig: signObject(RECOVERY_READINESS_DOMAIN, statement, replacementSecret),
      },
    ],
  };
}

export function signRecoveryFixtureActivation(
  fixture: Pick<RecoveryFixture, 'genesis' | 'source'>,
  context: ProposalContext,
  authorizationEntry: LogEntry,
): RecoveryActivation {
  const authorization = recoveryFixtureRef(authorizationEntry);
  const statement = {
    genesisDigest: genesisDigest(fixture.genesis),
    parent: recoveryFixtureRef(context.log.head),
    nextEpoch: context.membership.epoch + 1,
    authorization,
    checkDigest: recoveryCheckDigest(context.log, authorization),
  };
  return {
    kind: 'recovery-activate',
    statement,
    checks: remainingSeats.map((seat) => ({
      seat,
      sig: signObject(RECOVERY_CHECK_DOMAIN, statement, recoveryFixtureKey(fixture, seat)),
    })),
  };
}

export function recoveryFixtureReplacement(byte: number) {
  return identityFromSecret(new Uint8Array(32).fill(byte));
}
