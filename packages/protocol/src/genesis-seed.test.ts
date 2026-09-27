import { fromBase64Url, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { identityFromSecret, scalarToBytes } from '@cp2p/crypto';
import type { Result } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import {
  createGenesisSeedCommit,
  createGenesisSeedReveal,
  validateGenesisSeedTranscript,
} from './genesis-seed.js';
import type { GenesisSeedScope } from './genesis-seed.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | undefined): T {
  if (item === undefined) throw new Error('Missing seed fixture value');
  return item;
}

function fixture() {
  const keys = [1, 2, 3, 4].map((number) => new Uint8Array(32).fill(number));
  const masters = [21n, 22n, 23n, 24n].map(scalarToBytes);
  const seats = [0, 1, 2, 3] as const;
  const scope: GenesisSeedScope = {
    freezeHash: 'ab'.repeat(32),
    ceremonyNonce: toBase64Url(new Uint8Array(32).fill(51)),
    ceremonyId: toBase64Url(new Uint8Array(32).fill(52)),
    participants: seats.map((seat) => ({
      seat,
      publicKey: identityFromSecret(required(keys[seat])).peerId,
    })),
    mode: { kind: 'joint' },
  };
  const commits = seats.map((seat) =>
    value(createGenesisSeedCommit(scope, seat, required(masters[seat]), required(keys[seat]))),
  );
  const reveals = seats.map((seat) =>
    value(createGenesisSeedReveal(scope, seat, required(masters[seat]), required(keys[seat]))),
  );
  const transcript = { protocol: 'genesis-seed-v1', kind: 'joint', commits, reveals };
  return { scope, keys, masters, commits, reveals, transcript };
}

describe('genesis seed transcript', () => {
  test('derives a joint seed only from a complete seat-ordered signed commit/reveal transcript', () => {
    const { scope, transcript, reveals } = fixture();
    const checked = value(validateGenesisSeedTranscript(scope, transcript));
    expect(checked.genesisSeed).toBe(
      toBase64Url(
        hashValue({
          domain: 'cp2p/v1/genesis-seed',
          ceremonyId: scope.ceremonyId,
          shares: reveals.map((reveal) => reveal.body.share),
        }),
      ),
    );
    expect(fromBase64Url(checked.genesisSeed)).toHaveLength(32);
    expect(checked.transcript).toEqual(transcript);
    expect(checked.transcript).not.toBe(transcript);
    const otherCeremony = value(
      validateGenesisSeedTranscript(
        {
          ...scope,
          ceremonyId: toBase64Url(new Uint8Array(32).fill(53)),
        },
        transcript,
      ),
    );
    expect(otherCeremony.genesisSeed).not.toBe(checked.genesisSeed);
  });

  test('rejects missing, reordered, duplicated, changed and wrongly signed shares', () => {
    const { scope, transcript, commits, reveals, keys, masters } = fixture();
    for (const candidate of [
      { ...transcript, commits: commits.slice(1) },
      { ...transcript, reveals: reveals.slice(1) },
      { ...transcript, commits: [commits[1], commits[0], commits[2], commits[3]] },
      { ...transcript, reveals: [reveals[0], reveals[0], reveals[2], reveals[3]] },
      {
        ...transcript,
        reveals: [{ ...required(reveals[0]), sig: required(reveals[1]).sig }, ...reveals.slice(1)],
      },
      {
        ...transcript,
        reveals: [
          {
            ...required(reveals[0]),
            body: { ...required(reveals[0]).body, share: required(reveals[1]).body.share },
          },
          ...reveals.slice(1),
        ],
      },
      {
        ...transcript,
        commits: [
          {
            ...required(commits[0]),
            body: { ...required(commits[0]).body, freezeHash: 'cd'.repeat(32) },
          },
          ...commits.slice(1),
        ],
      },
    ])
      expect(validateGenesisSeedTranscript(scope, candidate).ok).toBe(false);
    expect(createGenesisSeedCommit(scope, 0, required(masters[0]), required(keys[1])).ok).toBe(
      false,
    );
    expect(createGenesisSeedReveal(scope, 0, new Uint8Array(31), required(keys[0])).ok).toBe(false);
    for (const master of [new Uint8Array(32), new Uint8Array(32).fill(255)]) {
      expect(createGenesisSeedCommit(scope, 0, master, required(keys[0]))).toMatchObject({
        ok: false,
        error: { code: 'genesis-seed-master' },
      });
      expect(createGenesisSeedReveal(scope, 0, master, required(keys[0]))).toMatchObject({
        ok: false,
        error: { code: 'genesis-seed-master' },
      });
    }
    expect(
      validateGenesisSeedTranscript(
        { ...scope, participants: scope.participants.toReversed() },
        transcript,
      ).ok,
    ).toBe(false);
    expect(
      validateGenesisSeedTranscript(
        { ...scope, ceremonyNonce: toBase64Url(new Uint8Array(32).fill(54)) },
        transcript,
      ).ok,
    ).toBe(false);
    expect(
      validateGenesisSeedTranscript({ ...scope, freezeHash: toHex(hashValue('other')) }, transcript)
        .ok,
    ).toBe(false);
  });

  test('accepts fixed seed only when the frozen choice matches exactly', () => {
    const { scope, keys, masters, transcript } = fixture();
    const seed = toBase64Url(new Uint8Array(32).fill(77));
    const fixedScope: GenesisSeedScope = { ...scope, mode: { kind: 'fixed', seed } };
    const fixed = { protocol: 'genesis-seed-v1', kind: 'fixed', seed };
    expect(value(validateGenesisSeedTranscript(fixedScope, fixed)).genesisSeed).toBe(seed);
    expect(validateGenesisSeedTranscript(fixedScope, transcript).ok).toBe(false);
    expect(validateGenesisSeedTranscript(scope, fixed).ok).toBe(false);
    expect(
      validateGenesisSeedTranscript(fixedScope, {
        ...fixed,
        seed: toBase64Url(new Uint8Array(32).fill(78)),
      }).ok,
    ).toBe(false);
    expect(validateGenesisSeedTranscript(fixedScope, { ...fixed, commits: [] }).ok).toBe(false);
    expect(createGenesisSeedCommit(fixedScope, 0, required(masters[0]), required(keys[0])).ok).toBe(
      false,
    );
  });
});
