import { canonicalEncode } from '@cp2p/codec';
import { parsePeerId, scalarToBytes, verifyObject } from '@cp2p/crypto';
import type { Result, Seat } from '@cp2p/engine';
import { expect, test } from 'vitest';
import { createBeaconSecretSource } from './beacon-source.js';
import { MemoryBeaconContributionStore } from './beacon-contributions.js';
import { MemoryCheatCandidateStore } from './cheat-candidates.js';
import { MemoryCountContributionStore } from './count-contributions.js';
import { createConsensusState } from './consensus.js';
import { deckCeremonyId } from './deck-genesis.js';
import { createDeckSecretSource } from './deck-source.js';
import { entryHash, genesisDigest } from './genesis.js';
import { MemoryGenesisConsentStore } from './genesis-outbox.js';
import { createHandSecretSource } from './hand-source.js';
import { MemoryProtocolJournal } from './journal.js';
import { P2PSession } from './p2p-session.js';
import type { P2PSessionOptions } from './p2p-session.js';
import { replayCertifiedPrefix } from './replay.js';
import { MemoryStealDeliveryStore } from './steal-contributions.js';
import { createStealSecretSource } from './steal-source.js';
import { createMemnet } from './testing/memnet.js';
import {
  advanceRecoveryFixture,
  createRecoveryFixture,
  recoveryFixtureKey,
} from './testing/recovery-fixture.js';
import { VerifiedSessionDriver } from './verified-session-driver.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | undefined | null): T {
  if (item === undefined || item === null) throw new Error('Missing recovery session fixture');
  return item;
}

const master = (owner: Seat) => scalarToBytes(BigInt(17 + owner));

