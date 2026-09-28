import { RESOURCES } from '@cp2p/engine';
import * as v from 'valibot';

/** Card kinds are the five base resources plus at most three module kinds (knights: three). */
export const MAX_CARD_KINDS = 8;

/** The card kinds a hand proof covers, in canonical order (base resources first). */
export type CardKinds = readonly string[];

/** The base-game kinds; every hand API defaults to these so base games are unchanged. */
export const BASE_CARD_KINDS: CardKinds = RESOURCES;

function hasExactKeys(record: Readonly<Record<string, unknown>>, kinds: CardKinds): boolean {
  const keys = Object.keys(record);
  return keys.length === kinds.length && kinds.every((kind) => Object.hasOwn(record, kind));
}

const cache = new WeakMap<v.GenericSchema, Map<string, v.GenericSchema>>();

/** A record with exactly one entry per card kind. Memoized per item schema and kind list. */
export function kindRecordSchema<T>(
  kinds: CardKinds,
  item: v.GenericSchema<unknown, T>,
): v.GenericSchema<unknown, Record<string, T>> {
  let byKinds = cache.get(item);
  if (!byKinds) {
    byKinds = new Map();
    cache.set(item, byKinds);
  }
  const id = kinds.join(',');
  const known = byKinds.get(id);
  if (known) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The cache key is this exact item schema and kind list.
    return known as v.GenericSchema<unknown, Record<string, T>>;
  }
  const schema = v.pipe(
    v.record(v.string(), item),
    v.check((record) => hasExactKeys(record, kinds)),
  );
  byKinds.set(id, schema);
  return schema;
}

/** True when a name may be a card kind: a short lowercase word, never a prototype key. */
export function isKindName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,15}$/.test(value);
}
