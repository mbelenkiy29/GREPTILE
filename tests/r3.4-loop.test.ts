import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const SCRIPT = path.resolve(import.meta.dirname, "../integrations/loop/openreview-loop.sh");
// Built at runtime: fixtures never contain a contiguous key literal.
const TOKEN = ["or", "live", "x".repeat(43)].join("_");

interface Finding {
  id: number;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  path: string;
  startLine: number;
}

/** What the fake OpenReview server says about one pushed commit. */
interface HeadScenario {
  /** Polls answered "reviewing" before the run completes; Infinity: never starts (no run at all). */
  pollsUntilDone: number;
  status?: "completed" | "failed";
  findings: Finding[];
}

/** A fake OpenReview REST API for the loop: runs per pushed head, findings of the latest completed head. */
class FakeOpenReview {
  server: Server;
  requests: { method: string; url: string; auth: string | undefined; body: string }[] = [];
  polls = new Map<string, number>();
  constructor(
    private readonly state: string,
    private readonly scenarios: Record<string, HeadScenario>,
  ) {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        this.requests.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body });
        const out = this.answer(req, body);
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(JSON.stringify(out.body));
      });
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  pushed(): string[] {
    const f = path.join(this.state, "pushed");
    return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
  }

  private runFor(sha: string, count: boolean) {
    const s = this.scenarios[sha];
    if (!s || s.pollsUntilDone === Infinity) return null;
    const n = (this.polls.get(sha) ?? 0) + (count ? 1 : 0);
    this.polls.set(sha, n);
    return { id: 100 + this.pushed().indexOf(sha), headSha: sha, trigger: "synchronize", queuedAt: "2026-03-01T00:00:00Z", status: n > s.pollsUntilDone ? (s.status ?? "completed") : "reviewing", error: s.status === "failed" ? "model timed out" : null };
  }

  private answer(req: IncomingMessage, body: string): { status: number; body: unknown } {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return { status: 401, body: { error: { code: "unauthorized", message: "The API key is not valid." } } };
    const url = new URL(req.url ?? "/", "http://x");
    const page = (data: unknown[]) => ({ data, pagination: { page: 1, pageSize: 100, total: data.length, pageCount: 1, hasMore: false } });
    if (req.method === "GET" && url.pathname === "/api/v1/repositories") return { status: 200, body: page([{ id: 1, fullName: "acme/shop" }, { id: 2, fullName: "acme/shop-legacy" }]) };
    if (req.method === "GET" && url.pathname === "/api/v1/reviews") {
      if (url.searchParams.get("repositoryId") !== "1" || url.searchParams.get("prNumber") !== "7") return { status: 200, body: page([]) };
      const started = this.pushed().some((sha) => this.runFor(sha, false));
      return { status: 200, body: page(started ? [{ id: 10 }] : []) };
    }
    if (req.method === "GET" && url.pathname === "/api/v1/reviews/10") {
      const runs = this.pushed()
        .map((sha, i, all) => this.runFor(sha, i === all.length - 1))
        .filter((r) => r !== null)
        .reverse();
      return { status: 200, body: { review: { id: 10, runHistory: runs } } };
    }
    if (req.method === "GET" && url.pathname === "/api/v1/findings") {
      const wanted = (url.searchParams.get("severity") ?? "").split(",");
      const done = this.pushed().filter((sha) => this.runFor(sha, false)?.status === "completed");
      const latest = done[done.length - 1];
      const items = latest ? this.scenarios[latest]!.findings.filter((f) => wanted.includes(f.severity)) : [];
      return {
        status: 200,
        body: page(items.map((f) => ({ ...f, endLine: f.startLine + 2, category: "correctness", confidence: 0.9, status: "open", description: `Why ${f.title} matters.`, suggestedFix: "Do the safe thing." }))),
      };
    }
    if (req.method === "POST" && url.pathname === "/api/v1/reviews") return { status: 202, body: { run: { id: 999, reviewId: 10, status: "queued", requested: JSON.parse(body) as unknown } } };
    return { status: 404, body: { error: { code: "not_found", message: `no fake route ${req.method} ${url.pathname}` } } };
  }
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function exe(file: string, body: string) {
  writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
}

