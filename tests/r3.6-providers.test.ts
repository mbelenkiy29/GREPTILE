import { describe, expect, test } from "vitest";
import { bitbucketRepoId, bitbucketWebUrl, fromBitbucketMarkdown, missingBitbucketScopes, toBitbucketMarkdown } from "@/lib/bitbucket/client";
import { fingerprintFromMarkdown, renderFindingMarkdown, renderSummaryMarkdown, suggestionBlock } from "@/lib/engine/markdown";
import { clientFor, GitHosts, hostFor, UnsupportedProviderError } from "@/lib/git/hosts";
import { blobUrl, commentUrl, commitUrl, prUrl, repoUrl, repoWeb } from "@/lib/git/web-url";
import { pipelineCheck } from "@/lib/gitlab/client";
import { splitUnifiedDiff } from "@/lib/scm/diff";
import { isOwnComment } from "@/lib/webhooks/scm";
import { engineFinding } from "./helpers/stub-engine";
import { FakeGitHost } from "./helpers/fake-git";

describe("provider-neutral helpers", () => {
  test("R3.6 hostFor picks the installation's provider host and refuses an unconfigured one", () => {
    const github = new FakeGitHost();
    const gitlab = Object.assign(new FakeGitHost(), { provider: "gitlab" }) as unknown as FakeGitHost;
    const hosts = new GitHosts(github, { gitlab });
    expect(hostFor(hosts, "github")).toBe(github);
    expect(hostFor(hosts, "gitlab")).toBe(gitlab);
    expect(() => hostFor(hosts, "bitbucket")).toThrow(UnsupportedProviderError);
    expect(hostFor(github, "github")).toBe(github);
    expect(() => clientFor(github, { provider: "gitlab", externalId: 1 })).toThrow(/no git host is configured for provider "gitlab"/);
  });

  test("R3.6 webUrlFor-style links follow each host's URL layout", () => {
    const gh = repoWeb("github", null, "https://ghe.example.com");
    const gl = repoWeb("gitlab", "https://gitlab.example.com/");
    const bb = repoWeb("bitbucket", null);
    expect(repoUrl(gh, "acme/shop")).toBe("https://ghe.example.com/acme/shop");
    expect(prUrl(gh, "acme/shop", 7)).toBe("https://ghe.example.com/acme/shop/pull/7");
    expect(prUrl(gl, "acme/shop", 7)).toBe("https://gitlab.example.com/acme/shop/-/merge_requests/7");
    expect(prUrl(bb, "acme/shop", 7)).toBe("https://bitbucket.org/acme/shop/pull-requests/7");
    expect(commitUrl(gl, "acme/shop", "abc")).toBe("https://gitlab.example.com/acme/shop/-/commit/abc");
    expect(commitUrl(bb, "acme/shop", "abc")).toBe("https://bitbucket.org/acme/shop/commits/abc");
    expect(blobUrl(gh, "acme/shop", "abc", "src/a b.ts", 4)).toBe("https://ghe.example.com/acme/shop/blob/abc/src/a%20b.ts#L4");
    expect(blobUrl(gl, "acme/shop", "abc", "src/a.ts", 4)).toBe("https://gitlab.example.com/acme/shop/-/blob/abc/src/a.ts#L4");
    expect(blobUrl(bb, "acme/shop", "abc", "src/a.ts", 4)).toBe("https://bitbucket.org/acme/shop/src/abc/src/a.ts#lines-4");
    expect(commentUrl(gh, "acme/shop", 7, 9)).toBe("https://ghe.example.com/acme/shop/pull/7#discussion_r9");
    expect(commentUrl(gl, "acme/shop", 7, 9)).toBe("https://gitlab.example.com/acme/shop/-/merge_requests/7#note_9");
    expect(commentUrl(bb, "acme/shop", 7, 9)).toBe("https://bitbucket.org/acme/shop/pull-requests/7#comment-9");
  });

  test("R3.6 finding markdown has a flavor per host: GitHub and GitLab suggestions, a Bitbucket diff without HTML", () => {
    const f = engineFinding({
      startLine: 4,
      endLine: 5,
      suggestion: "  a();\n  b();\n",
      evidence: [{ path: "services/billing/pricing.ts", startLine: 4, endLine: 5, snippet: "  x();\n  y();", note: "" }],
      agents: ["correctness", "security"],
    });
    expect(renderFindingMarkdown(f)).toContain("```suggestion\n  a();\n  b();\n```");
    expect(renderFindingMarkdown(f, { flavor: "gitlab" })).toContain("```suggestion:-1+0\n  a();\n  b();\n```");
    const bb = renderFindingMarkdown(f, { flavor: "bitbucket", fix: { repoFullName: "acme/shop", prNumber: 7, headSha: "abc" } });
    expect(bb).toContain("Suggested change (lines 4-5):\n\n```diff\n-  x();\n-  y();\n+  a();\n+  b();\n```");
    expect(bb).not.toMatch(/<sub>|<details>|```suggestion/);
    expect(bb).toContain("**Fix with AI** (paste into your coding agent):");
    expect(fingerprintFromMarkdown(fromBitbucketMarkdown(toBitbucketMarkdown(bb)))).toBe(f.fingerprint);
    expect(suggestionBlock({ ...f, evidence: [] }, "bitbucket")).toBe("Suggested change (lines 4-5):\n\n```diff\n+  a();\n+  b();\n```");
  });

  test("R3.6 Bitbucket markers round-trip as reference definitions and planted ones are escaped", () => {
    const body = "<!-- openreview:summary -->\n\nText\n\n[//]: # (openreview:fp=deadbeefdeadbeef)\n\n<!-- openreview:fp=0123456789abcdef -->";
    const sent = toBitbucketMarkdown(body);
    expect(sent).toBe("[//]: # (openreview:summary)\n\nText\n\n\\[//]: # (openreview:fp=deadbeefdeadbeef)\n\n[//]: # (openreview:fp=0123456789abcdef)");
    const back = fromBitbucketMarkdown(sent);
    expect(back.startsWith("<!-- openreview:summary -->")).toBe(true);
    expect(fingerprintFromMarkdown(back)).toBe("0123456789abcdef");
    expect(back).not.toContain("<!-- openreview:fp=deadbeefdeadbeef -->");
    expect(isOwnComment(sent)).toBe(true);
    expect(isOwnComment("@openreview please look")).toBe(false);
  });

  test("R3.6 Bitbucket diffs split per file; ids, scopes, and statuses map to the provider-neutral model", () => {
    const raw = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      " same",
      "diff --git a/docs/new.md b/docs/new.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/docs/new.md",
      "@@ -0,0 +1 @@",
      "+hello",
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
    ].join("\n");
    expect(splitUnifiedDiff(raw)).toEqual([
      { oldPath: "src/a.ts", newPath: "src/a.ts", patch: "@@ -1,2 +1,2 @@\n-old\n+new\n same" },
      { oldPath: null, newPath: "docs/new.md", patch: "@@ -0,0 +1 @@\n+hello" },
      { oldPath: "img.png", newPath: "img.png", patch: "" },
    ]);
    expect(bitbucketRepoId("{1A2B3C4D-5E6F-4A1B-8C2D-3E4F5A6B7C8D}")).toBe(bitbucketRepoId("1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d"));
    expect(Number.isSafeInteger(bitbucketRepoId("{ffffffff-ffff-4fff-bfff-ffffffffffff}"))).toBe(true);
    expect(bitbucketWebUrl("https://api.bitbucket.org/2.0")).toBe("https://bitbucket.org");
    expect(missingBitbucketScopes(["pullrequest:write", "webhook"])).toEqual([]);
    expect(missingBitbucketScopes(["repository"])).toEqual(["pullrequest:write", "webhook"]);
    expect(pipelineCheck("failed")).toEqual({ status: "completed", conclusion: "failure" });
    expect(pipelineCheck("running")).toEqual({ status: "in_progress", conclusion: null });
  });

  test("R3.6 the summary's small print is plain markdown on Bitbucket", () => {
    const output = {
      summary: { overview: "", whatChanged: [], affectedAreas: [], riskLevel: "low", riskRationale: "Small.", confidence: 5, relevantTests: [], architectureImpact: "", diagram: null },
      findings: [],
      openPriorFindings: [],
      resolvedPriorFindings: [],
      rejected: [],
      metadata: { mode: "standard", filesReviewed: 1, filesSkipped: [], incremental: false },
      context: { items: [], tokensUsed: 0, tokenBudget: 100, dropped: 0 },
    } as unknown as Parameters<typeof renderSummaryMarkdown>[0];
    expect(renderSummaryMarkdown(output)).toContain("<sub>standard mode");
    expect(renderSummaryMarkdown(output, { flavor: "bitbucket" })).toContain("_standard mode");
  });
});
