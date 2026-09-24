import { utf8ToBytes } from '@noble/hashes/utils.js';

/** Values accepted by the canonical JSON-like encoder. */
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

const BYTE_TAG = '$b';
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

interface Utf8Decoder {
  decode(input: Uint8Array): string;
}

interface Utf8DecoderConstructor {
  new (label?: string, options?: { fatal?: boolean }): Utf8Decoder;
}

declare const TextDecoder: Utf8DecoderConstructor;

function decoder(): Utf8Decoder {
  return new TextDecoder('utf-8', { fatal: true });
}

function toBase64UrlInternal(bytes: Uint8Array): string {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = hasSecond ? (bytes[index + 1] ?? 0) : 0;
    const third = hasThird ? (bytes[index + 2] ?? 0) : 0;
    const group = (first << 16) | (second << 8) | third;
    encoded += BASE64URL.charAt((group >>> 18) & 63);
    encoded += BASE64URL.charAt((group >>> 12) & 63);
    if (hasSecond) encoded += BASE64URL.charAt((group >>> 6) & 63);
    if (hasThird) encoded += BASE64URL.charAt(group & 63);
  }
  return encoded;
}

function fromBase64UrlInternal(encoded: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded) || encoded.length % 4 === 1) {
    throw new TypeError('Byte tag must use unpadded base64url.');
  }
  const length = Math.floor((encoded.length * 6) / 8);
  const bytes = new Uint8Array(length);
  let accumulator = 0;
  let bitCount = 0;
  let outputIndex = 0;
  for (const character of encoded) {
    const value = BASE64URL.indexOf(character);
    if (value < 0) throw new TypeError('Byte tag must use unpadded base64url.');
    accumulator = (accumulator << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes[outputIndex] = (accumulator >>> bitCount) & 255;
      outputIndex += 1;
      accumulator &= (1 << bitCount) - 1;
    }
  }
  if (toBase64UrlInternal(bytes) !== encoded) {
    throw new TypeError('Byte tag must use canonical base64url.');
  }
  return bytes;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function encodeValue(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new TypeError('Canonical encoding accepts integers only.');
    }
    return JSON.stringify(value);
  }
  if (value instanceof Uint8Array) {
    return `{"${BYTE_TAG}":${JSON.stringify(toBase64UrlInternal(value))}}`;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported canonical value: ${typeof value}.`);
  }
  if (ancestors.has(value))
    throw new TypeError('Canonical encoding does not accept cyclic values.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.length !== value.length + 1 || ownKeys.some((key) => typeof key === 'symbol')) {
        throw new TypeError('Canonical arrays cannot have holes or extra properties.');
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index))
          throw new TypeError('Canonical arrays cannot have holes.');
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
          throw new TypeError('Canonical arrays must contain plain data elements.');
        }
        items.push(encodeValue(descriptor.value, ancestors));
      }
      return `[${items.join(',')}]`;
    }
    if (!isPlainObject(value)) throw new TypeError('Canonical objects must be plain records.');

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== 'string')) {
      throw new TypeError('Canonical objects cannot contain symbol keys.');
    }
    const keys: string[] = [];
    for (const key of ownKeys) {
      if (typeof key !== 'string')
        throw new TypeError('Canonical objects cannot contain symbol keys.');
      keys.push(key);
    }
    if (keys.length === 1 && keys[0] === BYTE_TAG) {
      throw new TypeError('An exact one-key $b object is reserved for Uint8Array values.');
    }
    const entries = keys.toSorted().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        throw new TypeError('Canonical objects must contain enumerable data properties.');
      }
      return `${JSON.stringify(key)}:${encodeValue(descriptor.value, ancestors)}`;
    });
    return `{${entries.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Encodes plain JSON-like values as canonical UTF-8 bytes. */
export function canonicalEncode(value: unknown): Uint8Array {
  return utf8ToBytes(encodeValue(value, new WeakSet<object>()));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function decodeTagged(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeTagged);
  if (typeof value !== 'object' || value === null) return value;
  if (!isPlainRecord(value)) throw new TypeError('Decoded objects must be plain records.');
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === BYTE_TAG) {
    const encoded = value[BYTE_TAG];
    if (typeof encoded !== 'string') throw new TypeError('Byte tag value must be a string.');
    return fromBase64UrlInternal(encoded);
  }
  const decoded: Record<string, unknown> = {};
  for (const key of keys) {
    Object.defineProperty(decoded, key, {
      value: decodeTagged(value[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return decoded;
}

/** Decodes canonical UTF-8 bytes and byte tags, rejecting alternate JSON representations. */
export function canonicalDecode(bytes: Uint8Array): unknown {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Canonical input must be a Uint8Array.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new TypeError(`Invalid canonical JSON bytes: ${String(error)}`, { cause: error });
  }
  const value = decodeTagged(parsed);
  const encoded = canonicalEncode(value);
  if (encoded.length !== bytes.length || encoded.some((byte, index) => byte !== bytes[index])) {
    throw new TypeError('Input bytes are not in canonical encoding.');
  }
  return value;
}

/** Converts bytes to unpadded base64url. */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64UrlInternal(bytes);
}

/** Converts canonical unpadded base64url to bytes. */
export function fromBase64Url(encoded: string): Uint8Array {
  return fromBase64UrlInternal(encoded);
}
