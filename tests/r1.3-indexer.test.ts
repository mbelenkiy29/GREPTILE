import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { completeInstallation, getRepo } from "@/lib/data/installations";
import type { Db } from "@/lib/db";
import { edges, files, symbols } from "@/lib/db/schema";
import { indexRepo, type IndexDeps } from "@/lib/indexer";
import { parseSource } from "@/lib/indexer/parser";
import { resolveImport } from "@/lib/indexer/resolve";
import { searchSymbols } from "@/lib/indexer/search";
import { FakeEmbeddings } from "@/lib/llm/fake";
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

describe("tree-sitter parsing", () => {
  const cases: [string, string, string[], string[], string[]][] = [
    [
      "src/cart.ts",
      `import { tax } from "./tax";\nexport function total(xs: number[]) { return tax(sum(xs)); }\nconst sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\nexport class Cart { add() { return total([1]); } }\n`,
      ["function:total", "function:sum", "class:Cart", "method:add"],
      ["tax", "sum", "reduce", "total"],
      ["./tax"],
    ],
    ["web/app.js", `const db = require("./db");\nfunction main() { return db.connect(); }\n`, ["function:main"], ["require", "connect"], ["./db"]],
    [
      "pkg/service.py",
      `from .repo import load\nimport json\n\nclass Service:\n    def run(self):\n        return json.dumps(load())\n`,
      ["class:Service", "function:run"],
      ["dumps", "load"],
      [".repo", "json"],
    ],
    [
      "cmd/main.go",
      `package main\n\nimport "example.com/app/store"\n\ntype Server struct{}\n\nfunc (s *Server) Start() { store.Open() }\n\nfunc main() { (&Server{}).Start() }\n`,
      ["type:Server", "method:Start", "function:main"],
      ["Open", "Start"],
      ["example.com/app/store"],
    ],
    [
      "src/main/java/app/Billing.java",
      `package app;\nimport app.util.Money;\npublic class Billing {\n  public Billing() {}\n  int charge() { return Money.round(new Invoice().amount()); }\n}\n`,
      ["class:Billing", "method:Billing", "method:charge"],
      ["round", "Invoice", "amount"],
      ["app.util.Money"],
    ],
    [
      "src/lib.rs",
      `use crate::util::clamp;\nmod util;\npub struct Meter;\npub trait Read {}\npub fn read() -> i32 { clamp(Meter::value()) }\n`,
      ["struct:Meter", "trait:Read", "function:read"],
      ["clamp", "value"],
      ["crate::util::clamp", "util"],
    ],
    [
      "Billing/Invoice.cs",
      `using Billing.Util;\nnamespace Billing {\n  public interface ITotal {}\n  public class Invoice {\n    public Invoice() {}\n    public int Total() { return Money.Round(Compute()); }\n  }\n}\n`,
      ["interface:ITotal", "class:Invoice", "method:Invoice", "method:Total"],
      ["Round", "Compute"],
      ["Billing.Util"],
    ],
  ];

  test.each(cases)("R1.3 parses %s into symbols, calls, and imports", async (file, src, defs, calls, imports) => {
    const parsed = (await parseSource(file, src))!;
    expect(parsed.symbols.map((s) => `${s.kind}:${s.name}`)).toEqual(defs);
    expect(parsed.calls.map((c) => c.name)).toEqual(calls);
    expect(parsed.imports.map((i) => i.target)).toEqual(imports);
  });

  test("R1.3 attributes each call to its innermost enclosing symbol", async () => {
    const parsed = (await parseSource("a.ts", `function outer() {\n  function inner() { helper(); }\n  other();\n}\n`))!;
    const name = (i: number | null) => (i === null ? null : parsed.symbols[i]!.name);
    expect(parsed.calls.map((c) => [c.name, name(c.from)])).toEqual([
      ["helper", "inner"],
      ["other", "outer"],
    ]);
  });

  test("R1.3 resolves imports to repository files per language", () => {
    const files = new Set([
      "src/tax.ts",
      "src/db/index.ts",
      "pkg/repo.py",
      "pkg/__init__.py",
      "store/store.go",
      "store/open.go",
      "src/main/java/app/util/Money.java",
      "src/util.rs",
      "Billing/Util/Money.cs",
    ]);
    expect(resolveImport("typescript", "src/cart.ts", "./tax", files)).toEqual(["src/tax.ts"]);
    expect(resolveImport("typescript", "src/cart.ts", "./tax.js", files)).toEqual(["src/tax.ts"]);
    expect(resolveImport("javascript", "src/app.js", "./db", files)).toEqual(["src/db/index.ts"]);
    expect(resolveImport("typescript", "src/cart.ts", "react", files)).toEqual([]);
    expect(resolveImport("python", "pkg/service.py", ".repo", files)).toEqual(["pkg/repo.py"]);
    expect(resolveImport("python", "main.py", "pkg.repo", files)).toEqual(["pkg/repo.py"]);
    expect(resolveImport("go", "cmd/main.go", "example.com/app/store", files)).toEqual(["store/open.go", "store/store.go"]);
    expect(resolveImport("java", "src/main/java/app/Billing.java", "app.util.Money", files)).toEqual([
      "src/main/java/app/util/Money.java",
    ]);
    expect(resolveImport("rust", "src/lib.rs", "crate::util::clamp", files)).toEqual(["src/util.rs"]);
    expect(resolveImport("rust", "src/lib.rs", "util", files)).toEqual(["src/util.rs"]);
    expect(resolveImport("csharp", "Billing/Invoice.cs", "Billing.Util", files)).toEqual(["Billing/Util/Money.cs"]);
  });
});

