# Hexfield

Hexfield is a browser board game for local play with two to four players. Mix human seats and bots, pass the screen for hotseat turns, and resume saved games. Local games run in your browser; they do not need an account or game server.

Play the published build at [dukesteen.github.io/hexfield](https://dukesteen.github.io/hexfield/). Games save in that browser's local storage. Clearing site data removes those saves; finished games can export a replay JSON file.

## Run locally

Use Node 22 and pnpm 10.7.1:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:5187/>. Run `pnpm check` for the repository checks or `pnpm test:e2e` for browser tests.

## Verify locally

`pnpm check:full` runs the static checks (types, lint, format, dependency boundaries, engine purity, translation keys), the build, every unit test with four workers, and the engine coverage gate. Slower acceptance runs are started by hand:

- Browser tests: `pnpm test:e2e` (all three browsers), or `CI_BROWSER_SET=chromium pnpm test:e2e` for Chromium alone. Set `PLAYWRIGHT_TEST_PORT` to run beside another dev server.
- Heavy unit tests: `CP2P_HEAVY_TESTS=1 pnpm test` adds the full verified Cities & Knights P2P games (`knights-game`, and the every-progress-card game in `knights-progress-game`), the six-seat online ceremony, and the full knights simulation sweeps. Each of those games takes minutes; pass a file path to run one.
- Simulations: `pnpm sim run --games 2000 --players 4 --seed 42 --parallel 4` and `pnpm sim fuzz --iterations 50000 --seed 42`.
- Network acceptance: `pnpm sim net --scenario <1-9> --seeds 5 --seed 42 --parallel 1`. Add `--security verified --seeds 1 --max-elapsed-ms 900000` for a real-crypto game, or `--lifecycle persistence` for the restart check.

The `main` branch deploys to GitHub Pages after CI checks and the simulation job pass. Browser tests run by default. The Pages build uses `/hexfield/` as its asset base; local development and ordinary builds use `/`.

After verifying the release changes with E2E tests locally, a maintainer can skip the hosted browser run with:

```sh
gh workflow run ci.yml -f skip_e2e=true
```

Record which local browser checks passed for the release. Use `pnpm test:e2e` for the complete suite; small UI fixes can use the relevant focused tests. This manual option still runs repository checks, the build, coverage, and simulation before deployment. Pushes and ordinary manual runs keep the browser suite enabled.
