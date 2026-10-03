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

/** Knowledge base settings (R6.12); also parsed on their own by `knowledgeEnv()`. */
const knowledgeShape = {
  /** Generate and refresh the repository knowledge base after indexing. On unless set to false / 0 / no / off. */
  KNOWLEDGE_ENABLED: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (typeof v === "boolean" ? v : !["false", "0", "no", "off"].includes((v ?? "").trim().toLowerCase()))),
  /** Entries regenerated per refresh run (model calls); the rest stay stale for the next run. */
  KNOWLEDGE_MAX_ENTRIES_PER_RUN: optionalNumber(z.number().int().min(1).max(12).default(5)),
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

/** GitLab and Bitbucket Cloud (R3.6); also parsed on their own by `scmEnv()`. */
const scmShape = {
  /** GitLab instance origin: gitlab.com or a self-managed instance (`https://gitlab.example.com`). */
  GITLAB_URL: z.string().url().default("https://gitlab.com"),
  /** Bitbucket Cloud REST API base. */
  BITBUCKET_API_URL: z.string().url().default("https://api.bitbucket.org/2.0"),
};

/** REST API settings (R6.18); also parsed on their own by `apiEnv()`. */
const apiShape = {
  /** Requests one API key (or signed-in user) may make per minute; over it the API answers 429 with retry-after. */
  API_RATE_LIMIT_PER_MINUTE: optionalNumber(z.number().int().min(1).max(100_000).default(120)),
  /** How long a CLI review (`POST /api/v1/reviews/local`, R3.5) may run inside its request before it is aborted. */
  LOCAL_REVIEW_TIMEOUT_MS: optionalNumber(z.number().int().min(10_000).max(900_000).default(300_000)),
};

/**
 * Plans, usage limits, and optional Stripe billing (R4.2, R4.3); also parsed on their own by `billingEnv()`. Billing is
 * on only when all four STRIPE_* variables are set; otherwise every org is on the unlimited self-hosted plan.
 */
const billingShape = {
  STRIPE_SECRET_KEY: optional,
  STRIPE_WEBHOOK_SECRET: optional,
  /** Recurring per-seat price of the team plan. */
  STRIPE_PRICE_TEAM_SEAT: optional,
  /** Metered price (attached to a Stripe billing meter) for overage credits. */
  STRIPE_PRICE_OVERAGE: optional,
  /** Credits the free plan includes per billing period. */
  FREE_MONTHLY_CREDITS: optionalNumber(z.number().int().min(0).default(50)),
  /** Credits the team plan includes per seat per billing period; usage beyond is billed as overage. */
  TEAM_INCLUDED_CREDITS_PER_SEAT: optionalNumber(z.number().int().min(0).default(200)),
  /** Display prices (USD) shown on billing and pricing pages; keep them equal to the Stripe prices. */
  TEAM_SEAT_PRICE_USD: optionalNumber(z.number().min(0).default(24)),
  OVERAGE_CREDIT_PRICE_USD: optionalNumber(z.number().min(0).default(0.2)),
  /** Let usage alert webhooks target http and private / loopback / link-local addresses (SSRF guard off). */
  USAGE_ALERT_ALLOW_PRIVATE_URLS: flag,
};

/** Enterprise and hardening settings (R4.6, R6.20); also parsed on their own by `enterpriseEnv()`. */
const enterpriseShape = {
  /** Let SSO connections use http and private / loopback issuers and IdP endpoints (SSRF guard off). */
  SSO_ALLOW_PRIVATE_ISSUERS: flag,
  /** Audit log entries older than this are pruned by the worker. */
  AUDIT_RETENTION_DAYS: optionalNumber(z.number().int().min(1).max(3650).default(365)),
  /**
   * Extra hosts server-side HTTP may reach, comma-separated (`hooks.example.com`, `*.corp.example`). The LLM and
   * embedding endpoints, the git hosts, Stripe (when billing is configured), and SSO issuers are always allowed.
   */
  OUTBOUND_ALLOWLIST: optional,
  /** Refuse outbound HTTP to hosts outside the allowlist (otherwise such calls are allowed and logged). */
  OUTBOUND_ALLOWLIST_ENFORCE: flag,
  /** Requests per minute one client address may make to each public sign-in, SSO, and invitation endpoint. */
  PUBLIC_RATE_LIMIT_PER_MINUTE: optionalNumber(z.number().int().min(1).max(100_000).default(30)),
  /** Webhook deliveries per minute accepted for one installation (generous: bursts of pushes are normal). */
  WEBHOOK_RATE_LIMIT_PER_MINUTE: optionalNumber(z.number().int().min(1).max(1_000_000).default(1_200)),
};

