import Link from "next/link";
import { billingConfig } from "../src/billing";
import { CookieSettings } from "./consent";
import { ThemePicker } from "./theme";
import { Mark } from "./ui/logo";

/** The public source repository, linked from the site header, footer and self-hosting section. */
export const sourceRepository = "https://github.com/mbelenkiy29/OPENREVIEW";

// Public-site header and footer shared by the landing page, docs and changelog. On the landing
// page links are in-page anchors; elsewhere they point back to the landing sections.
export function SiteHeader({ home = false, current }: { home?: boolean; current?: "docs" | "changelog" }) {
  const base = home ? "" : "/";
  // Pricing lives on the landing page, which shows it when billing is enabled at build time; other
  // pages skip the link.
  const pricing = home && billingConfig().enabled;
  return <header className="site-header">
    <Link className="brand" href="/"><Mark /> OpenReview</Link>
    <nav className="site-nav" aria-label="Site">
      <Link href={`${base}#features`}>Features</Link>
      <Link href={`${base}#how`}>How it works</Link>
      {pricing && <Link href={`${base}#pricing`}>Pricing</Link>}
      <Link href="/docs/quickstart" aria-current={current === "docs" ? "page" : undefined}>Docs</Link>
      <Link href="/changelog" aria-current={current === "changelog" ? "page" : undefined}>Changelog</Link>
      <a href={sourceRepository}>GitHub</a>
    </nav>
    <div className="site-actions">
      {home ? <Link href="/login">Sign in</Link> : <Link href="/dashboard">Dashboard</Link>}
      <Link className="button primary small" href="/signup">Get started</Link>
    </div>
  </header>;
}

const columns: [string, [string, string][]][] = [
  ["Docs", [["/docs/quickstart", "Quickstart"], ["/docs/reviews", "How reviews work"], ["/docs/configuration", "Configuration"], ["/docs/self-hosting", "Self-hosting"]]],
  ["Developers", [["/docs/api", "Public API"], ["/docs/mcp", "MCP"], ["/docs/cli", "CLI"], ["/docs/openapi.yaml", "OpenAPI spec"]]],
  ["Integrations", [["/docs/github-app", "GitHub App"], ["/docs/notifications", "Slack and email"], ["/docs/linear", "Linear"], ["/docs/atlassian", "Jira and Confluence"]]],
];

export function SiteFooter({ home = false }: { home?: boolean }) {
  const pricing = home && billingConfig().enabled;
  return <footer className="site-footer">
    <div className="footer-grid">
      <div>
        <Link className="brand" href="/"><Mark /> OpenReview</Link>
        <span className="muted">Repository-aware pull request reviews.</span>
      </div>
      <nav aria-label="Product">
        <h2>Product</h2>
        <Link href="/#features">Features</Link>
        <Link href="/#how">How it works</Link>
        {pricing && <Link href="/#pricing">Pricing</Link>}
        <Link href="/changelog">Changelog</Link>
      </nav>
      {columns.map(([title, links]) => <nav key={title} aria-label={title}>
        <h2>{title}</h2>
        {links.map(([href, label]) => href.endsWith(".yaml") ? <a key={href} href={href}>{label}</a> : <Link key={href} href={href}>{label}</Link>)}
      </nav>)}
    </div>
    <div className="footer-base">
      <span>OpenReview · <a href={`${sourceRepository}/blob/main/LICENSE`}>MIT licensed</a> · <a href={sourceRepository}>Source on GitHub</a> · <Link href="/privacy">Privacy</Link> · <Link href="/terms">Terms</Link><CookieSettings /></span>
      <ThemePicker />
    </div>
  </footer>;
}
