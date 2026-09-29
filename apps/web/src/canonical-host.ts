/**
 * The address to move to when the app is opened on a `www.` host, so saves, settings and the
 * signaling origin check all use the one canonical origin. Null when already canonical.
 */
export function canonicalUrl(location: Pick<Location, 'href' | 'hostname'>): string | null {
  if (!location.hostname.startsWith('www.')) return null;
  const url = new URL(location.href);
  url.hostname = location.hostname.slice('www.'.length);
  return url.href;
}
