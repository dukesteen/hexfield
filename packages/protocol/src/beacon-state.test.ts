import { canonicalDecode, canonicalEncode, fromBase64Url, toBase64Url } from '@cp2p/codec';
import { createHashChain, signObject } from '@cp2p/crypto';
import { success } from '@cp2p/engine';
import type { GameState } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { signBeaconReveal } from './beacon.js';
import { signBeaconExtension } from './beacon-extension.js';
import {
  completeBeaconState,
  consumeFixedBeacon,
  extendBeaconState,
  freezeBeaconRequest,
  getBeaconExtensionOperation,
  getBeaconOperation,
  initializeBeaconState,
  validateBeaconState,
} from './beacon-state.js';
import type { BeaconState, EntryRef } from './beacon-state.js';
import { genesisBody, genesisId, signGenesis } from './genesis.js';
import { createRandomDerivations } from './random-derivations.js';
import { createSimulationGenesis } from './testing/simulation-genesis.js';
import type { Genesis, GenesisBody } from './types.js';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing beacon state fixture');
  return value;
}

function fixture(lengths: readonly number[] = [2, 2], humanCount = 2) {
  const simulation = createSimulationGenesis({ seed: 73, humanCount });
  const humans = simulation.genesis.seats.filter((seat) => seat.kind === 'human');
  const chains = humans.map((_, index) =>
    createHashChain(new Uint8Array(32).fill(20 + index), required(lengths[index] ?? lengths[0])),
  );
  const commitments = humans.map((seat, index) => ({
    seat: seat.seat,
    length: required(lengths[index] ?? lengths[0]),
    tip: toBase64Url(required(required(chains[index])[0])),
  }));
  const body: GenesisBody = {
    ...genesisBody(simulation.genesis),
    security: 'verified',
    commitments: { beaconChains: commitments },
  };
  const genesis: Genesis = {
    ...body,
    gameId: genesisId(body),
    signatures: humans.map((seat) =>
      signGenesis(body, seat.seat, required(simulation.identities.get(seat.seat)).secretKey),
    ),
  };
  const game = simulation.engine.createGame(body.config, fromBase64Url(body.genesisSeed));
  const pending = required(
    simulation.engine.getPending(game).find((item) => item.kind === 'random'),
  );
  const anchor: EntryRef = { seq: 0, hash: 'a'.repeat(64) };
  const initialized = initializeBeaconState(genesis);
  if (!initialized.ok) throw new Error(initialized.error.message);
  const frozen = freezeBeaconRequest(initialized.value, pending, game, anchor, 0);
  if (!frozen.ok) throw new Error(frozen.error.message);
  return {
    simulation,
    genesis,
    humans,
    chains,
    commitments,
    game,
    pending,
    anchor,
    initial: initialized.value,
    frozen: frozen.value,
  };
}

function revealsFor(
  fixtureValue: ReturnType<typeof fixture>,
  state: BeaconState,
  positions: readonly number[],
) {
  const operation = getBeaconOperation(state);
  if (!operation.ok) throw new Error(operation.error.message);
  return fixtureValue.humans.map((seat, index) =>
    signBeaconReveal(
      operation.value,
      seat.seat,
      required(required(fixtureValue.chains[index])[required(positions[index])]),
      required(fixtureValue.simulation.identities.get(seat.seat)).secretKey,
    ),
  );
}

