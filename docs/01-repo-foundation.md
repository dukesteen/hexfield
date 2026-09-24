# 01 — Repository Foundation

## Goal

Set up a pnpm monorepo with strict TypeScript, testing, linting, dependency-boundary enforcement and CI, so every later stage starts from a working, checked skeleton.

## Prerequisites

- Read `00-architecture.md`.
- Node 22 LTS, pnpm ≥ 9 (pin with `packageManager` in root `package.json` and use Corepack).

## Out of scope

Any game logic. This stage produces empty packages with a single sanity test each.

## Deliverables

```
.
├── package.json                 root scripts, packageManager, engines
├── pnpm-workspace.yaml          apps/*, packages/*, tools/*
├── tsconfig.base.json           strict shared config
├── tsconfig.json                solution-style references
├── .oxlintrc.json
├── .oxfmtrc.json
├── .dependency-cruiser.cjs
├── vitest.workspace.ts
├── .github/workflows/ci.yml
├── .editorconfig, .gitignore, .nvmrc
├── docs/DECISIONS.md            (empty template)
├── docs/STATUS.md               (checklist of all stages)
├── docs/rules/                  (empty, for resolved [VERIFY] rules)
├── apps/web/                    Vite + React + TS "hello" page
├── apps/signaling/              placeholder package
├── packages/{engine,codec,crypto,protocol,p2p,storage,renderer,bots,maps}/
└── tools/sim/
```

Each package has `package.json` (name `@cp2p/<name>`, `"type": "module"`, `exports` pointing at `src/index.ts` during development and `dist` for builds), `tsconfig.json`, `src/index.ts`, and `src/index.test.ts`.

## Steps

### 1. Initialise the workspace

- Run `git init`, add `.gitignore` (node_modules, dist, coverage, .turbo, playwright-report, test-results, *.local).
- Root `package.json`: `"private": true`, `"packageManager": "pnpm@<latest 9/10>"`, `"engines": {"node": ">=22"}`.
- `pnpm-workspace.yaml` listing `apps/*`, `packages/*`, `tools/*`.

### 2. TypeScript

- `tsconfig.base.json`:
  - `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`, `"noImplicitOverride": true`, `"noFallthroughCasesInSwitch": true`, `"verbatimModuleSyntax": true`
  - `"target": "ES2022"`, `"module": "ESNext"`, `"moduleResolution": "Bundler"`, `"lib": ["ES2023"]` (packages), plus `"DOM"` only in `apps/web`, `packages/p2p`, `packages/storage`, `packages/renderer`.
  - `"composite": true`, `"declaration": true`.
- `packages/engine/tsconfig.json` sets `"lib": ["ES2023"]` and `"types": []`, so any accidental use of DOM/Node globals fails to compile. This is a key guard for the zero-dependency rule.
- Root `tsconfig.json` with project references to all packages. `pnpm typecheck` = `tsc -b`.

### 3. Lint & format (oxlint + oxfmt)

- **Linting: oxlint.** Root `.oxlintrc.json`:
  - Enable the `correctness`, `suspicious` and `perf` categories as errors. Enable the `typescript`, `unicorn`, `import`, `promise` and `vitest` plugins, plus `react`, `react-hooks` and `jsx-a11y` in an override for `apps/web/**`.
  - Rules: `typescript/no-explicit-any: error`, `typescript/no-non-null-assertion: warn`, `no-console: warn` (off in `tools/**`), `eqeqeq: error`, `import/no-cycle: error`.
  - Enable type-aware linting (`oxlint --type-aware`, backed by `tsgolint`) for `typescript/switch-exhaustiveness-check` and `typescript/no-floating-promises`. If type-aware mode isn't stable in the installed version, rely on a `never`-typed exhaustiveness helper (`assertNever`) instead and record it in DECISIONS.md.
  - Engine override (`packages/engine/**`): `no-restricted-globals` for `Date`, `setTimeout`, `setInterval`, `crypto`, `performance`, `window`, `document`, `process`; `no-console: error`. `Math.random` is also caught by the purity script below (oxlint may not support `no-restricted-properties`).
- **Formatting: oxfmt.** Root `.oxfmtrc.json` (or equivalent config): 2-space indent, single quotes, trailing commas `all`, print width 100. `pnpm format` writes; `pnpm format:check` verifies in CI.
- Add `tools/check-engine-purity.mjs`: it greps `packages/engine/src` (excluding tests) for banned identifiers (`Math.random`, `Date`, `performance.now`, `crypto.`) and fails with file:line output. This backs up the lint rules.
- Editor integration: add `.vscode/extensions.json` recommending the Oxc extension, and `settings.json` enabling format-on-save with oxfmt.

### 4. Dependency boundaries

