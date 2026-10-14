import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { scanChanges } from "../src/security-scan";
import { dependencyChanges } from "../src/dependency-changes";
import { advisoryFinding, osvClient, osvEnabled, type OsvVuln } from "../src/osv";
import { reviewChange } from "../src/engine/review";
import type { Candidate, ChangedFile, ModelProvider, ModelRequest, ReviewInput } from "../src/engine/types";

const added = (path: string, lines: string[], context: string[] = []): ChangedFile => ({ path, status: "modified", patch: `@@ -1,${context.length} +1,${context.length + lines.length} @@\n` + [...context.map((l) => " " + l), ...lines.map((l) => "+" + l)].join("\n") });
const checks = (path: string, line: string) => scanChanges([added(path, [line])]).map((f) => f.symbol);

test("pattern checks flag high-signal security defects on added lines (true positives)", () => {
  const positives: [string, string, string][] = [
    ["src/key.ts", "const key = `-----BEGIN RSA PRIVATE KEY-----`;", "private-key"],
    ["src/aws.ts", 'const id = "AKIAQWERTYUIOPASDFGH";', "cloud-token"],
    ["src/gh.py", 'TOKEN = "ghp_' + "a".repeat(36) + '"', "cloud-token"],
    ["src/stripe.ts", 'stripe("sk_live_' + "b".repeat(24) + '")', "cloud-token"],
    ["src/db.ts", 'const config = { password: "hunter2-is-not-strong" };', "assigned-secret"],
    ["src/users.ts", 'db.query("SELECT * FROM users WHERE id = " + req.params.id);', "sql-concatenation"],
    ["src/users.ts", "db.query(`DELETE FROM sessions WHERE user = ${userId}`);", "sql-concatenation"],
    ["app/users.py", 'cursor.execute(f"SELECT name FROM users WHERE id = {user_id}")', "sql-concatenation"],
    ["src/http.ts", "const agent = new https.Agent({ rejectUnauthorized: false });", "tls-verification-off"],
    ["app/client.py", "requests.get(url, verify=False)", "tls-verification-off"],
    ["svc/client.go", "tls.Config{InsecureSkipVerify: true}", "tls-verification-off"],
    ["src/calc.ts", "const result = eval(req.body.expression);", "dynamic-eval"],
    ["src/calc.js", "const fn = new Function(userCode);", "dynamic-eval"],
    ["app/run.py", "exec(payload)", "dynamic-eval"],
    ["src/git.ts", "execSync(`git checkout ${branch}`);", "shell-injection"],
    ["app/tasks.py", "subprocess.run(cmd, shell=True)", "shell-injection"],
    ["app/tasks.py", 'os.system(f"convert {name}")', "shell-injection"],
    ["app/load.py", "data = pickle.loads(request.data)", "unsafe-deserialization"],
    ["app/load.py", "config = yaml.load(stream)", "unsafe-deserialization"],
  ];
  for (const [path, line, id] of positives) assert.deepEqual(checks(path, line), [id], `${path}: ${line}`);
  // Quotes mask the secret itself, even formats the indexer's redaction does not know.
  const [stripe] = scanChanges([added("src/stripe.ts", ['stripe("sk_live_' + "b".repeat(24) + '")'])]);
  assert.equal(stripe.evidence[0].quote, 'stripe("[REDACTED TOKEN]")');
  const [finding] = scanChanges([added("src/http.ts", ["const agent = new https.Agent({ rejectUnauthorized: false });"], ["import https from 'https';"])]);
  assert.deepEqual([finding.category, finding.severity, finding.startLine, finding.evidence[0].quote, finding.agent], ["security", "high", 2, "const agent = new https.Agent({ rejectUnauthorized: false });", "security-checks"]);
});

