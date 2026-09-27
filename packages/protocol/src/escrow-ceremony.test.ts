import {
  canonicalDecode,
  canonicalEncode,
  fromBase64Url,
  hashValue,
  toBase64Url,
  toHex,
} from '@cp2p/codec';
import {
  decodePoint,
  encodePoint,
  encodeScalar,
  G,
  identityFromSecret,
  proveDleq,
  scalePoint,
  sealWithEphemeralProof,
  signObject,
} from '@cp2p/crypto';
import type { Result, Seat } from '@cp2p/engine';
import { expect, test } from 'vitest';
import { EscrowCeremony } from './escrow-ceremony.js';
import { escrowShareEnvelopeHash } from './escrow-distribution.js';
import { escrowDeliveryContexts } from './escrow-opening.js';
import { validateGenesisEscrow } from './genesis-escrow.js';
import {
  MemoryEscrowLifecycleStore,
  checkEscrowCeremonyActive,
  reserveEscrowGenesisConsent,
  retireEscrowCeremony,
} from './escrow-lifecycle.js';
import type { EscrowManifestApproval } from './escrow-lifecycle.js';
import {
  GENESIS_PREVIOUS_HASH,
  genesisId,
  signEntry,
  signGenesis,
  signVerifiedGenesis,
} from './genesis.js';
import { createStealSecretSource } from './steal-source.js';
import type { GenesisBody, GenesisSeat } from './types.js';
import { createGenesisDeckFixture } from './testing/deck-fixture.js';
import { fixtureAt, protocolFixture } from './testing/fixtures.js';

const identities = Array.from({ length: 4 }, (_, seat) =>
  identityFromSecret(new Uint8Array(32).fill(seat + 11)),
);
const masters = [71n, 72n, 73n, 74n] as const;
const encryption = [201n, 202n, 203n, 204n] as const;
const seatOrder: readonly Seat[] = [0, 1, 2, 3];

class RetirementStore extends MemoryEscrowLifecycleStore {
  retirementCommitted = false;
  failRetirementOnce = false;

  override async compareAndSwap(
    id: string,
    before: Uint8Array,
    after: Uint8Array,
  ): Promise<boolean> {
    if (
      id === 'escrow-lifecycle/device-index-v1' &&
      JSON.stringify(canonicalDecode(after)).includes('"retiredCeremonies":["')
    ) {
      if (this.failRetirementOnce) {
        this.failRetirementOnce = false;
        throw new Error('retirement disk failure');
      }
      const won = await super.compareAndSwap(id, before, after);
      if (won) this.retirementCommitted = true;
      return won;
    }
    return super.compareAndSwap(id, before, after);
  }
}

function dealerSignedBadEnvelope(good: import('./escrow-distribution.js').EscrowShareEnvelope) {
  const prior = good.body;
  const payload = canonicalEncode({
    protocol: prior.protocol,
    ceremonyId: prior.ceremonyId,
    dealerSeat: prior.dealer.seat,
    holderSeat: prior.holder.seat,
    holderIndex: prior.holder.index,
    threshold: prior.threshold,
    masterPub: prior.masterPub,
    share: encodeScalar(999n),
  });
  const body = {
    ...prior,
    shareHash: toHex(hashValue({ domain: 'cp2p/v1/escrow-share-payload', payload })),
  };
  const contexts = escrowDeliveryContexts(body);
  const sealed = sealWithEphemeralProof(
    payload,
    prior.holder.encryptionKey,
    new Uint8Array(32).fill(95),
    contexts.seal,
    contexts.proof,
  );
  payload.fill(0);
  const signed = { ...body, ...sealed };
  const dealer = fixtureAt(identities, 0);
  return { body: signed, sig: signObject('escrow-share', signed, dealer.secretKey) };
}

