# 08 — WebRTC Networking & Signaling

## Goal

Implement `@cp2p/p2p`:

- a real `Transport` (from stage 06) over a **full mesh of WebRTC DataChannels**,
- pluggable **signaling adapters**: manual codes/QR (zero server), a tiny WebSocket signaling service, and in-mesh relay for mesh completion,
- configurable STUN/TURN,
- connection diagnostics.

Plus `apps/signaling`, the optional signaling service.

## Prerequisites

Stage 06 is complete. This stage can be built in parallel with stage 07.

## 1. Peer connections

- One `RTCPeerConnection` per remote peer. N ≤ 6 → at most 15 connections per game (5 per peer).
- Use the **perfect negotiation** pattern (the MDN reference implementation):
  - the "polite" peer is the one with the lexicographically smaller `PeerId`,
  - handle glare and ICE restarts,
  - use trickle ICE when the signaling channel supports it.
- DataChannels (negotiated, pre-agreed ids, so no extra signaling round):
  - `game` (id 0): `ordered: true`, reliable. All protocol messages.
  - `bulk` (id 1): `ordered: true`, reliable. Snapshots and sync batches, so they don't head-of-line-block game traffic.
- **Framing & chunking**: messages > 16 KiB are split into chunks: `[msgId u32][index u16][count u16][payload]`. Reassemble with a 30 s timeout and a 1 MiB cap. Respect `bufferedAmount`: pause sending above 1 MiB, resume on `bufferedamountlow` (threshold 256 KiB).
- **Peer authentication**: after the channel opens, both sides exchange `HELLO` signed with their Ed25519 identity key, _including a hash of the DTLS fingerprints of both sides_ (from the local/remote SDP). This binds the identity to this DTLS session and stops a malicious signaling server from man-in-the-middling. If the fingerprint binding fails, close the connection and show a security warning.
- Liveness: `PING` every 2 s. Mark the peer down after 3 missed pongs, or on `connectionState` = `failed`/`closed`. On `disconnected`, wait 5 s, then try an ICE restart. On `failed`, rebuild the connection via any available signaling path.

## 2. Signaling adapters

```ts
interface SignalingAdapter {
  kind: 'manual' | 'server' | 'mesh-relay';
  // deliver an opaque signaling blob to a specific peer (or a room)
  send(to: PeerId | 'room', blob: SignalBlob): Promise<void>;
  onSignal(cb: (from: PeerId, blob: SignalBlob) => void): Unsubscribe;
  close(): void;
}
```

### 2.1 Manual (copy/paste + QR) — zero infrastructure

- Only between the **inviter** and each **joiner**. Remaining mesh links are built via mesh relay (§2.3).
- Uses non-trickle ICE: wait for `icegatheringstate == complete` (with a 4 s cap), then encode.
- **Offer code**: `{ v:1, from: PeerId, sdp: minimised SDP, lobby: { name, inviterName }, sig }`.
  - Minimise the SDP: keep only lines needed for data channels (`v, o, s, t, a=group, m=application, c, a=ice-ufrag, a=ice-pwd, a=fingerprint, a=setup, a=mid, a=sctp-port, a=max-message-size, a=candidate`), and drop redundant candidates (keep host, srflx, relay; max 4).
  - Then canonical JSON → deflate-raw → base64url → prefix `HX1.`. Target < 700 chars so it fits a QR code (version ≤ 25, error correction M).
- Flow:
  1. The inviter shows the offer as a QR code, a copyable text code and a share button (Web Share API).
  2. The joiner scans or pastes it and gets an **answer code** shown the same way.
  3. The inviter scans or pastes the answer. The connection is established.
- The offer is single-use per joiner. The inviter UI shows a "next invite" button that creates a fresh `RTCPeerConnection` and offer for each additional joiner.
- Scanning: the `BarcodeDetector` API where available, else `jsQR` on camera frames (`getUserMedia`). Pasting must always work.

### 2.2 Signaling server (optional, best UX)

- `apps/signaling`: a room-based relay of opaque blobs. It **never** parses game data.
  - `wss://host/room/<roomId>`
  - Messages: `join { peerId, sig }`, `signal { to, blob }`, `peers [...]`, `leave`.
  - Room ids: 10 random base32 characters (≈ 50 bits), plus a URL-friendly invite `https://app/#/join/<roomId>`.
  - Limits: 8 peers per room, 64 KiB per message, 30 messages/s per connection, room TTL 24 h after the last activity.
  - Stateless apart from room membership. No logs of blob contents.