/**
 * Runtime validation (R4.5, beta); also parsed on their own by `sandboxEnv()`. Off unless RUNTIME_VALIDATION_ENABLED is
 * set AND a repository enables `runtimeValidation` in its config. The worker talks to a Docker Engine API at
 * SANDBOX_DOCKER_HOST; run that engine on a separate sandbox host or rootless, and never mount its socket into the web
 * container.
 */
const sandboxShape = {
  RUNTIME_VALIDATION_ENABLED: flag,
  /** `unix:///var/run/docker.sock` or `tcp://sandbox-host:2375` (plain HTTP; reach a remote engine over a private network). */
  SANDBOX_DOCKER_HOST: optional,
  SANDBOX_IMAGE: z.string().trim().min(1).default("node:22-bookworm-slim"),
  /** Comma-separated images (`*` wildcards) repositories may choose; empty = any image. */
  SANDBOX_ALLOWED_IMAGES: optional,
  SANDBOX_CPUS: optionalNumber(z.number().min(0.1).max(64).default(2)),
  SANDBOX_MEMORY_MB: optionalNumber(z.number().int().min(128).max(262_144).default(2048)),
  /** Size of the in-memory (tmpfs) volume holding the checkout and everything the commands write. */
  SANDBOX_WORKDIR_MB: optionalNumber(z.number().int().min(64).max(262_144).default(2048)),
  SANDBOX_TIMEOUT_SEC: optionalNumber(z.number().int().min(10).max(7200).default(600)),
  SANDBOX_MAX_OUTPUT_KB: optionalNumber(z.number().int().min(4).max(10_240).default(256)),
  /**
   * HTTP(S) forward proxy that only allows package registries, reachable on SANDBOX_INSTALL_NETWORK. Required for the
   * `install-only` network policy; without it installs run offline.
   */
  SANDBOX_REGISTRY_PROXY: optional,
  /** Docker network (create it with `--internal`) on which only the registry proxy is reachable. */
  SANDBOX_INSTALL_NETWORK: z.string().trim().min(1).default("openreview-sandbox-install"),
};

/** Public "Paste a PR" demo (R3.7); also parsed on their own by `demoEnv()`. Off unless DEMO_ENABLED is set. */
const demoShape = {
  DEMO_ENABLED: flag,
  DEMO_PER_IP_PER_HOUR: optionalNumber(z.number().int().min(1).max(10_000).default(3)),
  DEMO_GLOBAL_PER_HOUR: optionalNumber(z.number().int().min(1).max(100_000).default(30)),
  /** Leading zero bits the browser's proof-of-work must find (each extra bit doubles the work). */
  DEMO_POW_DIFFICULTY: optionalNumber(z.number().int().min(8).max(28).default(18)),
  DEMO_MAX_REPO_MB: optionalNumber(z.number().min(1).max(10_000).default(50)),
  DEMO_MAX_PR_FILES: optionalNumber(z.number().int().min(1).max(3000).default(50)),
  DEMO_MAX_PR_ADDITIONS: optionalNumber(z.number().int().min(1).max(1_000_000).default(2000)),
  /** Estimated model spend (USD, from model_calls) per UTC day after which demo reviews are refused. */
  DEMO_DAILY_COST_USD: optionalNumber(z.number().min(0).default(5)),
  DEMO_RETENTION_HOURS: optionalNumber(z.number().min(1).max(24 * 365).default(24)),
  /** Optional token (no scopes needed) for a higher GitHub API rate limit; never used to write. */
  DEMO_GITHUB_TOKEN: optional,
};

/** Public, non-secret settings the UI shell needs; also parsed on their own by `siteEnv()`. */
const siteShape = {
  /** Source of the running version, linked from the dashboard footer (AGPL-3.0 §13). */
  SOURCE_CODE_URL: z.string().url().default("https://github.com/openreview/openreview"),
  GITHUB_WEB_URL: z.string().url().default("https://github.com"),
};

/**
 * GitHub App setup page (R6.25); also parsed on their own by `setupEnv()`, which must work before the GitHub App
 * variables exist. `INSTANCE_ADMIN_EMAILS` names the instance admins (comma-separated, case-insensitive); empty means
 * the first user who signed in.
 */