test("pattern checks stay quiet on safe or placeholder code (false-positive fixtures)", () => {
  const negatives: [string, string][] = [
    ["src/aws.ts", 'const id = "AKIAIOSFODNN7EXAMPLE";'],
    ["src/db.ts", "const config = { password: process.env.DB_PASSWORD };"],
    ["src/db.ts", 'const config = { password: "" };'],
    ["src/db.ts", 'const label = "Enter your password";'],
    ["src/users.ts", 'db.query("SELECT * FROM users WHERE id = $1", [id]);'],
    ["src/users.ts", 'const title = "Select an option from the list: " + name;'],
    ["src/http.ts", "const agent = new https.Agent({ rejectUnauthorized: true });"],
    ["app/client.py", "requests.get(url, verify=True)"],
    ["src/calc.ts", 'const total = evaluate(expression); // eval("x") in docs'],
    ["src/calc.ts", 'eval("1 + 1");'],
    ["app/load.py", "config = yaml.load(stream, Loader=yaml.SafeLoader)"],
    ["app/load.py", "config = yaml.safe_load(stream)"],
    ["src/git.ts", 'execFile("git", ["checkout", branch]);'],
    ["README.md", "Set password: hunter2-is-not-strong in your local config"],
    ["tests/fixtures/keys.ts", 'const fake = "ghp_' + "a".repeat(36) + '";'],
  ];
  for (const [path, line] of negatives) assert.deepEqual(checks(path, line), [], `${path}: ${line}`);
  // Removed lines and removed files are never scanned.
  assert.deepEqual(scanChanges([{ path: "src/http.ts", status: "modified", patch: "@@ -1 +0,0 @@\n-const agent = new https.Agent({ rejectUnauthorized: false });" }]), []);
  assert.deepEqual(scanChanges([{ ...added("src/http.ts", ["rejectUnauthorized: false"]), status: "removed" }]), []);
});

test("dependency versions are read from manifest and lockfile diffs for npm, PyPI, Go, crates.io and Maven", () => {
  const { changes, unsupported } = dependencyChanges([
    added("package.json", ['    "lodash": "^4.17.20",', '    "left-pad": "github:user/left-pad",', '  "version": "2.0.0",'], ['  "dependencies": {']),
    added("package-lock.json", ['      "version": "4.17.20",'], ['    "node_modules/lodash": {']),
    added("pnpm-lock.yaml", ["  /minimist@1.2.0:", "  '@babel/core@7.20.0(supports-color@8.1.1)':", "  axios@0.21.0:"]),
    added("yarn.lock", ['  version "1.2.5"', "  resolution: \"x\""], ['"minimist@^1.2.0":']),
    added("requirements.txt", ["Requests[socks]==2.19.0", "flask>=2.0", "Django==3.2.1 ; python_version >= '3.8'"]),
    added("poetry.lock", ['version = "5.3.0"'], ["[[package]]", 'name = "PyYAML"']),
    added("go.mod", ["\tgithub.com/gin-gonic/gin v1.6.0", "module example.com/app v1.0.0"]),
    added("go.sum", ["golang.org/x/net v0.7.0 h1:abc=", "golang.org/x/net v0.7.0/go.mod h1:def="]),
    added("Cargo.lock", ['version = "1.0.100"'], ["[[package]]", 'name = "serde"']),
    added("Cargo.toml", ['tokio = { version = "=1.18.0", features = ["full"] }', 'rust-version = "1.70.0"']),
    added("pom.xml", ["      <version>2.14.1</version>"], ["    <dependency>", "      <groupId>org.apache.logging.log4j</groupId>", "      <artifactId>log4j-core</artifactId>"]),
    added("Gemfile.lock", ["    rails (6.0.0)"]),
  ]);
  assert.deepEqual(changes.map((c) => [c.ecosystem, c.name, c.version, c.path, c.line]), [
    ["npm", "lodash", "4.17.20", "package.json", 2],
    ["npm", "minimist", "1.2.0", "pnpm-lock.yaml", 1],
    ["npm", "@babel/core", "7.20.0", "pnpm-lock.yaml", 2],
    ["npm", "axios", "0.21.0", "pnpm-lock.yaml", 3],
    ["npm", "minimist", "1.2.5", "yarn.lock", 2],
    ["PyPI", "requests", "2.19.0", "requirements.txt", 1],
    ["PyPI", "django", "3.2.1", "requirements.txt", 3],
    ["PyPI", "pyyaml", "5.3.0", "poetry.lock", 3],
    ["Go", "github.com/gin-gonic/gin", "1.6.0", "go.mod", 1],
    ["Go", "golang.org/x/net", "0.7.0", "go.sum", 1],
    ["crates.io", "serde", "1.0.100", "Cargo.lock", 3],
    ["crates.io", "tokio", "1.18.0", "Cargo.toml", 1],
    ["Maven", "org.apache.logging.log4j:log4j-core", "2.14.1", "pom.xml", 4],
  ], "the lockfile's lodash 4.17.20 repeats package.json's and is listed once");
  assert.deepEqual(unsupported, ["Gemfile.lock"]);
  assert.equal(changes.find((c) => c.name === "lodash")!.quote, '    "lodash": "^4.17.20",');
});

