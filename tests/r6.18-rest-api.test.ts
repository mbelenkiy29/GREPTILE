import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { API_SCOPES, revokeApiKey, type ApiScope } from "@/lib/api/keys";
import { MemoryRateLimiter } from "@/lib/api/rate-limit";
import { routeId } from "@/lib/api/router";
import { openApiDocument } from "@/lib/api/openapi";
import { V1_ROUTES } from "@/lib/api/v1";
import { listAudit } from "@/lib/data/audit";
import { createRule } from "@/lib/data/rules";
import { findingFeedback, findings, indexJobs, reviewRuns, rules } from "@/lib/db/schema";
import { addMember, makeUser, signedInCookie } from "./helpers/auth";
import { API_ORIGIN, apiDeps, call, json, makeKey } from "./helpers/api";
import { dashboardFixture } from "./helpers/dashboard";

const NOW = new Date("2026-03-01T12:00:00Z");
const ALL = [...API_SCOPES];

async function fixture() {
  const fx = await dashboardFixture(NOW);
  const deps = apiDeps(fx.db);
  const [globexFinding] = await fx.db.select().from(findings).where(eq(findings.orgId, "org_b"));
  const globexRule = await createRule(fx.db, "org_b", { text: "Globex rule text", source: "dashboard" });
  return { ...fx, deps, globexFinding: globexFinding!, globexRule };
}

type ErrorBody = { error: { code: string; message: string } };

