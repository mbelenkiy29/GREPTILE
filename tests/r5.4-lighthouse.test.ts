import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const root = path.resolve(import.meta.dirname, "..");

const assertion = z.tuple([z.literal("error"), z.object({ minScore: z.number(), aggregationMethod: z.string().optional() })]);
const lhrc = z.object({
  ci: z.object({
    collect: z.object({ startServerCommand: z.string(), url: z.array(z.string().url()).min(1), numberOfRuns: z.number().int().min(1) }).passthrough(),
    assert: z.object({ assertions: z.record(z.string(), assertion) }),
    upload: z.object({ target: z.string() }).passthrough(),
  }),
});

describe("lighthouse and responsive checks", () => {
  test("R5.4 lighthouserc.json asserts performance and accessibility of at least 0.9 on / and /pricing", () => {
    const cfg = lhrc.parse(JSON.parse(readFileSync(path.join(root, "lighthouserc.json"), "utf8")));
    const paths = cfg.ci.collect.url.map((u) => new URL(u).pathname).sort();
    expect(paths).toEqual(["/", "/pricing"]);
    for (const cat of ["performance", "accessibility"]) {
      const a = cfg.ci.assert.assertions[`categories:${cat}`];
      expect(a, cat).toBeDefined();
      expect(a![0]).toBe("error");
      expect(a![1].minScore).toBeGreaterThanOrEqual(0.9);
    }
    // The server lhci starts serves the production build on the port the URLs use.
    const port = new URL(cfg.ci.collect.url[0]!).port;
    expect(cfg.ci.collect.startServerCommand).toContain("next start");
    expect(cfg.ci.collect.startServerCommand).toContain(`-p ${port}`);
  });

  test("R5.4 CI runs Lighthouse with the mobile and desktop presets and the Playwright e2e suite", () => {
    const ci = parseYaml(readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, { steps: { run?: string }[] }> };
    const runs = Object.values(ci.jobs).flatMap((j) => j.steps.map((s) => s.run ?? ""));
    const lhci = runs.filter((r) => r.includes("lhci autorun"));
    expect(lhci.some((r) => !r.includes("preset="))).toBe(true);
    expect(lhci.some((r) => r.includes("--collect.settings.preset=desktop"))).toBe(true);
    expect(runs).toContain("pnpm e2e");
  });

  test("R5.4 the Playwright config checks 375px and 1440px and uses the preinstalled Chromium when present", () => {
    const spec = readFileSync(path.join(root, "e2e/site.spec.ts"), "utf8");
    expect(spec).toMatch(/WIDTHS = \[375, 1440\]/);
    for (const p of ['"/"', '"/pricing"', '"/docs"', '"/sign-in"']) expect(spec).toContain(`path: ${p}`);
    expect(spec).toContain("AxeBuilder");
    const config = readFileSync(path.join(root, "e2e/playwright.config.ts"), "utf8");
    expect(config).toContain("PLAYWRIGHT_CHROMIUM_PATH");
    expect(config).toContain("/opt/pw-browsers/chromium");
    expect(config).toContain("webServer");
  });
});
