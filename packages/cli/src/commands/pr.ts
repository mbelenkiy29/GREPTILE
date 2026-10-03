/** `openreview status`, `findings`, `fix-prompt`, and `fix-all` (R3.5): a pull request's review on the server. */
import { SEVERITIES, type Severity } from "@/lib/engine/types";
import { ApiResponseError } from "../api";
import { authedClient, meSchema, findingListSchema, resolvePrReview, reviewDetailSchema, TargetError, type Ctx, type ServerFinding } from "../context";
import { CliError } from "../errors";
import { renderAgent, sortFindings, style } from "../render";
import { describeMe } from "./auth";

export interface PrOptions {
  repo?: string;
  pr?: number;
}

function counts(findings: { severity: Severity }[]): Record<Severity, number> {
  const c = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}

function countsText(c: Record<Severity, number>): string {
  const parts = SEVERITIES.filter((s) => c[s] > 0).map((s) => `${c[s]} ${s}`);
  return parts.length ? parts.join(", ") : "none";
}

export async function status(ctx: Ctx, opts: PrOptions & { json?: boolean }): Promise<void> {
  const { api, auth } = await authedClient(ctx);
  const me = await api.json("GET", "/api/v1/me", meSchema);
  const connection = { server: auth.server, reachable: true, keyValid: true, organization: me.organization, scopes: me.scopes, apiKey: me.apiKey };

  let pr: Record<string, unknown> | null = null;
  let prNote: string | null = null;
  try {
    const target = await resolvePrReview(ctx, api, opts);
    const { review } = await api.json("GET", `/api/v1/reviews/${target.review.id}`, reviewDetailSchema);
    const published = review.findings.items.filter((f) => (f.visibility ?? "published") === "published");
    const open = sortFindings(published.filter((f) => f.status === "open"));
    const latest = review.runHistory[0] ?? null;
    pr = {
      repository: review.repoFullName,
      number: review.prNumber,
      title: review.prTitle,
      url: review.pullRequest?.url ?? null,
      state: review.pullRequest?.state ?? null,
      reviewId: review.id,
      reviewStatus: review.status,
      latestRun: latest ? { id: latest.id, status: latest.status, trigger: latest.trigger } : null,
      riskLevel: review.riskLevel,
      error: review.error,
      findings: counts(published),
      openFindings: open.map((f) => ({ id: f.id, severity: f.severity, title: f.title, path: f.path, line: f.startLine })),
    };
  } catch (err) {
    // Without an explicit target, a missing repository, branch, or review is not an error for `status`.
    if (!(err instanceof TargetError) || opts.pr !== undefined || opts.repo !== undefined) throw err;
    prNote = err.hint ? `${err.message} ${err.hint}` : err.message;
  }

  if (opts.json) {
    ctx.out(JSON.stringify({ connection, pullRequest: pr, note: prNote }, null, 2));
    return;
  }
  const s = style(ctx.color);
  const lines = [s.bold("Connection"), ...describeMe(me, auth.server).map((l) => `  ${l}`), `  Status:       ${s.green("connected, key valid")}`, ""];
  if (pr) {
    const run = pr.latestRun as { id: number; status: string; trigger: string } | null;
    const open = pr.openFindings as { id: number; severity: Severity; title: string; path: string; line: number }[];
    lines.push(s.bold(`Pull request #${pr.number as number} · ${pr.repository as string}`));
    lines.push(`  ${pr.title as string}${pr.url ? `  ${s.dim(pr.url as string)}` : ""}`);
    lines.push(`  Review:       ${pr.reviewStatus as string}${pr.riskLevel ? ` (risk ${pr.riskLevel as string})` : ""}`);
    lines.push(`  Latest run:   ${run ? `#${run.id} ${run.status} (${run.trigger})` : "none yet"}`);
    if (pr.error) lines.push(`  Error:        ${pr.error as string}`);
    lines.push(`  Findings:     ${countsText(pr.findings as Record<Severity, number>)}`);
    if (open.length) {
      lines.push("", s.bold(`Open findings (${open.length})`));
      for (const f of open) lines.push(`  ${s.severity(f.severity, `[${f.severity}]`)} ${f.path}:${f.line} ${f.title} ${s.dim(`(id ${f.id})`)}`);
      lines.push("", s.dim("  `openreview findings --agent` lists them for a coding agent; `openreview fix-all` prints one task to fix them."));
    } else {
      lines.push(`  Open findings: none`);
    }
  } else if (prNote) {
    lines.push(s.dim(prNote));
  }
  ctx.out(lines.join("\n"));
}

async function openFindings(ctx: Ctx, opts: PrOptions): Promise<{ findings: ServerFinding[]; header: string; reviewId: number }> {
  const { api } = await authedClient(ctx);
  const target = await resolvePrReview(ctx, api, opts);
  const all: ServerFinding[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await api.json("GET", "/api/v1/findings", findingListSchema, { query: { reviewId: target.review.id, status: "open", pageSize: 100, page } });
    all.push(...res.data);
    if (!res.pagination.hasMore) break;
  }
  const header = `# OpenReview: ${all.length} open finding${all.length === 1 ? "" : "s"} on ${target.repo} #${target.review.prNumber} (${target.review.prTitle})`;
  return { findings: sortFindings(all), header, reviewId: target.review.id };
}

export async function findings(ctx: Ctx, opts: PrOptions & { json?: boolean; agent?: boolean; maxFindings?: number }): Promise<void> {
  const { findings: list, header, reviewId } = await openFindings(ctx, opts);
  const shown = opts.maxFindings === undefined ? list : list.slice(0, opts.maxFindings);
  if (opts.json) {
    ctx.out(JSON.stringify({ reviewId, total: list.length, findings: shown }, null, 2));
    return;
  }
  if (opts.agent) {
    ctx.out(renderAgent({ header, findings: list, ...(opts.maxFindings !== undefined ? { maxFindings: opts.maxFindings } : {}) }));
    return;
  }
  const s = style(ctx.color);
  const lines = [s.bold(header.replace(/^# /, "")), ""];
  if (!shown.length) lines.push(s.green("No open findings."));
  for (const f of shown) {
    lines.push(`${s.severity(f.severity, `[${f.severity.toUpperCase()}]`)} ${s.bold(f.title)} ${s.dim(`(id ${f.id})`)}`);
    lines.push(`  ${f.path}:${f.startLine} · ${f.category}`);
    if (f.description) lines.push(`  ${f.description.replace(/\n/g, "\n  ")}`);
    lines.push("");
  }
  if (shown.length < list.length) lines.push(s.dim(`… ${list.length - shown.length} more.`));
  lines.push(s.dim("`openreview fix-prompt <id>` prints a prompt that fixes one; `openreview fix-all` fixes them all."));
  ctx.out(lines.join("\n"));
}

async function deliver(ctx: Ctx, text: string, copy: boolean | undefined): Promise<void> {
  ctx.out(text);
  if (!copy) return;
  const tool = await ctx.io.copy(text);
  if (tool) ctx.note(`Copied to the clipboard (${tool}).`);
  else ctx.warn("No clipboard tool found (pbcopy, wl-copy, xclip, xsel, or clip); the prompt is printed above.");
}

export const FIX_AGENTS = ["claude-code", "cursor", "codex"] as const;

export async function fixPrompt(ctx: Ctx, findingId: string, opts: { agent?: string; copy?: boolean }): Promise<void> {
  const id = Number(findingId);
  if (!Number.isInteger(id) || id <= 0) throw new CliError(`"${findingId}" is not a finding id.`, "`openreview findings` lists open findings with their ids.");
  const agent = opts.agent ?? "claude-code";
  if (!(FIX_AGENTS as readonly string[]).includes(agent)) throw new CliError(`--for must be one of ${FIX_AGENTS.join(", ")}.`);
  const { api } = await authedClient(ctx);
  try {
    const text = await api.text("GET", `/api/v1/findings/${id}/fix-prompt`, { query: { agent, format: "text" } });
    await deliver(ctx, text, opts.copy);
  } catch (err) {
    if (err instanceof ApiResponseError && err.status === 404) throw new CliError(`Finding ${id} was not found in your organization.`, "`openreview findings` lists open findings with their ids.");
    throw err;
  }
}

export async function fixAll(ctx: Ctx, opts: PrOptions & { copy?: boolean; minConfidence?: number }): Promise<void> {
  const { api } = await authedClient(ctx);
  const target = await resolvePrReview(ctx, api, opts);
  const text = await api.text("GET", `/api/v1/reviews/${target.review.id}/fix-all`, {
    query: { format: "md", ...(opts.minConfidence !== undefined ? { minConfidence: opts.minConfidence } : {}) },
  });
  await deliver(ctx, text, opts.copy);
}
