import QRCode from 'qrcode';

const QUIET_ZONE = 4;

/** The quiet zone and square modules stay intact at every rendered size. */
export function invitationQr(value: string): { size: number; path: string; version: number } {
  if (!value || value.length > 4096) throw new Error('Invitation is too large for a QR code');
  const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
  const segments: string[] = [];
  for (let row = 0; row < qr.modules.size; row += 1) {
    for (let column = 0; column < qr.modules.size; column += 1) {
      if (qr.modules.get(row, column))
        segments.push(`M${column + QUIET_ZONE},${row + QUIET_ZONE}h1v1h-1z`);
    }
  }
  return { size: qr.modules.size + QUIET_ZONE * 2, path: segments.join(''), version: qr.version };
}
