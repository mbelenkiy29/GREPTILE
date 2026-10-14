import Link from "next/link";
import { SignInOptions } from "./sign-in";
import { billingConfig } from "../src/billing";

const steps = [
  ["Index the repository", "OpenReview parses your default branch into files, symbols and a cross-file call and import graph, with optional semantic embeddings."],
  ["Investigate each change", "The diff is read alongside its callers, tests, past findings, your rules and any linked requirements, by specialists or a tool-using agent."],
  ["Verify before posting", "A finding needs exact quotes from the reviewed revision and survives an independent check. Unsupported claims are dropped."],
  ["Learn from your team", "Reactions, feedback and recurring human review comments become memory that your admins can inspect and control."],
] as const;
const features = [
  ["Evidence on every finding", "Each issue cites the exact lines it depends on, pinned to the commit, with a committable suggestion when the fix is small."],
  ["One summary, kept current", "A single summary comment with an overview, changed files, issues, a confidence score and a sequence diagram is updated as the PR moves."],
  ["Incremental re-reviews", "New pushes are reviewed against what changed, and threads for fixed findings resolve themselves."],
  ["Ask your codebase", "Chat, the API, MCP and Slack all answer questions with citations that must match the indexed source."],
  ["Configuration as code", "Rules and settings live in .openreview.json, read from the base branch so a PR cannot weaken its own review."],
  ["Fix with your agent", "Hand findings to Codex, Claude Code or Cursor Agent on your machine, or ask @openreview for a validated fix."],
  ["Many providers", "GitHub, GitHub Enterprise, GitLab, Bitbucket Cloud and Data Center, Gitea and Perforce."],
  ["Your model, your budget", "Bring Anthropic, OpenAI or a compatible endpoint. A hard inference budget and per-task usage accounting keep spend predictable."],
] as const;
const faq = [
  ["Does OpenReview run our code?", "No. Reviews read source and never execute it. Test results appear only when a paired runtime worker records them for that commit."],
  ["Where does our code go?", "Self-hosted, it stays in your Convex deployment and goes only to the model provider you configure. Secret-looking values are redacted before model calls."],
  ["Can a pull request turn its own review off?", "No. Repository configuration is read from the base branch, and admins can lock settings."],
  ["Will it flood our PRs with comments?", "Findings must pass confidence, severity and evidence thresholds. You choose the maximum comment count, strictness and categories, and learned preferences reduce repeat noise."],
  ["Which models are supported?", "Claude and OpenAI models, or any OpenAI-compatible endpoint, with per-task model routing."],
] as const;

export default async function Home({ searchParams }: { searchParams: Promise<{ error?: string; email?: string; signedout?: string }> }) {
  const { error, email, signedout } = await searchParams;
  const billing = billingConfig();
  return <div className="landing">
    <header className="site-header"><Link className="brand" href="/"><span className="mark">⌘</span> OpenReview</Link><nav aria-label="Site"><a href="#how">How it works</a><a href="#features">Features</a>{billing.enabled && <a href="#pricing">Pricing</a>}<Link href="/docs/quickstart">Docs</Link><Link href="/changelog">Changelog</Link></nav></header>
    <main>
      <section className="hero">
        <h1>Review the change.<br />Understand the codebase.</h1>
        <p className="lede">OpenReview reviews pull requests using your whole repository, not only the diff. Every finding quotes the code it depends on, and nothing is posted until it has been verified.</p>
        {error && <p role="alert" className="error">{error === "link" ? "That sign-in link is invalid, expired or already used. Request a new one." : "Sign-in failed. Check the OAuth callback URL and server configuration, then try again."}</p>}
        {email === "sent" && <p role="status">Check your inbox for a sign-in link. It expires in 15 minutes.</p>}
        {email === "error" && <p role="alert" className="error">The sign-in link could not be sent. Check the address, or try again in a few minutes.</p>}
        {signedout && <p role="status">You have been signed out.</p>}
        <SignInOptions />
        <p className="muted"><Link href="/docs/quickstart">Read the quickstart</Link> · <Link href="/docs/self-hosting">Self-host it</Link></p>
      </section>
      <section id="how" aria-labelledby="how-heading" className="band">
        <h2 id="how-heading">How it works</h2>
        <ol className="steps">{steps.map(([title, body], i) => <li key={title}><span className="step-number">{i + 1}</span><h3>{title}</h3><p>{body}</p></li>)}</ol>
      </section>
      <section id="features" aria-labelledby="features-heading" className="band">
        <h2 id="features-heading">Built for reviews you can trust</h2>
        <div className="feature-grid">{features.map(([title, body]) => <article key={title}><h3>{title}</h3><p>{body}</p></article>)}</div>
      </section>
      <section aria-labelledby="deploy-heading" className="band">
        <h2 id="deploy-heading">Self-hosted or cloud</h2>
        <div className="table-scroll"><table className="compare"><thead><tr><th></th><th>Self-hosted</th><th>Cloud</th></tr></thead><tbody>
          <tr><th scope="row">Where it runs</th><td>Your Next.js host and Convex backend</td><td>A hosted OpenReview deployment</td></tr>
          <tr><th scope="row">Model and keys</th><td>Yours, with your own budget</td><td>Provided by the operator</td></tr>
          <tr><th scope="row">Review limits</th><td>None</td><td>Plan quota per seat</td></tr>
          <tr><th scope="row">Setup</th><td><Link href="/docs/self-hosting">Self-hosting guide</Link></td><td>Sign in and install the app</td></tr>
        </tbody></table></div>
      </section>
      {billing.enabled && <section id="pricing" aria-labelledby="pricing-heading" className="band">
        <h2 id="pricing-heading">Pricing</h2>
        <div className="feature-grid two">
          <article><h3>Trial</h3><p className="price">Free for {billing.trialDays} days</p><p>Up to {billing.trialReviews} reviews a month, with every feature included.</p></article>
          <article><h3>Team</h3><p className="price">{process.env.BILLING_SEAT_PRICE_LABEL ?? "Per seat, billed monthly"}</p><p>{billing.reviewsPerSeat} reviews per seat each month. Owners, admins and members are seats; viewers are free.</p></article>
        </div>
      </section>}
      <section aria-labelledby="faq-heading" className="band">
        <h2 id="faq-heading">Questions</h2>
        <div className="faq">{faq.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}</div>
      </section>
    </main>
    <footer className="site-footer"><span>OpenReview · MIT licensed</span><nav aria-label="Footer"><Link href="/docs/quickstart">Docs</Link><Link href="/docs/api">API</Link><Link href="/docs/mcp">MCP</Link><Link href="/changelog">Changelog</Link><Link href="/docs/self-hosting">Self-hosting</Link></nav></footer>
  </div>;
}
