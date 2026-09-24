#!/usr/bin/env node
import { mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = path.join(repoRoot, '.dependency-cruiser.cjs');
const fixtures = [];
const fixtureDirs = [];
let createdModulesRoot;

async function checkFixture(relativeFile, source, options) {
  const {
    shouldReject,
    expectedRule,
    expectedTarget,
    expectedTypeOnly = false,
    allowedEnginePath,
    requiredEnginePaths = [],
    label,
  } = options;
  const fixture = path.join(repoRoot, relativeFile);
  await mkdir(path.dirname(fixture), { recursive: true });
  await writeFile(fixture, source, { flag: 'wx' });
  fixtures.push(fixture);

  const result = spawnSync(
    'pnpm',
    ['exec', 'depcruise', '--config', config, '--output-type', 'json', fixture],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  if (result.error) throw result.error;

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `dependency-cruiser did not return JSON for ${label}. ${result.stderr || result.stdout}`,
    );
  }

  const sourcePath = relativeFile.replaceAll(path.sep, '/');
  const fixtureModule = (report.modules ?? []).find((module) =>
    String(module.source ?? module.name ?? '')
      .replaceAll('\\', '/')
      .endsWith(sourcePath),
  );
  const dependencies = fixtureModule?.dependencies ?? [];
  const targetEdge = dependencies.find((dependency) =>
    expectedTarget.test(`${dependency.module ?? ''} ${dependency.resolved ?? ''}`),
  );
  if (!targetEdge) {
    throw new Error(
      `${label}: expected dependency edge ${expectedTarget}; got ${JSON.stringify(dependencies)}`,
    );
  }
  if (expectedTypeOnly && !targetEdge.dependencyTypes?.includes('type-only')) {
    throw new Error(
      `${label}: expected type-only edge; got ${JSON.stringify(targetEdge.dependencyTypes ?? [])}`,
    );
  }

  const violations = report.violations ?? report.summary?.violations ?? [];
  const fixtureViolations = violations.filter((violation) =>
    String(violation.from ?? '')
      .replaceAll('\\', '/')
      .endsWith(sourcePath),
  );
  const rejectedByRule = fixtureViolations.some(
    (violation) => violation.rule?.name === expectedRule,
  );
  if (shouldReject ? !rejectedByRule : fixtureViolations.length > 0) {
    const expectation = shouldReject ? `rejection by ${expectedRule}` : 'no boundary violations';
    throw new Error(`${label}: expected ${expectation}; got ${JSON.stringify(fixtureViolations)}`);
  }
  if (allowedEnginePath) {
    const engineModules = (report.modules ?? [])
      .map((module) => String(module.source ?? module.name ?? '').replaceAll('\\', '/'))
      .filter((modulePath) => modulePath.includes('packages/engine/src/'));
    const leaked = engineModules.filter((modulePath) => !allowedEnginePath.test(modulePath));
    if (leaked.length) throw new Error(`${label}: geometry entry reached ${leaked.join(', ')}`);
    for (const required of requiredEnginePaths) {
      if (!engineModules.some((modulePath) => required.test(modulePath))) {
        throw new Error(`${label}: dependency graph omitted ${required}`);
      }
    }
  }
  console.log(`${label}: passed.`);
}

