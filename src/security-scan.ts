import { parsePatch } from "./diff-view";
import type { Candidate, ChangedFile } from "./engine/types";
import { redact } from "./engine/indexer";

// Deterministic, high-signal security checks over added lines. They are original, small and tested;
// model judgment never removes their results (the model may only explain and rank around them).
type Check = { id: string; title: string; severity: Candidate["severity"]; paths: RegExp; test: (line: string, path: string) => boolean; description: string; impact: string; fix: string };
const code = /\.(?:[cm]?[jt]sx?|py|go|rb|java|kt|cs|php|rs|swift|scala)$/i;
const js = /\.[cm]?[jt]sx?$/i, py = /\.py$/i;
const testPath = /(^|\/)(tests?|__tests__|spec|fixtures?|examples?|mocks?|testdata)\/|\.(test|spec)\.[^/]+$|_test\.go$/i;
// Placeholder values that are documentation, not credentials.
const placeholder = /EXAMPLE|example|dummy|placeholder|changeme|your[_-]?|xxx+|\*{3,}|<[^>]+>|\$\{|process\.env|os\.environ|getenv/i;
const tokens = /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,}|xox[abpors]-[A-Za-z0-9-]{10,}|sk_live_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35})\b/;
const assigned = /(\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["'])[^"'\s]{12,}(["'])/i;
// Evidence quotes never repeat a secret value in comments or storage.
export const maskSecrets = (line: string) => redact(line).replace(new RegExp(tokens.source, "g"), "[REDACTED TOKEN]").replace(new RegExp(assigned.source, "gi"), "$1[REDACTED]$2");
// SQL keywords: uppercase as written in most code, or lowercase with enough structure to rule out prose.
const sql = /(?:SELECT\b[^"'`]*\bFROM\b|INSERT\s+INTO\b|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b|select\b[^"'`]*\bfrom\s+\w+[^"'`]*\bwhere\b|insert\s+into\s+\w+\s*\(|update\s+\w+\s+set\s+\w+\s*=|delete\s+from\s+\w+\s+where\b)/.source;
export const securityChecks: Check[] = [
  { id: "private-key", title: "Private key committed in source", severity: "critical", paths: /./, test: (l) => /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(l),
    description: "A private key block is added to the repository.", impact: "Anyone with read access to the repository or its history can impersonate the key's owner.", fix: "Remove the key, rotate it, and load it from a secret store or environment variable." },
  { id: "cloud-token", title: "Hard-coded access token", severity: "critical", paths: /./,
    test: (l) => tokens.test(l) && !placeholder.test(l),
    description: "A credential with a recognisable provider format (cloud, source host, chat or payment token) is added in source.", impact: "The token grants access to the provider account to anyone who can read the repository or its history.", fix: "Revoke and rotate the token, then read it from a secret store or environment variable." },
  { id: "assigned-secret", title: "Secret assigned as a string literal", severity: "high", paths: code,
    test: (l) => assigned.test(l) && !placeholder.test(l),
    description: "A password, API key or token is assigned a literal value in code.", impact: "The secret ships with the source and cannot be rotated without a code change.", fix: "Read the value from configuration or a secret store and rotate the exposed one." },
  { id: "sql-concatenation", title: "SQL query built by string concatenation", severity: "high", paths: code,
    test: (l) => new RegExp(`["'\`]\\s*${sql}[^"'\`]*["'\`]\\s*\\+\\s*[A-Za-z_$]`).test(l) || new RegExp(`\`[^\`]*${sql}[^\`]*\\$\\{`).test(l) || new RegExp(`\\bf["'][^"']*${sql}[^"']*\\{`).test(l),
    description: "A SQL statement is assembled from string pieces that include a variable.", impact: "Values that reach the variable can change the query (SQL injection).", fix: "Use parameterized queries or the query builder's placeholders." },
  { id: "tls-verification-off", title: "TLS certificate verification disabled", severity: "high", paths: code,
    test: (l) => /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|\bverify\s*=\s*False\b|InsecureSkipVerify\s*:\s*true|_create_unverified_context|CURLOPT_SSL_VERIFYPEER\s*,\s*(?:false|0)\b/.test(l),
    description: "Certificate verification is turned off for an outgoing TLS connection.", impact: "A network attacker can intercept or alter the traffic (man in the middle).", fix: "Keep verification on; trust a specific CA bundle if a private certificate is needed." },
  { id: "dynamic-eval", title: "Code evaluated from a non-literal value", severity: "high", paths: /\.(?:[cm]?[jt]sx?|py)$/i,
    test: (l, path) => /(?<![\w.$])eval\s*\(\s*(?!["'`][^"'`]*["'`]\s*\))[^)\s]/.test(l) || js.test(path) && /\bnew\s+Function\s*\(\s*(?!["'`][^"'`]*["'`]\s*\))[^)\s]/.test(l) || py.test(path) && /(?<![\w.])exec\s*\(\s*(?!["'][^"']*["']\s*\))[A-Za-z_]/.test(l),
    description: "Code is evaluated from a value that is not a fixed string.", impact: "If the value can carry user input, an attacker can run arbitrary code.", fix: "Remove dynamic evaluation; parse the data (for example as JSON) or dispatch to known functions." },
  { id: "shell-injection", title: "Shell command built from a variable", severity: "high", paths: code,
    test: (l) => /\bexec(?:Sync)?\s*\(\s*(?:`[^`]*\$\{|["'][^"']*["']\s*\+)/.test(l) || /\bsubprocess\.\w+\([^)]*shell\s*=\s*True/.test(l) || /\bos\.system\s*\(\s*(?:f["']|["'][^"']*["']\s*[+%])/.test(l),
    description: "A shell command line is assembled from a variable and run through a shell.", impact: "Shell metacharacters in the value let an attacker run additional commands.", fix: "Pass arguments as an array to a non-shell API (execFile, subprocess without shell=True) and validate them." },
  { id: "unsafe-deserialization", title: "Unsafe deserialization of untrusted data", severity: "high", paths: py,
    test: (l) => /\bpickle\.loads?\s*\(/.test(l) || /\byaml\.load\s*\((?![^)]*Loader\s*=\s*(?:yaml\.)?(?:Safe|CSafe)Loader)/.test(l),
    description: "Data is deserialized with a loader that can construct arbitrary objects.", impact: "Crafted input can execute code during deserialization.", fix: "Use yaml.safe_load or a data-only format such as JSON." },
];
export type ScanFinding = Candidate & { agent: string; checkId: string };
export function scanChanges(diff: ChangedFile[], limit = 20): ScanFinding[] {
  const found: ScanFinding[] = [];
  for (const file of diff) {
    if (file.status === "removed") continue;
    const tests = testPath.test(file.path);
    for (const line of parsePatch(file.patch).flatMap((h) => h.lines)) {
      if (line.kind !== "add" || line.new === undefined || line.text.length > 2000) continue;
      for (const check of securityChecks) {
        // Test fixtures routinely hold fake credentials; the other checks still apply there.
        if (found.length >= limit || !check.paths.test(file.path) || (tests && /secret|token|private-key/.test(check.id)) || !check.test(line.text, file.path)) continue;
        found.push({ title: check.title, description: check.description + " Found by OpenReview's deterministic security checks.", severity: check.severity, confidence: 0.95, category: "security", filePath: file.path, startLine: line.new, endLine: line.new, evidence: [{ filePath: file.path, startLine: line.new, quote: maskSecrets(line.text) }], impact: check.impact, suggestedFix: check.fix, symbol: check.id, agent: "security-checks", checkId: check.id });
        break;
      }
    }
  }
  return found;
}
