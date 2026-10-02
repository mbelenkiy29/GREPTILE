import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { completeInstallation } from "@/lib/data/installations";
import type { Db } from "@/lib/db";
import { edges, files, symbols } from "@/lib/db/schema";
import { indexRepo } from "@/lib/indexer";
import {
  calleesOf,
  callersOf,
  dependentsOf,
  filesByTag,
  findSymbolsByName,
  importersOf,
  nearestChunks,
  nearestSymbols,
  recentChanges,
  repoDependencies,
  routesFor,
  schemaConsumers,
  searchFullText,
  searchPaths,
  testsFor,
  type RepoScope,
} from "@/lib/indexer/query";
import { FakeEmbeddings } from "@/lib/llm/fake";
import { createTestDb } from "./helpers/db";
import { FakeGitHost } from "./helpers/fake-git";
import { FixtureRepo, tempDir } from "./helpers/fixture-repo";

/** A small multi-language repository exercising every relation kind. */
const FIXTURE: Record<string, string> = {
  // TypeScript: classes, interfaces, re-exports, references, tests, routes, a Drizzle table.
  "src/shapes/base.ts": `export abstract class Shape {\n  abstract area(): number;\n}\n\nexport interface Drawable {\n  draw(): void;\n}\n`,
  "src/shapes/circle.ts": `import { Shape, Drawable } from "./base";\nimport { render } from "../render";\n\nexport class Circle extends Shape implements Drawable {\n  constructor(private r: number) {\n    super();\n  }\n  area() {\n    return Math.PI * this.r * this.r;\n  }\n  draw() {\n    render(this);\n  }\n}\n`,
  "src/shapes/index.ts": `export * from "./circle";\nexport { Shape } from "./base";\n`,
  "src/render.ts": `import type { Drawable } from "./shapes/base";\n\nexport function render(d: Drawable) {\n  return d;\n}\n`,
  "src/shapes/circle.test.ts": `import { Circle } from "./circle";\n\ndescribe("Circle", () => {\n  it("has an area", () => {\n    expect(new Circle(1).area()).toBeGreaterThan(3);\n  });\n});\n`,
  "src/api/server.ts": `import express from "express";\nimport { listOrders } from "../orders/service";\n\nconst router = express.Router();\nrouter.get("/orders", listOrders);\n`,
  "src/orders/service.ts": `import { orders } from "../db/schema";\n\nexport function listOrders() {\n  return db.select().from(orders);\n}\n`,
  "src/db/schema.ts": `import { pgTable, serial } from "drizzle-orm/pg-core";\n\nexport const orders = pgTable("orders", { id: serial("id") });\n`,
  "db/migrations/0002_orders_total.sql": `ALTER TABLE orders ADD COLUMN total integer;\n`,
  // Python: Django model, a test that imports it.
  "billing/__init__.py": "",
  "billing/models.py": `from django.db import models\n\n\nclass Invoice(models.Model):\n    total = models.IntegerField()\n`,
  "billing/tests/test_invoice.py": `from billing.models import Invoice\n\n\ndef test_total():\n    assert Invoice(total=1).total == 1\n`,
  // Go: test paired by name.
  "store/store.go": `package store\n\nfunc Get(id string) string {\n\treturn id\n}\n`,
  "store/store_test.go": `package store\n\nimport "testing"\n\nfunc TestGet(t *testing.T) {\n\tGet("x")\n}\n`,
  // Java and C#: extends / implements.
  "src/main/java/com/acme/Base.java": `package com.acme;\npublic class Base {}\n`,
  "src/main/java/com/acme/Payable.java": `package com.acme;\npublic interface Payable {}\n`,
  "src/main/java/com/acme/Billing.java": `package com.acme;\npublic class Billing extends Base implements Payable {}\n`,
  "Billing/IInvoice.cs": `namespace Billing {\n  public interface IInvoice {}\n}\n`,
  "Billing/Document.cs": `namespace Billing {\n  public class Document {}\n}\n`,
  "Billing/Receipt.cs": `namespace Billing {\n  public class Receipt : Document, IInvoice {}\n}\n`,
  // Manifests: a workspace depending on a sibling module and an external package.
  "package.json": JSON.stringify({ name: "@acme/shop", workspaces: ["packages/*"], dependencies: { "@acme/core": "workspace:*", express: "^4.18.2" } }),
  "packages/core/package.json": JSON.stringify({ name: "@acme/core", dependencies: { zod: "^3.22.0" } }),
  "docs/architecture.md": `# Architecture\n\nShapes render through the render module.\n\n## Orders\n\nOrders are stored in Postgres and listed by the orders service.\n`,
};