const vuln = (id: string, severity: string, fixed?: string): OsvVuln => ({ id, summary: `Prototype pollution in <b>lodash</b> via [crafted](https://evil.example) @maintainer input\nsecond line`, database_specific: { severity }, affected: [{ package: { ecosystem: "npm", name: "lodash" }, ranges: [{ events: [{ introduced: "0" }, ...(fixed ? [{ fixed }] : [])] }] }] });

test("OSV lookups batch queries, fetch each advisory once and map severity, fixes and safe text", async () => {
  const calls: { url: string; body?: unknown }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/v1/querybatch")) {
      const queries = (JSON.parse(String(init.body)) as { queries: { package: { name: string } }[] }).queries;
      return Response.json({ results: queries.map((q) => (q.package.name === "lodash" ? { vulns: [{ id: "GHSA-aaaa-bbbb-cccc", modified: "x" }, { id: "CVE-2020-8203", modified: "x" }] } : q.package.name === "minimist" ? { vulns: [{ id: "GHSA-aaaa-bbbb-cccc", modified: "x" }] } : {})) });
    }
    const id = decodeURIComponent(url.split("/v1/vulns/")[1]);
    return Response.json(id === "CVE-2020-8203" ? vuln(id, "HIGH", "4.17.19") : vuln(id, "MODERATE", "4.17.21"));
  }) as typeof fetch;
  const changes = dependencyChanges([added("package.json", ['    "lodash": "4.17.15",', '    "minimist": "1.2.0",', '    "react": "18.2.0",'])]).changes;
  const { advisories, truncated } = await osvClient({ fetch: fake, base: "https://osv.test", batchSize: 2 })(changes);
  assert.equal(truncated, false);
  assert.equal(calls.filter((c) => c.url.endsWith("/v1/querybatch")).length, 2, "three queries in batches of two");
  assert.deepEqual((calls[0].body as { queries: unknown[] }).queries[0], { package: { name: "lodash", ecosystem: "npm" }, version: "4.17.15" });
  assert.deepEqual(calls.filter((c) => c.url.includes("/v1/vulns/")).map((c) => c.url), ["https://osv.test/v1/vulns/GHSA-aaaa-bbbb-cccc", "https://osv.test/v1/vulns/CVE-2020-8203"]);
  const finding = advisoryFinding(changes[0], advisories.get("npm\u0000lodash\u00004.17.15")!);
  assert.equal(finding.severity, "high", "the most severe advisory wins");
  assert.equal(finding.title, "lodash 4.17.15 has 2 known vulnerabilities (GHSA-aaaa-bbbb-cccc, CVE-2020-8203)");
  assert.match(finding.suggestedFix, /Upgrade lodash to a fixed version \(4\.17\.21, 4\.17\.19\) or later\./);
  assert.match(finding.description, /^Prototype pollution in blodash\/b via crafted\(link removed @​maintainer input second line This change adds npm package lodash at version 4\.17\.15/);
  assert.match(finding.description, /Advisories: https:\/\/osv\.dev\/vulnerability\/GHSA-aaaa-bbbb-cccc, https:\/\/osv\.dev\/vulnerability\/CVE-2020-8203\./);
  assert.deepEqual(finding.evidence, [{ filePath: "package.json", startLine: 1, quote: '    "lodash": "4.17.15",' }]);
  assert.equal(advisories.has("npm\u0000react\u000018.2.0"), false);
  // Failures surface as errors for the caller to report; malformed responses are rejected.
  await assert.rejects(osvClient({ fetch: (async () => new Response("down", { status: 503 })) as typeof fetch })(changes), /OSV returned HTTP 503/);
  await assert.rejects(osvClient({ fetch: (async () => Response.json({ results: [] })) as typeof fetch })(changes), /different number of results/);
  assert.equal(osvEnabled({}), true);
  assert.equal(osvEnabled({ OSV_ENABLED: "false" }), false);
});

