import type { GameConfig, Seat } from '@cp2p/engine';
import type { PeerId } from './transport.js';
import type { GenesisSeedMode } from './genesis-seed.js';
import type { TakeoverPolicy } from './takeover-policy.js';

export const LOBBY_COLOURS = ['blue', 'orange', 'green', 'magenta', 'yellow', 'red'] as const;
export type LobbyColour = (typeof LOBBY_COLOURS)[number];
export type LobbyBotLevel = 'easy' | 'medium' | 'hard';

export type LobbySeat =
  | { seat: Seat; kind: 'open'; colour: LobbyColour; ready: false }
  | { seat: Seat; kind: 'human'; peer: PeerId; name: string; colour: LobbyColour; ready: boolean }
  | {
      seat: Seat;
      kind: 'bot';
      name: string;
      colour: LobbyColour;
      ready: false;
      botLevel: LobbyBotLevel;
      botHost: PeerId;
    };

/** A host-signed draft. The ceremony must issue new per-game keys after freeze. */
export interface LobbyState {
  readonly lobbyId: string;
  readonly hostPeer: PeerId;
  readonly hostEpoch: number;
  readonly version: number;
  readonly name: string;
  readonly seats: readonly LobbySeat[];
  readonly spectators: readonly PeerId[];
  readonly config: GameConfig;
  readonly seedMode: GenesisSeedMode;
  readonly takeover: TakeoverPolicy;
  readonly status: 'open' | 'starting' | 'started';
  readonly ceremonyNonce: string | null;
}

export type LobbyRequest =
  | { kind: 'takeSeat'; seat: Seat }
  | { kind: 'leaveSeat' }
  | { kind: 'setName'; name: string }
  | { kind: 'setColour'; colour: LobbyColour }
  | { kind: 'setReady'; ready: boolean }
  | { kind: 'spectate' };

export interface LobbyFreezeAck {
  readonly body: {
    readonly lobbyId: string;
    readonly hostEpoch: number;
    readonly ceremonyNonce: string;
    readonly stateHash: string;
    readonly peer: PeerId;
  };
  readonly sig: string;
}

export interface LobbyFreezeAgreement {
  readonly state: LobbyState;
  readonly acks: readonly LobbyFreezeAck[];
}

export type LobbyDiagnostic =
  | { kind: 'protocol-version'; hostVersion: number }
  | { kind: 'engine-version'; hostVersion: string }
  | { kind: 'invalid-message'; code: string };
