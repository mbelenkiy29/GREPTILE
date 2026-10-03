/**
 * Server-action result messages (R6.13). An action redirects back with `?toast=<code>`; the shell shows the message
 * for a known code. Only codes from this table render, so a crafted URL can never inject text.
 */

export type ToastTone = "success" | "info" | "warning" | "error";

export const TOASTS = {
  "repo.enabled": { tone: "success", message: "Reviews resumed for this repository." },
  "repo.disabled": { tone: "info", message: "Reviews paused for this repository." },
  "repo.not_found": { tone: "error", message: "That repository isn't connected to this organization." },
  "repo.archived": { tone: "warning", message: "Archived repositories are read-only on their git host and can't be reviewed." },
  "index.queued": { tone: "success", message: "Re-index queued. Progress appears below." },
  "index.cancelled": { tone: "info", message: "Index run cancelled." },
  "index.not_running": { tone: "warning", message: "That index run had already finished." },
  "review.queued": { tone: "success", message: "Re-review queued." },
  "review.cancelled": { tone: "info", message: "Review run cancelled." },
  "review.cancel_requested": { tone: "info", message: "Cancellation requested. The run stops at its next stage." },
  "review.already_finished": { tone: "warning", message: "That review run had already finished." },
  "review.not_found": { tone: "error", message: "That review isn't in this organization." },
  "review.usage_limit": { tone: "warning", message: "Not queued: this organization reached a usage cap or plan limit. See Settings → Usage & billing." },
  "usage.saved": { tone: "success", message: "Usage caps and alerts saved." },
  "usage.invalid": { tone: "error", message: "Those usage settings couldn't be saved. Check the form and try again." },
  "usage.secret_rotated": { tone: "success", message: "Alert webhook signing secret replaced. Update your receiver with the new secret." },
  "billing.checkout_cancelled": { tone: "info", message: "Checkout cancelled. Nothing was charged." },
  "billing.checkout_success": { tone: "success", message: "Thanks! Your team plan is active as soon as Stripe confirms the payment." },
  "billing.unavailable": { tone: "error", message: "Billing is unavailable right now. Please try again." },
  "billing.already_subscribed": { tone: "info", message: "This organization already has a team subscription. Use Manage billing to change it." },
  "delivery.replayed": { tone: "success", message: "Delivery replayed." },
  "delivery.replay_failed": { tone: "error", message: "The replay failed again. The error is shown on the delivery." },
  "delivery.not_replayable": { tone: "warning", message: "That delivery can't be replayed (it didn't fail, or its payload wasn't kept)." },
  "delivery.not_found": { tone: "error", message: "That delivery isn't in this organization." },
  "knowledge.queued": { tone: "success", message: "Knowledge regeneration queued. Entries update as they're regenerated." },
  "knowledge.busy": { tone: "info", message: "A knowledge refresh is already queued or running for this repository." },
  "knowledge.saved": { tone: "success", message: "Description saved. Regenerations now propose changes instead of overwriting it." },
  "knowledge.invalid": { tone: "error", message: "The description must be non-empty Markdown under 1,500 words." },
  "knowledge.accepted": { tone: "success", message: "Proposed description accepted." },
  "knowledge.rejected": { tone: "info", message: "Proposed description discarded. Your text is kept." },
  "knowledge.no_proposal": { tone: "warning", message: "That entry has no proposed description to review." },
  "knowledge.not_found": { tone: "error", message: "That knowledge entry isn't in this organization." },
  "knowledge.disabled": { tone: "warning", message: "The knowledge base is turned off for this deployment (KNOWLEDGE_ENABLED)." },
  "knowledge.not_indexed": { tone: "warning", message: "Index the repository first; knowledge is generated from the index." },
  "rule.created": { tone: "success", message: "Rule created. Reviews enforce it from the next run." },
  "rule.saved": { tone: "success", message: "Rule saved." },
  "rule.deleted": { tone: "info", message: "Rule deleted." },
  "rule.enabled": { tone: "success", message: "Rule turned on." },
  "rule.disabled": { tone: "info", message: "Rule turned off. Reviews ignore it until you turn it back on." },
  "rule.approved": { tone: "success", message: "Suggested rule approved. Reviews enforce it from the next run." },
  "rule.dismissed": { tone: "info", message: "Suggested rule dismissed." },
  "rule.template_added": { tone: "success", message: "Template added as a rule. Edit it to fit your codebase." },
  "rule.not_found": { tone: "error", message: "That rule isn't in this organization." },
  "rule.invalid": { tone: "error", message: "That rule couldn't be saved. Check its fields and try again." },
  "preference.saved": { tone: "success", message: "Preference saved and pinned." },
  "preference.deleted": { tone: "info", message: "Preference deleted." },
  "preference.not_found": { tone: "error", message: "That preference isn't in this organization." },
  "preference.invalid": { tone: "error", message: "Descriptions need at least 3 characters." },
  "preferences.reset": { tone: "success", message: "Learned preferences reset." },
  "org.renamed": { tone: "success", message: "Organization updated." },
  "org.error": { tone: "error", message: "That change couldn't be made. Check the form and try again." },
  "invite.revoked": { tone: "info", message: "Invitation revoked." },
  "runtime.saved": { tone: "success", message: "Runtime validation settings saved. They apply from the next review." },
  "runtime.cleared": { tone: "info", message: "Runtime validation settings removed for this repository." },
  "runtime.invalid": { tone: "error", message: "Those runtime validation settings couldn't be saved. A test command is required; check the image name, timeout, and environment lines." },
  "onboarding.workspace": { tone: "success", message: "Workspace ready. Next, connect GitHub." },
  "onboarding.connected": { tone: "success", message: "GitHub installation connected. Its repositories are being indexed." },
  "onboarding.not_accessible": { tone: "error", message: "Your GitHub account can't access that installation, so it wasn't connected." },
  "onboarding.owned_elsewhere": { tone: "error", message: "That installation is already connected to another organization." },
  "onboarding.not_found": { tone: "error", message: "That installation is no longer waiting to be connected." },
  "onboarding.github_unavailable": { tone: "error", message: "We couldn't reach GitHub to check your installations. Please try again." },
  "onboarding.repos_saved": { tone: "success", message: "Repository selection saved." },
  "onboarding.no_repos": { tone: "warning", message: "Pick at least one repository to review." },
  "onboarding.defaults_saved": { tone: "success", message: "Review defaults saved." },
  "onboarding.defaults_invalid": { tone: "error", message: "Some review defaults were invalid. Check the values and try again." },
  "onboarding.index_queued": { tone: "success", message: "Indexing queued again." },
  "onboarding.review_queued": { tone: "success", message: "Review queued. It appears here when it starts." },
  "apikey.revoked": { tone: "success", message: "API key revoked. Requests using it are refused from now on." },
  "apikey.not_found": { tone: "warning", message: "That API key isn't active in this organization." },
  "sso.created": { tone: "success", message: "Connection created. Add the URLs below to your identity provider, then test it." },
  "sso.saved": { tone: "success", message: "Connection saved." },
  "sso.enabled": { tone: "success", message: "Connection enabled." },
  "sso.disabled": { tone: "info", message: "Connection disabled. It no longer signs anyone in, and SSO is no longer required." },
  "sso.enforced": { tone: "success", message: "Single sign-on is now required for this organization." },
  "sso.not_enforced": { tone: "info", message: "Single sign-on is no longer required." },
  "sso.deleted": { tone: "info", message: "Connection deleted." },
  "sso.not_found": { tone: "error", message: "That connection isn't in this organization." },
  "llm.saved": { tone: "success", message: "Model provider saved. New model calls use it." },
  "llm.removed": { tone: "info", message: "Model provider removed. This organization uses the server's default model again." },
  "scm.checked": { tone: "success", message: "Connection checked." },
  "scm.check_failed": { tone: "error", message: "The connection check failed. See the error on the connection." },
  "scm.disconnected": { tone: "info", message: "Provider disconnected. Its webhooks and stored token were removed." },
  "scm.not_found": { tone: "error", message: "That connection or repository isn't in this organization." },
  "scm.repo_enabled": { tone: "success", message: "Repository enabled. Its webhook was created and indexing is queued." },
  "scm.repo_disabled": { tone: "info", message: "Reviews paused. The repository's webhook was removed." },
  "scm.hook_failed": { tone: "error", message: "The webhook couldn't be changed on the git host. Check the connection's token and role." },
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