function signedFalseComplaint(
  envelope: import('./escrow-distribution.js').EscrowShareEnvelope,
  recipientSecret: bigint,
  holderKey: Uint8Array,
) {
  const context = {
    protocol: 'escrow-share-dispute-v1' as const,
    ceremonyId: envelope.body.ceremonyId,
    dealerSeat: envelope.body.dealer.seat,
    holderSeat: envelope.body.holder.seat,
    envelopeHash: escrowShareEnvelopeHash(envelope),
  };
  const sharedPoint = encodePoint(
    scalePoint(decodePoint(envelope.body.sealed.ephemeral), recipientSecret),
  );
  const proof = proveDleq(
    {
      base1: encodePoint(G),
      point1: envelope.body.holder.encryptionKey,
      base2: envelope.body.sealed.ephemeral,
      point2: sharedPoint,
    },
    recipientSecret,
    new Uint8Array(32).fill(99),
    context,
  );
  const body = { ...context, sharedPoint, proof };
  return { body, sig: signObject('escrow-share-dispute', body, holderKey) };
}

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function frozen(nonce = 30n): GenesisBody {
  const fixture = protocolFixture();
  const seats: GenesisSeat[] = identities.map((identity, index) => ({
    seat: seatOrder[index] ?? 0,
    kind: 'human',
    publicKey: identity.peerId,
    encryptionKey: encodePoint(scalePoint(G, encryption[index] ?? 201n)),
    name: `Human ${index}`,
    colour: `#${(index + 1).toString(16).repeat(6)}`,
  }));
  return {
    ...fixture.body,
    config: { ...fixture.body.config, seats: [0, 1, 2, 3] },
    seats,
    ceremonyNonce: encodeScalar(nonce),
    security: 'verified',
    commitments: {
      masters: seats.map(({ seat }) => ({
        seat,
        masterPub: encodePoint(scalePoint(G, (masters as readonly bigint[])[seat] ?? 71n)),
      })),
    },
  };
}

async function preparedDealer(store: RetirementStore) {
  const manifest = frozen();
  const ceremony = new EscrowCeremony(manifest, store);
  const approvals = [] as EscrowManifestApproval[];
  for (const seat of seatOrder) {
    const key = fixtureAt(identities, seat).secretKey;
    // oxlint-disable-next-line no-await-in-loop -- Approvals are durable before distribution begins.
    approvals.push(value(await ceremony.approveAndSend(manifest, seat, key, () => undefined)));
  }
  const master = fromBase64Url(encodeScalar(masters[0]));
  const envelopes = value(
    await ceremony.distributeAndSend({
      genesis: manifest,
      approvals,
      dealerSeat: 0,
      master,
      dealerSigningKey: fixtureAt(identities, 0).secretKey,
      send: () => undefined,
    }),
  );
  return { manifest, ceremony, master, bad: dealerSignedBadEnvelope(fixtureAt(envelopes, 0)) };
}

