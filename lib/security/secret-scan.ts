/**
 * Content-level secret detection (R6.3). The indexer runs every file through `scanForSecrets` before anything is
 * stored or embedded, and replaces each matching line with `[REDACTED SECRET]` (keeping its indentation, so line
 * numbers and indentation-sensitive parsing are unaffected). The review pipeline reuses `redactSecrets` for diffs and
 * snippets it sends to a model.
 */

export const REDACTED_SECRET = "[REDACTED SECRET]";

export type SecretRule =
  | "private_key"
  | "aws_access_key_id"
  | "aws_secret_access_key"
  | "github_token"
  | "gitlab_token"
  | "slack_token"
  | "slack_webhook"
  | "stripe_key"
  | "anthropic_key"
  | "openai_key"
  | "url_credentials"
  | "assigned_secret";

export interface SecretFinding {
  /** 1-based line number. */
  line: number;
  rule: SecretRule;
  /** A short masked preview (never the secret itself), for logs and UI. */
  preview: string;
}

const TOKEN_RULES: { rule: SecretRule; re: RegExp }[] = [
  { rule: "aws_access_key_id", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/ },
  {
    rule: "aws_secret_access_key",
    re: /aws_?secret_?(?:access_?)?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/i,
  },
  { rule: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { rule: "github_token", re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { rule: "gitlab_token", re: /\bgl(?:pat|dt|rt|ptt|cbt)-[A-Za-z0-9_-]{20,}\b/ },
  { rule: "slack_token", re: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}\b/ },
  { rule: "slack_webhook", re: /https:\/\/hooks\.slack\.com\/(?:services|workflows)\/[A-Za-z0-9/_-]{20,}/ },
  { rule: "stripe_key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { rule: "stripe_key", re: /\bwhsec_[A-Za-z0-9]{24,}\b/ },
  { rule: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{32,}/ },
  { rule: "openai_key", re: /\bsk-(?:proj-|svcacct-|admin-)?(?!ant-)[A-Za-z0-9_-]{32,}/ },
];

const PRIVATE_KEY_BEGIN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;
const PRIVATE_KEY_END = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;

/** `scheme://user:password@host` connection strings. */
const URL_CREDENTIALS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'`]+:([^\s/@"'`]{3,})@/i;

/** Names that say a value is a credential. */
const SECRET_NAME = /(?:secret|passw(?:or)?d|token|api[_-]?key)/i;

/** `name = "value"`, `name: 'value'`, `"name": "value"`, `name := "value"` anywhere on a line. */
const QUOTED_ASSIGNMENT = /([A-Za-z_][\w.-]*)["']?\s*(?::=|=>|[:=])\s*(["'`])([^"'`\s]{12,})\2/g;

/** Whole-line `NAME=value` / `name: value` (env files, YAML, properties) with an unquoted value. */
const UNQUOTED_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*[:=]\s*([A-Za-z0-9+/=_-]{16,})\s*(?:#.*)?$/;

/** Values that look like placeholders, references, or URLs rather than credentials. */
const PLACEHOLDER =
  /^(?:\$\{?\w+\}?|<[^>]+>|\{\{.*\}\}|%\(?\w+\)?s?|https?:\/\/.*|(?:your|my|example|sample|dummy|fake|placeholder|changeme|change-me|replace|xxx+|\*+)[\w-]*)$/i;

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** High-entropy, credential-shaped value (random tokens nearly always mix in digits). */
function looksRandom(value: string): boolean {
  if (PLACEHOLDER.test(value)) return false;
  if (!/[A-Za-z]/.test(value)) return false;
  const h = shannonEntropy(value);
  if (/\d/.test(value)) return h >= 3.5;
  return value.length >= 32 && h >= 4.2;
}

function mask(value: string): string {
  const v = value.trim();
  return v.length <= 8 ? "****" : `${v.slice(0, 4)}…(${v.length} chars)`;
}

function scanLine(line: string): { rule: SecretRule; match: string } | null {
  for (const { rule, re } of TOKEN_RULES) {
    const m = re.exec(line);
    if (m) return { rule, match: m[0] };
  }
  const url = URL_CREDENTIALS.exec(line);
  if (url && !PLACEHOLDER.test(url[1]!) && !/^(?:password|postgres|root|admin|guest|user|pass)$/i.test(url[1]!)) {
    return { rule: "url_credentials", match: url[0] };
  }
  QUOTED_ASSIGNMENT.lastIndex = 0;
  for (let m = QUOTED_ASSIGNMENT.exec(line); m; m = QUOTED_ASSIGNMENT.exec(line)) {
    if (SECRET_NAME.test(m[1]!) && looksRandom(m[3]!)) return { rule: "assigned_secret", match: m[3]! };
  }
  const bare = UNQUOTED_ASSIGNMENT.exec(line);
  if (bare && SECRET_NAME.test(bare[1]!) && looksRandom(bare[2]!)) return { rule: "assigned_secret", match: bare[2]! };
  return null;
}

/**
 * Finds lines that contain credentials: private key blocks (every line of the block), cloud/provider tokens (AWS,
 * GitHub, GitLab, Slack, Stripe, OpenAI, Anthropic), credentials embedded in connection URLs, and high-entropy
 * string literals assigned to names containing secret/password/passwd/token/api_key.
 */
export function scanForSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split("\n");
  let inKey = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (inKey || PRIVATE_KEY_BEGIN.test(line)) {
      findings.push({ line: i + 1, rule: "private_key", preview: "-----BEGIN … PRIVATE KEY-----" });
      inKey = !PRIVATE_KEY_END.test(line);
      continue;
    }
    const hit = scanLine(line);
    if (hit) findings.push({ line: i + 1, rule: hit.rule, preview: mask(hit.match) });
  }
  return findings;
}

/** Replaces the lines named by `findings` with `[REDACTED SECRET]`, keeping indentation and line count. */
export function applyRedactions(text: string, findings: readonly SecretFinding[]): string {
  if (findings.length === 0) return text;
  const redact = new Set(findings.map((f) => f.line));
  return text
    .split("\n")
    .map((line, i) => {
      if (!redact.has(i + 1)) return line;
      const indent = /^\s*/.exec(line)![0];
      return `${indent}${REDACTED_SECRET}${line.endsWith("\r") ? "\r" : ""}`;
    })
    .join("\n");
}

/** `text` with every line that contains a credential replaced by `[REDACTED SECRET]`. */
export function redactSecrets(text: string): string {
  return applyRedactions(text, scanForSecrets(text));
}

const ALLOWED_ENV_FILE = /^\.env\.(?:example|sample|template)$/i;

/**
 * Files that hold credentials by convention and are never read: `.env`, `.env.*` (except example/sample/template),
 * keys and keystores, SSH private keys, `credentials*.json`, and `secrets.*`.
 */
export function isSecretFilePath(filePath: string): boolean {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const lower = base.toLowerCase();
  if (lower === ".env") return true;
  if (lower.startsWith(".env.")) return !ALLOWED_ENV_FILE.test(base);
  if (/\.(?:pem|key|p12|pfx|keystore|jks)$/.test(lower)) return true;
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)/.test(lower)) return true;
  if (/^credentials.*\.json$/.test(lower)) return true;
  if (lower.startsWith("secrets.")) return true;
  return false;
}
