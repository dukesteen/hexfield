/** @type {import('dependency-cruiser').IConfiguration} */
const { existsSync, readdirSync } = require('node:fs');
const path = require('node:path');

const modulesDir = path.join(__dirname, 'packages/engine/src/modules');
const moduleIds = existsSync(modulesDir)
  ? readdirSync(modulesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  : [];
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'packages-do-not-import-apps-or-tools',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^(?:apps/|tools/)' },
    },
    {
      name: 'engine-is-isolated',
      severity: 'error',
      from: { path: '^packages/engine/', pathNot: '\\.test\\.[cm]?[jt]sx?$' },
      to: { pathNot: '^packages/engine/' },
    },
    {
      name: 'engine-rng-only-in-setup',
      severity: 'error',
      from: {
        path: '^packages/engine/src/',
        pathNot:
          '^packages/engine/src/(?:core/state/createGame\\.ts$|modules/[^/]+/setup(?:/|\\.ts$)|rng\\.ts$)|\\.(?:test|spec)\\.[cm]?[jt]sx?$|/(?:__tests__|test|tests)/',
      },
      to: {
        path: '^packages/engine/src/(?:core/rng/|rng\\.ts$)',
        dependencyTypesNot: ['type-only'],
      },
    },
    // Stage 11 can allow sibling imports after reading each module's declared dependencies.
    ...moduleIds.map((id) => ({
      name: `engine-module-${id}-no-siblings`,
      severity: 'error',
      from: {
        path: `^packages/engine/src/modules/${escapeRegex(id)}/`,
        pathNot: '\\.(?:test|spec)\\.[cm]?[jt]sx?$|/(?:__tests__|test|tests)/',
      },
      to: { path: `^packages/engine/src/modules/(?!${escapeRegex(id)}/)[^/]+/` },
    })),
    ...moduleIds.map((id) => ({
      name: `engine-module-${id}-setup-private`,
      severity: 'error',
      from: {
        path: `^packages/engine/src/modules/${escapeRegex(id)}/`,
        pathNot: `^packages/engine/src/modules/${escapeRegex(id)}/(?:setup/|index\\.ts$)|\\.(?:test|spec)\\.[cm]?[jt]sx?$|/(?:__tests__|test|tests)/`,
      },
      to: {
        path: `^packages/engine/src/modules/${escapeRegex(id)}/(?:setup/|index\\.ts$)`,
        dependencyTypesNot: ['type-only'],
      },
    })),
    {
      name: 'codec-only-noble-hashes',
      severity: 'error',
      from: { path: '^packages/codec/', pathNot: '\\.test\\.[cm]?[jt]sx?$' },
      to: {
        pathNot:
          '^(packages/codec/|@noble/hashes(?:/|$)|node_modules/[.]pnpm/@noble[+]hashes@|node_modules/@noble/hashes/)',
      },
    },
    {
      name: 'crypto-limited-dependencies',
      severity: 'error',
      from: { path: '^packages/crypto/', pathNot: '\\.test\\.[cm]?[jt]sx?$' },
      to: {
        pathNot:
          '^(packages/(?:crypto|codec)/|@cp2p/codec(?:/|$)|@noble/(?:curves|hashes)(?:/|$)|node_modules/[.]pnpm/@noble[+](?:curves|hashes)@|node_modules/@noble/(?:curves|hashes)/)',
      },
    },
    {
      name: 'protocol-limited-dependencies',
      severity: 'error',
      from: { path: '^packages/protocol/', pathNot: '\\.test\\.[cm]?[jt]sx?$' },
      to: {
        pathNot:
          '^(packages/(?:protocol|engine|codec|crypto)/|@cp2p/(?:engine|codec|crypto)(?:/|$)|valibot(?:/|$)|node_modules/[.]pnpm/valibot@|node_modules/valibot/)',
      },
    },
    {
      name: 'maps-limited-dependencies',
      severity: 'error',
      from: { path: '^packages/maps/', pathNot: '\\.test\\.[cm]?[jt]sx?$' },
      to: {
        pathNot:
          '^(packages/(?:maps|engine)/|@cp2p/engine(?:/|$)|valibot(?:/|$)|node_modules/[.]pnpm/valibot@|node_modules/valibot/)',
      },
    },
    {
      name: 'renderer-limited-dependencies',
      severity: 'error',
      from: { path: '^packages/renderer/', pathNot: '\\.test\\.[cm]?[jt]sx?$' },
      to: {
        pathNot:
          '^(packages/(?:renderer|engine)/|@cp2p/engine(?:/|$)|pixi\\.js(?:/|$)|node_modules/[.]pnpm/pixi[.]js@|node_modules/pixi\\.js/)',
      },
    },
    {
      name: 'renderer-engine-runtime-only-geometry',
      severity: 'error',
      from: { path: '^packages/renderer/', pathNot: '\\.test\\.[cm]?[jt]sx?$' },
      to: {
        path: '^(?:packages/engine/|@cp2p/engine(?:/|$))',
        pathNot: '^(?:packages/engine/src/geometry\\.ts|@cp2p/engine/geometry)$',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'no-react-below-web',
      severity: 'error',
      from: { pathNot: '^apps/web/' },
      to: {
        path: '^(?:react|react-dom)(?:/|$)|^node_modules/[.]pnpm/(?:react|react-dom)@|node_modules/(?:react|react-dom)(?:/|$)',
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
    exclude: '(?:^|/)(?:dist|coverage)/',
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['types', '@cp2p/source', 'import', 'default'],
    },
  },
};
