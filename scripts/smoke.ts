import { loadEnvFile } from "node:process";
import { ConvexHttpClient } from "convex/browser";
import { SignJWT } from "jose";
import { api } from "../convex/_generated/api";
loadEnvFile(".env.local");
// Browserless smoke test: signs in a local fixture user and checks that every dashboard route
// server-renders without error markup. Local backends and localhost web servers only.
const base = process.env.SMOKE_URL ?? "http://127.0.0.1:3000";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base)) throw new Error("Smoke tests only run against localhost");
const backend = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
if (!/^http:\/\/127\.0\.0\.1/.test(process.env.NEXT_PUBLIC_CONVEX_URL!)) throw new Error("refusing: not a local backend");
const id = await backend.mutation(api.users.login, { secret: process.env.SERVICE_SECRET!, githubId: -4242, login: "smoke-fixture", avatar: "" });
const token = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(id).setIssuer("openreview").setAudience("openreview").setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(process.env.SESSION_SECRET!));
let me = await backend.query(api.users.me, { token });
if (!me.organizations.length) await backend.mutation(api.users.createOrganization, { token, name: "Smoke workspace" });
me = await backend.query(api.users.me, { token });
const org = me.organizations[0]._id!;
await backend.mutation(api.repositories.connect, { token, secret: process.env.SERVICE_SECRET!, organizationId: org, installationId: -4242, account: "smoke", accountId: -4242, repositories: [{ id: -4242, fullName: "smoke/repo", defaultBranch: "main" }] });
// Guided-setup steps after "connect" render only once repositories are selected and indexing has started.
const [smokeRepo] = await backend.query(api.repositories.list, { token, organizationId: org });
await backend.mutation(api.onboarding.select, { token, organizationId: org, repositoryIds: [smokeRepo._id] });
await backend.mutation(api.onboarding.start, { token, organizationId: org, pauseReviews: true });
// The plan step exists only when the backend bills workspaces; otherwise it redirects to "done".
const billing = (await backend.query(api.billing.status, { token, organizationId: org })).enabled;
const routes = [...["connect", "indexing", "summary", "comments", "triggers", "tools", "team", ...(billing ? ["plan"] : []), "done"].map((step) => `/dashboard/onboarding/${step}`), "/dashboard/analytics", "/dashboard/chat", "/dashboard/settings/repositories", "/dashboard/pulls", "/dashboard/pulls/findings", "/dashboard/memory/rules", "/dashboard/memory/knowledge", "/dashboard/memory/preferences", "/dashboard/memory/integrations", "/dashboard/memory/clusters", "/dashboard/settings/people", "/dashboard/settings/usage", "/dashboard/settings/review", "/dashboard/settings/keys", "/dashboard/settings/audit", "/dashboard/settings/account", "/dashboard/settings/billing", "/dashboard/settings/notifications", "/dashboard/settings/teams", "/dashboard/settings/agents", "/dashboard/settings/providers", "/dashboard/settings/automation", "/dashboard/settings/nope", "/invite?token=bad", "/", "/docs/quickstart"];
let failures = 0;
for (const route of routes) {
  const response = await fetch(base + route, { headers: { cookie: `openreview_session=${token}` }, redirect: "manual" });
  const html = response.status === 200 ? await response.text() : "";
  // loading.tsx streams a skeleton first; the page's own content (and any error boundary) follows.
  const broken = /Application error|Internal Server Error|__next_error__|NEXT_REDIRECT|Unable to load this workspace|This page couldn.t load/.test(html);
  const headings = [...html.matchAll(/<h1[^>]*>([^<]{1,60})/g)].map((m) => m[1]).filter((h) => h !== "Loading…");
  const heading = headings.at(-1) ?? "(no heading)";
  const expected = route === "/dashboard/settings/nope" ? /Not found/ : null;
  if (response.status >= 500 || broken || (expected && !expected.test(html))) failures++;
  console.log(`${String(response.status).padEnd(4)} ${route.padEnd(36)} ${broken ? "ERROR-MARKUP " : ""}${heading}`);
}
console.log(failures ? `FAILURES ${failures}` : "all routes rendered");
if (failures) process.exitCode = 1;
