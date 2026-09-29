import { hashValue, toHex } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import type { Result } from '@cp2p/engine';
import { SCENARIOS, scenarioConfig } from '@cp2p/maps';
import { LobbyController } from '@cp2p/protocol';
import { createMemnet } from '@cp2p/protocol/testing';
import { describe, expect, test } from 'vitest';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

const SEAFARING = SCENARIOS.filter((scenario) => scenario.modules.includes('seafaring'));

describe('online lobby with seafaring scenarios', () => {
  test.each(SEAFARING.map((scenario) => [scenario.id, scenario] as const))(
    '%s is accepted by the host and replicated with its board and options',
    (_id, scenario) => {
      const keys = [1, 2].map((number) => new Uint8Array(32).fill(number));
      const peers = keys.map((key) => identityFromSecret(key).peerId);
      const net = createMemnet({ peers });
      const [hostKey, guestKey, hostPeer, guestPeer] = [keys[0], keys[1], peers[0], peers[1]];
      if (!hostKey || !guestKey || !hostPeer || !guestPeer) throw new Error('Missing keys');
      const config = scenarioConfig(scenario, scenario.seats.max);
      const host = value(
        LobbyController.createHost({
          lobbyId: 'room_sea',
          name: 'Sea',
          hostName: 'Avery',
          config: scenarioConfig(scenario, scenario.seats.min),
          transport: net.transport(hostPeer),
          clock: net.clock,
          secretKey: hostKey,
        }),
      );
      const guest = value(
        LobbyController.join({
          lobbyId: 'room_sea',
          hostPeer,
          transport: net.transport(guestPeer),
          clock: net.clock,
          secretKey: guestKey,
        }),
      );
      try {
        net.clock.advanceBy(0);
        value(host.configure(config));
        net.clock.advanceBy(0);
        const replicated = guest.state()?.config;
        expect(replicated?.modules.map((module) => module.id)).toContain('seafaring');
        expect(replicated?.seats).toHaveLength(scenario.seats.max);
        // Fixed boards travel in the signed config; the archipelago is left to the genesis seed.
        expect(toHex(hashValue(replicated?.board ?? null))).toBe(
          toHex(hashValue(config.board ?? null)),
        );
        expect(replicated?.options.seafaring).toEqual(config.options.seafaring);
      } finally {
        host.dispose();
        guest.dispose();
        net.dispose();
      }
    },
    // The 11x9 boards hash and sign a larger config; keep room on a loaded worker.
    30_000,
  );
});