try {
  await checkFixture(
    'packages/engine/src/__boundary_react_fixture__.ts',
    "import React from 'react';\nexport { React };\n",
    {
      shouldReject: true,
      expectedRule: 'engine-is-isolated',
      expectedTarget: /react/,
      label: 'engine → react is rejected',
    },
  );
  await checkFixture(
    'packages/engine/src/__boundary_node_fixture__.ts',
    "import { readFile } from 'node:fs';\nexport { readFile };\n",
    {
      shouldReject: true,
      expectedRule: 'engine-is-isolated',
      expectedTarget: /(?:node:)?fs/,
      label: 'engine → node:fs is rejected',
    },
  );
  await checkFixture(
    'packages/bots/src/__boundary_app_fixture__.ts',
    "import { APP_NAME } from '../../../apps/web/src/config.js';\nexport { APP_NAME };\n",
    {
      shouldReject: true,
      expectedRule: 'packages-do-not-import-apps-or-tools',
      expectedTarget: /apps\/web\/src\/config/,
      label: 'package → app is rejected',
    },
  );
  await checkFixture(
    'packages/renderer/src/__boundary_runtime_fixture__.ts',
    "import { PACKAGE_NAME } from '@cp2p/engine';\nexport { PACKAGE_NAME };\n",
    {
      shouldReject: true,
      expectedRule: 'renderer-engine-runtime-only-geometry',
      expectedTarget: /@cp2p\/engine.*packages\/engine\/src/,
      label: 'renderer runtime package import is rejected',
    },
  );
  await checkFixture(
    'packages/renderer/src/__boundary_types_fixture__.ts',
    "import type { PACKAGE_NAME } from '@cp2p/engine';\nexport type Name = typeof PACKAGE_NAME;\n",
    {
      shouldReject: false,
      expectedRule: 'renderer-engine-runtime-only-geometry',
      expectedTarget: /@cp2p\/engine.*packages\/engine\/src/,
      expectedTypeOnly: true,
      label: 'renderer engine type-only package import is allowed',
    },
  );
  await checkFixture(
    'packages/renderer/src/__boundary_geometry_fixture__.ts',
    "import { hexId } from '@cp2p/engine/geometry';\nexport { hexId };\n",
    {
      shouldReject: false,
      expectedRule: 'renderer-engine-runtime-only-geometry',
      expectedTarget: /@cp2p\/engine\/geometry.*packages\/engine\/src\/geometry/,
      allowedEnginePath: /packages\/engine\/src\/(?:geometry\.ts|core\/geometry\/)/,
      requiredEnginePaths: [
        /packages\/engine\/src\/geometry\.ts$/,
        /packages\/engine\/src\/core\/geometry\/index\.ts$/,
      ],
      label: 'renderer geometry entry stays isolated from engine rules',
    },
  );
  await checkFixture(
    'packages/engine/src/core/pipeline/__boundary_rng_fixture__.ts',
    "import { createRng } from '../rng/index.js';\nexport { createRng };\n",
    {
      shouldReject: true,
      expectedRule: 'engine-rng-only-in-setup',
      expectedTarget: /packages\/engine\/src\/core\/rng\/index/,
      label: 'pipeline → genesis RNG is rejected',
    },
  );
  await checkFixture(
    'packages/engine/src/core/pipeline/__boundary_rng_types_fixture__.ts',
    "import type { Rng } from '../rng/index.js';\nexport type { Rng };\n",
    {
      shouldReject: false,
      expectedRule: 'engine-rng-only-in-setup',
      expectedTarget: /packages\/engine\/src\/core\/rng\/index/,
      expectedTypeOnly: true,
      label: 'pipeline → RNG type-only import is allowed',
    },
  );
  const siblingRoot = path.join(repoRoot, 'packages/engine/src/modules');
  createdModulesRoot = await mkdir(siblingRoot, { recursive: true });
  const firstModule = await mkdtemp(path.join(siblingRoot, '__boundary_a__-'));
  const secondModule = await mkdtemp(path.join(siblingRoot, '__boundary_b__-'));
  fixtureDirs.push(firstModule, secondModule);
  const firstId = path.basename(firstModule);
  const secondId = path.basename(secondModule);
  const siblingTarget = path.join(secondModule, 'shared.ts');
  await writeFile(siblingTarget, 'export const value = 1;\n', { flag: 'wx' });
  fixtures.push(siblingTarget);
  await checkFixture(
    `packages/engine/src/modules/${firstId}/rule.ts`,
    `import { value } from '../${secondId}/shared.js';\nexport { value };\n`,
    {
      shouldReject: true,
      expectedRule: `engine-module-${firstId}-no-siblings`,
      expectedTarget: new RegExp(`packages/engine/src/modules/${secondId}/shared`),
      label: 'undeclared sibling module import is rejected',
    },
  );
  const setupDir = path.join(firstModule, 'setup');
  await checkFixture(
    path.relative(repoRoot, path.join(setupDir, '__boundary_rng_fixture__.ts')),
    "import { createRng } from '../../../core/rng/index.js';\nexport { createRng };\n",
    {
      shouldReject: false,
      expectedRule: 'engine-rng-only-in-setup',
      expectedTarget: /packages\/engine\/src\/core\/rng\/index/,
      label: 'module setup → genesis RNG is allowed',
    },
  );
  await checkFixture(
    `packages/engine/src/modules/${firstId}/index.ts`,
    "import { createRng } from './setup/__boundary_rng_fixture__.js';\nexport const init = () => createRng(new Uint8Array(32));\n",
    {
      shouldReject: false,
      expectedRule: `engine-module-${firstId}-setup-private`,
      expectedTarget: new RegExp(
        `packages/engine/src/modules/${firstId}/setup/__boundary_rng_fixture__`,
      ),
      label: 'module entry → setup binding is allowed',
    },
  );
  await checkFixture(
    `packages/engine/src/modules/${firstId}/rules/__boundary_setup_fixture__.ts`,
    "import { createRng } from '../setup/__boundary_rng_fixture__.js';\nexport { createRng };\n",
    {
      shouldReject: true,
      expectedRule: `engine-module-${firstId}-setup-private`,
      expectedTarget: new RegExp(
        `packages/engine/src/modules/${firstId}/setup/__boundary_rng_fixture__`,
      ),
      label: 'rule handler → RNG setup reexport is rejected',
    },
  );
  await checkFixture(
    `packages/engine/src/modules/${firstId}/rules/__boundary_entry_fixture__.ts`,
    "import { init } from '../index.js';\nexport { init };\n",
    {
      shouldReject: true,
      expectedRule: `engine-module-${firstId}-setup-private`,
      expectedTarget: new RegExp(`packages/engine/src/modules/${firstId}/index`),
      label: 'rule handler → module entry reexport is rejected',
    },
  );
  await checkFixture(
    'packages/codec/src/__boundary_react_fixture__.ts',
    "import { useState } from '../../../apps/web/node_modules/react/index.js';\nexport { useState };\n",
    {
      shouldReject: true,
      expectedRule: 'no-react-below-web',
      expectedTarget: /node_modules\/.pnpm\/react@/,
      label: 'resolved React import outside web is rejected',
    },
  );
  await checkFixture(
    'packages/codec/src/__boundary_noble_fixture__.ts',
    "import { sha256 } from '@noble/hashes/sha256';\nexport { sha256 };\n",
    {
      shouldReject: false,
      expectedRule: 'codec-only-noble-hashes',
      expectedTarget: /@noble\/hashes/,
      label: 'codec → @noble/hashes is allowed',
    },
  );
} catch (error) {
  console.error(`Boundary check failed: ${String(error)}`);
  process.exitCode = 1;
} finally {
  await Promise.all(fixtures.map((fixture) => rm(fixture, { force: true })));
  await Promise.all(fixtureDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  if (createdModulesRoot) {
    try {
      await rmdir(createdModulesRoot);
    } catch (error) {
      if (error.code !== 'ENOTEMPTY') {
        console.error(`Could not remove temporary module directory: ${String(error)}`);
        process.exitCode = 1;
      }
    }
  }
}