test('a surviving session recovers a bot, finishes the frozen beacon and resumes it after restart', async () => {
  const fixture = createRecoveryFixture({ masterBackedBeacon: true, chainLength: 4 });
  const seats = [1, 2, 3] as const;
  const network = createMemnet({
    peers: fixture.genesis.seats.map(({ publicKey }) => publicKey),
  });
  const sessions = new Map<Seat, P2PSession>();
  const options = new Map<Seat, P2PSessionOptions>();
  const providers: ReturnType<typeof createBeaconSecretSource>[] = [];
  let botMayMove = true;
  const decisions: { seat: Seat; level: string }[] = [];

  async function pumpUntil(condition: () => boolean, limit = 100): Promise<void> {
    for (let tick = 0; tick < limit; tick += 1) {
      // Each delivery batch must settle before the next virtual-time tick.
      // oxlint-disable-next-line no-await-in-loop
      await Promise.all([...sessions.values()].map((session) => session.flush()));
      if (condition()) return;
      network.clock.advanceBy(250);
      // oxlint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(
      `Recovery did not converge: ${JSON.stringify(
        [...sessions].map(([seat, session]) => ({
          seat,
          head: session.getCommittedHead(),
          status: session.getProtocolStatus(),
        })),
      )}`,
    );
  }

  try {
    for (const seat of seats) {
      const journal = new MemoryProtocolJournal();
      let context = fixture.beforeSetup;
      expect(
        // oxlint-disable-next-line no-await-in-loop -- Preload each independent journal with its certified ancestry.
        await journal.initialize(
          fixture.genesisEntry,
          canonicalEncode(value(createConsensusState(context, seat))),
        ),
      ).toBe(true);
      for (const certified of fixture.deckEntries) {
        const next = advanceRecoveryFixture(context, certified);
        expect(
          // oxlint-disable-next-line no-await-in-loop -- Each durable commit depends on the preceding parent.
          await journal.commit(
            certified.entry.seq,
            0,
            certified,
            canonicalEncode(value(createConsensusState(next, seat))),
          ),
        ).toBe(true);
        context = next;
      }
      const store = new MemoryGenesisConsentStore();
      const stealSource = (owner: Seat) =>
        createStealSecretSource(
          master(owner),
          fixture.genesis.ceremonyNonce,
          owner,
          required(fixture.genesis.seats.find((item) => item.seat === owner)).publicKey,
        );
      const deckSource = (deckId: string, owner: Seat) =>
        createDeckSecretSource(
          master(owner),
          required(
            fixture.ready.log.crypto?.decks.decks.find(
              (deck) => deck.commitment.definition.deckId === deckId,
            ),
          ).commitment.definition,
          owner,
        );
      const beacon = createBeaconSecretSource(
        master(seat),
        { ceremonyId: deckCeremonyId(fixture.genesis), seat },
        4,
      );
      providers.push(beacon);
      const current: P2PSessionOptions = {
        genesisEntry: fixture.genesisEntry,
        engine: fixture.source.engine,
        policy: fixture.policy,
        seat,
        secretKey: recoveryFixtureKey(fixture, seat),
        transport: network.transport(required(fixture.source.identities.get(seat)).peerId),
        clock: network.clock,
        journal,
        cheatCandidateStore: new MemoryCheatCandidateStore(),
        beaconSource: beacon.source,
        beaconContributions: new MemoryBeaconContributionStore(),
        createDeckSource: deckSource,
        deckContributions: store,
        countContributionStore: new MemoryCountContributionStore(),
        stealDeliveryStore: new MemoryStealDeliveryStore(),
        recoveryStore: store,
        recoveryParticipant: {
          store,
          privateEntropy: () => new Uint8Array(32).fill(100 + seat),
          encryptionSecret: () => {
            const source = stealSource(seat);
            try {
              return source.encryptionSecret();
            } finally {
              source.dispose();
            }
          },
        },
        createDriver: (engine, genesis, _clock, owned) =>
          new VerifiedSessionDriver(
            engine,
            genesis,
            owned,
            deckSource,
            (owner) => createHandSecretSource(master(owner), genesisDigest(genesis), owner),
            stealSource,
          ),
        botDelayMs: 100,
        decideBot: (view, _pending, level) => {
          expect(seat).toBe(1);
          expect(view.seat).toBe(0);
          if (!botMayMove) return null;
          const command = fixture.source.engine
            .getLegalCommands(view.state, view.seat, view.priv)
            .commands.find((item) => ['PLACE_SETTLEMENT', 'PLACE_ROAD'].includes(item.type));
          if (command) {
            decisions.push({ seat: view.seat, level });
            botMayMove = false;
          }
          return command ?? null;
        },
      };
      options.set(seat, current);
      // oxlint-disable-next-line no-await-in-loop -- Each restored session keeps its own durable safety record.
      sessions.set(seat, value(await P2PSession.restore(current)));
    }

    const host = required(sessions.get(1));
    const submitted = host.requestTakeover(0, 'medium');
    await pumpUntil(() =>
      ([2, 3] as const).every((seat) => required(sessions.get(seat)).getRecoveryCandidate()),
    );
    const authorization = required(required(sessions.get(2)).getRecoveryCandidate()).change;
    const replacementKey = required(authorization.statement.replacements[0]).publicKey;
    const approvals = await Promise.all(
      ([2, 3] as const).map((seat) =>
        required(sessions.get(seat)).approveRecoveryAuthorization(authorization),
      ),
    );
    expect(approvals.every((result) => result.ok)).toBe(true);
    await pumpUntil(() =>
      [...sessions.values()].every((session) => {
        const history = session.exportSave();
        return history.entries.some(({ entry }) => entry.payload.kind === 'system');
      }),
    );
    expect(await submitted).toEqual({ ok: true, value: undefined });
    expect(host.getPrivate(0)).not.toBeNull();
    expect(required(sessions.get(2)).getPrivate(0)).toBeNull();
    expect(required(sessions.get(3)).getPrivate(0)).toBeNull();
    expect(host.getState().seats.find(({ seat }) => seat === 0)?.status).toBe('bot');
    for (const seat of [2, 3] as const) {
      const validation = required(sessions.get(seat)).validate(seat, { type: 'END_TURN' });
      expect(validation.ok ? undefined : validation.error.code).not.toBe(
        'session-recovery-loading',
      );
    }

    // Advance only the setup choices needed to reach the recovered seat.
    for (let move = 0; decisions.length === 0 && move < 8; move += 1) {
      const active = host.getState().turn.activeSeat;
      if (active === 0) {
        // oxlint-disable-next-line no-await-in-loop
        await pumpUntil(() => decisions.length > 0);
        break;
      }
      const actor = required(sessions.get(active));
      const command = required(
        actor
          .getLegalCommands(active)
          .commands.find((item) => ['PLACE_SETTLEMENT', 'PLACE_ROAD'].includes(item.type)),
      );
      const seq = host.getCommittedHead().seq;
      const pending = actor.submit(active, command);
      // oxlint-disable-next-line no-await-in-loop
      await pumpUntil(() =>
        [...sessions.values()].every((session) => session.getCommittedHead().seq > seq),
      );
      // oxlint-disable-next-line no-await-in-loop
      expect(await pending).toEqual({ ok: true, value: undefined });
    }
    await pumpUntil(() =>
      host
        .exportSave()
        .entries.some(
          ({ entry }) => entry.payload.kind === 'command' && entry.payload.signed.body.seat === 0,
        ),
    );
    expect(decisions).toEqual([{ seat: 0, level: 'medium' }]);
    const saved = host.exportSave();
    const rebuilt = value(
      replayCertifiedPrefix(saved.genesis, saved.entries, fixture.source.engine, fixture.policy),
    );
    expect(rebuilt.context.membership.epoch).toBe(2);
    expect(rebuilt.context.membership.voters.map(({ seat }) => seat)).toEqual([1, 2, 3]);
    const commandEntry = required(
      saved.entries.find(
        ({ entry }) => entry.payload.kind === 'command' && entry.payload.signed.body.seat === 0,
      ),
    ).entry;
    if (commandEntry.payload.kind !== 'command') throw new Error('Expected recovered bot command');
    const { body, sig } = commandEntry.payload.signed;
    expect(verifyObject('cmd', body, sig, parsePeerId(replacementKey))).toBe(true);
    expect(
      verifyObject('cmd', body, sig, parsePeerId(required(fixture.genesis.seats[0]).publicKey)),
    ).toBe(false);

    const hand = host.getPrivate(0);
    const head = host.getCommittedHead();
    await pumpUntil(() =>
      [...sessions.values()].every((session) => session.getCommittedHead().hash === head.hash),
    );
    host.dispose();
    botMayMove = true;
    const restored = value(await P2PSession.restore(required(options.get(1))));
    sessions.set(1, restored);
    expect(restored.getPrivate(0)).toEqual(hand);
    expect(restored.getCommittedHead()).toEqual(head);
    await pumpUntil(
      () =>
        decisions.length === 2 &&
        [...sessions.values()].every((session) => session.getCommittedHead().seq > head.seq),
    );
    const finalHead = restored.getCommittedHead();
    expect(
      [...sessions.values()].every((session) => session.getCommittedHead().hash === finalHead.hash),
    ).toBe(true);
    const record = required(await required(options.get(1)).journal.load());
    expect(entryHash(required(record.entries.at(-1)).entry)).toBe(finalHead.hash);
  } finally {
    for (const session of sessions.values()) session.dispose();
    for (const provider of providers) provider.dispose();
    network.dispose();
  }
}, 60_000);
