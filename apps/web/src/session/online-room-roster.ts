import type { PeerId } from '@cp2p/protocol';

const MAX_MESH_PEERS = 6;

export interface PregameRosterSources {
  readonly self: PeerId;
  readonly host: PeerId;
  readonly seated: readonly PeerId[];
  readonly connected: readonly PeerId[];
  readonly spectators: readonly PeerId[];
  /** Current, unseated discovery candidates, newest first. */
  readonly transient: readonly PeerId[];
}

/** Reserve current game participants before filling spare pregame discovery slots. */
export function planPregameRoster(sources: PregameRosterSources): readonly PeerId[] {
  const roster: PeerId[] = [];
  const add = (peer: PeerId) => {
    if (roster.length < MAX_MESH_PEERS && !roster.includes(peer)) roster.push(peer);
  };
  add(sources.self);
  add(sources.host);
  for (const peer of sources.seated) add(peer);
  for (const peer of sources.connected) add(peer);
  for (const peer of sources.spectators) add(peer);
  for (const peer of sources.transient) add(peer);
  return roster;
}
