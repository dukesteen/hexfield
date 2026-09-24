import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const inputs = [
  'packages/engine/src',
  'packages/bots/src',
  'packages/codec/src',
  'packages/maps/src',
  'tools/sim/src',
  'packages/engine/package.json',
  'packages/engine/tsconfig.json',
  'packages/bots/package.json',
  'packages/bots/tsconfig.json',
  'packages/codec/package.json',
  'packages/codec/tsconfig.json',
  'packages/maps/package.json',
  'packages/maps/tsconfig.json',
  'tools/sim/package.json',
  'tools/sim/tsconfig.json',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'tsconfig.base.json',
  'tsconfig.test.json',
];

function files(path: string): string[] {
  const absolute = join(root, path);
  if (!statSync(absolute).isDirectory()) return [path];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? files(child) : entry.isFile() ? [child] : [];
  });
}

/** SHA-256 over ordered source paths and bytes, including dirty and untracked files. */
export function sourceFingerprint(): string {
  const hash = createHash('sha256');
  for (const path of inputs.flatMap(files).toSorted()) {
    hash.update(path);
    hash.update('\0');
    hash.update(readFileSync(join(root, path)));
    hash.update('\0');
  }
  return hash.digest('hex');
}
