import { loadEnvFile } from "node:process";
import { chromium, type Locator } from "playwright";
import { ConvexHttpClient } from "convex/browser";
import { SignJWT } from "jose";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { api } from "../convex/_generated/api";

loadEnvFile(".env.local");
const url = process.env.APP_URL ?? "http://localhost:3000";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url))
  throw new Error("Browser fixture tests only run against localhost");
const backend = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
const id = await backend.mutation(api.users.login, {
  secret: process.env.SERVICE_SECRET!,
  githubId: -100,
  login: "openreview-browser-fixture",
  avatar: "",
});
const token = await new SignJWT({})
  .setProtectedHeader({ alg: "HS256" })
  .setSubject(id)
  .setIssuer("openreview")
  .setAudience("openreview")
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(process.env.SESSION_SECRET!));
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1365, height: 900 },
});
const page = await context.newPage(),
  errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await mkdir("output/playwright", { recursive: true });
try {
  await page.goto(url);
  await page.getByRole("link", { name: "Sign in with GitHub" }).waitFor();
  await page.getByRole("heading", { name: "How it works" }).waitFor();
  await page.screenshot({ path: "output/playwright/home.png", fullPage: true });
  for (const [path, heading] of [["/docs/quickstart", "Quickstart"], ["/docs/api", "Public API"], ["/docs/configuration", "Repository configuration as code"], ["/changelog", "Changelog"]]) {
    await page.goto(url + path);
    await page.getByRole("heading", { name: heading, level: 1 }).first().waitFor();
  }
  assert.equal((await page.request.get(`${url}/docs/openapi.yaml`)).status(), 200);
  assert.equal((await page.request.get(`${url}/docs/not-a-page`)).status(), 404);
  await context.addCookies([
    {
      name: "openreview_session",
      value: token,
      url,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto(`${url}/dashboard`);
  // loading.tsx streams first; wait for the real page before choosing the fresh-database branch.
  await page.waitForLoadState("networkidle");
  if (
    await page.getByRole("heading", { name: "Create your workspace" }).count()
  ) {
    await page
      .getByLabel("Workspace name")
      .fill("Browser verification workspace");
    await page.getByRole("button", { name: "Create workspace" }).click();
    // A new workspace lands on the onboarding checklist (E4a); this branch only runs on a fresh database.
    await page.waitForURL("**/dashboard/onboarding");
    await page.getByRole("heading", { name: "Workspace setup", level: 1 }).waitFor();
  }
  const me = await backend.query(api.users.me, { token });
  const organizationId = me.organizations[0]._id!;
  await backend.mutation(api.repositories.connect, {
    token,
    secret: process.env.SERVICE_SECRET!,
    organizationId,
    installationId: -100,
    account: "test-fixture-only",
    accountId: -100,
    repositories: [
      {
        id: -100,
        fullName: "test-fixture/context-example",
        defaultBranch: "main",
      },
    ],
  });
  await page.goto(`${url}/dashboard/repositories`);
  await page
    .getByRole("heading", { name: "test-fixture/context-example", exact: true })
    .waitFor();
  // Walk every page in the main navigation and in each section's secondary navigation.
  const settled = () =>
    page.waitForFunction(
      () =>
        document.querySelector("h1") &&
        ![...document.querySelectorAll("h1")].some(
          (h) => h.textContent === "Loading…",
        ),
    );
  const visit = async (link: Locator) => {
    const href = (await link.getAttribute("href"))!.split("?")[0];
    await link.click();
    await page.waitForURL((u) => u.pathname.startsWith(href));
    await settled();
  };
  let dashboardPages = 0;
  for (const name of [
    "Analytics",
    "Chat",
    "Memory",
    "Pull Requests",
    "Settings",
  ]) {
    await visit(
      page
        .getByRole("navigation", { name: "Main navigation" })
        .getByRole("link", { name, exact: true }),
    );
    dashboardPages++;
    const secondary = page.locator("aside.secondary-nav nav").first();
    if (!(await secondary.count())) continue;
    for (const label of await secondary.getByRole("link").allTextContents()) {
      const link = secondary.getByRole("link", { name: label, exact: true });
      await visit(link);
      assert.equal(
        await link.getAttribute("aria-current"),
        "page",
        `${label} is not marked as the current page`,
      );
      dashboardPages++;
    }
  }
  const [repository] = await backend.query(api.repositories.list, {
    token,
    organizationId,
  });
  await page.goto(`${url}/dashboard/settings?repository=${repository._id}`);
  await page.getByLabel("Minimum confidence").fill("0.92");
  await page.getByRole("button", { name: "Save review settings" }).click();
  await page.waitForTimeout(500);
  assert.equal(
    (
      await backend.query(api.settings.repository, {
        token,
        repositoryId: repository._id,
      })
    ).settings.minimumConfidence,
    0.92,
  );
  await page.goto(`${url}/dashboard/rules`);
  await page
    .getByLabel("Title", { exact: true })
    .first()
    .fill("Browser check membership");
  await page
    .getByLabel("Instructions", { exact: true })
    .first()
    .fill(
      "All routes must validate organization membership before reading organization data.",
    );
  await page.getByRole("button", { name: "Create rule", exact: true }).click();
  await page
    .getByRole("heading", { name: /Browser check membership/ })
    .last()
    .waitFor();
  await page.getByRole("link", { name: "Chat", exact: true }).first().click();
  await page.getByRole("heading", { name: "Chat", exact: true }).waitFor();
  await page.getByRole("link", { name: "New chat" }).waitFor();
  await page.getByRole("heading", { name: "No indexed repositories" }).waitFor();
  assert.equal((await page.request.get(`${url}/api/chat/abcdefghij/stream`)).status(), 404);
  await page.goto(`${url}/dashboard/memory/preferences`);
  await page.getByRole("heading", { name: "Learned team conventions" }).waitFor();
  await page.getByLabel("Convention status").selectOption("suggested");
  await page.getByLabel("Search memory").fill("pagination");
  await page.getByRole("button", { name: "Apply" }).click();
  await page.waitForURL(/convention=suggested/);
  await page.getByText("0 matching conventions", { exact: false }).waitFor();
  // Screenshots and layout checks wait for the page content, not the streamed loading skeleton.
  await page.goto(`${url}/dashboard`);
  await settled();
  await page.screenshot({
    path: "output/playwright/dashboard.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "output/playwright/mobile.png",
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Mobile page overflows horizontally",
  );
  // Dark theme at mobile and desktop widths: no overflow, no console errors.
  await page.emulateMedia({ colorScheme: "dark" });
  for (const path of ["/dashboard", "/dashboard/chat", "/dashboard/settings/billing", "/docs/quickstart"]) {
    await page.goto(url + path);
    await settled();
    await page.screenshot({ path: `output/playwright/dark-mobile${path.replaceAll("/", "-")}.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Dark mobile ${path} overflows horizontally`);
  }
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.goto(`${url}/dashboard`);
  await settled();
  await page.screenshot({ path: "output/playwright/dark-desktop.png", fullPage: true });
  assert.deepEqual(errors, [], `Browser errors: ${errors.join("; ")}`);
  console.log(
    `Browser verification passed: landing, docs, changelog, onboarding, repository selection, ${dashboardPages} dashboard pages (main and secondary navigation), persisted settings/rules, Memory page filters, Chat page, mobile layout and dark theme. GitHub OAuth and real indexing still require external credentials.`,
  );
} finally {
  await browser.close();
}
