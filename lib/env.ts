import { z } from "zod";

/** A numeric variable; unset or empty falls through to `inner`'s default. */
const optionalNumber = <T extends z.ZodType>(inner: T) =>
  z.preprocess((v) => (v === undefined || v === "" ? undefined : Number(v)), inner);

const optional = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

/** Model gateway settings (R6.15, R6.16); also parsed on their own by `llmEnvSchema`. */
const llmShape = {
  LLM_PROVIDER: z.enum(["anthropic", "openai", "openrouter", "openai-compatible", "fake"]).default("anthropic"),
  LLM_MODEL: optional,
  LLM_BASE_URL: optional,
  LLM_API_KEY: optional,
  /** Per-task model overrides; each falls back to LLM_MODEL, then the provider's built-in route. */
  LLM_MODEL_REVIEW: optional,
  LLM_MODEL_VERIFY: optional,
  LLM_MODEL_SUMMARY: optional,
  LLM_MODEL_CLASSIFY: optional,
  LLM_MODEL_CONTEXT: optional,
  LLM_MODEL_CHAT: optional,
  LLM_MODEL_KNOWLEDGE: optional,
  LLM_MODEL_RULES: optional,
  /** Review and verify model for the fast / deep review modes. */
  LLM_MODEL_FAST: optional,
  LLM_MODEL_DEEP: optional,
  LLM_TIMEOUT_MS: optionalNumber(z.number().int().positive().default(180_000)),
  LLM_MAX_RETRIES: optionalNumber(z.number().int().min(0).max(10).default(3)),
  /** USD per million tokens, merged over the built-in table: {"model": {"input": 1, "output": 2, ...}}. */
  LLM_PRICING_JSON: optional,
  LLM_CACHE_TTL_HOURS: optionalNumber(z.number().positive().default(168)),
  EMBEDDING_PROVIDER: z.enum(["openai", "openai-compatible", "fake"]).default("openai"),
  EMBEDDING_MODEL: optional,
  EMBEDDING_BASE_URL: optional,
  EMBEDDING_API_KEY: optional,
};

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  /** Secret for signing app-issued tokens such as the GitHub install `state`. */
  APP_SECRET: z.string().min(16),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_SLUG: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  GITHUB_API_URL: z.string().url().default("https://api.github.com"),
  /** Login that `@mentions` the bot in PR comments (R1.7). */
  BOT_MENTION: z.string().default("openreview"),

  ...llmShape,

  REPO_CACHE_DIR: z.string().default("/tmp/openreview-repos"),
});

export type Env = z.infer<typeof schema>;

/** The variables the model gateway reads, so `lib/llm` can be configured without the full server env. */
export const llmEnvSchema = z.object({ APP_URL: z.string().url().default("http://localhost:3000"), ...llmShape });

export type LlmEnv = z.infer<typeof llmEnvSchema>;

let cached: Env | undefined;

/** Parsed server env. Throws with a readable message if a required variable is missing. */
export function env(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}

/** Only the variables the health check and db/redis clients need. */
export function infraEnv() {
  return z.object({ DATABASE_URL: z.string().url(), REDIS_URL: z.string().url() }).parse(process.env);
}
