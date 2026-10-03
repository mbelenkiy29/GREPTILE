/**
 * `pnpm demo` (R6.22): runs the real review pipeline on a local fixture repository without a GitHub App.
 *
 *   DEMO_MODE=true pnpm demo                 review with the configured model (LLM_PROVIDER, LLM_API_KEY, ...)
 *   DEMO_MODE=true LLM_PROVIDER=fake pnpm demo   offline walkthrough: replays fixtures/demo-repo/recorded/review.json
 *   DEMO_MODE=true pnpm demo --record        review with the configured model and save its responses as the recording
 *
 * Needs DATABASE_URL (migrated with `pnpm db:migrate`). Reads `.env` when present. Then `pnpm dev`, sign in with dev
 * login (AUTH_DEV_LOGIN=true), and open the printed review URL.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { db, sql } from "@/lib/db";
import { llmEnvSchema, localModeEnv } from "@/lib/env";
import { localModeBlocker } from "@/lib/git/local/guard";
import { createGateway, embeddings, PostgresModelCallRecorder, type EmbeddingProvider, type LlmProvider } from "@/lib/llm";
import { FakeEmbeddings } from "@/lib/llm/fake";
import { loadRecording, RecordingLlm, ReplayLlm, saveRecording } from "@/lib/llm/replay";
import { DEMO_FIXTURE_DIR, runLocalDemo } from "@/lib/local-demo";

const RECORDING = path.join(DEMO_FIXTURE_DIR, "recorded", "review.json");

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

async function main() {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const { values } = parseArgs({ options: { record: { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false } } });
  if (values.help) {
    console.log("Usage: pnpm demo [--record]\n\nRuns the real review pipeline on fixtures/demo-repo through the local git host (DEMO_MODE=true).");
    return;
  }

  const mode = localModeEnv();
  const blocker = localModeBlocker(mode);
  if (blocker) fail(blocker);
  const llmEnv = llmEnvSchema.parse(process.env);
  const database = db();
  const recorder = new PostgresModelCallRecorder(database);

  let llm: LlmProvider;
  let recording: RecordingLlm | undefined;
  if (llmEnv.LLM_PROVIDER === "fake") {
    if (values.record) fail("--record needs a real model: set LLM_PROVIDER and LLM_API_KEY.");
    const replay = new ReplayLlm(await loadRecording(RECORDING), path.relative(process.cwd(), RECORDING));
    llm = createGateway({ provider: replay, recorder });
    const origin =
      replay.recording.origin === "scripted"
        ? "hand-written responses for this fixture, not a live model"
        : `responses recorded from ${replay.recording.model ?? "a model"} on ${replay.recording.recordedAt ?? "an earlier run"}`;
    console.log(`Offline walkthrough (LLM_PROVIDER=fake): replaying ${path.relative(process.cwd(), RECORDING)} — ${origin}.`);
  } else {
    const gateway = createGateway({ recorder });
    const problem = gateway.configurationError("review");
    if (problem) {
      fail(
        `No model is configured for reviews (${problem}).\n  Set LLM_PROVIDER and LLM_API_KEY (or ANTHROPIC_API_KEY), or run an offline walkthrough with recorded responses:\n    DEMO_MODE=true LLM_PROVIDER=fake EMBEDDING_PROVIDER=fake pnpm demo`,
      );
    }
    llm = gateway;
    if (values.record) {
      recording = new RecordingLlm(gateway, { provider: llmEnv.LLM_PROVIDER, description: "Captured by `pnpm demo --record` on the discount-cap pull request of fixtures/demo-repo." });
      llm = recording;
    }
    console.log(`Reviewing with ${llmEnv.LLM_PROVIDER} (${gateway.routeFor("review").model}).`);
  }

  let embedder: EmbeddingProvider;
  const embeddingKeyMissing = llmEnv.EMBEDDING_PROVIDER === "openai" && !llmEnv.EMBEDDING_API_KEY;
  if (llmEnv.EMBEDDING_PROVIDER === "fake" || embeddingKeyMissing) {
    if (embeddingKeyMissing) console.log("No EMBEDDING_API_KEY: semantic search uses the offline token-hash embedding (EMBEDDING_PROVIDER=fake).");
    embedder = new FakeEmbeddings();
  } else {
    embedder = embeddings({ db: database });
  }

  const result = await runLocalDemo({
    db: database,
    mode,
    llm,
    embedder,
    cacheDir: process.env.REPO_CACHE_DIR || "/tmp/openreview-repos",
    appUrl: process.env.APP_URL || "http://localhost:3000",
    progress: (m) => console.log(`• ${m}`),
  });

  if (recording) {
    await saveRecording(RECORDING, recording.recording());
    console.log(`Saved the model's responses to ${path.relative(process.cwd(), RECORDING)}.`);
  }

  const { run } = result;
  if (run.status !== "completed") fail(`The review ended ${run.status}${run.reason ? `: ${run.reason}` : ""}.`);
  console.log(`\n✓ Reviewed ${result.repository}#${result.prNumber}: ${run.findings ?? 0} finding(s), ${run.posted ?? 0} inline comment(s) posted.`);
  console.log(`  Review:        ${result.reviewUrl}`);
  console.log(`  Pull request:  ${result.pullRequestUrl}`);
  console.log("  Start the app with `pnpm dev` and sign in with dev login (AUTH_DEV_LOGIN=true) to open them.\n");
}

main()
  .catch((err) => fail(err instanceof Error ? err.message : String(err)))
  .finally(() => sql().end({ timeout: 5 }));
