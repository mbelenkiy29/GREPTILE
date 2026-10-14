import { egressAllowed } from "./egress";
// "Open in agent" links, only for schemes the agents officially document (checked 2026-10-14):
// Cursor   cursor://anysphere.cursor-deeplink/prompt?text=… (≤10,000 URL-encoded chars; user confirms)
// Claude   claude-cli://open?q=…&repo=owner/name (q ≤5,000 chars; pre-filled, never auto-sent)
// Codex    codex://new?prompt=…&originUrl=… (pre-filled, never auto-sent; no published limit, capped)
// Conductor conductor://prompt=… (docs.conductor.build/core/deep-links: pre-fills the composer; the workspace
//          is created only when the user clicks Create; no published limit, capped like Codex. `path` and
//          `branch` need the local checkout path, which the server does not know, so they are omitted.)
// Devin documents no deep link, only an API: see src/devin.ts (opt-in with the user's own key).
// Each link only pre-fills a prompt for the developer to review; nothing runs from the link.
export type AgentLink = { agent: "cursor" | "claude" | "codex" | "conductor"; label: string; url?: string; unavailable?: string };
export const codexPromptCap = 8000;
export function agentRepoContext(repo: { fullName: string; connectionId?: unknown; remoteUrl?: string }) {
  const github = !repo.connectionId && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.fullName);
  const origin = repo.remoteUrl && /^https:\/\//.test(repo.remoteUrl) ? repo.remoteUrl : github ? `https://github.com/${repo.fullName}` : undefined;
  return { ...(github ? { githubSlug: repo.fullName } : {}), ...(origin ? { originUrl: origin } : {}) };
}
export function agentLinks(prompt: string, context: { githubSlug?: string; originUrl?: string }): AgentLink[] {
  const cursor = `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(prompt)}`;
  const claude = `claude-cli://open?q=${encodeURIComponent(prompt)}${context.githubSlug ? `&repo=${encodeURIComponent(context.githubSlug).replace("%2F", "/")}` : ""}`;
  const codex = `codex://new?prompt=${encodeURIComponent(prompt)}${context.originUrl ? `&originUrl=${encodeURIComponent(context.originUrl)}` : ""}`;
  const conductor = `conductor://prompt=${encodeURIComponent(prompt)}`;
  const tooLong = (limit: string) => `This prompt is longer than ${limit}; copy it instead.`;
  return [
    cursor.length <= 10000 ? { agent: "cursor", label: "Open in Cursor", url: cursor } : { agent: "cursor", label: "Open in Cursor", unavailable: tooLong("Cursor's 10,000-character link limit") },
    prompt.length <= 5000 ? { agent: "claude", label: "Open in Claude Code", url: claude } : { agent: "claude", label: "Open in Claude Code", unavailable: tooLong("Claude Code's 5,000-character link limit") },
    prompt.length <= codexPromptCap ? { agent: "codex", label: "Open in Codex", url: codex } : { agent: "codex", label: "Open in Codex", unavailable: tooLong(`${codexPromptCap} characters`) },
    prompt.length <= codexPromptCap ? { agent: "conductor", label: "Open in Conductor", url: conductor } : { agent: "conductor", label: "Open in Conductor", unavailable: tooLong(`${codexPromptCap} characters`) },
  ];
}

// The Devin handoff is offered only when the viewer saved their own Devin key and the finding (or review)
// can be fixed; otherwise there is no Devin button at all.
export function devinHandoff(configured: boolean, fixable: boolean, reviewId: string, finding?: string) {
  return configured && fixable && egressAllowed("handoff") ? { reviewId, ...(finding ? { finding } : {}) } : undefined;
}
