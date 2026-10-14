# CLI

Review committed changes locally against their merge base:

```sh
pnpm cli review --base main
pnpm cli review --json
pnpm cli review --security --mode deep
pnpm cli review --agent      # output for coding agents
```

Run `npm link` to install the `openreview` command from a checkout.

- **Model credentials:** local reviews use model credentials from your environment.
- **Repository config:** they read `.openreview.json` from the base commit.
- **Limits:** they never execute repository code, and index at most 5,000 files or 20 MB.

## Connect to a server

```sh
openreview login --url https://review.example.com --token <api-key>
openreview status
```

## Fix with your coding agent

The bridge dispatches **Fix** and **Fix All** from the dashboard to Codex, Claude Code or Cursor Agent running on your machine:

```sh
openreview bridge install
openreview bridge pair --url https://review.example.com
openreview bridge register /absolute/path/to/repository
openreview bridge status
```

The agent works in your registered checkout, and you review, commit and push its changes yourself. The next review checks whether each finding was resolved.
