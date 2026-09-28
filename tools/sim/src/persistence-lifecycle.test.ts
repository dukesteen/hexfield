import { describe, expect, test } from 'vitest';
import { MemoryProtocolJournal } from '@cp2p/protocol';
import { createSimulationGenesis } from '@cp2p/protocol/testing';
import {
  PersistenceLifecycle,
  observeRestoredJournal,
  restartEvidence,
} from './persistence-lifecycle.js';

function continued(
  lifecycle: PersistenceLifecycle,
  event: NonNullable<ReturnType<PersistenceLifecycle['next']>>,
  seq: number,
  hash = `entry-${seq}`,
  voters = event.seats,
): void {
  for (const seat of voters) {
    const restored = event.restored.find((item) => item.seat === seat);
    if (restored) restored.precommits.push({ seq, valueHash: hash });
    else
      event.restored.push({
        seat,
        headHash: 'head',
        safetyHash: 'safety',
        safetyRevision: 1,
        loadedBeforeVoting: false,
        votingMessagesAfterLoad: 0,
        orderingViolations: 0,
        precommits: [{ seq, valueHash: hash }],
      });
  }
  lifecycle.observe([{ seq, kind: 'command', hash }]);
}

describe('persistence lifecycle schedule', () => {
  test('rotates every peer, closes everyone in non-seat order, and requires command continuation', () => {
    const lifecycle = new PersistenceLifecycle();
    expect(lifecycle.next(49, 10)).toBeNull();
    const first = lifecycle.next(50, 10);
    expect(first?.seats).toEqual([0]);
    expect(lifecycle.next(100, 10)).toBeNull();
    lifecycle.observe([{ seq: 51, kind: 'system', hash: 'system-51' }]);
    expect(first?.continuedAtSeq).toBeNull();
    if (!first) throw new Error('Missing first lifecycle event');
    continued(lifecycle, first, 52);
    const second = lifecycle.next(100, 10);
    expect(second?.seats).toEqual([1]);
    if (!second) throw new Error('Missing second lifecycle event');
    continued(lifecycle, second, 101);
    const third = lifecycle.next(150, 10);
    expect(third?.seats).toEqual([2]);
    if (!third) throw new Error('Missing third lifecycle event');
    continued(lifecycle, third, 151);
    const everyoneLeft = lifecycle.next(151, 10);
    expect(everyoneLeft?.seats).toEqual([2, 0, 3, 1]);
    if (!everyoneLeft) throw new Error('Missing everyone-left lifecycle event');
    continued(lifecycle, everyoneLeft, 152);
    const fourth = lifecycle.next(200, 10);
    expect(fourth?.seats).toEqual([3]);
    if (!fourth) throw new Error('Missing fourth lifecycle event');
    continued(lifecycle, fourth, 201);
    expect(() => lifecycle.finish()).toThrow('exact restoration');
    for (const event of lifecycle.restarts) {
      for (const seat of event.seats)
        if (!event.restored.some((restored) => restored.seat === seat))
          event.restored.push({
            seat,
            headHash: 'head',
            safetyHash: 'safety',
            safetyRevision: 1,
            loadedBeforeVoting: true,
            votingMessagesAfterLoad: 1,
            orderingViolations: 0,
            precommits: [],
          });
      for (const restored of event.restored) {
        restored.loadedBeforeVoting = true;
        restored.votingMessagesAfterLoad = 1;
      }
    }
    expect(() => lifecycle.finish(249)).not.toThrow();
    expect(() => lifecycle.finish(250)).not.toThrow();
    expect(() => lifecycle.finish(251)).toThrow('untested restart boundary');
  });

  test('rejects skipped approximately fifty-entry boundaries', () => {
    expect(() => new PersistenceLifecycle().next(100, 10)).toThrow('skipped');
  });

  test('requires the restored seat to precommit to the continuation entry', () => {
    const lifecycle = new PersistenceLifecycle();
    const event = lifecycle.next(50, 10);
    if (!event) throw new Error('Missing lifecycle event');
    event.restored.push({
      seat: 0,
      headHash: 'head',
      safetyHash: 'safety',
      safetyRevision: 1,
      loadedBeforeVoting: true,
      votingMessagesAfterLoad: 1,
      orderingViolations: 0,
      precommits: [],
    });
    lifecycle.observe([{ seq: 51, kind: 'command', hash: 'entry-51' }]);
    expect(event.continuedAtSeq).toBeNull();
    expect(lifecycle.next(100, 10)).toBeNull();
  });

  test('does not count a precommit for the pre-restart height', () => {
    const lifecycle = new PersistenceLifecycle();
    const event = lifecycle.next(50, 10);
    if (!event) throw new Error('Missing lifecycle event');
    event.restored.push({
      seat: 0,
      headHash: 'head',
      safetyHash: 'safety',
      safetyRevision: 1,
      loadedBeforeVoting: true,
      votingMessagesAfterLoad: 1,
      orderingViolations: 0,
      precommits: [{ seq: 50, valueHash: 'entry-51' }],
    });
    lifecycle.observe([{ seq: 51, kind: 'command', hash: 'entry-51' }]);
    expect(event.continuedAtSeq).toBeNull();
  });

  test('does not count a precommit for a different command hash', () => {
    const lifecycle = new PersistenceLifecycle();
    const event = lifecycle.next(50, 10);
    if (!event) throw new Error('Missing lifecycle event');
    event.restored.push({
      seat: 0,
      headHash: 'head',
      safetyHash: 'safety',
      safetyRevision: 1,
      loadedBeforeVoting: true,
      votingMessagesAfterLoad: 1,
      orderingViolations: 0,
      precommits: [{ seq: 51, valueHash: 'different-entry' }],
    });
    lifecycle.observe([{ seq: 51, kind: 'command', hash: 'entry-51' }]);
    expect(event.continuedAtSeq).toBeNull();
  });

  test('requires three restored precommits for everyone-left continuation', () => {
    const lifecycle = new PersistenceLifecycle();
    const first = lifecycle.next(50, 10);
    if (!first) throw new Error('Missing first lifecycle event');
    continued(lifecycle, first, 51);
    const second = lifecycle.next(100, 10);
    if (!second) throw new Error('Missing second lifecycle event');
    continued(lifecycle, second, 101);
    const third = lifecycle.next(150, 10);
    if (!third) throw new Error('Missing third lifecycle event');
    continued(lifecycle, third, 151);
    const everyoneLeft = lifecycle.next(151, 10);
    if (!everyoneLeft) throw new Error('Missing everyone-left lifecycle event');
    continued(lifecycle, everyoneLeft, 152, 'entry-152', [2, 0]);
    expect(everyoneLeft.continuedAtSeq).toBeNull();
    continued(lifecycle, everyoneLeft, 152, 'entry-152', [3]);
    expect(everyoneLeft.continuedAtSeq).toBe(152);
    expect(everyoneLeft.continuedBySeats).toEqual([2, 0, 3]);
  });
});

