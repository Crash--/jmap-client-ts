# Contributing to jmap-client-ts

Contributions are welcome. Open an issue to report a bug or discuss a change
before large pull requests.

## Setup

Use Node 24 (`nvm use` reads `.nvmrc`), then:

```bash
npm install
```

## Checks

```bash
npm run lint       # ESLint 9 + Prettier 3 (npm run lint:fix to fix)
npm run typecheck  # sources, tests and type tests
npm test           # unit and type tests (vitest)
npm run build      # dist/ with tsdown
```

Integration tests need Docker and start a disposable
`linagora/tmail-backend` (Docker Compose project `jmapclient-it`, ports bound
to 127.0.0.1 only):

```bash
npm run test:integration
```

## Public API

The public surface is described in [docs/v2-api.md](docs/v2-api.md). Update
it in the same pull request as any change of the API.

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `docs:`, `test:`, `chore:`, …), one subject per commit,
subject in the imperative mood.
