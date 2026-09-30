/**
 * Route classes for the PWA guards. A reload on these screens would interrupt play (a local
 * game, an online game, or a lobby holding peer connections), so update prompts wait.
 */
export function isActiveGamePath(path: string): boolean {
  if (/^\/local\/new\/?$/.test(path)) return false;
  return /^\/(?:local|game|lobby)\/[^/]+\/?$/.test(path);
}

/** Screens that keep the display awake: local and online games. */
export function isWakeLockPath(path: string): boolean {
  return isActiveGamePath(path) && !path.startsWith('/lobby/');
}

/** Online games only: backgrounding their tab can drop the peer connections. */
export function isOnlineGamePath(path: string): boolean {
  return /^\/game\/[^/]+\/?$/.test(path);
}
