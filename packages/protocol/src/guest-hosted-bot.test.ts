import { parsePeerId, scalarToBytes, verifyObject } from '@cp2p/crypto';
import { genesisDigest } from './genesis.js';
import type { Result, Seat } from '@cp2p/engine';
import { expect, test } from 'vitest';
import { MemoryBeaconContributionStore } from './beacon-contributions.js';
import { MemoryCheatCandidateStore } from './cheat-candidates.js';
import { MemoryCountContributionStore } from './count-contributions.js';
import { validateDeckCeremony } from './deck-genesis.js';
import type { ReplayPolicy } from './replay.js';
import { createHandSecretSource } from './hand-source.js';
import { MemoryProtocolJournal } from './journal.js';
import { P2PSession } from './p2p-session.js';
import { replayCertifiedPrefix } from './replay.js';
import { MemoryStealDeliveryStore } from './steal-contributions.js';
import { createMemnet } from './testing/memnet.js';
import { createVerifiedDeckSession } from './testing/verified-deck-session.js';
import { VerifiedSessionDriver } from './verified-session-driver.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing guest bot fixture');
  return item;
}

test('a guest host automatically signs and certifies its verified bot setup command', async () => {
  const decisions: { host: Seat; bot: Seat }[] = [];
  const fixture = createVerifiedDeckSession(317, 2, 128);
  const policy: ReplayPolicy = {
    ...fixture.policy,
    genesis: {
      verifyCommitments: (candidate) => validateDeckCeremony(candidate, fixture.deck.transcripts),
    },
  };
  const peers = fixture.humans.map((human) => human.publicKey);
  const network = createMemnet({ peers });
  const live = (
    await Promise.all(
      fixture.humans.map((human) => {
        const deckSource = fixture.createDeckSourceFor(human.seat);
        return P2PSession.create({
          decideBot: (view) => {
            decisions.push({ host: human.seat, bot: view.seat });
            return (
              fixture.simulation.engine.getLegalCommands(view.state, view.seat, view.priv)
                .commands[0] ?? null
            );
          },
          botDelayMs: 350,
          genesisEntry: fixture.entry,
          engine: fixture.simulation.engine,
          policy,
          seat: human.seat,
          secretKey: required(fixture.simulation.identities.get(human.seat)).secretKey,
          botKeys: fixture.botKeysFor(human.seat),
          transport: network.transport(human.publicKey),
          clock: network.clock,
          journal: new MemoryProtocolJournal(),
          cheatCandidateStore: new MemoryCheatCandidateStore(),
          beaconSource: fixture.beaconSourceFor(human.seat),
          beaconContributions: new MemoryBeaconContributionStore(),
          deckSetupPasses: fixture.deckSetupPasses,
          createDeckSource: deckSource,
          deckContributions: new MemoryStealDeliveryStore(),
          countContributionStore: new MemoryCountContributionStore(),
          stealDeliveryStore: new MemoryStealDeliveryStore(),
          createDriver(engine, genesis, _clock, owned) {
            return new VerifiedSessionDriver(
              engine,
              genesis,
              owned,
              deckSource,
              (seat) =>
                createHandSecretSource(
                  scalarToBytes(BigInt(71 + seat)),
                  genesisDigest(fixture.genesis),
                  seat,
                ),
              fixture.createStealSourceFor(human.seat),
            );
          },
        });
      }),
    )
  ).map(value);
  const first = required(live[0]);
  const guest = required(live[1]);
  const bot = required(fixture.genesis.seats.find((seat) => seat.seat === 3));
  expect(bot.kind).toBe('bot');
  expect(bot.kind === 'bot' && bot.botHost).toBe(required(fixture.humans[1]).publicKey);
  expect(fixture.botKeysFor(0).has(3)).toBe(false);
  expect(fixture.botKeysFor(1).has(3)).toBe(true);
  const drain = async (until: () => boolean) => {
    for (let pass = 0; pass < 128; pass += 1) {
      network.clock.advanceBy(50);
      // oxlint-disable-next-line no-await-in-loop -- Each step drains a signed consensus phase.
      await Promise.all(live.map((session) => session.flush()));
      if (until()) return;
    }
    throw new Error(`Guest bot stalled at ${first.getCommittedHead().seq}`);
  };
  try {
    await drain(() => first.getCommittedHead().seq >= 0);
    expect(first.getPrivate(3)).toBeNull();
    expect(guest.getPrivate(3)).not.toBeNull();
    const botEntries = () =>
      first
        .exportSave()
        .entries.filter(
          ({ entry }) => entry.payload.kind === 'command' && entry.payload.signed.body.seat === 3,
        );
    for (let step = 0; step < 12 && botEntries().length === 0; step += 1) {
      // oxlint-disable-next-line no-await-in-loop -- Initial private-count work must certify before setup choices.
      await drain(
        () =>
          botEntries().length > 0 ||
          first
            .getPending()
            .some(
              (pending) =>
                pending.kind === 'player' && pending.allowed.includes('PLACE_SETTLEMENT'),
            ) ||
          first
            .getPending()
            .some((pending) => pending.kind === 'player' && pending.allowed.includes('PLACE_ROAD')),
      );
      if (botEntries().length > 0) break;
      const active = first.getState().turn.activeSeat;
      if (active === 0 || active === 1) {
        const owner = required(live[active]);
        const command = required(owner.getLegalCommands(active).commands[0]);
        const completion: { current: Result<void> | null } = { current: null };
        void owner.submit(active, command).then((result) => {
          completion.current = result;
          return undefined;
        });
        // oxlint-disable-next-line no-await-in-loop -- Setup choices depend on the certified predecessor.
        await drain(() => completion.current !== null);
        value(required(completion.current));
      } else {
        const prior = first.getCommittedHead().seq;
        // oxlint-disable-next-line no-await-in-loop -- Production delayed bot scheduler owns this action.
        await drain(() => first.getCommittedHead().seq > prior);
      }
    }
    const entry = required(botEntries()[0]).entry;
    if (entry.payload.kind !== 'command') throw new Error('Expected bot command');
    const signed = entry.payload.signed;
    expect(signed.body.command.type).toBe('PLACE_SETTLEMENT');
    expect(verifyObject('cmd', signed.body, signed.sig, parsePeerId(bot.publicKey))).toBe(true);
    expect(decisions).toContainEqual({ host: 1, bot: 3 });
    expect(decisions).not.toContainEqual({ host: 0, bot: 3 });
    const head = first.getCommittedHead();
    await drain(() => live.every((session) => session.getCommittedHead().seq >= head.seq));
    const entries = first.exportSave().entries.map(({ entry: item }) => item);
    for (const session of live) {
      const saved = session.exportSave();
      expect(saved.entries.map(({ entry: item }) => item)).toEqual(entries);
      expect(session.getCommittedHead()).toEqual(first.getCommittedHead());
      expect(
        value(
          replayCertifiedPrefix(fixture.entry, saved.entries, fixture.simulation.engine, policy),
        ).context.log.state,
      ).toEqual(first.getState());
    }
  } finally {
    live.forEach((session) => session.dispose());
    network.dispose();
  }
}, 60000);
