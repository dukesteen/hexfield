import { fromBase64Url, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { createHashChain, scalarToBytes } from '@cp2p/crypto';
import { success } from '@cp2p/engine';
import type { Seat } from '@cp2p/engine';
import type { BeaconSecretSource } from '../beacon-contributions.js';
import type { DeckSecretSource } from '../deck-source.js';
import { createDeckSecretSource } from '../deck-source.js';
import { createStealSecretSource } from '../steal-source.js';
import type { StealSourceFactory } from '../steal-source.js';
import { genesisDeckDefinitions } from '../deck-genesis.js';
import {
  GENESIS_PREVIOUS_HASH,
  genesisBody,
  genesisId,
  signEntry,
  signVerifiedGenesis,
} from '../genesis.js';
import type { ReplayPolicy } from '../replay.js';
import type { Genesis, GenesisBody } from '../types.js';
import { createGenesisDeckFixture } from './deck-fixture.js';
import { createSimulationGenesis } from './simulation-genesis.js';

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing verified deck fixture value');
  return value;
}

/** Real 25-card ceremony with deterministic private sources for replica tests. */
export function createVerifiedDeckSession(
  seed = 317,
  humanCount = 2,
  chainLength = 128,
  options: { vpTarget?: number; boardSeed?: Uint8Array } = {},
) {
  const { vpTarget, boardSeed } = options;
  const simulation = createSimulationGenesis({
    seed,
    humanCount,
    ...(vpTarget === undefined
      ? {}
      : {
          config: {
            modules: [{ id: 'base', version: '1.0.0' }],
            seats: [0, 1, 2, 3],
            options: { base: { mapLayout: 'random', vpTarget } },
          },
        }),
  });
  const humans = simulation.genesis.seats.filter((seat) => seat.kind === 'human');
  const chains = humans.map((_, index) =>
    createHashChain(new Uint8Array(32).fill(index + 84), chainLength),
  );
  const bodyBeforeDeck: GenesisBody = {
    ...genesisBody(simulation.genesis),
    ...(boardSeed === undefined ? {} : { genesisSeed: toBase64Url(boardSeed) }),
    security: 'verified',
    commitments: {
      beaconChains: humans.map((seat, index) => ({
        seat: seat.seat,
        length: chainLength,
        tip: toBase64Url(required(required(chains[index])[0])),
      })),
    },
  };
  const deck = createGenesisDeckFixture(bodyBeforeDeck, simulation.identities);
  const body = deck.body;
  const genesis: Genesis = {
    ...body,
    gameId: genesisId(body),
    signatures: humans.map((seat) => {
      const result = signVerifiedGenesis(
        body,
        deck.transcripts,
        seat.seat,
        required(simulation.identities.get(seat.seat)).secretKey,
      );
      if (!result.ok) throw new Error(`Verified genesis signing failed: ${result.error.message}`);
      return result.value;
    }),
  };
  const state = simulation.engine.createGame(body.config, fromBase64Url(body.genesisSeed));
  const first = required(simulation.identities.get(required(humans[0]).seat));
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

  function beaconSourceFor(seat: Seat): BeaconSecretSource {
    const index = humans.findIndex((item) => item.seat === seat);
    if (index < 0) throw new Error(`Seat ${seat} is not a human beacon contributor`);
    return {
      link(epoch, linkIndex) {
        if (epoch !== 0 || linkIndex < 1 || linkIndex > chainLength)
          throw new Error('Unexpected beacon link');
        return required(required(chains[index])[linkIndex]);
      },
      extension() {
        throw new Error('The verified deck fixture exhausted its beacon chain');
      },
    };
  }

  function botKeysFor(hostSeat: Seat): ReadonlyMap<Seat, Uint8Array> {
    const host = required(simulation.identities.get(hostSeat)).peerId;
    return new Map(
      simulation.genesis.seats
        .filter((seat) => seat.kind === 'bot' && seat.botHost === host)
        .map((seat) => [seat.seat, required(simulation.identities.get(seat.seat)).secretKey]),
    );
  }

  function createDeckSourceFor(hostSeat: Seat): (deckId: string, seat: Seat) => DeckSecretSource {
    const human = required(humans.find((seat) => seat.seat === hostSeat));
    const host = required(simulation.identities.get(human.seat)).peerId;
    const owned = [
      human.seat,
      ...simulation.genesis.seats
        .filter((seat) => seat.kind === 'bot' && seat.botHost === host)
        .map((seat) => seat.seat),
    ];
    const definitions = genesisDeckDefinitions(body);
    if (!definitions.ok) throw new Error(definitions.error.message);
    const definition = required(definitions.value.find((item) => item.deckId === 'dev'));
    const masters = new Map(owned.map((seat) => [seat, scalarToBytes(BigInt(17 + seat))]));
    return (deckId, seat) => {
      if (deckId !== 'dev') throw new Error(`Unexpected deck ${deckId}`);
      const master = masters.get(seat);
      if (!master) throw new Error(`Seat ${seat} is not hosted by ${hostSeat}`);
      return createDeckSecretSource(master, definition, seat);
    };
  }

  const policy: ReplayPolicy = {
    // Genesis signatures and certified deck-pass folds check the ceremony proofs.
    genesis: { verifyCommitments: () => success(undefined) },
    entry: { verifyCommand: () => success(undefined) },
  };

  function createStealSourceFor(hostSeat: Seat): StealSourceFactory {
    const host = required(humans.find((seat) => seat.seat === hostSeat));
    return (seat) => {
      const owner = required(genesis.seats.find((item) => item.seat === seat));
      if (owner.seat !== hostSeat && (owner.kind !== 'bot' || owner.botHost !== host.publicKey))
        throw new Error(`Seat ${seat} is not hosted by ${hostSeat}`);
      return createStealSecretSource(
        scalarToBytes(BigInt(17 + seat)),
        genesis.ceremonyNonce,
        seat,
        owner.publicKey,
      );
    };
  }

  return {
    simulation,
    humans,
    chains,
    deck,
    genesis,
    entry,
    policy,
    beaconSourceFor,
    botKeysFor,
    createDeckSourceFor,
    createStealSourceFor,
    deckSetupPasses: deck.transcripts.flatMap((transcript) =>
      transcript.passes.map((pass) => ({ deckId: transcript.deckId, pass })),
    ),
  };
}

export type VerifiedDeckSession = ReturnType<typeof createVerifiedDeckSession>;
