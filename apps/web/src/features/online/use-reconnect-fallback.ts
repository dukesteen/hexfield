import { useEffect, useState } from 'react';
import type { OnlineRoomSnapshot } from '../../session/online-room.js';

// Give the known peer a full WebRTC attempt before offering manual connection codes.
const AUTOMATIC_RECONNECT_MS = 30_000;

export function reconnectPlayers(snapshot: OnlineRoomSnapshot) {
  const roster = snapshot.agreement?.state ?? snapshot.lobby;
  return (
    roster?.seats.flatMap((seat) => {
      if (seat.kind !== 'human') return [];
      const peer = snapshot.deviceRoutes
        ? snapshot.deviceRoutes.seats.find((route) => route.seat === seat.seat)?.devicePeer
        : seat.peer;
      return peer && peer !== snapshot.self ? [{ peer, name: seat.name }] : [];
    }) ?? []
  );
}

/** UI fallback only. Transport retries continue and never change protocol authority. */
export function useReconnectFallback(snapshot: OnlineRoomSnapshot | null): boolean {
  const missingKey = (snapshot ? reconnectPlayers(snapshot) : [])
    .filter(({ peer }) => !snapshot?.peers.includes(peer))
    .map(({ peer }) => peer)
    .toSorted()
    .join(',');
  const [expiredKey, setExpiredKey] = useState<string | null>(null);
  useEffect(() => {
    setExpiredKey(null);
    if (!missingKey || snapshot?.closed) return undefined;
    const timer = window.setTimeout(() => setExpiredKey(missingKey), AUTOMATIC_RECONNECT_MS);
    return () => window.clearTimeout(timer);
  }, [missingKey, snapshot?.closed]);

  // A manual room with no remaining link has no route for automatic signaling.
  const noSignalingRoute = snapshot && !snapshot.invite.serverUrl && snapshot.peers.length === 0;
  return (
    !!snapshot &&
    !snapshot.closed &&
    !!missingKey &&
    (!!noSignalingRoute || expiredKey === missingKey)
  );
}
