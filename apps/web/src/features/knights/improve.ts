import type { CommandShape } from '@cp2p/engine';
import { TRACKS } from './state';
import type { Track } from './state';

/** The tracks the engine offers a level on, from the seat's legal commands. */
export function improvableTracks(commands: readonly CommandShape[]): Track[] {
  return TRACKS.filter((track) =>
    commands.some((command) => command.type === 'BUILD_IMPROVEMENT' && command.track === track),
  );
}