test('ceremony reserves before send and retries identical envelopes after enqueue failure', async () => {
  const manifest = frozen();
  const store = new MemoryEscrowLifecycleStore();
  const ceremony = new EscrowCeremony(manifest, store);
  const approvals: EscrowManifestApproval[] = [];
  // oxlint-disable no-await-in-loop -- Each approval is durably stored before the next ceremony action.
  for (let seat = 0; seat < 4; seat += 1) {
    const key = identities[seat]?.secretKey;
    if (!key) throw new Error('Missing test identity');
    const approval = value(
      await ceremony.approveAndSend(manifest, seatOrder[seat] ?? 0, key, (item) => {
        approvals.push(item);
        return undefined;
      }),
    );
    expect(approval).toEqual(approvals[seat]);
  }
  // oxlint-enable no-await-in-loop
  const master = fromBase64Url(encodeScalar(masters[0]));
  const key = identities[0]?.secretKey;
  if (!key) throw new Error('Missing dealer');
  let firstSent = 0;
  const first = await ceremony.distributeAndSend({
    genesis: manifest,
    approvals,
    dealerSeat: 0,
    master,
    dealerSigningKey: key,
    send: () => {
      firstSent += 1;
      throw new Error('temporary enqueue failure');
    },
  });
  expect(first.ok ? '' : first.error.code).toBe('escrow-ceremony-lock');
  expect(firstSent).toBe(1);
  const sent: { seat: Seat; bytes: string }[] = [];
  const retry = value(
    await ceremony.distributeAndSend({
      genesis: manifest,
      approvals,
      dealerSeat: 0,
      master,
      dealerSigningKey: key,
      send: (seat, envelope) => {
        sent.push({ seat, bytes: toBase64Url(canonicalEncode(envelope)) });
        return undefined;
      },
    }),
  );
  expect(retry).toHaveLength(3);
  expect(sent.map(({ seat }) => seat)).toEqual([1, 2, 3]);
  expect(sent.map(({ bytes }) => bytes)).toEqual(
    retry.map((item) => toBase64Url(canonicalEncode(item))),
  );
  const firstEnvelope = fixtureAt(retry, 0);
  const holderKey = identities[1]?.secretKey;
  if (!holderKey) throw new Error('Missing holder');
  let ackSent = false;
  const accepted = value(
    await ceremony.acceptAndSendAck({
      envelope: firstEnvelope,
      dealerSeat: 0,
      expectedMasterPub: encodePoint(scalePoint(G, masters[0])),
      holderSeat: 1,
      recipientEncryptionSecret: encryption[1],
      holderSigningKey: holderKey,
      send: () => {
        ackSent = true;
        return undefined;
      },
    }),
  );
  expect(ackSent).toBe(true);
  expect(
    value(
      await ceremony.acceptAndSendAck({
        envelope: firstEnvelope,
        dealerSeat: 0,
        expectedMasterPub: encodePoint(scalePoint(G, masters[0])),
        holderSeat: 1,
        recipientEncryptionSecret: encryption[1],
        holderSigningKey: holderKey,
        send: () => undefined,
      }),
    ),
  ).toEqual(accepted);
  expect(value(await ceremony.loadAcceptedShare(firstEnvelope)).ack).toEqual(accepted);
  const good = fixtureAt(retry, 1);
  const holder = identities[2];
  if (!holder) throw new Error('Missing holder');
  let published = false;
  const localComplaint = await ceremony.disputeAndPublish({
    envelope: good,
    dealerSeat: 0,
    holderSeat: 2,
    recipientEncryptionSecret: encryption[2],
    holderSigningKey: holder.secretKey,
    publish: () => {
      published = true;
      return undefined;
    },
  });
  expect(localComplaint.ok ? '' : localComplaint.error.code).toBe('escrow-good-delivery');
  expect(published).toBe(false);
  const context = {
    protocol: 'escrow-share-dispute-v1' as const,
    ceremonyId: good.body.ceremonyId,
    dealerSeat: good.body.dealer.seat,
    holderSeat: good.body.holder.seat,
    envelopeHash: escrowShareEnvelopeHash(good),
  };
  const sharedPoint = encodePoint(
    scalePoint(decodePoint(good.body.sealed.ephemeral), encryption[2]),
  );
  const proof = proveDleq(
    {
      base1: encodePoint(G),
      point1: good.body.holder.encryptionKey,
      base2: good.body.sealed.ephemeral,
      point2: sharedPoint,
    },
    encryption[2],
    new Uint8Array(32).fill(99),
    context,
  );
  const disputeBody = { ...context, sharedPoint, proof };
  const falseComplaint = {
    body: disputeBody,
    sig: signObject('escrow-share-dispute', disputeBody, holder.secretKey),
  };
  const received = await ceremony.receiveDispute(good, falseComplaint);
  expect(received.ok).toBe(true);
  expect((await ceremony.receiveDispute(good, falseComplaint)).ok).toBe(true);
  const consentedStore = new MemoryEscrowLifecycleStore();
  const consented = new EscrowCeremony(manifest, consentedStore);
  expect((await reserveEscrowGenesisConsent(manifest, encodeScalar(888n), consentedStore)).ok).toBe(
    true,
  );
  const afterConsent = await consented.receiveDispute(good, falseComplaint);
  expect(afterConsent.ok ? '' : afterConsent.error.code).toBe('escrow-ceremony-consenting-dispute');
  const otherGood = fixtureAt(retry, 2);
  const otherComplaint = signedFalseComplaint(
    otherGood,
    encryption[3],
    fixtureAt(identities, 3).secretKey,
  );
  const restartedConsented = new EscrowCeremony(manifest, consentedStore);
  const secondDisclosure = await restartedConsented.receiveDispute(otherGood, otherComplaint);
  expect(secondDisclosure.ok ? '' : secondDisclosure.error.code).toBe(
    'escrow-ceremony-consenting-dispute',
  );
  expect(value(await restartedConsented.loadDisclosures())).toHaveLength(2);
  expect((await restartedConsented.receiveDispute(otherGood, otherComplaint)).ok).toBe(false);
  expect((await consented.abort()).ok).toBe(false);
  expect((await retireEscrowCeremony(manifest, store)).ok).toBe(true);
  const blocked = await ceremony.distributeAndSend({
    genesis: manifest,
    approvals,
    dealerSeat: 0,
    master,
    dealerSigningKey: key,
    send: () => undefined,
  });
  expect(blocked.ok ? '' : blocked.error.code).toBe('escrow-ceremony-retired');
});

