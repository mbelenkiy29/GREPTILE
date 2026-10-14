import { test } from "node:test";
import assert from "node:assert/strict";
import { AzureDevOps, azureThreadStatus } from "../src/azure-devops";
import { summaryMarker } from "../src/github";
import type { Finding } from "../src/engine/types";

const base = "https://dev.azure.com/fabrikam", repoId = "3411ebc1-d5aa-464f-9615-0b527bc66719", head = "a".repeat(40), target = "b".repeat(40), common = "c".repeat(40);
const oldBlob = "1".repeat(40), newBlob = "2".repeat(40), addedBlob = "3".repeat(40), binBlob = "4".repeat(40);
type Call = { method: string; path: string; query: URLSearchParams; auth: string | null; body?: Record<string, unknown> };
function fakeAzure(state: { head?: string; status?: string; threads?: Record<string, unknown>[]; changeHeadOnSecondRead?: boolean } = {}) {
  const calls: Call[] = [];
  const threads = state.threads ?? [];
  let prReads = 0;
  const pr = () => ({ pullRequestId: 7, title: "Totals in cents", description: "Fixes AB#12", isDraft: false, status: state.status ?? "active", createdBy: { id: "u-alice", uniqueName: "alice@fabrikam.com" }, sourceRefName: "refs/heads/feature/cents", targetRefName: "refs/heads/main", lastMergeSourceCommit: { commitId: (state.changeHeadOnSecondRead && ++prReads > 1) ? "f".repeat(40) : state.head ?? head }, lastMergeTargetCommit: { commitId: target }, repository: { id: repoId, name: "shop", project: { name: "Retail" } } });
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input)), method = init.method ?? "GET", form = init.body instanceof URLSearchParams ? init.body : undefined, body = typeof init.body === "string" ? JSON.parse(init.body) : form ? Object.fromEntries(form) : undefined;
    calls.push({ method, path: url.pathname, query: url.searchParams, auth: new Headers(init.headers).get("authorization"), body });
    assert.equal(init.redirect, "error");
    if (url.hostname === "login.microsoftonline.com") return Response.json({ access_token: "entra-access-token", expires_in: 3600 });
    assert.equal(url.searchParams.get("api-version"), "7.1");
    const p = url.pathname.replace("/fabrikam/", "");
    const r = `Retail/_apis/git/repositories/${repoId}`;
    if (p === "_apis/connectionData") return Response.json({ authenticatedUser: { id: "u-bot", uniqueName: "openreview-bot" } });
    if (p === "_apis/git/repositories") return Response.json({ value: [{ id: repoId, name: "shop", defaultBranch: "refs/heads/main", remoteUrl: "https://dev.azure.com/fabrikam/Retail/_git/shop", project: { id: "p-1", name: "Retail" } }, { id: "x", name: "empty", remoteUrl: "https://dev.azure.com/fabrikam/Retail/_git/empty", project: { id: "p-1", name: "Retail" } }, { id: "y", name: "old", defaultBranch: "refs/heads/main", isDisabled: true, remoteUrl: "https://dev.azure.com/fabrikam/Retail/_git/old", project: { id: "p-1", name: "Retail" } }] });
    if (p === `${r}/refs`) return Response.json({ value: [{ name: "refs/heads/main", objectId: target }, { name: "refs/heads/main-old", objectId: "d".repeat(40), isLocked: true }] });
    if (p === `${r}/commits/${head}`) return Response.json({ treeId: "e".repeat(40) });
    if (p === `${r}/trees/${"e".repeat(40)}`) return Response.json({ treeEntries: [{ relativePath: "src/cart.ts", objectId: newBlob, gitObjectType: "blob", size: 40 }, { relativePath: "src", objectId: "t", gitObjectType: "tree" }] });
    if (p.startsWith(`${r}/blobs/`)) {
      const sha = p.split("/").at(-1);
      const content = sha === oldBlob ? "const a = 1;\nconst total = price * 100;\nexport { a };\n" : sha === newBlob ? "const a = 1;\nconst total = Math.round(price * 100);\nexport { a };\n" : sha === addedBlob ? "export const tax = 0;\n" : "\u0000PNG";
      return new Response(content, { headers: { "content-type": "application/octet-stream" } });
    }
    if (p === `${r}/pullrequests/7`) return Response.json(pr());
    if (p === `${r}/pullrequests`) return Response.json({ value: [{ pullRequestId: 7 }, { pullRequestId: 9 }] });
    if (p === `${r}/pullRequests/7/iterations`) return Response.json({ value: [{ id: 1, sourceRefCommit: { commitId: "9".repeat(40) } }, { id: 2, sourceRefCommit: { commitId: head }, commonRefCommit: { commitId: common } }] });
    if (p === `${r}/pullRequests/7/iterations/2/changes`) return Response.json({ changeEntries: [{ changeTrackingId: 1, changeType: "edit", item: { path: "/src/cart.ts", objectId: newBlob, originalObjectId: oldBlob } }, { changeTrackingId: 2, changeType: "add", item: { path: "/src/tax.ts", objectId: addedBlob } }, { changeTrackingId: 3, changeType: "edit", item: { path: "/logo.png", objectId: binBlob, originalObjectId: binBlob } }], nextSkip: 0 });
    if (p === `${r}/pullRequests/7/threads` && method === "GET") return Response.json({ value: threads });
    if (p === `${r}/pullRequests/7/threads` && method === "POST") { const created = { id: 100 + threads.length, status: body.status === azureThreadStatus.closed ? "closed" : "active", threadContext: body.threadContext ?? null, comments: [{ id: 1, parentCommentId: 0, content: body.comments[0].content, author: { id: "u-bot" } }] }; threads.push(created); return Response.json(created); }
    if (/\/threads\/\d+\/comments\/\d+$/.test(p) && method === "PATCH") return Response.json({ id: 1, content: body.content, author: { id: "u-bot" } });
    if (/\/threads\/\d+\/comments$/.test(p) && method === "POST") return Response.json({ id: 2, parentCommentId: 1, content: body.content, author: { id: "u-bot" } });
    if (p === `${r}/pullRequests/7/commits`) return Response.json({ value: [{ commitId: head }] });
    if (p === `${r}/pullRequests/7/statuses` && method === "GET") return Response.json({ value: [{ state: "succeeded", context: { name: "build", genre: "ci" } }] });
    if (p === `${r}/pullRequests/7/statuses` && method === "POST") return Response.json({ id: 1 });
    return new Response("not found " + p, { status: 404 });
  }) as typeof fetch;
  return { calls, impl, threads };
}
const finding: Finding = { title: "Totals rounded twice", description: "d", severity: "high", confidence: 0.9, category: "correctness", filePath: "src/cart.ts", startLine: 2, endLine: 2, evidence: [{ filePath: "src/cart.ts", startLine: 2, quote: "const total = Math.round(price * 100);" }], impact: "i", suggestedFix: "f", symbol: "total", fingerprint: "fp123", agent: "correctness" } as unknown as Finding;

