import { agentLinks, agentRepoContext } from "../../src/agent-links";

// Bridge-free handoff: officially documented "open with prompt" links that only pre-fill the
// prompt in the developer's agent; they review it before anything runs.
export function AgentLinks({ prompt, repo }: { prompt: string; repo?: { fullName: string; connectionId?: unknown; remoteUrl?: string } }) {
  const links = agentLinks(prompt, repo ? agentRepoContext(repo) : {});
  return <p className="agent-links">{links.map((l) => l.url ? <a key={l.agent} className="button small" href={l.url}>{l.label}</a> : <span key={l.agent} className="muted" title={l.unavailable}>{l.label} unavailable · </span>)}<span className="muted"> Opens your agent with the prompt pre-filled; nothing runs until you send it.</span></p>;
}
