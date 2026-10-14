# CLI

Review committed changes locally against their merge base:

```sh
pnpm cli review --base main
pnpm cli review --json
pnpm cli review --security --mode deep
pnpm cli review --agent      # output for coding agents
pnpm cli review --inline     # file:line blocks with surrounding code
pnpm cli review --engine agentic
pnpm cli review --resume     # continue an interrupted agentic review
```

Run `npm link` to install the `openreview` command from a checkout.

- **Model credentials:** local reviews use model credentials from your environment.
- **Repository config:** they read `.openreview.json` from the base commit.
- **Limits:** they never execute repository code, and index at most 5,000 files or 20 MB.

`--inline` prints each finding as a `file:line` block. The block includes two lines of code on either side, with the flagged lines marked `>`, then the priority, any tags, the explanation and the suggested fix.

`--engine agentic` runs the tool-using reviewer. It saves its progress after every step in your OS cache directory: `~/Library/Caches/openreview` on macOS, `$XDG_CACHE_HOME/openreview` or `~/.cache/openreview` on Linux, and `%LOCALAPPDATA%\openreview\cache` on Windows. The saved file is owner-only and keyed by checkout and base commit.

If a review is interrupted (for example with Ctrl-C), run the same command with `--resume`, which implies the agentic engine, to continue from the last completed step. The saved progress is used only when `HEAD` is unchanged. If you committed since, it is discarded and the review starts over. It is removed when a review finishes.

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

Without the bridge, each finding offers prompt links for Cursor, Claude Code, Codex and Conductor. These are the agents' documented deep links, and each one only pre-fills the prompt. **Send to Devin** uses Devin's API with your own key, saved under Personal agents. It appears only after you save that key.
