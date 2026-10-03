/**
 * The Docker sandbox (R4.5). Each run gets a fresh container and a fresh in-memory volume, both removed in `finally`:
 *
 * - no network (`NetworkMode: none`); with the `install-only` policy and a configured registry proxy, the container
 *   starts on the proxy's internal network, runs the install step, and is disconnected (and checked to be offline)
 *   before the test step;
 * - CPU quota, memory limit with swap disabled, a pids limit, read-only root filesystem, every capability dropped,
 *   `no-new-privileges`, a non-root user, an init process, no host mounts (the workdir is a tmpfs-backed volume and
 *   `/tmp` a tmpfs);
 * - the source arrives through the archive API (a tar stream, owned by the sandbox user), never a bind mount;
 * - commands run with `sh -c` through the exec API, inside the container only, with only the declared environment;
 * - a hard wall-clock timeout kills the container; output is demultiplexed, capped (head and tail), and redacted.
 */
import { randomBytes } from "node:crypto";
import { CancelledError } from "@/lib/engine/types";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";
import { withTag } from "./config";
import { demultiplex, OutputCollector } from "./output";
import { expectStatus, readJson, readText, type DockerRequest, type DockerResponse, type DockerTransport } from "./transport";
import type { SandboxResult, SandboxRunner, SandboxSpec, SandboxStep } from "./types";

export const SANDBOX_WORKDIR = "/workspace";
export const SANDBOX_PIDS_LIMIT = 256;
/** Unprivileged uid:gid the commands run as (the source tree is owned by it). */
export const SANDBOX_USER = "1000:1000";

const MIB = 1024 * 1024;
const DOCKER_ID = /^[a-f0-9]{12,64}$/;
const NETWORK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface DockerSandboxOptions {
  cpus: number;
  memoryMb: number;
  /** Size of the tmpfs-backed workdir volume. */
  workdirMb: number;
  maxOutputBytes: number;
  /** HTTP(S) forward proxy (allowing only package registries) for `install-only` installs. */
  registryProxy?: string | null;
  /** Internal Docker network on which only the registry proxy is reachable. */
  installNetwork?: string;
  log?: Logger;
  now?: () => number;
  /** Limit for each cleanup request (kill, remove). */
  cleanupTimeoutMs?: number;
}

/** Environment the sandbox always sets; repository variables come on top (they cannot override these). */
function baseEnv(): Record<string, string> {
  return { HOME: "/tmp", TMPDIR: "/tmp", CI: "true" };
}

function proxyEnv(proxy: string): Record<string, string> {
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    npm_config_proxy: proxy,
    npm_config_https_proxy: proxy,
  };
}

