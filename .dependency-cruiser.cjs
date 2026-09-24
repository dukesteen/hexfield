/** @type {import('dependency-cruiser').IConfiguration} */
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
