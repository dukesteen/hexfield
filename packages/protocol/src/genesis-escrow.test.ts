import { fromBase64Url } from '@cp2p/codec';
import { encodePoint, G, identityFromSecret, scalePoint } from '@cp2p/crypto';
import { success } from '@cp2p/engine';
import type { Seat } from '@cp2p/engine';
import { beforeAll, describe, expect, test } from 'vitest';
import { deriveEscrowRosters } from './escrow-roster.js';
import { validateDeckCeremony } from './deck-genesis.js';
import {
  createEscrowShareEnvelopes,
  acceptEscrowShare,
  prepareEscrowVerifier,
} from './escrow-distribution.js';
import {
  genesisBody as readGenesisBody,
  genesisId,
  signGenesis,
  signVerifiedGenesis,
  validateGenesis,
} from './genesis.js';
import { validateGenesisEscrow } from './genesis-escrow.js';
import { validateGenesisMasters } from './genesis-masters.js';
import type { EscrowDealerCommitment } from './genesis-escrow.js';
import type { MasterCommitment } from './genesis-masters.js';
import type { Genesis, GenesisBody, GenesisSeat } from './types.js';
import { protocolFixture } from './testing/fixtures.js';
import { createGenesisDeckFixture } from './testing/deck-fixture.js';
import { createSimulationGenesis } from './testing/simulation-genesis.js';

const identities = Array.from({ length: 6 }, (_, index) =>
  identityFromSecret(new Uint8Array(32).fill(index + 40)),
);
const encryptionSecrets = [201n, 202n, 203n, 204n, 205n, 206n] as const;
const masterSecrets = [71n, 72n, 73n, 74n, 75n, 76n] as const;

function identityAt(seat: number) {
  const identity = identities[seat];
  if (!identity) throw new Error(`Missing identity ${seat}`);
  return identity;
}

function baseBody(humans: number, seatCount = 4): GenesisBody {
  const fixture = protocolFixture();
  const seatNumbers: Seat[] = [0, 1, 2, 3, 4, 5];
  const seats: GenesisSeat[] = seatNumbers.slice(0, seatCount).map((seat, index) => {
    const identity = identityAt(index);
    const common = {
      seat,
      publicKey: identity.peerId,
      encryptionKey: encodePoint(scalePoint(G, encryptionSecrets[index] ?? 201n)),
      name: `Seat ${seat}`,
      colour: `#${(index + 1).toString(16).repeat(6)}`,
    };
    if (index < humans) return { ...common, kind: 'human' };
    return { ...common, kind: 'bot', botHost: identityAt(0).peerId };
  });
  return {
    ...fixture.body,
    config: { ...fixture.body.config, seats: seats.map(({ seat }) => seat) },
    seats,
    security: 'verified',
    commitments: {},
  };
}

function signedGenesis(body: GenesisBody): Genesis {
  return {
    ...body,
    gameId: genesisId(body),
    signatures: body.seats
      .filter((seat) => seat.kind === 'human')
      .map((seat) => ({
        seat: seat.seat,
        sig: signGenesis(body, seat.seat, identityAt(seat.seat).secretKey).sig,
      })),
  };
}

function masterEntries(body: GenesisBody): MasterCommitment[] {
  return body.seats.map(({ seat }) => ({
    seat,
    masterPub: encodePoint(scalePoint(G, masterSecrets[seat] ?? 71n)),
  }));
}

