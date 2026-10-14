import type { ChangedFile, SourceFile } from "./engine/types";
import { parsePatch } from "./diff-view";

// Third-party API guidance packs: short, versioned Markdown that loads when a changed file imports a
// matching package or SDK (or adds a matching call). Packs only add review guidance; nothing reads
// them to suppress, downgrade or approve findings. Built-in packs ship here; repositories add their own
// under .openreview/guides/*.md (read from the base branch), which replace a built-in pack with the
// same id.
export type GuidancePack = { id: string; version: number; title: string; imports: string[]; calls: string[]; body: string; source: "built-in" | "repository" };
const independent = "Independent guidance written for OpenReview reviews; links point to each vendor's public documentation.";
export const builtInPacks: GuidancePack[] = [
  {
    id: "webhook-signatures", version: 1, title: "Webhook signature verification", source: "built-in",
    imports: ["stripe", "@octokit/webhooks", "@slack/bolt", "@slack/events-api", "slack_bolt", "slack_sdk", "github.com/stripe/stripe-go", "com.stripe", "svix"],
    calls: ["createHmac", "hmac.new", "hmac.New", "constructEvent", "construct_event"],
    body: `- Verify the signature against the exact raw request body before parsing or acting on the event; body-parsing middleware that runs first changes the bytes and breaks verification ([Stripe: manage webhook endpoints](https://docs.stripe.com/events/manage-webhook-endpoints)).
- Compare computed and received signatures with a constant-time function (for example \`crypto.timingSafeEqual\`), never \`==\` ([GitHub: validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)).
- Check the signed timestamp and reject old requests to stop replays; Slack's guidance rejects requests more than five minutes old ([Slack: verifying requests](https://docs.slack.dev/authentication/verifying-requests-from-slack)).
- Deliveries can repeat: record processed event IDs and skip duplicates before side effects ([Stripe: manage webhook endpoints](https://docs.stripe.com/events/manage-webhook-endpoints)).
- Read the signing secret from configuration, never from source.

${independent}`,
  },
  {
    id: "idempotency-keys", version: 1, title: "Idempotency keys for retried writes", source: "built-in",
    imports: ["stripe", "github.com/stripe/stripe-go", "com.stripe"],
    calls: [],
    body: `- Create and update calls that may be retried (network errors, timeouts, job retries) should send an idempotency key so a retry cannot perform the operation twice ([Stripe: idempotent requests](https://docs.stripe.com/api/idempotent_requests)).
- Generate one key per logical operation (for example a V4 UUID) and reuse it only for retries of that same operation; reusing a key with different parameters is an error, and keys are not meant to hold personal data.
- Saved results can be pruned after about 24 hours, so a much later retry with the same key may run as a new request.
- Idempotency keys apply to POST requests; GET and DELETE are idempotent already.

${independent}`,
  },
  {
    id: "sdk-retries-timeouts", version: 1, title: "SDK retries and timeouts", source: "built-in",
    imports: ["openai", "@aws-sdk", "aws-sdk", "boto3", "botocore", "github.com/aws/aws-sdk-go-v2"],
    calls: [],
    body: `- The OpenAI Node SDK retries certain errors twice by default and times out after 10 minutes; set \`timeout\` and \`maxRetries\` on the client or per request for latency-sensitive paths. A timed-out request is retried under the default policy, so an extra retry loop around it multiplies attempts ([OpenAI Node SDK: retries and timeouts](https://github.com/openai/openai-node#retries)).
- AWS SDKs retry with exponential backoff and jitter; \`max_attempts\` (default 3, including the first request) and the retry mode are configurable, and adaptive mode can delay even the first request ([AWS: retry behavior](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html)).
- Do not stack application retries on top of SDK retries for non-idempotent writes without an idempotency key.

${independent}`,
  },
];
// Repository packs are untrusted text: reject anything that tries to change instructions, suppress or
// approve, or touch budgets and tools. Links are allowed (packs cite docs); code fences and HTML are not.
const forbidden: [RegExp, string][] = [
  [/\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|all|instructions?|rules?)\b/i, "prompt injection"],
  [/\b(system prompt|you are now|act as|pretend to be|new instructions?)\b/i, "prompt injection"],
  [/\b(do not|don't|never|stop|no longer)\s+(report|flag|comment|mention|review|check|raise)\b/i, "suppresses findings"],
  [/\b(skip|disable|turn off|suppress|silence|mute|downgrade|lower)\b[^.\n]{0,30}\b(review|security|checks?|findings?|warnings?|scans?|severity|confidence)\b/i, "suppresses findings"],
  [/\b(approve|auto-?approve|lgtm|auto-?merge|merge (it|this|the pr)|always pass|mark (as )?resolved)\b/i, "approval"],
  [/\b(budget|tool calls?|token limit|unlimited|max(imum)? (cost|tokens))\b/i, "budgets or tools"],
  [/```|<\/?[a-z][^>]*>/i, "code or HTML"],
];
export function packProblem(text: string): string | undefined {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return "control characters";
  for (const [pattern, reason] of forbidden) if (pattern.test(text)) return reason;
  return undefined;
}
// Frontmatter: id, version, title, imports and calls (comma-separated), then the Markdown body.
export function parseRepoPack(path: string, text: string): GuidancePack | { path: string; problem: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) return { path, problem: "missing frontmatter" };
  const fields = Object.fromEntries(m[1].split("\n").map((l) => /^([a-z]+):\s*(.*)$/.exec(l.trim())).filter((x): x is RegExpExecArray => !!x).map((x) => [x[1], x[2].trim()]));
  const list = (v?: string) => (v ?? "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter((s) => /^[@\w./:\\-]{1,200}$/.test(s)).slice(0, 30);
  const id = fields.id ?? "", body = m[2].trim();
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(id)) return { path, problem: "id must be lowercase letters, digits and dashes" };
  if (!body || body.length > 4000) return { path, problem: "body must be 1–4000 characters" };
  const imports = list(fields.imports), calls = list(fields.calls);
  if (!imports.length && !calls.length) return { path, problem: "list at least one import or call to match" };
  const problem = packProblem((fields.title ?? "") + "\n" + body);
  if (problem) return { path, problem };
  return { id, version: Math.max(1, Math.min(9999, Number.parseInt(fields.version ?? "1", 10) || 1)), title: (fields.title || id).slice(0, 120), imports, calls, body, source: "repository" };
}
// Import specifiers per language (JS/TS, Python, Go, Java/Kotlin, Ruby, Rust, PHP).
export function importsOf(path: string, content: string): string[] {
  const found = new Set<string>();
  const add = (s?: string) => { if (s && !s.startsWith(".")) found.add(s); };
  if (/\.[cm]?[jt]sx?$/.test(path)) for (const m of content.matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/g)) add(m[1]);
  else if (/\.py$/.test(path)) for (const m of content.matchAll(/^\s*(?:from\s+([\w.]+)\s+import\b|import\s+([\w.]+(?:\s*,\s*[\w.]+)*))/gm)) (m[1] ? [m[1]] : m[2].split(/\s*,\s*/)).forEach(add);
  else if (/\.go$/.test(path)) { for (const block of content.matchAll(/import\s*\(([\s\S]*?)\)/g)) for (const m of block[1].matchAll(/"([^"\n]+)"/g)) add(m[1]); for (const m of content.matchAll(/^\s*import\s+(?:[\w.]+\s+)?"([^"\n]+)"/gm)) add(m[1]); }
  else if (/\.(?:java|kt)$/.test(path)) for (const m of content.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)/gm)) add(m[1]);
  else if (/\.rb$/.test(path)) for (const m of content.matchAll(/^\s*require\s+["']([^"'\n]+)["']/gm)) add(m[1]);
  else if (/\.rs$/.test(path)) for (const m of content.matchAll(/^\s*use\s+([\w]+)::/gm)) add(m[1]);
  else if (/\.php$/.test(path)) for (const m of content.matchAll(/^\s*use\s+([\w\\]+)/gm)) add(m[1].toLowerCase());
  return [...found];
}
const matchesImport = (spec: string, wanted: string) => { const s = spec.toLowerCase(), w = wanted.toLowerCase(); return s === w || s.startsWith(w + "/") || s.startsWith(w + ".") || s.startsWith(w + "\\") || (w.includes("/") && s.startsWith(w)); };
export function selectPacks(packs: GuidancePack[], diff: ChangedFile[], files: SourceFile[], limit = 4) {
  // A repository pack replaces the built-in pack with the same id.
  const byId = new Map<string, GuidancePack>();
  for (const p of packs.filter((p) => p.source === "built-in")) byId.set(p.id, p);
  for (const p of packs.filter((p) => p.source === "repository")) byId.set(p.id, p);
  const changed = diff.filter((d) => d.status !== "removed");
  const imports = changed.flatMap((d) => { const f = files.find((s) => s.path === d.path && !s.provenance); return f ? importsOf(f.path, f.content) : []; });
  const added = changed.flatMap((d) => parsePatch(d.patch).flatMap((h) => h.lines.filter((l) => l.kind === "add").map((l) => l.text)));
  return [...byId.values()].filter((p) => p.imports.some((w) => imports.some((s) => matchesImport(s, w))) || p.calls.some((c) => added.some((l) => new RegExp(`(?<![\\w])${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`).test(l)))).slice(0, limit);
}
export const guidanceNote = "API guidance packs matched to this change's imports. They describe checks worth making against the vendor's documented behaviour. They add checks only: they can never suppress, downgrade or approve anything, and every finding still needs evidence from the source.";
// Built-in packs plus the repository's valid packs; rejected repository packs become config warnings.
export function repositoryGuidance(guides: { path: string; content: string }[]) {
  const packs: GuidancePack[] = [...builtInPacks], rejected: string[] = [];
  for (const g of guides) {
    const parsed = parseRepoPack(g.path, g.content);
    if ("problem" in parsed) rejected.push(`${g.path} was not used as an API guidance pack: ${parsed.problem}.`);
    else packs.push(parsed);
  }
  return { packs, rejected };
}