- Two deployment targets, from the same core logic:
  - **Cloudflare Worker + Durable Object** (one DO per room, WebSocket hibernation API),
  - **Node** (`ws` library) for self-hosting, with a Dockerfile.
- The client uses trickle ICE over the server.
- The app setting "Signaling server URL" defaults to the project's deployed instance (configurable at build time and by the user). Empty = manual only.

### 2.3 Mesh relay

- Once a peer is connected to _any_ mesh member, it can signal every other member **through the existing DataChannels**: `RELAY_SIGNAL { to, from, blob }`, forwarded by the connected member.
- Rules: relayed blobs are signed by the originator. The forwarder can't read them usefully (SDP isn't secret, but the signature prevents tampering).
- This means that in manual mode, the inviter only exchanges codes with each joiner once, and the full mesh builds itself.
- Also used for reconnections mid-game when the signaling server is unavailable.

### 2.4 Future adapter (optional; don't implement now)

- Public decentralised signaling (Nostr relays or BitTorrent tracker WebSocket signaling, as in the `trystero` library). Leave the interface ready. Record the idea in DECISIONS.md.

## 3. ICE servers

- Defaults: a list of public STUN servers (configurable). **No default TURN.**
- The settings UI accepts TURN URLs plus credentials (static), or a "TURN credentials endpoint" URL returning short-lived credentials (for users who deploy coturn or a managed TURN service). Fetch it with a TanStack Query `useTurnCredentials` query (`staleTime` = credential TTL − 60 s) and validate the response with a Valibot schema.
- Write `docs/ops/turn.md` explaining how to deploy coturn, with a sample config.
- ICE transport policy option: `all` (default) or `relay` (privacy mode: hides your IP from other players; requires TURN).

## 4. Transport implementation

`WebRtcTransport implements Transport`:

- Maintains the peer table `{ peerId → { pc, channels, state, rtt, lastSeen } }`.
- `send`/`broadcast` only to authenticated peers.
- Emits `onPeerChange` on authentication and on loss.
- Exposes `stats()`: RTT, bytes, candidate pair types (host/srflx/relay) for diagnostics.

## 5. Diagnostics UI

A "Connection" panel in lobby and game:

- per-peer status, RTT, and route type (direct LAN / direct NAT / relayed),
- a "test connectivity" button that gathers local candidates and reports whether srflx/relay candidates were obtained (detecting "STUN blocked" / "no TURN configured"). Model it as a TanStack Query mutation; signaling-server reachability is a `useSignalingHealth` query,
- clear guidance text when a connection fails: suggest TURN, or the same network, or a hotspot.

## 6. Testing

- **Unit**: SDP minimiser round-trip (a minimised SDP still negotiates); code encode/decode; chunking/reassembly with random sizes; the backpressure logic, with a fake channel.
- **Node integration**: use `node-datachannel` (libdatachannel bindings) or `werift` as the `RTCPeerConnection` implementation in Node to run 4-peer mesh tests with the in-process signaling server. The transport must accept an injected RTC implementation.
- **Playwright multi-browser**: launch 4 browser contexts (Chromium ×2, Firefox, WebKit), using the local signaling server, and play a short scripted game (bots control all seats) to completion. Also run the manual-code flow by passing codes between contexts through the test harness.
- **Fault injection**: close a browser context mid-game and reopen it (full reconnection is stage 10; here assert only that the transport detects the loss and rebuilds when the peer returns).

## Steps

1. `PeerLink` (single connection, perfect negotiation, channels, chunking, backpressure, auth handshake with fingerprint binding).
2. `WebRtcTransport` (mesh management).
3. Signaling server core + Node host + tests; then the Cloudflare DO host.
4. Server adapter.
5. Manual adapter: SDP minimisation, codes, QR generate/scan UI components.
6. Mesh relay adapter.
7. ICE settings, diagnostics panel, TURN docs.
8. Node integration tests + Playwright multi-browser test.

## Acceptance criteria

- [ ] 4 browsers (including Firefox and WebKit) form a full mesh via the signaling server and via manual codes plus mesh relay.
- [ ] Offer codes fit a QR code and scan successfully on a phone camera (manual test, recorded in STATUS.md).
- [ ] The identity binding rejects a tampered signaling path (unit test with a MITM fake signaling adapter swapping fingerprints).
- [ ] A 1 MiB message transfers correctly with backpressure.
- [ ] The signaling server never logs or inspects blobs (code review checklist item plus a test asserting blobs are forwarded verbatim).
