import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, test } from 'vitest';
import { createHashChain, verifyHashChainLink } from './hash-chain.js';

const SEED = Uint8Array.from({ length: 32 }, (_, index) => index);

describe('beacon hash chain', () => {
  test('pins the tip, intermediate links, and seed at the requested index', () => {
    const chain = createHashChain(SEED, 3);
    expect(chain).toHaveLength(4);
    expect(chain.map(bytesToHex)).toEqual([
      '4e05063392f42b5180353ef82da86c714042155044d91ab3253f1bab08120a0a',
      '2f287b4d3d4910f6cada9e1bd1b4648099e8c52c81aa4a6aebfa6fc86f19834e',
      '630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd',
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    ]);
    for (let index = 0; index < chain.length - 1; index += 1) {
      const previous = chain[index] ?? new Uint8Array(0);
      const reveal = chain[index + 1] ?? new Uint8Array(0);
      expect(verifyHashChainLink(previous, reveal)).toBe(true);
    }
  });

  test('uses the 4096-link default and returns detached links', () => {
    const seed = SEED.slice();
    const chain = createHashChain(seed);
    expect(chain).toHaveLength(4097);
    expect(chain[4096]).toEqual(seed);
    expect(chain[0]).not.toBe(seed);
    const tipBeforeMutation = chain[0]?.slice();
    seed.fill(0);
    expect(chain[4096]).not.toEqual(seed);
    expect(chain[0]).toEqual(tipBeforeMutation);
  });

  test('rejects invalid length and seed, and verifies malformed links as false', () => {
    for (const length of [0, -1, 1.5, 65_537, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => createHashChain(Uint8Array.from({ length: 32 }), length)).toThrow(/length/);
    expect(() => createHashChain(new Uint8Array(31))).toThrow(/32 bytes/);
    expect(verifyHashChainLink(new Uint8Array(31), new Uint8Array(32))).toBe(false);
    expect(verifyHashChainLink(new Uint8Array(32), new Uint8Array(33))).toBe(false);
    expect(verifyHashChainLink(new Uint8Array(32), new Uint8Array(32))).toBe(false);
    const throwingLength = new Proxy(new Uint8Array(32), {
      get(target, property) {
        if (property === 'length') throw new Error('hostile length getter');
        return Reflect.get(target, property, target);
      },
    });
    const throwingBytes = new Proxy(new Uint8Array(32), {
      get() {
        throw new Error('hostile byte getter');
      },
    });
    expect(verifyHashChainLink(throwingLength, new Uint8Array(32))).toBe(false);
    expect(verifyHashChainLink(new Uint8Array(32), throwingBytes)).toBe(false);
  });
});
