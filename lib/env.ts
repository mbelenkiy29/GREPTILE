import { z } from "zod";

/** A numeric variable; unset or empty falls through to `inner`'s default. */
const optionalNumber = <T extends z.ZodType>(inner: T) =>
  z.preprocess((v) => (v === undefined || v === "" ? undefined : Number(v)), inner);

/** A boolean flag: "true"/"1"/"yes" are true; unset or empty is false (already-parsed booleans pass through). */
const flag = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => (typeof v === "boolean" ? v : ["true", "1", "yes"].includes((v ?? "").trim().toLowerCase())));

const optional = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

/** Credits one review consumes in each mode (R4.1). */
const creditsShape = {
  CREDITS_FAST: optionalNumber(z.number().min(0).default(1)),
  CREDITS_STANDARD: optionalNumber(z.number().min(0).default(2)),
  CREDITS_DEEP: optionalNumber(z.number().min(0).default(4)),
};

const indexMaxFileBytes = z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().positive().default(524_288));
/** Review pipeline settings (R6.6, R6.16); also parsed on their own by `pipelineEnv()`. */
const pipelineShape = {
  /** Delay before a review queued by a push starts, so bursts of pushes are reviewed once. */
  REVIEW_DEBOUNCE_MS: optionalNumber(z.number().int().min(0).max(3_600_000).default(15_000)),
  /** Heartbeat age after which a non-terminal review run is considered abandoned and re-queued. */
  REVIEW_STALE_MS: optionalNumber(z.number().int().min(60_000).default(600_000)),
};
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
  /**
   * Slowest output rate a call is allowed: an attempt may run for max(LLM_TIMEOUT_MS, maxTokens / rate) so long
   * deep-mode calls are not cut off. 0 disables the allowance.
   */
  LLM_MIN_OUTPUT_TOKENS_PER_SEC: optionalNumber(z.number().min(0).default(60)),
  /** Let organizations' own LLM endpoints use http and private / loopback / link-local addresses (SSRF guard off). */
  LLM_ALLOW_PRIVATE_ORG_ENDPOINTS: flag,
  /** USD per million tokens, merged over the built-in table: {"model": {"input": 1, "output": 2, ...}}. */
  LLM_PRICING_JSON: optional,
  LLM_CACHE_TTL_HOURS: optionalNumber(z.number().positive().default(168)),
  EMBEDDING_PROVIDER: z.enum(["openai", "openai-compatible", "fake"]).default("openai"),
  EMBEDDING_MODEL: optional,
  EMBEDDING_BASE_URL: optional,
  EMBEDDING_API_KEY: optional,
  /** Embedding cache rows older than this are re-embedded and pruned. */
  EMBEDDING_CACHE_TTL_DAYS: optionalNumber(z.number().positive().default(90)),
};

/** REST API settings (R6.18); also parsed on their own by `apiEnv()`. */
const apiShape = {
  /** Requests one API key (or signed-in user) may make per minute; over it the API answers 429 with retry-after. */
  API_RATE_LIMIT_PER_MINUTE: optionalNumber(z.number().int().min(1).max(100_000).default(120)),
};

/** Public, non-secret settings the UI shell needs; also parsed on their own by `siteEnv()`. */
const siteShape = {
  /** Source of the running version, linked from the dashboard footer (AGPL-3.0 §13). */
  SOURCE_CODE_URL: z.string().url().default("https://github.com/openreview/openreview"),
  GITHUB_WEB_URL: z.string().url().default("https://github.com"),
};

