import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { FindingsTable } from "@/components/dashboard/FindingsTable";
import { OverviewEmpty, OverviewView } from "@/components/dashboard/Overview";
import { ReviewDetailView } from "@/components/dashboard/ReviewDetailView";
import { RunLifecycle } from "@/components/dashboard/RunLifecycle";
import { InstallationHealth } from "@/components/dashboard/InstallationHealth";
import { ShellFrame } from "@/components/shell/ShellFrame";
import { ShellFooter } from "@/components/shell/ShellFooter";
import { activeNavId, NAV_ITEMS } from "@/components/shell/nav";
import { DiffView, parseUnifiedDiff } from "@/components/ui/Code";
import { EmptyState } from "@/components/ui/EmptyState";
import { Markdown } from "@/components/ui/Markdown";
import { Pagination, pageList } from "@/components/ui/Pagination";
import { searchFindings } from "@/lib/data/findings";
import { getOverview } from "@/lib/data/overview";
import { getReviewDetail } from "@/lib/data/reviews";
import { safeReturnPath, toastFor, withToast } from "@/lib/ui/toast";
import { hrefWith } from "@/lib/ui/url";
import { dashboardFixture } from "./helpers/dashboard";

const shell = (pathname: string) =>
  renderToStaticMarkup(
    <ShellFrame pathname={pathname} menuOpen={false} account={<span>account</span>} footer={<ShellFooter sourceUrl="https://git.example.com/me/openreview-fork" version="1.2.3" />}>
      <p>page body</p>
    </ShellFrame>,
  );

