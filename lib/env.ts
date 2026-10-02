import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const indexMaxFileBytes = z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().positive().default(524_288));

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

  LLM_PROVIDER: z.enum(["anthropic", "openai", "fake"]).default("anthropic"),
  LLM_MODEL: optional,
  LLM_BASE_URL: optional,
  LLM_API_KEY: optional,
  EMBEDDING_PROVIDER: z.enum(["openai", "fake"]).default("openai"),
  EMBEDDING_MODEL: optional,
  EMBEDDING_BASE_URL: optional,
  EMBEDDING_API_KEY: optional,

  REPO_CACHE_DIR: z.string().default("/tmp/openreview-repos"),
  /** Files larger than this many bytes are skipped by the indexer (R6.3). */
  INDEX_MAX_FILE_BYTES: indexMaxFileBytes,
});

export type Env = z.infer<typeof schema>;

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

/** Indexer settings; parsed on their own so indexing does not require the full app env. */
export function indexerEnv() {
  return z.object({ INDEX_MAX_FILE_BYTES: indexMaxFileBytes }).parse(process.env);
}
