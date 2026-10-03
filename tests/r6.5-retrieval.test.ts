import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MODE_PROFILES } from "@/lib/engine";
import { retrieveContext, retrieveForQuestion, type ContextBundle, type RetrievalInput } from "@/lib/retrieval";
import { parsePatch } from "@/lib/review/diff";
import { patchBetween, PRICING, readAt, type Fixture } from "./helpers/engine";
import { reviewFixture } from "./helpers/review-fixture";

const EXTRA = {
  "services/billing/pricing.test.ts": `import { computeTotal } from "./pricing";\n\ntest("sums items", () => {\n  expect(computeTotal([1, 2])).toBe(3);\n});\n`,
  "services/billing/tax-mode.ts": `// TAX_MODE selects inclusive or exclusive pricing.\nexport const defaultTaxMode = "inclusive";\n`,
  "services/api/router.ts": `import { handleCheckout } from "./handlers";\n\nexport function route(path: string, body: { items: number[] }) {\n  return path === "/checkout" ? handleCheckout(body) : null;\n}\n`,
  "src/api/server.ts": `import express from "express";\nimport { listOrders } from "../orders/service";\n\nconst router = express.Router();\nrouter.get("/orders", listOrders);\n`,
  "src/orders/service.ts": `import { orders } from "../db/schema";\n\nexport function listOrders() {\n  return db.select().from(orders);\n}\n`,
  "src/db/schema.ts": `import { pgTable, serial } from "drizzle-orm/pg-core";\n\nexport const orders = pgTable("orders", { id: serial("id") });\n`,
  "docs/billing.md": `# Billing\n\nTotals are computed by computeTotal in the billing service and include tax.\n`,
  "CONTRIBUTING.md": `# Contributing\n\nAll money values are integer cents.\n`,
  "package.json": `{\n  "name": "shop",\n  "dependencies": {\n    "express": "^4.18.2"\n  }\n}\n`,
};

let fx: Fixture;
beforeAll(async () => {
  fx = await reviewFixture({ baseExtra: EXTRA });
});
afterAll(() => fx.fixture.cleanup());

/** Retrieval input for edits to files of the base commit (head content given per path). */
function inputFor(edits: Record<string, string | null>, over: Partial<RetrievalInput> = {}): RetrievalInput {
  const head = new Map<string, string>();
  const base = new Map<string, string>();
  const diffs = Object.entries(edits).map(([path, after]) => {
    const before = readAt(fx.fixture, fx.base, path);
    if (before !== null) base.set(path, before);
    if (after !== null) head.set(path, after);
    return parsePatch(path, before === null ? "added" : after === null ? "removed" : "modified", patchBetween(before, after));
  });
  return { orgId: "org_a", repoId: fx.repo.id, mode: "deep", diffs, headContent: head, baseContent: base, ...over };
}

const prInput = (over: Partial<RetrievalInput> = {}) => inputFor({ [PRICING]: readAt(fx.fixture, fx.head, PRICING)! }, over);

function reasonsAt(b: ContextBundle, path: string): string[] {
  return b.items.filter((i) => i.path === path).flatMap((i) => i.reasons);
}

const HANDLERS_HEAD = `import { computeTotal } from "../billing/pricing";
import { taxFor } from "../billing/tax";

export function handleCheckout(req: { items: number[] }) {
  const mode = process.env.TAX_MODE ?? "inclusive";
  const guide = "docs/billing.md";
  return { total: computeTotal(req.items), tax: taxFor(1), mode, guide };
}
`;

