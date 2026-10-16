import { z } from "zod";
import { discoverRuleFiles, importCandidates, type RuleFileSystem } from "./rule-files";

// `openreview onboard`: workspace → provider install link → enable repositories → import AI rule
// files as suggested rules. Talks only to the OpenReview API with the saved workspace API key. It
// prints the provider install link and never changes provider settings. `--yes --json` runs without
// prompts for coding agents.
export type OnboardApi = { get(path: string): Promise<unknown>; post(path: string, body: unknown): Promise<unknown> };
export type OnboardIO = { ask(question: string): Promise<string>; print(line: string): void };
export type OnboardOptions = { yes: boolean; json: boolean; workspace?: string; createWorkspace?: string; repositories?: string; rules: boolean; remote?: string };
export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }

const workspaceResponse = z.object({
  workspace: z.object({ id: z.string(), name: z.string(), role: z.string() }),
  workspaces: z.array(z.object({ id: z.string(), name: z.string(), role: z.string(), current: z.boolean() })),
  installUrl: z.string().url(), dashboardUrl: z.string().url(), keysUrl: z.string().url(), rulesUrl: z.string().url(),
});
const repositoryList = z.array(z.object({ _id: z.string(), fullName: z.string(), enabled: z.boolean(), indexStatus: z.string() }).passthrough());
const enableResponse = z.object({ enabled: z.boolean().optional(), indexStatus: z.string().optional() }).passthrough();
const importResponse = z.object({ suggested: z.number(), rejected: z.array(z.object({ title: z.string(), reason: z.string() })) });

export type OnboardSummary = {
  workspace?: { id: string; name: string; role: string };
  stopped?: { step: "workspace"; reason: string; next: string };
  installUrl?: string;
  repositories: { enabled: { fullName: string; indexStatus?: string }[]; failed: { fullName: string; error: string }[]; alreadyEnabled: string[]; available: string[] };
  rules: { files: string[]; candidates: number; suggested: number; rejected: { title: string; reason: string }[]; skipped?: string; reviewUrl?: string };
};

