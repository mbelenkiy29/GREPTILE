import Link from "next/link";
import type { ReactNode } from "react";
import { SiteFooter, SiteHeader } from "./site-chrome";
import { AgentReplica, AnalyticsReplica, ChatReplica, FindingReplica, ReviewReplica, SummaryReplica } from "./landing/replicas";
import { Copy } from "./dashboard/live";
import { billingConfig } from "../src/billing";

const hosts = ["GitHub", "GitHub Enterprise", "GitLab", "Azure DevOps", "Bitbucket", "Gitea", "Perforce"];
const steps = [
  ["Index the repository", "OpenReview parses your default branch into files, symbols and a cross-file call and import graph, with optional semantic embeddings."],
  ["Investigate each change", "The diff is read alongside its callers, tests, past findings, your rules and any linked requirements, by specialists or a tool-using agent."],
  ["Verify before posting", "A finding needs exact quotes from the reviewed revision and survives an independent check. Unsupported claims are dropped."],
  ["Learn from your team", "Reactions, feedback and recurring human review comments become memory that your admins can inspect and control."],
] as const;
const features: { id: string; eyebrow: string; title: string; body: string; link: [string, string]; visual: ReactNode }[] = [
  { id: "evidence", eyebrow: "Evidence", title: "Evidence on every finding", body: "Each issue cites the exact lines it depends on, pinned to the commit, with a committable suggestion when the fix is small. A finding that cannot quote the reviewed revision is dropped.", link: ["/docs/reviews", "Learn how reviews work"], visual: <FindingReplica /> },
  { id: "summary", eyebrow: "Summary", title: "One summary, kept current", body: "A single summary comment with an overview, changed files, issues, a confidence score and a sequence diagram is updated as the pull request moves. New pushes are reviewed against what changed.", link: ["/docs/reviews", "See what a review posts"], visual: <SummaryReplica /> },
  { id: "chat", eyebrow: "Chat", title: "Ask your codebase", body: "Chat, the API, MCP and Slack all answer questions with citations that must match the indexed source.", link: ["/docs/chat", "Learn about codebase chat"], visual: <ChatReplica /> },
  { id: "fix", eyebrow: "Fixes", title: "Fix with your agent", body: "Hand findings to Codex, Claude Code or Cursor Agent on your machine, or ask @openreview for a validated fix.", link: ["/docs/cli", "Set up the agent bridge"], visual: <AgentReplica /> },
  { id: "analytics", eyebrow: "Analytics", title: "See what reviews are worth", body: "Track reviews, verified findings, addressed rate, time saved and model cost by repository, team and author, and export it as CSV.", link: ["/docs/quickstart", "Read the quickstart"], visual: <AnalyticsReplica /> },
];
const more = [
  ["Incremental re-reviews", "New pushes are reviewed against what changed, and threads for fixed findings resolve themselves."],
  ["Configuration as code", "Rules and settings live in .openreview.json, read from the base branch so a PR cannot weaken its own review."],
  ["Many providers", "GitHub, GitHub Enterprise, GitLab, Azure DevOps, Bitbucket Cloud and Data Center, Gitea and Perforce."],
  ["Your model, your budget", "Bring Anthropic, OpenAI or a compatible endpoint. A hard inference budget and per-task usage accounting keep spend predictable."],
] as const;
const faq = [
  ["Does OpenReview run our code?", "No. Reviews read source and never execute it. Test results appear only when a paired runtime worker records them for that commit."],
  ["Where does our code go?", "Self-hosted, it stays in your Convex deployment and goes only to the model provider you configure. Secret-looking values are redacted before model calls."],
  ["Can a pull request turn its own review off?", "No. Repository configuration is read from the base branch, and admins can lock settings."],
  ["Will it flood our PRs with comments?", "Findings must pass confidence, severity and evidence thresholds. You choose the maximum comment count, strictness and categories, and learned preferences reduce repeat noise."],
  ["Which models are supported?", "Claude and OpenAI models, or any OpenAI-compatible endpoint, with per-task model routing."],
] as const;
const commands = ["pnpm install", "CONVEX_AGENT_MODE=anonymous pnpm exec convex dev --once", "pnpm setup:local", "pnpm backend", "pnpm dev"];

