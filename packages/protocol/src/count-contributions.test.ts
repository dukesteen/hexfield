import { canonicalDecode, canonicalEncode, toBase64Url } from '@cp2p/codec';
import { encodeScalar, identityFromSecret, pedersenCommit } from '@cp2p/crypto';
import type { SchnorrProof } from '@cp2p/crypto';
import { success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import { describe, expect, test, vi } from 'vitest';
import { MemoryCountContributionStore, prepareCountContribution } from './count-contributions.js';
import type { CountContributionStore } from './count-contributions.js';
import { CountInbox } from './count-inbox.js';
import {
  COUNT_EVIDENCE_PROTOCOL,
  countOperationId,
  proveCountOpening,
  signCountContribution,
  verifyCountContribution,
} from './count-reveal.js';
import type { CountOperation } from './count-reveal.js';
import type { CryptoContext } from './crypto-context.js';
import type { LogContext } from './log.js';
import { decodeProtocolMessage, encodeProtocolMessage } from './messages.js';
import { protocolFixture } from './testing/fixtures.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function fixture() {
  const identities = [1, 2].map((byte) => identityFromSecret(new Uint8Array(32).fill(byte)));
  const first = identities[0];
  const second = identities[1];
  if (!first || !second) throw new Error('Missing count owner identity');
  const operation: CountOperation = {
    protocol: COUNT_EVIDENCE_PROTOCOL,
    genesisDigest: toBase64Url(new Uint8Array(32).fill(9)),
    epoch: 0,
    anchor: { seq: 12, hash: 'a'.repeat(64) },
    monopolist: 2,
    resource: 'ore',
    victims: [
      { seat: 0, publicKey: first.peerId, commitment: pedersenCommit(0n, 5n) },
      { seat: 1, publicKey: second.peerId, commitment: pedersenCommit(4n, 17n) },
    ],
  };
  const protocol = protocolFixture();
  const context: LogContext = {
    genesis: protocol.genesis,
    engine: protocol.engine,
    head: protocol.entry,
    state: protocol.state,
    lastNonces: new Map(),
    crypto: null,
  };
  const signed = (seat: 0 | 1) => {
    const count = seat === 0 ? 0 : 4;
    const blinding = seat === 0 ? 5n : 17n;
    const proof = value(
      proveCountOpening(
        operation,
        seat,
        count,
        encodeScalar(blinding),
        new Uint8Array(32).fill(40 + seat),
      ),
    );
    return signCountContribution(
      operation,
      seat,
      count,
      proof,
      identities[seat]?.secretKey ?? new Uint8Array(32),
    );
  };
  const cryptoFor = (remaining: readonly Seat[]): CryptoContext => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- CountInbox only reads this fixture's counts field.
    return { counts: { operation, remaining } } as CryptoContext;
  };
  return { identities, operation, context, signed, cryptoFor };
}