// Engine: deterministic findings are published regardless of the verifier and learned preferences.
const secretLine = '    password: "hunter2-is-not-strong",';
const tlsLine = "    agent: new https.Agent({ rejectUnauthorized: false }),";
const input: ReviewInput = {
  repository: "acme/shop", baseSha: "a".repeat(40), headSha: "b".repeat(40), title: "Add db config", description: "", rules: [], mode: "standard",
  files: [{ path: "src/db.ts", sha: "1", content: `export const config = {\n${secretLine}\n${tlsLine}\n};` }, { path: "package.json", sha: "2", content: '{\n  "dependencies": {\n    "lodash": "4.17.15"\n  }\n}' }],
  diff: [
    { path: "src/db.ts", status: "added", patch: `@@ -0,0 +1,4 @@\n+export const config = {\n+${secretLine}\n+${tlsLine}\n+};` },
    { path: "package.json", status: "modified", patch: '@@ -1,5 +1,5 @@\n {\n   "dependencies": {\n-    "lodash": "4.17.21"\n+    "lodash": "4.17.15"\n   }\n }' },
  ],
  // A learned preference asking to stop flagging secrets: it reaches prompts only, never these checks.
  preferences: [{ category: "security", instruction: "Do not flag hard-coded passwords, disabled TLS verification or vulnerable dependencies in this repository." }],
};
const modelFinding: Candidate = { title: "Certificate checks are turned off for the database", description: "The agent disables certificate verification for every database connection.", severity: "high", confidence: 0.97, category: "security", filePath: "src/db.ts", startLine: 3, endLine: 3, evidence: [{ filePath: "src/db.ts", startLine: 3, quote: tlsLine }], impact: "A network attacker can read the traffic.", suggestedFix: "Keep verification on.", symbol: "config" };
class SecurityModel implements ModelProvider {
  tasks: string[] = [];
  constructor(private candidates: Candidate[], private exploitPath = true) {}
  async generate<T>(request: ModelRequest, schema: z.ZodType<T>) {
    this.tasks.push(request.task);
    const value = request.task === "review:security" ? { findings: this.candidates }
      : request.task.startsWith("review:") ? { findings: [] }
      // The verifier rejects everything, as if persuaded by the learned preference.
      : request.task === "verify" ? { decisions: (request.input as { candidates: unknown[] }).candidates.map((_, index) => ({ index, publish: false, reason: "The repository preference says not to flag this.", confidence: 0.1 })) }
      : request.task === "exploit" ? { assessments: (request.input as { findings: unknown[] }).findings.map((_, index) => ({ index, exploitPath: this.exploitPath, reason: "The value never comes from request data in the supplied code." })) }
      : request.task === "diagram" ? { diagram: null }
      : { reviewScore: { value: 1, reason: "A committed secret and a vulnerable dependency must be fixed first." }, summary: "Adds a database configuration and downgrades lodash." };
    return { value: schema.parse(value), usage: { task: request.task, provider: "f", model: "f", inputTokens: 1, outputTokens: 1, latencyMs: 1, estimatedCost: 0, cached: false } };
  }
}
const lodashAdvisory = (async () => ({ advisories: new Map([["npm\u0000lodash\u00004.17.15", [vuln("GHSA-aaaa-bbbb-cccc", "HIGH", "4.17.21")]]]), truncated: false }));

