import { z } from "zod";
import { egressAllowed } from "./egress";
import type { DependencyChange } from "./dependency-changes";
import type { Candidate } from "./engine/types";

// OSV.dev advisory lookups for changed dependency versions: one batched query (/v1/querybatch),
// then details for each distinct advisory (/v1/vulns/{id}). Failures throw; callers degrade with a note.
export const osvBase = "https://api.osv.dev";
// Outbound advisory lookups; self-hosted installs turn them off with OSV_ENABLED=false (or point
// OSV_API_URL at a mirror).
export const osvEnabled = (env: Record<string, string | undefined> = process.env) => env.OSV_ENABLED !== "false" && egressAllowed("advisories", env);
const vulnId = z.string().regex(/^[A-Za-z0-9:._-]{3,100}$/);
const batchSchema = z.object({ results: z.array(z.object({ vulns: z.array(z.object({ id: vulnId })).optional(), next_page_token: z.string().optional() }).passthrough()) });
const severity = z.object({ severity: z.string().optional() }).passthrough().optional();
export const osvVulnSchema = z.object({
  id: vulnId,
  summary: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  database_specific: severity,
  affected: z.array(z.object({
    package: z.object({ ecosystem: z.string(), name: z.string() }).optional(),
    ranges: z.array(z.object({ events: z.array(z.record(z.string())) })).optional(),
    ecosystem_specific: severity,
    database_specific: severity,
  })).optional(),
}).passthrough();
export type OsvVuln = z.infer<typeof osvVulnSchema>;
export type AdvisoryLookup = (changes: DependencyChange[], signal?: AbortSignal) => Promise<{ advisories: Map<string, OsvVuln[]>; truncated: boolean }>;
export const changeKey = (c: Pick<DependencyChange, "ecosystem" | "name" | "version">) => `${c.ecosystem}\u0000${c.name}\u0000${c.version}`;

export function osvClient(options: { fetch?: typeof fetch; base?: string; batchSize?: number; maxDetails?: number; timeoutMs?: number } = {}): AdvisoryLookup {
  const get = options.fetch ?? fetch, base = options.base ?? osvBase, batchSize = options.batchSize ?? 500, maxDetails = options.maxDetails ?? 50;
  const request = async (path: string, init: RequestInit, signal?: AbortSignal) => {
    const response = await get(base + path, { ...init, signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 15_000), ...(signal ? [signal] : [])]) });
    if (!response.ok) throw new Error(`OSV returned HTTP ${response.status}`);
    return response.json();
  };
  return async (changes, signal) => {
    const ids = new Map<string, string[]>();
    let truncated = false;
    for (let i = 0; i < changes.length; i += batchSize) {
      const chunk = changes.slice(i, i + batchSize);
      const body = { queries: chunk.map((c) => ({ package: { name: c.name, ecosystem: c.ecosystem }, version: c.version })) };
      const parsed = batchSchema.parse(await request("/v1/querybatch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, signal));
      if (parsed.results.length !== chunk.length) throw new Error("OSV returned a different number of results than queries");
      parsed.results.forEach((r, j) => { if (r.next_page_token) truncated = true; if (r.vulns?.length) ids.set(changeKey(chunk[j]), r.vulns.map((v) => v.id)); });
    }
    const distinct = [...new Set([...ids.values()].flat())];
    if (distinct.length > maxDetails) truncated = true;
    const details = new Map<string, OsvVuln>();
    for (const id of distinct.slice(0, maxDetails)) details.set(id, osvVulnSchema.parse(await request(`/v1/vulns/${encodeURIComponent(id)}`, { method: "GET" }, signal)));
    const advisories = new Map<string, OsvVuln[]>();
    for (const [key, list] of ids) { const known = list.flatMap((id) => details.get(id) ?? []); if (known.length) advisories.set(key, known); }
    return { advisories, truncated };
  };
}

const levels: Record<string, Candidate["severity"]> = { CRITICAL: "critical", HIGH: "high", MODERATE: "medium", MEDIUM: "medium", LOW: "low" };
const order = ["critical", "high", "medium", "low"] as const;
export function advisorySeverity(v: OsvVuln, c: DependencyChange): Candidate["severity"] {
  const affected = v.affected?.filter((a) => a.package?.name === c.name);
  const label = v.database_specific?.severity ?? affected?.map((a) => a.ecosystem_specific?.severity ?? a.database_specific?.severity).find(Boolean);
  return levels[String(label ?? "").toUpperCase()] ?? "medium";
}
export function fixedVersions(v: OsvVuln, c: DependencyChange) {
  return [...new Set((v.affected ?? []).filter((a) => !a.package || a.package.name === c.name).flatMap((a) => (a.ranges ?? []).flatMap((r) => r.events.flatMap((e) => (e.fixed ? [e.fixed] : [])))))].filter((f) => /^[\w.+-]{1,60}$/.test(f));
}
// Third-party advisory text is untrusted: one plain line, no links, markup or mentions.
const plain = (text: string, limit = 300) => { const t = text.replace(/\s+/g, " ").replace(/https?:\/\/\S+/g, "[link removed]").replace(/[`<>[\]*_|]/g, "").replace(/@(?=[\w-])/g, "@​").trim(); return t.length > limit ? t.slice(0, limit - 1) + "…" : t; };
export function advisoryFinding(c: DependencyChange, vulns: OsvVuln[]): Candidate {
  const severity = order.find((s) => vulns.some((v) => advisorySeverity(v, c) === s)) ?? "medium";
  const ids = vulns.map((v) => v.id), shown = ids.slice(0, 3).join(", ") + (ids.length > 3 ? ` and ${ids.length - 3} more` : "");
  const fixed = [...new Set(vulns.flatMap((v) => fixedVersions(v, c)))].slice(0, 3);
  const summary = vulns.map((v) => v.summary).find(Boolean);
  return {
    title: `${c.name} ${c.version} has ${ids.length === 1 ? "a known vulnerability" : ids.length + " known vulnerabilities"} (${shown})`.slice(0, 200),
    description: `${summary ? plain(summary) + " " : ""}This change adds ${c.ecosystem} package ${c.name} at version ${c.version}, which OSV lists as affected. Advisories: ${ids.slice(0, 5).map((id) => `https://osv.dev/vulnerability/${id}`).join(", ")}.`,
    severity, confidence: 0.99, category: "security",
    filePath: c.path, startLine: c.line, endLine: c.line, evidence: [{ filePath: c.path, startLine: c.line, quote: c.quote }],
    impact: `Code that installs ${c.name} ${c.version} is exposed to ${shown}.`,
    suggestedFix: fixed.length ? `Upgrade ${c.name} to a fixed version (${fixed.join(", ")}) or later.` : `No fixed version is published for ${shown}; remove or replace ${c.name}, or apply the advisory's mitigation.`,
    symbol: c.name,
  };
}