describe("repository indexing", () => {
  let db: Db;
  let fixture: FixtureRepo;
  let deps: IndexDeps & { embedder: CountingEmbeddings };
  let repoId: number;
  const orgId = "org_a";

  beforeEach(async () => {
    db = await createTestDb();
    fixture = new FixtureRepo();
    fixture.commit({
      "src/pricing.ts": `export function computeTotal(items: number[]) {\n  return applyDiscount(items.reduce((a, b) => a + b, 0));\n}\nfunction applyDiscount(n: number) { return n * 0.9; }\n`,
      "src/checkout.ts": `import { computeTotal } from "./pricing";\nexport function checkout(items: number[]) {\n  return { total: computeTotal(items) };\n}\n`,
      "worker/jobs.py": `from .queue import enqueue\n\ndef schedule(job):\n    return enqueue(job)\n`,
      "worker/queue.py": `def enqueue(job):\n    return job\n`,
      "README.md": "# not indexed\n",
      "node_modules/dep/index.js": "function ignored() {}\n",
    });
    const host = new FakeGitHost();
    host.addInstallation(11, "acme", [{ id: 1, fullName: "acme/shop", defaultBranch: "main", private: true }]);
    host.cloneUrls.set("acme/shop", fixture.url);
    const { repos } = await completeInstallation(db, host, { orgId, orgName: "Acme", installationId: 11 });
    repoId = repos[0]!.id;
    deps = { db, host, embedder: new CountingEmbeddings(), cacheDir: tempDir() };
  });

  afterEach(() => fixture.cleanup());

  async function graph() {
    const fileRows = await db.select().from(files).where(eq(files.repoId, repoId));
    const symRows = await db.select().from(symbols).where(eq(symbols.repoId, repoId));
    const edgeRows = await db.select().from(edges).where(eq(edges.repoId, repoId));
    const pathOf = (id: number | null) => fileRows.find((f) => f.id === id)?.path ?? null;
    const symOf = (id: number | null) => symRows.find((s) => s.id === id)?.name ?? null;
    return {
      fileRows,
      symRows,
      calls: edgeRows.filter((e) => e.kind === "call").map((e) => `${symOf(e.fromSymbolId)}->${symOf(e.toSymbolId) ?? `?${e.targetName}`}`).sort(),
      imports: edgeRows.filter((e) => e.kind === "import").map((e) => `${pathOf(e.fromFileId)}->${pathOf(e.toFileId)}`).sort(),
    };
  }

  test("R1.3 indexes a repository into files → symbols → call/import edges with embeddings", async () => {
    const head = fixture.git("rev-parse", "HEAD");
    const res = await indexRepo(deps, { orgId, repoId });
    expect(res).toMatchObject({ sha: head, filesParsed: 4, filesRemoved: 0 });

    const g = await graph();
    expect(g.fileRows.map((f) => [f.path, f.language, f.orgId]).sort()).toEqual([
      ["src/checkout.ts", "typescript", orgId],
      ["src/pricing.ts", "typescript", orgId],
      ["worker/jobs.py", "python", orgId],
      ["worker/queue.py", "python", orgId],
    ]);
    expect(g.symRows.map((s) => s.name).sort()).toEqual(["applyDiscount", "checkout", "computeTotal", "enqueue", "schedule"]);
    expect(g.symRows.every((s) => s.embedding?.length === 1536)).toBe(true);
    expect(g.calls).toEqual([
      "checkout->computeTotal",
      "computeTotal->?reduce",
      "computeTotal->applyDiscount",
      "schedule->enqueue",
    ]);
    expect(g.imports).toEqual(["src/checkout.ts->src/pricing.ts", "worker/jobs.py->worker/queue.py"]);

    const repo = await getRepo(db, orgId, repoId);
    expect(repo).toMatchObject({ indexStatus: "ready", indexedSha: head, fileCount: 4, symbolCount: 5 });

    const [query] = await deps.embedder.embed(["computeTotal discount items"]);
    const hits = await searchSymbols(db, { orgId, repoId }, query!, 2);
    expect(hits[0]?.name).toBe("computeTotal");
    expect(await searchSymbols(db, { orgId: "org_other", repoId }, query!, 2)).toEqual([]);
  });

  test("R1.3 re-indexing after a push re-parses and re-embeds only changed files", async () => {
    await indexRepo(deps, { orgId, repoId });
    deps.embedder.embedded = [];
    const sha = fixture.commit({
      "src/pricing.ts": `export function computeTotal(items: number[]) {\n  return applyCoupon(items.length);\n}\nexport function applyCoupon(n: number) { return n - 1; }\n`,
      "worker/queue.py": null,
    });

    const res = await indexRepo(deps, { orgId, repoId, afterSha: sha });
    expect(res).toMatchObject({ sha, filesParsed: 1, filesRemoved: 1, filesUnchanged: 2 });
    expect(deps.embedder.embedded.map((t) => t.split("\n")[1])).toEqual(["function computeTotal", "function applyCoupon"]);

    const g = await graph();
    expect(g.symRows.map((s) => s.name).sort()).toEqual(["applyCoupon", "checkout", "computeTotal", "schedule"]);
    // The unchanged caller is re-linked to the re-created symbol; the deleted module's edges dangle by name.
    expect(g.calls).toEqual(["checkout->computeTotal", "computeTotal->applyCoupon", "schedule->?enqueue"]);
    expect(g.imports).toEqual(["src/checkout.ts->src/pricing.ts", "worker/jobs.py->null"]);
    expect(await db.select().from(symbols).where(and(eq(symbols.repoId, repoId), isNull(symbols.embedding)))).toEqual([]);
    expect((await getRepo(db, orgId, repoId))?.indexedSha).toBe(sha);
  });

  test("R1.3 a failed index marks the repo failed with the error", async () => {
    deps.host = new FakeGitHost();
    (deps.host as FakeGitHost).cloneUrls.set("acme/shop", "file:///nonexistent/repo");
    await expect(indexRepo(deps, { orgId, repoId })).rejects.toThrow();
    const repo = await getRepo(db, orgId, repoId);
    expect(repo?.indexStatus).toBe("failed");
    expect(repo?.indexError).toBeTruthy();
    await expect(indexRepo(deps, { orgId: "org_other", repoId })).rejects.toThrow(/not found/);
  });
});