const setupShape = {
  INSTANCE_ADMIN_EMAILS: optional,
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
  ...knowledgeShape,
  ...apiShape,
  ...billingShape,
  ...enterpriseShape,
  ...scmShape,
  ...sandboxShape,
  ...demoShape,
  ...setupShape,
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

const knowledgeSchema = z.object(knowledgeShape);
export type KnowledgeEnv = z.infer<typeof knowledgeSchema>;

/** Knowledge base settings (R6.12); parsed on their own so knowledge jobs (and tests) do not require the full app env. */
export function knowledgeEnv(source: Record<string, string | undefined> = process.env): KnowledgeEnv {
  return knowledgeSchema.parse(source);
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
  return apiSchema.parse({
    APP_URL: source.APP_URL || undefined,
    API_RATE_LIMIT_PER_MINUTE: source.API_RATE_LIMIT_PER_MINUTE,
    LOCAL_REVIEW_TIMEOUT_MS: source.LOCAL_REVIEW_TIMEOUT_MS,
  });
}

const billingSchema = z.object({ APP_URL: z.string().url().default("http://localhost:3000"), ...billingShape });
export type BillingEnv = z.infer<typeof billingSchema>;

/** Plan, usage-limit, and Stripe settings (R4.2, R4.3); parsed on their own so billing needs no GitHub or LLM variables. */
export function billingEnv(source: Record<string, string | undefined> = process.env): BillingEnv {
  return billingSchema.parse({ ...source, APP_URL: source.APP_URL || undefined });
}

const enterpriseSchema = z.object(enterpriseShape);
export type EnterpriseEnv = z.infer<typeof enterpriseSchema>;

/** SSO, audit retention, outbound allowlist, and public rate limits; parsed on their own so tests need no full env. */
export function enterpriseEnv(source: Record<string, string | undefined> = process.env): EnterpriseEnv {
  return enterpriseSchema.parse(source);
}

const scmSchema = z.object({ APP_URL: z.string().url().default("http://localhost:3000"), ...scmShape });
export type ScmEnv = z.infer<typeof scmSchema>;

/** GitLab / Bitbucket settings (R3.6); parsed on their own so connecting a provider needs no GitHub App or LLM variables. */
export function scmEnv(source: Record<string, string | undefined> = process.env): ScmEnv {
  return scmSchema.parse({
    APP_URL: source.APP_URL || undefined,
    GITLAB_URL: source.GITLAB_URL || undefined,
    BITBUCKET_API_URL: source.BITBUCKET_API_URL || undefined,
  });
}

const sandboxSchema = z.object(sandboxShape);
export type SandboxEnv = z.infer<typeof sandboxSchema>;

/** Runtime validation settings (R4.5); parsed on their own so the sandbox (and tests) need no other variables. */
export function sandboxEnv(source: Record<string, string | undefined> = process.env): SandboxEnv {
  return sandboxSchema.parse(source);
}

const demoSchema = z.object(demoShape);
export type DemoEnv = z.infer<typeof demoSchema>;

/** Public demo settings (R3.7); parsed on their own so the demo pages and job need no GitHub App variables. */
export function demoEnv(source: Record<string, string | undefined> = process.env): DemoEnv {
  return demoSchema.parse(source);
}

const setupSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  /** Optional here so the page can explain that it is missing instead of failing. */
  APP_SECRET: z.string().min(16).optional().catch(undefined),
  GITHUB_API_URL: z.string().url().default("https://api.github.com"),
  GITHUB_WEB_URL: siteShape.GITHUB_WEB_URL,
  GITHUB_APP_ID: optional,
  GITHUB_APP_SLUG: optional,
  GITHUB_APP_PRIVATE_KEY: optional,
  GITHUB_WEBHOOK_SECRET: optional,
  ...setupShape,
});
export type SetupEnv = z.infer<typeof setupSchema>;

/** GitHub App setup settings (R6.25); parsed on their own because the page runs before the App is configured. */
export function setupEnv(source: Record<string, string | undefined> = process.env): SetupEnv {
  return setupSchema.parse({
    NODE_ENV: source.NODE_ENV || undefined,
    APP_URL: source.APP_URL || undefined,
    APP_SECRET: source.APP_SECRET || undefined,
    GITHUB_API_URL: source.GITHUB_API_URL || undefined,
    GITHUB_WEB_URL: source.GITHUB_WEB_URL || undefined,
    GITHUB_APP_ID: source.GITHUB_APP_ID,
    GITHUB_APP_SLUG: source.GITHUB_APP_SLUG,
    GITHUB_APP_PRIVATE_KEY: source.GITHUB_APP_PRIVATE_KEY,
    GITHUB_WEBHOOK_SECRET: source.GITHUB_WEBHOOK_SECRET,
    INSTANCE_ADMIN_EMAILS: source.INSTANCE_ADMIN_EMAILS,
  });
}
