interface NativeQrDetector {
  detect(source: HTMLVideoElement): Promise<readonly { rawValue: string }[]>;
}

declare global {
  interface Window {
    BarcodeDetector?: {
      new (options: { formats: string[] }): NativeQrDetector;
      getSupportedFormats(): Promise<string[]>;
    };
  }
}

export interface QrScannerRuntime {
  readonly getMedia?: () => Promise<MediaStream>;
  readonly detect?: (video: HTMLVideoElement) => Promise<string | null>;
}

async function qrDetector(): Promise<(video: HTMLVideoElement) => Promise<string | null>> {
  const native = window.BarcodeDetector;
  if (native) {
    try {
      if ((await native.getSupportedFormats()).includes('qr_code')) {
        const detector = new native({ formats: ['qr_code'] });
        return async (video) => (await detector.detect(video))[0]?.rawValue ?? null;
      }
    } catch {
      // A partial native implementation can still use the local JS decoder.
    }
  }
  const { default: decode } = await import('jsqr');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Camera frames are unavailable');
  return async (video) => {
    const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    return (
      decode(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'dontInvert' })?.data ??
      null
    );
  };
}

/** Camera frames remain local. Cancellation also releases a late permission grant. */
export async function scanInvitationQr(
  video: HTMLVideoElement,
  signal: AbortSignal,
  runtime: QrScannerRuntime = {},
): Promise<string> {
  let media: MediaStream | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelFrame: (() => void) | undefined;
  const stop = () => {
    media?.getTracks().forEach((track) => track.stop());
    media = null;
    video.srcObject = null;
    if (timer !== undefined) clearTimeout(timer);
    cancelFrame?.();
  };
  const checkCancelled = () => {
    if (signal.aborted) throw new DOMException('Scanner cancelled', 'AbortError');
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    checkCancelled();
    const detect = runtime.detect ?? (await qrDetector());
    checkCancelled();
    media = await (
      runtime.getMedia ??
      (() =>
        navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        }))
    )();
    checkCancelled();
    video.srcObject = media;
    await video.play();
    for (;;) {
      checkCancelled();
      if (video.readyState >= 2) {
        // oxlint-disable-next-line no-await-in-loop -- Only one local camera frame is decoded at a time.
        const value = await detect(video);
        checkCancelled();
        if (value && value.length <= 4096) return value;
      }
      // oxlint-disable-next-line no-await-in-loop -- Bound decoding to five frames per second.
      await new Promise<void>((resolve) => {
        cancelFrame = resolve;
        timer = setTimeout(resolve, 200);
      });
    }
  } finally {
    signal.removeEventListener('abort', stop);
    stop();
  }
}