function shareEnvelopes(body: GenesisBody, dealerSeat: Seat, entropyByte?: number) {
  const secret = masterSecrets[dealerSeat] ?? 71n;
  const result = createEscrowShareEnvelopes({
    genesis: body,
    dealerSeat,
    expectedMasterPub: encodePoint(scalePoint(G, secret)),
    masterSecret: secret,
    entropy: new Uint8Array(32).fill(entropyByte ?? 100 + dealerSeat),
    dealerSigningKey: identityAt(dealerSeat).secretKey,
  });
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function deliveryFor(body: GenesisBody, envelope: ReturnType<typeof shareEnvelopes>[number]) {
  const holder = envelope.body.holder.seat;
  const accepted = acceptEscrowShare({
    envelope,
    genesis: body,
    dealerSeat: envelope.body.dealer.seat,
    expectedMasterPub: envelope.body.masterPub,
    holderSeat: holder,
    recipientEncryptionSecret: encryptionSecrets[holder] ?? 201n,
    holderSigningKey: identityAt(holder).secretKey,
  });
  if (!accepted.ok) throw new Error(`${accepted.error.code}: ${accepted.error.message}`);
  return { envelope, ack: accepted.value.ack };
}

function completeGenesis(humans = 4, seatCount = 4): Genesis {
  const genesisBody = baseBody(humans, seatCount);
  const body: GenesisBody = {
    ...genesisBody,
    commitments: { masters: masterEntries(genesisBody) },
  };
  const rosters = deriveEscrowRosters(body);
  if (!rosters.ok) throw new Error(`${rosters.error.code}: ${rosters.error.message}`);
  const escrow = rosters.value
    .filter((roster) => roster.eligible)
    .map((roster) => ({
      dealerSeat: roster.dealer.seat,
      shares: shareEnvelopes(body, roster.dealer.seat).map((envelope) =>
        deliveryFor(body, envelope),
      ),
    }));
  return signedGenesis({
    ...body,
    commitments: {
      ...body.commitments,
      escrow,
    },
  });
}

function errorCode(result: { ok: boolean; error?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

function acceptedRows(genesis: Genesis): EscrowDealerCommitment[] {
  const result = validateGenesisEscrow(genesis);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return [...result.value];
}

describe('verified genesis escrow transcript', () => {
  test('master commitments require canonical nonidentity point encodings', () => {
    const base = baseBody(4);
    const masters = masterEntries(base);
    const genesis: GenesisBody = { ...base, commitments: { masters } };
    expect(validateGenesisMasters(genesis).ok).toBe(true);
    const master = masters[0];
    if (!master) throw new Error('Missing master commitment');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(master.masterPub.at(-1) ?? '');
    const noncanonical = `${master.masterPub.slice(0, -1)}${alphabet[last ^ 1]}`;
    expect(noncanonical).toHaveLength(43);
    expect(fromBase64Url(master.masterPub)).toHaveLength(32);
    expect(() => fromBase64Url(noncanonical)).toThrow('canonical base64url');
    const padded: GenesisBody = {
      ...genesis,
      commitments: {
        ...genesis.commitments,
        masters: [{ ...master, masterPub: noncanonical }, ...masters.slice(1)],
      },
    };
    expect(validateGenesisMasters(padded).ok).toBe(false);
    const identity: GenesisBody = {
      ...genesis,
      commitments: {
        ...genesis.commitments,
        masters: [{ ...master, masterPub: encodePoint(G.subtract(G)) }, ...masters.slice(1)],
      },
    };
    expect(validateGenesisMasters(identity).ok).toBe(false);
  });

  let fourHuman: Genesis;
  let fourHumanAndBot: Genesis;

  beforeAll(() => {
    fourHuman = completeGenesis(4, 4);
    fourHumanAndBot = completeGenesis(4, 5);
  });

  test('accepts exact signed four-human delivery and ACK order from full signed Genesis', () => {
    const result = validateGenesisEscrow(fourHuman);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map(({ dealerSeat }) => dealerSeat)).toEqual([0, 1, 2, 3]);
    expect(
      result.value.map(({ shares }) => shares.map(({ envelope }) => envelope.body.holder.seat)),
    ).toEqual([
      [1, 2, 3],
      [0, 2, 3],
      [0, 1, 3],
      [0, 1, 2],
    ]);
  });

  test('accepts the bot dealer and excludes its original human host', () => {
    const result = validateGenesisEscrow(fourHumanAndBot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map(({ dealerSeat }) => dealerSeat)).toEqual([0, 1, 2, 3, 4]);
    expect(result.value[4]?.shares.map(({ envelope }) => envelope.body.holder.seat)).toEqual([
      1, 2, 3,
    ]);
  });

  test.each([1, 2, 3])('%i original humans produce an explicit empty escrow list', (humans) => {
    const genesis = signedGenesis({
      ...baseBody(humans, 4),
      commitments: { masters: masterEntries(baseBody(humans, 4)), escrow: [] },
    });
    expect(validateGenesisEscrow(genesis)).toEqual({ ok: true, value: [] });
  });

  test('rejects a non-empty escrow transcript with fewer than four original humans', () => {
    const body = baseBody(3, 4);
    const genesis = signedGenesis({
      ...body,
      commitments: {
        masters: masterEntries(body),
        escrow: acceptedRows(fourHuman).slice(0, 1),
      },
    });
    expect(errorCode(validateGenesisEscrow(genesis))).toBe('genesis-escrow-roster');
  });

  test('aggregate admission validates a real four-human deck and escrow before the callback', () => {
    const simulation = createSimulationGenesis({ seed: 317, humanCount: 4 });
    const draft: GenesisBody = {
      ...readGenesisBody(simulation.genesis),
      security: 'verified',
      commitments: {},
    };
    const fixture = createGenesisDeckFixture(draft, simulation.identities);
    const sign = (body: GenesisBody): Genesis => ({
      ...body,
      gameId: genesisId(body),
      signatures: body.seats.map(({ seat }) => {
        const identity = simulation.identities.get(seat);
        if (!identity) throw new Error(`Missing identity for seat ${seat}`);
        return signGenesis(body, seat, identity.secretKey);
      }),
    });
    const valid = validateGenesis(sign(fixture.body), simulation.engine, {
      verifyCommitments: (genesis) => validateDeckCeremony(genesis, fixture.transcripts),
    });
    expect(valid.ok).toBe(true);

    const escrow = acceptedRows(sign(fixture.body));
    const dealer = escrow[0];
    const delivery = dealer?.shares[0];
    if (!dealer || !delivery) throw new Error('Missing generated escrow delivery');
    const corrupted: GenesisBody = {
      ...fixture.body,
      commitments: {
        ...fixture.body.commitments,
        escrow: [
          {
            ...dealer,
            shares: [
              { ...delivery, ack: { ...delivery.ack, sig: 'A'.repeat(86) } },
              ...dealer.shares.slice(1),
            ],
          },
          ...escrow.slice(1),
        ],
      },
    };
    let callbackCalled = false;
    const invalid = validateGenesis(sign(corrupted), simulation.engine, {
      verifyCommitments: () => {
        callbackCalled = true;
        return success(undefined);
      },
    });
    expect(errorCode(invalid)).toBe('escrow-ack-signature');
    expect(callbackCalled).toBe(false);
  }, 30_000);

  test('rejects missing, extra, duplicate, or reordered shares and dealers', () => {
    const originalEscrow = acceptedRows(fourHuman);
    const dealer0 = originalEscrow[0];
    if (!dealer0) throw new Error('Missing dealer 0 transcript');
    const firstShare = dealer0.shares[0];
    const secondShare = dealer0.shares[1];
    if (!firstShare || !secondShare) throw new Error('Missing dealer 0 shares');
    const cases = [
      originalEscrow.slice(1),
      [...originalEscrow, dealer0],
      [originalEscrow[1] ?? dealer0, dealer0, ...originalEscrow.slice(2)],
      [{ ...dealer0, shares: dealer0.shares.slice(1) }, ...originalEscrow.slice(1)],
      [{ ...dealer0, shares: [...dealer0.shares, firstShare] }, ...originalEscrow.slice(1)],
      [
        { ...dealer0, shares: [secondShare, firstShare, ...dealer0.shares.slice(2)] },
        ...originalEscrow.slice(1),
      ],
    ];
    for (const escrow of cases) {
      const mutated = signedGenesis({
        ...fourHuman,
        commitments: { ...fourHuman.commitments, escrow },
      });
      expect(validateGenesisEscrow(mutated).ok).toBe(false);
    }
  });

  test('rejects transplanted or forged holder ACKs', () => {
    const escrow = acceptedRows(fourHuman);
    const dealer0 = escrow[0];
    const dealer1 = escrow[1];
    if (!dealer0 || !dealer1) throw new Error('Missing dealer transcripts');
    const transplanted = [...escrow];
    transplanted[0] = {
      ...dealer0,
      shares: dealer0.shares.map((share, index) =>
        index === 0 ? { ...share, ack: dealer1.shares[0]?.ack ?? share.ack } : share,
      ),
    };
    expect(
      validateGenesisEscrow(
        signedGenesis({
          ...fourHuman,
          commitments: { ...fourHuman.commitments, escrow: transplanted },
        }),
      ).ok,
    ).toBe(false);
    const forged = [...escrow];
    forged[0] = {
      ...dealer0,
      shares: dealer0.shares.map((share, index) =>
        index === 0 ? { ...share, ack: { ...share.ack, sig: 'A'.repeat(86) } } : share,
      ),
    };
    expect(
      validateGenesisEscrow(
        signedGenesis({ ...fourHuman, commitments: { ...fourHuman.commitments, escrow: forged } }),
      ).ok,
    ).toBe(false);
  });

  test('rejects a dealer that mixes two independently valid Feldman polynomials', () => {
    const escrow = acceptedRows(fourHuman);
    const dealer0 = escrow[0];
    if (!dealer0) throw new Error('Missing dealer 0 transcript');
    const genesisBody = baseBody(4, 4);
    const beforeDistribution = {
      ...genesisBody,
      commitments: { masters: masterEntries(genesisBody) },
    };
    const alternate = shareEnvelopes(beforeDistribution, 0, 211);
    const alternateEnvelope = alternate[0];
    if (!alternateEnvelope) throw new Error('Missing alternate holder envelope');
    const alternateDelivery = deliveryFor(beforeDistribution, alternateEnvelope);
    const mixed = [...escrow];
    mixed[0] = {
      ...dealer0,
      shares: [alternateDelivery, ...dealer0.shares.slice(1)],
    };
    const result = validateGenesisEscrow(
      signedGenesis({ ...fourHuman, commitments: { ...fourHuman.commitments, escrow: mixed } }),
    );
    expect(errorCode(result)).toBe('genesis-escrow-polynomial');
    mixed[0] = {
      ...dealer0,
      shares: [
        { ...alternateDelivery, envelope: { ...alternateDelivery.envelope, sig: 'A'.repeat(86) } },
        ...dealer0.shares.slice(1),
      ],
    };
    expect(
      errorCode(
        validateGenesisEscrow({
          ...fourHuman,
          commitments: { ...fourHuman.commitments, escrow: mixed },
        }),
      ),
    ).toBe('genesis-escrow-polynomial');
  });

  test('a reused verifier retains its detached manifest when caller data changes', () => {
    const draft = structuredClone(fourHuman);
    const rows = acceptedRows(draft);
    const delivery = rows[0]?.shares[0];
    if (!delivery) throw new Error('Missing delivery');
    const verifier = prepareEscrowVerifier(draft);
    if (!verifier.ok) throw new Error(verifier.error.message);
    const master = delivery.envelope.body.masterPub;
    draft.commitments.masters = [];
    draft.seats.length = 0;
    expect(verifier.value.envelope(delivery.envelope, 0, master).ok).toBe(true);
    expect(
      verifier.value.ack(delivery.ack, {
        ceremonyId: delivery.ack.body.ceremonyId,
        dealerSeat: 0,
        holderSeat: delivery.envelope.body.holder.seat,
        expectedMasterPub: master,
        shareHash: delivery.envelope.body.shareHash,
        envelopeHash: delivery.ack.body.envelopeHash,
      }).ok,
    ).toBe(true);
  });

  test('binds every dealer transcript to the expected master commitment', () => {
    const masters = masterEntries(fourHuman);
    const changedMasters = masters.map((entry) =>
      entry.seat === 0 ? { ...entry, masterPub: encodePoint(scalePoint(G, 99n)) } : entry,
    );
    const changed = signedGenesis({
      ...fourHuman,
      commitments: { ...fourHuman.commitments, masters: changedMasters },
    });
    expect(validateGenesisEscrow(changed).ok).toBe(false);
  });

  test('missing transcript blocks consent and admission before the commitment callback', () => {
    const fixture = protocolFixture();
    const base = baseBody(4, 4);
    const bodyWithoutEscrow: GenesisBody = {
      ...base,
      commitments: { masters: masterEntries(base) },
    };
    expect(errorCode(signVerifiedGenesis(bodyWithoutEscrow, [], 0, identityAt(0).secretKey))).toBe(
      'genesis-escrow',
    );
    let callbackCalled = false;
    const genesis = signedGenesis(bodyWithoutEscrow);
    const admitted = validateGenesis(genesis, fixture.engine, {
      verifyCommitments: () => {
        callbackCalled = true;
        return { ok: true, value: undefined };
      },
    });
    expect(admitted.ok).toBe(false);
    expect(errorCode(admitted)).toBe('genesis-escrow');
    expect(callbackCalled).toBe(false);
  });
});