// Prerendered at build time, so billing values come from the build environment. Old sign-in result
// links (/?error=…) are redirected to /login in next.config.ts.
export default function Home() {
  const billing = billingConfig();
  return <div className="landing">
    <SiteHeader home />
    <main>
      <section className="hero" aria-labelledby="hero-heading">
        <h1 id="hero-heading">Review the change.<br />Understand the codebase.</h1>
        <p className="lede">OpenReview reviews pull requests using your whole repository, not only the diff. Every finding quotes the code it depends on, and nothing is posted until it has been verified.</p>
        <div className="hero-actions">
          <Link className="button primary large" href="/signup">Get started</Link>
          <Link className="button large" href="/login">Sign in</Link>
        </div>
        <p className="hero-links"><Link href="/docs/quickstart">Read the quickstart →</Link><Link href="/docs/self-hosting">Self-host it →</Link></p>
      </section>
      <div className="stage"><ReviewReplica /></div>

      <section className="hosts" aria-labelledby="hosts-heading">
        <h2 id="hosts-heading">Reviews pull requests on</h2>
        <ul className="host-grid">{hosts.map((h) => <li key={h}>{h}</li>)}</ul>
      </section>

      {features.map((f, i) => <section key={f.id} id={i === 0 ? "features" : undefined} className={`feature${i % 2 ? " reverse" : ""}`} aria-labelledby={`${f.id}-heading`}>
        <div className="feature-copy">
          <span className="eyebrow">{f.eyebrow}</span>
          <h2 id={`${f.id}-heading`}>{f.title}</h2>
          <p>{f.body}</p>
          <Link href={f.link[0]}>{f.link[1]} →</Link>
        </div>
        <div className="stage">{f.visual}</div>
      </section>)}

      <section className="more" aria-labelledby="more-heading">
        <h2 id="more-heading">Built for reviews you can trust</h2>
        <div className="feature-grid">{more.map(([title, body]) => <article key={title} className="feature-card"><h3>{title}</h3><p>{body}</p></article>)}</div>
      </section>

      <section id="how" className="how" aria-labelledby="how-heading">
        <h2 id="how-heading">How it works</h2>
        <ol className="steps">{steps.map(([title, body], i) => <li key={title}><span className="step-number">{String(i + 1).padStart(2, "0")}</span><h3>{title}</h3><p>{body}</p></li>)}</ol>
      </section>

      <section className="run" aria-labelledby="run-heading">
        <div className="feature-copy">
          <h2 id="run-heading">Run it on your infrastructure</h2>
          <p>Your Next.js host, your Convex backend and your model provider. Code goes only to the model you configure, and secret-looking values are redacted first.</p>
          <Link href="/docs/self-hosting">Read the self-hosting guide →</Link>
        </div>
        <div className="terminal">
          <div className="terminal-bar"><span>Terminal</span><Copy value={commands.join("\n")} label="Copy" /></div>
          <pre>{commands.map((c) => <code key={c}><span>$ </span>{c}{"\n"}</code>)}</pre>
        </div>
      </section>

      <section className="compare-band" aria-labelledby="deploy-heading">
        <h2 id="deploy-heading">Self-hosted or cloud</h2>
        <div className="table-scroll"><table className="compare"><thead><tr><th><span className="sr-only">Aspect</span></th><th>Self-hosted</th><th>Cloud</th></tr></thead><tbody>
          <tr><th scope="row">Where it runs</th><td>Your Next.js host and Convex backend</td><td>A hosted OpenReview deployment</td></tr>
          <tr><th scope="row">Model and keys</th><td>Yours, with your own budget</td><td>Provided by the operator</td></tr>
          <tr><th scope="row">Review limits</th><td>None</td><td>Plan quota per seat</td></tr>
          <tr><th scope="row">Setup</th><td><Link href="/docs/self-hosting">Self-hosting guide</Link></td><td>Sign in and install the app</td></tr>
        </tbody></table></div>
      </section>

      {billing.enabled && <section id="pricing" className="pricing" aria-labelledby="pricing-heading">
        <h2 id="pricing-heading">Pricing</h2>
        <div className="feature-grid two">
          <article className="feature-card"><h3>Trial</h3><p className="price">Free for {billing.trialDays} days</p><p>Up to {billing.trialReviews} reviews a month, with every feature included.</p></article>
          <article className="feature-card"><h3>Starter</h3><p className="price">{process.env.BILLING_SEAT_PRICE_LABEL ?? "Per seat, billed monthly"}</p><p>Unlimited reviews, with a fair-use limit of {billing.reviewsPerSeat} per seat each month. Owners, admins and members are seats; viewers are free.</p></article>
        </div>
      </section>}

      <section className="faq-band" aria-labelledby="faq-heading">
        <h2 id="faq-heading">Questions</h2>
        <div className="faq">{faq.map(([q, a], i) => <details key={q} open={i === 0}><summary>{q}</summary><p>{a}</p></details>)}</div>
      </section>

      <section className="cta" aria-labelledby="cta-heading">
        <h2 id="cta-heading">Try OpenReview now.</h2>
        <div className="cta-actions">
          <Link className="button primary large" href="/signup">Get started</Link>
          <Link className="button large" href="/docs/quickstart">Read the quickstart →</Link>
        </div>
      </section>
    </main>
    <SiteFooter home />
  </div>;
}