test('completion validates the signed entry and exact deck transcript before sealing the registry', async () => {
  const fixture = protocolFixture();
  const fourHumanBody: GenesisBody = {
    ...fixture.body,
    security: 'verified',
    seats: fixture.body.seats.map(({ seat, publicKey, name, colour }) => ({
      seat,
      kind: 'human' as const,
      publicKey,
      name,
      colour,
    })),
  };
  const keyed = createGenesisDeckFixture(
    fourHumanBody,
    new Map(fixture.identities.map((identity, index) => [seatOrder[index] ?? 0, identity])),
  );
  const store = new MemoryEscrowLifecycleStore();
  const ceremony = new EscrowCeremony(keyed.body, store);
  const signer = fixture.identities[0];
  if (!signer) throw new Error('Missing fixture identity');
  expect(signVerifiedGenesis(keyed.body, keyed.transcripts, 0, signer.secretKey).ok).toBe(true);
  const dealer = fixtureAt(value(validateGenesisEscrow(keyed.body)), 0);
  const delivered = fixtureAt(dealer.shares, 0).envelope;
  const holderSeat = delivered.body.holder.seat;
  const holderIdentity = fixtureAt(fixture.identities, holderSeat);
  const masterBytes = fromBase64Url(encodeScalar(BigInt(17 + holderSeat)));
  const source = createStealSecretSource(
    masterBytes,
    keyed.body.ceremonyNonce,
    holderSeat,
    holderIdentity.peerId,
  );
  masterBytes.fill(0);
  const holderSecret = source.encryptionSecret();
  source.dispose();
  const disputeContext = {
    protocol: 'escrow-share-dispute-v1' as const,
    ceremonyId: delivered.body.ceremonyId,
    dealerSeat: delivered.body.dealer.seat,
    holderSeat,
    envelopeHash: escrowShareEnvelopeHash(delivered),
  };
  const sharedPoint = encodePoint(
    scalePoint(decodePoint(delivered.body.sealed.ephemeral), holderSecret),
  );
  const proof = proveDleq(
    {
      base1: encodePoint(G),
      point1: delivered.body.holder.encryptionKey,
      base2: delivered.body.sealed.ephemeral,
      point2: sharedPoint,
    },
    holderSecret,
    new Uint8Array(32).fill(99),
    disputeContext,
  );
  const disputeBody = { ...disputeContext, sharedPoint, proof };
  const pendingStore = new RetirementStore();
  const pendingCeremony = new EscrowCeremony(keyed.body, pendingStore);
  const pendingApprovals: EscrowManifestApproval[] = [];
  // oxlint-disable no-await-in-loop -- Each approval is persisted before distribution.
  for (const seat of seatOrder) {
    pendingApprovals.push(
      value(
        await pendingCeremony.approveAndSend(
          keyed.body,
          seat,
          fixtureAt(fixture.identities, seat).secretKey,
          () => undefined,
        ),
      ),
    );
  }
  // oxlint-enable no-await-in-loop
  value(
    await pendingCeremony.distributeAndSend({
      genesis: keyed.body,
      approvals: pendingApprovals,
      dealerSeat: 0,
      master: fromBase64Url(encodeScalar(17n)),
      dealerSigningKey: signer.secretKey,
      send: () => undefined,
    }),
  );
  pendingStore.failRetirementOnce = true;
  const failedRetire = await pendingCeremony.receiveDispute(delivered, {
    body: disputeBody,
    sig: signObject('escrow-share-dispute', disputeBody, holderIdentity.secretKey),
  });
  expect(failedRetire.ok ? '' : failedRetire.error.code).toBe('escrow-registry-write');
  let consentSent = false;
  const prevented = await new EscrowCeremony(keyed.body, pendingStore).consentAndSend({
    body: keyed.body,
    transcripts: keyed.transcripts,
    seat: 0,
    signingKey: signer.secretKey,
    send: () => {
      consentSent = true;
      return undefined;
    },
  });
  expect(prevented.ok ? '' : prevented.error.code).toBe('escrow-ceremony-retired');
  expect(consentSent).toBe(false);
  const consent = await ceremony.consentAndSend({
    body: keyed.body,
    transcripts: keyed.transcripts,
    seat: 0,
    signingKey: signer.secretKey,
    send: () => undefined,
  });
  expect(consent.ok).toBe(true);
  const genesis = {
    ...keyed.body,
    gameId: genesisId(keyed.body),
    signatures: seatOrder.map((seat) =>
      signGenesis(keyed.body, seat, fixtureAt(fixture.identities, seat).secretKey),
    ),
  };
  const entry = signEntry(
    {
      seq: 0,
      term: 1,
      prevHash: GENESIS_PREVIOUS_HASH,
      payload: { kind: 'genesis', genesis },
      stateHash: toHex(hashValue(fixture.state)),
      sequencer: signer.peerId,
    },
    signer.secretKey,
  );
  const bad = await ceremony.complete({
    signedGenesisEntry: { ...entry, stateHash: '0'.repeat(64) },
    transcripts: keyed.transcripts,
    engine: fixture.engine,
  });
  expect(bad.ok).toBe(false);
  expect((await retireEscrowCeremony(keyed.body, store)).ok).toBe(false);
  const completed = await ceremony.complete({
    signedGenesisEntry: entry,
    transcripts: keyed.transcripts,
    engine: fixture.engine,
  });
  expect(completed.ok).toBe(true);
  expect(
    await ceremony.complete({
      signedGenesisEntry: entry,
      transcripts: keyed.transcripts,
      engine: fixture.engine,
    }),
  ).toEqual(completed);
  const retired = await retireEscrowCeremony(keyed.body, store);
  expect(retired.ok ? '' : retired.error.code).toBe('escrow-ceremony-completed');
}, 20_000);