// owner/name (or group/sub/name) from a git remote URL.
export function repositoryFromRemote(remote: string | undefined) {
  if (!remote) return undefined;
  const m = /^(?:[\w.+-]+:\/\/(?:[^@/]+@)?[^/]+(?::\d+)?\/|[^@\s]+@[^:\s]+:)(.+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m && /^[\w.-]+(\/[\w.-]+)+$/.test(m[1]) ? m[1] : undefined;
}
const yesNo = async (io: OnboardIO, question: string, fallback = true) => {
  const answer = (await io.ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
  return answer ? /^y(es)?$/.test(answer) : fallback;
};

export async function onboard(api: OnboardApi, io: OnboardIO, files: RuleFileSystem, options: OnboardOptions): Promise<OnboardSummary> {
  if (options.json && !options.yes) throw new Error("--json runs without prompts; add --yes to accept the defaults");
  const interactive = !options.yes;
  const say = (line: string) => { if (!options.json) io.print(line); };
  const summary: OnboardSummary = { repositories: { enabled: [], failed: [], alreadyEnabled: [], available: [] }, rules: { files: [], candidates: 0, suggested: 0, rejected: [] } };

  // 1. Workspace: API keys belong to one workspace. Another workspace (or a new one) needs its own key.
  const info = workspaceResponse.parse(await api.get("/api/workspace"));
  summary.workspace = info.workspace;
  say(`Workspace: ${info.workspace.name} (${info.workspace.role})`);
  const others = info.workspaces.filter((w) => !w.current);
  const stop = (reason: string, next: string) => { summary.stopped = { step: "workspace", reason, next }; say(reason); say(next); return summary; };
  if (options.createWorkspace) return stop(`Workspaces are created in the dashboard, and each one gets its own API key.`, `Create "${options.createWorkspace}" at ${info.dashboardUrl}, generate an admin API key at ${info.keysUrl} (after switching to it), then run openreview login and openreview onboard again.`);
  if (options.workspace && ![info.workspace.id, info.workspace.name.toLowerCase()].includes(options.workspace.toLowerCase())) {
    const target = info.workspaces.find((w) => w.id === options.workspace || w.name.toLowerCase() === options.workspace!.toLowerCase());
    return stop(target ? `This API key belongs to ${info.workspace.name}, not ${target.name}.` : `No workspace named ${options.workspace} is available to you.`, `Switch to the workspace in the dashboard, generate an API key at ${info.keysUrl}, then run openreview login again.`);
  }
  if (interactive && others.length) {
    say(`Other workspaces: ${others.map((w) => w.name).join(", ")}`);
    if (!(await yesNo(io, `Continue with ${info.workspace.name}?`))) return stop("Stopped before making changes.", `To use another workspace, switch to it in the dashboard, generate an API key at ${info.keysUrl}, then run openreview login again.`);
  }
  if (!["owner", "admin"].includes(info.workspace.role)) say("Note: enabling repositories and importing rules need a workspace admin; those steps may be refused.");

  // 2. Provider install link (printed only).
  summary.installUrl = info.installUrl;
  say(`Install the GitHub App on the repositories you want reviewed: ${info.installUrl}`);
  say("(Other providers are connected under Settings → Providers in the dashboard.)");

  // 3. Repositories.
  const repositories = repositoryList.parse(await api.get("/api/repositories"));
  const current = repositoryFromRemote(options.remote)?.toLowerCase();
  const detected = current ? repositories.find((r) => r.fullName.toLowerCase() === current || r.fullName.toLowerCase().endsWith("/" + current.split("/").slice(-2).join("/"))) : undefined;
  summary.repositories.alreadyEnabled = repositories.filter((r) => r.enabled).map((r) => r.fullName);
  summary.repositories.available = repositories.filter((r) => !r.enabled).map((r) => r.fullName);
  if (!repositories.length) say("No repositories are installed yet. Install the app, then run openreview onboard again to enable them.");
  let selected: typeof repositories = [];
  const byNames = (list: string) => {
    const names = list.split(",").map((n) => n.trim().toLowerCase()).filter(Boolean);
    const unknown = names.filter((n) => !repositories.some((r) => r.fullName.toLowerCase() === n));
    if (unknown.length) throw new Error(`Unknown repositories: ${unknown.join(", ")}. Installed: ${repositories.map((r) => r.fullName).join(", ") || "none"}`);
    return repositories.filter((r) => names.includes(r.fullName.toLowerCase()));
  };
  if (options.repositories === "all") selected = repositories.filter((r) => !r.enabled);
  else if (options.repositories) selected = byNames(options.repositories);
  else if (interactive && summary.repositories.available.length) {
    say(`Installed but not enabled: ${summary.repositories.available.join(", ")}`);
    const fallback = detected && !detected.enabled ? detected.fullName : "";
    const answer = (await io.ask(`Repositories to enable (comma separated, "all", or blank${fallback ? ` for ${fallback}` : " to skip"}): `)).trim();
    selected = answer === "all" ? repositories.filter((r) => !r.enabled) : answer ? byNames(answer) : fallback ? [detected!] : [];
  } else if (detected && !detected.enabled) selected = [detected];
  for (const repo of selected.filter((r) => !r.enabled)) {
    try {
      const status = enableResponse.parse(await api.post("/api/repositories", { repositoryId: repo._id }));
      summary.repositories.enabled.push({ fullName: repo.fullName, ...(status.indexStatus ? { indexStatus: status.indexStatus } : {}) });
      say(`Enabled ${repo.fullName}; indexing ${status.indexStatus ?? "started"}.`);
    } catch (error) {
      summary.repositories.failed.push({ fullName: repo.fullName, error: error instanceof Error ? error.message.slice(0, 200) : "failed" });
      say(`Could not enable ${repo.fullName}: ${error instanceof Error ? error.message : "failed"}`);
    }
  }

  // 4. AI rule files → suggested rules (an admin approves each one in the dashboard).
  if (!options.rules) { summary.rules.skipped = "disabled with --no-rules"; return summary; }
  const found = await discoverRuleFiles(files);
  const candidates = importCandidates(found);
  summary.rules.files = found.map((f) => f.path);
  summary.rules.candidates = candidates.length;
  if (!candidates.length) { summary.rules.skipped = found.length ? "no rule-like statements found" : "no AI rule files found"; say(found.length ? `No review rules found in ${summary.rules.files.join(", ")}.` : "No AI rule files (CLAUDE.md, AGENTS.md, .cursorrules, …) found here."); return summary; }
  say(`Found ${candidates.length} candidate rule${candidates.length === 1 ? "" : "s"} in ${summary.rules.files.join(", ")}.`);
  if (interactive && !(await yesNo(io, "Import them as suggested rules for an admin to approve?"))) { summary.rules.skipped = "declined"; return summary; }
  const result = importResponse.parse(await api.post("/api/rules/import", { ...(detected ? { repositoryId: detected._id } : {}), rules: candidates }));
  summary.rules.suggested = result.suggested;
  summary.rules.rejected = result.rejected;
  summary.rules.reviewUrl = info.rulesUrl;
  say(`${result.suggested} suggested rule${result.suggested === 1 ? "" : "s"} await approval at ${info.rulesUrl}${result.rejected.length ? `; ${result.rejected.length} discarded by the safety checks` : ""}.`);
  return summary;
}

// HTTP client for the CLI: Bearer API key, JSON in and out, readable errors.
export function httpApi(baseUrl: string, apiKey: string, fetcher: typeof fetch = fetch): OnboardApi {
  const call = async (path: string, init: RequestInit) => {
    const response = await fetcher(new URL(path, baseUrl), { ...init, headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...(init.headers ?? {}) } });
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new ApiError(response.status, response.status === 401 ? "The API key was rejected. Run openreview login --url <server> --token <api-key>." : body.error ?? `HTTP ${response.status}`);
    return body;
  };
  return { get: (path) => call(path, { method: "GET" }), post: (path, body) => call(path, { method: "POST", body: JSON.stringify(body) }) };
}
