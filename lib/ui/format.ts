/** Display formatting shared by dashboard pages (deterministic: UTC, en-US). */

export const DEFAULT_GITHUB_WEB_URL = "https://github.com";

export function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function formatDay(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toISOString().slice(0, 10);
}

/** "3m ago", "2h ago", "5d ago", or the date for anything older than 30 days. */
export function formatRelative(d: Date | null | undefined, now: Date = new Date()): string {
  if (!d) return "—";
  const s = Math.round((now.getTime() - d.getTime()) / 1000);
  if (s < 0) return formatDate(d);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days <= 30) return `${days}d ago`;
  return formatDay(d);
}

/** 850 → "850 ms", 12_400 → "12.4 s", 125_000 → "2m 5s", 4_000_000 → "1h 6m". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s - m * 60)}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m - h * 60}m`;
}

/** Estimated USD: "$0.0042", "$1.25", or "—" when unpriced. */
export function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v === 0) return "$0.00";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 1234 → "1,234"; 1_234_567 → "1.2M"; 45_600 → "45.6k". */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (Math.abs(n) >= 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return n.toLocaleString("en-US");
}

export function formatPercent(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${Math.round(v * 100)}%`;
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "—";
}

function base(webUrl?: string) {
  return (webUrl ?? DEFAULT_GITHUB_WEB_URL).replace(/\/+$/, "");
}

export function githubRepoUrl(repoFullName: string, webUrl?: string) {
  return `${base(webUrl)}/${repoFullName}`;
}

export function githubPrUrl(repoFullName: string, prNumber: number, webUrl?: string) {
  return `${base(webUrl)}/${repoFullName}/pull/${prNumber}`;
}

export function githubCommitUrl(repoFullName: string, sha: string, webUrl?: string) {
  return `${base(webUrl)}/${repoFullName}/commit/${sha}`;
}

export function githubBlobUrl(repoFullName: string, sha: string, path: string, line?: number, webUrl?: string) {
  const p = path.split("/").map(encodeURIComponent).join("/");
  return `${base(webUrl)}/${repoFullName}/blob/${sha}/${p}${line ? `#L${line}` : ""}`;
}

/** Link to an inline review comment on its pull request. */
export function githubCommentUrl(repoFullName: string, prNumber: number, commentId: number, webUrl?: string) {
  return `${base(webUrl)}/${repoFullName}/pull/${prNumber}#discussion_r${commentId}`;
}

/**
 * Where an installation's repository access is managed on GitHub: the organization's installation settings for an
 * organization account, the user's own settings otherwise.
 */
export function githubInstallationSettingsUrl(
  installation: { accountLogin: string; accountType: string | null; externalId: number },
  webUrl?: string,
) {
  const id = encodeURIComponent(String(installation.externalId));
  return installation.accountType === "Organization"
    ? `${base(webUrl)}/organizations/${encodeURIComponent(installation.accountLogin)}/settings/installations/${id}`
    : `${base(webUrl)}/settings/installations/${id}`;
}