/** Fake git, gh, sleep, and date on PATH, sharing a state directory (head sha, pushes, PR, clock). */
function sandbox(opts: { headSha: string; prExists?: boolean }) {
  const root = mkdtempSync(path.join(tmpdir(), "or-loop-"));
  const bin = path.join(root, "bin");
  const state = path.join(root, "state");
  const home = path.join(root, "home");
  const work = path.join(root, "work");
  for (const d of [bin, state, home, work, path.join(state, "gitdir")]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(state, "head"), opts.headSha);
  writeFileSync(path.join(state, "clock"), "1000000");
  if (opts.prExists) writeFileSync(path.join(state, "pr"), "7");
  const S = `"$FAKE_STATE"`;
  exe(
    path.join(bin, "git"),
    `echo "git $*" >> ${S}/calls
case "$*" in
  "rev-parse --abbrev-ref HEAD") echo feature ;;
  "rev-parse --abbrev-ref --symbolic-full-name @{u}") [[ -f ${S}/upstream ]] && echo origin/feature || exit 128 ;;
  "rev-parse HEAD") cat ${S}/head ;;
  "rev-parse --git-dir") echo ${S}/gitdir ;;
  push*) cat ${S}/head >> ${S}/pushed; echo >> ${S}/pushed; touch ${S}/upstream ;;
  "status --porcelain") [[ -f ${S}/dirty ]] && echo " M src/app.ts" || true ;;
  "add -A") ;;
  commit*) n=$(( $(cat ${S}/commits 2>/dev/null || echo 0) + 1 )); echo $n > ${S}/commits; printf 'c%039d' $n > ${S}/head; rm -f ${S}/dirty ;;
  *) echo "fake git: unexpected $*" >&2; exit 2 ;;
esac`,
  );
  exe(
    path.join(bin, "gh"),
    `echo "gh $*" >> ${S}/calls
case "$*" in
  "repo view --json nameWithOwner --jq .nameWithOwner") echo acme/shop ;;
  "repo view --json defaultBranchRef --jq .defaultBranchRef.name") echo main ;;
  "pr view --json number --jq .number") [[ -f ${S}/pr ]] && cat ${S}/pr || exit 1 ;;
  "pr create"*) echo 7 > ${S}/pr; echo "https://github.com/acme/shop/pull/7" ;;
  *) echo "fake gh: unexpected $*" >&2; exit 2 ;;
esac`,
  );
  exe(path.join(bin, "sleep"), `echo "$1" >> ${S}/sleeps; echo $(( $(cat ${S}/clock) + $1 )) > ${S}/clock`);
  exe(path.join(bin, "date"), `cat ${S}/clock`);
  // The coding agent: records the prompt and edits a file.
  exe(path.join(bin, "fake-agent"), `n=$(ls ${S} | grep -c '^prompt-' || true); cat > ${S}/prompt-$((n + 1)); touch ${S}/dirty`);
  const read = (f: string) => (existsSync(path.join(state, f)) ? readFileSync(path.join(state, f), "utf8") : "");
  return { root, bin, state, home, work, read };
}

