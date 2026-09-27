// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { scanInvitationQr } from './qr-scanner';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const stop = vi.fn<() => void>();
  const media = new MediaStream();
  Object.defineProperty(media, 'getTracks', { value: () => [{ stop }] });
  const video = document.createElement('video');
  Object.defineProperty(video, 'readyState', { value: 4 });
  vi.spyOn(video, 'play').mockResolvedValue();
  return { video, media, stop };
}

test('releases camera tracks and removes the preview after a decoded invitation', async () => {
  const { video, media, stop } = fixture();
  const result = await scanInvitationQr(video, new AbortController().signal, {
    getMedia: async () => media,
    detect: async () => 'HX1.fixture-code',
  });
  expect(result).toBe('HX1.fixture-code');
  expect(stop).toHaveBeenCalledTimes(1);
  expect(video.srcObject).toBeNull();
});

test('releases a camera permission grant that arrives after the scanner closes', async () => {
  const { video, media, stop } = fixture();
  const abort = new AbortController();
  let grant!: (stream: MediaStream) => void;
  const granted = new Promise<MediaStream>((resolve) => {
    grant = resolve;
  });
  const scan = scanInvitationQr(video, abort.signal, {
    getMedia: () => granted,
    detect: async () => null,
  });
  abort.abort();
  grant(media);
  await expect(scan).rejects.toThrow('Scanner cancelled');
  expect(stop).toHaveBeenCalledTimes(1);
  expect(video.srcObject).toBeNull();
});

test('cancellation stops an active camera while a decoder is still working', async () => {
  const { video, media, stop } = fixture();
  const abort = new AbortController();
  let decode!: (value: string | null) => void;
  const pending = new Promise<string | null>((resolve) => {
    decode = resolve;
  });
  const detect = vi.fn<() => Promise<string | null>>(async () => pending);
  const scan = scanInvitationQr(video, abort.signal, { getMedia: async () => media, detect });
  await vi.waitFor(() => expect(detect).toHaveBeenCalled());
  abort.abort();
  expect(stop).toHaveBeenCalledTimes(1);
  decode('HX1.late-code');
  await expect(scan).rejects.toThrow('Scanner cancelled');
  expect(stop).toHaveBeenCalledTimes(1);
});
