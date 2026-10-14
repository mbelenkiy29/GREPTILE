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

## Onboard a workspace

```sh
openreview onboard --url https://review.example.com --token <admin-api-key>
```

`openreview onboard` walks through setup with the workspace's API key. Create an admin-scope key under Settings → API keys.

1. **Workspace.** It shows the workspace the key belongs to. An API key belongs to one workspace. To use another workspace, or to create a new one, the command prints the dashboard steps: switch to or create the workspace, generate a key there, and run it again.
2. **Install link.** It prints the GitHub App install link for the workspace. It never changes settings at your code provider.
3. **Repositories.** It lists the installed repositories and enables the ones you choose, which starts indexing. Pass `--repositories owner/name,…` or `--repositories all`. With `--yes` and no list, it enables only the repository of the current checkout.
4. **Rules.** It finds AI rule files in the current repository: `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.cursor/rules/*`, `.github/copilot-instructions.md`, `GEMINI.md` and `.windsurfrules`.
   - It imports their review-relevant statements as suggested rules. Agent workflow, persona text and code blocks are left out.
   - Each suggestion waits for an admin's approval on the Custom rules page, and the server discards text that fails the rule safety checks.
   - `--no-rules` skips this step.

For coding agents, `openreview onboard --yes --json` never prompts and prints one JSON summary. `--json` without `--yes` is refused. The exit code is non-zero if a step stopped or a repository could not be enabled.

## Fix with your coding agent

The bridge dispatches **Fix** and **Fix All** from the dashboard to Codex, Claude Code or Cursor Agent running on your machine:

```sh
openreview bridge install
openreview bridge pair --url https://review.example.com
openreview bridge register /absolute/path/to/repository
openreview bridge status
```

The agent works in your registered checkout, and you review, commit and push its changes yourself. The next review checks whether each finding was resolved.