describe("dashboard UI (R6.13)", () => {
  test("R6.13 shell renders every nav item, marks the active section, and links the source", () => {
    const html = shell("/dashboard/reviews/42");
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(["Overview", "Repositories", "Reviews", "Findings", "Knowledge", "Rules", "Team", "Usage", "Settings", "Activity"]);
    for (const item of NAV_ITEMS) expect(html).toContain(`href="${item.href}"`);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/<a class="nav-link" data-nav="reviews" aria-current="page" href="\/dashboard\/reviews">/);
    expect(html).toContain('<a class="skip-link" href="#main">Skip to content</a>');
    expect(html).toContain('id="main"');
    expect(html).toContain('aria-controls="app-sidebar"');
    // AGPL §13: a link to the running version's source.
    expect(html).toContain('href="https://git.example.com/me/openreview-fork"');
    expect(html).toContain("v1.2.3");

    expect(activeNavId("/dashboard")).toBe("overview");
    expect(activeNavId("/dashboard/learned")).toBe("rules");
    expect(activeNavId("/dashboard/repos/7?tab=settings")).toBe("repos");
    expect(activeNavId("/dashboard/reviewsx")).toBeNull();
    expect(shell("/dashboard")).toMatch(/data-nav="overview" aria-current="page"/);
  });

  test("R6.13 empty states guide the next step", async () => {
    const admin = renderToStaticMarkup(<OverviewEmpty canInstall />);
    expect(admin).toContain("Connect your first repository");
    expect(admin).toContain('href="/api/github/install"');
    expect(admin).toContain('href="/onboarding"');
    const member = renderToStaticMarkup(<OverviewEmpty canInstall={false} />);
    expect(member).not.toContain("/api/github/install");
    expect(member).toContain("Only owners and admins can install the GitHub App");
    const generic = renderToStaticMarkup(<EmptyState icon="finding" title="No findings yet" actions={<a href="/x">Go</a>}><p>Guidance</p></EmptyState>);
    expect(generic).toMatch(/data-empty-state="".*<svg.*<h2>No findings yet<\/h2>.*Guidance.*href="\/x"/s);

    const fx = await dashboardFixture();
    const overview = renderToStaticMarkup(<OverviewView overview={await getOverview(fx.db, "org_a", fx.now)} now={fx.now} />);
    expect(overview).toContain('data-stat="Findings caught"');
    expect(overview).toContain("33%");
    expect(overview).toContain('role="progressbar"');
    expect(overview).toContain('href="/dashboard/findings?severity=critical"');
    expect(overview).not.toContain("globex");

    const health = renderToStaticMarkup(<InstallationHealth installations={[{ id: 1, accountLogin: "acme", suspended: false, missingPermissions: ["pull_requests:write"] }]} />);
    expect(health).toContain("Pull requests: Read and write");
    expect(health).toContain("<code>pull_requests:write</code>");
    expect(renderToStaticMarkup(<InstallationHealth installations={[]} />)).toBe("");
  });

  test("R6.13 review lifecycle timeline renders each stage state and the failure reason", async () => {
    const fx = await dashboardFixture();
    const failed = (await getReviewDetail(fx.db, "org_a", fx.reviews.r2.review.id))!;
    const html = renderToStaticMarkup(<RunLifecycle run={failed.runHistory[0]!} now={fx.now} />);
    expect(html).toContain('aria-label="Review run lifecycle"');
    expect(html).toMatch(/data-state="done" data-step="queued"/);
    expect(html).toMatch(/data-state="interrupted" data-step="reviewing"/);
    expect(html).toMatch(/data-state="pending" data-step="verifying"/);
    expect(html).toMatch(/data-state="failed" data-step="failed".*engine error — model timed out/s);
    expect(html).toContain("(stopped here)");

    const ok = (await getReviewDetail(fx.db, "org_a", fx.reviews.r1.review.id))!;
    const detail = renderToStaticMarkup(<ReviewDetailView review={ok} now={fx.now} actions={<button>Re-review</button>} />);
    expect(detail).toContain("Adds <strong>billing</strong>.");
    expect(detail).toContain("Findings (2)");
    expect(detail).toContain('href="https://github.com/acme/shop/pull/1#discussion_r555"'.replace("acme/shop", "acme/api"));
    expect(detail).toContain("User input reaches raw SQL");
    expect(detail).toContain('data-testid="rejected-candidates"');
    expect(detail).toMatch(/data-rejected="\d+".*Possible null dereference.*Verify.*the value is checked two lines above/s);
    expect(detail).toContain("<button>Re-review</button>");
    expect(detail).toContain("model-large");
  });

  test("R6.13 findings table links each row to its review and GitHub comment with sortable headers", async () => {
    const fx = await dashboardFixture();
    const page = await searchFindings(fx.db, "org_a", { sort: "severity" });
    const state = { sort: "severity", severity: "critical,high" };
    const html = renderToStaticMarkup(<FindingsTable findings={page.items} pathname="/dashboard/findings" state={state} githubUrl="https://ghe.example.com" now={fx.now} />);
    const crit = fx.findings.fCritical;
    expect(html).toContain(`href="/dashboard/reviews/${crit.reviewId}#finding-${crit.id}-title"`);
    expect(html).toContain('href="https://ghe.example.com/acme/api/pull/1#discussion_r555"');
    expect(html).toContain('data-status="critical"');
    expect(html).toContain('aria-sort="descending"');
    // Clicking the active sort flips the direction; other columns start descending; page resets; filters stay.
    expect(html).toContain('href="/dashboard/findings?dir=asc&amp;severity=critical%2Chigh&amp;sort=severity"');
    expect(html).toContain('href="/dashboard/findings?dir=desc&amp;severity=critical%2Chigh&amp;sort=confidence"');
    expect(html).not.toContain("Possible null dereference");
  });

  test("R6.13 pagination keeps filters in the URL and marks the current page", () => {
    expect(pageList(5, 10)).toEqual([1, null, 4, 5, 6, null, 10]);
    expect(pageList(1, 1)).toEqual([1]);
    const html = renderToStaticMarkup(<Pagination pathname="/dashboard/reviews" state={{ status: "failed", page: "2" }} page={2} pageCount={3} total={60} pageSize={25} noun="reviews" />);
    expect(html).toContain("26–50 of 60 reviews");
    expect(html).toContain('href="/dashboard/reviews?status=failed"');
    expect(html).toContain('href="/dashboard/reviews?page=3&amp;status=failed"');
    expect(html).toContain('<span class="page" aria-current="page">2</span>');
    expect(hrefWith("/x", { a: "1", toast: "z" }, { a: undefined, b: 2 })).toBe("/x?b=2&toast=z");
  });

  test("R6.13 markdown renders the tables, collapsible details, footers, and nested fences review comments use", () => {
    const source = [
      "| Severity | Location |",
      "| --- | --- |",
      "| Critical | `a.ts:1` |",
      "",
      "<details><summary>Fix with AI</summary>",
      "",
      "````markdown",
      "Paste this:",
      "```ts",
      "x()",
      "```",
      "</details>",
      "````",
      "",
      "</details>",
      "",
      "<sub>standard mode</sub>",
      "",
      "New DEFAULT_MAX_PERCENT_OFF constant, _emphasis_ and __strong__.",
      "",
      '<details onclick="alert(1)"><img src=x onerror=alert(1)>',
    ].join("\n");
    const html = renderToStaticMarkup(<Markdown source={source} />);
    expect(html).toContain("<th>Severity</th>");
    expect(html).toContain("<td><code>a.ts:1</code></td>");
    expect(html).toContain("<details><summary>Fix with AI</summary>");
    // The four-backtick fence keeps the inner fence and the </details> inside it as code.
    expect(html).toContain('<pre data-lang="markdown"><code>Paste this:\n```ts\nx()\n```\n&lt;/details&gt;</code></pre></details>');
    expect(html).toContain("<small>standard mode</small>");
    expect(html).toContain("New DEFAULT_MAX_PERCENT_OFF constant, <em>emphasis</em> and <strong>strong</strong>.");
    // Anything else that looks like HTML stays text.
    expect(html).not.toMatch(/<img|<details onclick/);
    expect(html).toContain("&lt;details onclick=");
  });

  test("R6.13 markdown and diffs render untrusted text safely", () => {
    const html = renderToStaticMarkup(
      <Markdown source={"# Title\n\n<script>alert(1)</script> and **bold** with `code`\n\n- [ok](https://example.com)\n- [bad](javascript:alert(1))\n\n```ts\nconst a = '<b>';\n```"} />,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('href="https://example.com/"');
    expect(html).not.toContain("javascript:");
    expect(html).toContain("const a = &#x27;&lt;b&gt;&#x27;;");
    expect(html).toContain("<h3>Title</h3>");

    const diff = "@@ -1,2 +1,3 @@\n context\n-old line\n+new line\n+added <b>";
    expect(parseUnifiedDiff(diff).map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ["hunk", null, null],
      ["ctx", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
    ]);
    const view = renderToStaticMarkup(<DiffView diff={diff} title="src/a.ts" />);
    expect(view).toContain('<tr class="add">');
    expect(view).toContain('<tr class="del">');
    expect(view).toContain("added &lt;b&gt;");
    expect(view).toMatch(/class="wrap-toggle".*type="checkbox"/s);
  });

  test("R6.13 action results use fixed toast codes and same-app return paths", () => {
    expect(toastFor("index.queued")).toMatchObject({ tone: "success" });
    expect(toastFor("<img src=x>")).toBeNull();
    expect(toastFor("constructor")).toBeNull();
    expect(withToast("/dashboard/repos?q=a&toast=old", "repo.enabled")).toBe("/dashboard/repos?q=a&toast=repo.enabled");
    expect(safeReturnPath("/dashboard/repos?page=2", "/f")).toBe("/dashboard/repos?page=2");
    for (const bad of ["https://evil.example", "//evil.example/dashboard", "/dashboardx", "/dashboard\\..\\x", 42]) expect(safeReturnPath(bad, "/f")).toBe("/f");
  });
});
