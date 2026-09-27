import { hashValue, toHex } from '@cp2p/codec';
import { identityFromSecret, signObject } from '@cp2p/crypto';
import type { Identity } from '@cp2p/crypto';
import type { Seat } from '@cp2p/engine';
import { validateGenesisOnlineStart, ONLINE_START_PROTOCOL } from '../genesis-online-start.js';
import { validateGenesisMasters } from '../genesis-masters.js';
import { signGameSeatBinding } from '../online-bindings.js';
import { LOBBY_COLOURS } from '../lobby-types.js';
import type { LobbyFreezeAgreement, LobbySeat, LobbyState } from '../lobby-types.js';
import type { GenesisBody } from '../types.js';

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing online-start fixture value');
  return item;
}

/** Test-only device consent over the existing verified fixture's exact fixed board seed. */
export function attachFixtureOnlineStart(
  body: GenesisBody,
  gameIdentities: ReadonlyMap<Seat, Identity>,
): GenesisBody {
  const humans = body.seats.filter((seat) => seat.kind === 'human');
  const devices = new Map(
    humans.map((seat) => [
      seat.publicKey,
      identityFromSecret(
        hashValue({ domain: 'cp2p/test/online-device/v1', gamePeer: seat.publicKey }),
      ),
    ]),
  );
  const seats: LobbySeat[] = body.seats.map((seat) => {
    const colour = required(LOBBY_COLOURS[seat.seat]);
    if (seat.colour !== colour) throw new Error('Fixture seat colour is not lobby-approved');
    if (seat.kind === 'human') {
      return {
        seat: seat.seat,
        kind: 'human',
        peer: required(devices.get(seat.publicKey)).peerId,
        name: seat.name,
        colour,
        ready: true,
      };
    }
    return {
      seat: seat.seat,
      kind: 'bot',
      name: seat.name,
      colour,
      ready: false,
      botLevel: 'easy',
      botHost: required(devices.get(seat.botHost)).peerId,
    };
  });
  const state: LobbyState = {
    lobbyId: `fixture_${toHex(hashValue(body.ceremonyNonce)).slice(0, 16)}`,
    hostPeer: required(devices.get(required(humans[0]).publicKey)).peerId,
    hostEpoch: 0,
    version: 0,
    name: 'Verified fixture',
    seats,
    spectators: [],
    config: body.config,
    seedMode: { kind: 'fixed', seed: body.genesisSeed },
    takeover: body.takeover,
    status: 'starting',
    ceremonyNonce: body.ceremonyNonce,
  };
  const stateHash = toHex(hashValue(state));
  const agreement: LobbyFreezeAgreement = {
    state,
    acks: humans.map((seat) => {
      const device = required(devices.get(seat.publicKey));
      const ackBody = {
        lobbyId: state.lobbyId,
        hostEpoch: state.hostEpoch,
        ceremonyNonce: body.ceremonyNonce,
        stateHash,
        peer: device.peerId,
      };
      return { body: ackBody, sig: signObject('lobby-freeze-ack', ackBody, device.secretKey) };
    }),
  };
  const checkedMasters = validateGenesisMasters(body);
  if (!checkedMasters.ok)
    throw new Error(`Fixture masters failed: ${checkedMasters.error.message}`);
  const masters = checkedMasters.value;
  const bindings = body.seats.map((seat) => {
    const game = required(gameIdentities.get(seat.seat));
    if (game.peerId !== seat.publicKey) throw new Error('Fixture game identity differs from seat');
    const device = required(devices.get(seat.kind === 'human' ? seat.publicKey : seat.botHost));
    const signed = signGameSeatBinding({
      agreement,
      seat: seat.seat,
      deviceSecretKey: device.secretKey,
      gamePeer: game.peerId,
      masterPub: required(masters[seat.seat]).masterPub,
      encryptionKey: required(seat.encryptionKey),
    });
    if (!signed.ok) throw new Error(`Fixture binding failed: ${signed.error.message}`);
    return signed.value;
  });
  const next: GenesisBody = {
    ...body,
    commitments: {
      ...body.commitments,
      onlineStart: {
        protocol: ONLINE_START_PROTOCOL,
        agreement,
        bindings,
        seed: { protocol: 'genesis-seed-v1', kind: 'fixed', seed: body.genesisSeed },
      },
    },
  };
  const checked = validateGenesisOnlineStart(next);
  if (!checked.ok) throw new Error(`Fixture online start failed: ${checked.error.message}`);
  return next;
}