- Configure `.dependency-cruiser.cjs` with rules that exactly encode `00-architecture.md` §3:
  - `engine` → no workspace deps, no npm deps.
  - `codec` → only `@noble/hashes`.
  - `crypto` → only `codec`, `@noble/*`.
  - `protocol` → `engine`, `codec`, `crypto`, `valibot`.
  - `maps` → `engine`, `valibot`.
  - `renderer` → `engine` (type imports + `engine/geometry` entry point only), `pixi.js`.
  - no package except `apps/web` may import `react`.
  - no circular dependencies anywhere.
- `pnpm deps:check` runs it. Add a deliberately violating fixture in a test to prove the rule fires, then remove it (or keep it as a negative test that runs dependency-cruiser on a fixture directory).

### 5. Testing

- `vitest.workspace.ts` including all packages. Default environment `node`. `apps/web` and `renderer` use `happy-dom` where needed.
- Add `fast-check` to engine, codec, crypto and protocol dev dependencies.
- Coverage via `@vitest/coverage-v8`. Thresholds start at 0 and are raised in later stages (engine target ≥ 90% lines by the end of stage 03).
- Playwright set up in `apps/web` with one smoke test that loads the page. Configure Chromium, Firefox and WebKit projects.

### 6. Scripts (root)

| Script              | Does                                                               |
| ------------------- | ------------------------------------------------------------------ |
| `pnpm dev`          | Runs `apps/web` Vite dev server                                    |
| `pnpm build`        | Builds all packages and the app                                    |
| `pnpm typecheck`    | `tsc -b`                                                           |
| `pnpm lint`         | `oxlint` (with `--type-aware` if enabled; `--deny-warnings` in CI) |
| `pnpm format`       | `oxfmt` (write)                                                    |
| `pnpm format:check` | `oxfmt --check`                                                    |
| `pnpm test`         | `vitest run`                                                       |
| `pnpm test:e2e`     | Playwright                                                         |
| `pnpm deps:check`   | dependency-cruiser                                                 |
| `pnpm check`        | typecheck + lint + format:check + deps:check + purity check + test |
| `pnpm sim`          | runs `tools/sim` CLI (placeholder now)                             |

### 7. CI

- GitHub Actions workflow on push/PR: set up pnpm with cache, `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm build`, `pnpm test:e2e` (Chromium only on PR, all browsers on main).
- Upload coverage and Playwright reports as artifacts.

### 8. Web app skeleton

- `apps/web`: Vite + React 19 + TS. Render the `APP_NAME` and a version string. Configure path aliases for the workspace packages. Add:
  - `zustand` (live game/UI state),
  - `@tanstack/react-query` + `@tanstack/react-query-devtools` (dev only). Wrap the app in a `QueryClientProvider` with sensible defaults: `staleTime: Infinity` for IndexedDB-backed queries, since they're invalidated explicitly after mutations; `retry: false` for local storage queries.
  - `i18next` + `react-i18next`: an `I18nextProvider` with `en` as the fallback. Translation files at `apps/web/src/i18n/locales/<lng>/<namespace>.json`. A placeholder `common` namespace, with the page title rendered through `t()`.
  - `valibot` (also added to `protocol` and `maps`).
  - `@tanstack/react-router` + `@tanstack/router-plugin` (Vite plugin, file-based routes in `apps/web/src/routes/`, generated `routeTree.gen.ts` committed or git-ignored; record the choice) + `@tanstack/react-router-devtools` (dev only). Create the router with `createHashHistory()`, register the router type (`declare module '@tanstack/react-router' { interface Register { router: typeof router } }`), and pass the `queryClient` in router context. Start with a root route (`__root.tsx`, layout + providers) and an index route.
- Set a CSP meta tag placeholder (tightened in stage 18).

### 9. Docs scaffolding

- `docs/DECISIONS.md` with a header and entry template.
- `docs/STATUS.md` with one section per stage, each listing that stage's acceptance criteria as checkboxes (copy them from each doc).

## Required tests

- Each package: one trivial test proving the test runner works.
- Engine purity: a test (or CI step) proving that a file using `Math.random` in `packages/engine/src` fails the purity check (use a temp fixture).
- Boundaries: dependency-cruiser rejects an `engine → react` import fixture.

## Acceptance criteria

- [ ] `pnpm install && pnpm check && pnpm build` passes on a clean clone.
- [ ] `pnpm dev` serves the placeholder page. The Playwright smoke test passes in Chromium, Firefox and WebKit.
- [ ] Adding `import 'react'` to the engine fails `pnpm deps:check`.
- [ ] Using `Math.random()` or `document` in the engine fails `pnpm check`.
- [ ] CI runs green on GitHub Actions, or the same checks pass locally under the user-authorized local verification path in `README.md`.
- [ ] `docs/STATUS.md` and `docs/DECISIONS.md` exist.