function envList(env: Record<string, string>): string[] {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

async function drain(res: DockerResponse) {
  for await (const chunk of res.body) void chunk;
}

function dockerId(value: unknown, what: string): string {
  if (typeof value !== "string" || !DOCKER_ID.test(value)) throw new Error(`Docker returned an invalid ${what} id`);
  return value;
}

export class DockerSandbox implements SandboxRunner {
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(
    private readonly transport: DockerTransport,
    private readonly opts: DockerSandboxOptions,
  ) {
    this.log = (opts.log ?? rootLog).child({ component: "sandbox" });
    this.now = opts.now ?? Date.now;
    if (opts.installNetwork !== undefined && !NETWORK_NAME.test(opts.installNetwork)) throw new Error("SANDBOX_INSTALL_NETWORK is not a valid network name");
  }

  /** The exact container definition a run uses (exported for review and tests). */
  containerConfig(spec: SandboxSpec, name: string, installNetwork: string | null) {
    return {
      Image: spec.image,
      // The container only idles; the steps run through exec. The idle time outlasts the run's own timeout.
      Entrypoint: ["sleep"],
      Cmd: [String(Math.ceil(spec.timeoutMs / 1000) + 120)],
      User: SANDBOX_USER,
      WorkingDir: SANDBOX_WORKDIR,
      Env: envList(baseEnv()),
      Labels: { "dev.openreview.sandbox": "true", ...spec.labels },
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      OpenStdin: false,
      Tty: false,
      NetworkDisabled: installNetwork === null,
      HostConfig: {
        NetworkMode: installNetwork ?? "none",
        NanoCpus: Math.round(this.opts.cpus * 1e9),
        Memory: this.opts.memoryMb * MIB,
        // Equal to Memory: no swap.
        MemorySwap: this.opts.memoryMb * MIB,
        PidsLimit: SANDBOX_PIDS_LIMIT,
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        CapAdd: [],
        SecurityOpt: ["no-new-privileges:true"],
        Privileged: false,
        Init: true,
        Binds: [],
        Devices: [],
        Mounts: [{ Type: "volume", Source: name, Target: SANDBOX_WORKDIR, ReadOnly: false, VolumeOptions: { NoCopy: true } }],
        Tmpfs: { "/tmp": `rw,nosuid,nodev,size=${Math.min(1024, this.opts.workdirMb)}m` },
        Ulimits: [{ Name: "nofile", Soft: 4096, Hard: 4096 }],
        LogConfig: { Type: "none", Config: {} },
        RestartPolicy: { Name: "no" },
        AutoRemove: false,
      },
    };
  }

  /** The tmpfs-backed workdir volume a run uses. */
  volumeConfig(spec: SandboxSpec, name: string) {
    const [uid, gid] = SANDBOX_USER.split(":");
    return {
      Name: name,
      Driver: "local",
      DriverOpts: { type: "tmpfs", device: "tmpfs", o: `size=${this.opts.workdirMb}m,uid=${uid},gid=${gid},mode=0700` },
      Labels: { "dev.openreview.sandbox": "true", ...spec.labels },
    };
  }

  async run(spec: SandboxSpec): Promise<SandboxResult> {
    const started = this.now();
    const name = `openreview-sbx-${randomBytes(8).toString("hex")}`;
    const out = new OutputCollector(this.opts.maxOutputBytes);
    const steps: SandboxStep[] = [];
    const notes: string[] = [];
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("sandbox timed out"));
    }, spec.timeoutMs);
    timer.unref?.();
    const onCancel = () => controller.abort(new CancelledError("review cancelled"));
    if (spec.signal?.aborted) onCancel();
    spec.signal?.addEventListener("abort", onCancel, { once: true });

    let containerId: string | null = null;
    // Set before the create requests: a create cut off by the timeout may still have happened, so cleanup goes by name.
    let containerAttempted = false;
    let volumeAttempted = false;
    let current: SandboxStep["step"] | null = null;
    const finish = (status: SandboxResult["status"], failedStep: SandboxResult["failedStep"], exitCode: number | null, error?: string): SandboxResult => ({
      status,
      failedStep,
      exitCode,
      durationMs: this.now() - started,
      output: out.text(),
      truncated: out.truncated,
      steps,
      notes,
      ...(error ? { error } : {}),
    });
    const req = (r: DockerRequest) => this.transport.request({ ...r, signal: controller.signal });

    let result: SandboxResult | undefined;
    try {
      await this.ensureImage(spec.image, req);
      const installNetwork = spec.network === "install-only" && spec.install && this.opts.registryProxy ? (this.opts.installNetwork ?? null) : null;
      if (spec.network === "install-only" && spec.install && !installNetwork) {
        notes.push("No registry proxy is configured (SANDBOX_REGISTRY_PROXY), so the install step ran without network access.");
      }

      volumeAttempted = true;
      await expectStatus(await req({ method: "POST", path: "/volumes/create", json: this.volumeConfig(spec, name) }), [200, 201], "create volume");
      containerAttempted = true;
      const created = await req({ method: "POST", path: "/containers/create", query: { name }, json: this.containerConfig(spec, name, installNetwork) });
      await expectStatus(created, [201], "create container");
      containerId = dockerId((await readJson<{ Id?: unknown }>(created)).Id, "container");
      const startRes = await req({ method: "POST", path: `/containers/${containerId}/start` });
      await expectStatus(startRes, [204, 304], "start container");
      await drain(startRes);

      const upload = await req({
        method: "PUT",
        path: `/containers/${containerId}/archive`,
        query: { path: SANDBOX_WORKDIR, noOverwriteDirNonDir: true, copyUIDGID: true },
        tar: spec.source(),
      });
      await expectStatus(upload, [200], "copy the source into the container");
      await drain(upload);

      const env = { ...spec.env, ...baseEnv() };
      if (spec.install) {
        current = "install";
        const step = await this.exec(containerId, "install", spec.install, installNetwork ? { ...env, ...proxyEnv(this.opts.registryProxy!) } : env, out, req, steps);
        if (step.exitCode !== 0) result = finish("failed", "install", step.exitCode);
      }
      if (!result) {
        if (installNetwork) await this.goOffline(containerId, installNetwork, req);
        current = "test";
        const step = await this.exec(containerId, "test", spec.test, env, out, req, steps);
        result = step.exitCode === 0 ? finish("passed", null, 0) : finish("failed", "test", step.exitCode);
      }
      if (result.exitCode === 137) notes.push("Exit code 137: the process was killed (often the memory limit, SANDBOX_MEMORY_MB).");
    } catch (err) {
      if (spec.signal?.aborted) result = undefined;
      else if (timedOut) {
        out.write(`\n[killed: the run exceeded its ${Math.round(spec.timeoutMs / 1000)}s limit]\n`);
        result = finish("timeout", current, null, `timed out after ${Math.round(spec.timeoutMs / 1000)}s`);
      } else {
        result = finish("error", null, null, errorMessage(err, 500));
      }
    } finally {
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", onCancel);
      await this.cleanup(containerId ?? (containerAttempted ? name : null), volumeAttempted ? name : null);
    }
    if (!result) throw new CancelledError("review cancelled during runtime validation");
    return result;
  }

  /** Pulls the image unless the engine already has it. */
  private async ensureImage(image: string, req: (r: DockerRequest) => Promise<DockerResponse>) {
    const tagged = withTag(image);
    const inspect = await req({ method: "GET", path: `/images/${tagged}/json` });
    if (inspect.status === 200) return drain(inspect);
    await expectStatus(inspect, [404], "inspect image");
    const pull = await req({ method: "POST", path: "/images/create", query: { fromImage: tagged } });
    await expectStatus(pull, [200], `pull ${tagged}`);
    const progress = await readText(pull, 8 * MIB);
    for (const line of progress.split("\n")) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as { error?: unknown };
        if (typeof msg.error === "string") throw new Error(`pull ${tagged} failed: ${msg.error.slice(0, 300)}`);
      } catch (err) {
        if (err instanceof SyntaxError) continue;
        throw err;
      }
    }
  }

  private async exec(
    containerId: string,
    step: SandboxStep["step"],
    command: string,
    env: Record<string, string>,
    out: OutputCollector,
    req: (r: DockerRequest) => Promise<DockerResponse>,
    steps: SandboxStep[],
  ): Promise<SandboxStep> {
    const t0 = this.now();
    const record: SandboxStep = { step, command, exitCode: null, durationMs: 0 };
    steps.push(record);
    out.write(`$ ${command}\n`);
    const created = await req({
      method: "POST",
      path: `/containers/${containerId}/exec`,
      json: {
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Privileged: false,
        User: SANDBOX_USER,
        WorkingDir: SANDBOX_WORKDIR,
        Env: envList(env),
        Cmd: ["sh", "-c", command],
      },
    });
    await expectStatus(created, [201], `create the ${step} step`);
    const execId = dockerId((await readJson<{ Id?: unknown }>(created)).Id, "exec");
    const started = await req({ method: "POST", path: `/exec/${execId}/start`, json: { Detach: false, Tty: false } });
    await expectStatus(started, [200], `start the ${step} step`);
    await demultiplex(started.body, (chunk) => out.write(chunk));
    // The stream ends when the process exits; the engine may take a moment to record the exit code.
    for (let i = 0; i < 20; i++) {
      const inspected = await req({ method: "GET", path: `/exec/${execId}/json` });
      await expectStatus(inspected, [200], `inspect the ${step} step`);
      const info = await readJson<{ Running?: boolean; ExitCode?: number | null }>(inspected);
      if (!info.Running && typeof info.ExitCode === "number") {
        record.exitCode = info.ExitCode;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    record.durationMs = this.now() - t0;
    out.write(`\n[${step} exited with code ${record.exitCode ?? "unknown"}]\n`);
    return record;
  }

  /** Detaches the container from the install network and checks it has no network left. */
  private async goOffline(containerId: string, network: string, req: (r: DockerRequest) => Promise<DockerResponse>) {
    const res = await req({ method: "POST", path: `/networks/${encodeURIComponent(network)}/disconnect`, json: { Container: containerId, Force: true } });
    await expectStatus(res, [200], "disconnect the install network");
    await drain(res);
    const inspected = await req({ method: "GET", path: `/containers/${containerId}/json` });
    await expectStatus(inspected, [200], "inspect the container");
    const info = await readJson<{ NetworkSettings?: { Networks?: Record<string, unknown> | null } }>(inspected);
    const left = Object.keys(info.NetworkSettings?.Networks ?? {}).filter((n) => n !== "none");
    if (left.length) throw new Error(`the container is still attached to ${left.join(", ")}; refusing to run the tests with network access`);
  }

  /** Kills and removes the container (by id or name) and its volume; failures are logged, never thrown. */
  private async cleanup(container: string | null, volume: string | null) {
    const timeoutMs = this.opts.cleanupTimeoutMs ?? 30_000;
    const attempt = async (what: string, r: DockerRequest, ok: number[]) => {
      try {
        const res = await this.transport.request({ ...r, signal: AbortSignal.timeout(timeoutMs) });
        if (ok.includes(res.status)) await drain(res);
        else await expectStatus(res, ok, what);
      } catch (err) {
        this.log.warn(`sandbox cleanup: ${what} failed`, { error: errorMessage(err) });
      }
    };
    if (container) {
      // 409: not running any more.
      await attempt("kill container", { method: "POST", path: `/containers/${container}/kill` }, [204, 404, 409]);
      await attempt("remove container", { method: "DELETE", path: `/containers/${container}`, query: { force: true, v: true } }, [204, 404]);
    }
    if (volume) await attempt("remove volume", { method: "DELETE", path: `/volumes/${volume}`, query: { force: true } }, [204, 404]);
  }

  /**
   * Removes sandbox containers and volumes left behind by a worker that died mid-run: containers labeled as ours and
   * created more than `maxAgeMs` ago (longer than any run may last), and our unused volumes older than that. Returns
   * how many of each were removed.
   */
  async sweep(maxAgeMs: number): Promise<{ containers: number; volumes: number }> {
    const signal = AbortSignal.timeout(this.opts.cleanupTimeoutMs ?? 30_000);
    const cutoff = this.now() - maxAgeMs;
    const label = JSON.stringify({ label: ["dev.openreview.sandbox=true"] });
    const removed = { containers: 0, volumes: 0 };
    const list = await this.transport.request({ method: "GET", path: "/containers/json", query: { all: true, filters: label }, signal });
    await expectStatus(list, [200], "list sandbox containers");
    for (const c of await readJson<{ Id?: unknown; Created?: unknown }[]>(list)) {
      if (typeof c.Created !== "number" || c.Created * 1000 > cutoff || typeof c.Id !== "string" || !DOCKER_ID.test(c.Id)) continue;
      await this.cleanup(c.Id, null);
      removed.containers++;
    }
    const volumes = await this.transport.request({ method: "GET", path: "/volumes", query: { filters: JSON.stringify({ label: ["dev.openreview.sandbox=true"], dangling: ["true"] }) }, signal });
    await expectStatus(volumes, [200], "list sandbox volumes");
    for (const v of (await readJson<{ Volumes?: { Name?: unknown; CreatedAt?: unknown }[] | null }>(volumes)).Volumes ?? []) {
      const created = typeof v.CreatedAt === "string" ? Date.parse(v.CreatedAt) : NaN;
      if (typeof v.Name !== "string" || !/^openreview-sbx-[0-9a-f]{16}$/.test(v.Name) || !(created <= cutoff)) continue;
      await this.cleanup(null, v.Name);
      removed.volumes++;
    }
    return removed;
  }
}
