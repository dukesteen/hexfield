import { describe, expect, test } from 'vitest';
import { validateGenesisEntry } from '../genesis.js';
import { createSimulationGenesis } from './simulation-genesis.js';

describe('createSimulationGenesis', () => {
  test('same seed and index produce the same valid signed stub genesis', () => {
    const first = createSimulationGenesis({ seed: 17, gameIndex: 4 });
    const second = createSimulationGenesis({ seed: 17, gameIndex: 4 });

    expect(first.genesis).toEqual(second.genesis);
    expect(first.entry).toEqual(second.entry);
    expect([...first.identities]).toEqual([...second.identities]);
    expect(validateGenesisEntry(first.entry, first.engine, { allowStub: true }).ok).toBe(true);
    expect(first.genesis.security).toBe('stub');
  });

  test('game indexes derive distinct key material, board seeds, and ceremony nonces', () => {
    const first = createSimulationGenesis({ seed: 17, gameIndex: 0 });
    const second = createSimulationGenesis({ seed: 17, gameIndex: 1 });

    expect(first.genesis.gameId).not.toBe(second.genesis.gameId);
    expect(first.genesis.genesisSeed).not.toBe(second.genesis.genesisSeed);
    expect(first.genesis.ceremonyNonce).not.toBe(second.genesis.ceremonyNonce);
    expect(first.identities.get(0)?.peerId).not.toBe(second.identities.get(0)?.peerId);
    expect(first.genesis.createdAt).toBeLessThan(second.genesis.createdAt);
  });

  test('assigns bots round-robin to human hosts and signs only with humans', () => {
    const generated = createSimulationGenesis({ seed: 21, humanCount: 2 });
    const humans = generated.genesis.seats.filter((seat) => seat.kind === 'human');
    const bots = generated.genesis.seats.filter((seat) => seat.kind === 'bot');

    expect(humans.map((seat) => seat.seat)).toEqual([0, 1]);
    expect(bots.map((seat) => seat.botHost)).toEqual([humans[0]?.publicKey, humans[1]?.publicKey]);
    expect(generated.genesis.signatures.map((signature) => signature.seat)).toEqual([0, 1]);
    expect(validateGenesisEntry(generated.entry, generated.engine, { allowStub: true }).ok).toBe(
      true,
    );
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'rejects invalid seed values %s',
    (seed) => {
      expect(() => createSimulationGenesis({ seed })).toThrow(RangeError);
    },
  );

  test('rejects a game index that would overflow the fixed timestamp', () => {
    expect(() => createSimulationGenesis({ seed: 1, gameIndex: Number.MAX_SAFE_INTEGER })).toThrow(
      RangeError,
    );
  });

  test.each([0, 5])('rejects invalid human counts %i', (humanCount) => {
    expect(() => createSimulationGenesis({ seed: 1, humanCount })).toThrow(RangeError);
  });
});
