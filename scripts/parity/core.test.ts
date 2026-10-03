import { describe, expect, test } from "vitest";
import { formatVerdict, judge, parsePlaywrightJson, parseSpec, summaryLine, titleMatchesId } from "./core";

const spec = `# Spec
## Hard rules
- H1. not a feature
## Phase 1 — Core
- R1.1 First thing.
- R1.2 Second thing.
## Phase 2 — More
- R2.1 Third thing.
`;

const feature = { id: "R1.1", phase: 1, description: "" };

describe("parity verifier", () => {
  test("parses feature IDs per phase and ignores hard rules", () => {
    expect(parseSpec(spec).map((f) => [f.phase, f.id])).toEqual([
      [1, "R1.1"],
      [1, "R1.2"],
      [2, "R2.1"],
    ]);
  });

  test("matches IDs at a word boundary only", () => {
    expect(titleMatchesId("R1.1 posts a comment", "R1.1")).toBe(true);
    expect(titleMatchesId("R1.10 something else", "R1.1")).toBe(false);
    expect(titleMatchesId("about R1.1", "R1.1")).toBe(false);
  });

  test("fails when no test is attributed, passes when all attributed tests pass", () => {
    expect(formatVerdict(judge(feature, [], []))).toBe("FAIL R1.1 no tests found");
    expect(formatVerdict(judge(feature, [], [{ title: "R1.1 works", status: "passed" }]))).toBe("PASS R1.1");
  });

  test("fails on a failing attributed test or a failing global check", () => {
    const tests = [
      { title: "R1.1 a", status: "passed" as const },
      { title: "R1.1 b", status: "failed" as const },
    ];
    expect(formatVerdict(judge(feature, [], tests))).toBe("FAIL R1.1 1/2 tests failed: R1.1 b");
    expect(formatVerdict(judge(feature, [{ name: "build", ok: false }], [tests[0]!]))).toBe(
      "FAIL R1.1 build failed",
    );
  });

  test("skipped-only coverage does not count", () => {
    expect(formatVerdict(judge(feature, [], [{ title: "R1.1 x", status: "skipped" }]))).toBe(
      "FAIL R1.1 all tests skipped",
    );
  });

  test("summary line counts passes", () => {
    expect(summaryLine("1", [{ id: "R1.1", pass: true }, { id: "R1.2", pass: false, reason: "x" }])).toBe(
      "PARITY 1: 1/2 PASS",
    );
  });

  test("reads Playwright JSON results, nested suites included", () => {
    const report = {
      suites: [
        {
          title: "site.spec.ts",
          specs: [
            { title: "R5.4 passes", tests: [{ status: "expected" }] },
            { title: "R5.4 flaky but passed on retry", tests: [{ status: "flaky" }] },
            { title: "R5.4 fails in one project", tests: [{ status: "expected" }, { status: "unexpected" }] },
            { title: "R5.4 skipped", tests: [{ status: "skipped" }] },
          ],
          suites: [{ title: "nested", specs: [{ title: "R5.3 nested", tests: [{ status: "expected" }] }] }],
        },
      ],
    };
    expect(parsePlaywrightJson(report)).toEqual([
      { title: "R5.4 passes", status: "passed" },
      { title: "R5.4 flaky but passed on retry", status: "passed" },
      { title: "R5.4 fails in one project", status: "failed" },
      { title: "R5.4 skipped", status: "skipped" },
      { title: "R5.3 nested", status: "passed" },
    ]);
    expect(parsePlaywrightJson(null)).toEqual([]);
    const feature54 = { id: "R5.4", phase: 5, description: "" };
    expect(formatVerdict(judge(feature54, [], parsePlaywrightJson(report)))).toBe("FAIL R5.4 1/3 tests failed: R5.4 fails in one project");
  });
});
