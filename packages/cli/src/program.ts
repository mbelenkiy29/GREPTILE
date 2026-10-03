/**
 * The `openreview` command line (R3.5). {@link run} parses arguments and runs one command in-process against an
 * injected {@link CliIo}, returning the exit code; `cli.ts` binds it to the real process.
 */
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { SEVERITIES, type Severity } from "@/lib/engine/types";
import { REVIEW_MODES, type ReviewMode } from "@/lib/llm/types";
import { setLogSink } from "@/lib/log";
import { CLI_VERSION } from "./api";
import { login, logout, whoami } from "./commands/auth";
import { findings, fixAll, fixPrompt, FIX_AGENTS, status } from "./commands/pr";
import { review } from "./commands/review";
import { makeCtx, prOption } from "./context";
import { CliError, EXIT, scrubSecrets } from "./errors";
import type { CliIo } from "./io";

function intArg(name: string) {
  return (value: string) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError(`${name} must be a positive whole number.`);
    return n;
  };
}

function prArg(value: string): number {
  try {
    return prOption(value);
  } catch (err) {
    throw new InvalidArgumentError((err as Error).message);
  }
}

function confidenceArg(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new InvalidArgumentError("--min-confidence must be between 0 and 1.");
  return n;
}

const REVIEW_EXAMPLES = `
Examples:
  $ openreview review                        review this branch against origin's default branch
  $ openreview review --base develop         compare against another branch
  $ openreview review --include-uncommitted  include staged, unstaged, and untracked changes
  $ openreview review --local --mode fast    review fully locally with a quick pass
  $ openreview review --agent                compact output for Claude Code, Cursor, or Codex
  $ openreview review --json --fail-on high  machine-readable; exit 1 on high or critical findings

Modes:
  server  (default when logged in and the repository is connected) reviews against your OpenReview server's index
          of the repository, with your organization's settings, rules, and learned preferences. Nothing is posted
          to GitHub.
  local   (--local, or when not logged in) indexes the working tree into .openreview/ and runs the review engine on
          this machine with your own model: set ANTHROPIC_API_KEY, or LLM_PROVIDER and LLM_API_KEY (and optionally
          LLM_MODEL, EMBEDDING_API_KEY).

Exit codes: 0 done, 1 a finding at or above --fail-on, 2 an error.`;

const ROOT_HELP = `
Examples:
  $ openreview login --server https://openreview.example.com
  $ openreview review
  $ openreview status
  $ openreview findings --agent
  $ openreview fix-all --copy

Environment:
  OPENREVIEW_URL, OPENREVIEW_TOKEN   server and API key (override the saved login)
  ANTHROPIC_API_KEY, LLM_PROVIDER, LLM_API_KEY, LLM_MODEL, LLM_BASE_URL, EMBEDDING_API_KEY
                                     the model for local reviews
  NO_COLOR                           disable colors`;

