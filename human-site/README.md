# Human play

Play Maze Bench's 50 existing mazes with irreversible commands. Progress is saved in D1; completed attempts are exported for scoring by the existing Python scorer and displayed as Human baseline.

## Local preview

Use Node.js 22 or newer. Run from this directory:

```sh
npm ci
```

Copy `.dev.vars.example` to `.dev.vars` and set `EXPORT_TOKEN` to a random local secret. Then run:

```sh
npm run dev
```

Open [the local game](http://127.0.0.1:8787). The development command builds the assets and applies local D1 migrations. Local progress persists in `.wrangler/`; the local dataset is `verification`.

Use the arrow keys or four buttons. The counter counts accepted commands, including a final collision. Each browser gets one attempt per maze, with unfinished attempts available to resume indefinitely. Movement rules are available beside the controls.

## Publication after play approval

Have the owner test the local game and approve publication first. Use ChatGPT Sites to prepare this directory as a local project, with D1 bound as `DB` and static assets bound as `ASSETS`. The `.openai/hosting.json` file declares the storage binding; Sites adds its project identifier when provisioning. Hosted artifact compatibility and the first deployment still require verification through Sites.

Provision a fresh production database, apply `migrations/0001_initial.sql`, set `DATASET=production`, and set the hosted `EXPORT_TOKEN` secret. The Wrangler database ID `local-only` is a local-development placeholder. Keep local verification records separate from the production database.

After the approved Site is published, configure the GitHub repository:

| Setting | Value |
| --- | --- |
| Variable `HUMAN_SITE_URL` | Published Site URL |
| Secret `HUMAN_EXPORT_TOKEN` | The Site's export secret |
| Secret `HUMAN_SYNC_TOKEN` | Fine-grained token with Contents write permission for this repository |
| Variable `HUMAN_BASELINE_ENABLED` | `true`, after approving the connection |

Run **Sync human maze results** manually once. It subsequently runs hourly. The job commits completed records, their cursor, and `public/human_results.json`; that commit triggers the existing Pages and Hugging Face publication paths. The Site URL also enables the leaderboard's play link. The Site holds only its export secret; the GitHub write token stays in GitHub.

The export endpoint is `GET /api/export?after=0`, authenticated with `Authorization: Bearer <EXPORT_TOKEN>`. Paginated responses share a fixed `through` cursor. They contain completed commands and tier-wide participant counts, with browser identifiers omitted.

## Checks

Stop the development server before rebuilding on Windows, because it can hold generated assets open.

```sh
npm test
node --test ui-tests/session-contract.test.mjs
```

The server tests require Python for comparison with `MazeScorer`. UI tests use the repository's Playwright installation (`npm ci` at the repository root) and its Chromium browser (`npx playwright install chromium`).

To collect verification records while the local server is running, run `python scripts/sync_human_results.py --site-url http://127.0.0.1:8787 --allow-verification` from the repository root, adding explicit `--output`, `--archive`, and `--state` paths outside the official result files. Set `HUMAN_EXPORT_TOKEN` in the invoking environment. The production collector rejects verification records by default.

Licensed under the repository's [Apache-2.0 license](../LICENSE).
