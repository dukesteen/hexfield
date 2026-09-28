import { fromBase64Url } from '@cp2p/codec';
import { isPublicDraw, publicDrawInput } from '@cp2p/engine';
import type { GameConfig, GameState, Result, Seat } from '@cp2p/engine';
import { resolveArtifactSigner } from '../authority.js';
import { decodePublicDeckCard } from '../deck-draw.js';
import type { DealtDeckCard, DeckDrawOperation, SignedDeckUnlock } from '../deck-draw.js';
import { createDeckGenesisCommitment, genesisDeckDefinitions } from '../deck-genesis.js';
import {
  DECK_DRAW_PROTOCOL,
  applyDeckSetupEntry,
  captureDeckPending,
  completeDeckDeal,
  initializeDeckLedger,
} from '../deck-ledger.js';
import type { DeckLedger } from '../deck-ledger.js';
import { prepareDeckUnlock } from '../deck-outbox.js';
import type { DeckContributionStore } from '../deck-outbox.js';
import { createDeckSecretSource } from '../deck-source.js';
import type { Genesis } from '../types.js';
import { createDeckPasses } from './deck-fixture.js';
import { createSimulationGenesis } from './simulation-genesis.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function need<T>(item: T | undefined | null): T {
  if (item === undefined || item === null) throw new Error('Missing public draw fixture value');
  return item;
}

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

export interface CertifiedPublicDraw {
  deck: string;
  card: string;
  /** The request's other fields, such as the hex a fog tile lands on. */
  request: Readonly<Record<string, unknown>>;
}

export interface CertifiedPublicDraws {
  /** Genesis, before `prepare`. Two runs with one seed share it whatever their secrets. */
  initial: GameState;
  state: GameState;
  draws: CertifiedPublicDraw[];
}

export interface CertifiedPublicDrawOptions {
  seed: number;
  config: GameConfig;
  /** Each seat's deck master secret. It alone decides the order of every hidden deck. */
  master: (seat: Seat) => Uint8Array;
  /** Set up a position with a public draw pending, from genesis. */
  prepare?: (state: GameState) => GameState;
  /** Stop after this many draws. */
  maxDraws?: number;
}

/**
 * Run the real deck ceremony for every declared deck among all-human seats, then answer every
 * pending public draw through the certified path: capture, every seat's unlock, decode from the
 * chain, ledger verification and the engine input. Test-only, since it holds every master.
 */
export async function certifyPublicDraws(
  options: CertifiedPublicDrawOptions,
): Promise<CertifiedPublicDraws> {
  const seats = options.config.seats;
  const sim = createSimulationGenesis({
    seed: options.seed,
    config: options.config,
    humanCount: seats.length,
  });
  const definitions = value(genesisDeckDefinitions(sim.genesis));
  const passes = new Map(
    definitions.map((definition) => [
      definition.deckId,
      createDeckPasses(definition, sim.identities, options.master),
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
  const initial = sim.engine.createGame(genesis.config, fromBase64Url(genesis.genesisSeed));
  let ledger: DeckLedger = value(initializeDeckLedger(genesis, initial));
  for (const definition of definitions)
    for (const pass of need(passes.get(definition.deckId)))
      ledger = value(applyDeckSetupEntry(ledger, { deckId: definition.deckId, pass }));
  const signers = seats.map((seat) => value(resolveArtifactSigner(undefined, genesis, 0, seat)));

  async function unlockAll(
    active: DeckLedger,
    operation: DeckDrawOperation,
  ): Promise<SignedDeckUnlock[]> {
    const definition = need(definitions.find((item) => item.deckId === operation.deckId));
    const setup = need(
      active.decks.find((deck) => deck.commitment.definition.deckId === definition.deckId),
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
        options.master(participant.seat),
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
            need(sim.identities.get(participant.seat)).secretKey,
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

  let state = options.prepare ? options.prepare(initial) : initial;
  const draws: CertifiedPublicDraw[] = [];
  for (;;) {
    const pending = sim.engine.getPending(state).find(isPublicDraw);
    if (!pending || draws.length >= (options.maxDraws ?? Number.POSITIVE_INFINITY)) break;
    const step = draws.length;
    const captured = value(
      captureDeckPending(ledger, state, pending, { seq: 100 + step, hash: 'a'.repeat(64) }, 0),
    );
    const operation = need(captured.active);
    // oxlint-disable-next-line no-await-in-loop -- Each reveal follows the certified previous one.
    const unlocks = await unlockAll(captured, operation);
    const deck = need(
      captured.decks.find((item) => item.commitment.definition.deckId === operation.deckId),
    );
    const receipt: DealtDeckCard = {
      operation,
      point: need(unlocks.at(-1)).body.point,
      unlocks,
    };
    const card = value(decodePublicDeckCard(deck.setup, receipt, signers)).card;
    const input = publicDrawInput(pending, card);
    ledger = value(
      completeDeckDeal(
        captured,
        state,
        pending,
        input,
        { kind: 'proof', protocol: DECK_DRAW_PROTOCOL, data: unlocks },
        { seq: 101 + step, hash: 'b'.repeat(64) },
        signers,
      ),
    );
    state = value(sim.engine.apply(state, input)).state;
    draws.push({ deck: operation.deckId, card, request: pending.request });
  }
  return { initial, state, draws };
}
