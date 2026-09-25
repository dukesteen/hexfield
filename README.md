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

The `main` branch deploys to GitHub Pages only after CI checks, browser tests, and the simulation job pass. The Pages build uses `/hexfield/` as its asset base; local development and ordinary builds use `/`.
