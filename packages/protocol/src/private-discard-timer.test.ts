import { parsePeerId, verifyObject } from '@cp2p/crypto';
import { RESOURCES } from '@cp2p/engine';
import type { CommandShape, Result, Seat } from '@cp2p/engine';
import { expect, test } from 'vitest';
import { MemoryProtocolJournal } from './journal.js';
import { P2PSession } from './p2p-session.js';
import { replayCertifiedPrefix } from './replay.js';
import { createMemnet } from './testing/memnet.js';
import { createVerifiedNetworkFixture } from './testing/verified-network-fixture.js';

function required<T>(input: T | null | undefined): T {
  if (input === null || input === undefined) throw new Error('Missing discard timer fixture');
  return input;
}
function value<T>(input: Result<T>): T {
  if (!input.ok) throw new Error(`${input.error.code}: ${input.error.message}`);
  return input.value;
}

test('verified hidden-hand timer signs only the owner discard after local expiry', async () => {
  const fixture = createVerifiedNetworkFixture({
    seed: 42,
    discardLimit: 0,
    turnTimer: { preRollSec: 600, mainSec: 600, discardSec: 30, robberSec: 600 },
  });
  const humans = fixture.genesis.seats;
  const network = createMemnet({ peers: humans.map((seat) => seat.publicKey) });
  const journals = humans.map(() => new MemoryProtocolJournal());
  const sessions = (
    await Promise.all(
      humans.map((seat, index) =>
        P2PSession.create({
          ...fixture.sessionOptions(seat.seat),
          seat: seat.seat,
          secretKey: required(fixture.identities.get(seat.seat)).secretKey,
          transport: network.transport(seat.publicKey),
          clock: network.clock,
          journal: required(journals[index]),
        }),
      ),
    )
  ).map(value);
  const first = required(sessions[0]);
  const drain = async (until: () => boolean) => {
    for (let pass = 0; pass < 256; pass += 1) {
      network.clock.advanceBy(0);
      // oxlint-disable-next-line no-await-in-loop -- Drain genuinely signed consensus without advancing local expiry.
      await Promise.all(sessions.map((session) => session.flush()));
      if (until()) return;
    }
    throw new Error(
      `Discard trace stalled at ${first.getCommittedHead().seq}/${first.getState().turn.phase.at(-1)?.id}`,
    );
  };
  const submit = async (seat: Seat, command: CommandShape) => {
    const completion: { current: Result<void> | null } = { current: null };
    void required(sessions[seat])
      .submit(seat, command)
      .then((result) => {
        completion.current = result;
        return undefined;
      });
    await drain(() => completion.current !== null);
    value(required(completion.current));
  };
  try {
    await drain(() => sessions.every((session) => session.getCommittedHead().seq >= 0));
    let rolls = 0;
    const hiddenDiscard = () =>
      first.getState().turn.phase.at(-1)?.id === 'discard' &&
      first
        .getPending()
        .some(
          (pending) =>
            pending.kind === 'player' &&
            pending.allowed.includes('DISCARD') &&
            first
              .getState()
              .seats.some(
                (holder) =>
                  holder.seat === pending.seat &&
                  holder.resources.total >= 2 &&
                  RESOURCES.some(
                    (resource) => holder.resources.min[resource] !== holder.resources.max[resource],
                  ),
              ),
        );
    for (let choice = 0; choice < 120 && !hiddenDiscard(); choice += 1) {
      // oxlint-disable-next-line no-await-in-loop -- Wait for genuine beacon/result certification before choosing again.
      await drain(
        () =>
          hiddenDiscard() ||
          first
            .getPending()
            .some(
              (item) =>
                item.kind === 'player' && item.allowed.some((type) => type !== 'CLAIM_VICTORY'),
            ),
      );
      if (hiddenDiscard()) break;
      const pending =
        first
          .getPending()
          .find(
            (item) =>
              item.kind === 'player' &&
              item.seat === first.getState().turn.activeSeat &&
              item.allowed.some((type) => type !== 'CLAIM_VICTORY'),
          ) ??
        first
          .getPending()
          .find(
            (item) =>
              item.kind === 'player' && item.allowed.some((type) => type !== 'CLAIM_VICTORY'),
          );
      if (!pending || pending.kind !== 'player') throw new Error('Missing legal setup/roll choice');
      const owner = required(sessions[pending.seat]);
      const state = first.getState();
      const hand = required(owner.getPrivate(pending.seat)).hand;
      const legal = fixture.engine.getLegalCommands(
        state,
        pending.seat,
        required(owner.getPrivate(pending.seat)),
      );
      let command: CommandShape | undefined;
      if (pending.allowed.includes('DISCARD')) {
        let remaining = Math.floor(
          required(state.seats.find((holder) => holder.seat === pending.seat)).resources.total / 2,
        );
        const cards: Record<string, number> = {};
        for (const resource of RESOURCES) {
          cards[resource] = Math.min(hand[resource] ?? 0, remaining);
          remaining -= cards[resource];
        }
        command = { type: 'DISCARD', cards };
      }
      command ??= legal.commands.find((item) => item.type === 'STEAL');
      command ??= legal.commands.find((item) => {
        if (item.type !== 'MOVE_ROBBER') return false;
        const moved = fixture.engine.apply(state, {
          kind: 'command',
          seat: pending.seat,
          command: item,
        });
        return (
          moved.ok &&
          fixture.engine
            .getPending(moved.value.state)
            .some((next) => next.kind === 'player' && next.allowed.includes('STEAL'))
        );
      });
      command ??=
        legal.commands.find((item) => item.type === 'ROLL_DICE') ??
        legal.commands.find((item) => item.type === 'END_TURN') ??
        legal.commands[0];
      if (required(command).type === 'ROLL_DICE') rolls += 1;
      // oxlint-disable-next-line no-await-in-loop -- Each legal command extends the certified history, including the first hidden steal.
      await submit(pending.seat, required(command));
    }
    expect(hiddenDiscard()).toBe(true);
    expect(first.getState().turn.phase.at(-1)?.id).toBe('discard');
    expect(rolls).toBeGreaterThan(0);
    await drain(() =>
      sessions.every(
        (session) => session.getCommittedHead().hash === first.getCommittedHead().hash,
      ),
    );
    const parent = first.getCommittedHead();
    const before = structuredClone(first.getState());
    const hands = sessions.map((session, index) =>
      structuredClone(required(session.getPrivate(required(humans[index]).seat)).hand),
    );
    const discarders = first
      .getPending()
      .filter((item) => item.kind === 'player' && item.allowed.includes('DISCARD'));
    expect(discarders.length).toBeGreaterThan(0);
    const chosen = required(
      discarders.find(
        (pending) =>
          pending.kind === 'player' &&
          first
            .getState()
            .seats.some(
              (holder) =>
                holder.seat === pending.seat &&
                holder.resources.total >= 2 &&
                RESOURCES.some(
                  (resource) => holder.resources.min[resource] !== holder.resources.max[resource],
                ),
            ),
      ),
    );
    if (chosen.kind !== 'player') throw new Error('Expected private discard');
    const foreign = required(sessions[(chosen.seat + 1) % sessions.length]);
    expect(foreign.getPrivate(chosen.seat)).toBeNull();
    const privateHand = required(required(sessions[chosen.seat]).getPrivate(chosen.seat)).hand;
    let remaining = Math.floor(
      required(before.seats.find((holder) => holder.seat === chosen.seat)).resources.total / 2,
    );
    const cards: Record<string, number> = {};
    for (const resource of RESOURCES) {
      cards[resource] = Math.min(privateHand[resource] ?? 0, remaining);
      remaining -= cards[resource];
    }
    const legalDiscard: CommandShape = { type: 'DISCARD', cards };
    expect(
      fixture.engine.validate(before, { kind: 'command', seat: chosen.seat, command: legalDiscard })
        .ok,
    ).toBe(true);
    expect(
      fixture.engine.validate(before, {
        kind: 'system',
        type: 'TIMEOUT',
        seat: chosen.seat,
        phase: 'discard',
      }),
    ).toMatchObject({ ok: false, error: { code: 'private-discard-required' } });
    expect((await foreign.submit(chosen.seat, legalDiscard)).ok).toBe(false);
    expect(first.getCommittedHead()).toEqual(parent);
    const expiry = Math.min(
      ...first
        .getTimers()
        .filter((timer) => timer.phase === 'discard')
        .map((timer) => required(timer.expiresAt)),
    );
    network.clock.advanceBy(expiry - network.clock.now() - 1);
    await drain(() => true);
    expect(sessions.map((session) => session.getCommittedHead())).toEqual(
      sessions.map(() => parent),
    );
    network.clock.advanceBy(1);
    await drain(
      () =>
        first.getState().turn.phase.at(-1)?.id !== 'discard' &&
        sessions.every(
          (session) => session.getCommittedHead().hash === first.getCommittedHead().hash,
        ),
    );
    const entries = first.exportSave().entries;
    const after = first.getState();
    const discards = entries.filter(
      ({ entry }) =>
        entry.seq > parent.seq &&
        entry.payload.kind === 'command' &&
        entry.payload.signed.body.command.type === 'DISCARD',
    );
    expect(discards).toHaveLength(discarders.length);
    for (const { entry } of discards) {
      if (entry.payload.kind !== 'command') throw new Error('Expected signed owner command');
      const signed = entry.payload.signed;
      const owner = required(humans.find((seat) => seat.seat === signed.body.seat));
      expect(verifyObject('cmd', signed.body, signed.sig, parsePeerId(owner.publicKey))).toBe(true);
    }
    for (const resource of RESOURCES) {
      const returned = sessions.reduce(
        (sum, session, index) =>
          sum +
          (required(hands[index])[resource] ?? 0) -
          (required(session.getPrivate(required(humans[index]).seat)).hand[resource] ?? 0),
        0,
      );
      expect(after.bank[resource]).toBe((before.bank[resource] ?? 0) + returned);
    }
    for (const pending of discarders) {
      if (pending.kind !== 'player') throw new Error('Expected discard owner');
      const seat = pending.seat;
      const prior = Object.values(required(hands[seat])).reduce((sum, count) => sum + count, 0);
      const current = Object.values(
        required(required(sessions[seat]).getPrivate(seat)).hand,
      ).reduce((sum, count) => sum + count, 0);
      expect(current).toBe(prior - Math.floor(prior / 2));
      expect(required(after.seats.find((item) => item.seat === seat)).resources.total).toBe(
        current,
      );
    }
    for (const session of sessions) {
      const ownEntries = session.exportSave().entries;
      // Honest peers can retain different valid quorum subsets for the same entry.
      expect(ownEntries.map(({ entry }) => entry)).toEqual(entries.map(({ entry }) => entry));
      const replay = value(
        replayCertifiedPrefix(fixture.entry, ownEntries, fixture.engine, fixture.policy),
      );
      expect(replay.context.log.state).toEqual(after);
    }
    expect(fixture.engine.checkInvariants(after)).toEqual([]);
  } finally {
    sessions.forEach((session) => session.dispose());
    network.dispose();
    fixture.dispose();
  }
}, 120_000);
