#!/usr/bin/env node
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = path.join(repoRoot, '.dependency-cruiser.cjs');
const fixtures = [];

async function checkFixture(relativeFile, source, options) {
  const { shouldReject, expectedRule, expectedTarget, expectedTypeOnly = false, label } = options;
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
}
