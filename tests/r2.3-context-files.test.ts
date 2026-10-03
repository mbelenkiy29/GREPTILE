import { afterEach, describe, expect, test } from "vitest";
import { updateRepoSettings } from "@/lib/data/installations";
import { FakeLlm } from "@/lib/llm/fake";
import { loadContextDocs } from "@/lib/review/context-files";
import { answerMention } from "@/lib/review/mention";
import { runReviewJob } from "@/lib/review/run";
import { engineLlm, reviewCalls } from "./helpers/engine";
import { reviewFixture } from "./helpers/review-fixture";

type Fixture = Awaited<ReturnType<typeof reviewFixture>>;
let fx: Fixture | undefined;
afterEach(() => fx?.fixture.cleanup());

const llm = () => engineLlm();

/** The context document `path` as a nonce-tagged data block in a prompt, followed by the start of its content. */
const docBlock = (path: string, start: string) =>
  new RegExp(`<repo_doc nonce="[0-9a-f]{16}" path="${path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"[^>]*kind="context_doc"[^>]*>\n${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

const DOCS = {
  "CONTRIBUTING.md": "# Contributing\n\nAll money values are integer cents. Never use floats for currency.\n",
  "docs/adr/0001-currency.md": "# ADR 1: Currency\n\nDecision: amounts are stored as bigint cents.\n",
  "docs/adr/0002-regions.md": "# ADR 2: Regions\n\nRegion must be resolved from the account, not passed by callers.\n",
  "docs/notes.txt": "not context\n",
};

describe("context files", () => {
  test("R2.3 docs listed in openreview.json (paths and globs) are always included in review prompts", async () => {
    fx = await reviewFixture({
      baseExtra: { ...DOCS, "openreview.json": JSON.stringify({ context: ["CONTRIBUTING.md", "docs/adr/*.md", "docs/missing.md", "rfcs/*.md"] }) },
    });
    const model = llm();
    await runReviewJob({ db: fx.db, host: fx.host, llm: model, embedder: fx.embedder }, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head });

    const reviewers = reviewCalls(model);
    expect(reviewers.length).toBeGreaterThan(0);
    for (const call of reviewers) {
      const prompt = call.req.prompt;
      expect(prompt).toMatch(docBlock("CONTRIBUTING.md", "# Contributing\n\nAll money values are integer cents."));
      expect(prompt).toMatch(docBlock("docs/adr/0001-currency.md", "# ADR 1: Currency"));
      expect(prompt).toMatch(docBlock("docs/adr/0002-regions.md", "# ADR 2: Regions"));
      expect(prompt).not.toContain("not context");
    }
    const summary = fx.host.issueComments.get("acme/shop#7")![0]!.body;
    expect(summary).toContain("> **Note:** Context file `docs/missing.md` was not found.");
    expect(summary).toContain("> **Note:** Context pattern `rfcs/*.md` matched no files.");
  });

  test("R2.3 dashboard context files apply when the repo has no config, and mention answers include them", async () => {
    fx = await reviewFixture({ baseExtra: DOCS });
    await updateRepoSettings(fx.db, "org_a", fx.repo.id, { context: ["docs/adr/0002-regions.md"] });
    const model = llm();
    await runReviewJob({ db: fx.db, host: fx.host, llm: model, embedder: fx.embedder }, { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, headSha: fx.head });
    const correctness = reviewCalls(model).find((c) => c.req.meta?.agent === "correctness")!.req.prompt;
    expect(correctness).toMatch(docBlock("docs/adr/0002-regions.md", "# ADR 2: Regions"));
    // Only the dashboard's list is configured context (the index may still offer CONTRIBUTING.md as instructions).
    expect(correctness).not.toMatch(docBlock("CONTRIBUTING.md", ""));
    expect(correctness).not.toMatch(docBlock("docs/adr/0001-currency.md", ""));

    const mentionLlm = new FakeLlm(() => "ok");
    await answerMention(
      { db: fx.db, host: fx.host, llm: mentionLlm, embedder: fx.embedder, botMention: "openreview" },
      { orgId: "org_a", repoId: fx.repo.id, prNumber: 7, commentId: 1, body: "@openreview should callers pass region?", author: "a" },
    );
    expect(mentionLlm.calls[0]!.req.prompt).toMatch(docBlock("docs/adr/0002-regions.md", "# ADR 2: Regions\n\nRegion must be resolved from the account, not passed by callers."));
  });

  test("R2.3 context is capped per file and in total", async () => {
    fx = await reviewFixture({
      baseExtra: { "docs/big.md": "x".repeat(20_000), ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`docs/m${i}.md`, "y".repeat(11_000)])) },
    });
    const { docs, notices } = await loadContextDocs(fx.client, "acme/shop", fx.base, ["docs/big.md", "docs/m*.md"]);
    expect(docs[0]).toMatchObject({ path: "docs/big.md", truncated: true });
    expect(docs[0]!.content).toHaveLength(12_000);
    expect(docs.reduce((n, d) => n + d.content.length, 0)).toBeLessThanOrEqual(40_000);
    expect(notices.some((n) => n.startsWith("Context budget reached"))).toBe(true);
  });
});