describe('durable Monopoly count contributions', () => {
  test('persists a signed count before delivery and reuses exact bytes after a source failure', async () => {
    const { identities, operation, context } = fixture();
    const store = new MemoryCountContributionStore();
    const writes = vi.spyOn(store, 'putIfAbsent');
    const source = vi.fn<() => { count: number; proof: SchnorrProof }>(() => ({
      count: 0,
      proof: value(
        proveCountOpening(operation, 0, 0, encodeScalar(5n), new Uint8Array(32).fill(41)),
      ),
    }));
    const first = value(
      await prepareCountContribution(
        operation,
        0,
        identities[0]?.secretKey ?? new Uint8Array(32),
        context,
        () => success(source()),
        store,
      ),
    );
    const stored = await store.load(`count-contribution/${countOperationId(operation)}/0`);
    expect(stored).not.toBeNull();
    expect(canonicalDecode(stored ?? new Uint8Array())).toEqual(first);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(
      value(
        await prepareCountContribution(
          operation,
          0,
          identities[0]?.secretKey ?? new Uint8Array(32),
          { ...context, head: { ...context.head, seq: context.head.seq + 1 } },
          () => {
            throw new Error('source unavailable after restart');
          },
          store,
        ),
      ),
    ).toEqual(first);
    expect(source).toHaveBeenCalledTimes(1);
    expect(writes).toHaveBeenCalledTimes(1);
  });

  test('wrong keys and corrupt stored winners fail without replacing the record', async () => {
    const { identities, operation, context } = fixture();
    const store = new MemoryCountContributionStore();
    const id = `count-contribution/${countOperationId(operation)}/0`;
    await store.putIfAbsent(id, new Uint8Array([1, 2, 3]));
    const write = vi.spyOn(store, 'putIfAbsent');
    const producer = vi.fn<() => never>(() => {
      throw new Error('stored record must be checked first');
    });
    expect(
      await prepareCountContribution(
        operation,
        0,
        identities[1]?.secretKey ?? new Uint8Array(32),
        context,
        producer,
        store,
      ),
    ).toMatchObject({ ok: false, error: { code: 'count-outbox-key' } });
    expect(
      await prepareCountContribution(
        operation,
        0,
        identities[0]?.secretKey ?? new Uint8Array(32),
        context,
        producer,
        store,
      ),
    ).toMatchObject({ ok: false, error: { code: 'count-outbox-record' } });
    expect(write).not.toHaveBeenCalled();
    expect(producer).not.toHaveBeenCalled();
  });

  test('returns a competing valid put-if-absent winner instead of its locally prepared proof', async () => {
    const { identities, operation, context, signed } = fixture();
    const winner = signed(0);
    const competingProof = value(
      proveCountOpening(operation, 0, 0, encodeScalar(5n), new Uint8Array(32).fill(99)),
    );
    const local = signCountContribution(
      operation,
      0,
      0,
      competingProof,
      identities[0]?.secretKey ?? new Uint8Array(32),
    );
    expect(verifyCountContribution(winner, operation).ok).toBe(true);
    expect(verifyCountContribution(local, operation).ok).toBe(true);
    expect(winner).not.toEqual(local);
    const id = `count-contribution/${countOperationId(operation)}/0`;
    let loads = 0;
    let record: Uint8Array | null = null;
    const store: CountContributionStore = {
      async load(requested) {
        expect(requested).toBe(id);
        loads++;
        return loads === 1 ? null : (record?.slice() ?? null);
      },
      async putIfAbsent(requested, bytes) {
        expect(requested).toBe(id);
        record = canonicalEncode(winner);
        expect(canonicalDecode(bytes)).toEqual(local);
        return false;
      },
    };
    const result = await prepareCountContribution(
      operation,
      0,
      identities[0]?.secretKey ?? new Uint8Array(32),
      context,
      () => success({ count: 0, proof: competingProof }),
      store,
    );
    expect(result).toEqual({ ok: true, value: winner });
    expect(loads).toBe(2);
  });

  test('fails closed when a losing writer cannot load a valid winner', async () => {
    const { identities, operation, context } = fixture();
    const proof = value(
      proveCountOpening(operation, 0, 0, encodeScalar(5n), new Uint8Array(32).fill(41)),
    );
    const failures = await Promise.all(
      ([null, new Uint8Array([1, 2, 3])] as const).map(async (winner) => {
        let loads = 0;
        const store: CountContributionStore = {
          async load() {
            loads++;
            return loads === 1 ? null : (winner?.slice() ?? null);
          },
          async putIfAbsent() {
            return false;
          },
        };
        const result = await prepareCountContribution(
          operation,
          0,
          identities[0]?.secretKey ?? new Uint8Array(32),
          context,
          () => success({ count: 0, proof }),
          store,
        );
        return { result, loads };
      }),
    );
    for (const { result, loads } of failures) {
      expect(result).toMatchObject({ ok: false, error: { code: 'count-outbox-record' } });
      expect(loads).toBe(2);
    }
  });

  test('does not return signed success when durable insertion fails', async () => {
    const { identities, operation, context } = fixture();
    const proof = value(
      proveCountOpening(operation, 0, 0, encodeScalar(5n), new Uint8Array(32).fill(41)),
    );
    const store: CountContributionStore = {
      async load() {
        return null;
      },
      async putIfAbsent() {
        throw new Error('durable store unavailable');
      },
    };
    expect(
      await prepareCountContribution(
        operation,
        0,
        identities[0]?.secretKey ?? new Uint8Array(32),
        context,
        () => success({ count: 0, proof }),
        store,
      ),
    ).toMatchObject({ ok: false, error: { code: 'count-outbox-write' } });
  });

  test('copies the signing key before awaiting storage', async () => {
    const { identities, operation, context } = fixture();
    let resolveLoad: ((bytes: Uint8Array | null) => void) | undefined;
    const store: CountContributionStore = {
      load: () => new Promise((resolve) => (resolveLoad = resolve)),
      async putIfAbsent() {
        return true;
      },
    };
    const proof = value(
      proveCountOpening(operation, 0, 0, encodeScalar(5n), new Uint8Array(32).fill(41)),
    );
    const callerKey = identities[0]?.secretKey.slice();
    if (!callerKey) throw new Error('Missing owner key');
    const pending = prepareCountContribution(
      operation,
      0,
      callerKey,
      context,
      () => success({ count: 0, proof }),
      store,
    );
    callerKey.fill(0);
    resolveLoad?.(null);
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    expect(verifyCountContribution(result.value, operation).ok).toBe(true);
  });
});

