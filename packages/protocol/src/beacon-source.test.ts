import { toBase64Url } from '@cp2p/codec';
import { scalarToBytes, verifyHashChainLink } from '@cp2p/crypto';
import { describe, expect, test } from 'vitest';
import { createBeaconSecretSource } from './beacon-source.js';

const master = scalarToBytes(19n);
const ceremonyId = toBase64Url(new Uint8Array(32).fill(7));
const context = { ceremonyId, seat: 0 } as const;

describe('deterministic beacon secret source', () => {
  test('a fresh instance reproduces the extension and the link after a crash before storage', () => {
    const first = createBeaconSecretSource(master, context, 3);
    const initialTip = first.initialCommitment.tip;
    const firstReveal = first.source.link(0, 1);
    expect(verifyHashChainLink(initialTip, firstReveal)).toBe(true);
    const announced = first.source.extension(1);
    first.dispose();

    const restored = createBeaconSecretSource(master, context, 3);
    expect(restored.initialCommitment.tip).toEqual(initialTip);
    expect(restored.source.extension(1)).toEqual(announced);
    const reveal = restored.source.link(1, 1);
    expect(verifyHashChainLink(announced.tip, reveal)).toBe(true);
    expect(verifyHashChainLink(reveal, restored.source.link(1, 2))).toBe(true);
    restored.dispose();
  });

  test('master, ceremony, seat and epoch separate chains', () => {
    const baseline = createBeaconSecretSource(master, context, 2);
    const otherMaster = createBeaconSecretSource(scalarToBytes(20n), context, 2);
    const otherCeremony = createBeaconSecretSource(
      master,
      { ...context, ceremonyId: toBase64Url(new Uint8Array(32).fill(8)) },
      2,
    );
    const otherSeat = createBeaconSecretSource(master, { ...context, seat: 1 }, 2);
    const otherLength = createBeaconSecretSource(master, context, 3);
    const tip = baseline.initialCommitment.tip;
    expect(otherMaster.initialCommitment.tip).not.toEqual(tip);
    expect(otherCeremony.initialCommitment.tip).not.toEqual(tip);
    expect(otherSeat.initialCommitment.tip).not.toEqual(tip);
    expect(otherLength.initialCommitment.tip).not.toEqual(tip);
    expect(verifyHashChainLink(tip, otherLength.source.link(0, 1))).toBe(false);
    expect(baseline.source.extension(1).tip).not.toEqual(tip);
    expect(baseline.source.extension(2).tip).not.toEqual(baseline.source.extension(1).tip);
    for (const source of [baseline, otherMaster, otherCeremony, otherSeat, otherLength])
      source.dispose();
  });

  test('caller mutation cannot change future outputs, including after cache eviction', () => {
    const callerMaster = master.slice();
    const provider = createBeaconSecretSource(callerMaster, context, 2);
    callerMaster.fill(0);
    const expected = createBeaconSecretSource(master, context, 2);
    provider.initialCommitment.tip.fill(0);
    provider.source.link(0, 1).fill(0);
    provider.source.extension(1).tip.fill(0);
    provider.source.extension(2);
    provider.source.extension(3);
    expect(provider.initialCommitment).toEqual(expected.initialCommitment);
    expect(provider.source.link(0, 1)).toEqual(expected.source.link(0, 1));
    expect(provider.source.extension(1)).toEqual(expected.source.extension(1));
    provider.dispose();
    expected.dispose();
  });

  test('rejects invalid secrets, context, chain positions and disposed use', () => {
    expect(() => createBeaconSecretSource(new Uint8Array(31), context)).toThrow(/master/);
    expect(() => createBeaconSecretSource(new Uint8Array(32), context)).toThrow(/zero/);
    expect(() => createBeaconSecretSource(new Uint8Array(32).fill(255), context)).toThrow(
      /noncanonical/,
    );
    expect(() => createBeaconSecretSource(master, { ...context, ceremonyId: 'bad' })).toThrow(
      /context/,
    );
    expect(() =>
      Reflect.apply(createBeaconSecretSource, undefined, [master, { ...context, seat: 6 }]),
    ).toThrow(/context/);
    for (const length of [0, 65_537, 1.5, Number.POSITIVE_INFINITY])
      expect(() => createBeaconSecretSource(master, context, length)).toThrow(/length/);
    const provider = createBeaconSecretSource(master, context, 2);
    for (const index of [0, 3, 1.5]) expect(() => provider.source.link(0, index)).toThrow(/index/);
    expect(() => provider.source.link(-1, 1)).toThrow(/epoch/);
    expect(() => provider.source.extension(0)).toThrow(/epoch/);
    provider.dispose();
    expect(() => provider.initialCommitment).toThrow(/disposed/);
    expect(() => provider.source.link(0, 1)).toThrow(/disposed/);
    expect(() => provider.source.extension(1)).toThrow(/disposed/);
  });
});
