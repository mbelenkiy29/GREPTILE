import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { completeInstallation, getRepo } from "@/lib/data/installations";
import { edges, fileChunks, files, indexJobs, repoCommits, repoDependencies, symbols } from "@/lib/db/schema";
import { cancelIndexJob, createIndexJob, getIndexStatus, indexRepo, IndexLockedError, listIndexJobs, type IndexDeps } from "@/lib/indexer";
import { openLockSession, withRepoIndexLock, INDEX_LOCK_NAMESPACE, type LockSession } from "@/lib/indexer/lock";
import { searchFullText } from "@/lib/indexer/query";
import { FakeEmbeddings } from "@/lib/llm/fake";
import { REDACTED_SECRET } from "@/lib/security/secret-scan";
import { createTestDb } from "./helpers/db";
import { FakeGitHost } from "./helpers/fake-git";
import { FixtureRepo, tempDir } from "./helpers/fixture-repo";

class CountingEmbeddings extends FakeEmbeddings {
  embedded: string[] = [];
  override async embed(texts: string[]) {
    this.embedded.push(...texts);
    return super.embed(texts);
  }
}

const orgId = "org_a";
const fixtures: FixtureRepo[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

async function setup(initial: Record<string, string>) {
  const db = await createTestDb();
  const fixture = new FixtureRepo();
  fixtures.push(fixture);
  fixture.commit(initial, "initial import");
  const host = new FakeGitHost();
  host.addInstallation(11, "acme", [{ id: 1, fullName: "acme/shop", defaultBranch: "main", private: true }]);
  host.cloneUrls.set("acme/shop", fixture.url);
  const { repos } = await completeInstallation(db, host, { orgId, orgName: "Acme", installationId: 11 });
  const repoId = repos[0]!.id;
  const deps: IndexDeps & { embedder: CountingEmbeddings } = { db, host, embedder: new CountingEmbeddings(), cacheDir: tempDir() };
  return { db, fixture, host, repoId, deps };
}

const fakeToken = ["ghp", "_", "a1B2c3D4e5F6g7H8i9J0".repeat(2)].join("");
const fakeAws = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");

describe("scanning", () => {
  test("R6.3 skips vendored, generated, binary, oversized, secret, and unsupported files and counts them by reason", async () => {
    const { db, repoId, deps } = await setup({
      "src/index.ts": "export function main() { return 1; }\n",
      ".env.example": "DATABASE_URL=postgres://localhost/app\n",
      "node_modules/dep/index.js": "module.exports = 1;\n",
      "dist/bundle.js": "var a = 1;\n",
      "vendor/lib/x.go": "package lib\n",
      "public/app.min.js": "var b=2;\n",
      "pnpm-lock.yaml": "lockfileVersion: 9\n",
      "api/user.pb.go": "package api\n",
      "proto/user_pb2.py": "x = 1\n",
      "assets/logo.png": "PNG",
      "fixtures/raw.txt": "text\u0000with a NUL byte\n",
      "data/big.json": JSON.stringify({ blob: "z".repeat(3000) }),
      ".env": "SECRET=1\n",
      ".env.production": "SECRET=2\n",
      "certs/server.pem": "pem\n",
      "keys/id_rsa": "key\n",
      "config/credentials.json": "{}\n",
      "secrets.yaml": "a: b\n",
      "LICENSE": "MIT\n",
    });
    const res = await indexRepo({ ...deps, maxFileBytes: 2048 }, { orgId, repoId });
    expect(res.filesSkipped).toEqual({ vendored: 3, generated: 4, binary: 2, too_large: 1, secret_file: 6, unsupported: 1 });
    const indexed = await db.select({ path: files.path }).from(files).where(eq(files.repoId, repoId));
    expect(indexed.map((f) => f.path).sort()).toEqual([".env.example", "src/index.ts"]);
    const [job] = await db.select().from(indexJobs).where(eq(indexJobs.id, res.indexJobId));
    expect(job!.progress).toMatchObject({ phase: "done", filesTotal: 2, filesSkipped: res.filesSkipped });
  });

  test("R6.3 redacts secret lines before content is stored or embedded", async () => {
    const { db, repoId, deps } = await setup({
      "src/config.ts": `export const region = "eu-west-1";\nexport const githubToken = "${fakeToken}";\nexport function client() {\n  const key = "${fakeAws}";\n  return connect(key);\n}\n`,
      "docs/setup.md": `# Setup\n\nexport AWS_ACCESS_KEY_ID=${fakeAws}\n\nThen run the app.\n`,
    });
    const res = await indexRepo(deps, { orgId, repoId });
    const stored = [
      ...(await db.select({ c: symbols.content }).from(symbols).where(eq(symbols.repoId, repoId))).map((r) => r.c),
      ...(await db.select({ c: fileChunks.content }).from(fileChunks).where(eq(fileChunks.repoId, repoId))).map((r) => r.c),
    ].join("\n");
    for (const secret of [fakeToken, fakeAws]) {
      expect(stored).not.toContain(secret);
      expect(deps.embedder.embedded.join("\n")).not.toContain(secret);
    }
    expect(stored).toContain(`  ${REDACTED_SECRET}\n  return connect(key);`);
    expect(stored).toContain("Then run the app.");
    const [job] = await db.select().from(indexJobs).where(eq(indexJobs.id, res.indexJobId));
    expect(job!.progress.secretLinesRedacted).toBe(3);
  });

  test("R6.3 stores classification tags, sizes, and line counts, and per-language counts on the repo", async () => {
    const { db, repoId, deps } = await setup({
      "src/cart.ts": "export function total() {\n  return 1;\n}\n",
      "src/cart.test.ts": `import { total } from "./cart";\ntest("total", () => expect(total()).toBe(1));\n`,
      "tests/test_api.py": "def test_ok():\n    assert True\n",
      "package.json": JSON.stringify({ name: "shop", dependencies: { zod: "^3" } }),
      "README.md": "# Shop\n",
      "CLAUDE.md": "# Rules\nBe nice.\n",
      ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - run: pnpm test\n",
      "db/migrations/001.sql": "CREATE TABLE carts (id int);\n",
    });
    await indexRepo(deps, { orgId, repoId });
    const rows = await db.select({ path: files.path, tags: files.tags, size: files.sizeBytes, lines: files.lineCount }).from(files).where(eq(files.repoId, repoId));
    const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));
    expect(byPath["src/cart.ts"]).toMatchObject({ tags: ["source"], size: 40, lines: 3 });
    expect(byPath["src/cart.test.ts"]!.tags).toEqual(["test"]);
    expect(byPath["tests/test_api.py"]!.tags).toEqual(["test"]);
    expect(byPath["package.json"]!.tags).toEqual(["manifest"]);
    expect(byPath["README.md"]!.tags).toEqual(["doc"]);
    expect(byPath["CLAUDE.md"]!.tags).toEqual(["doc", "instructions"]);
    expect(byPath[".github/workflows/ci.yml"]!.tags).toEqual(["ci", "config"]);
    expect(byPath["db/migrations/001.sql"]!.tags).toEqual(["migration", "schema", "source"]);
    expect((await getRepo(db, orgId, repoId))!.languages).toEqual({ typescript: 2, python: 1, sql: 1 });
  });

  test("R6.3 records manifests as dependencies and module symbols", async () => {
    const { db, repoId, deps } = await setup({
      "package.json": JSON.stringify({ name: "@acme/shop", workspaces: ["packages/*"], dependencies: { express: "^4.18.2" }, devDependencies: { vitest: "^1" } }),
      "packages/core/package.json": JSON.stringify({ name: "@acme/core", dependencies: { zod: "^3.22" } }),
      "requirements.txt": "django>=4.2\n",
      "go.mod": "module example.com/shop\n\nrequire github.com/gin-gonic/gin v1.9.1\n",
    });
    await indexRepo(deps, { orgId, repoId });
    const rows = await db.select().from(repoDependencies).where(eq(repoDependencies.repoId, repoId));
    expect(rows.map((d) => `${d.manifestPath} ${d.ecosystem}:${d.name}@${d.versionSpec}:${d.kind}`).sort()).toEqual([
      "go.mod go:github.com/gin-gonic/gin@v1.9.1:prod",
      "package.json npm:express@^4.18.2:prod",
      "package.json npm:vitest@^1:dev",
      "packages/core/package.json npm:zod@^3.22:prod",
      "requirements.txt pypi:django@>=4.2:prod",
    ]);
    expect(rows.every((d) => d.orgId === orgId)).toBe(true);
    const modules = await db.select({ name: symbols.name }).from(symbols).where(and(eq(symbols.repoId, repoId), eq(symbols.kind, "module")));
    expect(modules.map((m) => m.name).sort()).toEqual(["@acme/core", "@acme/shop", "example.com/shop", "shop"]);
  });

  test("R6.3 indexes routes, schemas, and CI jobs as symbols", async () => {
    const { db, repoId, deps } = await setup({
      "src/app/api/orders/[id]/route.ts": "export async function GET() { return Response.json({}); }\n",
      "db/schema.sql": "CREATE TABLE orders (id int);\n",
      "prisma/schema.prisma": "model User {\n  id Int @id\n}\n",
      ".github/workflows/ci.yml": "name: CI\njobs:\n  build:\n    steps:\n      - run: make\n",
    });
    await indexRepo(deps, { orgId, repoId });
    const rows = await db.select({ kind: symbols.kind, name: symbols.name, q: symbols.qualifiedName }).from(symbols).where(eq(symbols.repoId, repoId));
    const entities = rows.filter((r) => ["route", "table", "model", "ci_job"].includes(r.kind)).map((r) => `${r.kind}:${r.q}`);
    expect(entities.sort()).toEqual(["ci_job:CI/build", "model:User", "route:GET /api/orders/:id", "table:User", "table:orders"]);
  });
});

