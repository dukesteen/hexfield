import { canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import {
  encodePoint,
  encodeScalar,
  G,
  identityFromSecret,
  recoverSecret,
  sealWithEphemeralProof,
  scalePoint,
  signObject,
} from '@cp2p/crypto';
import type { Seat } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { deckCeremonyId } from './deck-genesis.js';
import { genesisId, signGenesis } from './genesis.js';
import {
  acceptEscrowShare,
  createEscrowShareEnvelopes,
  escrowShareEnvelopeHash,
  verifyEscrowShareAck,
  verifyEscrowShareEphemeralProof,
} from './escrow-distribution.js';
import type { Genesis, GenesisBody, GenesisSeat } from './types.js';
import { protocolFixture } from './testing/fixtures.js';
import { escrowDeliveryContexts, readEscrowShareOpening } from './escrow-opening.js';

const signingIdentities = Array.from({ length: 5 }, (_, index) =>
  identityFromSecret(new Uint8Array(32).fill(index + 30)),
);
const encryptionSecrets = [101n, 102n, 103n, 104n, 105n, 106n] as const;
const masterSecrets = [77n, 78n, 79n, 80n, 81n, 82n] as const;

function body(): GenesisBody {
  const fixture = protocolFixture();
  const seatNumbers: Seat[] = [0, 1, 2, 3];
  const seats: GenesisSeat[] = signingIdentities.slice(0, 4).map((identity, index) => ({
    seat: seatNumbers[index] ?? 0,
    kind: 'human',
    publicKey: identity.peerId,
    encryptionKey: encodePoint(scalePoint(G, encryptionSecrets[index] ?? 1n)),
    name: `Human ${index}`,
    colour: `#${(index + 1).toString(16).repeat(6)}`,
  }));
  return {
    ...fixture.body,
    security: 'verified',
    config: { ...fixture.body.config, seats: [0, 1, 2, 3] },
    seats,
    commitments: {
      masters: seats.map(({ seat }) => ({
        seat,
        masterPub: encodePoint(scalePoint(G, masterSecrets[seat] ?? 77n)),
      })),
    },
  };
}

function botHostedBySeatTwo(): GenesisBody {
  const genesis = body();
  const botIdentity = signingIdentities[4];
  if (!botIdentity) throw new Error('Missing bot identity');
  const bot: GenesisSeat = {
    seat: 4,
    kind: 'bot',
    publicKey: botIdentity.peerId,
    encryptionKey: encodePoint(scalePoint(G, encryptionSecrets[4])),
    botHost: signingIdentities[2]?.peerId ?? '',
    name: 'Bot 4',
    colour: '#555555',
  };
  return {
    ...genesis,
    config: { ...genesis.config, seats: [0, 1, 2, 3, 4] },
    seats: [...genesis.seats, bot],
    commitments: {
      masters: [
        ...genesis.seats.map(({ seat }) => ({
          seat,
          masterPub: encodePoint(scalePoint(G, masterSecrets[seat] ?? 77n)),
        })),
        { seat: 4, masterPub: encodePoint(scalePoint(G, masterSecrets[4])) },
      ],
    },
  };
}

function fullGenesis(genesis: GenesisBody): Genesis {
  return {
    ...genesis,
    gameId: genesisId(genesis),
    signatures: genesis.seats
      .filter((seat) => seat.kind === 'human')
      .map((seat) => ({
        seat: seat.seat,
        sig: signGenesis(
          genesis,
          seat.seat,
          signingIdentities[seat.seat]?.secretKey ?? new Uint8Array(),
        ).sig,
      })),
  };
}

function get<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function envelopes(genesis: GenesisBody) {
  const masterSecret = 77n;
  return get(
    createEscrowShareEnvelopes({
      genesis,
      dealerSeat: 0,
      expectedMasterPub: encodePoint(scalePoint(G, masterSecret)),
      masterSecret,
      entropy: new Uint8Array(32).fill(91),
      dealerSigningKey: signingIdentities[0]?.secretKey ?? new Uint8Array(),
    }),
  );
}

describe('Feldman escrow share distribution', () => {
  test('creates deterministic individually signed envelopes and holder-signed acknowledgements', () => {
    const genesis = fullGenesis(body());
    const first = envelopes(genesis);
    const retry = envelopes(genesis);
    expect(first).toHaveLength(3);
    expect(retry).toEqual(first);
    expect(first.map(({ body: envelope }) => envelope.holder.seat)).toEqual([1, 2, 3]);
    expect(
      first.every(({ body: envelope }) => envelope.ceremonyId === deckCeremonyId(genesis)),
    ).toBe(true);
    expect(
      new Set(first.map(({ body: envelope }) => JSON.stringify(envelope.commitments))).size,
    ).toBe(1);

    const envelope = first[0];
    if (!envelope) throw new Error('Missing first holder envelope');
    expect(
      get(verifyEscrowShareEphemeralProof(envelope, genesis, 0, encodePoint(scalePoint(G, 77n)))),
    ).toEqual(envelope);
    const accepted = get(
      acceptEscrowShare({
        envelope,
        genesis,
        dealerSeat: 0,
        expectedMasterPub: encodePoint(scalePoint(G, 77n)),
        holderSeat: 1,
        recipientEncryptionSecret: encryptionSecrets[1],
        holderSigningKey: signingIdentities[1]?.secretKey ?? new Uint8Array(),
      }),
    );
    expect(accepted.value).toBeGreaterThanOrEqual(0n);
    expect(accepted.index).toBe(2);
    const ack = get(
      verifyEscrowShareAck(accepted.ack, genesis, {
        ceremonyId: deckCeremonyId(genesis),
        dealerSeat: 0,
        holderSeat: 1,
        expectedMasterPub: encodePoint(scalePoint(G, 77n)),
        shareHash: accepted.shareHash,
        envelopeHash: escrowShareEnvelopeHash(envelope),
      }),
    );
    expect(ack).toEqual(accepted.ack);
    expect(
      verifyEscrowShareAck(accepted.ack, genesis, {
        ceremonyId: deckCeremonyId(genesis),
        dealerSeat: 0,
        holderSeat: 1,
        expectedMasterPub: encodePoint(scalePoint(G, 77n)),
        shareHash: accepted.shareHash,
        envelopeHash: 'f'.repeat(64),
      }).ok,
    ).toBe(false);
    expect(
      verifyEscrowShareAck(accepted.ack, genesis, {
        ceremonyId: deckCeremonyId(genesis),
        dealerSeat: 2,
        holderSeat: 1,
        expectedMasterPub: encodePoint(scalePoint(G, 77n)),
        shareHash: accepted.shareHash,
        envelopeHash: escrowShareEnvelopeHash(envelope),
      }).ok,
    ).toBe(false);
  });

  test('all exact holders accept shares that reconstruct the manifest master', () => {
    const genesis = body();
    const shares = envelopes(genesis).map((envelope) => {
      const seat = envelope.body.holder.seat;
      const secret = encryptionSecrets.at(seat);
      const identity = signingIdentities.at(seat);
      if (secret === undefined || identity === undefined) throw new Error('Missing holder key');
      return get(
        acceptEscrowShare({
          envelope,
          genesis,
          dealerSeat: 0,
          expectedMasterPub: encodePoint(scalePoint(G, 77n)),
          holderSeat: seat,
          recipientEncryptionSecret: secret,
          holderSigningKey: identity.secretKey,
        }),
      );
    });
    expect(shares.map(({ holderSeat, index }) => [holderSeat, index])).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
    expect(
      recoverSecret(
        shares.map(({ index, value }) => ({ index, value })),
        3,
      ),
    ).toBe(77n);
  });

  test('bot dealer distribution excludes its original human host', () => {
    const genesis = botHostedBySeatTwo();
    const masterSecret = 81n;
    const deliveries = get(
      createEscrowShareEnvelopes({
        genesis,
        dealerSeat: 4,
        expectedMasterPub: encodePoint(scalePoint(G, masterSecret)),
        masterSecret,
        entropy: new Uint8Array(32).fill(92),
        dealerSigningKey: signingIdentities[4]?.secretKey ?? new Uint8Array(),
      }),
    );
    expect(deliveries.map(({ body: envelope }) => envelope.holder.seat)).toEqual([0, 1, 3]);
    expect(deliveries.every(({ body: envelope }) => envelope.threshold === 3)).toBe(true);
  });

  test('rejects another holder, changed envelope bytes, wrong keys, and wrong checked master', () => {
    const genesis = body();
    const envelope = envelopes(genesis)[0];
    if (!envelope) throw new Error('Missing first holder envelope');
    const common = {
      envelope,
      genesis,
      dealerSeat: 0 as Seat,
      expectedMasterPub: encodePoint(scalePoint(G, 77n)),
      holderSeat: 1 as Seat,
      recipientEncryptionSecret: encryptionSecrets[1],
      holderSigningKey: signingIdentities[1]?.secretKey ?? new Uint8Array(),
    };
    expect(acceptEscrowShare({ ...common, holderSeat: 2 }).ok).toBe(false);
    expect(acceptEscrowShare({ ...common, recipientEncryptionSecret: 999n }).ok).toBe(false);
    expect(
      acceptEscrowShare({ ...common, expectedMasterPub: encodePoint(scalePoint(G, 78n)) }).ok,
    ).toBe(false);
    const badProofBody = {
      ...envelope.body,
      ephemeralProof: { ...envelope.body.ephemeralProof, response: encodeScalar(0n) },
    };
    const badProofEnvelope = {
      body: badProofBody,
      sig: signObject(
        'escrow-share',
        badProofBody,
        signingIdentities[0]?.secretKey ?? new Uint8Array(),
      ),
    };
    expect(
      verifyEscrowShareEphemeralProof(badProofEnvelope, genesis, 0, common.expectedMasterPub).ok,
    ).toBe(false);
    const copiedProofBody = {
      ...envelope.body,
      sealed: {
        ...envelope.body.sealed,
        ciphertext: `${envelope.body.sealed.ciphertext[0] === 'A' ? 'B' : 'A'}${envelope.body.sealed.ciphertext.slice(1)}`,
      },
    };
    const copiedProofEnvelope = {
      body: copiedProofBody,
      sig: signObject(
        'escrow-share',
        copiedProofBody,
        signingIdentities[0]?.secretKey ?? new Uint8Array(),
      ),
    };
    expect(
      verifyEscrowShareEphemeralProof(copiedProofEnvelope, genesis, 0, common.expectedMasterPub).ok,
    ).toBe(false);
    const otherCeremony = {
      ...genesis,
      ceremonyNonce: encodeScalar(1234n),
    };
    expect(
      verifyEscrowShareEphemeralProof(envelope, otherCeremony, 0, common.expectedMasterPub).ok,
    ).toBe(false);
    const wrongThresholdBody = { ...envelope.body, threshold: envelope.body.threshold - 1 };
    const wrongThresholdEnvelope = {
      body: wrongThresholdBody,
      sig: signObject(
        'escrow-share',
        wrongThresholdBody,
        signingIdentities[0]?.secretKey ?? new Uint8Array(),
      ),
    };
    expect(
      verifyEscrowShareEphemeralProof(wrongThresholdEnvelope, genesis, 0, common.expectedMasterPub)
        .ok,
    ).toBe(false);
    const oversizedBody = {
      ...envelope.body,
      sealed: { ...envelope.body.sealed, ciphertext: 'A'.repeat(513) },
    };
    const oversizedEnvelope = {
      body: oversizedBody,
      sig: signObject(
        'escrow-share',
        oversizedBody,
        signingIdentities[0]?.secretKey ?? new Uint8Array(),
      ),
    };
    expect(
      verifyEscrowShareEphemeralProof(oversizedEnvelope, genesis, 0, common.expectedMasterPub).ok,
    ).toBe(false);
    const tampered = {
      ...envelope,
      body: {
        ...envelope.body,
        sealed: {
          ...envelope.body.sealed,
          ciphertext: `${envelope.body.sealed.ciphertext.slice(0, -1)}A`,
        },
      },
    };
    expect(acceptEscrowShare({ ...common, envelope: tampered }).ok).toBe(false);
  });

  test('requires every holder encryption key and declines ineligible original rosters', () => {
    const genesis = body();
    const holder = genesis.seats[1];
    if (!holder) throw new Error('Missing holder');
    const missingKey: GenesisBody = {
      ...genesis,
      seats: genesis.seats.map((seat) => {
        if (seat.seat !== 1) return seat;
        const copy = { ...seat };
        delete copy.encryptionKey;
        return copy;
      }),
    };
    expect(
      createEscrowShareEnvelopes({
        genesis: missingKey,
        dealerSeat: 0,
        expectedMasterPub: encodePoint(scalePoint(G, 77n)),
        masterSecret: 77n,
        entropy: new Uint8Array(32).fill(91),
        dealerSigningKey: signingIdentities[0]?.secretKey ?? new Uint8Array(),
      }).ok,
    ).toBe(false);
    const shortGenesis: GenesisBody = {
      ...genesis,
      config: { ...genesis.config, seats: [0, 1, 2] },
      seats: genesis.seats.slice(0, 3),
    };
    expect(
      createEscrowShareEnvelopes({
        genesis: shortGenesis,
        dealerSeat: 0,
        expectedMasterPub: encodePoint(scalePoint(G, 77n)),
        masterSecret: 77n,
        entropy: new Uint8Array(32).fill(91),
        dealerSigningKey: signingIdentities[0]?.secretKey ?? new Uint8Array(),
      }).ok,
    ).toBe(false);
  });

  test('checks the manifest master before creating any delivery', () => {
    const genesis = body();
    expect(
      createEscrowShareEnvelopes({
        genesis,
        dealerSeat: 0,
        expectedMasterPub: encodePoint(scalePoint(G, 78n)),
        masterSecret: 77n,
        entropy: new Uint8Array(32).fill(91),
        dealerSigningKey: signingIdentities[0]?.secretKey ?? new Uint8Array(),
      }).ok,
    ).toBe(false);
    // A caller cannot substitute a self-consistent attacker key and secret for the
    // dealer key already fixed in the signed genesis manifest.
    expect(
      createEscrowShareEnvelopes({
        genesis,
        dealerSeat: 0,
        expectedMasterPub: encodePoint(scalePoint(G, 78n)),
        masterSecret: 78n,
        entropy: new Uint8Array(32).fill(91),
        dealerSigningKey: signingIdentities[0]?.secretKey ?? new Uint8Array(),
      }).ok,
    ).toBe(false);
    const envelope = envelopes(genesis)[0];
    if (!envelope) throw new Error('Missing first holder envelope');
    expect(
      verifyEscrowShareEphemeralProof(envelope, genesis, 0, encodePoint(scalePoint(G, 78n))).ok,
    ).toBe(false);
    expect(
      acceptEscrowShare({
        envelope,
        genesis,
        dealerSeat: 0,
        expectedMasterPub: encodePoint(scalePoint(G, 78n)),
        holderSeat: 1,
        recipientEncryptionSecret: encryptionSecrets[1],
        holderSigningKey: signingIdentities[1]?.secretKey ?? new Uint8Array(),
      }).ok,
    ).toBe(false);
    const noMasters: GenesisBody = { ...genesis, commitments: {} };
    expect(
      verifyEscrowShareEphemeralProof(envelope, noMasters, 0, encodePoint(scalePoint(G, 77n))),
    ).toMatchObject({ ok: false, error: { code: 'genesis-masters' } });
    expect(
      acceptEscrowShare({
        envelope,
        genesis: noMasters,
        dealerSeat: 0,
        expectedMasterPub: encodePoint(scalePoint(G, 77n)),
        holderSeat: 1,
        recipientEncryptionSecret: encryptionSecrets[1],
        holderSigningKey: signingIdentities[1]?.secretKey ?? new Uint8Array(),
      }),
    ).toMatchObject({ ok: false, error: { code: 'genesis-masters' } });
  });

  test('rejects a signed degree-deficient Feldman polynomial', () => {
    const genesis = body();
    const envelope = envelopes(genesis)[0];
    if (!envelope) throw new Error('Missing first holder envelope');
    const payload = canonicalEncode({
      protocol: envelope.body.protocol,
      ceremonyId: envelope.body.ceremonyId,
      dealerSeat: envelope.body.dealer.seat,
      holderSeat: envelope.body.holder.seat,
      holderIndex: envelope.body.holder.index,
      threshold: envelope.body.threshold,
      masterPub: envelope.body.masterPub,
      share: encodeScalar(77n + 12n * BigInt(envelope.body.holder.index)),
    });
    const binding = {
      ...envelope.body,
      commitments: [
        encodePoint(scalePoint(G, 77n)),
        encodePoint(scalePoint(G, 12n)),
        encodePoint(G.subtract(G)),
      ],
      shareHash: toHex(hashValue({ domain: 'cp2p/v1/escrow-share-payload', payload })),
    };
    const contexts = escrowDeliveryContexts(binding);
    const deficientBody = {
      ...binding,
      ...sealWithEphemeralProof(
        payload,
        binding.holder.encryptionKey,
        new Uint8Array(32).fill(91),
        contexts.seal,
        contexts.proof,
      ),
    };
    // The opening, fresh ephemeral proof and dealer signature are otherwise valid.
    expect(readEscrowShareOpening(payload, deficientBody).ok).toBe(true);
    const deficient = {
      body: deficientBody,
      sig: signObject(
        'escrow-share',
        deficientBody,
        signingIdentities[0]?.secretKey ?? new Uint8Array(),
      ),
    };
    expect(
      verifyEscrowShareEphemeralProof(deficient, genesis, 0, encodePoint(scalePoint(G, 77n))),
    ).toMatchObject({ ok: false, error: { code: 'escrow-coefficient' } });
  });

  test('rejects escrow distribution under stub genesis', () => {
    const stub = { ...body(), security: 'stub' as const };
    expect(
      createEscrowShareEnvelopes({
        genesis: stub,
        dealerSeat: 0,
        expectedMasterPub: encodePoint(scalePoint(G, 77n)),
        masterSecret: 77n,
        entropy: new Uint8Array(32).fill(91),
        dealerSigningKey: signingIdentities[0]?.secretKey ?? new Uint8Array(),
      }).ok,
    ).toBe(false);
  });

  test('rejects a re-signed share that is canonical but does not open its Feldman commitment', () => {
    const genesis = body();
    const envelope = envelopes(genesis)[0];
    if (!envelope) throw new Error('Missing first holder envelope');
    const prior = envelope.body;
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
    const shareHash = toHex(hashValue({ domain: 'cp2p/v1/escrow-share-payload', payload }));
    const binding = {
      protocol: prior.protocol,
      ceremonyId: prior.ceremonyId,
      dealer: prior.dealer,
      holder: prior.holder,
      threshold: prior.threshold,
      masterPub: prior.masterPub,
      commitments: prior.commitments,
      shareHash,
    };
    const sealContext = { domain: 'cp2p/v1/escrow-sealed-share', ...binding };
    const proofContext = { domain: 'cp2p/v1/escrow-share-ephemeral-proof', ...binding };
    const sealed = sealWithEphemeralProof(
      payload,
      prior.holder.encryptionKey,
      new Uint8Array(32).fill(91),
      sealContext,
      proofContext,
    );
    payload.fill(0);
    const badBody = {
      ...prior,
      shareHash,
      sealed: sealed.sealed,
      ephemeralProof: sealed.ephemeralProof,
    };
    const badEnvelope = {
      body: badBody,
      sig: signObject('escrow-share', badBody, signingIdentities[0]?.secretKey ?? new Uint8Array()),
    };
    expect(
      acceptEscrowShare({
        envelope: badEnvelope,
        genesis,
        dealerSeat: 0,
        expectedMasterPub: encodePoint(scalePoint(G, 77n)),
        holderSeat: 1,
        recipientEncryptionSecret: encryptionSecrets[1],
        holderSigningKey: signingIdentities[1]?.secretKey ?? new Uint8Array(),
      }).ok,
    ).toBe(false);
  });
});
