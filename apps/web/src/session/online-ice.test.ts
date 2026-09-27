import { afterEach, expect, test, vi } from 'vitest';
import { OnlineIce } from './online-ice';
import type { OnlineConnectionSettings } from '../queries/network';

afterEach(() => vi.useRealTimers());

function configuration(credential: string, expiresAt?: number): OnlineConnectionSettings {
  return {
    iceServers: [{ urls: 'turn:relay.test', username: 'fixture', credential }],
    iceTransportPolicy: 'relay',
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

class TestConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = 'new';
  constructor(private config: RTCConfiguration) {
    super();
  }
  getConfiguration() {
    return structuredClone(this.config);
  }
  setConfiguration = vi.fn<(value: RTCConfiguration) => void>((value) => {
    this.config = structuredClone(value);
  });
  close() {
    this.connectionState = 'closed';
    this.dispatchEvent(new Event('connectionstatechange'));
  }
}

function fixture(initial: OnlineConnectionSettings, load: () => Promise<OnlineConnectionSettings>) {
  const created: TestConnection[] = [];
  const pool = new OnlineIce(initial, load, (config) => {
    const pc = new TestConnection(config);
    created.push(pc);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- RTC configuration lifecycle fake.
    return pc as unknown as RTCPeerConnection;
  });
  return { pool, created };
}

test('refreshes temporary TURN credentials for existing restarts and new connections', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const load = vi.fn<() => Promise<OnlineConnectionSettings>>(async () =>
    configuration('second', 600_000),
  );
  const { pool, created } = fixture(configuration('first', 300_000), load);
  try {
    pool.createConnection({ bundlePolicy: 'max-bundle' });
    pool.createConnection();
    created[1]?.close();
    await vi.advanceTimersByTimeAsync(239_999);
    expect(load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledOnce();
    expect(created[0]?.getConfiguration()).toEqual({
      ...configuration('second'),
      bundlePolicy: 'max-bundle',
    });
    expect(created[1]?.setConfiguration).not.toHaveBeenCalled();
    const next = pool.createConnection();
    expect(next.getConfiguration()).toEqual(configuration('second'));
  } finally {
    pool.dispose();
  }
});

test('failed refresh preserves live links but refuses new connections after expiry', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let available = false;
  const load = vi.fn<() => Promise<OnlineConnectionSettings>>(async () => {
    if (!available) throw new Error('Endpoint unavailable');
    return configuration('recovered', 300_000);
  });
  const { pool, created } = fixture(configuration('first', 20_000), load);
  try {
    pool.createConnection();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(created[0]?.connectionState).toBe('new');
    expect(() => pool.createConnection()).toThrow('expired');
    expect(created).toHaveLength(1);
    available = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pool.createConnection().getConfiguration()).toEqual(configuration('recovered'));
    expect(created[0]?.getConfiguration()).toEqual(configuration('recovered'));
  } finally {
    pool.dispose();
  }
});

test('closing a room drops late refresh results and stops retries', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let resolve!: (value: OnlineConnectionSettings) => void;
  const load = vi.fn<() => Promise<OnlineConnectionSettings>>(
    () => new Promise<OnlineConnectionSettings>((done) => (resolve = done)),
  );
  const { pool, created } = fixture(configuration('first', 10_000), load);
  pool.createConnection();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(load).toHaveBeenCalledOnce();
  pool.dispose();
  resolve(configuration('late', 300_000));
  await vi.advanceTimersByTimeAsync(600_000);
  expect(created[0]?.setConfiguration).not.toHaveBeenCalled();
  expect(load).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect(() => pool.createConnection()).toThrow('closed');
});

test('static TURN settings create no refresh timer', () => {
  vi.useFakeTimers();
  const load = vi.fn<() => Promise<OnlineConnectionSettings>>(async () => configuration('unused'));
  const { pool } = fixture(configuration('static'), load);
  try {
    expect(pool.createConnection().getConfiguration()).toEqual(configuration('static'));
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    pool.dispose();
  }
});
