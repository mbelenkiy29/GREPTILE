import { createHash } from "node:crypto";
import type { EmbeddingProvider, JsonRequest, LlmProvider, TextRequest, Usage } from "./types";

export type FakeCall = { kind: "json"; req: JsonRequest<unknown> } | { kind: "text"; req: TextRequest };

/**
 * Deterministic provider for tests and offline dev: a handler maps each request
 * to a canned response; every call is recorded. Never touches the network (H4).
 */
export class FakeLlm implements LlmProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  readonly calls: FakeCall[] = [];

  constructor(private readonly handler: (call: FakeCall) => unknown = () => ({})) {}

  private usageFor(req: { system: string; prompt: string }, out: string): Usage {
    return { inputTokens: Math.ceil((req.system.length + req.prompt.length) / 4), outputTokens: Math.ceil(out.length / 4) };
  }

  async json<T>(req: JsonRequest<T>) {
    const call: FakeCall = { kind: "json", req: req as JsonRequest<unknown> };
    this.calls.push(call);
    const data = req.schema.parse(await this.handler(call));
    return { data, usage: this.usageFor(req, JSON.stringify(data)) };
  }

  async text(req: TextRequest) {
    const call: FakeCall = { kind: "text", req };
    this.calls.push(call);
    const text = String(await this.handler(call));
    return { text, usage: this.usageFor(req, text) };
  }
}

/**
 * Deterministic bag-of-tokens embedding: texts sharing identifiers land close
 * together, which is enough to exercise vector retrieval without a model.
 */
export class FakeEmbeddings implements EmbeddingProvider {
  readonly name = "fake";

  constructor(readonly dimensions = 64) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(this.dimensions).fill(0);
      for (const tok of t.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? []) {
        const h = createHash("sha1").update(tok).digest();
        v[h.readUInt16BE(0) % this.dimensions]! += 1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
}