describe("docs and full-text search", () => {
  test("R6.3 chunks and embeds docs by heading, and full-text search finds them", async () => {
    const { db, repoId, deps } = await setup({
      "docs/deploy.md": "# Deploying\n\nUse the droplet.\n\n## Rollbacks\n\nRun the rollback script to restore the previous release.\n",
      "AGENTS.md": "# Agent instructions\n\nAlways run migrations before tests.\n",
      "src/release.ts": "export function rollbackRelease(id: string) {\n  return restorePrevious(id);\n}\n",
    });
    await indexRepo(deps, { orgId, repoId });
    const chunks = await db.select().from(fileChunks).where(eq(fileChunks.repoId, repoId)).orderBy(fileChunks.path, fileChunks.startLine);
    expect(chunks.map((c) => [c.path, c.kind, c.startLine, c.endLine, c.embedding !== null])).toEqual([
      ["AGENTS.md", "doc", 1, 3, true],
      ["docs/deploy.md", "doc", 1, 4, true],
      ["docs/deploy.md", "doc", 5, 7, true],
      ["src/release.ts", "code", 1, 3, false],
    ]);
    const hits = await searchFullText(db, { orgId, repoId }, "rollback script", 5);
    expect(hits[0]).toMatchObject({ path: "docs/deploy.md", startLine: 5, kind: "doc" });
    expect(hits[0]!.rank).toBeGreaterThan(0);
    const code = await searchFullText(db, { orgId, repoId }, "restorePrevious", 5);
    expect(code.map((h) => h.path)).toEqual(["src/release.ts"]);
    expect(await searchFullText(db, { orgId: "org_other", repoId }, "rollback", 5)).toEqual([]);
  });
});

