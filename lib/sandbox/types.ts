import type { Readable } from "node:stream";

export type NetworkPolicy = "none" | "install-only";

/** One sandboxed run (R4.5): a source tree, an optional install command, and a test command. */
export interface SandboxSpec {
  image: string;
  install: string | null;
  test: string;
  /** Environment for both commands (only what the repository config declares; never secrets). */
  env: Record<string, string>;
  network: NetworkPolicy;
  /** Hard wall-clock limit for the whole run (pull excluded). */
  timeoutMs: number;
  /** The source tree as a tar stream (a clean checkout at the PR head, without `.git`); called once. */
  source: () => Readable | AsyncIterable<Uint8Array>;
  /** Aborts the run (the review was cancelled); the container is killed and removed, then CancelledError is thrown. */
  signal?: AbortSignal;
  /** Correlation labels put on the container and volume. */
  labels?: Record<string, string>;
}

export interface SandboxStep {
  step: "install" | "test";
  command: string;
  exitCode: number | null;
  durationMs: number;
}

export interface SandboxResult {
  status: "passed" | "failed" | "timeout" | "error";
  failedStep: "install" | "test" | null;
  exitCode: number | null;
  durationMs: number;
  /** Combined output of the steps: capped (head and tail), sanitized, and redacted. */
  output: string;
  truncated: boolean;
  steps: SandboxStep[];
  /** Notes worth showing (e.g. the install ran without network). */
  notes: string[];
  /** Why the run errored. */
  error?: string;
}

export interface SandboxRunner {
  run(spec: SandboxSpec): Promise<SandboxResult>;
  /** Removes leftovers of runs older than `maxAgeMs` (a worker that died mid-run). */
  sweep?(maxAgeMs: number): Promise<{ containers: number; volumes: number }>;
}
