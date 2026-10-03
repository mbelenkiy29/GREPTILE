/**
 * Structured JSON logging (R6.21). One line per event on stdout (errors on stderr) with a level, a message, and
 * correlation fields (installation, delivery, repository, PR, review, agent, job). Child loggers carry their
 * correlation fields into every line. Values that look like credentials are redacted before they are written (R6.20).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Correlation ids that tie log lines for one webhook delivery / job / review / agent together. */
export interface LogContext {
  orgId?: string;
  installationId?: number;
  deliveryId?: string;
  repoId?: number;
  repo?: string;
  prNumber?: number;
  reviewId?: number;
  reviewRunId?: number;
  agent?: string;
  jobId?: string;
  job?: string;
  [key: string]: unknown;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY = /(pass(word)?|secret|token|api[-_]?key|authorization|cookie|private[-_]?key|credential|session)/i;

const SECRET_VALUE: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-(ant-)?[A-Za-z0-9_-]{16,}\b/g, // Anthropic / OpenAI style keys
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g, // GitLab
  /\bor_live_[A-Za-z0-9_-]{16,}/g, // OpenReview API keys
  /\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, // credentials embedded in URLs
  /\b(Bearer|token)\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];

/** Replaces credential-looking substrings in free text. */
export function redactText(text: string): string {
  let out = text;
  for (const re of SECRET_VALUE) {
    out = out.replace(re, (match, ...groups) => {
      if (re.source.startsWith("(https?")) return `${groups[0]}[REDACTED]@`;
      return "[REDACTED]";
    });
  }
  return out;
}

/** Deep-copies a value, redacting secret-named keys and credential-looking strings. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[…]";
  if (typeof value === "string") return redactText(value);
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message), stack: value.stack ? redactText(value.stack) : undefined };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) && v !== null && v !== undefined && typeof v !== "boolean" ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** A logger whose lines all carry `ctx` in addition to this logger's context. */
  child(ctx: LogContext): Logger;
  readonly context: LogContext;
}

type Sink = (line: string, level: LogLevel) => void;

const defaultSink: Sink = (line, level) => {
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

let sink: Sink = defaultSink;

/** Redirects log output (tests capture lines with this). Returns a function that restores the previous sink. */
export function setLogSink(next: Sink): () => void {
  const prev = sink;
  sink = next;
  return () => {
    sink = prev;
  };
}

function minLevel(): number {
  const configured = (process.env.LOG_LEVEL ?? "").toLowerCase() as LogLevel;
  if (configured in LEVELS) return LEVELS[configured];
  return process.env.NODE_ENV === "test" ? LEVELS.warn : LEVELS.info;
}

export function createLogger(context: LogContext = {}): Logger {
  const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < minLevel()) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg: redactText(msg),
      ...(redact(context) as object),
      ...(fields ? (redact(fields) as object) : {}),
    };
    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({ ts: entry.ts, level, msg: entry.msg, note: "unserializable fields dropped" });
    }
    sink(line, level);
  };
  return {
    context,
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (ctx) => createLogger({ ...context, ...ctx }),
  };
}

/** Root logger for server code. */
export const log: Logger = createLogger({ service: process.env.OPENREVIEW_SERVICE ?? "openreview" });

/**
 * Error message (and nothing else) for persisting in a status column; credentials are redacted. A wrapped error's
 * cause (e.g. the connection error behind a failed query) is appended and survives truncation.
 */
export function errorMessage(err: unknown, max = 2000): string {
  const msg = redactText(err instanceof Error ? err.message : String(err));
  const cause = err instanceof Error && err.cause instanceof Error ? redactText(err.cause.message) : "";
  if (!cause || msg.includes(cause)) return msg.slice(0, max);
  const suffix = ` (cause: ${cause.slice(0, 500)})`;
  return `${msg.slice(0, Math.max(0, max - suffix.length))}${suffix}`;
}
