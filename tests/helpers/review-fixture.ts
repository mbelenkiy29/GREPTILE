import { completeInstallation } from "@/lib/data/installations";
import type { Db } from "@/lib/db";
import { indexRepo } from "@/lib/indexer";
import { FakeEmbeddings } from "@/lib/llm/fake";
import { createTestDb } from "./db";
import { FakeGitHost } from "./fake-git";
import { FixtureRepo, tempDir } from "./fixture-repo";
import { addPrFromFixture } from "./pr";

export const BASE_FILES = {
  "services/billing/pricing.ts": `export function computeTotal(items: number[]) {
  return items.reduce((a, b) => a + b, 0);
}
`,
  "services/billing/tax.ts": `export function taxFor(amount: number) {
  return Math.round(amount * 0.2);
}
`,
  "services/api/handlers.ts": `import { computeTotal } from "../billing/pricing";

export function handleCheckout(req: { items: number[] }) {
  return { total: computeTotal(req.items) };
}
`,
  "web/cart/summary.ts": `import { computeTotal } from "../../services/billing/pricing";

export function renderSummary(items: number[]) {
  return "Total: " + computeTotal(items);
}
`,
  "workers/report.py": `def build_report(rows):
    return len(rows)
`,
};

export const HEAD_PRICING = `import { taxFor } from "./tax";

export function computeTotal(items: number[], region: string) {
  const subtotal = items.reduce((a, b) => a + b, 0);
  return subtotal + taxFor(subtotal);
}
`;

/** An indexed repo plus a PR that changes `computeTotal` (called from two other components). */
export async function reviewFixture() {
  const db: Db = await createTestDb();
  const fixture = new FixtureRepo();
  const base = fixture.commit(BASE_FILES, "base");
  const host = new FakeGitHost();
  host.addInstallation(11, "acme", [{ id: 1, fullName: "acme/shop", defaultBranch: "main", private: true }]);
  host.cloneUrls.set("acme/shop", fixture.url);
  const { repos } = await completeInstallation(db, host, { orgId: "org_a", orgName: "Acme", installationId: 11 });
  const repo = repos[0]!;
  const embedder = new FakeEmbeddings();
  await indexRepo({ db, host, embedder, cacheDir: tempDir() }, { orgId: "org_a", repoId: repo.id });

  fixture.git("checkout", "--quiet", "-b", "feature");
  const head = fixture.commit({ "services/billing/pricing.ts": HEAD_PRICING }, "add tax");
  const pr = addPrFromFixture(host, fixture, "acme/shop", {
    number: 7,
    base,
    head,
    title: "Add tax to totals",
    body: "Totals now include tax.",
  });
  return { db, fixture, host, repo, embedder, pr, base, head, client: host.client() };
}
