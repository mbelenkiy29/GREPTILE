import { z } from "zod";
import { LlmError, type EmbeddingProvider, type JsonRequest, type LlmProvider, type TextRequest } from "./types";

interface OpenAiConfig {
  baseURL: string;
  apiKey?: string;
  model: string;
  fetch?: typeof fetch;
}

async function post<T>(cfg: Omit<OpenAiConfig, "model">, path: string, body: unknown): Promise<T> {
  const res = await (cfg.fetch ?? fetch)(`${cfg.baseURL.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new LlmError(`${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

interface ChatResponse {
  choices: { message: { content: string | null; refusal?: string | null } }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/** Any OpenAI-compatible chat endpoint (OpenAI, vLLM, Ollama, LM Studio, ...). */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = "openai";
  readonly model: string;

  constructor(private readonly cfg: OpenAiConfig) {
    this.model = cfg.model;
  }

  private async chat(system: string, prompt: string, model: string | undefined, maxTokens: number, extra: object) {
    const res = await post<ChatResponse>(this.cfg, "/chat/completions", {
      model: model ?? this.model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      ...extra,
    });
    const msg = res.choices[0]?.message;
    if (!msg?.content) throw new LlmError(msg?.refusal ? `model refused: ${msg.refusal}` : "empty completion");
    return {
      content: msg.content,
      usage: { inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 },
    };
  }

  async json<T>(req: JsonRequest<T>) {
    const { content, usage } = await this.chat(req.system, req.prompt, req.model, req.maxTokens ?? 16000, {
      response_format: {
        type: "json_schema",
        json_schema: { name: req.schemaName, schema: z.toJSONSchema(req.schema), strict: false },
      },
    });
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fenced ? fenced[1]! : content);
    } catch {
      throw new LlmError(`invalid JSON for ${req.schemaName}`);
    }
    const result = req.schema.safeParse(parsed);
    if (!result.success) throw new LlmError(`output does not match ${req.schemaName}: ${result.error.message}`);
    return { data: result.data, usage };
  }

  async text(req: TextRequest) {
    const { content, usage } = await this.chat(req.system, req.prompt, req.model, req.maxTokens ?? 16000, {});
    return { text: content, usage };
  }
}

export class OpenAiCompatibleEmbeddings implements EmbeddingProvider {
  readonly name = "openai";

  constructor(private readonly cfg: OpenAiConfig) {}

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const batch = texts.slice(i, i + 64);
      const res = await post<{ data: { index: number; embedding: number[] }[] }>(this.cfg, "/embeddings", {
        model: this.cfg.model,
        input: batch,
      });
      out.push(...res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding));
    }
    return out;
  }
}