test('genuine bad share retires before publication and retries exact signed disclosure after restart', async () => {
  const store = new RetirementStore();
  const { manifest, ceremony, master, bad } = await preparedDealer(store);
  const holderKey = fixtureAt(identities, 1).secretKey;
  let firstComplaint = '';
  const failedSend = await ceremony.disputeAndPublish({
    envelope: bad,
    dealerSeat: 0,
    holderSeat: 1,
    recipientEncryptionSecret: encryption[1],
    holderSigningKey: holderKey,
    publish: (dispute) => {
      expect(store.retirementCommitted).toBe(true);
      firstComplaint = toBase64Url(canonicalEncode(dispute));
      throw new Error('enqueue failed');
    },
  });
  expect(failedSend.ok ? '' : failedSend.error.code).toBe('escrow-ceremony-lock');
  expect((await checkEscrowCeremonyActive(manifest, store)).ok).toBe(false);
  const restarted = new EscrowCeremony(manifest, store);
  let retried = '';
  const delivered = await restarted.disputeAndPublish({
    envelope: bad,
    dealerSeat: 0,
    holderSeat: 1,
    recipientEncryptionSecret: encryption[1],
    holderSigningKey: holderKey,
    publish: (dispute) => {
      retried = toBase64Url(canonicalEncode(dispute));
      return undefined;
    },
  });
  expect(delivered.ok).toBe(true);
  expect(retried).toBe(firstComplaint);
  expect(value(await restarted.loadDisclosures())).toHaveLength(1);
  let strayAck = false;
  const blockedAck = await restarted.acceptAndSendAck({
    envelope: bad,
    dealerSeat: 0,
    expectedMasterPub: bad.body.masterPub,
    holderSeat: 1,
    recipientEncryptionSecret: encryption[1],
    holderSigningKey: holderKey,
    send: () => {
      strayAck = true;
      return undefined;
    },
  });
  expect(blockedAck.ok ? '' : blockedAck.error.code).toBe('escrow-ceremony-retired');
  expect(strayAck).toBe(false);
  const nextManifest = frozen(31n);
  const nextApprovals: EscrowManifestApproval[] = [];
  // oxlint-disable no-await-in-loop -- Build the exact signed approval set before the retry attempt.
  for (const seat of seatOrder) {
    nextApprovals.push(
      value(
        await new EscrowCeremony(nextManifest, store).approveAndSend(
          nextManifest,
          seat,
          fixtureAt(identities, seat).secretKey,
          () => undefined,
        ),
      ),
    );
  }
  // oxlint-enable no-await-in-loop
  const reuse = await new EscrowCeremony(nextManifest, store).distributeAndSend({
    genesis: nextManifest,
    approvals: nextApprovals,
    dealerSeat: 0,
    master,
    dealerSigningKey: fixtureAt(identities, 0).secretKey,
    send: () => undefined,
  });
  expect(reuse.ok ? '' : reuse.error.code).toBe('escrow-master-reserved');
});