describe('Monopoly count inbox', () => {
  test('keeps later victims across earlier reveals and ignores duplicate or stale delivery', () => {
    const { operation, signed, cryptoFor } = fixture();
    const first = signed(0);
    const second = signed(1);
    const inbox = new CountInbox();
    value(inbox.refresh(cryptoFor([0, 1])));
    expect(
      inbox.remember({
        ...second,
        sig: `${second.sig.slice(0, -1)}${second.sig.endsWith('A') ? 'B' : 'A'}`,
      }).ok,
    ).toBe(false);
    expect(value(inbox.remember(second))).toBe(true);
    expect(value(inbox.remember(second))).toBe(false);
    expect(value(inbox.remember(first))).toBe(true);
    expect(value(inbox.candidate(cryptoFor([0, 1])))).toMatchObject({
      input: { type: 'REVEAL_COUNT', seat: 0, count: 0 },
    });
    // A refresh and then consumption of the first victim keep this operation ID;
    // the later victim's already verified proof survives both inbox updates.
    expect(value(inbox.candidate(cryptoFor([0, 1])))).toMatchObject({
      input: { type: 'REVEAL_COUNT', seat: 0 },
    });
    expect(value(inbox.candidate(cryptoFor([1])))).toEqual({
      kind: 'system',
      input: { kind: 'system', type: 'REVEAL_COUNT', seat: 1, resource: 'ore', count: 4 },
      evidence: { kind: 'proof', protocol: COUNT_EVIDENCE_PROTOCOL, data: second },
    });
    expect(value(inbox.remember(first))).toBe(false);
    expect(value(inbox.candidate(null))).toBeNull();
    expect(value(inbox.remember(second))).toBe(false);
    expect(countOperationId(operation)).toBe(second.body.operationId);
  });

  test('wire envelope is strict and round-trips a bounded signed contribution', () => {
    const { operation, signed } = fixture();
    const message = {
      t: 'COUNT_CONTRIB',
      genesisDigest: operation.genesisDigest,
      contribution: signed(1),
    };
    expect(value(decodeProtocolMessage(value(encodeProtocolMessage(message))))).toEqual(message);
    expect(encodeProtocolMessage({ ...message, unexpected: true }).ok).toBe(false);
  });
});
