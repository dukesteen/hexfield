function traverseJson(value: unknown, copyValues: boolean): unknown {
  const active = new WeakSet<object>();
  function visit(current: unknown): unknown {
    if (current === null || typeof current === 'string' || typeof current === 'boolean')
      return current;
    if (typeof current === 'number') {
      if (!Number.isSafeInteger(current))
        throw new Error('Game state numbers must be safe integers');
      return current;
    }
    if (typeof current !== 'object') throw new Error('Game state contains a non-JSON value');
    if (active.has(current)) throw new Error('Game state contains a cycle');
    active.add(current);
    let output: unknown;
    if (Array.isArray(current)) {
      const keys = Reflect.ownKeys(current);
      if (keys.length !== current.length + 1 || keys.some((key) => typeof key === 'symbol')) {
        throw new Error('Game state arrays cannot have sparse slots, extra properties or symbols');
      }
      const values: unknown[] | undefined = copyValues ? [] : undefined;
      for (let index = 0; index < current.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor) throw new Error('Game state contains a sparse array');
        if (!descriptor.enumerable || !('value' in descriptor)) {
          throw new Error('Game state arrays must contain enumerable data elements');
        }
        const child = visit(descriptor.value);
        values?.push(child);
      }
      output = values;
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('Game state must contain only plain JSON objects and arrays');
      }
      const keys = Reflect.ownKeys(current);
      const names: string[] = [];
      for (const key of keys) {
        if (typeof key !== 'string')
          throw new Error('Game state objects cannot contain symbol keys');
        names.push(key);
      }
      if (names.length === 1 && names[0] === '$b') {
        throw new Error('Game state cannot contain a reserved byte-tag object');
      }
      const entries: [string, unknown][] | undefined = copyValues ? [] : undefined;
      for (const key of copyValues ? names.toSorted() : names) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new Error('Game state objects must contain enumerable data properties');
        }
        const child = visit(descriptor.value);
        entries?.push([key, child]);
      }
      output = entries ? Object.fromEntries(entries) : undefined;
    }
    active.delete(current);
    return output;
  }
  return visit(value);
}

/** Copy JSON data and reject values that would make public state ambiguous. */
export function cloneJson<T>(value: T): T {
  // Runtime validation and copying preserve the JSON shape of the supplied value.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return traverseJson(value, true) as T;
}

/** Check the same JSON shape without allocating an owned copy. */
export function validateJson(value: unknown): void {
  traverseJson(value, false);
}