describe("retrieval engine", () => {
  test("R6.5 graph sources: definitions, callers, callees, importers, dependents, tests, recent changes, each with reasons", async () => {
    const b = await retrieveContext({ db: fx.db, embedder: fx.embedder }, prInput());
    const def = b.items.find((i) => i.kind === "definition")!;
    expect(def).toMatchObject({ path: PRICING, startLine: 3, endLine: 6, free: true, reasons: ["modified symbol computeTotal (head definition)"] });
    expect(reasonsAt(b, "services/api/handlers.ts")).toEqual(
      expect.arrayContaining([
        "calls changed symbol computeTotal (services/billing/pricing.ts)",
        "imports changed file services/billing/pricing.ts",
        "depends on changed symbol computeTotal",
      ]),
    );
    expect(reasonsAt(b, "services/billing/tax.ts")).toContain("called by changed symbol computeTotal");
    // Depth 2: the router depends on handleCheckout, which depends on computeTotal.
    expect(reasonsAt(b, "services/api/router.ts")).toContain("depends transitively (depth 2) on changed symbol computeTotal");
    expect(reasonsAt(b, "services/billing/pricing.test.ts")).toContain("tests services/billing/pricing.ts");
    expect(b.tests).toEqual([{ path: "services/billing/pricing.test.ts", note: "covers services/billing/pricing.ts (1 test)" }]);
    expect(b.items.some((i) => i.kind === "recent_change" && i.reasons[0] === "changed together with services/billing/pricing.ts recently")).toBe(true);
    expect(reasonsAt(b, "package.json")).toContain("manifest of the package containing services/billing/pricing.ts");
    expect(b.externalDependents[0]).toMatchObject({ symbol: "computeTotal", path: PRICING });
    // Changed files' own (stale) index content never appears as context; the head definition does.
    expect(b.items.filter((i) => i.path === PRICING).map((i) => i.kind)).toEqual(["definition"]);
  });

  test("R6.5 lexical sources: exact symbol, path, and full-text search for identifiers and constants the diff introduces", async () => {
    const b = await retrieveContext({ db: fx.db }, inputFor({ "services/api/handlers.ts": HANDLERS_HEAD }));
    expect(reasonsAt(b, "services/billing/tax.ts")).toContain("defines taxFor, referenced in the diff");
    expect(reasonsAt(b, "docs/billing.md")).toContain('matches path "docs/billing.md" referenced in the diff');
    expect(reasonsAt(b, "services/billing/tax-mode.ts")).toEqual(expect.arrayContaining(['mentions "TAX_MODE", introduced in the diff', 'mentions "inclusive", introduced in the diff']));
  });

  test("R6.5 routes, schema consumers, embeddings, docs, instructions, context docs, history, and rules", async () => {
    const service = readAt(fx.fixture, fx.base, "src/orders/service.ts")!.replace("return db.select().from(orders);", "return db.select().from(orders).limit(100);");
    const schema = readAt(fx.fixture, fx.base, "src/db/schema.ts")!.replace('{ id: serial("id") }', '{ id: serial("id"), total: serial("total") }');
    const routeBundle = await retrieveContext({ db: fx.db }, inputFor({ "src/orders/service.ts": service }));
    expect(reasonsAt(routeBundle, "src/api/server.ts")).toContain("route GET /orders handled by listOrders touches changed code");
    const schemaBundle = await retrieveContext({ db: fx.db }, inputFor({ "src/db/schema.ts": schema }));
    expect(reasonsAt(schemaBundle, "src/orders/service.ts")).toContain("uses table orders changed by the PR");

    const b = await retrieveContext(
      { db: fx.db, embedder: fx.embedder },
      prInput({
        contextDocs: [{ path: "docs/adr/0001-money.md", content: "Money is stored in cents." }],
        historicalFindings: [
          { title: "Total ignores discounts", category: "correctness", path: PRICING, status: "fixed", feedback: "useful" },
          { title: "Unrelated", category: "correctness", path: "workers/report.py", status: "open" },
        ],
        rules: [
          { id: "rule:1", text: "Billing code must use integer cents.", paths: ["services/billing/**"], scope: "org" },
          { id: "rule:2", text: "Workers must be idempotent.", paths: ["workers/**"], scope: "org" },
        ],
      }),
    );
    expect(b.items.some((i) => i.kind === "similar_code" || i.reasons.some((r) => r.startsWith("similar to the changed code")))).toBe(true);
    expect(reasonsAt(b, "docs/billing.md")).toContain("documentation related to the change");
    expect(reasonsAt(b, "CONTRIBUTING.md")).toContain("repository instructions");
    expect(reasonsAt(b, "docs/adr/0001-money.md")).toEqual(["context file configured for this repository"]);
    expect(b.items.filter((i) => i.kind === "history").map((i) => [i.name, i.reasons])).toEqual([["Total ignores discounts", ["earlier finding on a changed file"]]]);
    expect(b.items.filter((i) => i.kind === "rule").map((i) => i.name)).toEqual(["rule:1"]);
  });

  test("R6.5 merges overlapping ranges of one file into one item that keeps every reason", async () => {
    const b = await retrieveContext({ db: fx.db, embedder: fx.embedder }, prInput());
    const handlers = b.items.filter((i) => i.path === "services/api/handlers.ts" && i.startLine > 0);
    expect(handlers).toHaveLength(1);
    expect(handlers[0]).toMatchObject({ startLine: 1, endLine: 5, kind: "caller" });
    expect(handlers[0]!.content.split("\n")).toHaveLength(5);
    expect(handlers[0]!.score).toBeGreaterThan(0.9); // bonus for being reached several ways
    const keys = b.items.map((i) => `${i.kind}:${i.path}:${i.startLine}:${i.name}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("R6.5 budgets context by mode, drops the lowest scores first, and does not charge changed code", async () => {
    const budgets = await Promise.all((["fast", "standard", "deep"] as const).map((mode) => retrieveContext({ db: fx.db }, prInput({ mode }))));
    expect(budgets.map((b) => b.tokenBudget)).toEqual([12_000, 40_000, 100_000]);

    const full = await retrieveContext({ db: fx.db, embedder: fx.embedder }, prInput());
    const paid = full.items.filter((i) => !i.free);
    const tight = await retrieveContext({ db: fx.db, embedder: fx.embedder }, prInput({ tokenBudget: 60 }));
    expect(tight.tokensUsed).toBeLessThanOrEqual(60);
    expect(tight.dropped).toBeGreaterThan(0);
    expect(tight.dropped + tight.items.filter((i) => !i.free).length).toBe(paid.length);
    // The definition is free; the best-scored context survives; the lowest-scored is the first to go.
    expect(tight.items.some((i) => i.kind === "definition")).toBe(true);
    expect(tight.items.some((i) => i.path === "services/api/handlers.ts")).toBe(true);
    const lowest = [...paid].sort((a, b) => a.score - b.score)[0]!;
    expect(tight.droppedItems.some((d) => d.path === lowest.path && d.kind === lowest.kind)).toBe(true);
  });

  test("R6.5 is tenant-isolated and deterministic", async () => {
    const other = await retrieveContext({ db: fx.db, embedder: fx.embedder }, prInput({ orgId: "org_b" }));
    expect(other.items.map((i) => i.kind)).toEqual(["definition"]);
    expect(other.changed[0]!.indexId).toBeNull();
    const a = await retrieveContext({ db: fx.db, embedder: fx.embedder }, prInput());
    const b = await retrieveContext({ db: fx.db, embedder: fx.embedder }, prInput());
    expect(b).toEqual(a);
  });

  test("R6.5 retrieveForQuestion finds code a question names, plus the PR's graph context", async () => {
    const q = await retrieveForQuestion({ db: fx.db, embedder: fx.embedder }, { orgId: "org_a", repoId: fx.repo.id, question: "What does `build_report` return, and where is docs/billing.md used?" });
    expect(reasonsAt(q, "workers/report.py")).toContain("named in the question (build_report)");
    expect(reasonsAt(q, "docs/billing.md")).toContain("path named in the question (docs/billing.md)");
    const withPr = await retrieveForQuestion(
      { db: fx.db },
      { orgId: "org_a", repoId: fx.repo.id, question: "Who calls computeTotal?", prDiffs: prInput().diffs, headContent: prInput().headContent },
    );
    expect(reasonsAt(withPr, "web/cart/summary.ts")).toContain("calls changed symbol computeTotal (services/billing/pricing.ts)");
    const isolated = await retrieveForQuestion({ db: fx.db }, { orgId: "org_b", repoId: fx.repo.id, question: "What does `build_report` return?" });
    expect(isolated.items).toEqual([]);
  });
  test("R6.5 a symbol renamed inside a modified file keeps the new head definition and the removed base definition apart", async () => {
    const path = "src/totals.ts";
    const before = `export function oldTotal(items: number[]) {\n  let sum = 0;\n  for (const i of items) sum += i;\n  return sum;\n}\n`;
    const after = `export function newTotal(items: number[]) {\n  return items.reduce((a, b) => a + b, 0);\n}\n`;
    const b = await retrieveContext(
      { db: fx.db },
      {
        orgId: "org_a",
        repoId: fx.repo.id,
        mode: "standard",
        diffs: [parsePatch(path, "modified", patchBetween(before, after))],
        headContent: new Map([[path, after]]),
        baseContent: new Map([[path, before]]),
      },
    );
    const defs = b.items.filter((i) => i.kind === "definition" && i.path === path);
    const head = defs.find((d) => d.name === "newTotal");
    const removed = defs.find((d) => d.name === "oldTotal");
    expect(head).toMatchObject({ startLine: 1, endLine: 3, reasons: ["added symbol newTotal (head definition)"] });
    expect(head!.version).toBeUndefined();
    expect(head!.content).toContain("items.reduce");
    expect(head!.content).not.toContain("let sum");
    expect(removed).toMatchObject({ version: "base", startLine: 1, endLine: 5, reasons: ["symbol oldTotal removed by the PR (base definition)"] });
    expect(removed!.content).toContain("let sum");
    expect(removed!.content).not.toContain("items.reduce");
  });

  test("R6.5 definitions of changed symbols have their own cap and never exceed it", async () => {
    const path = "src/many.ts";
    const fn = (n: number, v: string) =>
      `export function handler${n}(input: { id: string; values: number[] }) {\n${Array.from({ length: 25 }, (_, k) => `  const step${k} = input.values.map((x) => x * ${k + 1} + ${v}).filter((x) => x > ${k});`).join("\n")}\n  return step0.length;\n}\n`;
    const before = Array.from({ length: 40 }, (_, n) => fn(n, "1")).join("\n");
    const after = Array.from({ length: 40 }, (_, n) => fn(n, "2")).join("\n");
    const b = await retrieveContext(
      { db: fx.db },
      { orgId: "org_a", repoId: fx.repo.id, mode: "fast", diffs: [parsePatch(path, "modified", patchBetween(before, after))], headContent: new Map([[path, after]]), baseContent: new Map([[path, before]]) },
    );
    const defs = b.items.filter((i) => i.free);
    expect(b.changed.length).toBe(40);
    expect(defs.length).toBeGreaterThan(0);
    expect(defs.reduce((n, i) => n + i.tokens, 0)).toBeLessThanOrEqual(MODE_PROFILES.fast.definitionTokens);
    expect(b.droppedItems.some((i) => i.free && i.kind === "definition")).toBe(true);
    expect(b.dropped).toBe(b.droppedItems.length);
  });
});