const fields = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  SOURCE_CODE_URL: siteShape.SOURCE_CODE_URL,
  /** Secret for signing app-issued tokens such as the GitHub install `state` and the OAuth state cookie. */
  APP_SECRET: z.string().min(16),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_SLUG: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  GITHUB_API_URL: z.string().url().default("https://api.github.com"),
  /** Web origin of the GitHub instance (GitHub Enterprise Server: `https://ghe.example.com`). */
  GITHUB_WEB_URL: siteShape.GITHUB_WEB_URL,
  /** The GitHub App's own OAuth credentials, used for "Sign in with GitHub" (R6.1). */
  GITHUB_APP_CLIENT_ID: optional,
  GITHUB_APP_CLIENT_SECRET: optional,
  /** Login that `@mentions` the bot in PR comments (R1.7). */
  BOT_MENTION: z.string().default("openreview"),

  /** Session lifetime; active sessions slide forward (at most once an hour). */
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** Local development / Playwright only: "Continue as local developer" on /sign-in. Rejected in production. */
  AUTH_DEV_LOGIN: flag,

  ...llmShape,

  REPO_CACHE_DIR: z.string().default("/tmp/openreview-repos"),
  /** Concurrent jobs per worker process. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  /** Webhook delivery records older than this are pruned by the worker (R6.21). */
  WEBHOOK_DELIVERY_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  /** Files larger than this many bytes are skipped by the indexer (R6.3). */
  INDEX_MAX_FILE_BYTES: indexMaxFileBytes,

  ...creditsShape,
  ...pipelineShape,
  ...apiShape,
});

function rejectDevLoginInProduction(e: { NODE_ENV: string; AUTH_DEV_LOGIN: boolean }, ctx: z.RefinementCtx) {
  if (e.AUTH_DEV_LOGIN && e.NODE_ENV === "production") {
    ctx.addIssue({
      code: "custom",
      path: ["AUTH_DEV_LOGIN"],
      message: "AUTH_DEV_LOGIN=true is only allowed outside production (NODE_ENV=production disables it).",
    });
  }
}

const schema = fields.superRefine(rejectDevLoginInProduction);

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

const siteSchema = z.object(siteShape);
export type SiteEnv = z.infer<typeof siteSchema>;

/** Settings the UI shell reads (source link, GitHub web origin); parsed on their own so pages need no secrets. */
export function siteEnv(source: Record<string, string | undefined> = process.env): SiteEnv {
  return siteSchema.parse({
    SOURCE_CODE_URL: source.SOURCE_CODE_URL || undefined,
    GITHUB_WEB_URL: source.GITHUB_WEB_URL || undefined,
  });
}

/** Indexer settings; parsed on their own so indexing does not require the full app env. */
export function indexerEnv() {
  return z.object({ INDEX_MAX_FILE_BYTES: indexMaxFileBytes }).parse(process.env);
}

/** Review credit costs per mode (R4.1); parsed on their own so the engine does not require the full app env. */
export function creditsEnv(source: Record<string, string | undefined> = process.env) {
  return z.object(creditsShape).parse(source);
}

const pipelineSchema = z.object(pipelineShape);
export type PipelineEnv = z.infer<typeof pipelineSchema>;

/** Review pipeline settings; parsed on their own so reviews (and tests) do not require the full app env. */
export function pipelineEnv(source: Record<string, string | undefined> = process.env): PipelineEnv {
  return pipelineSchema.parse(source);
}

const authSchema = fields
  .pick({
    NODE_ENV: true,
    APP_URL: true,
    APP_SECRET: true,
    GITHUB_API_URL: true,
    GITHUB_WEB_URL: true,
    GITHUB_APP_CLIENT_ID: true,
    GITHUB_APP_CLIENT_SECRET: true,
    SESSION_TTL_DAYS: true,
    AUTH_DEV_LOGIN: true,
  })
  .superRefine(rejectDevLoginInProduction);

export type AuthEnv = z.infer<typeof authSchema>;

/** Validates the variables sign-in and sessions need (R6.1). Exported for tests; use `authEnv()` at runtime. */
export function parseAuthEnv(source: Record<string, string | undefined>): AuthEnv {
  return authSchema.parse(source);
}

let cachedAuth: AuthEnv | undefined;

/** The auth subset of the env, so sign-in and sessions work without the GitHub App or LLM variables. */
export function authEnv(): AuthEnv {
  cachedAuth ??= parseAuthEnv(process.env);
  return cachedAuth;
}

const apiSchema = z.object({ APP_URL: z.string().url().default("http://localhost:3000"), ...apiShape });
export type ApiEnv = z.infer<typeof apiSchema>;

/** REST API settings (R6.18); parsed on their own so the API does not require the GitHub App or LLM variables. */
export function apiEnv(source: Record<string, string | undefined> = process.env): ApiEnv {
  return apiSchema.parse({ APP_URL: source.APP_URL || undefined, API_RATE_LIMIT_PER_MINUTE: source.API_RATE_LIMIT_PER_MINUTE });
}
