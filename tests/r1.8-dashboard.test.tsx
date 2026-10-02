import { afterEach, describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReposTable } from "@/components/dashboard/ReposTable";
import { ReviewDetailView } from "@/components/dashboard/ReviewDetailView";
import { ReviewsTable } from "@/components/dashboard/ReviewsTable";
import { completeInstallation, listRepos } from "@/lib/data/installations";
import { getReviewDetail, listReviews } from "@/lib/data/reviews";
import { repos } from "@/lib/db/schema";
import { FakeLlm, type FakeCall } from "@/lib/llm/fake";
import { runReviewJob } from "@/lib/review/run";
import { reviewFixture } from "./helpers/review-fixture";

type Fixture = Awaited<ReturnType<typeof reviewFixture>>;
let fx: Fixture | undefined;
afterEach(() => fx?.fixture.cleanup());

const agentOf = (call: FakeCall) => /OpenReview's (\w+) reviewer/.exec(call.req.system)?.[1] ?? "summary";

async function reviewedFixture() {
  const f = await reviewFixture();
  const llm = new FakeLlm((call) =>
    agentOf(call) === "summary"
      ? { whatChanged: ["Adds tax", "Adds region parameter"], riskLevel: "high", riskRationale: "r", confidence: 2 }
      : {
          findings:
            agentOf(call) === "logic"
              ? [{ path: "services/billing/pricing.ts", line: 3, endLine: null, severity: "high", title: "Callers break", body: "Two callers pass one argument.", suggestion: null, confidence: 5 }]
              : [],
        },
  );
  await runReviewJob({ db: f.db, host: f.host, llm, embedder: f.embedder }, { orgId: "org_a", repoId: f.repo.id, prNumber: 7, headSha: f.head });
  // A second org with its own review that must never leak into org_a's dashboard.
  f.host.addInstallation(22, "globex", [{ id: 2, fullName: "globex/core", defaultBranch: "main", private: true }]);
  await completeInstallation(f.db, f.host, { orgId: "org_b", orgName: "Globex", installationId: 22 });
  return f;
}

describe("dashboard", () => {
  test("R1.8 repos list shows each repository's index status", async () => {
    fx = await reviewedFixture();
    await fx.db.insert(repos).values({ orgId: "org_a", installationId: fx.repo.installationId, externalId: 3, fullName: "acme/broken", indexStatus: "failed", indexError: "clone failed: 404" });
    const rows = await listRepos(fx.db, "org_a");
    expect(rows.map((r) => [r.fullName, r.indexStatus])).toEqual([
      ["acme/broken", "failed"],
      ["acme/shop", "ready"],
    ]);
    const html = renderToStaticMarkup(<ReposTable repos={rows} />);
    expect(html).toContain('data-repo="acme/shop"');
    expect(html).toMatch(/acme\/shop.*badge badge-ok">ready<.*<td class="num">5<\/td><td class="num">5<\/td>/s);
    expect(html).toContain('badge badge-bad">failed</span><div class="error-text">clone failed: 404</div>');
    expect(html).toContain(fx.base.slice(0, 7));
    expect(renderToStaticMarkup(<ReposTable repos={[]} />)).toContain("Connect GitHub");
  });

  test("R1.8 reviews list shows PR, status, comment count, and credits used for the org only", async () => {
    fx = await reviewedFixture();
    const list = await listReviews(fx.db, "org_a");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ repoFullName: "acme/shop", prNumber: 7, prTitle: "Add tax to totals", prAuthor: "dev", status: "completed", riskLevel: "high", commentCount: 1, creditsUsed: 1 });
    expect(await listReviews(fx.db, "org_b")).toEqual([]);

    const html = renderToStaticMarkup(<ReviewsTable reviews={list} />);
    expect(html).toContain(`href="/dashboard/reviews/${list[0]!.id}"`);
    expect(html).toContain("acme/shop#7");
    expect(html).toContain("Add tax to totals");
    expect(html).toContain('href="https://github.com/acme/shop/pull/7"');
    expect(html).toContain('badge badge-ok">completed<');
    expect(html).toMatch(/<td class="num">1<\/td><td class="num">1<\/td>/);
  });

  test("R1.8 review detail shows the outcome, usage, and every inline comment; other orgs get nothing", async () => {
    fx = await reviewedFixture();
    const id = (await listReviews(fx.db, "org_a"))[0]!.id;
    const detail = (await getReviewDetail(fx.db, "org_a", id))!;
    expect(detail).toMatchObject({ prNumber: 7, confidence: 2, summary: "Adds tax\nAdds region parameter", runs: 1, creditsUsed: 1 });
    expect(detail.comments.map((c) => [c.path, c.line, c.severity, c.title])).toEqual([["services/billing/pricing.ts", 3, "high", "Callers break"]]);
    expect(detail.usage?.inputTokens).toBeGreaterThan(0);
    expect(await getReviewDetail(fx.db, "org_b", id)).toBeUndefined();

    const html = renderToStaticMarkup(<ReviewDetailView review={detail} />);
    expect(html).toContain("Confidence 2/5");
    expect(html).toContain("<li>Adds tax</li><li>Adds region parameter</li>");
    expect(html).toContain("Inline comments (1)");
    expect(html).toContain(`href="https://github.com/acme/shop/blob/${fx.head}/services/billing/pricing.ts#L3"`);
    expect(html).toContain("Two callers pass one argument.");
    expect(html).toContain("<dt>Credits used</dt><dd>1</dd>");

  });
});
