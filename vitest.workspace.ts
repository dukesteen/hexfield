import { readdirSync } from 'node:fs';
import { defineWorkspace } from 'vitest/config';

const packageRoots = readdirSync(new URL('./packages/', import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `packages/${entry.name}`);
const nodeProjects = [...packageRoots, 'apps/signaling', 'tools/sim'].map((root) => ({
  extends: './vitest.config.ts',
  test: { name: `@cp2p/${root.slice(root.lastIndexOf('/') + 1)}`, root: `./${root}` },
}));

export default defineWorkspace([...nodeProjects, 'apps/web']);