function build(io: CliIo, setExit: (code: number) => void): Command {
  const program = new Command();
  const write = (fn: (t: string) => void) => (t: string) => fn(t);
  program
    .name("openreview")
    .description("AI code review of your changes, on your OpenReview server or fully local.")
    .version(CLI_VERSION, "-v, --version")
    .option("--verbose", "print diagnostic logs to stderr")
    .addHelpText("after", ROOT_HELP)
    .showHelpAfterError("(run with --help for usage)")
    .exitOverride()
    .configureOutput({ writeOut: write(io.stdout), writeErr: write(io.stderr), outputError: (str, w) => w(str) });

  program
    .command("login")
    .description("Sign in to an OpenReview server (opens the browser to approve), or save an API key")
    .option("--server <url>", "your OpenReview server, e.g. https://openreview.example.com")
    .option("--token <key>", "an API key (or_live_…) to save instead of signing in; `-` reads it from stdin")
    .option("--no-browser", "print the sign-in link without opening a browser")
    .addHelpText(
      "after",
      `
Examples:
  $ openreview login --server https://openreview.example.com
  $ echo "$KEY" | openreview login --server https://openreview.example.com --token -

The key is stored in ~/.config/openreview/config.json (mode 0600). OPENREVIEW_URL and OPENREVIEW_TOKEN override it.`,
    )
    .action(async (opts: { server?: string; token?: string; browser: boolean }) => {
      await login(makeCtx(io), opts);
    });

  program
    .command("logout")
    .description("Forget the saved server and API key")
    .action(async () => {
      await logout(makeCtx(io));
    });

  program
    .command("whoami")
    .description("Show the server, organization, API key, and scopes in use")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      await whoami(makeCtx(io), opts);
    });

  program
    .command("status")
    .description("Check the connection, and show the review of this branch's pull request")
    .option("--repo <owner/name>", "repository (default: from the git remote)")
    .option("--pr <number>", "pull request number (default: the pull request of the current branch)", prArg)
    .option("--json", "machine-readable output")
    .addHelpText("after", "\nExamples:\n  $ openreview status\n  $ openreview status --pr 42 --json")
    .action(async (opts: { repo?: string; pr?: number; json?: boolean }) => {
      await status(makeCtx(io), opts);
    });

  program
    .command("review")
    .description("Review the current branch against its base branch")
    .option("--base <ref>", "branch, tag, or commit to compare against (default: origin's default branch, else main/master)")
    .option("--include-uncommitted", "also review staged, unstaged, and untracked changes")
    .option("--local", "review on this machine with your own model, even when logged in")
    .option("--server", "review on the server; fail instead of falling back to local mode")
    .option("--repo <owner/name>", "repository on the server (default: from the git remote)")
    .addOption(new Option("--mode <mode>", "review depth").choices([...REVIEW_MODES]))
    .option("--security", "focus the review on security")
    .option("--json", "structured JSON output (see the README for the schema)")
    .option("--agent", "concise output for coding agents, with a Fix-all checklist")
    .addOption(new Option("--fail-on <severity>", "exit 1 when a finding at or above this severity exists").choices([...SEVERITIES]))
    .option("--max-findings <n>", "show at most n findings (most severe first)", intArg("--max-findings"))
    .option("-q, --quiet", "print only the findings")
    .addHelpText("after", REVIEW_EXAMPLES)
    .action(
      async (opts: {
        base?: string;
        includeUncommitted?: boolean;
        local?: boolean;
        server?: boolean;
        repo?: string;
        mode?: ReviewMode;
        security?: boolean;
        json?: boolean;
        agent?: boolean;
        failOn?: Severity;
        maxFindings?: number;
        quiet?: boolean;
      }) => {
        if (opts.local && opts.server) throw new CliError("Use either --local or --server, not both.");
        if (opts.json && opts.agent) throw new CliError("Use either --json or --agent, not both.");
        setExit(await review(makeCtx(io, { quiet: opts.quiet || opts.json || opts.agent }), opts));
      },
    );

  program
    .command("findings")
    .description("List the unresolved findings of this branch's pull request")
    .option("--repo <owner/name>", "repository (default: from the git remote)")
    .option("--pr <number>", "pull request number (default: the pull request of the current branch)", prArg)
    .option("--json", "machine-readable output")
    .option("--agent", "concise output for coding agents, with a Fix-all checklist")
    .option("--max-findings <n>", "show at most n findings", intArg("--max-findings"))
    .addHelpText("after", "\nExamples:\n  $ openreview findings\n  $ openreview findings --pr 42 --agent")
    .action(async (opts: { repo?: string; pr?: number; json?: boolean; agent?: boolean; maxFindings?: number }) => {
      await findings(makeCtx(io), opts);
    });

  program
    .command("fix-prompt")
    .description("Print a coding-agent prompt that fixes one finding")
    .argument("<findingId>", "the finding's id (from `openreview findings`)")
    .addOption(new Option("--for <agent>", "which coding agent the prompt is for").choices([...FIX_AGENTS]).default("claude-code"))
    .option("--copy", "also copy it to the clipboard")
    .addHelpText("after", "\nExamples:\n  $ openreview fix-prompt 123 --copy\n  $ openreview fix-prompt 123 --for cursor")
    .action(async (findingId: string, opts: { for: string; copy?: boolean }) => {
      await fixPrompt(makeCtx(io), findingId, { agent: opts.for, ...(opts.copy ? { copy: true } : {}) });
    });

  program
    .command("fix-all")
    .description("Print one coding-agent task that fixes every unresolved finding of a pull request")
    .option("--repo <owner/name>", "repository (default: from the git remote)")
    .option("--pr <number>", "pull request number (default: the pull request of the current branch)", prArg)
    .option("--min-confidence <0-1>", "leave out findings below this confidence", confidenceArg)
    .option("--copy", "also copy it to the clipboard")
    .addHelpText("after", "\nExamples:\n  $ openreview fix-all\n  $ openreview fix-all --pr 42 --copy")
    .action(async (opts: { repo?: string; pr?: number; minConfidence?: number; copy?: boolean }) => {
      await fixAll(makeCtx(io), opts);
    });

  return program;
}

/** Runs the CLI with `argv` (without the node and script paths). Never throws; returns the exit code. */
export async function run(argv: string[], io: CliIo): Promise<number> {
  let exitCode: number = EXIT.ok;
  const verbose = argv.includes("--verbose");
  // Library logs (indexer, engine, gateway) are JSON lines for servers; the CLI shows them only with --verbose.
  const restore = setLogSink(verbose ? (line) => io.stderr(`${line}\n`) : () => undefined);
  try {
    const program = build(io, (code) => {
      exitCode = code;
    });
    if (!argv.length) {
      program.outputHelp();
      return EXIT.ok;
    }
    await program.parseAsync(argv, { from: "user" });
    return exitCode;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help and version exit 0; usage errors were already printed by commander.
      return err.exitCode === 0 ? EXIT.ok : EXIT.error;
    }
    if (err instanceof CliError) {
      io.stderr(`error: ${scrubSecrets(err.message)}\n`);
      if (err.hint) io.stderr(`${scrubSecrets(err.hint)}\n`);
      return err.exitCode;
    }
    io.stderr(`error: ${scrubSecrets(err instanceof Error ? err.message : String(err))}\n`);
    if (verbose && err instanceof Error && err.stack) io.stderr(`${scrubSecrets(err.stack)}\n`);
    else io.stderr("Run with --verbose for details.\n");
    return EXIT.error;
  } finally {
    restore();
  }
}
