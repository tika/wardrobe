# Contributing

Fork the repo, create a focused branch, and open a pull request. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages, for example `feat(mobile): add outfit screen`.

```bash
bun install
bun run check
```

`bun run check` typechecks every workspace, runs the backend tests, and builds the web app.

Never commit `.env`, `.alchemy/`, `data/`, personal photos, generated wardrobe assets, or API keys.