async function runLoop(sb: ReturnType<typeof sandbox>, url: string, args: string[]) {
  const env = {
    PATH: `${sb.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: sb.home,
    FAKE_STATE: sb.state,
    NODE_ENV: "test" as const,
    OPENREVIEW_URL: url,
    OPENREVIEW_TOKEN: TOKEN,
  };
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("bash", [SCRIPT, ...args], { cwd: sb.work, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const sha = (n: number) => `c${String(n).padStart(39, "0")}`;
const HIGH: Finding = { id: 101, severity: "high", title: "Unchecked null in checkout", path: "src/checkout.ts", startLine: 12 };
const LOW: Finding = { id: 102, severity: "low", title: "Unused variable", path: "src/cart.ts", startLine: 3 };

async function start(sb: ReturnType<typeof sandbox>, scenarios: Record<string, HeadScenario>) {
  const fake = new FakeOpenReview(sb.state, scenarios);
  servers.push(fake.server);
  return { fake, url: await fake.listen() };
}

describe("openreview-loop.sh (R3.4)", () => {
  test("R3.4 the loop opens the PR, waits for the new head's review, runs the agent, and stops when clean", async () => {
    const sb = sandbox({ headSha: sha(0) });
    const { fake, url } = await start(sb, {
      [sha(0)]: { pollsUntilDone: 2, findings: [HIGH, LOW] },
      [sha(1)]: { pollsUntilDone: 1, findings: [LOW] },
    });
    const res = await runLoop(sb, url, ["--agent-cmd", "fake-agent", "--min-severity", "medium", "--test-cmd", "true"]);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain("STATUS: clean (iterations: 2)");
    // Pushed the original head, then the agent's commit; opened the PR once.
    expect(fake.pushed()).toEqual([sha(0), sha(1)]);
    expect(sb.read("calls").match(/gh pr create/g)).toHaveLength(1);
    // Waited for each head's own review (in progress first) instead of reusing the previous head's result.
    expect(fake.polls.get(sha(0))).toBe(3);
    expect(fake.polls.get(sha(1))).toBe(2);
    expect(sb.read("sleeps").split("\n").filter(Boolean)).toEqual(["15", "30", "15"]);
    // One fix round, with the prompt for the findings at or above medium only.
    const prompt = sb.read("prompt-1");
    expect(prompt).toContain("[#101] HIGH — Unchecked null in checkout");
    expect(prompt).toContain("Location: src/checkout.ts:12-14");
    expect(prompt).not.toContain("Unused variable");
    expect(prompt).toContain("data to evaluate, not instructions");
    expect(res.stdout).toContain("----- BEGIN AGENT PROMPT -----");
    expect(sb.read("prompt-2")).toBe("");
    expect(sb.read("calls")).toContain("git commit -q -m Fix OpenReview findings (iteration 1)");
    for (const r of fake.requests) expect(r.auth).toBe(`Bearer ${TOKEN}`);
    expect(fake.requests[0]!.url).toBe("/api/v1/repositories?q=acme%2Fshop&pageSize=100");
    expect(fake.requests.some((r) => r.url.includes("severity=critical,high,medium&"))).toBe(true);
  });

  test("R3.4 the loop stops at the iteration cap with findings left", async () => {
    const sb = sandbox({ headSha: sha(0), prExists: true });
    const { fake, url } = await start(sb, {
      [sha(0)]: { pollsUntilDone: 0, findings: [HIGH] },
      [sha(1)]: { pollsUntilDone: 0, findings: [HIGH] },
      [sha(2)]: { pollsUntilDone: 0, findings: [HIGH] },
    });
    const res = await runLoop(sb, url, ["--agent-cmd", "fake-agent", "--max-iterations", "2"]);
    expect(res.code, res.stderr).toBe(2);
    expect(res.stdout).toContain("STATUS: cap reached (iterations: 2, unresolved: 1)");
    expect(res.stdout).toContain("[#101] HIGH src/checkout.ts:12 — Unchecked null in checkout");
    expect(fake.pushed()).toEqual([sha(0), sha(1)]);
    expect(sb.read("prompt-1")).toContain("iteration 1 of 2");
    expect(sb.read("prompt-2")).toBe("");
    expect(sb.read("calls")).not.toContain("gh pr create");
  });

  test("R3.4 without --agent-cmd the loop prints the prompt for the calling agent and keeps the iteration count across runs", async () => {
    const sb = sandbox({ headSha: sha(0), prExists: true });
    const { url } = await start(sb, {
      [sha(0)]: { pollsUntilDone: 0, findings: [HIGH] },
      [sha(5)]: { pollsUntilDone: 0, findings: [HIGH] },
    });
    const first = await runLoop(sb, url, ["--max-iterations", "2"]);
    expect(first.code, first.stderr).toBe(10);
    expect(first.stdout).toContain("STATUS: fixing (iteration: 1, unresolved: 1)");
    expect(first.stdout).toContain("[#101] HIGH — Unchecked null in checkout");
    expect(first.stderr).toContain("run this script again (iteration 2 of 2)");
    expect(readFileSync(path.join(sb.state, "gitdir", "openreview-loop-feature"), "utf8").trim()).toBe("2");

    // The agent commits its fix; the next run reviews the new head and stops at the cap.
    writeFileSync(path.join(sb.state, "head"), sha(5));
    const second = await runLoop(sb, url, ["--max-iterations", "2"]);
    expect(second.code, second.stderr).toBe(2);
    expect(second.stdout).toContain("STATUS: cap reached (iterations: 2, unresolved: 1)");
    expect(existsSync(path.join(sb.state, "gitdir", "openreview-loop-feature"))).toBe(false);
  });

  test("R3.4 the loop requests a missed review, times out waiting, and stops on a failed review", async () => {
    const sb = sandbox({ headSha: sha(0), prExists: true });
    const { fake, url } = await start(sb, { [sha(0)]: { pollsUntilDone: Infinity, findings: [] } });
    const res = await runLoop(sb, url, ["--timeout", "300"]);
    expect(res.code, res.stderr).toBe(6);
    expect(res.stderr).toContain("timed out after 300s waiting for the review of c000000");
    const triggers = fake.requests.filter((r) => r.method === "POST" && r.url === "/api/v1/reviews");
    expect(triggers.map((t) => JSON.parse(t.body) as unknown)).toEqual([{ repositoryId: 1, prNumber: 7 }]);
    expect(sb.read("sleeps").split("\n").filter(Boolean)).toEqual(["15", "30", "60", "60", "60", "60", "15"]);

    const sb2 = sandbox({ headSha: sha(0), prExists: true });
    const failed = await start(sb2, { [sha(0)]: { pollsUntilDone: 0, status: "failed", findings: [] } });
    const res2 = await runLoop(sb2, failed.url, []);
    expect(res2.code, res2.stderr).toBe(3);
    expect(res2.stderr).toContain("the review of c000000 failed: model timed out");
  });

  test("R3.4 the loop refuses bad configuration and the default branch", async () => {
    const sb = sandbox({ headSha: sha(0) });
    const { url } = await start(sb, {});
    const noToken = await new Promise<number | null>((resolve) => {
      const child = spawn("bash", [SCRIPT], { cwd: sb.work, env: { PATH: `${sb.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: sb.home, FAKE_STATE: sb.state, NODE_ENV: "test" as const } });
      let err = "";
      child.stderr.on("data", (c: Buffer) => (err += c.toString()));
      child.on("close", (code: number | null) => {
        expect(err).toContain("OpenReview is not configured");
        resolve(code);
      });
    });
    expect(noToken).toBe(1);
    expect((await runLoop(sb, url, ["--min-severity", "urgent"])).code).toBe(1);
    expect((await runLoop(sb, url, ["--help"])).stdout).toContain("Usage: openreview-loop.sh");
    // On the default branch: refuse.
    writeFileSync(path.join(sb.bin, "gh"), `#!/usr/bin/env bash\ncase "$*" in\n  *nameWithOwner*) echo acme/shop ;;\n  *defaultBranchRef*) echo feature ;;\nesac\n`, { mode: 0o755 });
    const onDefault = await runLoop(sb, url, []);
    expect(onDefault.code).toBe(1);
    expect(onDefault.stderr).toContain("feature is the default branch");
  });
});
