/**
 * Server-action result messages (R6.13). An action redirects back with `?toast=<code>`; the shell shows the message
 * for a known code. Only codes from this table render, so a crafted URL can never inject text.
 */

export type ToastTone = "success" | "info" | "warning" | "error";

export const TOASTS = {
  "repo.enabled": { tone: "success", message: "Reviews resumed for this repository." },
  "repo.disabled": { tone: "info", message: "Reviews paused for this repository." },
  "repo.not_found": { tone: "error", message: "That repository isn't connected to this organization." },
  "repo.archived": { tone: "warning", message: "Archived repositories are read-only on GitHub and can't be reviewed." },
  "index.queued": { tone: "success", message: "Re-index queued. Progress appears below." },
  "index.cancelled": { tone: "info", message: "Index run cancelled." },
  "index.not_running": { tone: "warning", message: "That index run had already finished." },
  "review.queued": { tone: "success", message: "Re-review queued." },
  "review.cancelled": { tone: "info", message: "Review run cancelled." },
  "review.cancel_requested": { tone: "info", message: "Cancellation requested. The run stops at its next stage." },
  "review.already_finished": { tone: "warning", message: "That review run had already finished." },
  "review.not_found": { tone: "error", message: "That review isn't in this organization." },
  "delivery.replayed": { tone: "success", message: "Delivery replayed." },
  "delivery.replay_failed": { tone: "error", message: "The replay failed again. The error is shown on the delivery." },
  "delivery.not_replayable": { tone: "warning", message: "That delivery can't be replayed (it didn't fail, or its payload wasn't kept)." },
  "delivery.not_found": { tone: "error", message: "That delivery isn't in this organization." },
} as const satisfies Record<string, { tone: ToastTone; message: string }>;

export type ToastCode = keyof typeof TOASTS;

export function toastFor(code: unknown): { code: ToastCode; tone: ToastTone; message: string } | null {
  if (typeof code !== "string" || !Object.hasOwn(TOASTS, code)) return null;
  const t = TOASTS[code as ToastCode];
  return { code: code as ToastCode, tone: t.tone, message: t.message };
}

/**
 * A same-app dashboard path to return to after an action, from an untrusted form field. Anything that is not a
 * plain `/dashboard` path (absolute URLs, protocol-relative `//host`, backslashes) falls back to `fallback`.
 */
export function safeReturnPath(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  if (!/^\/dashboard(?:[/?#]|$)/.test(value) || value.startsWith("//") || value.includes("\\") || value.length > 2000) return fallback;
  return value;
}

/** `path` with `toast=<code>` set (replacing any earlier toast). */
export function withToast(path: string, code: ToastCode): string {
  const url = new URL(path, "http://openreview.local");
  url.searchParams.set("toast", code);
  return `${url.pathname}${url.search}${url.hash}`;
}
