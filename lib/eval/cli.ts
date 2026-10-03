/**
 * The `pnpm eval` command line (R6.24); `scripts/eval.ts` runs it. See `eval/README.md`.
 *
 *   pnpm eval                               live, with the model configured in the environment (LLM_PROVIDER, ...)
 *   pnpm eval --provider fake --recorded    replay eval/recordings/<mode>/ (deterministic, offline; what CI runs)
 *   pnpm eval --record                      live, saving every answer to eval/recordings/<mode>/
 *   options: --mode fast|standard|deep, --case <id> (repeatable or comma-separated), --concurrency <n>, --out <dir>,
 *            --recordings <dir>
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { llmEnvSchema } from "@/lib/env";
import { createGateway, embeddings, InMemoryModelCallRecorder } from "@/lib/llm";
import { REVIEW_MODES, type ReviewMode } from "@/lib/llm/types";
import { loadCases } from "./cases";
import { consoleTable, saveReport } from "./report";
import { RECORDINGS_DIR, REPORTS_DIR, runEval, type EvalReport, type ModelSource } from "./run";

export class EvalUsageError extends Error {}

export interface EvalArgs {
  help: boolean;
  replay: boolean;
  record: boolean;
  provider?: string;
  mode: ReviewMode;
  cases: string[];
  concurrency: number;
  out: string;
  recordings: string;
}

export function parseEvalArgs(argv: string[]): EvalArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        provider: { type: "string" },
        recorded: { type: "boolean", default: false },
        record: { type: "boolean", default: false },
        mode: { type: "string", default: "standard" },
        case: { type: "string", multiple: true, default: [] },
        concurrency: { type: "string", default: "2" },
        out: { type: "string" },
        recordings: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (err) {
    throw new EvalUsageError((err as Error).message);
  }
  const mode = values.mode as ReviewMode;
  if (!(REVIEW_MODES as readonly string[]).includes(mode)) throw new EvalUsageError(`--mode must be one of ${REVIEW_MODES.join(", ")}`);
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new EvalUsageError("--concurrency must be an integer from 1 to 16");
  if (values.recorded && values.record) throw new EvalUsageError("--recorded replays recordings and --record writes them; pick one");
  if (values.recorded && values.provider && values.provider !== "fake") throw new EvalUsageError("--recorded replays recordings offline; use it with --provider fake (or alone)");
  if (values.provider === "fake" && !values.recorded) throw new EvalUsageError("--provider fake needs --recorded: the fake provider can only replay recorded responses");
  return {
    help: values.help,
    replay: values.recorded,
    record: values.record,
    ...(values.provider ? { provider: values.provider } : {}),
    mode,
    cases: values.case.flatMap((c) => c.split(",")).map((c) => c.trim()).filter(Boolean),
    concurrency,
    out: path.resolve(values.out ?? REPORTS_DIR),
    recordings: path.resolve(values.recordings ?? RECORDINGS_DIR),
  };
}

export const EVAL_USAGE =
  "Usage: pnpm eval [--provider fake --recorded | --record] [--mode fast|standard|deep] [--case <id>] [--concurrency 2] [--out eval/reports]\nSee eval/README.md.";

/** Runs the command; returns the exit code (1 when a case failed to run or the arguments are wrong). */
export async function evalMain(
  argv: string[],
  io: { out: (line: string) => void; err: (line: string) => void; env?: Record<string, string | undefined> } = { out: console.log, err: console.error },
): Promise<{ code: number; report?: EvalReport; files?: { markdown: string; json: string } }> {
  let args: EvalArgs;
  try {
    args = parseEvalArgs(argv);
  } catch (err) {
    io.err(`${(err as Error).message}\n${EVAL_USAGE}`);
    return { code: 2 };
  }
  if (args.help) {
    io.out(EVAL_USAGE);
    return { code: 0 };
  }
  const cases = await loadCases(undefined, args.cases);

  let source: ModelSource;
  if (args.replay) {
    source = { kind: "replay", dir: args.recordings };
  } else {
    const env = { ...(io.env ?? process.env), ...(args.provider ? { LLM_PROVIDER: args.provider } : {}) };
    const llmEnv = llmEnvSchema.parse(env);
    const probe = createGateway({ env });
    const problem = probe.configurationError("review");
    if (problem) {
      io.err(`No model is configured (${problem}). Set LLM_PROVIDER and LLM_API_KEY, or replay the committed recordings: pnpm eval --provider fake --recorded`);
      return { code: 2 };
    }
    const noEmbeddings = llmEnv.EMBEDDING_PROVIDER === "fake" || (llmEnv.EMBEDDING_PROVIDER === "openai" && !llmEnv.EMBEDDING_API_KEY);
    if (noEmbeddings) io.out("No embedding model configured: retrieval uses the code graph and full-text search only.");
    source = {
      kind: "live",
      provider: llmEnv.LLM_PROVIDER,
      model: probe.routeFor("review", args.mode).model,
      llm: () => createGateway({ env, recorder: new InMemoryModelCallRecorder() }),
      ...(noEmbeddings ? {} : { embedder: embeddings({}) }),
      ...(args.record ? { recordDir: args.recordings } : {}),
    };
  }

  io.out(`Running ${cases.length} case${cases.length === 1 ? "" : "s"} in ${args.mode} mode (${source.kind === "replay" ? "replaying recordings" : `live: ${source.provider}`})…\n`);
  const report = await runEval({ cases, mode: args.mode, concurrency: args.concurrency, source });
  const files = await saveReport(report, args.out);
  io.out(consoleTable(report));
  io.out(`\nReport: ${path.relative(process.cwd(), files.markdown)} and ${path.relative(process.cwd(), files.json)}`);
  if (args.record) io.out(`Recordings: ${path.relative(process.cwd(), path.join(args.recordings, args.mode))}/`);
  if (report.totals.errors) {
    io.err(`\n${report.totals.errors} case(s) failed to run; see the report.`);
    return { code: 1, report, files };
  }
  return { code: 0, report, files };
}
