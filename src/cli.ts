#!/usr/bin/env node
import { loadEnvFile } from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { parseDiff } from "./engine/diff";
import { eligibleFile } from "./engine/indexer";
import { reviewChange } from "./engine/review";
import { modelFromEnvironment } from "./engine/model";
import { applyRepoConfig, loadRepoConfig } from "./repo-config";
import type { Rule, SourceFile } from "./engine/types";
import { runtimeEvidenceSchema } from "./engine/types";
import { findingTags, priorityOf, tagLabels } from "./priority";
import { validateRuntime } from "../scripts/sandbox";
import { memoryToolbox } from "./engine/agent";
import { cacheDirectory, localAgentState, stateFile } from "./local-review-state";
import { inlineReport } from "./inline-output";

try {
  loadEnvFile(".env.local");
} catch {
  /* Explicit environment configuration works without a file. */
}
const execute = promisify(execFile);
async function git(...args: string[]) {
  return (await execute("git", args, { maxBuffer: 8 * 1024 * 1024 })).stdout;
}
const configDirectory = path.join(homedir(), ".config", "openreview");
const cliConfig = z.object({
  url: z.string().url(),
  apiKey: z.string().min(16),
});
async function main() {
  if (process.argv[2] === "bridge") { await (await import("./bridge")).bridgeMain(process.argv.slice(3)); return; }
  if (process.argv[2] === "p4") { await (await import("./perforce-depot")).p4IndexMain(process.argv.slice(3)); return; }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: "string", default: "main" },
      json: { type: "boolean" },
      agent: { type: "boolean" },
      security: { type: "boolean" },
      "runtime-evidence": { type: "string" },
      image: { type: "string" },
      command: { type: "string" },
      timeout: { type: "string", default: "120" },
      mode: { type: "string", default: "standard" },
      url: { type: "string" },
      token: { type: "string" },
      help: { type: "boolean" },
      yes: { type: "boolean" },
      workspace: { type: "string" },
      "create-workspace": { type: "string" },
      repositories: { type: "string" },
      "no-rules": { type: "boolean" },
      engine: { type: "string" },
      resume: { type: "boolean" },
      inline: { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(
      "OpenReview\n\nopenreview login --url https://review.example.com --token <api-key>\nopenreview onboard [--url <server> --token <admin-api-key>] [--repositories all|owner/name,...] [--no-rules] [--workspace <name>] [--yes --json]\nopenreview review [--base main] [--json | --agent | --inline] [--security] [--mode fast|standard|deep] [--engine pipeline|agentic] [--resume]\nopenreview status\nopenreview p4 index --help\nopenreview runtime --image <image@sha256:digest> --command <test-command> [--timeout 120]\n\nLocal review uses LLM_PROVIDER, LLM_MODEL, LLM_API_KEY (or a configured compatible endpoint).",
    );
    return;
  }
  if (command === "login") {
    const config = cliConfig.parse({ url: values.url, apiKey: values.token });
    if (
      !config.url.startsWith("https://") &&
      !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(config.url)
    )
      throw new Error("API URL must use HTTPS");
    const response = await fetch(new URL("/api/repositories", config.url), {
      headers: { authorization: `Bearer ${config.apiKey}` },
    });
    if (!response.ok)
      throw new Error(
        `Login failed: HTTP ${response.status}. Generate an API key in dashboard Settings.`,
      );
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(configDirectory, "config.json"),
      JSON.stringify(config),
      { mode: 0o600 },
    );
    console.log(
      "Authenticated. Configuration saved with owner-only permissions.",
    );
    return;
  }
  if (command === "onboard") {
    // Uses the saved login, or --url/--token (validated and saved like `openreview login`).
    let config;
    if (values.url || values.token) {
      config = cliConfig.parse({ url: values.url, apiKey: values.token });
      if (!config.url.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(config.url)) throw new Error("API URL must use HTTPS");
      await mkdir(configDirectory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(configDirectory, "config.json"), JSON.stringify(config), { mode: 0o600 });
    } else {
      try { config = cliConfig.parse(JSON.parse(await readFile(path.join(configDirectory, "config.json"), "utf8"))); }
      catch { throw new Error("Not logged in. Run openreview onboard --url <server> --token <admin-api-key> (create the key in dashboard Settings → API keys)."); }
    }
    const { onboard, httpApi } = await import("./onboard");
    const root = (await git("rev-parse", "--show-toplevel").catch(() => process.cwd())).trim() || process.cwd();
    const remote = (await git("-C", root, "remote", "get-url", "origin").catch(() => "")).trim() || undefined;
    const { readdir } = await import("node:fs/promises");
    const inside = (relative: string) => { const full = path.resolve(root, relative); if (full !== root && !full.startsWith(root + path.sep)) throw new Error("outside repository"); return full; };
    const files = { read: (relative: string) => readFile(inside(relative), "utf8").catch(() => null), list: (relative: string) => readdir(inside(relative)).catch(() => [] as string[]) };
    const readline = values.yes ? undefined : (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
    try {
      const summary = await onboard(httpApi(config.url, config.apiKey), { ask: (q) => readline ? readline.question(q) : Promise.reject(new Error("No prompts in --yes mode")), print: (line) => console.log(line) }, files, { yes: Boolean(values.yes), json: Boolean(values.json), workspace: values.workspace, createWorkspace: values["create-workspace"], repositories: values.repositories, rules: !values["no-rules"], remote });
      if (values.json) console.log(JSON.stringify(summary, null, 2));
      if (summary.stopped || summary.repositories.failed.length) process.exitCode = 1;
    } finally { readline?.close(); }
    return;
  }
  if (command === "runtime") {
    const evidence = await validateRuntime(
      values.image ?? "",
      values.command ?? "",
      Number(values.timeout),
    );
    console.log(JSON.stringify(evidence, null, 2));
    if (evidence.exitCode !== 0) process.exitCode = 1;
    return;
  }
  if (command === "status") {
    let config;
    try {
      config = cliConfig.parse(
        JSON.parse(
          await readFile(path.join(configDirectory, "config.json"), "utf8"),
        ),
      );
    } catch {
      throw new Error(
        "Not logged in. Run openreview login --url <server> --token <api-key>. Local review also works with LLM environment variables.",
      );
    }
    const response = await fetch(new URL("/api/repositories", config.url), {
      headers: { authorization: `Bearer ${config.apiKey}` },
    });
    if (!response.ok) throw new Error(`Status failed: HTTP ${response.status}`);
    console.log(JSON.stringify(await response.json(), null, 2));
    return;
  }
  if (command !== "review") throw new Error(`Unknown command: ${command}`);
  const root = (await git("rev-parse", "--show-toplevel")).trim();
  const baseRef = values.base!;
  if (baseRef.startsWith("-") || !/^[a-zA-Z0-9_./-]+$/.test(baseRef))
    throw new Error("Invalid base reference");
  const baseSha = (await git("merge-base", baseRef, "HEAD")).trim(),
    headSha = (await git("rev-parse", "HEAD")).trim();
  const diff = parseDiff(
    await git(
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--find-renames",
      "--unified=5",
      baseSha,
      headSha,
    ),
  );
  if (!diff.length) {
    console.log(
      values.json || values.agent
        ? JSON.stringify({
            summary: "No committed changes against base.",
            findings: [],
            usage: [],
          })
        : "No committed changes against base.",
    );
    return;
  }
  const entries = (await git("ls-tree", "-r", "-l", "-z", "HEAD"))
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const [metadata, filePath] = entry.split("\t");
      const [, type, sha, size] = metadata.trim().split(/\s+/);
      return { path: filePath, type, sha, size: Number(size) };
    })
    .filter(
      (e) =>
        e.type === "blob" &&
        e.size <= 200000 &&
        eligibleFile({ path: e.path, sha: e.sha, content: "" }),
    );
  if (entries.length > 5000)
    throw new Error(
      "Local review currently supports up to 5,000 eligible files. Use server indexing for larger repositories.",
    );
  const files: SourceFile[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const content = await git("show", `HEAD:${entry.path}`);
    bytes += content.length;
    if (bytes > 20_000_000)
      throw new Error(
        "Local source indexing exceeds 20 MB; use server indexing.",
      );
    files.push({ ...entry, content });
  }
  // Same repository config schema and base-revision semantics as server reviews.
  const repoConfig = await loadRepoConfig({
    tree: async (_repository, sha) => (await git("ls-tree", "-r", "--long", sha)).split("\n").filter(Boolean).flatMap((line) => {
      const match = /^\d+ blob ([0-9a-f]+)\s+(\d+|-)\t(.+)$/.exec(line);
      return match ? [{ path: match[3], sha: match[1], size: Number(match[2]) || 0 }] : [];
    }),
    blob: async (_repository, _path, sha) => ({ content: await git("cat-file", "blob", sha) }),
  }, root, baseSha);
  for (const warning of repoConfig.warnings) process.stderr.write(`OpenReview config: ${warning}\n`);
  const rules: Rule[] = repoConfig.rules;
  // --resume continues an interrupted agentic review of this checkout (same base and HEAD only).
  const engine = z.enum(["pipeline", "agentic"]).parse(values.engine ?? (values.resume ? "agentic" : "pipeline"));
  if (values.resume && engine !== "agentic") throw new Error("--resume applies to the agentic engine");
  if ([values.json, values.agent, values.inline].filter(Boolean).length > 1) throw new Error("Choose one output format: --json, --agent or --inline");
  const saved = localAgentState(stateFile(cacheDirectory(), root, baseSha), { resume: Boolean(values.resume), headSha });
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const result = await reviewChange(
    {
      repository: path.basename(root),
      baseSha,
      headSha,
      title: (await git("log", "-1", "--format=%s")).trim(),
      description: "",
      diff,
      files,
      rules,
      runtimeEvidence: values["runtime-evidence"]
        ? runtimeEvidenceSchema.parse(
            JSON.parse(await readFile(values["runtime-evidence"], "utf8")),
          )
        : undefined,
      mode: z.enum(["fast", "standard", "deep"]).parse(values.mode),
      settings: {
        ...(repoConfig.settings.ignoredPaths ? { ignoredPaths: repoConfig.settings.ignoredPaths } : {}),
        ...(repoConfig.settings.instructions || repoConfig.directories.length ? { instructions: applyRepoConfig({ instructions: repoConfig.settings.instructions ?? "" }, repoConfig).settings.instructions } : {}),
        ...(repoConfig.settings.categories ? { categories: repoConfig.settings.categories } : {}),
        ...(values.security ? { categories: ["security" as const] } : {}),
      },
    },
    modelFromEnvironment(),
    async (stage) => {
      if (!values.json && !values.agent)
        process.stderr.write(`${stage.replaceAll("_", " ")}\n`);
    },
    controller.signal,
    engine === "agentic" ? { engine, tools: memoryToolbox(files, headSha), agent: saved.hooks } : undefined,
  ).catch((error) => {
    if (engine === "agentic" && controller.signal.aborted) throw new Error("Interrupted. Run the same command with --resume to continue from the last completed step.");
    throw error;
  });
  if (engine === "agentic") {
    await saved.clear();
    if (saved.outcome() !== "fresh" && !values.json && !values.agent) process.stderr.write(saved.outcome() === "resumed" ? "Resumed the interrupted review.\n" : "HEAD moved since the interrupted review; started over.\n");
  }
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else if (values.agent)
    console.log(
      JSON.stringify({
        repository: root,
        commit: headSha,
        findings: result.findings.map((f) => ({
          file: f.filePath,
          line: f.startLine,
          severity: f.severity,
          priority: priorityOf(f.severity),
          tags: findingTags(f),
          issue: f.title,
          evidence: f.evidence,
          fix: f.suggestedFix,
        })),
        summary: result.summary,
      }),
    );
  else if (values.inline) console.log(inlineReport(result.findings, files));
  else {
    console.log(result.summary);
    for (const f of result.findings)
      console.log(
        `\n[${[priorityOf(f.severity) + " " + f.severity, ...findingTags(f).map((t) => tagLabels[t])].join(", ")}] ${f.filePath}:${f.startLine} ${f.title}\n${f.description}\nFix: ${f.suggestedFix}`,
      );
  }
}
main().catch(async (error) => {
  console.error(
    `OpenReview: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
  if (process.argv[2] === "bridge" && process.argv[3] === "dispatch" && process.argv.includes("--desktop") && process.stdin.isTTY && process.stdout.isTTY) {
    const { createInterface } = await import("node:readline/promises");
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try { await terminal.question("Press Enter to close this error. Findings remain unresolved. "); }
    finally { terminal.close(); }
  }
});
