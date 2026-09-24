export const PACKAGE_NAME = '@cp2p/codec';

export { canonicalDecode, canonicalEncode, fromBase64Url, toBase64Url } from './canonical.js';
export type { CanonicalValue } from './canonical.js';
export { hashValue, sha256, toHex } from './hash.js';
