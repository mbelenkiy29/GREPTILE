/** What every command gets: the IO, output helpers, and the server lookups several commands share. */
import { z } from "zod";
import { SEVERITIES } from "@/lib/engine/types";
import { ApiClient, ApiResponseError } from "./api";
import { requireAuth, type Auth } from "./config";
import { CliError } from "./errors";
import { currentBranch, remoteRepo, repoRoot } from "./git";
import type { CliIo } from "./io";

export interface Ctx {
  io: CliIo;
  /** Colors on stdout. */
  color: boolean;
  out(text: string): void;
  /** Progress and notes (stderr), silenced by --quiet. */
  note(text: string): void;
  warn(text: string): void;
}

export function makeCtx(io: CliIo, opts: { quiet?: boolean } = {}): Ctx {
  return {
    io,
    color: io.isTTY && !io.env.NO_COLOR && io.env.TERM !== "dumb",
    out: (t) => io.stdout(t.endsWith("\n") ? t : `${t}\n`),
    note: (t) => {
      if (!opts.quiet) io.stderr(`${t}\n`);
    },
    warn: (t) => io.stderr(`warning: ${t}\n`),
  };
}

export async function authedClient(ctx: Ctx, opts: { server?: string } = {}): Promise<{ api: ApiClient; auth: Auth }> {
  const auth = await requireAuth(ctx.io, opts);
  return { api: new ApiClient(ctx.io, auth.server, auth.token), auth };
}

// ---- response schemas (loose: newer servers may add fields)

export const meSchema = z.looseObject({
  organization: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
  scopes: z.array(z.string()),
  apiKey: z.object({ id: z.number(), name: z.string(), prefix: z.string() }).nullable(),
  user: z.looseObject({ id: z.string(), name: z.string() }).nullable(),
});
export type Me = z.infer<typeof meSchema>;

const pagination = z.looseObject({ total: z.number(), hasMore: z.boolean() });

export const repositorySchema = z.looseObject({ id: z.number(), fullName: z.string(), enabled: z.boolean(), indexStatus: z.string(), defaultBranch: z.string().optional() });
export const repositoryListSchema = z.object({ data: z.array(repositorySchema), pagination });

export const reviewListItemSchema = z.looseObject({
  id: z.number(),
  repoFullName: z.string(),
  prNumber: z.number(),
  prTitle: z.string(),
  status: z.string(),
  headSha: z.string(),
  findings: z.number(),
  lastRun: z.looseObject({ id: z.number(), status: z.string(), trigger: z.string() }).nullable(),
});
export const reviewListSchema = z.object({ data: z.array(reviewListItemSchema), pagination });

export const severitySchema = z.enum(SEVERITIES);
export const serverFindingSchema = z.looseObject({
  id: z.number(),
  title: z.string(),
  severity: severitySchema,
  confidence: z.number(),
  category: z.string(),
  path: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  status: z.string(),
  description: z.string().default(""),
  impact: z.string().nullable().optional(),
  suggestedFix: z.string().nullable().optional(),
  suggestion: z.string().nullable().optional(),
  visibility: z.string().optional(),
});
export type ServerFinding = z.infer<typeof serverFindingSchema>;
export const findingListSchema = z.object({ data: z.array(serverFindingSchema), pagination });

export const reviewDetailSchema = z.object({
  review: z.looseObject({
    id: z.number(),
    repoFullName: z.string(),
    prNumber: z.number(),
    prTitle: z.string(),
    status: z.string(),
    headSha: z.string(),
    riskLevel: z.string().nullable(),
    openFindings: z.number(),
    error: z.string().nullable(),
    pullRequest: z.looseObject({ url: z.string().nullable(), state: z.string(), headRef: z.string(), baseRef: z.string() }).nullable(),
    runHistory: z.array(z.looseObject({ id: z.number(), status: z.string(), trigger: z.string() })),
    findings: z.looseObject({ items: z.array(serverFindingSchema), total: z.number() }),
  }),
});
export type ReviewDetail = z.infer<typeof reviewDetailSchema>["review"];

/** The repository, branch, or pull request review could not be determined (not a server or network failure). */
export class TargetError extends CliError {}

/** The repository's `owner/name`: `--repo`, else the git remote. */
export async function repoName(ctx: Ctx, explicit: string | undefined): Promise<{ fullName: string; root: string | null }> {
  if (explicit) {
    if (!/^[^/\s]+(\/[^/\s]+)+$/.test(explicit)) throw new CliError(`--repo must look like owner/name (got "${explicit}").`);
    return { fullName: explicit, root: await repoRoot(ctx.io.cwd).catch(() => null) };
  }
  const root = await repoRoot(ctx.io.cwd).catch((err: unknown) => Promise.reject(err instanceof CliError ? new TargetError(err.message, err.hint) : err));
  const fullName = await remoteRepo(root);
  if (!fullName) throw new TargetError("Couldn't tell which repository this is: it has no git remote.", "Pass --repo owner/name.");
  return { fullName, root };
}

/** The connected repository named `fullName` on the server, or null when it is not connected. */
export async function findRepository(api: ApiClient, fullName: string): Promise<z.infer<typeof repositorySchema> | null> {
  const page = await api.json("GET", "/api/v1/repositories", repositoryListSchema, { query: { q: fullName, pageSize: 50 } });
  return page.data.find((r) => r.fullName.toLowerCase() === fullName.toLowerCase()) ?? null;
}

export interface PrTarget {
  repo: string;
  /** The pull request number, or the branch it was looked up by. */
  label: string;
  review: z.infer<typeof reviewListItemSchema>;
}

/** The review of `--pr N`, else of the pull request whose head is the current branch. */
export async function resolvePrReview(ctx: Ctx, api: ApiClient, opts: { repo?: string; pr?: number }): Promise<PrTarget> {
  const { fullName, root } = await repoName(ctx, opts.repo);
  let query: Record<string, string | number>;
  let label: string;
  if (opts.pr !== undefined) {
    query = { repository: fullName, prNumber: opts.pr };
    label = `#${opts.pr}`;
  } else {
    if (!root) throw new TargetError("Not inside a git repository, so there is no current branch.", "Pass --pr <number>.");
    const branch = await currentBranch(root);
    if (!branch) throw new TargetError("HEAD is detached, so there is no branch to find a pull request for.", "Check out your branch, or pass --pr <number>.");
    query = { repository: fullName, headRef: branch };
    label = `branch ${branch}`;
  }
  const page = await api.json("GET", "/api/v1/reviews", reviewListSchema, { query: { ...query, pageSize: 1 } });
  const review = page.data[0];
  if (!review) {
    const repo = await findRepository(api, fullName).catch((err: unknown) => (err instanceof ApiResponseError ? null : Promise.reject(err)));
    if (!repo) throw new TargetError(`${fullName} is not connected to OpenReview.`, "Install the app on it from the dashboard, or review locally with `openreview review --local`.");
    throw new TargetError(`No review found for ${label} in ${fullName}.`, "Open a pull request (it is reviewed automatically), or review your branch now with `openreview review`.");
  }
  return { repo: fullName, label, review };
}

/** `--pr` as a positive integer. */
export function prOption(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new CliError(`--pr must be a pull request number (got "${value}").`);
  return n;
}