describe("index job", () => {
  test("R1.3 the index-repo job pushed by the webhook runs the indexer", async () => {
    const db = await createTestDb();
    const fixture = new FixtureRepo();
    const sha = fixture.commit({ "lib/a.ts": "export function a() { return 1; }\n" });
    const host = new FakeGitHost();
    host.addInstallation(11, "acme", [{ id: 1, fullName: "acme/x", defaultBranch: "main", private: true }]);
    host.cloneUrls.set("acme/x", fixture.url);
    const { repos } = await completeInstallation(db, host, { orgId: "org_a", orgName: "Acme", installationId: 11 });
    const { runJob } = await import("@/lib/jobs/handlers");
    const { MemoryQueue } = await import("@/lib/jobs/types");
    const { FakeLlm } = await import("@/lib/llm/fake");
    await runJob(
      { db, host, queue: new MemoryQueue(), llm: new FakeLlm(), embedder: new FakeEmbeddings(), cacheDir: tempDir(), botMention: "openreview" },
      "index-repo",
      { orgId: "org_a", repoId: repos[0]!.id, mode: "incremental", afterSha: sha },
    );
    expect(await getRepo(db, "org_a", repos[0]!.id)).toMatchObject({ indexStatus: "ready", indexedSha: sha, symbolCount: 1 });
    fixture.cleanup();
  });
});
