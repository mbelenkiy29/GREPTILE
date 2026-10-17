import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// PostHog must stay out of the JavaScript every page loads: only src/analytics.ts imports it, and
// only the loader imports that module, lazily, after consent.
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const path = join(dir, f);
  return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(f) ? [path] : [];
});
const sources = [...files("app"), ...files("src"), "instrumentation-client.ts"];

test("only src/analytics.ts imports PostHog", () => {
  const importers = sources.filter((f) => /from ["']posthog-js["']|import\(["']posthog-js["']\)/.test(readFileSync(f, "utf8")));
  assert.deepEqual(importers, [join("src", "analytics.ts")]);
});

test("analytics is reached only through the lazy loader", () => {
  const direct = sources.filter((f) => /(from|import\()\s*["'](\.\.?\/)+(src\/)?analytics["']/.test(readFileSync(f, "utf8").replace(/import type [^;]+;/g, "")));
  assert.deepEqual(direct, [join("src", "analytics-loader.ts")]);
  assert.match(readFileSync(join("src", "analytics-loader.ts"), "utf8"), /import\("\.\/analytics"\)/, "the loader imports it dynamically");
});
