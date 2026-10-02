import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const flag = z
  .enum(["true", "false", ""])
  .optional()
  .transform((v) => v === "true");

const fields = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
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
  GITHUB_WEB_URL: z.string().url().default("https://github.com"),
  /** The GitHub App's own OAuth credentials, used for "Sign in with GitHub" (R6.1). */
  GITHUB_APP_CLIENT_ID: optional,
  GITHUB_APP_CLIENT_SECRET: optional,
  /** Login that `@mentions` the bot in PR comments (R1.7). */
  BOT_MENTION: z.string().default("openreview"),

  /** Session lifetime; active sessions slide forward (at most once an hour). */
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** Local development / Playwright only: "Continue as local developer" on /sign-in. Rejected in production. */
  AUTH_DEV_LOGIN: flag,

  LLM_PROVIDER: z.enum(["anthropic", "openai", "fake"]).default("anthropic"),
  LLM_MODEL: optional,
  LLM_BASE_URL: optional,
  LLM_API_KEY: optional,
  EMBEDDING_PROVIDER: z.enum(["openai", "fake"]).default("openai"),
  EMBEDDING_MODEL: optional,
  EMBEDDING_BASE_URL: optional,
  EMBEDDING_API_KEY: optional,

  REPO_CACHE_DIR: z.string().default("/tmp/openreview-repos"),
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
