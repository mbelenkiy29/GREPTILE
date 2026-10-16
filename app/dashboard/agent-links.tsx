import { agentLinks, agentRepoContext } from "../../src/agent-links";
import { sendToDevin } from "./actions";

// Bridge-free handoff: officially documented "open with prompt" links that only pre-fill the
// prompt in the developer's agent; they review it before anything runs.
// `devin` is passed only when the viewer saved a Devin API key; otherwise the Devin button is absent.
export function AgentLinks({ prompt, repo, devin }: { prompt: string; repo?: { fullName: string; connectionId?: unknown; remoteUrl?: string }; devin?: { reviewId: string; finding?: string } }) {
  const links = agentLinks(prompt, repo ? agentRepoContext(repo) : {});
  return <><p className="agent-links">{links.map((l) => l.url ? <a key={l.agent} className="button small" href={l.url}>{l.label}</a> : <span key={l.agent} className="muted" title={l.unavailable}>{l.label} unavailable · </span>)}<span className="muted"> Opens your agent with the prompt pre-filled; nothing runs until you send it.</span></p>
    {devin && <form action={sendToDevin} className="agent-links"><input type="hidden" name="reviewId" value={devin.reviewId} />{devin.finding && <input type="hidden" name="finding" value={devin.finding} />}<button className="button small">Send to Devin</button><span className="muted"> Starts an unlisted Devin session with your own API key.</span></form>}</>;
}
