/**
 * The repo settings form for runtime validation (R4.5): owners and admins set a repository's sandbox commands in the
 * dashboard (a base-branch `openreview.json` `runtimeValidation` block takes precedence). Saving merges into the
 * repo's settings layer without touching the review settings.
 */
import { can, type Role } from "@/lib/auth/permissions";
import type { Db } from "@/lib/db";
import type { RuntimeValidationConfig } from "@/lib/db/schema";
import { getRepo, updateRepoSettings } from "@/lib/data/installations";
import { runtimeValidationSchema } from "./config";

export type RuntimeValidationFormResult = { status: "saved" | "cleared" } | { status: "invalid"; message: string } | { status: "forbidden" | "not_found" };

const text = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
};

/** `KEY=value` lines into an object; blank lines and `#` comments are skipped. */
function parseEnvLines(source: string): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (const [i, raw] of source.split("\n").entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return `Line ${i + 1} of the environment is not KEY=value.`;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** The submitted form as a runtime validation config, `null` to remove it, or an error message. */
export function parseRuntimeValidationForm(form: FormData): { config: RuntimeValidationConfig | null } | { error: string } {
  const enabled = form.get("enabled") === "true";
  const test = text(form, "test");
  if (!enabled && !test) return { config: null };
  const env = parseEnvLines(text(form, "env"));
  if (typeof env === "string") return { error: env };
  const timeout = text(form, "timeoutSec");
  const candidate = {
    enabled,
    test,
    ...(text(form, "image") ? { image: text(form, "image") } : {}),
    ...(text(form, "install") ? { install: text(form, "install") } : {}),
    ...(timeout ? { timeoutSec: Number(timeout) } : {}),
    ...(text(form, "network") === "install-only" ? { network: "install-only" as const } : {}),
    ...(Object.keys(env).length ? { env } : {}),
  };
  const parsed = runtimeValidationSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const field = issue.path.length ? `${issue.path.join(".")}: ` : "";
    return { error: `${field}${issue.message}` };
  }
  return { config: parsed.data };
}

/** Saves (or removes) a repository's runtime validation settings; `ctx` comes from the session. */
export async function saveRuntimeValidationForm(db: Db, ctx: { orgId: string; role: Role }, form: FormData): Promise<RuntimeValidationFormResult> {
  if (!can(ctx.role, "settings.manage")) return { status: "forbidden" };
  const repoId = Number(text(form, "repoId"));
  const repo = Number.isSafeInteger(repoId) ? await getRepo(db, ctx.orgId, repoId) : undefined;
  if (!repo) return { status: "not_found" };
  const parsed = parseRuntimeValidationForm(form);
  if ("error" in parsed) return { status: "invalid", message: parsed.error };
  const next = { ...repo.settings };
  if (parsed.config) next.runtimeValidation = parsed.config;
  else delete next.runtimeValidation;
  await updateRepoSettings(db, ctx.orgId, repo.id, next);
  return { status: parsed.config ? "saved" : "cleared" };
}