describe("REST API v1 (R6.18)", () => {
  test("R6.18 GET /me reports the key, its org, and its scopes; missing, unknown, revoked, and expired keys get 401", async () => {
    const { db, deps } = await fixture();
    const { token, key } = await makeKey(db, "org_a", ["repos:read", "reviews:read"]);
    const res = await call(deps, "GET /me", { token });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await json(res)).toEqual({
      organization: { id: "org_a", name: "Acme", slug: expect.any(String) },
      scopes: ["repos:read", "reviews:read"],
      apiKey: { id: key.id, name: key.name, prefix: key.prefix },
      user: null,
    });

    const anonymous = await call(deps, "GET /me");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("Bearer");
    expect(await json<ErrorBody>(anonymous)).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
    expect((await call(deps, "GET /me", { headers: { authorization: "Basic abc" } })).status).toBe(401);
    expect((await call(deps, "GET /me", { token: "or_live_" + "Z".repeat(43) })).status).toBe(401);
    expect((await call(deps, "GET /me", { token: "ghp_notours" })).status).toBe(401);

    await revokeApiKey(db, "org_a", key.id, NOW);
    const revoked = await call(deps, "GET /me", { token });
    expect(revoked.status).toBe(401);
    expect((await json<ErrorBody>(revoked)).error.message).toMatch(/revoked/);

    const expiring = await makeKey(db, "org_a", ["repos:read"], { expiresInDays: 1, now: new Date(NOW.getTime() - 2 * 86_400_000) });
    const expired = await call(deps, "GET /me", { token: expiring.token });
    expect(expired.status).toBe(401);
    expect((await json<ErrorBody>(expired)).error.message).toMatch(/expired/);
  });

  test("R6.18 repositories: paginated list, detail with effective settings and index status, and re-index", async () => {
    const { db, deps, repos } = await fixture();
    const { token, key } = await makeKey(db, "org_a", ["repos:read", "repos:write"]);

    const list = await json<{ data: { fullName: string }[]; pagination: Record<string, unknown> }>(await call(deps, "GET /repositories?pageSize=2", { token }));
    expect(list.data.map((r) => r.fullName)).toEqual(["acme/api", "acme/old"]);
    expect(list.pagination).toEqual({ page: 1, pageSize: 2, total: 3, pageCount: 2, hasMore: true });
    const filtered = await json<{ data: { fullName: string }[] }>(await call(deps, "GET /repositories?q=web", { token }));
    expect(filtered.data.map((r) => r.fullName)).toEqual(["acme/web"]);

    const detail = await json<{ repository: Record<string, unknown> }>(await call(deps, `GET /repositories/${repos.api.id}`, { token }));
    expect(detail.repository).toMatchObject({
      id: repos.api.id,
      fullName: "acme/api",
      indexStatus: "ready",
      reviewMode: "deep",
      settings: { repository: { mode: "deep" }, effective: { mode: "deep" }, sources: { mode: "repo" } },
      index: { indexStatus: "ready", fileCount: 120, languages: { TypeScript: 100, SQL: 20 } },
    });

    const queued = await call(deps, `POST /repositories/${repos.api.id}/reindex`, { token, body: { mode: "full" } });
    expect(queued.status).toBe(202);
    const { indexJob } = await json<{ indexJob: { id: number; kind: string; status: string; trigger: string } }>(queued);
    expect(indexJob).toMatchObject({ kind: "full", status: "queued", trigger: "api" });
    expect(deps.queue.jobs).toEqual([
      expect.objectContaining({
        name: "index-repo",
        jobId: `index-${repos.api.id}-api-${indexJob.id}`,
        data: expect.objectContaining({ orgId: "org_a", repoId: repos.api.id, mode: "full", trigger: "api", indexJobId: indexJob.id, meta: { requestedBy: `api_key:${key.id}` } }),
      }),
    ]);
    const [row] = await db.select().from(indexJobs).where(eq(indexJobs.id, indexJob.id));
    expect(row).toMatchObject({ orgId: "org_a", trigger: "api", kind: "full" });
    // Default mode is incremental.
    expect((await json<{ indexJob: { kind: string } }>(await call(deps, `POST /repositories/${repos.web.id}/reindex`, { token, body: {} }))).indexJob.kind).toBe("incremental");

    const bad = await call(deps, `POST /repositories/${repos.api.id}/reindex`, { token, body: { mode: "everything" } });
    expect(bad.status).toBe(400);
    expect((await json<ErrorBody>(bad)).error.code).toBe("validation_error");
    expect((await call(deps, "GET /repositories/abc", { token })).status).toBe(400);
    expect((await call(deps, "GET /repositories?pageSize=500", { token })).status).toBe(400);
    expect((await call(deps, "GET /repositories?unknown=1", { token })).status).toBe(400);
    expect((await call(deps, "GET /repositories/999999", { token })).status).toBe(404);
  });

  test("R6.18 reviews: filtered list, detail with runs, summary, and findings, API-triggered review (audited), and cancel", async () => {
    const { db, deps, repos, reviews } = await fixture();
    const { token, key } = await makeKey(db, "org_a", ["reviews:read", "reviews:write"]);

    const all = await json<{ data: { id: number }[]; pagination: { total: number } }>(await call(deps, "GET /reviews", { token }));
    expect(all.pagination.total).toBe(3);
    const failed = await json<{ data: { id: number; status: string }[] }>(await call(deps, `GET /reviews?status=failed&repositoryId=${repos.api.id}`, { token }));
    expect(failed.data.map((r) => r.id)).toEqual([reviews.r2.review.id]);
    expect((await call(deps, "GET /reviews?status=bogus", { token })).status).toBe(400);

    const detail = await json<{ review: Record<string, unknown> & { runHistory: unknown[]; findings: { items: { id: number }[] } } }>(
      await call(deps, `GET /reviews/${reviews.r1.review.id}`, { token }),
    );
    expect(detail.review).toMatchObject({ id: reviews.r1.review.id, repoFullName: "acme/api", prNumber: 1, status: "completed" });
    expect(detail.review.runHistory).toEqual([expect.objectContaining({ id: reviews.r1.run.id, status: "completed", summary: expect.objectContaining({ overview: "Adds **billing**." }) })]);
    expect(detail.review.findings.items.length).toBe(2);

    const created = await call(deps, "POST /reviews", { token, body: { repositoryId: repos.api.id, prNumber: 42, mode: "fast", focus: "security" } });
    expect(created.status).toBe(202);
    const { run } = await json<{ run: { id: number; reviewId: number; status: string; trigger: string; requestedBy: string } }>(created);
    expect(run).toMatchObject({ status: "queued", trigger: "api", requestedBy: `api_key:${key.id}` });
    const [runRow] = await db.select().from(reviewRuns).where(eq(reviewRuns.id, run.id));
    expect(runRow).toMatchObject({ orgId: "org_a", repoId: repos.api.id, prNumber: 42, trigger: "api", mode: "fast", focus: "security", requestedBy: `api_key:${key.id}` });
    expect(deps.queue.jobs.at(-1)).toMatchObject({ name: "review-pr", data: { runId: run.id, trigger: "api", meta: { requestedBy: `api_key:${key.id}` } } });
    const [audit] = await listAudit(db, "org_a", { action: "review.requested" });
    expect(audit).toMatchObject({ actorType: "api_key", actorId: String(key.id), targetType: "review", targetId: String(run.reviewId) });
    expect(audit!.metadata).toMatchObject({ runId: run.id, prNumber: 42, mode: "fast" });

    expect((await call(deps, "POST /reviews", { token, body: { repositoryId: repos.api.id } })).status).toBe(400);
    expect((await call(deps, "POST /reviews", { token, body: { repositoryId: repos.api.id, prNumber: 1, mode: "turbo" } })).status).toBe(400);
    expect((await call(deps, "POST /reviews", { token, rawBody: "{not json", headers: { "content-type": "application/json" } })).status).toBe(400);
    const archived = await call(deps, "POST /reviews", { token, body: { repositoryId: repos.old.id, prNumber: 1 } });
    expect(archived.status).toBe(409);
    expect((await json<ErrorBody>(archived)).error.code).toBe("conflict");

    const cancelled = await call(deps, `POST /reviews/runs/${run.id}/cancel`, { token });
    expect(cancelled.status).toBe(200);
    expect(await json(cancelled)).toEqual({ runId: run.id, status: "cancelled" });
    expect((await call(deps, `POST /reviews/runs/${run.id}/cancel`, { token })).status).toBe(409);
    const running = await json(await call(deps, `POST /reviews/runs/${reviews.r3.run.id}/cancel`, { token }));
    expect(running).toEqual({ runId: reviews.r3.run.id, status: "cancel_requested" });
    expect((await call(deps, "POST /reviews/runs/999999/cancel", { token })).status).toBe(404);
  });

  test("R6.18 findings: search with filters, detail with feedback counts, and feedback from an API key", async () => {
    const { db, deps, reviews, findings: f } = await fixture();
    const { token, key } = await makeKey(db, "org_a", ["findings:read", "findings:write"]);

    const all = await json<{ data: { id: number }[] }>(await call(deps, "GET /findings", { token }));
    expect(all.data.map((x) => x.id).sort()).toEqual([f.fCritical.id, f.fLow.id, f.fFalse.id].sort()); // published only
    const crit = await json<{ data: { id: number }[] }>(await call(deps, "GET /findings?severity=critical,high&status=open", { token }));
    expect(crit.data.map((x) => x.id)).toEqual([f.fCritical.id]);
    const byReview = await json<{ data: { id: number }[] }>(await call(deps, `GET /findings?reviewId=${reviews.r2.review.id}`, { token }));
    expect(byReview.data.map((x) => x.id)).toEqual([f.fFalse.id]);
    const repeated = await json<{ data: { id: number }[] }>(await call(deps, "GET /findings?category=security&category=testing", { token }));
    expect(repeated.data.map((x) => x.id)).toEqual([f.fCritical.id]);
    const badFilter = await call(deps, "GET /findings?severity=urgent", { token });
    expect(badFilter.status).toBe(400);
    expect((await json<ErrorBody>(badFilter)).error.message).toContain("query.severity");

    const detail = await json<{ finding: Record<string, unknown> }>(await call(deps, `GET /findings/${f.fCritical.id}`, { token }));
    expect(detail.finding).toMatchObject({ id: f.fCritical.id, repoFullName: "acme/api", severity: "critical", feedback: { useful: 1 } });
    expect((await call(deps, `GET /findings/${f.fRejected.id}`, { token })).status).toBe(404); // rejected candidates are not exposed

    const first = await call(deps, `POST /findings/${f.fCritical.id}/feedback`, { token, body: { kind: "useful", note: "good catch" } });
    expect(first.status).toBe(201);
    expect(await json(first)).toMatchObject({ duplicate: false, counts: { useful: 2 } });
    const again = await call(deps, `POST /findings/${f.fCritical.id}/feedback`, { token, body: { kind: "useful" } });
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ duplicate: true, counts: { useful: 2 } });
    const wontFix = await json(await call(deps, `POST /findings/${f.fCritical.id}/feedback`, { token, body: { kind: "wont_fix" } }));
    expect(wontFix).toMatchObject({ finding: { status: "wont_fix", resolution: "user" } });
    const rows = await db.select().from(findingFeedback).where(and(eq(findingFeedback.findingId, f.fCritical.id), eq(findingFeedback.source, "api")));
    expect(rows.map((r) => [r.kind, r.externalAuthor, r.userId])).toEqual([
      ["useful", `api_key:${key.id}`, null],
      ["wont_fix", `api_key:${key.id}`, null],
    ]);
    expect((await call(deps, `POST /findings/${f.fCritical.id}/feedback`, { token, body: { kind: "love_it" } })).status).toBe(400);
    expect((await call(deps, `POST /findings/${f.fRejected.id}/feedback`, { token, body: { kind: "useful" } })).status).toBe(404);
  });

  test("R6.18 rules: list, create, edit, and delete with validation", async () => {
    const { db, deps, repos } = await fixture();
    const { token, key } = await makeKey(db, "org_a", ["rules:read", "rules:write"]);

    const created = await call(deps, "POST /rules", { token, body: { text: "Use parameterized SQL everywhere", repositoryId: repos.api.id, paths: ["src/**/*.ts"] } });
    expect(created.status).toBe(201);
    const { rule } = await json<{ rule: { id: number; text: string; repoId: number; paths: string[]; source: string; createdBy: string } }>(created);
    expect(rule).toMatchObject({ text: "Use parameterized SQL everywhere", repoId: repos.api.id, paths: ["src/**/*.ts"], source: "api", createdBy: `api_key:${key.id}` });

    const list = await json<{ data: { id: number; repoFullName: string | null }[] }>(await call(deps, "GET /rules", { token }));
    expect(list.data).toEqual([expect.objectContaining({ id: rule.id, repoFullName: "acme/api" })]);
    expect((await json<{ data: unknown[] }>(await call(deps, "GET /rules?status=candidate", { token }))).data).toEqual([]);

    const patched = await call(deps, `PATCH /rules/${rule.id}`, { token, body: { text: "Always use parameterized SQL", status: "rejected", repositoryId: null } });
    expect(patched.status).toBe(200);
    expect((await json<{ rule: Record<string, unknown> }>(patched)).rule).toMatchObject({ text: "Always use parameterized SQL", status: "rejected", repoId: null });
    expect((await call(deps, `PATCH /rules/${rule.id}`, { token, body: {} })).status).toBe(400);
    expect((await call(deps, "POST /rules", { token, body: { text: "tiny" } })).status).toBe(400);
    expect((await call(deps, "POST /rules", { token, body: { text: "A valid rule text", extra: true } })).status).toBe(400);

    expect((await call(deps, `DELETE /rules/${rule.id}`, { token })).status).toBe(204);
    expect((await call(deps, `DELETE /rules/${rule.id}`, { token })).status).toBe(404);
    expect(await db.select().from(rules).where(eq(rules.orgId, "org_a"))).toEqual([]);
    const actions = (await listAudit(db, "org_a")).map((a) => a.action).sort();
    expect(actions).toEqual(["rule.created", "rule.deleted", "rule.updated"]);
  });

  test("R6.18 every route checks its scope: a key without it gets 403 insufficient_scope, a key with only it gets through", async () => {
    const { db, deps, repos, reviews, findings: f } = await fixture();
    const ruleFor = async () => (await createRule(db, "org_a", { text: "Scoped rule text" })).id;
    const samples: Record<string, () => Promise<{ request: string; body?: unknown }>> = {
      "GET /repositories": async () => ({ request: "GET /repositories" }),
      "GET /repositories/{id}": async () => ({ request: `GET /repositories/${repos.api.id}` }),
      "POST /repositories/{id}/reindex": async () => ({ request: `POST /repositories/${repos.api.id}/reindex`, body: {} }),
      "GET /repositories/{id}/search": async () => ({ request: `GET /repositories/${repos.api.id}/search?q=invoice` }),
      "GET /repositories/{id}/related": async () => ({ request: `GET /repositories/${repos.api.id}/related?path=src/search.ts` }),
      "GET /repositories/{id}/knowledge": async () => ({ request: `GET /repositories/${repos.api.id}/knowledge` }),
      "GET /reviews": async () => ({ request: "GET /reviews" }),
      "POST /reviews": async () => ({ request: "POST /reviews", body: { repositoryId: repos.api.id, prNumber: 77 } }),
      "GET /reviews/{id}": async () => ({ request: `GET /reviews/${reviews.r1.review.id}` }),
      "POST /reviews/runs/{runId}/cancel": async () => ({ request: `POST /reviews/runs/${reviews.r3.run.id}/cancel` }),
      "GET /reviews/{id}/fix-all": async () => ({ request: `GET /reviews/${reviews.r1.review.id}/fix-all` }),
      "GET /findings": async () => ({ request: "GET /findings" }),
      "GET /findings/{id}": async () => ({ request: `GET /findings/${f.fCritical.id}` }),
      "POST /findings/{id}/feedback": async () => ({ request: `POST /findings/${f.fCritical.id}/feedback`, body: { kind: "useful" } }),
      "GET /findings/{id}/fix-prompt": async () => ({ request: `GET /findings/${f.fCritical.id}/fix-prompt` }),
      "GET /rules": async () => ({ request: "GET /rules" }),
      "POST /rules": async () => ({ request: "POST /rules", body: { text: "A brand new rule" } }),
      "PATCH /rules/{id}": async () => ({ request: `PATCH /rules/${await ruleFor()}`, body: { text: "An edited rule text" } }),
      "DELETE /rules/{id}": async () => ({ request: `DELETE /rules/${await ruleFor()}` }),
    };
    const scoped = V1_ROUTES.filter((r) => r.scope !== null);
    expect(scoped.map(routeId).sort()).toEqual(Object.keys(samples).sort());
    for (const route of scoped) {
      const scope = route.scope as ApiScope;
      const without = await makeKey(db, "org_a", ALL.filter((s) => s !== scope));
      const denied = await call(deps, (await samples[routeId(route)]!()).request, { token: without.token, body: (await samples[routeId(route)]!()).body });
      expect(denied.status, routeId(route)).toBe(403);
      expect((await json<ErrorBody>(denied)).error, routeId(route)).toEqual({ code: "insufficient_scope", message: `This API key lacks the ${scope} scope.` });
      const only = await makeKey(db, "org_a", [scope]);
      const sample = await samples[routeId(route)]!();
      const allowed = await call(deps, sample.request, { token: only.token, body: sample.body });
      expect(allowed.status, routeId(route)).toBeLessThan(300);
    }
    // /me needs no particular scope.
    expect((await call(deps, "GET /me", { token: (await makeKey(db, "org_a", ["knowledge:read"])).token })).status).toBe(200);
  });

  test("R6.18 tenant isolation: org A's key gets 404 for every org B id and never sees org B rows in lists", async () => {
    const { db, deps, repos, reviews, globexFinding, globexRule } = await fixture();
    const { token } = await makeKey(db, "org_a", ALL);
    const foreign: [string, unknown?][] = [
      [`GET /repositories/${repos.core.id}`],
      [`POST /repositories/${repos.core.id}/reindex`, {}],
      [`GET /repositories/${repos.core.id}/search?q=secret`],
      [`GET /repositories/${repos.core.id}/related?symbol=main`],
      [`GET /repositories/${repos.core.id}/knowledge`],
      [`GET /reviews/${reviews.rb.review.id}`],
      [`GET /reviews/${reviews.rb.review.id}/fix-all`],
      [`POST /reviews/runs/${reviews.rb.run.id}/cancel`],
      [`GET /findings/${globexFinding.id}`],
      [`GET /findings/${globexFinding.id}/fix-prompt`],
      [`POST /findings/${globexFinding.id}/feedback`, { kind: "not_useful" }],
      [`PATCH /rules/${globexRule.id}`, { text: "Hijacked rule text" }],
      [`DELETE /rules/${globexRule.id}`],
      ["POST /reviews", { repositoryId: repos.core.id, prNumber: 9 }],
      ["POST /rules", { text: "Rule for their repo", repositoryId: repos.core.id }],
    ];
    for (const [request, body] of foreign) {
      const res = await call(deps, request, { token, body });
      expect(res.status, request).toBe(404);
      expect((await json<ErrorBody>(res)).error.code, request).toBe("not_found");
    }
    const lists = ["GET /repositories", "GET /reviews", "GET /findings", "GET /rules"];
    for (const request of lists) {
      const body = JSON.stringify(await json(await call(deps, request, { token })));
      expect(body, request).not.toMatch(/globex|Globex/);
    }
    for (const request of [`GET /reviews?repositoryId=${repos.core.id}`, `GET /findings?repositoryId=${repos.core.id}`, `GET /findings?reviewId=${reviews.rb.review.id}`]) {
      expect((await json<{ data: unknown[] }>(await call(deps, request, { token }))).data, request).toEqual([]);
    }
    // Nothing of org B changed.
    const [rule] = await db.select().from(rules).where(eq(rules.id, globexRule.id));
    expect(rule!.text).toBe("Globex rule text");
    expect(deps.queue.jobs).toEqual([]);
    expect(await db.select().from(findingFeedback).where(eq(findingFeedback.findingId, globexFinding.id))).toEqual([]);
  });

  test("R6.18 rate limiting: over the per-minute limit the API answers 429 with retry-after, per key", async () => {
    const { db } = await fixture();
    let now = new Date("2026-03-01T12:00:45Z");
    const deps = apiDeps(db, { rateLimitPerMinute: 3, limiter: new MemoryRateLimiter(), now: () => now });
    const a = await makeKey(db, "org_a", ["repos:read"]);
    const b = await makeKey(db, "org_a", ["repos:read"]);
    for (let i = 0; i < 3; i++) {
      const ok = await call(deps, "GET /repositories", { token: a.token });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("x-ratelimit-remaining")).toBe(String(2 - i));
    }
    const limited = await call(deps, "GET /repositories", { token: a.token });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("15");
    expect(limited.headers.get("x-ratelimit-limit")).toBe("3");
    expect(await json<ErrorBody>(limited)).toEqual({ error: { code: "rate_limited", message: expect.stringContaining("3 requests per minute") } });
    // Another key has its own window; the next window starts fresh.
    expect((await call(deps, "GET /repositories", { token: b.token })).status).toBe(200);
    now = new Date("2026-03-01T12:01:00Z");
    expect((await call(deps, "GET /repositories", { token: a.token })).status).toBe(200);
  });

  test("R6.18 session-cookie access: same-origin dashboard calls work, cross-origin mutations are refused (CSRF), and roles limit writes", async () => {
    const { db, deps, repos, findings: f } = await fixture();
    const admin = await makeUser(db, "ada");
    const member = await makeUser(db, "mel");
    await addMember(db, "org_a", admin.id, "admin");
    await addMember(db, "org_a", member.id, "member");
    const adminCookie = (await signedInCookie(db, admin.id, "org_a", NOW)).cookie;
    const memberCookie = (await signedInCookie(db, member.id, "org_a", NOW)).cookie;

    const me = await json<{ user: { id: string; role: string }; scopes: string[]; apiKey: null }>(await call(deps, "GET /me", { cookie: memberCookie }));
    expect(me.user).toMatchObject({ id: member.id, role: "member" });
    expect(me.apiKey).toBeNull();
    expect(me.scopes).toEqual(["repos:read", "reviews:read", "reviews:write", "findings:read", "findings:write", "rules:read", "knowledge:read"]);
    // Reads need no Origin header.
    expect((await call(deps, `GET /findings/${f.fCritical.id}`, { cookie: memberCookie })).status).toBe(200);

    // Mutations: refused without a same-origin Origin, allowed with it.
    for (const origin of [null, "https://evil.example"]) {
      const res = await call(deps, `POST /findings/${f.fCritical.id}/feedback`, { cookie: memberCookie, origin, body: { kind: "useful" } });
      expect(res.status).toBe(403);
      expect((await json<ErrorBody>(res)).error.code).toBe("csrf_failed");
    }
    const crossSite = await call(deps, `POST /findings/${f.fCritical.id}/feedback`, { cookie: memberCookie, headers: { "sec-fetch-site": "cross-site" }, body: { kind: "useful" } });
    expect(crossSite.status).toBe(403);
    const ok = await call(deps, `POST /findings/${f.fCritical.id}/feedback`, { cookie: memberCookie, origin: API_ORIGIN, body: { kind: "useful" } });
    expect(ok.status).toBe(201);
    const [fb] = await db.select().from(findingFeedback).where(and(eq(findingFeedback.findingId, f.fCritical.id), eq(findingFeedback.userId, member.id)));
    expect(fb).toMatchObject({ source: "api", kind: "useful" });

    // A member cannot manage rules or re-index; an admin can.
    const memberRule = await call(deps, "POST /rules", { cookie: memberCookie, origin: API_ORIGIN, body: { text: "Members cannot add this" } });
    expect(memberRule.status).toBe(403);
    expect((await json<ErrorBody>(memberRule)).error.code).toBe("insufficient_scope");
    expect((await call(deps, `POST /repositories/${repos.api.id}/reindex`, { cookie: memberCookie, origin: API_ORIGIN, body: {} })).status).toBe(403);
    expect((await call(deps, "POST /rules", { cookie: adminCookie, origin: API_ORIGIN, body: { text: "Admins can add this" } })).status).toBe(201);
    const review = await call(deps, "POST /reviews", { cookie: memberCookie, origin: API_ORIGIN, body: { repositoryId: repos.api.id, prNumber: 5 } });
    expect(review.status).toBe(202);
    const [audit] = await listAudit(db, "org_a", { action: "review.requested" });
    expect(audit).toMatchObject({ actorType: "user", actorId: member.id });

    // A user with no membership in the session's org is refused.
    const outsider = await makeUser(db, "out");
    const outsiderCookie = (await signedInCookie(db, outsider.id, "org_a", NOW)).cookie;
    expect((await call(deps, "GET /me", { cookie: outsiderCookie })).status).toBe(403);
    // A bearer key takes precedence over a cookie and needs no Origin.
    const { token } = await makeKey(db, "org_a", ["rules:write"]);
    expect((await call(deps, "POST /rules", { token, cookie: memberCookie, body: { text: "Key-created rule" } })).status).toBe(201);
  });

  test("R6.18 the OpenAPI document lists every route with its scope and schemas, and the route files match the route table", async () => {
    const { deps } = await fixture();
    const res = await call(deps, "GET /openapi.json");
    expect(res.status).toBe(200);
    const doc = await json<{ openapi: string; servers: { url: string }[]; paths: Record<string, Record<string, Record<string, unknown>>> }>(res);
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers).toEqual([{ url: `${API_ORIGIN}/api/v1` }]);
    const documented = Object.entries(doc.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`));
    expect(documented.sort()).toEqual(V1_ROUTES.map(routeId).sort());
    expect(doc.paths["/reviews"]!.post).toMatchObject({
      "x-required-scope": "reviews:write",
      requestBody: { content: { "application/json": { schema: { properties: { repositoryId: expect.any(Object), prNumber: expect.any(Object), mode: { enum: ["fast", "standard", "deep"] } } } } } },
    });
    expect(doc.paths["/findings"]!.get!.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: "severity", in: "query" })]));
    expect(doc.paths["/findings/{id}"]!.get!.parameters).toEqual([expect.objectContaining({ name: "id", in: "path", required: true })]);
    expect(openApiDocument("https://x.example/").servers).toEqual([{ url: "https://x.example/api/v1" }]);

    // Every app/api/v1 route file binds routes of the table, at the matching path; together they cover the table.
    const root = path.resolve(import.meta.dirname, "../app/api/v1");
    const bound: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name === "route.ts") {
          const urlPath = "/" + path.relative(root, dir).split(path.sep).map((s) => s.replace(/^\[(\w+)\]$/, "{$1}")).join("/");
          for (const m of readFileSync(full, "utf8").matchAll(/export const (GET|POST|PATCH|DELETE) = v1\("(\w+) ([^"]+)"\)/g)) {
            expect(m[1]).toBe(m[2]);
            expect(m[3]).toBe(urlPath);
            bound.push(`${m[2]} ${m[3]}`);
          }
        }
      }
    };
    walk(root);
    expect(bound.sort()).toEqual(V1_ROUTES.map(routeId).sort());
  });
});
