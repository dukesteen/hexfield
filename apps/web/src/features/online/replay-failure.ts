import type { TFunction } from 'i18next';
import { PublicReplayVersionError } from '../../session/online-public-archive-client.js';

/**
 * The message for a replay that failed to import or open. Archives from another version say
 * so ("created with an older version"); they stay closed because verification failed.
 */
export function replayFailureMessage(error: unknown, t: TFunction): string {
  if (error instanceof PublicReplayVersionError)
    return error.version.relation === 'older'
      ? t('lobby:publicReplayOlderVersion', { version: error.version.version })
      : t('lobby:publicReplayNewerVersion', { version: error.version.version });
  return t('lobby:publicReplayFailed');
}