test('pending authenticated disclosure blocks outgoing ceremony actions after retirement write failure', async () => {
  const store = new RetirementStore();
  const { manifest, ceremony, bad } = await preparedDealer(store);
  store.failRetirementOnce = true;
  const failedRetirement = await ceremony.disputeAndPublish({
    envelope: bad,
    dealerSeat: 0,
    holderSeat: 1,
    recipientEncryptionSecret: encryption[1],
    holderSigningKey: fixtureAt(identities, 1).secretKey,
    publish: () => undefined,
  });
  expect(failedRetirement.ok ? '' : failedRetirement.error.code).toBe('escrow-registry-write');
  expect(store.retirementCommitted).toBe(false);
  expect(value(await ceremony.loadDisclosures())).toHaveLength(1);
  const restarted = new EscrowCeremony(manifest, store);
  let sent = false;
  const outgoing = await restarted.approveAndSend(
    manifest,
    0,
    fixtureAt(identities, 0).secretKey,
    () => {
      sent = true;
      return undefined;
    },
  );
  expect(outgoing.ok).toBe(false);
  expect(sent).toBe(false);
  const consent = await restarted.consentAndSend({
    body: manifest,
    transcripts: [],
    seat: 0,
    signingKey: fixtureAt(identities, 0).secretKey,
    send: () => {
      sent = true;
      return undefined;
    },
  });
  expect(consent.ok ? '' : consent.error.code).toBe('escrow-ceremony-retired');
  expect(sent).toBe(false);
});
