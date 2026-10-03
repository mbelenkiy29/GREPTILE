/** Strict parsing of public GitHub pull request URLs for the demo (R3.7). */

export interface DemoPrRef {
  owner: string;
  repo: string;
  number: number;
}

/** GitHub logins: alphanumerics and single hyphens, not at either end, at most 39 characters. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** Repository names: letters, digits, `.`, `_`, `-`, at most 100 characters (`.` and `..` are not names). */
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

export type ParseResult = { ok: true; ref: DemoPrRef } | { ok: false; error: string };

/**
 * Accepts exactly `https://github.com/<owner>/<repo>/pull/<number>` (an optional trailing slash, or the PR's `files`,
 * `commits`, or `checks` tab). Anything else — other hosts, other schemes, credentials, ports, query strings,
 * fragments, extra path segments — is rejected.
 */
export function parsePrUrl(input: string): ParseResult {
  const text = input.trim();
  const fail = (error: string): ParseResult => ({ ok: false, error });
  if (!text || text.length > 300) return fail("Paste the URL of a public GitHub pull request.");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail("That is not a URL. Paste a link like https://github.com/owner/repo/pull/123.");
  }
  if (url.protocol !== "https:") return fail("Only https://github.com pull request URLs are supported.");
  if (url.hostname !== "github.com" || url.port || url.username || url.password) return fail("Only pull requests on github.com are supported.");
  if (url.search || url.hash || /[?#]/.test(text)) return fail("Remove the query string or fragment from the URL.");
  const parts = url.pathname.replace(/\/$/, "").split("/").slice(1);
  if (parts.length === 5 && ["files", "commits", "checks"].includes(parts[4]!)) parts.pop();
  if (parts.length !== 4 || parts[2] !== "pull") return fail("That is not a pull request URL. It should look like https://github.com/owner/repo/pull/123.");
  const [owner, repo, , num] = parts as [string, string, string, string];
  if (!OWNER.test(owner)) return fail("The repository owner in the URL is not a valid GitHub name.");
  if (!REPO.test(repo) || repo === "." || repo === ".." || repo.endsWith(".git")) return fail("The repository name in the URL is not valid.");
  if (!/^[1-9]\d{0,8}$/.test(num)) return fail("The pull request number in the URL is not valid.");
  return { ok: true, ref: { owner, repo, number: Number(num) } };
}

export function prUrl(ref: DemoPrRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}