describe('durable restoration observation', () => {
  test('verifies the retained prefix and actual controller safety load before voting', async () => {
    const fixture = createSimulationGenesis({ seed: 42 });
    const journal = new MemoryProtocolJournal();
    expect(await journal.initialize(fixture.entry, new Uint8Array([1, 2, 3]))).toBe(true);
    const record = await journal.load();
    if (!record) throw new Error('Missing journal record');
    const evidence = restartEvidence(0, record);
    const restored = observeRestoredJournal(journal, record, evidence);
    expect(evidence.loadedBeforeVoting).toBe(false);
    expect(await restored.load()).toEqual(record);
    expect(evidence.loadedBeforeVoting).toBe(false);
    expect(await restored.load()).toEqual(record);
    expect(await restored.loadSafety(record.height)).toEqual(record.safety);
    expect(evidence.loadedBeforeVoting).toBe(true);
    // Once restoration loaded the durable state, ordinary consensus may advance its safety revision.
    expect(
      await restored.saveSafety(record.height, record.safety.revision, new Uint8Array([4])),
    ).toBe(true);
    expect((await restored.load())?.safety.revision).toBe(1);
    for (const identity of fixture.identities.values()) identity.secretKey.fill(0);
  });

  test('refuses safety persistence before the retained record has been validated', async () => {
    const fixture = createSimulationGenesis({ seed: 44 });
    const journal = new MemoryProtocolJournal();
    await journal.initialize(fixture.entry, new Uint8Array([1]));
    const record = await journal.load();
    if (!record) throw new Error('Missing journal record');
    const evidence = restartEvidence(0, record);
    const restored = observeRestoredJournal(journal, record, evidence);
    await expect(
      restored.saveSafety(record.height, record.safety.revision, new Uint8Array([2])),
    ).rejects.toThrow('before validating');
    expect((await journal.load())?.safety).toEqual(record.safety);
    expect(evidence.orderingViolations).toBe(1);
    for (const identity of fixture.identities.values()) identity.secretKey.fill(0);
  });

  test('rejects a safety change before the restoring session reads its durable record', async () => {
    const fixture = createSimulationGenesis({ seed: 43 });
    const journal = new MemoryProtocolJournal();
    await journal.initialize(fixture.entry, new Uint8Array([1, 2, 3]));
    const record = await journal.load();
    if (!record) throw new Error('Missing journal record');
    const evidence = restartEvidence(0, record);
    const restored = observeRestoredJournal(journal, record, evidence);
    await journal.saveSafety(record.height, record.safety.revision, new Uint8Array([4]));
    await expect(restored.load()).rejects.toThrow('prefix or safety');
    expect(evidence.loadedBeforeVoting).toBe(false);
    for (const identity of fixture.identities.values()) identity.secretKey.fill(0);
  });

  test('rejects safety changed between session replay and the controller read', async () => {
    const fixture = createSimulationGenesis({ seed: 45 });
    const journal = new MemoryProtocolJournal();
    await journal.initialize(fixture.entry, new Uint8Array([1]));
    const record = await journal.load();
    if (!record) throw new Error('Missing journal record');
    const evidence = restartEvidence(0, record);
    const restored = observeRestoredJournal(journal, record, evidence);
    await restored.load();
    await journal.saveSafety(record.height, record.safety.revision, new Uint8Array([2]));
    await expect(restored.loadSafety(record.height)).rejects.toThrow('different durable safety');
    expect(evidence.loadedBeforeVoting).toBe(false);
    for (const identity of fixture.identities.values()) identity.secretKey.fill(0);
  });

  test('requires the first restored write to use the retained revision', async () => {
    const fixture = createSimulationGenesis({ seed: 46 });
    const journal = new MemoryProtocolJournal();
    await journal.initialize(fixture.entry, new Uint8Array([1]));
    const record = await journal.load();
    if (!record) throw new Error('Missing journal record');
    const evidence = restartEvidence(0, record);
    const restored = observeRestoredJournal(journal, record, evidence);
    await restored.load();
    await restored.loadSafety(record.height);
    await expect(restored.saveSafety(record.height, 10, new Uint8Array([2]))).rejects.toThrow(
      'retained safety revision',
    );
    expect(evidence.orderingViolations).toBe(1);
    expect((await journal.load())?.safety).toEqual(record.safety);
    for (const identity of fixture.identities.values()) identity.secretKey.fill(0);
  });
});
