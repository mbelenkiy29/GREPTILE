/**
 * Recorded model responses (R6.22 demo walkthrough, R6.24 evaluation harness). `RecordingLlm` wraps a real provider
 * and keeps every answer with its usage and model; `ReplayLlm` answers from such a recording without any network,
 * so a walkthrough or an evaluation can run offline and deterministically.
 *
 * Prompts carry per-review nonces and retrieved context that differ between runs, so calls are matched by what made
 * them (`task` and `meta.agent`), in order, not by prompt text. A recording is labelled with its origin: `recorded`
 * (captured from the named model with `--record`) or `scripted` (hand-written responses for a fixture, used to test
 * the harness itself; they say nothing about any model's quality).
 */
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  LlmError,
  LlmValidationError,
  type JsonRequest,
  type JsonResult,
  type LlmProvider,
  type TextRequest,
  type TextResult,
  type Usage,
} from "./types";

const usageSchema = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0).optional(),
  cacheWriteTokens: z.number().int().min(0).optional(),
});

export const recordedCallSchema = z.object({
  /** `<task>:<agent>` (see {@link callKey}). */
  key: z.string().min(1),
  /** Structured output (json calls) or the answer text (text calls). */
  response: z.unknown(),
  /** Tokens the call used, when captured from a provider. */
  usage: usageSchema.optional(),
  /** The model that answered, when captured from a provider. */
  model: z.string().optional(),
});
export type RecordedCall = z.infer<typeof recordedCallSchema>;

export const recordingSchema = z.object({
  version: z.literal(1),
  origin: z.enum(["recorded", "scripted"]),
  description: z.string().default(""),
  /** Provider and model a `recorded` recording was captured from. */
  provider: z.string().optional(),
  model: z.string().optional(),
  recordedAt: z.string().optional(),
  calls: z.array(recordedCallSchema),
  /** Answers for calls the recording has no specific entry for, by task (e.g. reviewers that found nothing). */
  defaults: z.record(z.string(), z.unknown()).default({}),
});
export type Recording = z.infer<typeof recordingSchema>;

/** What a call is matched by: its task and the engine stage / agent that made it. */
export function callKey(req: { task?: string; meta?: { agent?: string | null } }): string {
  return `${req.task ?? "default"}:${req.meta?.agent ?? "none"}`;
}

/** No recorded answer for a call: the recording does not match the code under review. */
export class ReplayMissError extends LlmError {
  constructor(key: string, source: string) {
    super(`no recorded response for ${key} in ${source}; record it again with a configured model (--record)`, { retryable: false });
    this.name = "ReplayMissError";
  }
}

const estimate = (req: { system: string; prompt: string }, out: string): Usage => ({
  inputTokens: Math.ceil((req.system.length + req.prompt.length) / 4),
  outputTokens: Math.ceil(out.length / 4),
});

/** Answers every call from a recording, in order per key, then from its defaults. Never touches the network. */
export class ReplayLlm implements LlmProvider {
  readonly name = "replay";
  readonly model: string;
  /** Every call answered, with its key, in order. */
  readonly served: { key: string; kind: "json" | "text"; prompt: string; system: string }[] = [];
  private readonly queues = new Map<string, RecordedCall[]>();

  constructor(
    readonly recording: Recording,
    private readonly source = "the recording",
  ) {
    this.model = recording.model ?? `${recording.origin}-replay`;
    for (const c of recording.calls) {
      const q = this.queues.get(c.key) ?? [];
      q.push(c);
      this.queues.set(c.key, q);
    }
  }

  /** Recorded calls that were never asked for (a recording that no longer matches the code). */
  unused(): string[] {
    return [...this.queues.entries()].flatMap(([key, q]) => q.map(() => key));
  }

  private next(req: { task?: string; meta?: { agent?: string | null } }): { response: unknown; usage?: Usage; model?: string } {
    const key = callKey(req);
    const queued = this.queues.get(key)?.shift();
    if (queued) return { response: queued.response, usage: queued.usage, model: queued.model ?? this.recording.model };
    const task = req.task ?? "default";
    if (task in this.recording.defaults) return { response: this.recording.defaults[task], model: this.recording.model };
    throw new ReplayMissError(key, this.source);
  }

  async json<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
    const hit = this.next(req);
    this.served.push({ key: callKey(req), kind: "json", prompt: req.prompt, system: req.system });
    const text = JSON.stringify(hit.response) ?? "";
    const usage = hit.usage ?? estimate(req, text);
    const parsed = req.schema.safeParse(hit.response);
    if (!parsed.success) throw new LlmValidationError(`recorded output does not match ${req.schemaName}`, z.prettifyError(parsed.error), { usage });
    return { data: parsed.data, usage, ...(hit.model ? { servedModel: hit.model } : {}) };
  }

  async text(req: TextRequest): Promise<TextResult> {
    const hit = this.next(req);
    this.served.push({ key: callKey(req), kind: "text", prompt: req.prompt, system: req.system });
    const text = typeof hit.response === "string" ? hit.response : JSON.stringify(hit.response);
    return { text, usage: hit.usage ?? estimate(req, text), ...(hit.model ? { servedModel: hit.model } : {}) };
  }
}

/** Wraps a real provider and records every answer (`--record`); `recording()` returns what was captured. */
export class RecordingLlm implements LlmProvider {
  readonly name: string;
  private readonly calls: RecordedCall[] = [];

  constructor(
    private readonly inner: LlmProvider,
    private readonly meta: { provider: string; description?: string; now?: () => Date },
  ) {
    this.name = inner.name;
  }

  get model(): string {
    return this.inner.model;
  }

  private servedModel(result: { servedModel?: string; route?: { model?: string } }): string | undefined {
    return result.servedModel ?? result.route?.model ?? (this.inner.model || undefined);
  }

  async json<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
    const result = await this.inner.json(req);
    const model = this.servedModel(result as JsonResult<T> & { route?: { model?: string } });
    this.calls.push({ key: callKey(req), response: result.data, usage: result.usage, ...(model ? { model } : {}) });
    return result;
  }

  async text(req: TextRequest): Promise<TextResult> {
    const result = await this.inner.text(req);
    const model = this.servedModel(result as TextResult & { route?: { model?: string } });
    this.calls.push({ key: callKey(req), response: result.text, usage: result.usage, ...(model ? { model } : {}) });
    return result;
  }

  recording(): Recording {
    const models = [...new Set(this.calls.map((c) => c.model).filter((m): m is string => !!m))];
    return {
      version: 1,
      origin: "recorded",
      description: this.meta.description ?? "",
      provider: this.meta.provider,
      ...(models.length ? { model: models.join(", ") } : {}),
      recordedAt: (this.meta.now ?? (() => new Date()))().toISOString(),
      calls: this.calls,
      defaults: {},
    };
  }
}

export async function loadRecording(file: string): Promise<Recording> {
  return recordingSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

export async function saveRecording(file: string, recording: Recording): Promise<void> {
  await writeFile(file, `${JSON.stringify(recording, null, 2)}\n`);
}