test("PAT and Entra service-principal auth; discovery, refs, trees and bounded blobs use the repository GUID", async () => {
  const az = fakeAzure(), client = new AzureDevOps(base, "pat-secret-value", repoId, az.impl);
  assert.deepEqual(await client.repositories(), [{ externalId: repoId, fullName: "Retail/shop", defaultBranch: "main", remoteUrl: "https://dev.azure.com/fabrikam/Retail/_git/shop", group: { externalId: "p-1", name: "Retail" } }]);
  assert.equal(az.calls[0].auth, "Basic " + Buffer.from(":pat-secret-value").toString("base64"));
  assert.equal(await client.head("Retail/shop", "main"), target);
  assert.deepEqual(await client.branches("Retail/shop"), { branches: [{ name: "main", sha: target, protected: false }, { name: "main-old", sha: "d".repeat(40), protected: true }], limited: false });
  assert.deepEqual(await client.tree("Retail/shop", head), [{ path: "src/cart.ts", sha: newBlob, type: "blob", size: 40 }]);
  assert.match((await client.blob("Retail/shop", "src/cart.ts", newBlob)).content, /Math\.round/);
  await assert.rejects(client.tree("Retail/shop", "main"), /exact commit/);
  assert.equal(client.sourceUrl("Retail/shop", head, "src/cart.ts"), `https://dev.azure.com/fabrikam/Retail/_git/shop?path=%2Fsrc%2Fcart.ts&version=GC${head}`);
  const sp = fakeAzure(), entra = new AzureDevOps(base, JSON.stringify({ tenantId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222", clientSecret: "client-secret" }), repoId, sp.impl);
  await entra.repositories(); await entra.head("Retail/shop", "main");
  assert.deepEqual(sp.calls[0].body, { grant_type: "client_credentials", client_id: "22222222-2222-4222-8222-222222222222", client_secret: "client-secret", scope: "499b84ac-1321-427f-aa17-267ca6975798/.default" });
  assert.equal(sp.calls.filter((c) => c.path.endsWith("/oauth2/v2.0/token")).length, 1, "the Entra token is cached");
  assert.ok(sp.calls.filter((c) => c.path.startsWith("/fabrikam")).every((c) => c.auth === "Bearer entra-access-token"));
});

test("pull requests come from the latest iteration with diffs computed from base and head blobs", async () => {
  const az = fakeAzure(), client = new AzureDevOps(base, "pat", repoId, az.impl);
  const pr = await client.pullRequest("Retail/shop", 7) as unknown as { head: { sha: string; ref: string }; base: { sha: string; ref: string }; revisionKey: string; user: { login: string }; diff: { path: string; status: string; patch: string }[]; omitted: { path: string; reason: string }[]; checks: { name: string; conclusion: string }[]; html_url: string };
  assert.deepEqual([pr.head, pr.base, pr.revisionKey, pr.user.login], [{ sha: head, ref: "feature/cents" }, { sha: common, ref: "main" }, target + ":" + head, "alice@fabrikam.com"]);
  assert.equal(pr.html_url, "https://dev.azure.com/fabrikam/Retail/_git/shop/pullrequest/7");
  assert.deepEqual(pr.diff.map((d) => [d.path, d.status]), [["src/cart.ts", "modified"], ["src/tax.ts", "added"], ["logo.png", "modified"]]);
  assert.equal(pr.diff[0].patch, "@@ -1,3 +1,3 @@\n const a = 1;\n-const total = price * 100;\n+const total = Math.round(price * 100);\n export { a };");
  assert.equal(pr.diff[1].patch, "@@ -0,0 +1,1 @@\n+export const tax = 0;");
  assert.deepEqual(pr.omitted, [{ path: "logo.png", reason: "Binary file" }]);
  assert.deepEqual(pr.checks, [{ name: "ci/build", status: "completed", conclusion: "success" }]);
  assert.equal(az.calls.find((c) => c.path.endsWith("/iterations/2/changes"))?.query.get("$compareTo"), "0");
  const moving = fakeAzure({ changeHeadOnSecondRead: true });
  await assert.rejects(new AzureDevOps(base, "pat", repoId, moving.impl).pullRequest("Retail/shop", 7), /revision changed during ingestion/);
  assert.deepEqual(await client.openChanges("Retail/shop", null), { numbers: [7, 9], next: null });
});

test("publishing creates positioned finding threads and one closed summary thread, then edits it in place", async () => {
  const az = fakeAzure(), client = new AzureDevOps(base, "pat", repoId, az.impl);
  const first = await client.publish("Retail/shop", 7, head, "One verified finding.", [finding], "rev1", "concise", target + ":" + head, 1);
  const created = az.calls.filter((c) => c.method === "POST" && c.path.endsWith("/threads"));
  assert.equal(created.length, 2);
  assert.deepEqual(created[0].body?.threadContext, { filePath: "/src/cart.ts", rightFileStart: { line: 2, offset: 1 }, rightFileEnd: { line: 2, offset: 1 } });
  assert.deepEqual(created[0].body?.pullRequestThreadContext, { changeTrackingId: 1, iterationContext: { firstComparingIteration: 1, secondComparingIteration: 2 } });
  assert.match(String((created[0].body?.comments as { content: string }[])[0].content), /<!-- openreview:rev1:finding:fp123 -->/);
  assert.equal(created[1].body?.status, azureThreadStatus.closed);
  assert.ok(String((created[1].body?.comments as { content: string }[])[0].content).includes(summaryMarker));
  assert.deepEqual(first, { id: "101", reused: false, comments: [{ id: "100:1", fingerprint: "fp123" }] });
  // Re-publishing reuses the finding thread and edits the summary instead of posting again.
  const second = await client.publish("Retail/shop", 7, head, "Updated summary.", [finding], "rev1", "concise", target + ":" + head, 1);
  assert.equal(az.calls.filter((c) => c.method === "POST" && c.path.endsWith("/threads")).length, 2);
  assert.equal(az.calls.filter((c) => c.method === "PATCH").at(-1)?.path, `/fabrikam/Retail/_apis/git/repositories/${repoId}/pullRequests/7/threads/101/comments/1`);
  assert.deepEqual(second.comments, [{ id: "100:1", fingerprint: "fp123" }]);
  // Moved heads, unknown lines and closed pull requests are refused.
  await assert.rejects(new AzureDevOps(base, "pat", repoId, fakeAzure({ head: "e".repeat(40) }).impl).publish("Retail/shop", 7, head, "s", [], "rev1"), /revision changed or closed/);
  await assert.rejects(new AzureDevOps(base, "pat", repoId, fakeAzure().impl).publish("Retail/shop", 7, head, "s", [{ ...finding, startLine: 1, endLine: 1, fingerprint: "ctx" } as Finding], "rev1"), /not in the computed diff/);
  await assert.rejects(new AzureDevOps(base, "pat", repoId, fakeAzure({ status: "completed" }).impl).publish("Retail/shop", 7, head, "s", [], "rev1"), /revision changed or closed/);
});

test("replies go to the finding's thread, are idempotent by marker, and statuses use the openreview context", async () => {
  const az = fakeAzure({ threads: [{ id: 55, comments: [{ id: 1, content: "finding", author: { id: "u-bot" } }, { id: 2, content: "earlier\n\n<!-- openreview:conversation:9 -->", author: { id: "u-bot" } }] }] });
  const client = new AzureDevOps(base, "pat", repoId, az.impl);
  assert.deepEqual(await client.reply("Retail/shop", 7, "Answer", "55:1"), { id: "55:2" });
  assert.deepEqual(az.calls.at(-1)?.body, { content: "Answer", parentCommentId: 1, commentType: 1 });
  assert.deepEqual(await client.reply("Retail/shop", 7, "Again", "55:1", "conversation:9"), { id: "55:2" });
  await assert.rejects(client.reply("Retail/shop", 7, "x", "nope"), /thread identity/);
  await client.reportStatus("Retail/shop", 7, "succeeded", "No verified findings", "https://review.example.com/dashboard/pulls/r1");
  assert.deepEqual(az.calls.at(-1)?.body, { state: "succeeded", description: "No verified findings", context: { name: "openreview", genre: "code-review" }, targetUrl: "https://review.example.com/dashboard/pulls/r1" });
  assert.throws(() => new AzureDevOps(base, "pat", "not-a-guid").sourceUrl("Retail/shop/extra", head, "a.ts"), /Invalid Azure DevOps repository/);
});
