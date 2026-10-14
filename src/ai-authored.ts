// Detection of pull requests written by coding agents, from explicit signals only (never from code
// style): known agent bot authors, Co-Authored-By trailers naming an agent, agent branch prefixes, and
// markers the agents themselves add to PR descriptions. Used to route such PRs to a chosen model.
export type AiAuthoredSignal = { agent: string; kind: "author" | "trailer" | "branch" | "body"; detail: string };
type Agent = { name: string; authors?: RegExp; trailer?: RegExp; branch?: RegExp; body?: RegExp };
const agents: Agent[] = [
  { name: "Claude Code", authors: /^claude(?:-code)?\[bot\]$/i, trailer: /^co-authored-by:\s*claude\b[^<\n]*<[^>]*@anthropic\.com>/im, branch: /^claude\//, body: /Generated with \[Claude Code\]\(https:\/\/claude\.(?:ai|com)\//i },
  { name: "GitHub Copilot", authors: /^(?:copilot-swe-agent\[bot\]|copilot)$/i, trailer: /^co-authored-by:\s*copilot\b[^<\n]*<[^>]*>/im, branch: /^copilot\// },
  { name: "Cursor", authors: /^cursor(?:-agent)?\[bot\]$/i, trailer: /^co-authored-by:\s*cursor agent\b[^<\n]*<[^>]*@cursor\.com>/im, branch: /^cursor\//, body: /https:\/\/cursor\.com\/(?:agents|background-agent)\b/i },
  { name: "OpenAI Codex", authors: /^(?:chatgpt-codex-connector|openai-codex|codex)\[bot\]$/i, trailer: /^co-authored-by:\s*(?:openai )?codex\b[^<\n]*<[^>]*>/im, branch: /^codex\//, body: /https:\/\/chatgpt\.com\/codex\/tasks\//i },
  { name: "Devin", authors: /^devin-ai-integration\[bot\]$/i, trailer: /^co-authored-by:\s*devin\b[^<\n]*<[^>]*@(?:devin\.ai|cognition\.ai)>/im, branch: /^devin\//, body: /https:\/\/app\.devin\.ai\/sessions\//i },
  { name: "Jules", authors: /^google-labs-jules\[bot\]$/i, branch: /^jules\//, body: /https:\/\/jules\.google\.com\/task\//i },
  { name: "Aider", trailer: /^co-authored-by:\s*aider\b[^<\n]*<[^>]*@aider\.chat>/im },
];
const clip = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 120);
export function detectAiAuthored(pr: { author: string; branch: string; body?: string | null; commits?: { message?: string }[] }): AiAuthoredSignal | undefined {
  for (const a of agents) if (a.authors?.test(pr.author)) return { agent: a.name, kind: "author", detail: `author ${clip(pr.author)}` };
  for (const commit of pr.commits ?? []) for (const a of agents) { const m = a.trailer && commit.message?.match(a.trailer); if (m) return { agent: a.name, kind: "trailer", detail: clip(m[0]) }; }
  for (const a of agents) if (a.branch?.test(pr.branch)) return { agent: a.name, kind: "branch", detail: `branch ${clip(pr.branch)}` };
  for (const a of agents) { const m = a.body && pr.body?.match(a.body); if (m) return { agent: a.name, kind: "body", detail: `description marker ${clip(m[0])}` }; }
  return undefined;
}
// The review model: aiAuthoredModel when set and the PR is agent-authored, otherwise the usual model.
export const reviewModelFor = (settings: { model?: string; aiAuthoredModel?: string }, signal?: AiAuthoredSignal) => signal && settings.aiAuthoredModel?.trim() ? { model: settings.aiAuthoredModel.trim(), routed: true } : { model: settings.model || undefined, routed: false };