describe("code graph", () => {
  let db: Db;
  let fixture: FixtureRepo;
  let scope: RepoScope;
  const embedder = new FakeEmbeddings();
  const orgId = "org_a";

  beforeAll(async () => {
    db = await createTestDb();
    fixture = new FixtureRepo();
    fixture.commit(FIXTURE, "initial");
    fixture.commit({ "src/render.ts": FIXTURE["src/render.ts"]!.replace("return d;", "return d; // keep") }, "tweak render");
    const host = new FakeGitHost();
    host.addInstallation(11, "acme", [{ id: 1, fullName: "acme/shop", defaultBranch: "main", private: true }]);
    host.cloneUrls.set("acme/shop", fixture.url);
    const { repos } = await completeInstallation(db, host, { orgId, orgName: "Acme", installationId: 11 });
    scope = { orgId, repoId: repos[0]!.id };
    await indexRepo({ db, host, embedder, cacheDir: tempDir() }, scope);
  });

  afterAll(() => fixture.cleanup());

  async function rel(kind: string) {
    const fileRows = await db.select().from(files).where(eq(files.repoId, scope.repoId));
    const symRows = await db.select().from(symbols).where(eq(symbols.repoId, scope.repoId));
    const pathOf = (id: number | null) => fileRows.find((f) => f.id === id)?.path ?? "?";
    const symOf = (id: number | null) => {
      const s = symRows.find((x) => x.id === id);
      return s ? (s.qualifiedName ?? s.name) : null;
    };
    const rows = await db.select().from(edges).where(and(eq(edges.repoId, scope.repoId), eq(edges.kind, kind as "call")));
    return rows
      .map((e) => `${symOf(e.fromSymbolId) ?? pathOf(e.fromFileId)} -> ${e.toSymbolId ? symOf(e.toSymbolId) : e.toFileId ? pathOf(e.toFileId) : `?${e.targetName}`}`)
      .sort();
  }

  async function sym(name: string, kind?: string) {
    const [s] = await findSymbolsByName(db, scope, [name], { kinds: kind ? [kind] : undefined });
    if (!s) throw new Error(`no symbol ${name}`);
    return s;
  }

  async function fileId(p: string) {
    const [f] = await db.select().from(files).where(and(eq(files.repoId, scope.repoId), eq(files.path, p)));
    if (!f) throw new Error(`no file ${p}`);
    return f.id;
  }

  test("R6.4 links classes to the classes and interfaces they extend and implement", async () => {
    expect(await rel("extends")).toEqual(["Billing -> Base", "Circle -> Shape", "Invoice -> ?Model", "Receipt -> Document"]);
    expect(await rel("implements")).toEqual(["Billing -> Payable", "Circle -> Drawable", "Receipt -> IInvoice"]);
  });

  test("R6.4 records type and identifier references to known symbols", async () => {
    const refs = await rel("reference");
    // `listOrders` passed as a route handler at module level is a reference from the file.
    expect(refs).toEqual(expect.arrayContaining(["render -> Drawable", "listOrders -> orders", "src/api/server.ts -> listOrders"]));
    expect(refs.filter((r) => r.startsWith("render -> "))).toEqual(["render -> Drawable"]);
  });

  test("R6.4 records re-exports as export edges between files", async () => {
    expect(await rel("export")).toEqual(["src/shapes/index.ts -> src/shapes/base.ts", "src/shapes/index.ts -> src/shapes/circle.ts"]);
  });

  test("R6.4 links source files to their tests by imports and by naming convention", async () => {
    expect(await rel("tested_by")).toEqual([
      "billing/models.py -> billing/tests/test_invoice.py",
      "src/shapes/circle.ts -> src/shapes/circle.test.ts",
      "store/store.go -> store/store_test.go",
    ]);
  });

  test("R6.4 links routes to their handler symbols", async () => {
    expect(await rel("route_handler")).toEqual(["GET /orders -> listOrders"]);
  });

  test("R6.4 links tables and models to the files and symbols that consume them", async () => {
    expect(await rel("schema_consumer")).toEqual(["Invoice -> test_total", "orders -> db/migrations/0002_orders_total.sql", "orders -> listOrders"]);
  });

  test("R6.4 links modules to sibling modules and external packages", async () => {
    expect(await rel("depends_on")).toEqual(["@acme/core -> ?zod", "@acme/shop -> ?express", "@acme/shop -> @acme/core"]);
  });

  test("R6.4 resolves calls and imports across files and languages", async () => {
    const calls = await rel("call");
    expect(calls).toEqual(expect.arrayContaining(["Circle.draw -> render", "TestGet -> Get", "test_total -> Invoice"]));
    expect(await rel("import")).toEqual(
      expect.arrayContaining(["src/shapes/circle.ts -> src/shapes/base.ts", "src/shapes/circle.ts -> src/render.ts", "billing/tests/test_invoice.py -> billing/models.py"]),
    );
  });

  test("R6.4 stores parents, qualified names, signatures, and export flags on symbols", async () => {
    const area = await sym("Circle.area");
    const circle = await sym("Circle", "class");
    const [row] = await db.select().from(symbols).where(eq(symbols.id, area.id));
    expect(row).toMatchObject({ kind: "method", qualifiedName: "Circle.area", parentId: circle.id, signature: "area() {", exported: true });
    expect(await sym("Circle > has an area", "test")).toMatchObject({ qualifiedName: "Circle > has an area", exported: false });
    expect(circle).toMatchObject({ exported: true, signature: "export class Circle extends Shape implements Drawable {" });
  });

  test("R6.4 findSymbolsByName matches exact names, qualified names, and prefixes", async () => {
    expect((await findSymbolsByName(db, scope, ["Circle"])).map((s) => `${s.kind}:${s.qualifiedName}`)).toEqual(["test:Circle", "class:Circle"]);
    expect((await findSymbolsByName(db, scope, ["Circle"], { kinds: ["class"] })).map((s) => s.path)).toEqual(["src/shapes/circle.ts"]);
    expect((await findSymbolsByName(db, scope, ["Circle.draw"])).map((s) => s.path)).toEqual(["src/shapes/circle.ts"]);
    expect((await findSymbolsByName(db, scope, ["Circ"], { mode: "prefix" })).map((s) => s.qualifiedName)).toEqual([
      "Circle.area",
      "Circle.draw",
      "Circle",
      "Circle",
      "Circle > has an area",
      "Circle.constructor",
    ]);
    expect(await findSymbolsByName(db, scope, ["50%_off"], { mode: "prefix" })).toEqual([]);
    expect(await findSymbolsByName(db, { ...scope, orgId: "org_other" }, ["Circle"])).toEqual([]);
  });

  test("R6.4 searchPaths matches substrings and globs", async () => {
    expect((await searchPaths(db, scope, "shapes/")).map((f) => f.path)).toEqual([
      "src/shapes/base.ts",
      "src/shapes/index.ts",
      "src/shapes/circle.ts",
      "src/shapes/circle.test.ts",
    ]);
    expect((await searchPaths(db, scope, "src/**/*.test.ts")).map((f) => f.path)).toEqual(["src/shapes/circle.test.ts"]);
    expect((await searchPaths(db, scope, "**/*.{go,java}")).map((f) => f.path)).toEqual([
      "src/main/java/com/acme/Base.java",
      "src/main/java/com/acme/Billing.java",
      "src/main/java/com/acme/Payable.java",
      "store/store.go",
      "store/store_test.go",
    ]);
    expect(await searchPaths(db, { ...scope, orgId: "org_other" }, "shapes")).toEqual([]);
  });

  test("R6.4 searchFullText ranks chunks matching a web-style query", async () => {
    const hits = await searchFullText(db, scope, `"orders service"`, 5);
    expect(hits[0]).toMatchObject({ path: "docs/architecture.md", kind: "doc", startLine: 5 });
    expect((await searchFullText(db, scope, "listOrders -express", 10)).map((h) => h.path)).toEqual(["src/orders/service.ts"]);
    expect(await searchFullText(db, scope, "   ", 10)).toEqual([]);
  });

  test("R6.4 nearestSymbols and nearestChunks rank by embedding similarity", async () => {
    const [q] = await embedder.embed(["render drawable"]);
    const near = await nearestSymbols(db, scope, q!, 3);
    expect(near[0]!.name).toBe("render");
    expect(near[0]!.distance).toBeLessThan(near[2]!.distance);
    expect((await nearestSymbols(db, scope, q!, 3, { kinds: ["interface"] })).map((s) => s.name)[0]).toBe("Drawable");
    const [d] = await embedder.embed(["orders stored postgres listed service"]);
    const chunks = await nearestChunks(db, scope, d!, 2);
    expect(chunks[0]).toMatchObject({ path: "docs/architecture.md", startLine: 5 });
    expect(await nearestChunks(db, { ...scope, orgId: "org_other" }, d!, 2)).toEqual([]);
  });

  test("R6.4 callersOf and calleesOf walk call edges", async () => {
    const render = await sym("render");
    const draw = await sym("Circle.draw");
    const callers = await callersOf(db, scope, [render.id]);
    expect(callers.map((c) => [c.symbolId, c.caller?.qualifiedName, c.file.path, c.line])).toEqual([[render.id, "Circle.draw", "src/shapes/circle.ts", 12]]);
    const callees = await calleesOf(db, scope, [draw.id]);
    expect(callees.map((c) => [c.symbolId, c.callee.name, c.callee.path])).toEqual([[draw.id, "render", "src/render.ts"]]);
    expect(await callersOf(db, { ...scope, orgId: "org_other" }, [render.id])).toEqual([]);
  });

  test("R6.4 importersOf lists files importing or re-exporting a file", async () => {
    const base = await fileId("src/shapes/base.ts");
    expect((await importersOf(db, scope, [base])).map((i) => i.importer.path).sort()).toEqual(["src/render.ts", "src/shapes/circle.ts", "src/shapes/index.ts"]);
    expect(await importersOf(db, scope, [])).toEqual([]);
  });

  test("R6.4 testsFor returns test files and their test cases", async () => {
    const circle = await fileId("src/shapes/circle.ts");
    const models = await fileId("billing/models.py");
    const hits = await testsFor(db, scope, [circle, models]);
    expect(hits.map((h) => [h.fileId, h.testFile.path, h.tests.map((t) => t.qualifiedName)])).toEqual([
      [models, "billing/tests/test_invoice.py", ["test_total"]],
      [circle, "src/shapes/circle.test.ts", ["Circle", "Circle > has an area"]],
    ]);
  });

  test("R6.4 routesFor finds routes declared in or handled by files", async () => {
    const server = await fileId("src/api/server.ts");
    const service = await fileId("src/orders/service.ts");
    for (const id of [server, service]) {
      const routes = await routesFor(db, scope, [id]);
      expect(routes.map((r) => [r.route.name, r.route.path, r.handler?.name, r.handler?.path])).toEqual([
        ["GET /orders", "src/api/server.ts", "listOrders", "src/orders/service.ts"],
      ]);
    }
    expect(await routesFor(db, scope, [await fileId("src/render.ts")])).toEqual([]);
  });

  test("R6.4 schemaConsumers lists files and symbols using a table", async () => {
    const table = await sym("orders", "table");
    const consumers = await schemaConsumers(db, scope, [table.id]);
    expect(consumers.map((c) => [c.file.path, c.symbol?.name ?? null])).toEqual([
      ["db/migrations/0002_orders_total.sql", null],
      ["src/orders/service.ts", "listOrders"],
    ]);
  });

  test("R6.4 dependentsOf walks callers and importers transitively up to depth 2", async () => {
    const render = await sym("render");
    const describeDeps = (deps: Awaited<ReturnType<typeof dependentsOf>>) =>
      deps.map((d) => `${d.depth} ${d.via} ${d.kind === "symbol" ? d.symbol!.qualifiedName : d.file.path}`).sort();
    expect(describeDeps(await dependentsOf(db, scope, render.id, { depth: 1 }))).toEqual(["1 call Circle.draw", "1 import src/shapes/circle.ts"]);
    expect(describeDeps(await dependentsOf(db, scope, render.id, { depth: 2 }))).toEqual([
      "1 call Circle.draw",
      "1 import src/shapes/circle.ts",
      "2 import src/shapes/circle.test.ts",
      "2 import src/shapes/index.ts",
    ]);
    // Depth is capped at 2.
    expect(await dependentsOf(db, scope, render.id, { depth: 5 })).toEqual(await dependentsOf(db, scope, render.id, { depth: 2 }));
    const drawable = await sym("Drawable");
    expect(describeDeps(await dependentsOf(db, scope, drawable.id, { depth: 1 }))).toEqual([
      "1 implements Circle",
      "1 import src/render.ts",
      "1 import src/shapes/circle.ts",
      "1 import src/shapes/index.ts",
      "1 reference render",
    ]);
    expect(await dependentsOf(db, { ...scope, orgId: "org_other" }, render.id)).toEqual([]);
  });

  test("R6.4 recentChanges returns commits, optionally only those touching given paths", async () => {
    expect((await recentChanges(db, scope)).map((c) => c.message)).toEqual(["tweak render", "initial"]);
    const touching = await recentChanges(db, scope, { paths: ["src/render.ts"], limit: 1 });
    expect(touching.map((c) => [c.message, c.changedPaths])).toEqual([["tweak render", ["src/render.ts"]]]);
    expect(await recentChanges(db, scope, { paths: ["nope.ts"] })).toEqual([]);
  });

  test("R6.4 repoDependencies lists declared dependencies with filters", async () => {
    expect((await repoDependencies(db, scope)).map((d) => `${d.manifestPath}:${d.name}`)).toEqual([
      "package.json:@acme/core",
      "package.json:express",
      "packages/core/package.json:zod",
    ]);
    expect((await repoDependencies(db, scope, { names: ["zod"] })).map((d) => d.versionSpec)).toEqual(["^3.22.0"]);
    expect(await repoDependencies(db, scope, { ecosystem: "pypi" })).toEqual([]);
  });

  test("R6.4 filesByTag returns files with any of the tags", async () => {
    expect((await filesByTag(db, scope, ["test"])).map((f) => f.path)).toEqual([
      "billing/tests/test_invoice.py",
      "src/shapes/circle.test.ts",
      "store/store_test.go",
    ]);
    expect((await filesByTag(db, scope, ["manifest", "migration"])).map((f) => f.path)).toEqual([
      "db/migrations/0002_orders_total.sql",
      "package.json",
      "packages/core/package.json",
    ]);
    expect(await filesByTag(db, { ...scope, orgId: "org_other" }, ["test"])).toEqual([]);
  });
});
