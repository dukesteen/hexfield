import { entryHash, genesisDigest } from './genesis.js';
import { MemoryProtocolJournal } from './journal.js';
import { decodeProtocolMessage, encodeProtocolMessage } from './messages.js';
import { ReplicatedLog } from './replicated-log.js';
import { signTradeProofRequest, signTradeProofResponse } from './trade-proof-delivery.js';
import type { ProtocolMessage } from './messages.js';
import type { PeerId, ProtocolClock, Transport, Unsubscribe } from './transport.js';
import { fixtureAt, protocolFixture } from './testing/fixtures.js';
import { describe, expect, test, vi } from 'vitest';
import type { Result } from '@cp2p/engine';
import type { IndexedHandProof, SignedTradeProofResponse } from './trade-proof-delivery.js';
import { success } from '@cp2p/engine';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

class TestClock implements ProtocolClock {
  now(): number {
    return 0;
  }
  setTimeout(_callback: () => void, _delayMs: number): unknown {
    return 1;
  }
  clearTimeout(_handle: unknown): void {}
}

class TestTransport implements Transport {
  readonly sent: ProtocolMessage[] = [];
  readonly disconnected: PeerId[] = [];
  private listener: ((from: PeerId, bytes: Uint8Array) => void) | null = null;
  constructor(readonly self: PeerId) {}
  peers(): PeerId[] {
    return [];
  }
  send(_to: PeerId, bytes: Uint8Array): void {
    this.sent.push(value(decodeProtocolMessage(bytes)));
  }
  broadcast(bytes: Uint8Array): void {
    this.sent.push(value(decodeProtocolMessage(bytes)));
  }
  disconnect(peer: PeerId): void {
    this.disconnected.push(peer);
  }
  onMessage(listener: (from: PeerId, bytes: Uint8Array) => void): Unsubscribe {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
  onPeerChange(_listener: (peer: PeerId, online: boolean) => void): Unsubscribe {
    return () => undefined;
  }
  inject(from: PeerId, message: unknown): void {
    this.listener?.(from, value(encodeProtocolMessage(message)));
  }
}

describe('directed trade proof transport', () => {
  test('wire envelopes are canonical and reject extra keys', () => {
    const fixture = protocolFixture();
    const finalizer = fixtureAt(fixture.identities, 0);
    const owner = fixtureAt(fixture.identities, 1);
    const request = signTradeProofRequest(
      {
        gameId: fixture.genesis.gameId,
        genesisDigest: genesisDigest(fixture.genesis),
        seat: 0,
        nonce: 1,
        headSeq: 0,
        headHash: entryHash(fixture.entry),
        command: { type: 'CONFIRM_TRADE', offerId: 0, withSeat: 1 },
      },
      finalizer.secretKey,
    );
    const wireRequest = { t: 'TRADE_PROOF_REQUEST', request };
    expect(value(decodeProtocolMessage(value(encodeProtocolMessage(wireRequest))))).toEqual(
      wireRequest,
    );
    expect(encodeProtocolMessage({ ...wireRequest, extra: true }).ok).toBe(false);
    expect(
      encodeProtocolMessage({
        t: 'TRADE_PROOF_REQUEST',
        request: { ...request, body: { ...request.body, extra: true } },
      }).ok,
    ).toBe(false);

    const response = signTradeProofResponse(request, 1, [], owner.secretKey);
    const wireResponse = { t: 'TRADE_PROOF_RESPONSE', response };
    expect(value(decodeProtocolMessage(value(encodeProtocolMessage(wireResponse))))).toEqual(
      wireResponse,
    );
    expect(encodeProtocolMessage({ ...wireResponse, extra: true }).ok).toBe(false);
    expect(
      encodeProtocolMessage({
        t: 'TRADE_PROOF_RESPONSE',
        response: { ...response, body: { ...response.body, extra: true } },
      }).ok,
    ).toBe(false);
  });

  test('wrong-host requests and unsolicited responses are ignored before proof callbacks', async () => {
    const fixture = protocolFixture();
    const local = fixtureAt(fixture.identities, 0);
    const wrongHost = fixtureAt(fixture.identities, 0);
    const finalizer = fixtureAt(fixture.identities, 1);
    const transport = new TestTransport(local.peerId);
    const tradeProof = vi.fn<() => Result<readonly IndexedHandProof[]>>(() => success([]));
    const onTradeProofResponse = vi.fn<(response: SignedTradeProofResponse) => void>();
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine: fixture.engine,
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 0,
        secretKey: local.secretKey,
        transport,
        clock: new TestClock(),
        journal: new MemoryProtocolJournal(),
        tradeProof,
        onTradeProofResponse,
      }),
    );
    const context = replica.getContext();
    const request = signTradeProofRequest(
      {
        gameId: fixture.genesis.gameId,
        genesisDigest: context.membership.genesisDigest,
        seat: 1,
        nonce: 1,
        headSeq: 0,
        headHash: entryHash(context.log.head),
        command: { type: 'CONFIRM_TRADE', offerId: 0, withSeat: 0 },
      },
      finalizer.secretKey,
    );
    transport.inject(wrongHost.peerId, { t: 'TRADE_PROOF_REQUEST', request });
    await replica.flush();
    expect(tradeProof).not.toHaveBeenCalled();
    expect(transport.sent).toEqual([]);

    const staleRequest = signTradeProofRequest(
      {
        ...request.body,
        headSeq: 1,
      },
      finalizer.secretKey,
    );
    transport.inject(finalizer.peerId, { t: 'TRADE_PROOF_REQUEST', request: staleRequest });
    await replica.flush();
    expect(tradeProof).not.toHaveBeenCalled();
    expect(transport.disconnected).toEqual([]);

    const unsolicited = signTradeProofResponse(request, 0, [], local.secretKey);
    transport.inject(local.peerId, { t: 'TRADE_PROOF_RESPONSE', response: unsolicited });
    await replica.flush();
    expect(onTradeProofResponse).not.toHaveBeenCalled();
    replica.dispose();
  });
});