test("learned preferences and the model verifier cannot suppress deterministic security findings", async () => {
  const model = new SecurityModel([modelFinding]);
  const result = await reviewChange(input, model, async () => {}, undefined, { advisories: lodashAdvisory });
  assert.deepEqual(result.findings.map((f) => [f.agent, f.filePath, f.startLine, f.category]).sort(), [["dependency-advisories", "package.json", 3, "security"], ["security-checks", "src/db.ts", 2, "security"], ["security-checks", "src/db.ts", 3, "security"]]);
  assert.ok(result.metadata.suppressions?.some((s) => s.title === "Certificate checks are turned off for the database" && s.reason === "Duplicate of a deterministic security check"), JSON.stringify(result.metadata.suppressions));
  // The committed secret is never repeated in the published evidence.
  const secret = result.findings.find((f) => f.startLine === 2)!;
  assert.equal(secret.evidence[0].quote, '    password: "[REDACTED]",');
  assert.ok(!JSON.stringify(result.findings).includes("hunter2-is-not-strong"));
  assert.equal(result.metadata.verdict, "changes");
  assert.equal(model.tasks.includes("verify"), false, "deterministic findings never go to the verifier and the model duplicate was dropped first");
  // Off switches: the repository setting, or security not among the review's categories.
  assert.deepEqual((await reviewChange({ ...input, settings: { securityScan: false } }, new SecurityModel([]), async () => {}, undefined, { advisories: lodashAdvisory })).findings, []);
  assert.deepEqual((await reviewChange({ ...input, settings: { categories: ["correctness"] } }, new SecurityModel([]), async () => {}, undefined, { advisories: lodashAdvisory })).findings, []);
});

test("advisory lookups degrade with a visible note; the exploit check lowers confidence but never removes a finding", async () => {
  const down = await reviewChange(input, new SecurityModel([]), async () => {}, undefined, { advisories: async () => { throw new Error("OSV returned HTTP 503"); } });
  assert.deepEqual(down.findings.map((f) => f.agent), ["security-checks", "security-checks"]);
  assert.ok(down.metadata.coverageLimits?.includes("Dependency advisories could not be checked (OSV returned HTTP 503); 1 changed dependency version was not checked for known vulnerabilities"));
  assert.equal(down.metadata.coverageIncomplete, true);
  const off = await reviewChange(input, new SecurityModel([]));
  assert.ok(off.metadata.coverageLimits?.includes("1 changed dependency version was not checked for known vulnerabilities (advisory lookups are off)"));
  assert.equal(off.metadata.coverageIncomplete, false);
  // A model-reported security finding elsewhere (no deterministic overlap) gets an exploitability judgment.
  const authFinding: Candidate = { ...modelFinding, title: "Config exported to the client bundle", description: "The config object is exported from a module the browser bundle imports.", filePath: "src/db.ts", startLine: 1, endLine: 1, evidence: [{ filePath: "src/db.ts", startLine: 1, quote: "export const config = {" }], impact: "Connection settings reach browsers.", symbol: "config" };
  const verifying = new (class extends SecurityModel {
    async generate<T>(request: ModelRequest, schema: z.ZodType<T>) {
      if (request.task === "verify") return { value: schema.parse({ decisions: [{ index: 0, publish: true, reason: "The module is exported and imported by the client.", confidence: 0.95 }] }), usage: { task: "verify", provider: "f", model: "f", inputTokens: 1, outputTokens: 1, latencyMs: 1, estimatedCost: 0, cached: false } };
      return super.generate(request, schema);
    }
  })([authFinding], false);
  const ranked = await reviewChange({ ...input, settings: { minimumConfidence: 0.9 } }, verifying, async () => {}, undefined, { advisories: lodashAdvisory });
  const lowered = ranked.findings.find((f) => f.title === "Config exported to the client bundle")!;
  assert.equal(lowered.confidence, 0.9, "0.95 lowered by 0.1 but never below the 0.9 threshold");
  assert.match(lowered.description, /No exploit path from untrusted input was shown in the reviewed code, so confidence was lowered\.$/);
  assert.deepEqual(ranked.metadata.exploitability, [{ fingerprint: lowered.fingerprint, exploitPath: false }]);
  assert.equal(ranked.findings.length, 4);
});
