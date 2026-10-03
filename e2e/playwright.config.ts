import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests of the public site (R5.4) against the production build. The web server is `next start` on the
 * existing build (`pnpm build` first when there is none) with a minimal environment: no database or Redis is needed to
 * render the public pages.
 *
 * Chromium: PLAYWRIGHT_CHROMIUM_PATH, else the preinstalled /opt/pw-browsers/chromium when present, else Playwright's
 * own download (`pnpm exec playwright install chromium`).
 */
const root = path.resolve(import.meta.dirname, "..");
const port = Number(process.env.E2E_PORT ?? 3210);
const preinstalled = "/opt/pw-browsers/chromium";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || (existsSync(preinstalled) ? preinstalled : undefined);

export default defineConfig({
  testDir: ".",
  outputDir: path.join(root, "test-results"),
  fullyParallel: true,
  workers: 2,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME ? [["list"], ["json"]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `sh -c 'test -f .next/BUILD_ID || pnpm build; exec pnpm exec next start -H 127.0.0.1 -p ${port}'`,
    cwd: root,
    url: `http://127.0.0.1:${port}/robots.txt`,
    reuseExistingServer: !process.env.CI,
    timeout: 600_000,
    env: {
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      APP_URL: `http://127.0.0.1:${port}`,
      APP_SECRET: "e2e-only-secret-0123456789abcdef",
      // Never contacted by the public pages; present only to satisfy env validation.
      DATABASE_URL: "postgres://openreview:openreview@127.0.0.1:1/openreview",
      REDIS_URL: "redis://127.0.0.1:1",
      RUN_MIGRATIONS: "false",
    },
  },
});
