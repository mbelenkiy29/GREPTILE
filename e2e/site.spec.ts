import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * R5.4: the public pages at phone (375px) and desktop (1440px) widths — full-page screenshots, no horizontal
 * overflow, no console errors, landmarks and a single h1, and no serious or critical axe violations (WCAG 2.1 AA).
 */

const PAGES = [
  { path: "/", name: "landing", chrome: true },
  { path: "/pricing", name: "pricing", chrome: true },
  { path: "/docs", name: "docs", chrome: true },
  { path: "/sign-in", name: "sign-in", chrome: false },
] as const;

const WIDTHS = [375, 1440] as const;

/** Collects console errors and uncaught page errors while a test runs. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

async function seriousViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
}

for (const width of WIDTHS) {
  for (const p of PAGES) {
    test(`R5.4 ${p.path} at ${width}px renders without overflow, console errors, or serious axe violations`, async ({ page }, info) => {
      const errors = watchErrors(page);
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      const res = await page.goto(p.path, { waitUntil: "networkidle" });
      expect(res?.status()).toBe(200);

      await page.screenshot({ path: info.outputPath(`${p.name}-${width}.png`), fullPage: true });
      await info.attach(`${p.name}-${width}`, { path: info.outputPath(`${p.name}-${width}.png`), contentType: "image/png" });

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, "page is wider than the viewport").toBeLessThanOrEqual(0);

      await expect(page.locator("main")).toHaveCount(1);
      await expect(page.locator("h1")).toHaveCount(1);
      if (p.chrome) {
        await expect(page.getByRole("banner")).toHaveCount(1);
        await expect(page.getByRole("contentinfo")).toHaveCount(1);
        await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
      }

      expect(await seriousViolations(page)).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}

test("R5.4 landing page in dark mode has no serious axe violations", async ({ page }) => {
  const errors = watchErrors(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "networkidle" });
  expect(await seriousViolations(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("R5.4 docs page at 375px keeps wide tables and code inside their own scroll boxes", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/docs/self-hosting", { waitUntil: "networkidle" });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(await seriousViolations(page)).toEqual([]);
});

test("R5.3 docs search finds pages from the build-time index", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/docs", { waitUntil: "networkidle" });
  const search = page.getByRole("searchbox", { name: "Search the docs" });
  await search.fill("openreview.json");
  const result = page.locator(".docs-search-results a").first();
  await expect(result).toBeVisible();
  await search.fill("single sign-on saml");
  await expect(page.locator(".docs-search-results a", { hasText: "Single sign-on" })).toBeVisible();
  await page.locator(".docs-search-results a", { hasText: "Single sign-on" }).click();
  await expect(page).toHaveURL(/\/docs\/sso$/);
  await expect(page.locator("h1")).toHaveText("Single sign-on");
});

test("R5.3 docs code blocks have a copy button and pages link to their neighbours", async ({ page }) => {
  await page.goto("/docs/quickstart", { waitUntil: "networkidle" });
  await expect(page.locator(".doc-code").first().getByRole("button", { name: "Copy code" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Previous and next page" }).getByRole("link")).toHaveCount(2);
  await expect(page.getByRole("navigation", { name: "On this page" })).toBeVisible();
});
