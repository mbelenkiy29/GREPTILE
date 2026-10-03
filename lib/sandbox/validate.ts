/**
 * Runtime validation for a review run (R4.5). Runs only when the deployment enables it (RUNTIME_VALIDATION_ENABLED)
 * AND the repository's config does (`runtimeValidation.enabled`, read at the PR's base commit or from the repo's
 * dashboard settings — never from the PR head). The PR head is fetched into a throwaway directory by the worker's git
 * path, streamed into the sandbox with `git archive` (no `.git`), and the result is stored in `runtime_validations`.
 * Sandbox problems never fail the review: they are recorded as `error` and reported.
 */
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { scoped } from "@/lib/data/tenant";
import type { Db } from "@/lib/db";
import { runtimeValidations, type RuntimeValidationConfig } from "@/lib/db/schema";
import { CancelledError, type RuntimeValidationResult } from "@/lib/engine/types";
import { sandboxEnv, type SandboxEnv } from "@/lib/env";
import { archiveTree, fetchRef } from "@/lib/indexer/git";
import { errorMessage, log as rootLog, type Logger } from "@/lib/log";
import { imageAllowed } from "./config";
import { toResult } from "./results";
import { DockerSandbox } from "./docker";
import { parseFailingTests } from "./failures";
import { httpDockerTransport } from "./transport";
import type { SandboxRunner, SandboxSpec } from "./types";

const SHA = /^[0-9a-f]{40,64}$/;

/** What the review job needs to run validations; built from the environment by {@link sandboxFromEnv}. */
export interface RuntimeValidationDeps {
  env: SandboxEnv;
  /** The sandbox; null when no Docker engine is configured. */
  runner: SandboxRunner | null;
  /** Parent directory for the throwaway head checkouts. */
  workDir: string;
  /**
   * The source tree at `sha` as a tar stream, given the clone URL. Defaults to a shallow fetch of `sha` into a
   * throwaway directory under `workDir` and `git archive`.
   */
  source?: (input: { url: string; sha: string; dir: string }) => Promise<SandboxSpec["source"]>;
  log?: Logger;
  now?: () => Date;
}

/** Runtime validation deps from the environment (a Docker sandbox when SANDBOX_DOCKER_HOST is set). */
export function sandboxFromEnv(cacheDir: string, log?: Logger, source: Record<string, string | undefined> = process.env): RuntimeValidationDeps {
  const env = sandboxEnv(source);
  const runner = env.SANDBOX_DOCKER_HOST
    ? new DockerSandbox(httpDockerTransport(env.SANDBOX_DOCKER_HOST), {
        cpus: env.SANDBOX_CPUS,
        memoryMb: env.SANDBOX_MEMORY_MB,
        workdirMb: env.SANDBOX_WORKDIR_MB,
        maxOutputBytes: env.SANDBOX_MAX_OUTPUT_KB * 1024,
        registryProxy: env.SANDBOX_REGISTRY_PROXY ?? null,
        installNetwork: env.SANDBOX_INSTALL_NETWORK,
        ...(log ? { log } : {}),
      })
    : null;
  return { env, runner, workDir: path.join(cacheDir, "sandbox"), ...(log ? { log } : {}) };
}

export interface RuntimeValidationInput {
  orgId: string;
  reviewRunId: number;
  /** The effective runtime validation config (from the base commit's openreview.json or repo settings). */
  config: RuntimeValidationConfig | null;
  headSha: string;
  /** Clone URL with short-lived credentials (never passed into the sandbox). */
  cloneUrl: () => Promise<string>;
  signal?: AbortSignal;
}

/** The default source: shallow-fetch `sha` into `dir` and stream `git archive` of it. */
async function gitSource({ url, sha, dir }: { url: string; sha: string; dir: string }): Promise<SandboxSpec["source"]> {
  await fetchRef(url, dir, sha, { depth: 1, timeoutMs: 300_000 });
  return () => archiveTree(dir, sha);
}

/**
 * Runs the repository's runtime validation for a review run (see the module comment). Returns null when the repository
 * does not ask for it. Throws {@link CancelledError} when `signal` aborts (the review was cancelled); any other
 * problem is stored and returned as an `error` result.
 */