describe('replayable beacon state', () => {
  test('binds exact ordered human tips to verified genesis, including a single human with bots', () => {
    const one = fixture([2], 1);
    expect(one.initial.chains).toHaveLength(1);
    expect(one.initial.chains[0]?.seat).toBe(0);
    expect(one.genesis.seats.filter((seat) => seat.kind === 'bot')).toHaveLength(3);
    expect(one.frozen.active?.participants).toEqual(one.initial.chains);
    expect(one.frozen.active?.round).toBe(1);

    expect(initializeBeaconState({ ...one.genesis, security: 'stub' }).ok).toBe(false);
    expect(initializeBeaconState({ ...one.genesis, commitments: {} }).ok).toBe(false);
    expect(
      initializeBeaconState({
        ...one.genesis,
        commitments: {
          beaconChains: [...one.commitments, { ...required(one.commitments[0]), seat: 1 }],
        },
      }).ok,
    ).toBe(false);
    const two = fixture();
    expect(
      initializeBeaconState({
        ...two.genesis,
        commitments: { beaconChains: two.commitments.toReversed() },
      }).ok,
    ).toBe(false);
  });

  test('freezes the certified request and detaches caller objects across controls and replay', () => {
    const data = fixture();
    const original = canonicalDecode(canonicalEncode(data.frozen));
    expect(validateBeaconState(original)).toEqual(success(data.frozen));
    const pendingCopy = structuredClone(data.pending);
    const frozen = freezeBeaconRequest(data.initial, pendingCopy, data.game, data.anchor, 3);
    if (!frozen.ok) throw new Error(frozen.error.message);
    pendingCopy.request.type = 'changed';
    data.anchor.hash = 'b'.repeat(64);
    expect(frozen.value.active?.pending.request.type).toBe('startSeat');
    expect(frozen.value.active?.anchor.hash).toBe('a'.repeat(64));
    expect(getBeaconOperation(frozen.value).ok).toBe(true);
    expect(freezeBeaconRequest(frozen.value, data.pending, data.game, data.anchor, 3).ok).toBe(
      false,
    );
    expect(data.initial.active).toBeNull();
    expect(data.frozen).toEqual(original);
  });

  test('rejects incomplete or invalid evidence without mutation and consumes one round once', () => {
    const data = fixture();
    const before = structuredClone(data.frozen);
    const reveals = revealsFor(data, data.frozen, [1, 1]);
    expect(
      completeBeaconState(data.frozen, reveals.slice(0, 1), data.game, {
        seq: 1,
        hash: 'c'.repeat(64),
      }).ok,
    ).toBe(false);
    const first = required(reveals[0]);
    const forged = {
      ...first,
      sig: signObject(
        'beacon-reveal',
        first.body,
        required(data.simulation.identities.get(1)).secretKey,
      ),
    };
    expect(
      completeBeaconState(data.frozen, [forged, required(reveals[1])], data.game, {
        seq: 1,
        hash: 'c'.repeat(64),
      }).ok,
    ).toBe(false);
    expect(data.frozen).toEqual(before);

    const completed = completeBeaconState(data.frozen, reveals, data.game, {
      seq: 1,
      hash: 'c'.repeat(64),
    });
    if (!completed.ok) throw new Error(completed.error.message);
    expect(completed.value.outcome.kind).toBe('system');
    expect(completed.value.state.round).toBe(1);
    expect(completed.value.state.active).toBeNull();
    expect(completed.value.state.chains.map((chain) => chain.index)).toEqual([1, 1]);
    expect(
      completeBeaconState(completed.value.state, reveals, data.game, {
        seq: 2,
        hash: 'd'.repeat(64),
      }).ok,
    ).toBe(false);
  });

  test('extends only exhausted chains and preserves the original request anchor', () => {
    const data = fixture([1, 2]);
    const first = completeBeaconState(
      data.frozen,
      revealsFor(data, data.frozen, [1, 1]),
      data.game,
      { seq: 1, hash: 'c'.repeat(64) },
    );
    if (!first.ok) throw new Error(first.error.message);
    const second = freezeBeaconRequest(
      first.value.state,
      data.pending,
      data.game,
      { seq: 2, hash: 'd'.repeat(64) },
      0,
    );
    if (!second.ok) throw new Error(second.error.message);
    expect(getBeaconOperation(second.value).ok).toBe(false);
    const extension = getBeaconExtensionOperation(second.value);
    if (!extension.ok) throw new Error(extension.error.message);
    expect(extension.value.participants.map((item) => item.seat)).toEqual([0]);
    const newChain = createHashChain(new Uint8Array(32).fill(99), 3);
    const signed = signBeaconExtension(
      extension.value,
      0,
      3,
      required(newChain[0]),
      required(data.simulation.identities.get(0)).secretKey,
    );
    expect(extendBeaconState(second.value, []).ok).toBe(false);
    const extended = extendBeaconState(second.value, [signed]);
    if (!extended.ok) throw new Error(extended.error.message);
    expect(extended.value.active?.anchor).toEqual({ seq: 2, hash: 'd'.repeat(64) });
    expect(extended.value.active?.round).toBe(2);
    expect(
      extended.value.chains.map(({ chainEpoch, index, length }) => [chainEpoch, index, length]),
    ).toEqual([
      [1, 0, 3],
      [0, 1, 2],
    ]);
    expect(extendBeaconState(extended.value, [signed]).ok).toBe(false);
    const operation = getBeaconOperation(extended.value);
    if (!operation.ok) throw new Error(operation.error.message);
    const reveals = [
      signBeaconReveal(
        operation.value,
        0,
        required(newChain[1]),
        required(data.simulation.identities.get(0)).secretKey,
      ),
      signBeaconReveal(
        operation.value,
        1,
        required(required(data.chains[1])[2]),
        required(data.simulation.identities.get(1)).secretKey,
      ),
    ];
    const completed = completeBeaconState(extended.value, reveals, data.game, {
      seq: 4,
      hash: 'e'.repeat(64),
    });
    expect(completed.ok).toBe(true);
  });

  test('stores a fixed steal seed/index until explicit consumption without a second tip advance', () => {
    const data = fixture();
    const registry = createRandomDerivations([
      {
        type: 'testSteal',
        validate(_state: GameState, pending) {
          return pending.systemType === 'STEAL_RESULT'
            ? success(undefined)
            : { ok: false, error: { code: 'test-pending', message: 'Wrong system type' } };
        },
        derive() {
          return success({ kind: 'steal-index', thief: 0, victim: 1, handSize: 2, index: 1 });
        },
      },
    ]);
    const pending = {
      kind: 'random' as const,
      request: { type: 'testSteal' },
      systemType: 'STEAL_RESULT',
    };
    const frozen = freezeBeaconRequest(data.initial, pending, data.game, data.anchor, 0, registry);
    if (!frozen.ok) throw new Error(frozen.error.message);
    const ref = { seq: 1, hash: 'c'.repeat(64) };
    const completed = completeBeaconState(
      frozen.value,
      revealsFor(data, frozen.value, [1, 1]),
      data.game,
      ref,
      registry,
    );
    if (!completed.ok) throw new Error(completed.error.message);
    expect(completed.value.outcome).toEqual({
      kind: 'steal-index',
      thief: 0,
      victim: 1,
      handSize: 2,
      index: 1,
    });
    expect(completed.value.state.fixed?.entry).toEqual(ref);
    expect(completed.value.state.round).toBe(1);
    expect(completed.value.state.chains.map((chain) => chain.index)).toEqual([1, 1]);
    expect(freezeBeaconRequest(completed.value.state, data.pending, data.game, ref, 0).ok).toBe(
      false,
    );
    expect(consumeFixedBeacon(completed.value.state, { ...ref, hash: 'd'.repeat(64) }).ok).toBe(
      false,
    );
    const consumed = consumeFixedBeacon(completed.value.state, ref);
    if (!consumed.ok) throw new Error(consumed.error.message);
    expect(consumed.value.fixed).toBeNull();
    expect(consumed.value.round).toBe(1);
    expect(consumed.value.chains).toEqual(completed.value.state.chains);
    expect(consumeFixedBeacon(consumed.value, ref).ok).toBe(false);
  });
});
