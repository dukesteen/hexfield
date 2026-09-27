import type { OnlineConnectionSettings } from '../queries/network';

/** One room's RTC factories and temporary TURN credential refresh lifecycle. */
export class OnlineIce {
  private current: OnlineConnectionSettings;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly connections = new Map<RTCPeerConnection, () => void>();

  constructor(
    initial: OnlineConnectionSettings,
    private readonly load: () => Promise<OnlineConnectionSettings>,
    private readonly create: (configuration: RTCConfiguration) => RTCPeerConnection = (
      configuration,
    ) => new RTCPeerConnection(configuration),
  ) {
    this.current = structuredClone(initial);
    this.schedule();
  }

  createConnection(configuration: RTCConfiguration = {}): RTCPeerConnection {
    if (this.closed) throw new Error('Room connection settings are closed');
    if (this.current.expiresAt !== undefined && this.current.expiresAt <= Date.now())
      throw new Error('TURN credentials have expired; waiting for fresh credentials');
    const pc = this.create({ ...configuration, ...this.configuration() });
    const onState = () => {
      if (pc.connectionState !== 'closed') return;
      pc.removeEventListener('connectionstatechange', onState);
      this.connections.delete(pc);
    };
    pc.addEventListener('connectionstatechange', onState);
    this.connections.set(pc, onState);
    return pc;
  }

  /** The room owns its connections. This only releases refresh work and listeners. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const [pc, listener] of this.connections)
      pc.removeEventListener('connectionstatechange', listener);
    this.connections.clear();
    this.current = { iceServers: [], iceTransportPolicy: this.current.iceTransportPolicy };
  }

  private configuration(): RTCConfiguration {
    return {
      iceServers: structuredClone([...this.current.iceServers]),
      iceTransportPolicy: this.current.iceTransportPolicy,
    };
  }

  private schedule(retry = false): void {
    if (this.closed || this.current.expiresAt === undefined) return;
    const remaining = this.current.expiresAt - Date.now();
    const delay = retry ? 5_000 : Math.max(100, remaining - Math.min(60_000, remaining / 2));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, delay);
  }

  private async refresh(): Promise<void> {
    try {
      const next = await this.load();
      if (this.closed) return;
      if (next.expiresAt !== undefined && next.expiresAt <= Date.now())
        throw new Error('Refreshed TURN credentials have expired');
      this.current = structuredClone(next);
      for (const pc of this.connections.keys()) {
        if (pc.connectionState === 'closed') continue;
        try {
          // Existing ICE restarts must use the new credentials too. Preserve
          // certificates and other immutable RTC settings chosen at creation.
          pc.setConfiguration({ ...pc.getConfiguration(), ...this.configuration() });
        } catch {
          // A closing connection may reject updates. Future connections still
          // use the refreshed settings; this must not close a healthy game link.
        }
      }
      this.schedule();
    } catch {
      // Keep an established connection alive, but never create another using
      // expired credentials. Retry is bounded and ends when the room closes.
      this.schedule(true);
    }
  }
}
