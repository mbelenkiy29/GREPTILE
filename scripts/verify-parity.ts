/**
 * Hard rule H6: run typecheck, lint, tests and `next build`, then print one
 * `PASS <ID>` / `FAIL <ID> <reason>` line per feature in the requested phase,
 * followed by `PARITY <phase>: <passed>/<total> PASS`. Exits 0 only if every ID passes.
 *
 * Usage: pnpm verify:parity [--phase <n|all>] [--skip-build] [--skip-e2e]
 * Playwright e2e tests (`pnpm e2e`, against the production build) count toward feature coverage like vitest tests.
 * Step output goes to stderr so stdout carries only the verdict lines.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  type CheckResult,
  type TestCase,
  formatVerdict,
  judge,
  parsePlaywrightJson,
  parseSpec,
  summaryLine,
} from "./parity/core";

const root = path.resolve(import.meta.dirname, "..");
const specPath = path.join(root, "docs/OPENREVIEW_SPEC.md");
const outDir = path.join(root, ".parity");

function parseArgs(argv: string[]) {
  let phase = "all";
  let skipBuild = false;
  let skipE2e = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--phase") phase = argv[++i] ?? "";
    else if (arg.startsWith("--phase=")) phase = arg.slice("--phase=".length);
    else if (arg === "--skip-build") skipBuild = true;
    else if (arg === "--skip-e2e") skipE2e = true;
    else if (arg === "--") continue;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (phase !== "all" && !/^\d+$/.test(phase)) throw new Error(`--phase must be a number or "all", got "${phase}"`);
  return { phase, skipBuild, skipE2e };
}

function run(name: string, cmd: string, args: string[], env: Record<string, string> = {}): CheckResult {
  process.stderr.write(`\n▶ ${name}: ${cmd} ${args.join(" ")}\n`);
  const res = spawnSync(cmd, args, { cwd: root, stdio: ["ignore", process.stderr, process.stderr], env: { ...process.env, ...env } });
  const ok = res.status === 0;
  process.stderr.write(`${ok ? "✔" : "✘"} ${name}\n`);
  return { name, ok };
}

interface VitestJson {
  testResults?: { assertionResults?: { title: string; status: string }[] }[];
}

function readVitest(file: string): TestCase[] {
  if (!existsSync(file)) return [];
  const json = JSON.parse(readFileSync(file, "utf8")) as VitestJson;
  return (json.testResults ?? []).flatMap((f) =>
    (f.assertionResults ?? []).map((a) => ({
      title: a.title,
      status: a.status === "passed" ? "passed" : a.status === "failed" ? "failed" : "skipped",
    })),
  );
}

function readPlaywright(file: string): TestCase[] {
  if (!existsSync(file)) return [];
  return parsePlaywrightJson(JSON.parse(readFileSync(file, "utf8")));
}

function main() {
  const { phase, skipBuild, skipE2e } = parseArgs(process.argv.slice(2));
  const features = parseSpec(readFileSync(specPath, "utf8")).filter(
    (f) => phase === "all" || f.phase === Number(phase),
  );
  if (features.length === 0) throw new Error(`no feature IDs found for phase ${phase} in ${specPath}`);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const vitestOut = path.join(outDir, "vitest.json");
  const bin = (name: string) => path.join(root, "node_modules/.bin", name);

  const checks: CheckResult[] = [
    run("typecheck", bin("tsc"), ["--noEmit"]),
    run("lint", bin("eslint"), ["."]),
    run("tests", bin("vitest"), [
      "run",
      "--passWithNoTests",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${vitestOut}`,
    ]),
  ];
  if (!skipBuild) checks.push(run("build", bin("next"), ["build"]));
  // End-to-end tests run against the production build (the Playwright web server builds one if none exists).
  const e2eOut = path.join(outDir, "playwright.json");
  if (!skipE2e) {
    checks.push(run("e2e", bin("playwright"), ["test", "-c", "e2e/playwright.config.ts", "--reporter=list,json"], { PLAYWRIGHT_JSON_OUTPUT_NAME: e2eOut }));
  }

  // A failing test is attributed to its own feature ID, not to every feature; a suite that failed without reporting
  // any test (it could not start) fails every feature.
  const testSuites = new Set(["tests", "e2e"]);
  const globalChecks = checks.filter((c) => !testSuites.has(c.name));
  const vitestCases = readVitest(vitestOut);
  if (!checks.find((c) => c.name === "tests")!.ok && vitestCases.length === 0) {
    globalChecks.push({ name: "tests", ok: false });
  }
  const e2eCases = skipE2e ? [] : readPlaywright(e2eOut);
  if (!skipE2e && !checks.find((c) => c.name === "e2e")!.ok && e2eCases.length === 0) {
    globalChecks.push({ name: "e2e", ok: false });
  }
  const tests = [...vitestCases, ...e2eCases];

  const verdicts = features.map((f) => judge(f, globalChecks, tests));
  process.stderr.write("\n");
  for (const v of verdicts) console.log(formatVerdict(v));
  console.log(summaryLine(phase, verdicts));
  process.exitCode = verdicts.every((v) => v.pass) ? 0 : 1;
}

try {
  main();
} catch (err) {
  console.error(`verify:parity: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
}