describe("index jobs", () => {
  test("R6.3 tracks an index job's lifecycle: progress, attempts, changed files, completion", async () => {
    const { db, fixture, repoId, deps } = await setup({ "src/a.ts": "export function a() {}\n", "src/b.ts": "export function b() {}\n" });
    const first = await indexRepo(deps, { orgId, repoId });
    const sha = fixture.git("rev-parse", "HEAD");
    const [job] = await db.select().from(indexJobs).where(eq(indexJobs.id, first.indexJobId));
    expect(job).toMatchObject({ orgId, repoId, kind: "full", trigger: "install", status: "completed", attempts: 1, fromSha: null, toSha: sha, error: null });
    expect(job!.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(job!.progress).toMatchObject({ phase: "done", filesTotal: 2, filesDone: 2, filesChanged: 2, filesRemoved: 0, symbols: 2 });
    expect(job!.startedAt).toBeInstanceOf(Date);
    expect(job!.finishedAt!.getTime()).toBeGreaterThanOrEqual(job!.startedAt!.getTime());
    expect((await getRepo(db, orgId, repoId))!.lastIndexJobId).toBe(first.indexJobId);

    // A queued job created up front (dashboard / API) is picked up by id.
    const after = fixture.commit({ "src/b.ts": "export function b2() {}\n", "src/c.ts": "export function c() {}\n", "src/a.ts": null });
    const queued = await createIndexJob(db, { orgId, repoId, kind: "incremental", trigger: "manual" });
    expect(queued).toMatchObject({ status: "queued", attempts: 0, progress: { phase: "queued" } });
    const second = await indexRepo(deps, { orgId, repoId, indexJobId: queued.id });
    expect(second.indexJobId).toBe(queued.id);
    const [done] = await db.select().from(indexJobs).where(eq(indexJobs.id, queued.id));
    expect(done).toMatchObject({ status: "completed", kind: "incremental", trigger: "manual", fromSha: sha, toSha: after, attempts: 1 });
    expect(done!.changedFiles).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(done!.progress).toMatchObject({ filesChanged: 2, filesRemoved: 1, filesTotal: 2 });
  });

  test("R6.3 records failures, counts attempts across retries of one queued job, and caps changed files", async () => {
    const many = Object.fromEntries(Array.from({ length: 520 }, (_, i) => [`src/m${String(i).padStart(3, "0")}.ts`, `export const v${i} = ${i};\n`]));
    const { db, host, repoId, deps } = await setup(many);
    const url = host.cloneUrls.get("acme/shop")!;
    host.cloneUrls.set("acme/shop", "file:///nonexistent/repo");
    await expect(indexRepo(deps, { orgId, repoId, queueJobId: "index-1-initial" })).rejects.toThrow(/nonexistent/);
    const [failed] = await db.select().from(indexJobs).where(eq(indexJobs.repoId, repoId));
    expect(failed).toMatchObject({ status: "failed", attempts: 1, queueJobId: "index-1-initial" });
    expect(failed!.error).toMatch(/does not appear to be a git repository/);
    expect((await getRepo(db, orgId, repoId))).toMatchObject({ indexStatus: "failed" });

    // The queue retries the same job: the same row is reused and its attempts count up.
    host.cloneUrls.set("acme/shop", url);
    const res = await indexRepo(deps, { orgId, repoId, queueJobId: "index-1-initial" });
    expect(res.indexJobId).toBe(failed!.id);
    const [retried] = await db.select().from(indexJobs).where(eq(indexJobs.id, failed!.id));
    expect(retried).toMatchObject({ status: "completed", attempts: 2, error: null });
    expect(retried!.changedFiles).toHaveLength(500);
    expect(retried!.progress.filesDone).toBe(520);
    expect((await db.select().from(indexJobs).where(eq(indexJobs.repoId, repoId))).length).toBe(1);
  });

  test("R6.3 lists index jobs and reports index status for the dashboard", async () => {
    const { db, fixture, repoId, deps } = await setup({ "src/a.ts": "export function a() {}\n" });
    await indexRepo(deps, { orgId, repoId });
    fixture.commit({ "src/a.ts": "export function a2() {}\n" });
    await indexRepo(deps, { orgId, repoId, mode: "full", trigger: "api" });
    const queued = await createIndexJob(db, { orgId, repoId, kind: "incremental", trigger: "schedule" });

    const page1 = await listIndexJobs(db, orgId, repoId, { page: 1, pageSize: 2 });
    expect(page1).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(page1.jobs.map((j) => [j.trigger, j.kind, j.status])).toEqual([
      ["schedule", "incremental", "queued"],
      ["api", "full", "completed"],
    ]);
    expect((await listIndexJobs(db, orgId, repoId, { page: 2, pageSize: 2 })).jobs.map((j) => j.trigger)).toEqual(["install"]);
    expect(await listIndexJobs(db, "org_other", repoId)).toMatchObject({ jobs: [], total: 0 });

    const status = await getIndexStatus(db, orgId, repoId);
    expect(status).toMatchObject({ indexStatus: "ready", fileCount: 1, symbolCount: 1, languages: { typescript: 1 } });
    expect(status!.current?.id).toBe(queued.id);
    expect(status!.last).toMatchObject({ trigger: "api", status: "completed" });
    expect(await getIndexStatus(db, "org_other", repoId)).toBeNull();

    // A cancelled queued job never runs.
    expect(await cancelIndexJob(db, orgId, repoId, queued.id)).toBe(true);
    const res = await indexRepo(deps, { orgId, repoId, indexJobId: queued.id });
    expect(res.status).toBe("cancelled");
    expect((await getIndexStatus(db, orgId, repoId))!.current).toBeNull();
    expect(await cancelIndexJob(db, "org_other", repoId, queued.id)).toBe(false);
  });

  test("R6.3 incremental re-index reparses only changed files; a full run reparses everything", async () => {
    const { db, fixture, repoId, deps } = await setup({
      "src/a.ts": "export function a() { return b(); }\n",
      "src/b.ts": "export function b() { return 1; }\n",
      "src/c.ts": "export function c() { return 2; }\n",
      "docs/guide.md": "# Guide\n",
    });
    await indexRepo(deps, { orgId, repoId });
    const idsBefore = new Map((await db.select().from(files).where(eq(files.repoId, repoId))).map((f) => [f.path, f.id]));
    deps.embedder.embedded = [];

    const sha = fixture.commit({ "src/b.ts": "export function b() { return 3; }\n" });
    const res = await indexRepo(deps, { orgId, repoId, afterSha: sha });
    expect(res).toMatchObject({ kind: "incremental", filesParsed: 1, filesUnchanged: 3, filesRemoved: 0 });
    const idsAfter = new Map((await db.select().from(files).where(eq(files.repoId, repoId))).map((f) => [f.path, f.id]));
    expect(idsAfter.get("src/a.ts")).toBe(idsBefore.get("src/a.ts"));
    expect(idsAfter.get("src/c.ts")).toBe(idsBefore.get("src/c.ts"));
    expect(idsAfter.get("src/b.ts")).not.toBe(idsBefore.get("src/b.ts"));
    expect(deps.embedder.embedded.map((t) => t.split("\n")[0])).toEqual(["src/b.ts"]);
    // The unchanged caller is re-linked to the re-created callee.
    const [call] = await db.select().from(edges).where(and(eq(edges.repoId, repoId), eq(edges.kind, "call")));
    const [b] = await db.select().from(symbols).where(and(eq(symbols.repoId, repoId), eq(symbols.name, "b")));
    expect(call!.toSymbolId).toBe(b!.id);

    // Nothing changed: nothing is reparsed or embedded.
    deps.embedder.embedded = [];
    expect(await indexRepo(deps, { orgId, repoId })).toMatchObject({ filesParsed: 0, filesUnchanged: 4 });
    expect(deps.embedder.embedded).toEqual([]);

    const full = await indexRepo(deps, { orgId, repoId, mode: "full", trigger: "manual" });
    expect(full).toMatchObject({ kind: "full", filesParsed: 4, filesUnchanged: 0 });
  });

  test("R6.3 records the last 50 commits of the indexed ref with their changed paths", async () => {
    const { db, fixture, repoId, deps } = await setup({ "src/a.ts": "export const a = 0;\n" });
    // 54 commits in one shell, each touching one file.
    execFileSync(
      "sh",
      ["-c", 'for i in $(seq 1 54); do echo "export const v = $i;" > "src/f$((i % 3)).ts"; git add -A; git commit -q -m "change $i" -m "body of change $i"; done'],
      { cwd: fixture.dir },
    );
    await indexRepo(deps, { orgId, repoId });
    const commits = await db.select().from(repoCommits).where(eq(repoCommits.repoId, repoId)).orderBy(sql`${repoCommits.committedAt} desc, ${repoCommits.id} asc`);
    expect(commits).toHaveLength(50);
    const head = fixture.git("rev-parse", "HEAD");
    const newest = commits.find((c) => c.sha === head)!;
    expect(newest).toMatchObject({ orgId, author: "Fixture", parentSha: fixture.git("rev-parse", "HEAD~1"), changedPaths: ["src/f0.ts"] });
    expect(newest.message).toBe("change 54\n\nbody of change 54");
    expect(commits.some((c) => c.message.startsWith("initial import"))).toBe(false);
    // The oldest recorded commit still has its parent, so its changed paths are a real diff.
    expect(commits.every((c) => c.parentSha && c.changedPaths.length === 1)).toBe(true);

    // Re-indexing after more commits adds the new ones without duplicating.
    fixture.commit({ "src/new.ts": "export const n = 1;\n" }, "add new");
    await indexRepo(deps, { orgId, repoId });
    const all = await db.select().from(repoCommits).where(eq(repoCommits.repoId, repoId));
    expect(all).toHaveLength(51);
    expect(all.find((c) => c.message === "add new")!.changedPaths).toEqual(["src/new.ts"]);
  });
});

describe("per-repository lock", () => {
  test("R6.3 holds a Postgres advisory lock for the run and releases it afterwards", async () => {
    const { db, repoId } = await setup({ "a.ts": "export const a = 1;\n" });
    const advisory = async () =>
      (
        (await db.execute(sql`select objid from pg_locks where locktype = 'advisory' and classid = ${INDEX_LOCK_NAMESPACE} and granted`)) as unknown as {
          rows: { objid: number }[];
        }
      ).rows.map((r) => Number(r.objid));
    const during = await withRepoIndexLock(db, repoId, advisory);
    expect(during).toEqual([repoId]);
    expect(await advisory()).toEqual([]);
    // Released even when the run throws.
    await expect(withRepoIndexLock(db, repoId, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await advisory()).toEqual([]);
    const session = await openLockSession(db);
    expect(await session.tryLock(repoId)).toBe(true);
    await session.unlock(repoId);
    await session.release();
  });

  test("R6.3 a second run of the same repository fails with a retryable lock error while the first holds the lock", async () => {
    const { db, repoId, deps } = await setup({ "a.ts": "export const a = 1;\n" });
    // Simulates another worker holding the repository's advisory lock.
    const held = new Set<number>([repoId]);
    const contended = async (): Promise<LockSession> => ({
      tryLock: async (key) => !held.has(key),
      unlock: async (key) => void held.delete(key),
      release: async () => {},
    });
    const err = await indexRepo({ ...deps, lock: { session: contended, attempts: 3, delayMs: 1 } }, { orgId, repoId, queueJobId: "q1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IndexLockedError);
    expect((err as IndexLockedError).retryable).toBe(true);
    const [job] = await db.select().from(indexJobs).where(eq(indexJobs.repoId, repoId));
    expect(job).toMatchObject({ status: "failed", attempts: 1, queueJobId: "q1" });
    // The repository itself is not marked failed: the other run owns its status.
    expect((await getRepo(db, orgId, repoId))!.indexStatus).toBe("pending");

    held.clear();
    const res = await indexRepo({ ...deps, lock: { session: contended, attempts: 1 } }, { orgId, repoId, queueJobId: "q1" });
    expect(res.indexJobId).toBe(job!.id);
    const [retried] = await db.select().from(indexJobs).where(eq(indexJobs.id, job!.id));
    expect(retried).toMatchObject({ status: "completed", attempts: 2 });
  });
});