export async function runRuntimeValidation(db: Db, deps: RuntimeValidationDeps, input: RuntimeValidationInput): Promise<RuntimeValidationResult | null> {
  const config = input.config;
  if (!config?.enabled) return null;
  const log = (deps.log ?? rootLog).child({ component: "runtime-validation", orgId: input.orgId, reviewRunId: input.reviewRunId });
  const clock = deps.now ?? (() => new Date());
  const image = config.image ?? deps.env.SANDBOX_IMAGE;
  const network = config.network ?? "none";
  const commands = { install: config.install ?? null, test: config.test };
  const base = { orgId: input.orgId, reviewRunId: input.reviewRunId, image, network, commands };
  const reset = {
    status: "queued" as const,
    image,
    network,
    commands,
    failedStep: null,
    exitCode: null,
    durationMs: null,
    outputExcerpt: null,
    outputTruncated: false,
    failingTests: [],
    reason: null,
    startedAt: null,
    finishedAt: null,
  };
  // One row per run; a retried run starts it over.
  const [row] = await db
    .insert(runtimeValidations)
    .values(base)
    .onConflictDoUpdate({ target: runtimeValidations.reviewRunId, set: reset })
    .returning();
  const id = row!.id;
  const update = async (values: Partial<typeof runtimeValidations.$inferInsert>) => {
    const [updated] = await db
      .update(runtimeValidations)
      .set(values)
      .where(scoped(runtimeValidations, input.orgId, eq(runtimeValidations.id, id)))
      .returning();
    return updated!;
  };
  const end = async (status: "skipped" | "error", reason: string) => toResult(await update({ status, reason, finishedAt: clock(), durationMs: 0 }));

  if (!deps.env.RUNTIME_VALIDATION_ENABLED) return end("skipped", "Runtime validation is turned off on this OpenReview server (RUNTIME_VALIDATION_ENABLED).");
  if (!deps.runner) return end("skipped", "No sandbox is configured on this OpenReview server (SANDBOX_DOCKER_HOST).");
  if (!imageAllowed(image, deps.env.SANDBOX_ALLOWED_IMAGES)) return end("error", `The image ${image} is not allowed on this server (SANDBOX_ALLOWED_IMAGES).`);
  if (!SHA.test(input.headSha)) return end("error", "The pull request head is not a commit sha.");

  const timeoutSec = Math.min(config.timeoutSec ?? deps.env.SANDBOX_TIMEOUT_SEC, deps.env.SANDBOX_TIMEOUT_SEC);
  const startedAt = clock();
  await update({ status: "running", startedAt });
  const dir = path.join(deps.workDir, `${input.reviewRunId}-${randomBytes(6).toString("hex")}`);
  try {
    await mkdir(dir, { recursive: true });
    const source = await (deps.source ?? gitSource)({ url: await input.cloneUrl(), sha: input.headSha, dir });
    if (input.signal?.aborted) throw new CancelledError();
    const result = await deps.runner.run({
      image,
      install: commands.install,
      test: commands.test,
      env: config.env ?? {},
      network,
      timeoutMs: timeoutSec * 1000,
      source,
      ...(input.signal ? { signal: input.signal } : {}),
      labels: { "dev.openreview.org": input.orgId, "dev.openreview.review-run": String(input.reviewRunId) },
    });
    const reason = [result.error, ...result.notes].filter(Boolean).join(" ") || null;
    log.info("runtime validation finished", { status: result.status, exitCode: result.exitCode, durationMs: result.durationMs, failedStep: result.failedStep });
    return toResult(
      await update({
        status: result.status,
        failedStep: result.failedStep,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        outputExcerpt: result.output,
        outputTruncated: result.truncated,
        failingTests: result.status === "failed" ? parseFailingTests(result.output) : [],
        reason,
        finishedAt: clock(),
      }),
    );
  } catch (err) {
    if (err instanceof CancelledError || input.signal?.aborted) {
      await update({ status: "error", reason: "Cancelled with the review.", finishedAt: clock(), durationMs: clock().getTime() - startedAt.getTime() }).catch(() => undefined);
      throw err instanceof CancelledError ? err : new CancelledError();
    }
    const message = errorMessage(err, 500);
    log.warn("runtime validation could not run", { error: message });
    return toResult(
      await update({ status: "error", reason: `Runtime validation could not run: ${message}`, finishedAt: clock(), durationMs: clock().getTime() - startedAt.getTime() }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
